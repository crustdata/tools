import assert from "node:assert/strict";
import { test } from "node:test";
import { fundingLine, momentumOf, money, roundName, trendLine } from "../src/company.js";
import type { RawPerson } from "../src/crustdata.js";
import { daysSince, dedupe, flagsOf, roleKey, skipReason, titleLevel, toJob, yearsRequired, type Job } from "../src/jobs.js";
import { draftNote, NOTE_LIMIT, shortRole, shortSchool } from "../src/notes.js";
import { boardOf } from "../src/open-check.js";
import { functionOf, nearness, pick, plainTitle, roleAt, searchesFor, type Person } from "../src/people.js";
import { resolveProfile } from "../src/profile.js";
import { csvCell, md, safeUrl } from "../src/render.js";
import { postingSkills, scoreJob, titleMatch, type Seeker } from "../src/score.js";
import { countryCondition, jobFilters, schoolAliases, spellingsFor, urlVariants } from "../src/hunt.js";

const NOW = new Date("2026-10-28T12:00:00Z");

function job(over: Partial<Job> & { desc?: string } = {}): Job {
  const base = toJob({
    crustdata_job_id: 1, job_details: { title: "Software Engineer", url: "https://boards.greenhouse.io/acme/jobs/1", source: "greenhouse", workplace_type: "On-site" },
    location: { raw: "San Francisco, CA", city: "San Francisco", state: "California", country: "United States" },
    metadata: { date_added: "2026-10-27T00:00:00" }, content: { description: over.desc ?? "Requirements\n- Go and Kubernetes" },
    company: { basic_info: { crustdata_company_id: 7, name: "Acme", primary_domain: "acme.example", industries: ["Software Development"] }, headcount: { total: 100 } },
  })!;
  const { desc: _d, ...rest } = over;
  return { ...base, ...rest };
}

const me: Seeker = { skills: ["Go", "Kubernetes", "Python"], titles: ["software engineer"], years: 5, remote: "no", needsSponsorship: false };

test("job rows: category numbers dropped, HTML descriptions become text, missing ids are skipped", () => {
  const j = toJob({ crustdata_job_id: 5, job_details: { title: "Eng", category: "312 - Engineering" }, content: { description: "<p>Go &amp; Rust</p><ul><li>One</li></ul>" } })!;
  assert.equal(j.category, "Engineering");
  assert.match(j.description, /Go & Rust\n+- One/);
  assert.equal(toJob({ job_details: { title: "x" } }), null);
  assert.equal(toJob({ crustdata_job_id: 1, job_details: { title: "  " } }), null);
});

test("the same role on several job sites is one row, keeping the listing whose openness can be checked", () => {
  const a = job({ id: "a", title: "Sr. Software Engineer (Remote)", source: "indeed", url: "https://x.example/1", postedAt: "2026-10-27T00:00:00" });
  const b = job({ id: "b", title: "Senior Software Engineer", source: "greenhouse", postedAt: "2026-10-20T00:00:00" });
  const c = job({ id: "c", title: "Senior Software Engineer", company: { ...a.company, id: 8, name: "Other" } });
  const out = dedupe([a, b, c]);
  assert.equal(out.length, 2);
  const kept = out.find(j => j.company.id === 7)!;
  assert.equal(kept.id, "b");
  assert.equal(kept.alsoListed, 1);
  assert.equal(kept.postedAt, "2026-10-27T00:00:00", "the newest date of the group is kept");
  assert.equal(roleKey("Sr. Software Eng. - SF"), roleKey("Senior Software Engineer"));
});

test("agencies, skipped companies and title words are left out with a reason", () => {
  const agency = job({ company: { ...job().company, industries: ["Staffing and Recruiting"] } });
  assert.equal(skipReason(agency, { agencies: true, companies: [], titleWords: [] }), "staffing agency");
  assert.equal(skipReason(agency, { agencies: false, companies: [], titleWords: [] }), null);
  assert.match(String(skipReason(job(), { agencies: true, companies: ["https://www.acme.example/careers"], titleWords: [] })), /skipped company/);
  assert.match(String(skipReason(job({ title: "Software Engineer Intern" }), { agencies: true, companies: [], titleWords: ["intern"] })), /intern/);
  assert.equal(skipReason(job({ title: "Internal Tools Engineer" }), { agencies: true, companies: [], titleWords: ["intern"] }), null);
});

