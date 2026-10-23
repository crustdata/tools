import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { domainOf, employerMatches, isFounderTitle, pickFounders, priorFounderRoles, schoolMatches } from "../src/founders.js";
import type { RawProfile } from "../src/types.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/seed-pipeline.json", import.meta.url), "utf8"));
const profiles: RawProfile[] = fixture.inputs.profiles;

test("founder titles, and titles that only look like one", () => {
  for (const t of ["Founder", "Co-Founder & CEO", "Cofounder", "co-founder and CTO", "CEO", "Chief Technology Officer", "Engineering Founder", "Founder & CEO, Fakeco / SVP at Bigco"])
    assert.ok(isFounderTitle(t), t);
  for (const t of ["Founders Associate", "Founder's Office", "Chief of Staff to the CEO", "Founding Engineer", "Advisor", "Founder in Residence", "Entrepreneur in Residence", "Founder Intern", "Head of Infrastructure", ""])
    assert.ok(!isFounderTitle(t), t);
});

test("the role at THIS company decides: advisors, associates and placeholder profiles are not founders", () => {
  const relay = pickFounders(profiles, 900101);
  assert.deepEqual(relay.map(f => f.name), ["Jane Doe", "Omar Example"]);
  assert.equal(relay[0].title, "Co-Founder & CEO");
});

test("a founder whose first current role is elsewhere still counts, and the other role is shown", () => {
  const [alex] = pickFounders(profiles, 900104);
  assert.equal(alex.name, "Alex Testperson");
  assert.equal(alex.title, "Founder & CEO");
  assert.equal(alex.alsoNow[0].title, "Venture Partner");
  assert.equal(pickFounders(profiles, 700006).length, 0, "a venture partner is not a founder of the fund");
});

test("two founders at one company, CEO and CTO first", () => {
  const fern = pickFounders(profiles, 900103);
  assert.equal(fern.length, 2);
  assert.equal(fern[0].title, "Co-Founder & CTO");
});

test("repeat founder: a past founder title, or CEO of a small company, at another company", () => {
  assert.equal(pickFounders(profiles, 900101)[0].priorFounder[0].company, "Tidewell Data");
  assert.equal(pickFounders(profiles, 900105)[0].priorFounder[0].title, "CEO");
  const big = priorFounderRoles([{ title: "CEO", company: "Bigco", companyId: 5, headcount: 20000 }], 1);
  assert.equal(big.length, 0, "the CEO of a 20,000-person company is not a repeat founder");
  const same = priorFounderRoles([{ title: "Founder", company: "Fakeco", companyId: 1 }], 1);
  assert.equal(same.length, 0, "an earlier role at the same company does not count");
});

test("a founder role at a Stealth company just before this one is this company before launch, not a repeat founder", () => {
  const past = [{ title: "Co-Founder", company: "Stealth AI Startup", companyId: 99, start: "2024-06-01", end: "2026-02-01" }];
  assert.equal(priorFounderRoles(past, 1, "2026-03-01").length, 0);
  assert.equal(priorFounderRoles(past, 1, "2028-03-01").length, 1, "years before, it was an earlier company");
  assert.equal(priorFounderRoles([{ ...past[0], company: "Tidewell Data" }], 1, "2026-03-01").length, 1);
});

test("--founders-from: domains and names; --schools with short names", () => {
  const role = { title: "Staff Engineer", company: "Ledgerpine Inc.", domain: "ledgerpine.example" };
  assert.ok(employerMatches("ledgerpine.example", role));
  assert.ok(employerMatches("https://www.ledgerpine.example/", role));
  assert.ok(employerMatches("Ledgerpine", role));
  assert.ok(!employerMatches("Pay", role), "names match whole words");
  assert.ok(!employerMatches("lane.example", { ...role, domain: "ledgerpine.example" }));
  assert.ok(employerMatches("lane.example", { ...role, domain: "eu.lane.example" }), "subdomains match");
  assert.ok(schoolMatches("MIT", "Massachusetts Institute of Technology"));
  assert.ok(schoolMatches("Stanford", "Stanford University"));
  assert.ok(schoolMatches("berkeley", "University of California, Berkeley"));
  assert.ok(!schoolMatches("MIT", "Smith College"));
  const jane = pickFounders(profiles, 900101, ["ledgerpine.example"], ["Stanford"])[0];
  assert.equal(jane.fromList[0].role.company, "Ledgerpine");
  assert.deepEqual(jane.schoolHits, ["Stanford"]);
});

test("domains", () => {
  assert.equal(domainOf("https://www.Ledgerpine.example/?utm=x"), "ledgerpine.example");
  assert.equal(domainOf("ledgerpine"), undefined);
  assert.equal(domainOf(undefined), undefined);
});

