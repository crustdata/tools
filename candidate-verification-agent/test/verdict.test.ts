import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { capabilities, parseResults, safeDownloadUrl, type PersonData } from "../src/crustdata.js";
import { dateConflicts } from "../src/dates.js";
import { fullResult, namesDiffer, quickResult, reviewOrder, sortForReview, summaryLine, verdictLabel, type Result } from "../src/verdict.js";
import { endpointsFor } from "../src/fake-api.js";

const NOW = Date.parse("2026-11-11T00:00:00Z");
const job = (title: string, start: string, end: string | null, extra = {}) => ({ title, name: "Example Co", start_date: `${start}T00:00:00+00:00`, end_date: end ? `${end}T00:00:00+00:00` : null, ...extra });
const person = (jobs: ReturnType<typeof job>[], schools: PersonData["education"]): PersonData => ({ experience: { employment_details: { current: jobs.filter(j => !j.end_date), past: jobs.filter(j => j.end_date) } }, education: schools });
const ms = (degree: string, sy: number | null, ey: number | null) => ({ schools: [{ school: "Example University", degree, start_year: sy, end_year: ey }] });

test("dates: a full-time job overlapping a full-time degree by more than six months is flagged", () => {
  const c = dateConflicts(person([job("Senior Engineer", "2018-01-01", "2019-12-01")], ms("Master of Science", 2017, 2019)), NOW);
  assert.equal(c.length, 1);
  assert.equal(c[0].months, 16);
  assert.match(c[0].text, /Senior Engineer at Example Co \(2018 to 2019\) overlaps Master of Science at Example University \(2017 to 2019\) by about 16 months/);
});

test("dates: what students do alongside study is never flagged", () => {
  for (const title of ["Software Engineering Intern", "Teaching Assistant", "Research Assistant", "Co-Founder", "Freelance Developer", "Part-time Barista", "Student Ambassador"]) {
    assert.deepEqual(dateConflicts(person([job(title, "2018-01-01", "2019-12-01")], ms("Bachelor of Science", 2016, 2020)), NOW), [], title);
  }
  assert.deepEqual(dateConflicts(person([job("Engineer", "2018-01-01", "2019-12-01", { employment_type: "Part-time" })], ms("Bachelor of Science", 2016, 2020)), NOW), []);
});

test("dates: part-time and research degrees, missing years and short overlaps are not flagged", () => {
  const work = [job("Engineer", "2018-01-01", null)];
  for (const degree of ["Executive MBA", "PhD", "Online Master of Computer Science", "Certificate in Data Science", "F24 Batch", "Part-time MBA"]) {
    assert.deepEqual(dateConflicts(person(work, ms(degree, 2017, 2019)), NOW), [], degree);
  }
  assert.deepEqual(dateConflicts(person(work, ms("Bachelor of Science", null, 2019)), NOW), []);
  // Job starts 1 Jan 2019, study ends 1 Jun 2019: five months, not flagged.
  assert.deepEqual(dateConflicts(person([job("Engineer", "2019-01-01", null)], ms("Bachelor of Science", 2015, 2019)), NOW), []);
  // Starting the job after graduating is the normal case.
  assert.deepEqual(dateConflicts(person([job("Engineer", "2019-07-01", null)], ms("BS", 2015, 2019)), NOW), []);
  // "Member of Technical Staff" is a full-time role.
  assert.equal(dateConflicts(person([job("Member of Technical Staff", "2016-01-01", null)], ms("Bachelor of Science", 2015, 2019)), NOW).length, 1);
});

const result = (over: Partial<Result>): Result => ({ profileUrl: "https://www.linkedin.com/in/example-x", check: "full", checkedAt: "2026-11-11T00:00:00Z", verdict: "cannot_verify", flags: [], citations: [], dateConflicts: [], ...over });

