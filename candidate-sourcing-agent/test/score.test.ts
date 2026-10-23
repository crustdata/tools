import { test } from "node:test";
import assert from "node:assert/strict";
import type { Person, Role } from "../src/crustdata.js";
import { domainOf, primaryRole, yearsWorked } from "../src/profile.js";
import { mergeSpec } from "../src/role.js";
import { WEIGHTS, scoreCandidate, titleMatch } from "../src/score.js";

const TODAY = new Date("2026-10-21T00:00:00Z");
const role = (title: string, start: string | null, end: string | null = null, extra: Partial<Role> = {}): Role =>
  ({ title, name: "Example Labs", start_date: start, end_date: end, company_website: "https://examplelabs.example/", company_headcount_latest: 120, company_headcount_range: "51-200", ...extra });
const person = (current: Role[], past: Role[] = [], extra: Partial<Person> = {}): Person => ({
  crustdata_person_id: 1, fit: "strong",
  basic_profile: { name: "Jane Doe", headline: "" },
  experience: { employment_details: { current, past } },
  skills: { professional_network_skills: ["PyTorch", "Python"] },
  ...extra,
});
const spec = (over: object = {}) => mergeSpec({ role: "Machine learning engineer", name: "t", title: "Machine learning engineer", must: ["PyTorch"], ...over });

test("title match: abbreviations, extra words, the main word", () => {
  assert.equal(titleMatch("Senior ML Engineer", "Machine learning engineer"), "exact");
  assert.equal(titleMatch("Engineer, Machine Learning", "Machine learning engineer"), "allWords");
  assert.equal(titleMatch("Software Engineer", "Machine learning engineer"), "mainWord");
  assert.equal(titleMatch("Data Scientist", "Machine learning engineer"), "none");
  assert.equal(titleMatch("Senior Backend Developer", "Senior backend engineer"), "exact", "developer and engineer are the same job");
});

test("years worked: overlaps once, gaps and internships left out, no dates means unknown", () => {
  const p = person([role("ML Engineer", "2022-01-01")], [role("Engineer", "2018-01-01", "2020-01-01"), role("Contractor", "2019-01-01", "2020-06-01"), role("Intern", "2016-01-01", "2017-01-01")]);
  // 2018-01 to 2020-06 (2.4 years) plus 2022-01 to 2026-10 (4.8 years), the 2020-06 to 2022-01 gap not counted.
  assert.equal(Math.floor(yearsWorked(p, TODAY)!), 7);
  assert.equal(yearsWorked(person([role("ML Engineer", null)]), TODAY), undefined);
});

test("the main role is a real job, not a side role marked as the default", () => {
  const p = person([role("Advisor", "2025-01-01", null, { is_default: true, name: "Example Ventures" }), role("Machine Learning Engineer", "2022-04-01", null, { name: "Example Health" })]);
  assert.equal(primaryRole(p)?.name, "Example Health");
});

test("a listed skill counts in full, one only written about counts half", () => {
  const listed = scoreCandidate(spec({ nice: ["Kubernetes"] }), person([role("Machine Learning Engineer", "2023-01-01")], [], { skills: { professional_network_skills: ["PyTorch", "Kubernetes"] } }), { today: TODAY });
  const written = scoreCandidate(spec({ nice: ["Kubernetes"] }), person([role("Machine Learning Engineer", "2023-01-01", null, { description: "Serving models on Kubernetes." })]), { today: TODAY });
  const missing = scoreCandidate(spec({ nice: ["Kubernetes"] }), person([role("Machine Learning Engineer", "2023-01-01")]), { today: TODAY });
  assert.ok(listed.score > written.score && written.score > missing.score);
  assert.ok(written.reasons.some(r => r.startsWith("writes about Kubernetes")));
  assert.deepEqual(missing.niceMissing, ["Kubernetes"]);
});

test("someone who just started scores lower than someone two to five years in", () => {
  const fresh = scoreCandidate(spec(), person([role("Machine Learning Engineer", "2026-08-01")], [role("ML Engineer", "2019-01-01", "2026-07-01")]), { today: TODAY });
  const settled = scoreCandidate(spec(), person([role("Machine Learning Engineer", "2023-08-01")], [role("ML Engineer", "2019-01-01", "2023-07-01")]), { today: TODAY });
  assert.ok(settled.score > fresh.score);
  assert.ok(fresh.reasons.some(r => r.includes("just started")));
});

