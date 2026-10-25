// Regressions found in review round 2 (one test per bug). Each failed before its fix.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeFetch, type Fixture } from "../src/fake-api.js";
import { deniedFieldsNow, pacing, spend, type PersonData } from "../src/crustdata.js";
import { DEFAULTS, RunStopped, lastRun, research, type Options, type Outcome } from "../src/research.js";
import { main } from "../src/cli.js";
import { buildBrief, changes, searchPhrase } from "../src/brief.js";
import { classify, parseList, type Input } from "../src/input.js";
import { envText, readEnv } from "../src/setup.js";

pacing.on = false;
process.env.CRUSTDATA_API_KEY = "test-key";
const base = JSON.parse(readFileSync(new URL("../fixtures/meeting.json", import.meta.url), "utf8")) as Fixture;
const NOW = new Date(base.now!);
const opts = (o: Partial<Options> = {}): Options => ({ ...DEFAULTS, now: NOW, contact: [], ...o });
const inputs = (...raw: string[]): Input[] => raw.flatMap(r => classify(r).inputs);
const quiet = () => {};
const MAYA_URL = "https://www.linkedin.com/in/example-maya-okafor";
const DIEGO_URL = "https://www.linkedin.com/in/example-diego-alvarez";
const WEI_URL = "https://www.linkedin.com/in/example-wei-chen";

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "pr-review2-"));
  process.env.OUT_DIR = out;
  process.env.CACHE_HOURS = "24";
  process.env.SKIP_DOMAINS = "";
  process.env.MAX_CREDITS_PER_RUN = "0";
  spend.credits = 0;
  deniedFieldsNow().clear();
});
const use = (fx: Partial<Fixture> = {}) => { const f = fakeFetch({ ...base, ...fx }); globalThis.fetch = f.fetch; return f.calls; };
async function cli(argv: string[]) {
  const o: string[] = [], e: string[] = [];
  const log = console.log, write = process.stderr.write.bind(process.stderr);
  console.log = (...a: unknown[]) => { o.push(a.join(" ")); };
  (process.stderr as any).write = (s: string) => { e.push(String(s)); return true; };
  try { return { code: await main(argv), stdout: o.join("\n"), stderr: e.join("") }; }
  finally { console.log = log; (process.stderr as any).write = write; }
}

/** n made-up people, example-p-0 .. example-p-(n-1). */
const crowd = (n: number): PersonData[] => Array.from({ length: n }, (_, k) => ({
  crustdata_person_id: 9300000 + k,
  basic_profile: { name: `Person${k} Example` },
  social_handles: { professional_network_identifier: { profile_url: `https://www.linkedin.com/in/example-p-${k}` } },
  experience: { employment_details: { current: [], past: [] } },
}));
const crowdUrls = (n: number) => Array.from({ length: n }, (_, k) => `https://www.linkedin.com/in/example-p-${k}`);
const enrichedUrls = (calls: Array<{ path: string; body: any }>) =>
  calls.filter(c => c.path === "/person/enrich").flatMap(c => c.body.professional_network_profile_urls ?? []);

// --- N1: a failure in a later batch throws away the earlier, already billed batch -------------------------------

test("N1a out of credits on enrich batch 2: the 25 profiles paid for in batch 1 are not paid for again", async () => {
  const people = crowd(30);
  use({ people, faults: [{ path: "/person/enrich", call: 2, status: 402, message: "Insufficient credits" }] });
  const x = inputs(...crowdUrls(30));
  const stopped = await research(x, opts({ noPosts: true, web: false }), quiet).catch(e => e);
  assert.ok(stopped instanceof RunStopped);
  const paidFirst = spend.credits;
  // Topped up; "run the same command again to do the rest (finished people cost nothing again)".
  const calls = use({ people });
  spend.credits = 0;
  await research(x, opts({ noPosts: true, web: false }), quiet);
  assert.equal(enrichedUrls(calls).length, 5,
    `paid ${paidFirst} credits for batch 1, then re-sent ${enrichedUrls(calls).length} profiles (${spend.credits} credits) on the re-run`);
});

test("N1b a 500 on enrich batch 2 does not mark the 25 people already paid for in batch 1 as failed", async () => {
  use({ people: crowd(30), faults: [{ path: "/person/enrich", call: 2, status: 500 }] });
  const res = await research(inputs(...crowdUrls(30)), opts({ noPosts: true, web: false }), quiet);
  const failedButPaid = res.slice(0, 25).filter(o => o.status === "failed").length;
  assert.equal(failedButPaid, 0, `${failedButPaid} people paid for (${spend.credits} credits) reported as "Profile lookup failed"`);
});

