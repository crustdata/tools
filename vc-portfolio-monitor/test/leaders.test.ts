import assert from "node:assert/strict";
import { test } from "node:test";
import { leaderEvent, leaderRole, pickLeaders, type Leader } from "../src/leaders.js";

test("leaderRole keeps founders and C-level, drops look-alike titles", () => {
  const yes: [string, string][] = [
    ["Co-Founder", "founder"], ["Cofounder & CTO", "founder"], ["Founder, Board Member", "founder"], ["CEO", "ceo"],
    ["Chief Executive Officer", "ceo"], ["Chief Operating Officer", "c_level"], ["CFO", "c_level"], ["Chief Revenue Officer, Americas", "c_level"],
    ["President", "president"], ["President & COO", "c_level"],
  ];
  for (const [t, role] of yes) assert.equal(leaderRole(t), role, t);
  for (const t of ["Chief of Staff", "Executive Assistant to Chief Executive Officer", "Founding Engineer", "Founder's Associate", "Vice President, Sales", "VP Engineering",
    "Founder in Residence", "Chief Advisor", "Board Member", "Office of the CEO", "", "Deputy CFO", "Former CEO", "ex-CEO"]) assert.equal(leaderRole(t), undefined, t);
  for (const [t, role] of [["Co-founder, former CEO", "founder"], ["CEO & Co-founder | ex-Stripe", "founder"], ["Gründer & Geschäftsführer", "founder"], ["Fondateur & PDG", "founder"], ["Directeur Général", "ceo"], ["Fundador", "founder"]] as const) assert.equal(leaderRole(t), role, t);
});

test("pickLeaders ranks founders first, drops people without a profile URL and repeats, and caps", () => {
  const people = [
    { name: "C", title: "Chief Operating Officer", profileUrl: "u3" },
    { name: "A", title: "Co-Founder", profileUrl: "u1", startDate: "2020-01-01" },
    { name: "B", title: "CEO", profileUrl: "u2" },
    { name: "Z", title: "Chief of Staff", profileUrl: "u4" },
    { name: "A again", title: "Co-Founder", profileUrl: "U1" },
    { name: "No URL", title: "CTO" },
  ];
  assert.deepEqual(pickLeaders(people, 8).map(p => p.name), ["A", "B", "C"]);
  assert.deepEqual(pickLeaders(people, 2).map(p => p.name), ["A", "B"]);
});

const leader: Leader = { profileUrl: "https://www.profiles.example/in/example-jo", name: "Jo", title: "Co-Founder & CTO", role: "founder", domain: "acme.example", company: "Acme", companyId: 1 };
const rec = (current: unknown[], past: unknown[] = []) => ({ experience: { employment_details: { current, past } } });
const now = new Date("2026-10-26T00:00:00Z");

test("leaderEvent: left for a new company", () => {
  const e = leaderEvent(rec([{ title: "CEO", name: "NewCo", crustdata_company_id: 9, is_default: true }], [{ title: "Co-Founder & CTO", name: "Acme", crustdata_company_id: 1, end_date: "2026-09-30" }]), leader, now);
  assert.deepEqual(e, { kind: "left", newTitle: "CEO", newCompany: "NewCo", endDate: "2026-09-30" });
});

test("leaderEvent: left needs evidence (an end date there, or a new main role elsewhere); a role gone for one run is not a departure", () => {
  assert.equal(leaderEvent(rec([], [{ title: "CTO", name: "Acme", crustdata_company_id: 1, end_date: "2026-09-30" }]), leader, now)?.kind, "left");
  assert.equal(leaderEvent(rec([{ title: "Co-Founder & CTO", name: "Acme", crustdata_company_id: 1, end_date: "2026-10-01" }]), leader, now)?.kind, "left");
  assert.equal(leaderEvent(rec([], [{ title: "Engineer", name: "Google", crustdata_company_id: 9, end_date: "2019-01-01" }]), leader, now), undefined);
  // An old role elsewhere that was listed all along (a serial founder, an angel) is not evidence; a new one is.
  const watched = { ...leader, addedAt: "2026-09-01T00:00:00Z" };
  assert.equal(leaderEvent(rec([{ title: "Co-Founder", name: "OldCo", crustdata_company_id: 7, start_date: "2019-01-01" }]), watched, now), undefined);
  assert.equal(leaderEvent(rec([{ title: "CEO", name: "NewCo", crustdata_company_id: 8, start_date: "2026-10-01", is_default: true }]), watched, now)?.kind, "left");
  assert.equal(leaderEvent({ experience: { employment_details: { past: [] } } }, leader, now), undefined); // no current list at all
});

