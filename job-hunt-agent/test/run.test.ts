import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import { main } from "../src/cli.js";
import { pacing } from "../src/crustdata.js";
import { dashboardApp } from "../src/dashboard.js";
import { fakeFetch, type Call, type Fixture } from "../src/fake-api.js";
import { Store } from "../src/store.js";

pacing.on = false;
const HUNT = JSON.parse(readFileSync(new URL("../fixtures/hunt-sf.json", import.meta.url), "utf8")) as Fixture;
const CV = fileURLToPath(new URL("../examples/cv-example.md", import.meta.url));

let out: string;
let calls: Call[];

function useFixture(fx: Fixture) {
  const f = fakeFetch(fx);
  calls = f.calls;
  globalThis.fetch = f.fetch;
}

async function run(argv: string[], fx: Fixture = HUNT): Promise<number> {
  useFixture(fx);
  return main(argv);
}

const runs = () => readdirSync(out).filter(d => existsSync(join(out, d, "jobs.json")));
const lastRun = () => JSON.parse(readFileSync(join(out, runs().sort((a, b) => statSync(join(out, a, "jobs.json")).mtimeMs - statSync(join(out, b, "jobs.json")).mtimeMs).at(-1)!, "jobs.json"), "utf8"));
const paid = (path: string) => calls.filter(c => c.path === path && c.body?.limit !== 0).length;

beforeEach(() => {
  // Settings from the developer's shell must not change what the tests see.
  for (const k of ["CACHE_DAYS", "DASHBOARD_PORT", "MAX_CREDITS_PER_RUN", "JHA_REPLAY", "OUT_DIR", "DB_PATH", "PROFILE_PATH"]) delete process.env[k];
  out = mkdtempSync(join(tmpdir(), "jha-run-"));
  process.env.OUT_DIR = out;
  process.env.DB_PATH = join(out, "test.db");
  process.env.PROFILE_PATH = join(out, "profile.json");
  process.env.CRUSTDATA_API_KEY = "test-key";
  process.env.JHA_NOW = HUNT.now;
  process.env.MAX_CREDITS_PER_RUN = "30";
  delete process.env.INIT_CWD;
});

const ARGS = ["hunt", "--title", "software engineer", "--location", "San Francisco", "--cv", CV, "--top", "5"];

test("a hunt reads jobs, folds duplicates, drops agencies and closed jobs, finds people and writes every file", async () => {
  assert.equal(await run(ARGS), 0);
  const r = lastRun();
  assert.equal(r.jobs.length, 5);
  assert.equal(r.counts.unique, 7);
  assert.deepEqual(r.counts.skipped, { "staffing agency": 1 });
  assert.deepEqual(r.closed.map((c: { title: string }) => c.title), ["Staff Software Engineer, Infrastructure"]);
  const top = r.jobs[0];
  assert.equal(top.job.company.name, "Northwind Robotics");
  assert.equal(top.job.alsoListed, 1);
  assert.equal(top.open, "open");
  const kinds = top.people.map((p: { kind: string; name: string }) => `${p.kind}:${p.name}`);
  assert.ok(kinds.includes("recruiter:Avery Example"));
  assert.ok(kinds.includes("manager:Casey Placeholder"));
  assert.ok(!kinds.some((k: string) => k.includes("Gray Fixture")), "advisors are not team members");
  assert.ok(kinds.includes("alumni:Harper Demo") || kinds.includes("alumni:Devon Testcase"));
  // A startup with nobody in the US still gets its people (searched again without the country).
  const tail = r.jobs.find((j: { job: { company: { name: string } } }) => j.job.company.name === "Tailspin Data");
  assert.ok(tail.people.some((p: { location: string }) => /Toronto/.test(p.location)));
  const lit = r.jobs.find((j: { job: { company: { name: string } } }) => j.job.company.name === "Litware Systems");
  assert.ok(lit.fit.flags.some((f: string) => /clearance/.test(f)) && lit.fit.flags.some((f: string) => /citizens/.test(f)));
  for (const j of r.jobs) for (const p of j.people) assert.ok(p.note.length > 20 && p.note.length <= 300);

  const dir = join(out, runs()[0]);
  const report = readFileSync(join(dir, "report.md"), "utf8");
  assert.match(report, /Drafts only: nothing was sent/);
  assert.match(report, /Closed on their job board/);
  assert.doesNotMatch(report, /[\u2014\u2013]/, "no long dashes in the report");
  assert.match(readFileSync(join(dir, "jobs.csv"), "utf8").split("\n")[0], /^rank,score,fit,title/);
  assert.equal(readdirSync(join(dir, "jobs")).length, 5);
  assert.ok(r.credits > 0 && r.credits < r.estimate, `${r.credits} within the estimate`);
  // Weak fits (under 50) get no people search unless --all, and the run says so.
  assert.equal(lit.people.length, 0);
  assert.match(r.notes.join(" "), /weak fits? \(under 50\) got no people search/);
});