test("N1c out of credits on contact batch 2: contacts bought in batch 1 are not bought again", async () => {
  const people = crowd(30);
  const contacts = Object.fromEntries(crowdUrls(30).map((u, k) => [u, { business_emails: [{ email: `p${k}@acme.example` }] }]));
  use({ people, contacts, faults: [{ path: "/person/contact/enrich", call: 2, status: 402 }] });
  const x = inputs(...crowdUrls(30));
  await research(x, opts({ noPosts: true, web: false, contact: ["business"] }), quiet).catch(e => e);
  const calls = use({ people, contacts });
  await research(x, opts({ noPosts: true, web: false, contact: ["business"] }), quiet);
  const rebought = calls.filter(c => c.path === "/person/contact/enrich").flatMap(c => c.body.professional_network_profile_urls).length;
  assert.equal(rebought, 5, `${rebought} contact lookups sent again (25 were paid for before the stop)`);
});

test("N12 a key that cannot read experience does not get a brief that asserts 'No role change'", async () => {
  use({ faults: [{ path: "/person/enrich", call: 1, status: 403, message: "Access denied to fields: experience" }] });
  const res = await research(inputs(MAYA_URL), opts({ noPosts: true, web: false }), quiet);
  assert.ok(!/No role change/.test(res[0].brief?.quiet ?? ""), `brief says: ${res[0].brief?.quiet}`);
});

// --- N2: a denied field is remembered forever ----------------------------------------------------------------

const deniedFile = () => join(out, ".cache", `${createHash("sha1").update("denied-fields").digest("hex").slice(0, 20)}.json`);

test("N2a the denied-fields entry is re-saved by every run, so it never reaches CACHE_HOURS and never expires", async () => {
  use({ faults: [{ path: "/person/enrich", call: 1, status: 403, message: "Access denied to fields: certifications, honors" }] });
  await research(inputs(MAYA_URL), opts({ noPosts: true, web: false }), quiet);
  // 23 hours later (inside CACHE_HOURS=24) the next daily run happens in a new process.
  const f = deniedFile();
  const saved = JSON.parse(readFileSync(f, "utf8"));
  saved.at -= 23 * 3_600_000;
  writeFileSync(f, JSON.stringify(saved));
  const then = new Date(saved.at);
  utimesSync(f, then, then);
  deniedFieldsNow().clear();
  use();
  await research(inputs(DIEGO_URL), opts({ noPosts: true, web: false }), quiet);
  const after = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(after.at, saved.at, "the 23-hour-old denial was re-stamped as new: a daily run keeps it alive forever, even after Crustdata enables the fields");
});

test("N2b after Crustdata enables a field, a --refresh run that reads it fine does not clear the old denial", async () => {
  use({ faults: [{ path: "/person/enrich", call: 1, status: 403, message: "Access denied to fields: certifications, honors" }] });
  await research(inputs(MAYA_URL), opts({ noPosts: true, web: false }), quiet);
  deniedFieldsNow().clear(); // a new process
  let calls = use();     // the key can read every field now
  await research(inputs(DIEGO_URL), opts({ noPosts: true, web: false, refresh: true }), quiet);
  assert.ok(calls[0].body.fields.includes("certifications"));
  deniedFieldsNow().clear(); // the next normal run, in a new process
  calls = use();
  await research(inputs(WEI_URL), opts({ noPosts: true, web: false }), quiet);
  assert.ok(calls[0].body.fields.includes("certifications"), `still not asked for: ${calls[0].body.fields}`);
});

// --- N3: credentials, pronouns and emoji in the profile name drop every (paid) web and news result -------------

test("N3 a profile name with a credential, pronouns or an emoji keeps web results that name the person", () => {
  for (const name of ["Jane Doe, PhD", "Jane Doe (She/Her)", "Jane Doe 🚀", "Jane Doe, MBA, CPA"]) {
    const b = buildBrief({
      input: "x", matchedBy: "profile URL", now: NOW, days: 180, person: { basic_profile: { name } },
      web: [{ url: "https://news.example/jane-doe-acme", title: "Jane Doe joins Acme as CTO", snippet: "Acme named Jane Doe its new CTO." }],
    });
    assert.equal(b.web?.length, 1, `"${name}": the result naming Jane Doe was dropped (the web call was billed)`);
  }
  const p: PersonData = { basic_profile: { name: "Jane Doe, PhD" }, experience: { employment_details: { current: [{ name: "Acme", title: "CTO" }] } } };
  assert.equal(searchPhrase(p), '"Jane Doe" Acme', "the quoted phrase includes the credential, which few pages write");
});

// --- N4, N5, N6: input files that silently lose people ---------------------------------------------------------