test("levels from titles and the years a posting asks for", () => {
  assert.equal(titleLevel("Software Engineer Intern"), -1);
  assert.equal(titleLevel("New Grad Software Engineer"), 0);
  assert.equal(titleLevel("Software Engineer II"), 1);
  assert.equal(titleLevel("Senior / Staff Software Engineer"), 3);
  assert.equal(titleLevel("Senior Principal Engineer"), 4);
  assert.equal(titleLevel("Associate Director, Engineering"), 4);
  assert.equal(titleLevel("Staff Engineer"), 3);
  assert.equal(titleLevel("Principal Engineer"), 4);
  assert.equal(yearsRequired("5+ years of software engineering experience; 3+ years with Go experience"), 3);
  assert.equal(yearsRequired("Founded 25 years ago. 2-4 years of experience."), 2);
  assert.equal(yearsRequired("We have 100 years of history"), null);
});

test("visa, clearance and citizenship flags read the usual phrasings", () => {
  for (const d of ["We are unable to sponsor visas.", "This role does not offer visa sponsorship.", "Candidates must be authorized to work without sponsorship.", "No H1B sponsorship.", "We will not sponsor employment visas"]) {
    assert.equal(flagsOf(job({ desc: d })).noSponsorship, true, d);
  }
  assert.equal(flagsOf(job({ desc: "We sponsor visas for this role." })).noSponsorship, false);
  assert.equal(flagsOf(job({ desc: "Active TS/SCI clearance required" })).clearance, true);
  assert.equal(flagsOf(job({ desc: "Must be a U.S. citizen" })).citizensOnly, true);
  assert.equal(daysSince("2026-10-27T12:00:00", NOW), 1);
  assert.equal(daysSince("garbage", NOW), null);
});

test("posting skills split into required and nice to have", () => {
  const p = postingSkills(job({ desc: "Requirements\n- Go\n- Kubernetes\n\nNice to have\n- Rust\n- Go\n\nAbout us\nWe use Python a lot" }));
  assert.deepEqual(p.required.sort(), ["Go", "Kubernetes", "Python"]);
  assert.deepEqual(p.nice, ["Rust"]);
  assert.deepEqual(postingSkills(job({ desc: "Terraform is a plus" })).nice, ["Terraform"]);
});

test("the fit score adds up, explains itself and takes points for flags", () => {
  const good = scoreJob(job(), me, null, NOW);
  assert.equal(good.label, "Strong fit");
  assert.deepEqual(good.matched, ["Go", "Kubernetes"]);
  assert.equal(good.parts.skills, 50);
  const visa = scoreJob(job({ desc: "Go, Kubernetes. We are unable to sponsor visas." }), { ...me, needsSponsorship: true }, null, NOW);
  assert.equal(good.score - visa.score, 25);
  assert.ok(visa.flags.some(f => /sponsor/.test(f)));
  const noVisaNeeded = scoreJob(job({ desc: "Go, Kubernetes. We are unable to sponsor visas." }), me, null, NOW);
  assert.equal(noVisaNeeded.score, good.score, "no penalty when you do not need sponsorship, only the flag");
  const senior = scoreJob(job({ title: "Principal Software Engineer", desc: "Go. 12+ years of experience." }), { ...me, years: 2 }, null, NOW);
  assert.ok(senior.flags.some(f => /Pitched at principal/.test(f)) && senior.flags.some(f => /12\+ years/.test(f)));
  const blank = scoreJob(job({ desc: "We are a great team." }), me, null, NOW);
  assert.equal(blank.parts.skills, 25);
  assert.equal(titleMatch("Backend Developer", ["backend engineer"]), 1);
  assert.equal(titleMatch("Data Scientist", ["software engineer"]), 0);
});