test("titles around founders and CEOs that are not founders, and the real CEO is kept", () => {
  for (const t of ["Office of the CEO", "EA to the CEO", "Head of Founder Relations", "Founder Success Manager", "CEO Coach", "Product Manager, CEO Office", "Founder Mode podcast host"])
    assert.ok(!isFounderTitle(t), t);
  const person = (id: number, name: string, title: string): RawProfile => ({ crustdata_person_id: id, basic_profile: { name }, experience: { employment_details: { current: [{ title, crustdata_company_id: 1 }] } } });
  const picked = pickFounders([person(1, "Real Cto", "Co-founder & CTO"), person(2, "Pat Ops", "Head of Founder Relations"), person(3, "Sam Cs", "Founder Success Manager"), person(4, "Real Ceo", "CEO")], 1);
  assert.deepEqual(picked.map(f => f.name), ["Real Ceo", "Real Cto"], "the CEO first");
  const dup = pickFounders([person(1, "Ann Lee", "Founder"), person(2, "Ann Lee", "Founder")], 1);
  assert.equal(dup.length, 1, "the same person under two ids is kept once");
});

test("matching: letters in any alphabet, bare public suffixes, internships", () => {
  assert.ok(!schoolMatches("rich", "ETH Zürich"));
  assert.ok(!employerMatches("co.uk", { title: "Engineer", company: "Acme", domain: "acme.co.uk" }));
  assert.ok(!employerMatches("Ledgerpine", { title: "Software Engineering Intern", company: "Ledgerpine" }));
  assert.ok(employerMatches("Ledgerpine", { title: "Software Engineer", company: "Ledgerpine" }));
});

test("a Stealth founder role with no start date for the current role is not counted", () => {
  assert.equal(priorFounderRoles([{ title: "Founder", company: "Stealth Startup", companyId: 9, start: "2024-01-01", end: "2025-01-01" }], 1, undefined).length, 0);
});

test("round 2: more non-founder titles, the CEO kept over co-founders, and what a repeat founder is", () => {
  for (const t of ["CEO Assistant", "Executive Assistant, CEO", "Founder Coach", "Deputy CTO", "Field CTO"]) assert.ok(!isFounderTitle(t), t);
  const person = (id: number, name: string, title: string): RawProfile => ({ crustdata_person_id: id, basic_profile: { name }, experience: { employment_details: { current: [{ title, crustdata_company_id: 1 }] } } });
  const picked = pickFounders([person(1, "A One", "Co-Founder"), person(2, "B Two", "Co-Founder"), person(3, "C Three", "Co-Founder"), person(4, "D Ceo", "CEO")], 1);
  assert.ok(picked.some(f => f.name === "D Ceo"), "the CEO is never pushed out by co-founders");
  const role = (title: string, company: string, start?: string, end?: string, headcount?: number) => ({ title, company, companyId: 50, start, end, headcount });
  assert.equal(priorFounderRoles([role("Founder & President", "Stanford Blockchain Club", "2018-01-01", "2020-01-01")], 1).length, 0);
  assert.equal(priorFounderRoles([role("Founder", "Self-employed", "2021-01-01", "2023-01-01")], 1).length, 0);
  assert.equal(priorFounderRoles([role("CEO", "Jane Doe Consulting LLC", "2019-01-01", "2022-01-01", 1)], 1).length, 0);
  assert.equal(priorFounderRoles([role("Co-Founder", "Brightloop", "2022-01-01", "2022-04-01")], 1).length, 0, "a 3-month stint is not a company founded");
  assert.equal(priorFounderRoles([role("Co-Founder", "Brightloop", "2019-01-01", "2022-04-01", 12)], 1).length, 1);
});

test("round 3: side roles are not a second job; fund partners are not repeat founders; real companies with club or school in the name count", () => {
  const p: RawProfile = { crustdata_person_id: 9, basic_profile: { name: "Omar Example" }, experience: { employment_details: { current: [
    { title: "Co-Founder & CTO", crustdata_company_id: 1 }, { title: "Advisor", name: "Techstars", crustdata_company_id: 2 },
    { title: "Angel Investor", name: "Self-employed", crustdata_company_id: 3 }, { title: "Co-Founder", name: "Stealth Startup", crustdata_company_id: 4 },
    { title: "Venture Partner", name: "Brightfund Ventures", crustdata_company_id: 5 } ] } } };
  assert.deepEqual(pickFounders([p], 1)[0].alsoNow.map(r => r.title), ["Venture Partner"]);
  const role = (title: string, company: string, headcount?: number) => ({ title, company, companyId: 50, start: "2015-01-01", end: "2020-01-01", headcount });
  assert.equal(priorFounderRoles([role("Founder & General Partner", "Brightfund Ventures", 8)], 1).length, 0);
  assert.equal(priorFounderRoles([role("Co-Founder", "Razorpath Shave Club", 400)], 1).length, 1);
  assert.equal(priorFounderRoles([role("Founder", "Lambdawise School", 120)], 1).length, 1);
});