test("N4 a stray double quote inside a CSV cell (27\" monitor) does not swallow every row after it", () => {
  const csv = 'Name,Email,Company\nJane Doe,jane@acme.example,Acme 27" Displays\nBob Lee,bob@globex.example,Globex\nAnn Wu,ann@initech.example,Initech\n';
  const r = parseList(csv);
  assert.deepEqual(r.inputs.map(i => i.raw), ["jane@acme.example", "bob@globex.example", "ann@initech.example"],
    `got ${JSON.stringify(r.inputs.map(i => i.raw))}, skipped ${JSON.stringify(r.skipped)}, warnings ${JSON.stringify(r.warnings)}`);
});

test("N5 a plain list whose first person works at Mailchimp, Personio or 'Acme Company' is not dropped as a header", () => {
  for (const first of ["Sam Lee, Mailchimp", "Jane Doe, Personio", "Ana Silva, Acme Company", "Raj Patel, Lastminute.com"]) {
    const r = parseList(`${first}\nBob Smith, Globex\n`);
    assert.equal(r.inputs.length, 2, `"${first}" was dropped: ${JSON.stringify(r.warnings)}`);
  }
});

test("N6 'Last, First' names with a credential or a two-word surname read as First Last", () => {
  const r = parseList('Name,Company\n"Doe, Jane, MBA",Acme\n"Garcia Lopez, Maria",Globex\n"van der Berg, Jan",Initech\n');
  assert.deepEqual(r.inputs.map(i => (i as { name: string }).name), ["Jane Doe", "Maria Garcia Lopez", "Jan van der Berg"]);
});

test("N6b an invite line with an email and a plain name keeps both people", () => {
  const r = classify("Bob Smith <bob@acme.example>; Alice Wong, Globex", true);
  assert.equal(r.inputs.length, 2, `Alice Wong was dropped without a reason: ${JSON.stringify(r)}`);
});

// --- N7: research() from a long-lived worker ------------------------------------------------------------------

test("N7a an async onBrief (post to Slack) that fails is awaited and reported, not an unhandled rejection", async () => {
  use();
  const floating: unknown[] = [];
  const catcher = (e: unknown) => floating.push(e);
  process.on("unhandledRejection", catcher);
  try {
    const res = await research(inputs(MAYA_URL), opts({ noPosts: true, web: false }), quiet,
      (async () => { await new Promise(r => setTimeout(r, 1)); throw new Error("Slack webhook 500"); }) as unknown as (o: Outcome) => void);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(floating.length, 0, `research() returned ${res[0].status} and the failure became an unhandled rejection (crashes a worker on Node 22)`);
  } finally { process.off("unhandledRejection", catcher); }
});

test("N7b two research() calls running at once each report their own credits", async () => {
  use();
  const one = research(inputs(MAYA_URL), opts({ noPosts: true, web: false }), quiet).then(() => lastRun.credits);
  const two = research(inputs(DIEGO_URL), opts({ noPosts: true, web: false }), quiet).then(() => lastRun.credits);
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual([a, b], [1, 1], "each run enriched one profile (1 credit) but lastRun mixes both runs");
});

// --- N8: cache semantics ----------------------------------------------------------------------------------------

test("N8a an email nobody matches is not looked up again within CACHE_HOURS", async () => {
  use();
  await research(inputs("nobody@northwind-analytics.example"), opts({ noPosts: true, web: false }), quiet);
  const calls = use();
  await research(inputs("nobody@northwind-analytics.example"), opts({ noPosts: true, web: false }), quiet);
  assert.deepEqual(calls.map(c => c.path), [], "identify is called (and paced) again for a known miss");
});

test("N8b a one-off run with CACHE_HOURS=0 does not delete the answers the daily run paid for", async () => {
  use();
  await research(inputs(MAYA_URL), opts({ noPosts: true, web: false }), quiet);
  process.env.CACHE_HOURS = "0";
  use();
  await research(inputs(DIEGO_URL), opts({ noPosts: true, web: false }), quiet);
  process.env.CACHE_HOURS = "24";
  const calls = use();
  await research(inputs(MAYA_URL), opts({ noPosts: true, web: false }), quiet);
  assert.deepEqual(calls.map(c => c.path), [], "Maya is paid for again: CACHE_HOURS=0 wiped the shared cache");
});

// --- N9: "what changed" edge cases -----------------------------------------------------------------------------