test("company growth and funding lines", () => {
  const m = momentumOf({ headcount: { total: 1409, growth_percent: { "6m": 19.3, "12m": 67.7 } }, funding: { last_round_type: "series_e", last_fundraise_date: "2026-09-22", last_round_amount_usd: 350e6, total_investment_usd: 585.25e6 } });
  assert.equal(m.trend, "growing");
  assert.equal(trendLine(m), "Growing: 1,409 people, +19% in 6 months, +68% in 12 months");
  assert.equal(fundingLine(m), "Series E, $350M, Sep 2026 ($585M raised in total)");
  assert.equal(momentumOf({ headcount: { growth_percent: { "6m": -9 } } }).trend, "shrinking");
  assert.equal(momentumOf(undefined).trend, "unknown");
  assert.equal(fundingLine(momentumOf(undefined)), null);
  assert.equal(money(4_200_000), "$4.2M");
  assert.equal(roundName("secondary_market"), "Secondary sale");
  assert.equal(roundName("weird_new_round"), "Weird new round");
});

test("people searches: recruiter type follows the job, country first, alumni by every spelling", () => {
  assert.equal(functionOf({ title: "Senior Backend Engineer", category: null }), "engineering");
  assert.equal(functionOf({ title: "Machine Learning Engineer", category: null }), "data");
  assert.equal(functionOf({ title: "Account Executive", category: null }), "sales");
  assert.equal(plainTitle("Senior Backend Engineer (Remote) - Payments"), "Backend Engineer");
  const s = searchesFor(job(), ["University of California, Berkeley", "UC Berkeley"], undefined, "United States");
  assert.deepEqual(s.map(x => x.kind), ["recruiter", "manager", "alumni", "team"]);
  assert.match(s[0].query, /technical recruiter/);
  assert.deepEqual((s[0].extra as { value: string[] }).value, ["United States", "United States of America"]);
  assert.equal(s[2].local, undefined);
  assert.equal((s[2].extra as { op: string }).op, "or");
  assert.equal(searchesFor(job(), []).length, 3);
});

const P = (name: string, title: string, extra: Partial<RawPerson> = {}, companyId = 7): RawPerson => ({
  crustdata_person_id: name.length, basic_profile: { name, location: { full_location: "New York, New York, United States" } },
  experience: { employment_details: { current: [{ title, crustdata_company_id: companyId, start_date: "2024-01-01T00:00:00" }] } },
  social_handles: { professional_network_identifier: { profile_url: `https://www.linkedin.com/in/example-${name.toLowerCase().replace(/\s/g, "-")}` } },
  ...extra,
});

test("picking people: titles must fit the kind, advisors drop out, nobody twice, nearest first", () => {
  const taken = new Set<string>();
  const recs = pick("recruiter", [P("Ann One", "Software Engineer"), P("Bo Two", "Senior Technical Recruiter / Consultant via Agency"), P("Cy Three", "Technical Recruiter", { basic_profile: { name: "Cy Three", location: { full_location: "San Francisco Bay Area" } } })], 7, 2, [], taken, { city: "San Francisco", state: "California" });
  assert.deepEqual(recs.map(p => p.name), ["Cy Three", "Bo Two"]);
  const team = pick("team", [P("Bo Two", "Senior Technical Recruiter"), P("Di Four", "Technical Advisor"), P("Ed Five", "Software Engineer"), P("Ed Five", "Software Engineer")], 7, 3, [], taken);
  assert.deepEqual(team.map(p => p.name), ["Ed Five"]);
  const alumni = pick("alumni", [P("Fa Six", "Engineer", { education: { schools: [{ school: "UC Berkeley College of Engineering", end_year: 2021 }] } }), P("Gi Seven", "Engineer", { education: { schools: [{ school: "Stanford University" }] } })], 7, 3, ["UC Berkeley"], new Set());
  assert.deepEqual(alumni.map(p => [p.name, p.schoolYear]), [["Fa Six", 2021]]);
  const two = P("Hu Eight", "Investor", {});
  two.experience!.employment_details!.current!.push({ title: "Staff Engineer", crustdata_company_id: 7 });
  assert.equal(roleAt(two, 7)?.title, "Staff Engineer");
  assert.equal(roleAt(two, 99), null);
  assert.equal(nearness("San Mateo, California, United States", { city: "San Francisco" }), 2);
  assert.equal(nearness("Los Angeles, California, United States", { location: "San Jose, CA" }), 1);
  assert.equal(nearness("London, England", { city: "San Francisco", state: "California" }), 0);
});