test("review order: evidence first; quick scores, date conflicts and name differences are questions, never Review first", () => {
  assert.equal(reviewOrder(result({ verdict: "clearly_fabricated" })), 1);
  assert.equal(reviewOrder(result({ verdict: "clearly_genuine" })), 9);
  assert.equal(reviewOrder(result({ verdict: "clearly_genuine", check: "quick", dateConflicts: ["x"] })), 6);
  assert.equal(reviewOrder(result({ verdict: "clearly_fabricated", check: "quick" })), 5);
  assert.equal(reviewOrder(result({ verdict: "probably_fabricated", check: "quick" })), 5);
  assert.equal(reviewOrder(result({ verdict: "clearly_fabricated", dateConflicts: ["x"] })), 1);
  assert.equal(reviewOrder(result({ verdict: "probably_genuine", nameMismatch: "x" })), 6);
  assert.equal(reviewOrder(result({ verdict: "probably_genuine", flags: ["past_roles_unverified"] })), 8);
  const sorted = sortForReview([
    { line: 2, result: result({ verdict: "clearly_genuine", confidence: 0.9 }) },
    { line: 3, result: result({ verdict: "probably_genuine", confidence: 0.8 }) },
    { line: 4, result: result({ verdict: "probably_genuine", confidence: 0.6 }) },
    { line: 5, result: result({ verdict: "probably_fabricated", confidence: 0.2 }) },
    { line: 6, result: result({ verdict: "probably_fabricated", confidence: 0.4 }) },
    { line: 7, result: result({ verdict: "not_checked", check: "none" }) },
  ]);
  // Inside a verdict, file order: confidence is a band per verdict, not a ranking.
  assert.deepEqual(sorted.map(s => s.line), [5, 6, 7, 3, 4, 2]);
});

test("names: accents, case and short forms match; different people do not", () => {
  assert.equal(namesDiffer("Jose Diaz", "José Díaz Pérez"), false);
  assert.equal(namesDiffer("Priya", "Priya Example"), false);
  assert.equal(namesDiffer("Someone Else", "Priya Example"), true);
  assert.equal(namesDiffer(undefined, "Priya Example"), false);
  assert.equal(namesDiffer("Sam Kumar", "Sam Testcase"), true);
  assert.equal(namesDiffer("Priya Kumar", "Rahul Kumar"), true);
  assert.equal(namesDiffer("Mohammed Al-Rashid", "Muhammed Alrashid"), false);
  assert.equal(namesDiffer("Aleksandr Ivanov", "Александр Иванов"), false, "different alphabets are not compared");
  assert.equal(namesDiffer("Xiaoming Wang", "王小明"), false);
  for (const [a, b] of [["Xiaoming Wang", "Wang Xiaoming"], ["Kim Min-jun", "Minjun Kim"], ["Nguyen Van An", "An Nguyen"], ["Ali Hassan", "Hassan Ali"], ["Rahul K", "Rahul Kumar"], ["S. Venkatesh", "Venkatesh Subramanian"], ["Dr. Ana Souza", "Ana Souza"], ["Smith, John", "John Smith"], ["Jane D.", "Jane Doe"], ["Mary-Kate Olsen", "Kate Olsen"], ["Li Na", "Na Li"], ["Mr. John Smith Jr.", "John Smith"]]) {
    assert.equal(namesDiffer(a, b), false, `${a} / ${b}`);
  }
});

test("full results: verdict, flags from both places, sources; a missing record is no verdict", () => {
  const r = fullResult("https://www.linkedin.com/in/example-x", { original_identifier: "x", data: { verdict: "probably_genuine", confidence: 0.65, reasoning: "Coworkers engaged. More text.", flags: ["past_roles_unverified"], coverage: { social_ran: true, coworker_hits: 7, flags: ["posts_unavailable"] }, citations: [{ url: "https://a.example", title: "A" }, { title: "no url" } as any] } }, undefined, NOW);
  assert.equal(r.check, "full");
  assert.deepEqual(r.flags, ["past_roles_unverified", "posts_unavailable"]);
  assert.equal(r.citations.length, 1);
  assert.match(summaryLine(r), /^Evidence supports the current role\. Coworkers engaged\. 7 people at the claimed employer engaged with recent posts\. Older roles not checked \(does not lower the verdict\)\.$/);
  const none = fullResult("https://www.linkedin.com/in/example-x", undefined, undefined, NOW);
  assert.equal(none.verdict, "not_checked");
  assert.match(none.note!, /not charged/);
  const odd = fullResult("u", { data: { verdict: "something_new" } }, undefined, NOW);
  assert.equal(odd.verdict, "not_checked");
  assert.equal(verdictLabel(odd), 'New verdict "something_new": read the reasoning');
  assert.equal(reviewOrder(odd), 5, "a billed verdict this version does not know is shown near the top, not hidden");
});

test("quick results: worded as a profile score, with tier and date conflicts", () => {
  const p: PersonData = { ...person([job("Engineer", "2016-01-01", null)], ms("Bachelor of Science", 2015, 2019)), basic_profile: { name: "X" }, assessment: { authenticity: { verdict: "probably_genuine", tier: 2 } } };
  const r = quickResult("u", p, NOW);
  assert.equal(r.check, "quick");
  assert.equal(r.tier, 2);
  assert.equal(r.dateConflicts.length, 1);
  assert.equal(verdictLabel(r), "Profile score: low risk; dates overlap study");
  assert.equal(reviewOrder(r), 6);
  assert.equal(quickResult("u", undefined, NOW).verdict, "not_checked");
  const noScore = quickResult("u", { basic_profile: { name: "X" } }, NOW);
  assert.equal(noScore.check, "none");
  assert.match(noScore.note!, /cannot read the profile score/);
});

