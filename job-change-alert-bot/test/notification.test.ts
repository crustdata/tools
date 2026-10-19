import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { duration, isBaselineOrTest, monthYear, parseNdjson, sameCompany, sameTitle, toJobChanges, type Notification } from "../src/notification.js";

const load = (name: string): Notification => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const changesOf = (name: string, known?: Parameters<typeof toJobChanges>[3]) => {
  const n = load(name);
  return toJobChanges(n.metadata.watch_id, n.metadata.run_id, n.results!, known);
};

test("a move to a new company has the right from, to, tenure and start date", () => {
  const [c, ...rest] = changesOf("job-change.json");
  assert.equal(rest.length, 0);
  assert.equal(c.kind, "new_company");
  assert.equal(c.name, "Sherry Robinson");
  assert.equal(c.previousTitle, "Director of Sales");
  assert.equal(c.previousCompany, "Contoso Cloud");
  assert.equal(c.previousTenureMonths, 42);
  assert.equal(c.newTitle, "VP of Sales");
  assert.equal(c.newCompany, "Northwind Analytics");
  assert.equal(c.newCompanyDomain, "northwindanalytics.com");
  assert.equal(c.id, "50991:64200:6324687");
});

test("a promotion at the same company is a title change, not a job change", () => {
  const [c] = changesOf("promotion.json");
  assert.equal(c.kind, "title_change");
  assert.equal(c.previousTitle, "Account Executive");
  assert.equal(c.newTitle, "Senior Account Executive");
  assert.equal(c.newCompany, "Acme Corp");
});

test("someone leaving with no new role is left_company", () => {
  const [c] = changesOf("left-company.json");
  assert.equal(c.kind, "left_company");
  assert.equal(c.previousCompany, "Tailspin Toys");
  assert.equal(c.previousTitle, "Head of RevOps");
});

test("a side role while staying at the main company is added_role", () => {
  const [c] = changesOf("side-role.json");
  assert.equal(c.kind, "added_role");
  assert.equal(c.newCompany, "TinyStartup");
  assert.equal(c.stillCompany, "Northwind Analytics");
});

test("a punctuation-only title edit is title_edit", () => {
  assert.equal(changesOf("title-edit.json")[0].kind, "title_edit");
});

test("the same person in the same run always gets the same id", () => {
  assert.equal(changesOf("job-change.json")[0].id, changesOf("job-change.json")[0].id);
});

test("baseline and test notifications are recognised", () => {
  assert.equal(isBaselineOrTest(load("baseline.json")), true);
  assert.equal(isBaselineOrTest(load("test-notification.json")), true);
  assert.equal(isBaselineOrTest(load("job-change.json")), false);
});

test("a stored role is used as 'was' when no role just ended", () => {
  const n = load("job-change.json");
  const r = structuredClone(n.results![0]);
  r.changes = r.changes.filter((c: { field: string }) => c.field === "experience.employment_details.current");
  r.record.experience.employment_details.past = [];
  const [c] = toJobChanges(1, 2, [r], () => ({ title: "Head of Sales", company: "Fabrikam" }));
  assert.equal(c.kind, "new_company");
  assert.equal(c.previousTitle, "Head of Sales");
  assert.equal(c.previousCompany, "Fabrikam");
});

test("malformed results are skipped, not thrown", () => {
  assert.deepEqual(toJobChanges(1, 2, [null as any, { changes: "x" } as any, { changes: [] , record: {} }]), []);
  assert.deepEqual(toJobChanges(1, 2, "nope" as any), []);
});

test("company and title comparisons ignore case, punctuation and legal suffixes", () => {
  assert.equal(sameCompany({ name: "Acme Corp" }, { name: "ACME, Inc." }), true);
  assert.equal(sameCompany({ name: "Acme", crustdata_company_id: 1 }, { name: "Acme", crustdata_company_id: 2 }), false);
  assert.equal(sameTitle("VP Sales", "VP, sales"), true);
  assert.equal(sameTitle("VP Sales", "SVP Sales"), false);
});

test("dates and durations read like a person wrote them", () => {
  assert.equal(monthYear("2026-10-01T00:00:00+00:00"), "Oct 2026");
  assert.equal(duration(43), "3 years 7 months");
  assert.equal(duration(12), "1 year");
  assert.equal(duration(0), undefined);
});

test("NDJSON run files parse one result per line", () => {
  const ndjson = load("job-change.json").results!.map(r => JSON.stringify(r)).join("\n") + "\n";
  assert.equal(parseNdjson(ndjson).length, 1);
});