test("a second run pays nothing for companies and people it already has, and marks jobs as seen", async () => {
  await run(ARGS);
  assert.ok(paid("/person/search") > 0);
  await run(ARGS);
  assert.equal(paid("/person/search"), 0);
  assert.equal(paid("/company/search"), 0);
  assert.equal(lastRun().jobs.every((j: { isNew: boolean }) => !j.isNew), true);
  await run([...ARGS, "--refresh"]);
  assert.ok(paid("/person/search") > 0, "--refresh asks again");
});

test("--emails keeps only addresses at the hiring company; a key without contact data gets a plain note", async () => {
  await run([...ARGS, "--emails", "--yes"]);
  const people = lastRun().jobs[0].people;
  assert.equal(people.find((p: { name: string }) => p.name === "Avery Example").email, "avery@northwind.example");
  assert.equal(people.find((p: { name: string }) => p.name === "Casey Placeholder").email, null);
  await run([...ARGS, "--emails", "--refresh", "--yes"], { ...HUNT, forbidden: ["/person/contact/enrich"] });
  assert.match(lastRun().notes.join(" "), /contact data needs enabling/);
});

test("--dry-run counts for free and writes nothing; a run above the credit limit stops before paying", async () => {
  assert.equal(await run([...ARGS, "--dry-run"]), 0);
  const jobCalls = calls.filter(c => c.path === "/job/search");
  assert.equal(jobCalls.length, 1);
  assert.equal(jobCalls[0].body.limit, 0);
  assert.equal(runs().length, 0);
  process.env.MAX_CREDITS_PER_RUN = "1";
  assert.equal(await run(ARGS), 1);
  assert.equal(paid("/job/search"), 0);
  assert.equal(await run([...ARGS, "--yes"]), 0);
});

test("a rejected key and running out of credits stop with a plain next step", async () => {
  await assert.rejects(run(ARGS, { ...HUNT, faults: [{ path: "/job/search", call: 1, status: 401 }] }), /rejected the API key/);
  await assert.rejects(run(ARGS, { ...HUNT, faults: [{ path: "/person/search", call: 2, status: 402, message: "Insufficient credits" }] }), /out of credits/);
  // What was paid for before it stopped is cached: the next run does not ask for it again.
  await run(ARGS);
  const rerun = paid("/person/search");
  await run([...ARGS, "--refresh"]);
  assert.equal(rerun, paid("/person/search") - 1, "the one search paid before the 402 is not paid again");
});

test("one failed people search is a note, not a failed run", async () => {
  assert.equal(await run(ARGS, { ...HUNT, faults: [{ path: "/person/search", call: 1, status: 400, message: "bad filter" }] }), 0);
  assert.match(lastRun().notes.join(" "), /People search \(recruiter\) at Northwind Robotics failed/);
});

test("one job by its posting URL, with tracking parameters; a job not in the index points to --company", async () => {
  assert.equal(await run(["job", "https://boards.greenhouse.io/northwind/jobs/7000001?gh_src=abc", "--cv", CV]), 0);
  const r = lastRun();
  assert.equal(r.kind, "job");
  assert.equal(r.jobs[0].job.title, "Senior Software Engineer, Platform");
  assert.ok(r.jobs[0].people.length >= 5);
  await assert.rejects(run(["job", "https://boards.greenhouse.io/nobody/jobs/1", "--cv", CV]), /--company <company website>/);
  assert.equal(await run(["job", "--company", "https://www.fabrikam.example/careers", "--title", "Platform Engineer", "--cv", CV]), 0);
  const m = lastRun();
  assert.equal(m.jobs[0].job.company.name, "Fabrikam Payments");
  assert.match(m.notes.join(" "), /No posting text/);
  await assert.rejects(run(["job", "--company", "nobody.example", "--title", "X", "--cv", CV]), /no company with the website nobody\.example/);
});