test("results file: gzipped or plain JSON lines; a bad line is skipped, not fatal", () => {
  const text = '{"original_identifier":"a","data":{"verdict":"clearly_genuine"}}\nnot json\n[1]\n\n{"original_identifier":"b"}\n';
  for (const raw of [Buffer.from(text), gzipSync(text)]) {
    const { records, badLines } = parseResults(raw);
    assert.equal(records.length, 2);
    assert.equal(badLines, 2);
  }
});

test("results are downloaded only from Crustdata storage over https", () => {
  assert.ok(safeDownloadUrl("https://crustdata-batch-api-data.s3.amazonaws.com/id/output/results.jsonl.gz?X-Amz-Signature=x"));
  assert.ok(safeDownloadUrl("https://crustdata-batch-api-data.s3.us-east-2.amazonaws.com/id/x.gz"));
  for (const bad of ["http://crustdata-batch-api-data.s3.amazonaws.com/x", "https://evil.example/x", "https://crustdata-batch-api-data.s3.amazonaws.com.evil.example/x", "https://169.254.169.254/latest", "", undefined]) assert.equal(safeDownloadUrl(bad as string), false, String(bad));
});

test("capabilities from /account/endpoints", () => {
  assert.deepEqual(capabilities(endpointsFor({})), { verify: true, verifyCredits: 10, enrich: true, assessment: true, identify: true });
  const none = capabilities(endpointsFor({ verify: false, assessment: false, identify: false }));
  assert.equal(none.verify, false);
  assert.equal(none.assessment, false);
  assert.equal(none.identify, false);
});

test("dates: a past job with no end date never runs to today; jobs students hold in other languages are not flagged", () => {
  const p: PersonData = { experience: { employment_details: { current: [], past: [{ title: "Analyst", name: "Example Co", start_date: "2015-01-01T00:00:00+00:00", end_date: null }] } }, education: ms("Master of Science", 2019, 2021) };
  assert.deepEqual(dateConflicts(p, NOW), []);
  for (const title of ["Werkstudent Data", "Praktikant", "Stagiaire", "Becario", "Sales Associate", "Lab Assistant", "Instructor"]) {
    assert.deepEqual(dateConflicts(person([job(title, "2018-01-01", "2019-12-01")], ms("Bachelor of Arts", 2016, 2020)), NOW), [], title);
  }
  assert.deepEqual(dateConflicts(person([job("Developer", "2017-01-01", "2020-12-01")], ms("Master of Business Administration - MBA", 2019, 2021)), NOW), [], "MBAs are often part-time");
});

test("the AI text never keeps a name, in any alphabet", async () => {
  const { anonymize } = await import("../src/ai.js");
  assert.equal(anonymize("The profile of Élodie Durand shows Élodie at Acme", "Élodie Durand"), "The profile of the candidate shows the candidate at Acme");
  assert.equal(anonymize("Łukasz Żak works there", "Łukasz Żak"), "the candidate works there");
  assert.equal(anonymize("王小明 claims a role", "王小明"), "the candidate claims a role");
});

test("a probably fabricated verdict without the coworker check is a question, not Review first", () => {
  assert.equal(reviewOrder(result({ verdict: "probably_fabricated", flags: ["posts_unavailable"] })), 3);
  assert.equal(reviewOrder(result({ verdict: "probably_fabricated", coverage: { social_ran: false } })), 3);
  assert.equal(reviewOrder(result({ verdict: "probably_fabricated", coverage: { social_ran: true } })), 2);
});

test("a source cited twice is listed once", () => {
  const r = fullResult("u", { data: { verdict: "clearly_genuine", citations: [{ url: "https://a.example", title: "A" }, { url: "https://a.example", title: "A" }, { url: "https://b.example" }] } }, undefined, NOW);
  assert.equal(r.citations.length, 2);
});

test("a name difference makes even an evidence verdict a question first", () => {
  assert.equal(reviewOrder(result({ verdict: "clearly_fabricated", nameMismatch: "x" })), 6);
  assert.equal(reviewOrder(result({ verdict: "clearly_genuine", nameMismatch: "x" })), 6);
});