const R = (r: Record<string, unknown>) => r;
test("N9a a promotion where the older role at the same company has no start date is not 'Joined'", () => {
  const p: PersonData = { experience: { employment_details: {
    current: [
      R({ name: "Acme", crustdata_company_id: 1, title: "VP Sales", start_date: "2026-08-01T00:00:00+00:00", is_default: true }),
      R({ name: "Acme", crustdata_company_id: 1, title: "Director of Sales" }),
    ],
    past: [R({ name: "Globex", crustdata_company_id: 2, title: "AE", start_date: "2015-01-01", end_date: "2019-01-01" })],
  } } } as PersonData;
  const c = changes(p, NOW, 180);
  assert.ok(!c.some(x => /^Joined Acme/.test(x.text)), c.map(x => x.text).join(" | "));
});

test("N9b a past role there with no end date, years before a stint elsewhere, makes a return 'Rejoined', not 'New title'", () => {
  const p: PersonData = { experience: { employment_details: {
    current: [R({ name: "Acme", crustdata_company_id: 1, title: "VP Sales", start_date: "2026-08-01T00:00:00+00:00" })],
    past: [
      R({ name: "Globex", crustdata_company_id: 2, title: "Head of Sales", start_date: "2018-01-01", end_date: "2026-07-01" }),
      R({ name: "Acme", crustdata_company_id: 1, title: "Account Executive", start_date: "2015-01-01", end_date: null }),
    ],
  } } } as PersonData;
  const c = changes(p, NOW, 180);
  assert.notEqual(c[0]?.kind, "new_title", c.map(x => x.text).join(" | "));
});

test("N9c two current roles started the same month at two companies are not both 'Joined ... Before: Globex'", () => {
  const p: PersonData = { experience: { employment_details: {
    current: [
      R({ name: "Acme", crustdata_company_id: 1, title: "CEO", start_date: "2026-08-01", is_default: true }),
      R({ name: "Initech", crustdata_company_id: 3, title: "Board Member", start_date: "2026-08-01" }),
    ],
    past: [R({ name: "Globex", crustdata_company_id: 2, title: "VP", start_date: "2019-01-01", end_date: "2026-07-01" })],
  } } } as PersonData;
  const c = changes(p, NOW, 180);
  assert.equal(c.filter(x => x.kind === "new_company").length, 1, c.map(x => x.text).join(" | "));
});

// --- N10: CLI contract for scripts ----------------------------------------------------------------------------

test("N10a a cron can tell 'nobody on the list was found' from 'the run stopped' by the exit code", async () => {
  use();
  const none = await cli(["nobody@northwind-analytics.example", "--no-web", "--no-posts"]);
  use({ faults: [{ path: "/person/enrich", call: 1, status: 401 }] });
  const stopped = await cli([MAYA_URL, "--no-web", "--no-posts"]);
  assert.notEqual(none.code, stopped.code, `both exit ${none.code}`);
});

test("N10b --dry-run --json prints the documented shape, and --json alone never prints help text on stdout", async () => {
  use();
  const dry = await cli(["maya@northwind-analytics.example", "--dry-run", "--json"]);
  const parsed = JSON.parse(dry.stdout);
  assert.ok(parsed.every((x: Record<string, unknown>) => "status" in x), `dry-run JSON: ${dry.stdout}`);
  const bare = await cli(["--json"]);
  assert.doesNotThrow(() => bare.stdout.trim() && JSON.parse(bare.stdout), `stdout: ${bare.stdout.slice(0, 60)}...`);
});

// N10c (a one-person run leaves an older index.md) is kept on purpose: rewriting index.md would wipe the index
// of the meeting researched just before.

test("N10d a daily attendee file with only a meeting room and colleagues exits 0 (nobody to research), like an empty file", async () => {
  use();
  process.env.SKIP_DOMAINS = "mycompany.example";
  const f = join(out, "attendees.txt");
  writeFileSync(f, "me@mycompany.example\nboardroom-4@resource.calendar.google.com\n");
  const r = await cli(["--file", f, "--json"]);
  assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
});

// --- N11: setup .env round trip --------------------------------------------------------------------------------

test("N11 .env values round trip through Node: backslash-n with an apostrophe, a # in an unquoted value", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-env2-"));
  const value = "ab'c\\nd";
  writeFileSync(join(dir, ".env"), envText("RT2=\n", { RT2: value }));
  delete process.env.RT2;
  process.loadEnvFile(join(dir, ".env"));
  assert.equal(process.env.RT2, value, `written as ${readFileSync(join(dir, ".env"), "utf8").trim()}`);
  writeFileSync(join(dir, ".env3"), "RT3=abc#def\n");
  delete process.env.RT3;
  process.loadEnvFile(join(dir, ".env3"));
  assert.equal(readEnv(join(dir, ".env3")).RT3, process.env.RT3, "setup reads a different value than Node does, then quotes and rewrites it");
});