test("draft notes stay under 300 characters and never name a practice as a tool", () => {
  const person: Person = { kind: "recruiter", name: "Maximiliana Alexandrovna Konstantinopolskaya-Weatherby", title: "Recruiter", location: null, profileUrl: null, since: null, school: null, schoolYear: null, email: null };
  const long = job({ title: "Senior Staff Principal Distinguished Software Engineer, Infrastructure Platform Reliability and Developer Productivity (Remote, US)" , company: { ...job().company, name: "A Company With An Extraordinarily Long Legal Name Incorporated Worldwide Holdings" } });
  for (const kind of ["recruiter", "manager", "team", "alumni"] as const) {
    const n = draftNote({ ...person, kind, school: "University of California, Berkeley, Haas School of Business" }, long, { handYears: 5, matched: ["Distributed systems", "Go"], school: "University of California, Berkeley" });
    assert.ok(n.length <= NOTE_LIMIT, `${kind}: ${n.length}`);
  }
  const n = draftNote({ ...person, name: "Dr. Ann Lee" }, job(), { handYears: null, matched: ["Distributed systems", "CI/CD", "Go"], school: null });
  assert.match(n, /^Hi Ann, /);
  assert.match(n, /I've been working with Go\./);
  assert.doesNotMatch(n, /years/, "no years claimed unless set by hand");
  assert.match(draftNote({ ...person, name: "Bo" }, job(), { handYears: 4, matched: ["Go"], school: null }), /I have 4 years of experience in this kind of work, including Go\./);
  assert.doesNotMatch(draftNote({ ...person, name: "Bo" }, job(), { handYears: null, matched: [], school: null }), /working with|years/);
  // The alumni note names your school, not the other person's spelling of it.
  const alum = draftNote({ ...person, kind: "alumni", name: "Cy", school: "UC Berkeley College of Engineering" }, job(), { handYears: null, matched: [], school: "University of California, Berkeley" });
  assert.match(alum, /we both went to UC Berkeley\./);
  // "$" in a company name is not read as a replacement pattern.
  assert.match(draftNote({ ...person, name: "Di" }, job({ company: { ...job().company, name: "Money$'Corp" } }), { handYears: null, matched: [], school: null }), /at Money\$'Corp\. Who/);
  assert.equal(shortSchool("University of California, Berkeley, Haas School of Business"), "UC Berkeley");
  assert.equal(shortRole("Software Engineer (Infra)"), "Software Engineer (Infra)");
  assert.equal(shortRole("Backend Engineer (Remote, US) - Payments"), "Backend Engineer");
});

test("job board links: Greenhouse, Lever, Ashby, SmartRecruiters; anything else is not checked", () => {
  assert.deepEqual(boardOf("https://boards.greenhouse.io/acme/jobs/123"), { board: "greenhouse", org: "acme", id: "123" });
  assert.deepEqual(boardOf("https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x"), { board: "greenhouse", org: "acme", id: "123" });
  assert.deepEqual(boardOf("https://boards.greenhouse.io/embed/job_app?for=acme&token=55"), { board: "greenhouse", org: "acme", id: "55" });
  assert.equal(boardOf("https://jobs.lever.co/acme/0b5e7a52-1111-4c4c-9a9a-000000000001")?.board, "lever");
  assert.equal((boardOf("https://jobs.eu.lever.co/acme/0b5e7a52-1111-4c4c-9a9a-000000000001") as { eu?: boolean }).eu, true);
  assert.equal(boardOf("https://jobs.ashbyhq.com/acme/2A1D0C7E-2222-4d4d-8b8b-000000000002")?.id, "2a1d0c7e-2222-4d4d-8b8b-000000000002");
  assert.equal(boardOf("https://jobs.smartrecruiters.com/Acme/7440000001-engineer")?.id, "7440000001");
  assert.equal(boardOf("https://evil.example/boards.greenhouse.io/acme/jobs/1"), null);
  assert.equal(boardOf("javascript:alert(1)"), null);
  assert.equal(boardOf(null), null);
});

test("report text is escaped, links are http(s) only, CSV cells never run as formulas", () => {
  assert.equal(md("A | B [x](y) <b>\nnext"), "A \\| B \\[x\\](y) \\<b\\> next");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://a.example/x)y"), "https://a.example/x%29y");
  assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(csvCell("-1"), "'-1");
  assert.equal(csvCell(null), "");
});

test("profile: defaults, flags win, bad values get a sentence", () => {
  const p = resolveProfile({ titles: ["engineer"], location: "Austin", skills: ["golang"] }, { location: "Denver", top: 3 });
  assert.equal(p.location, "Denver");
  assert.equal(p.top, 3);
  assert.deepEqual(p.skills, ["Go"]);
  assert.throws(() => resolveProfile({}, {}), /No job title/);
  assert.throws(() => resolveProfile({ titles: ["x"] }, {}), /No location/);
  assert.doesNotThrow(() => resolveProfile({ titles: ["x"], remote: "only" }, {}));
  assert.throws(() => resolveProfile({ titles: ["x"], location: "y", days: 400 }, {}), /days must be/);
  assert.doesNotThrow(() => resolveProfile({}, {}, "job"));
  assert.equal(resolveProfile({ titles: ["x"], location: "y", scan: 5, top: 10 }, {}).top, 5);
});

test("search filters: titles as an or, place near or remote, date window", () => {
  const p = resolveProfile({ titles: ["software engineer", "backend engineer"], location: "San Francisco", remote: "also" }, {});
  const f = jobFilters(p, NOW) as { conditions: Array<{ op?: string; conditions?: unknown[]; value?: unknown }> };
  assert.equal(f.conditions[0].op, "or");
  assert.equal(f.conditions[1].op, "or");
  assert.equal(f.conditions[2].value, "2026-09-28");
});

test("school spellings: aliases both ways, suggestions that name the same school, no other campuses", () => {
  assert.ok(schoolAliases("University of California, Berkeley").includes("UC Berkeley"));
  assert.ok(schoolAliases("MIT").includes("Massachusetts Institute of Technology"));
  const s = spellingsFor("University of California, Berkeley", ["University of California, Berkeley, Haas School of Business", "University of California, Los Angeles", "Berkeley City College"]);
  assert.deepEqual(s, ["University of California, Berkeley", "UC Berkeley"]);
  assert.deepEqual(spellingsFor("IIT Bombay", ["IIT, Bombay", "IIT-Bombay", "IIT Bombay - Shailesh J. Mehta School of Management"]).slice(0, 2), ["IIT Bombay", "Indian Institute of Technology, Bombay"]);
});

test("posting URLs are also tried without tracking parameters", () => {
  assert.deepEqual(urlVariants("https://boards.greenhouse.io/acme/jobs/1?gh_src=abc&utm_source=x"), ["https://boards.greenhouse.io/acme/jobs/1?gh_src=abc&utm_source=x", "https://boards.greenhouse.io/acme/jobs/1"]);
});

test("a listing with no company record joins the same role at the company that has one; agencies by name", () => {
  const withId = job({ id: "x", title: "Software Engineer, Infrastructure", source: "ashby", company: { ...job().company, id: 5, name: "Sodalis AI" } });
  const noId = job({ id: "y", title: "Software Engineer, Infrastructure", source: "greenhouse", company: { ...job().company, id: null, name: "SODALIS" } });
  const out = dedupe([noId, withId]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "x");
  const agency = job({ company: { ...job().company, name: "Ronaj Recruitment", industries: ["Technology, Information and Internet"] } });
  assert.equal(skipReason(agency, { agencies: true, companies: [], titleWords: [] }), "staffing agency");
  assert.equal(skipReason(job({ company: { ...job().company, name: "Recruit Holdings" } }), { agencies: true, companies: [], titleWords: [] }), null);
});

test("a posting sent as one long line still has its nice-to-have part recognised", () => {
  const p = postingSkills(job({ desc: "About Us We build tools. You Might Be a Good Fit If You Have Go and Kubernetes experience. You Might Be a Great Fit If You Have used Rust and Terraform." }));
  assert.deepEqual(p.required.sort(), ["Go", "Kubernetes"]);
  assert.deepEqual(p.nice.sort(), ["Rust", "Terraform"]);
});

test("school spellings never pull in another school; US country forms; job links copied from search pages", () => {
  assert.deepEqual(spellingsFor("University of Washington", ["University of Washington", "Washington State University", "University of Washington Bothell", "Central Washington University"]), ["University of Washington"]);
  assert.deepEqual(spellingsFor("UIUC", ["University of Illinois Urbana-Champaign", "UIUC"]), ["UIUC", "University of Illinois Urbana-Champaign"]);
  assert.deepEqual((countryCondition("USA") as { value: unknown }).value, ["United States", "United States of America", "USA"]);
  assert.equal((countryCondition("Germany") as { value: unknown }).value, "Germany");
  assert.equal(urlVariants("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4012345678")[0], "https://www.linkedin.com/jobs/view/4012345678");
  assert.equal(urlVariants("https://www.linkedin.com/jobs/view/senior-engineer-at-acme-4012345678/")[0], "https://www.linkedin.com/jobs/view/4012345678");
});

test("setup reads CV paths the way people paste them", async () => {
  const { cleanPath } = await import("../src/setup.js");
  const { homedir } = await import("node:os");
  assert.equal(cleanPath("'/tmp/My Resume 2026.pdf'"), "/tmp/My Resume 2026.pdf");
  assert.equal(cleanPath("/tmp/My\\ Resume\\ \\(final\\).pdf "), "/tmp/My Resume (final).pdf");
  assert.equal(cleanPath("~/Documents/cv.pdf"), `${homedir()}/Documents/cv.pdf`);
  assert.equal(cleanPath("cv.md", "/work"), "/work/cv.md");
});

test(".env values written by setup read back the same with Node's own parser", async () => {
  const { envText, quote } = await import("../src/setup.js");
  const { parseEnv } = await import("node:util");
  for (const v of ["plain", "with space", "a#hash", "quote'inside", "both'and\"", "$dollar"]) {
    assert.equal(parseEnv(`K=${quote(v)}`).K, v, v);
  }
  const text = envText("# comment\nCRUSTDATA_API_KEY=\nCACHE_DAYS=14\n", { CRUSTDATA_API_KEY: "k y", OTHER: "1" });
  assert.match(text, /^# comment\nCRUSTDATA_API_KEY='k y'\nCACHE_DAYS=14\n/);
  assert.match(text, /# Other settings\nOTHER=1/);
});

test("an alumni note names the school you share with that person, not your first school", async () => {
  const { sharedSchool } = await import("../src/hunt.js");
  const owners = new Map([["hack reactor", "Hack Reactor"], ["university of michigan", "University of Michigan"]]);
  assert.equal(sharedSchool("University of Michigan - Stephen M. Ross School of Business", owners), "University of Michigan");
  assert.equal(sharedSchool("Hack Reactor", owners), "Hack Reactor");
  assert.equal(sharedSchool("Michigan State University", owners), null);
});

test("round 2 regressions: posting text with '<', learning markers, odd prices, people outside the job's line of work", async () => {
  const { plainText } = await import("../src/jobs.js");
  assert.equal(plainText("Need 3+ years (<5 at most) and C++ < Go"), "Need 3+ years (<5 at most) and C++ < Go");
  assert.equal(plainText("<p>&lt;5 years of experience</p><ul><li>Go</li></ul>"), "<5 years of experience\n\n- Go");
  const { parseCv } = await import("../src/cv.js");
  assert.deepEqual(parseCv("Python / TypeScript / Go (basic)").skills.sort(), ["Python", "TypeScript"]);
  assert.deepEqual(parseCv("Python, Kubernetes and Terraform (learning)").skills.sort(), ["Kubernetes", "Python"]);
  const { pricesFrom, LIST_PRICES } = await import("../src/crustdata.js");
  const odd = pricesFrom([{ path: "/person/search", base_credits: "0.03" as unknown as number, premium_fields: null as unknown as [] }]);
  assert.equal(odd.person, LIST_PRICES.person, "strings and missing lists fall back to the price list");
  assert.ok(Number.isFinite(pricesFrom([{ path: "/company/search", premium_fields: [{ field: "headcount", credits: null as unknown as number }] }]).company));
  const mgr = pick("manager", [P("Ann One", "Account Manager"), P("Bo Two", "Engineering Manager")], 7, 1, [], new Set(), { title: "Backend Engineer" });
  assert.deepEqual(mgr.map(p => p.name), ["Bo Two"]);
  const team = pick("team", [P("Cy Three", "Sales Development Representative"), P("Di Four", "Data Engineer")], 7, 3, [], new Set(), { title: "Backend Engineer" });
  assert.deepEqual(team.map(p => p.name), ["Di Four"]);
  const alum = pick("alumni", [P("Ed Five", "Engineer", { education: { schools: [{ school: "École Polytechnique" }] } })], 7, 3, ["Ecole Polytechnique"], new Set());
  assert.equal(alum.length, 1);
  const { first } = await import("../src/notes.js");
  assert.equal(first("🙂 Ana Lopez"), "Ana");
  assert.equal(first("Dr Sir"), "there");
});

test("years: the line below a date is the next job, not this one; old two-digit years", async () => {
  const { yearsOfExperience } = await import("../src/cv.js");
  const now = new Date("2026-10-28T12:00:00Z");
  const cv = "Experience\nBarista, Cafe\n2015 - 2025\nSoftware Engineer, Acme\n2025 - Present";
  assert.ok((yearsOfExperience(cv, now) ?? 9) < 2, String(yearsOfExperience(cv, now)));
  assert.equal(yearsOfExperience("Summary\n7 years of experience in Python and Go.", now), 7);
  assert.equal(yearsOfExperience("Experience\nDeveloper, Acme (Jun '98 - May '02)", now), 4);
});

test("round 3: titles by role noun, whole-word staff filters, tool claims never lower the dates, one note per person per company", async () => {
  assert.equal(functionOf({ title: "Product Manager, AI", category: null }), "product");
  assert.equal(functionOf({ title: "Account Executive, AI Solutions", category: null }), "sales");
  assert.equal(functionOf({ title: "Machine Learning Engineer", category: null }), "data");
  const keep = pick("team", [P("Ann One", "Software Engineer, Dashboard"), P("Bo Two", "Software Engineer - Los Angeles"), P("Cy Three", "Board Member")], 7, 3, [], new Set(), { title: "Software Engineer" });
  assert.deepEqual(keep.map(p => p.name), ["Ann One", "Bo Two"]);
  const mgr = pick("manager", [P("Di Four", "Engineering Manager, Onboarding")], 7, 1, [], new Set(), { title: "Software Engineer" });
  assert.equal(mgr.length, 1);
  const { yearsOfExperience, parseCv, schoolFromLine } = await import("../src/cv.js");
  const now = new Date("2026-10-28T12:00:00Z");
  assert.equal(yearsOfExperience("Summary\n2 years of experience with Kubernetes.\nExperience\nEngineer (Jan 2020 - Present)", now), 6.8);
  assert.ok((yearsOfExperience("Experience\nBarista\nStarbucks Coffee, Jan 2015 - Dec 2018\nSoftware Engineer\nAcme Corp, Jan 2019 - Dec 2020", now) ?? 9) < 2.5);
  assert.ok(!parseCv("React Native (learning), Python").skills.includes("React"));
  assert.equal(schoolFromLine("B.S. Computer Science from University of Texas at Austin"), "University of Texas at Austin");
  assert.equal(schoolFromLine("Indian Institute of Technology (IIT) Bombay, B.Tech 2015"), "Indian Institute of Technology Bombay");
  assert.equal(schoolFromLine("MBA, Harvard Business School, 2019"), "Harvard Business School");
  const { markRepeats, schoolAliases } = await import("../src/hunt.js");
  assert.ok(schoolAliases("University of Texas, Austin").includes("University of Texas at Austin"));
  const person = (name: string, kind: "recruiter" | "alumni"): Person => ({ kind, name, title: kind === "alumni" ? "Data Engineer" : "Recruiter", location: null, profileUrl: `https://x.example/in/${name}`, since: null, school: null, schoolYear: null, email: null });
  const a = { job: job({ title: "Data Engineer" }), people: [person("uma", "alumni"), person("rex", "recruiter")] };
  const b = { job: job({ id: "2", title: "Senior Data Engineer" }), people: [person("uma", "alumni"), person("rex", "recruiter")] };
  markRepeats([a, b]);
  assert.equal(a.people.filter(p => p.first).length, 1);
  assert.equal(b.people.filter(p => p.first).length, 0, "one person to write to first per company");
  assert.deepEqual(b.people.map(p => p.alsoFor), [1, 1]);
});