test("leaderEvent: a renamed company with no id yet is still the same company", () => {
  const noId = { ...leader, companyId: undefined };
  assert.equal(leaderEvent(rec([{ title: "Co-Founder & CTO", name: "Acme AI", is_default: true }]), noId, now), undefined);
});

test("leaderEvent: a CEO who drops the CEO title is a CEO change; a leader recorded as gone who is back is a return", () => {
  const ceo = { ...leader, title: "CEO", role: "ceo" as const };
  assert.deepEqual(leaderEvent(rec([{ title: "Executive Chairman", name: "Acme", crustdata_company_id: 1 }]), ceo, now), { kind: "ceo_changed", newTitle: "Executive Chairman", elsewhereTitle: undefined, elsewhereCompany: undefined });
  assert.equal(leaderEvent(rec([{ title: "Chief Executive Officer & Co-founder", name: "Acme", crustdata_company_id: 1 }]), { ...leader, title: "Co-Founder & CEO" }, now), undefined);
  assert.equal(leaderEvent(rec([{ title: "CEO & Co-Founder", name: "Acme", crustdata_company_id: 1 }]), { ...leader, title: "Co-Founder and CEO" }, now), undefined);
  assert.equal(leaderEvent(rec([{ title: "CTO", name: "Acme", crustdata_company_id: 1 }]), { ...leader, status: "left" }, now)?.kind, "returned");
  assert.equal(leaderEvent(rec([{ title: "Chairman", name: "Acme", crustdata_company_id: 1 }]), leader, now)?.kind, "stepped_back");
});

test("leaderEvent: matches the company by id, then website, then name", () => {
  const noId = { ...leader, companyId: undefined };
  assert.equal(leaderEvent(rec([{ title: "Co-Founder & CTO", name: "ACME Inc." }]), noId, now), undefined);
  assert.equal(leaderEvent(rec([{ title: "Co-Founder & CTO", name: "Other", company_website_domain: "www.acme.example" }]), noId, now), undefined);
});

test("leaderEvent: title changes, spelling-only edits, stepping back, side roles", () => {
  assert.deepEqual(leaderEvent(rec([{ title: "CEO", name: "Acme", crustdata_company_id: 1 }]), leader, now), { kind: "role", newTitle: "CEO" });
  assert.equal(leaderEvent(rec([{ title: "Cofounder and CTO", name: "Acme", crustdata_company_id: 1 }]), leader, now), undefined);
  assert.deepEqual(leaderEvent(rec([{ title: "Advisor", name: "Acme", crustdata_company_id: 1 }]), leader, now), { kind: "stepped_back", newTitle: "Advisor" });
  // A board seat elsewhere is not news; a new main role elsewhere is.
  assert.equal(leaderEvent(rec([{ title: "Co-Founder & CTO", name: "Acme", crustdata_company_id: 1, is_default: true }, { title: "Board Member", name: "Org", crustdata_company_id: 5 }]), leader, now), undefined);
  assert.equal(leaderEvent(rec([{ title: "Co-Founder & CTO", name: "Acme", crustdata_company_id: 1 }, { title: "CTO", name: "Other", crustdata_company_id: 5, is_default: true }]), leader, now)?.kind, "side_role");
});

test("leaderEvent: an empty or unreadable record is not a departure", () => {
  assert.equal(leaderEvent(rec([], []), leader, now), undefined);
  assert.equal(leaderEvent({}, leader, now), undefined);
  assert.equal(leaderEvent({ experience: { employment_details: { current: "x" } } }, leader, now), undefined);
  assert.equal(leaderEvent(null, leader, now), undefined);
});