// Edge cases found in review. `pos` builds a position; `run` classifies one result.
const pos = (title: string, name: string, id: number, extra: Record<string, unknown> = {}) => ({ title, name, crustdata_company_id: id, ...extra });
const run = (changes: any[], current: any[], past: any[] = [], known?: Parameters<typeof toJobChanges>[3]) =>
  toJobChanges(1, 1, [{ changes, record: { crustdata_person_id: 9, basic_profile: { name: "Test Person" }, experience: { employment_details: { current, past } } } }], known)[0];

test("leaving the main job while keeping a board seat is left_company, with the seat noted", () => {
  const ended = pos("VP Ops", "Northwind", 50, { end_date: "2026-09-30", start_date: "2019-01-01" });
  const seat = pos("Board Member", "TinyStartup", 51, { start_date: "2024-01-01" });
  const c = run([{ field: "experience.employment_details.past", type: "added", new_elements: [ended] }], [seat], [ended]);
  assert.equal(c.kind, "left_company");
  assert.equal(c.previousCompany, "Northwind");
  assert.equal(c.stillCompany, "TinyStartup");
});

test("a new role at the same company while the old one is still listed is a title change", () => {
  const ae = pos("Account Executive", "Acme", 4, { start_date: "2022-01-01" });
  const sae = pos("Senior Account Executive", "Acme", 4, { start_date: "2026-10-01", is_default: true });
  const c = run([{ field: "experience.employment_details.current", type: "added", new_elements: [sae] }], [ae, sae], [pos("SDR", "Contoso", 3, { end_date: "2021-12-31" })]);
  assert.equal(c.kind, "title_change");
  assert.equal(c.previousTitle, "Account Executive");
});

test("a promotion edited in place, with no start date and no known company, is a title change", () => {
  const sae = pos("Senior AE", "Acme", 4);
  const c = run([
    { field: "experience.employment_details.current", type: "added", new_elements: [sae] },
    { field: "basic_profile.current_title", type: "changed", from: "AE", to: "Senior AE" },
  ], [sae], [pos("SDR", "Globex", 5, { start_date: "2016-01-01", end_date: "2019-01-01" })]);
  assert.equal(c.kind, "title_change");
});

test("a new job not yet flagged as main is a move when the current title points at it", () => {
  const old = pos("VP Sales", "OldCo", 1, { is_default: true, start_date: "2020-01-01" });
  const cro = pos("CRO", "NewCo", 2, { start_date: "2026-09-01" });
  const c = run([
    { field: "experience.employment_details.current", type: "added", new_elements: [cro] },
    { field: "basic_profile.current_title", type: "changed", from: "VP Sales", to: "CRO" },
  ], [old, cro]);
  assert.equal(c.kind, "new_company");
  assert.equal(c.previousCompany, "OldCo");
});

test("titles in non-Latin scripts are compared properly", () => {
  assert.equal(sameTitle("Менеджер по продажам", "Директор по продажам"), false);
  assert.equal(sameTitle("営業部長", "代表取締役"), false);
  assert.equal(sameTitle("営業部長", "営業部長"), true);
});

test("a differently spelled profile URL still finds the person you imported", () => {
  const [c] = toJobChanges(1, 1, [{ changes: [{ field: "basic_profile.current_title", type: "changed", from: "A", to: "B" }], record: { social_handles: { professional_network_identifier: { profile_url: "https://linkedin.com/in/Example-Rita-Reyes/" } } } }]);
  assert.equal(c.profileUrl, "https://www.linkedin.com/in/example-rita-reyes");
});