test("rows that were not asked for are left out of the maximum, bonuses are capped at 100", () => {
  const p = person([role("Machine Learning Engineer", "2023-01-01")]);
  const s = scoreCandidate(spec(), p, { today: TODAY, open: true });
  // fit 25 + skills 20 + title 15 + tenure 10 = full marks on the four rows that apply, plus the open bonus
  assert.equal(s.score, 100);
  assert.ok(s.reasons.includes("open to new roles"));
  // No fit tier (past the top 200 of the ranked list) counts as "weak": never above someone Crustdata rated.
  const noFit = scoreCandidate(spec(), { ...p, fit: null }, { today: TODAY });
  const weak = scoreCandidate(spec(), { ...p, fit: "weak" }, { today: TODAY });
  assert.equal(noFit.score, weak.score);
  assert.equal(noFit.score, Math.round((100 * (70 - WEIGHTS.fit.max + WEIGHTS.fit.weak)) / 70));
  assert.ok(noFit.reasons.some(r => r.startsWith("below Crustdata's top-ranked group")));
});

test("no penalty for staying long or for more experience than the band asked", () => {
  const long = scoreCandidate(spec({ years: [3, 6] }), person([role("Machine Learning Engineer", "2016-01-01")]), { today: TODAY });
  const mid = scoreCandidate(spec({ years: [3, 6] }), person([role("Machine Learning Engineer", "2022-01-01")], [role("Engineer", "2020-01-01", "2021-12-01")]), { today: TODAY });
  assert.ok(long.score >= mid.score - 2, `${long.score} vs ${mid.score}`);
  assert.ok(long.reasons.some(r => r.includes("more than asked")));
});

test("short skill names match their case only: Go is not found in go to market", () => {
  const p = person([role("Machine Learning Engineer", "2023-01-01", null, { description: "Led go to market for R&D tools; C-level demos." })], [], { skills: { professional_network_skills: [] } });
  const s = scoreCandidate(spec({ must: [], skills: ["Go", "R", "C"] }), p, { today: TODAY });
  assert.deepEqual(s.missing, ["Go", "R", "C"]);
  const q = person([role("Backend Engineer", "2023-01-01", null, { description: "Services in Go and C++." })], [], { skills: { professional_network_skills: [] } });
  assert.deepEqual(scoreCandidate(spec({ must: [], skills: ["Go", "C++"] }), q, { today: TODAY }).missing, []);
});

test("dates that are not dates are ignored", () => {
  const p = person([role("Machine Learning Engineer", "Present")], [role("Engineer", "0", "Current")]);
  assert.equal(yearsWorked(p, TODAY), undefined);
});

test("past employer by domain, school by name, size band", () => {
  const p = person([role("Machine Learning Engineer", "2023-01-01")], [role("Engineer", "2018-01-01", "2022-12-01", { company_website: "https://www.exampleai.example/?utm_source=x", name: "Example AI" })],
    { education: { schools: [{ school: "Example State University" }] } });
  const s = scoreCandidate(spec({ past: ["exampleai.example"], schools: ["Example State"], sizes: ["51-200"] }), p, { today: TODAY });
  assert.ok(s.reasons.includes("worked at exampleai.example"));
  assert.ok(s.reasons.includes("studied at Example State University"));
  assert.ok(s.reasons.includes("company of 120 people"));
  // The number asked wins over the band: 120 people is outside "under 100" even though 51-200 is the band.
  const small = scoreCandidate(spec({ sizes: ["51-200"], sizeRange: [1, 99] }), p, { today: TODAY });
  assert.ok(small.reasons.includes("company of 120 people (outside the size asked)"));
  assert.equal(domainOf("https://www.ExampleAI.example/?utm_source=x"), "exampleai.example");
});

test("research records add a bonus with --papers", () => {
  const p = person([role("Research Engineer", "2023-01-01")], [], { research_profiles: [{ h_index: { all: 12 }, citations_count: { all: 900 } }] });
  const without = scoreCandidate(spec(), p, { today: TODAY });
  const withPapers = scoreCandidate(spec({ papers: true }), p, { today: TODAY });
  assert.equal(withPapers.score - without.score, WEIGHTS.research.h10);
  assert.ok(withPapers.reasons.some(r => r.startsWith("research: h-index 12")));
});