test("profile.json is read; a broken one says how to fix it", async () => {
  writeFileSync(process.env.PROFILE_PATH!, JSON.stringify({ titles: ["software engineer"], location: "San Francisco", cv: CV, top: 2 }));
  assert.equal(await run(["hunt"]), 0);
  assert.equal(lastRun().jobs.length, 2);
  writeFileSync(process.env.PROFILE_PATH!, "{ titles: ");
  await assert.rejects(run(["hunt"]), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const H = { host: "localhost:3480" };

test("dashboard: empty state, then the run, with every API value escaped", async () => {
  const store = new Store(":memory:");
  let app = dashboardApp(store, out);
  assert.match(await (await app.request("/", { headers: H })).text(), /No runs yet/);
  const fx = structuredClone(HUNT);
  fx.jobs[0].job_details!.title = "<script>alert(1)</script> Engineer";
  fx.people["900101"][0].basic_profile!.name = "<img src=x onerror=alert(1)>";
  await run(ARGS, fx);
  app = dashboardApp(store, out);
  const html = await (await app.request("/", { headers: H })).text();
  assert.doesNotMatch(html, /<script>alert|<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Engineer/);
  assert.match(html, /Copy note/);
  const other = await app.request(`/?run=${encodeURIComponent("../../etc")}`, { headers: H });
  assert.equal(other.status, 200, "an unknown run id shows the newest run");
});

test("dashboard: refuses other host names and other sites, saves statuses and notes", async () => {
  await run(ARGS);
  const store = new Store(":memory:");
  const app = dashboardApp(store, out);
  assert.equal((await app.request("/", { headers: { host: "evil.example:3480" } })).status, 403);
  const post = (body: unknown, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) => app.request("/api/status", { method: "POST", headers: { ...H, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const jobId = lastRun().jobs[0].job.id;
  assert.equal((await post({ jobId, status: "applied" }, {})).status, 403, "no Origin and no Sec-Fetch-Site: not from this page");
  assert.equal((await post({ jobId, status: "applied" }, { "sec-fetch-site": "same-origin", "content-type": "text/plain; x=application/json" })).status, 415);
  const page = await app.request("/", { headers: H });
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal((await post({ jobId, status: "applied" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ jobId, status: "hired!" })).status, 400);
  assert.equal((await post({ jobId: "../x", status: "applied" })).status, 400);
  assert.equal((await post({ jobId, status: "applied", note: "Sent to Avery" }, { origin: "http://localhost:3480" })).status, 200);
  assert.equal(store.statuses().get(jobId)?.status, "applied");
  const html = await (await app.request(`/?job=${jobId}`, { headers: H })).text();
  assert.match(html, /Sent to Avery/);
  assert.match(html, /<option value="applied" selected>/);
});

test("dashboard: shows the Claude Code evaluation for a job, escaped, with only http(s) links", async () => {
  await run(ARGS);
  const r = lastRun();
  const dir = join(out, runs()[0], "ai");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${r.jobs[0].job.id}.md`), "## Verdict\n**Apply** <b>now</b>\n- [site](https://ok.example)\n- [bad](javascript:alert(1))");
  const html = await (await dashboardApp(new Store(":memory:"), out).request(`/?job=${r.jobs[0].job.id}`, { headers: H })).text();
  assert.match(html, /Claude's evaluation/);
  assert.match(html, /<strong>Apply<\/strong> &lt;b&gt;now&lt;\/b&gt;/);
  assert.match(html, /href="https:\/\/ok\.example"/);
  assert.doesNotMatch(html, /href="javascript/);
});

test("a malformed people answer (nulls, strings, a single object) is skipped, not cached into a crash", async () => {
  const bad = { ...HUNT, rawProfiles: [null, "x", 7, { basic_profile: null, experience: { employment_details: { current: { title: "Recruiter", crustdata_company_id: 900101 } } } }] };
  assert.equal(await run(ARGS, bad as Fixture), 0);
  assert.equal(await run(ARGS), 0, "the next run against a healthy API works");
});

test("a 429 is waited out and retried", async () => {
  assert.equal(await run(ARGS, { ...HUNT, faults: [{ path: "/person/search", call: 1, status: 429 }] }), 0);
  assert.ok(lastRun().jobs[0].people.length > 0);
});

test("charges higher than the account's price list stop the run before it drains the account", async () => {
  const free = [{ path: "/job/search", base_credits: 0.03 }, { path: "/company/search", base_credits: 0.03 }, { path: "/person/search", base_credits: 0.03 }];
  const pricey = [{ path: "/job/search", base_credits: 0.03 }, { path: "/company/search", base_credits: 5 }, { path: "/person/search", base_credits: 5 }];
  await assert.rejects(run(ARGS, { ...HUNT, endpoints: free, billAs: pricey }), /more than its estimate allows/);
});

test("the spend ceiling fails closed when the account's prices are odd, and resets after a stopped run", async () => {
  const strings = [{ path: "/company/search", base_credits: "5" }, { path: "/person/search", base_credits: "5" }];
  const pricey = [{ path: "/job/search", base_credits: 0.03 }, { path: "/company/search", base_credits: 5 }, { path: "/person/search", base_credits: 5 }];
  // Odd prices fall back to the price list, so the estimate stays a number and the ceiling still holds.
  await assert.rejects(run(ARGS, { ...HUNT, endpoints: strings, billAs: pricey }), /more than its estimate allows/);
  assert.equal(await run(ARGS), 0, "the next run is not blocked by the last run's ceiling");
});