test("round three: in-place promotion with real dates, old roles added, re-hire with an out-of-date CSV company, contractors", () => {
  // In-place promotion: role started 2022, title renamed, an older job ended right before it.
  const sae = pos("Senior AE", "Acme", 4, { start_date: "2022-01-03" });
  assert.equal(run([
    { field: "experience.employment_details.current", type: "added", new_elements: [sae] },
    { field: "basic_profile.current_title", type: "changed", from: "AE", to: "Senior AE" },
  ], [sae], [pos("SDR", "Contoso", 3, { end_date: "2021-12-31" })]).kind, "title_change");

  // An internship from 2009 added to a profile with no current role is not a departure.
  const intern = pos("Intern", "OldCorp", 7, { start_date: "2009-06-01", end_date: "2009-09-01" });
  assert.equal(run([{ field: "experience.employment_details.past", type: "added", new_elements: [intern] }], [], [intern]), undefined);

  // Re-hire: the Globex role just ended, the new role is at Acme, and the CSV still says Acme from years ago.
  const globex = pos("VP Sales", "Globex", 8, { end_date: "2026-09-30" });
  const cro = pos("CRO", "Acme", 4, { start_date: "2026-10-01", is_default: true });
  const c = run([
    { field: "experience.employment_details.current", type: "added", new_elements: [cro] },
    { field: "experience.employment_details.past", type: "added", new_elements: [globex] },
  ], [cro], [globex], () => ({ title: "AE", company: "Acme", companyId: 4 }));
  assert.equal(c.kind, "new_company");
  assert.equal(c.previousCompany, "Globex");

  // Contractor at A and B (neither flagged) adds C: a side role, not a move.
  const a = pos("Consultant", "A Co", 11, { start_date: "2024-01-01" }), b = pos("Consultant", "B Co", 12, { start_date: "2025-01-01" });
  const cc = pos("Consultant", "C Co", 13, { start_date: "2026-10-01" });
  assert.equal(run([{ field: "experience.employment_details.current", type: "added", new_elements: [cc] }], [a, b, cc]).kind, "added_role");

  // A board seat does not replace a flagged main role just because the headline changed.
  const vp = pos("VP Sales", "OldCo", 1, { is_default: true, start_date: "2020-01-01" });
  const seat = pos("Board Member", "Charity", 2, { start_date: "2026-09-01" });
  assert.equal(run([
    { field: "experience.employment_details.current", type: "added", new_elements: [seat] },
    { field: "basic_profile.current_title", type: "changed", from: "VP Sales", to: "Board Member" },
  ], [vp, seat]).kind, "added_role");
});

test("one malformed item in a notification does not lose the others", () => {
  const good = { changes: [{ field: "basic_profile.current_title", type: "changed", from: "AE", to: "Senior AE" }], record: { crustdata_person_id: 1, experience: { employment_details: { current: [{ title: "Senior AE", name: "Acme" }] } } } };
  const bad = { changes: [null, { field: "experience.employment_details.current", type: "added", new_elements: {} }], record: { crustdata_person_id: 2 } };
  const out = toJobChanges(1, 1, [bad as any, good]);
  assert.equal(out.length, 1);
  assert.equal(out[0].crustdataPersonId, 1);
});

test("legal suffixes are dropped only as the last word", () => {
  assert.equal(sameCompany({ name: "Acme Inc." }, { name: "Acme" }), true);
  assert.equal(sameCompany({ name: "Square Co" }, { name: "Square Co Labs" }), false);
});

test("final review: moves without start dates, side-role phrases, departures without end dates, company name variants", () => {
  // CSV says Acme; new role at Beta with no start date and a new title: a move, not a promotion at Beta.
  const beta = pos("VP Sales", "Beta", 20);
  const move = run([
    { field: "experience.employment_details.current", type: "added", new_elements: [beta] },
    { field: "basic_profile.current_title", type: "changed", from: "Director Sales", to: "VP Sales" },
  ], [beta], [], () => ({ title: "Director Sales", company: "Acme" }));
  assert.equal(move.kind, "new_company");
  assert.equal(move.previousCompany, "Acme");

  // Job titles that merely contain side-role words are main roles.
  const old = pos("Nurse", "Old Hospital", 30, { is_default: true, start_date: "2018-01-01" });
  for (const title of ["Board Certified Nurse Practitioner", "Investor Relations Manager", "Head of Advisory Services"]) {
    const role = pos(title, "New Place", 31, { start_date: "2026-09-01" });
    const c = run([
      { field: "experience.employment_details.current", type: "added", new_elements: [role] },
      { field: "basic_profile.current_title", type: "changed", from: "Nurse", to: title },
    ], [old, role]);
    assert.equal(c.kind, "new_company", title);
  }

  // An internship from 2012 with no end date, added while they are CEO elsewhere, is not a departure.
  const intern = pos("Intern", "OldCo", 40, { start_date: "2012-06-01" });
  const ceo = pos("CEO", "MyCo", 41, { start_date: "2020-01-01" });
  assert.equal(run([{ field: "experience.employment_details.past", type: "added", new_elements: [intern] }], [ceo], [intern]), undefined);

  // Company names written differently are the same company.
  assert.equal(sameCompany({ name: "ACME Corporation, Inc." }, { name: "Acme Corp" }), true);
  assert.equal(sameCompany({ name: "The Acme Company" }, { name: "Acme" }), true);
  assert.equal(sameCompany({ name: "Salesforce.com, Inc." }, { name: "Salesforce" }), true);
});
