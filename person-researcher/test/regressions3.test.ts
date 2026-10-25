// Regressions found in review round 3 (one test per bug). Each failed before its fix.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeFetch, type Fixture } from "../src/fake-api.js";
import { deniedFieldsNow, pacing, spend, type PersonData } from "../src/crustdata.js";
import { DEFAULTS, research, writeFiles, type Options } from "../src/research.js";
import { main } from "../src/cli.js";
import { changes, lastNameOf, pickLinks, searchPhrase } from "../src/brief.js";
import { classify, parseList, type Input } from "../src/input.js";
import { renderBrief } from "../src/render.js";
import { readEnv } from "../src/setup.js";

pacing.on = false;
process.env.CRUSTDATA_API_KEY = "test-key";
const base = JSON.parse(readFileSync(new URL("../fixtures/meeting.json", import.meta.url), "utf8")) as Fixture;
const NOW = new Date(base.now!);
const opts = (o: Partial<Options> = {}): Options => ({ ...DEFAULTS, now: NOW, contact: [], ...o });
const inputs = (...raw: string[]): Input[] => raw.flatMap(r => classify(r).inputs);
const quiet = () => {};
const DIEGO_URL = "https://www.linkedin.com/in/example-diego-alvarez";

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "pr-review3-"));
  process.env.OUT_DIR = out;
  process.env.CACHE_HOURS = "24";
  process.env.SKIP_DOMAINS = "";
  process.env.MAX_CREDITS_PER_RUN = "0";
  spend.credits = 0;
  deniedFieldsNow().clear();
  pacing.on = false;
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
const crowd = (n: number): PersonData[] => Array.from({ length: n }, (_, k) => ({
  crustdata_person_id: 9400000 + k,
  basic_profile: { name: `Person${k} Example` },
  social_handles: { professional_network_identifier: { profile_url: `https://www.linkedin.com/in/example-r3-${k}` } },
  experience: { employment_details: { current: [], past: [] } },
}));

// --- T1 (major) a plain list where a company looks like a column name loses every other person, and exits 0 -----------------------

test("T1a a name with a column-like company in a plain list is a person, not a CSV header that swallows the list", () => {
  const r = parseList("jane@acme.com\nAlex Kim, LinkedIn\nbob@globex.com\n");
  assert.deepEqual(r.inputs.map(x => x.raw), ["jane@acme.com", "Alex Kim, LinkedIn", "bob@globex.com"],
    `read as: ${JSON.stringify(r.skipped.map(s => `${s.raw}: ${s.reason}`))}`);
});

test("T1b a daily attendee file ending with such a line does not research nobody and exit 0", async () => {
  use();
  const f = join(out, "attendees.txt");
  writeFileSync(f, "maya@northwind-analytics.example\nwei.chen.home@mail.example\nAlex Kim, LinkedIn\n");
  const r = await cli(["--file", f, "--no-posts", "--no-web"]);
  assert.ok(!/Nobody to research/.test(r.stderr), r.stderr);
});

// --- T2 (major) research() from code with a mixed-case email: identify match paid for, reported "not charged" ------

test("T2 a calendar email with capitals passed to research() is found by identify, not cached as a miss", async () => {
  // The fake API matches the address as sent; the real API matches case-insensitively and echoes it lowercased.
  use({ emails: { "wei.chen.home@mail.example": "https://www.linkedin.com/in/example-wei-chen", "Wei.Chen.Home@Mail.example": "https://www.linkedin.com/in/example-wei-chen" } });
  const email = "Wei.Chen.Home@Mail.example";
  const res = await research([{ kind: "email", raw: email, email }], opts({ noPosts: true, web: false }), quiet);
  assert.equal(res[0].status, "done", `${res[0].status}: ${res[0].note} (credits spent: ${spend.credits})`);
});

// --- T3 (major) a contact lookup that failed or is not enabled renders as "No contact details found" ----------------

test("T3a a key without contact access does not get briefs that say 'No contact details found'", async () => {
  use({ forbidden: ["/person/contact/enrich"] });
  const res = await research(inputs(DIEGO_URL), opts({ noPosts: true, web: false, contact: ["business"] }), quiet);
  assert.doesNotMatch(renderBrief(res[0].brief!), /No contact details found/);
});

test("T3b a 500 on contact batch 2 is not shown as 'No contact details found (not charged)' for those people", async () => {
  const people = crowd(30);
  const contacts = Object.fromEntries(people.map(p => [p.social_handles!.professional_network_identifier!.profile_url!, { business_emails: [{ email: "x@y.example", status: "deliverable" }] }]));
  use({ people, contacts, faults: [{ path: "/person/contact/enrich", call: 2, status: 500 }] });
  const x = people.map(p => p.social_handles!.professional_network_identifier!.profile_url!).flatMap(u => inputs(u));
  const res = await research(x, opts({ noPosts: true, web: false, contact: ["business"] }), quiet);
  assert.deepEqual(res[0].brief?.contact?.business, ["x@y.example"]);
  assert.doesNotMatch(renderBrief(res[29].brief!), /No contact details found/);
});

// --- T4 (minor) identify batch 2 fails: the 25 people identify already matched (and billed) are failed too -------

test("T4 a 500 on identify batch 2 does not fail the 25 people batch 1 matched and paid for", async () => {
  const people = crowd(30);
  const emails = Object.fromEntries(people.map((p, k) => [`r3-${k}@mail.example`, p.social_handles!.professional_network_identifier!.profile_url!]));
  use({ people, emails, faults: [{ path: "/person/identify", call: 2, status: 500 }] });
  const res = await research(Object.keys(emails).flatMap(e => inputs(e)), opts({ noPosts: true, web: false }), quiet);
  const failedButPaid = res.slice(0, 25).filter(o => o.status !== "done").length;
  assert.equal(failedButPaid, 0, `${failedButPaid} people matched by identify (${spend.credits} credits) reported as "${res[0].note}"`);
});

// --- T5 (minor) names with a typographic apostrophe or a credential without a comma ------------------------------

test("T5a a curly apostrophe in the profile name is kept in the web query and the last-name filter", () => {
  const p: PersonData = { basic_profile: { name: "Conan O’Brien" }, experience: { employment_details: { current: [{ name: "Team Coco", title: "Host" }] } } };
  assert.match(searchPhrase(p), /O['’]Brien/);
  const kept = pickLinks([{ url: "https://news.example/a", title: "Conan O'Brien joins Team Coco" }], [], undefined, 5, lastNameOf("Conan O’Brien"));
  assert.equal(kept.length, 1);
});

test("T5b a straight apostrophe on the profile still matches news that prints a curly one", () => {
  const kept = pickLinks([{ url: "https://news.example/a", title: "Conan O’Brien joins Team Coco" }], [], undefined, 5, lastNameOf("Conan O'Brien"));
  assert.equal(kept.length, 1);
});

test("T5c 'Jane Doe MBA' (no comma) is searched and filtered as Doe, not MBA", () => {
  assert.equal(lastNameOf("Jane Doe MBA"), "Doe");
  assert.equal(lastNameOf("John Smith PhD"), "Smith");
});

// --- T6 (minor) a move to a new main job, keeping an advisor role, reads as "Added a role" ------------------------

test("T6 a new main job (is_default) after leaving the last one is 'Joined', even with an older advisor role", () => {
  const p: PersonData = { experience: { employment_details: {
    current: [
      { name: "Board Co", title: "Advisor", start_date: "2022-01-01T00:00:00+00:00", crustdata_company_id: 1 },
      { name: "Beta", title: "CEO", start_date: "2026-08-01T00:00:00+00:00", is_default: true, crustdata_company_id: 2 },
    ],
    past: [{ name: "Gamma", title: "VP Sales", start_date: "2019-01-01T00:00:00+00:00", end_date: "2026-07-01T00:00:00+00:00", crustdata_company_id: 3 }],
  } } };
  const c = changes(p, NOW, 180);
  assert.equal(c[0].kind, "new_company", JSON.stringify(c.map(x => x.text)));
});

// --- T7 (minor) a CSV saved with old Mac line endings (CR only) researches nobody and exits 0 ---------------------

test("T7 a CR-only CSV (Excel 'CSV (Macintosh)') is read row by row", () => {
  const r = parseList("Email,Name\rjane@acme.com,Jane Doe\rbob@globex.com,Bob Ray\r");
  assert.equal(r.inputs.length, 2, JSON.stringify(r));
});

// --- T8 (minor) lastRun is process-wide: writeFiles() after concurrent runs puts another run's credits in index.md --

test("T8 writeFiles() for a run uses that run's credits even when another research() finished later", async () => {
  use();
  const a = research(inputs("maya@northwind-analytics.example", DIEGO_URL), opts({ noPosts: true, web: false }), quiet);
  const b = research(inputs("Priya Raman, Hooli"), opts({ refresh: true }), quiet); // more calls, finishes last
  const [ra] = await Promise.all([a, b]);
  const { files } = writeFiles(ra, out, NOW);
  assert.match(readFileSync(files.find(f => f.endsWith("index.md"))!, "utf8"), /Credits used: 2\.$/m);
});

// --- T9 (minor) a CSV row with only a person's name is called a "report title" and the cron exits 0 -------------

test("T9 a row with a first and last name but no company or email is not skipped as a benign report title", () => {
  const r = parseList("Name,Company,Email\nJane Nocompany,,\n");
  assert.notEqual(r.skipped[0]?.benign, true, JSON.stringify(r.skipped));
});

// --- T10 (polish) setup reads a hand-written quoted value with a comment as the quotes plus the value -------------

test("T10 readEnv reads KEY=\"abc\" # comment as abc, like Node does", () => {
  const f = join(out, ".env");
  writeFileSync(f, 'CRUSTDATA_API_KEY="abc123" # from the dashboard\n');
  assert.equal(readEnv(f).CRUSTDATA_API_KEY, "abc123");
});

// --- T11 (minor) pacing is not reserved: concurrent runs in one worker fire two calls at the same instant --------

test("T11 three research() calls at once keep /person/enrich calls at least 4 s apart", { timeout: 30_000 }, async () => {
  const f = fakeFetch(base);
  const at: number[] = [];
  globalThis.fetch = (async (u: any, init: any) => { if (String(u).endsWith("/person/enrich")) at.push(Date.now()); return f.fetch(u, init); }) as typeof fetch;
  pacing.on = true;
  try {
    await Promise.all(["https://www.linkedin.com/in/example-diego-alvarez", "https://www.linkedin.com/in/example-priya-raman", "https://www.linkedin.com/in/example-wei-chen"]
      .map(u => research(inputs(u), opts({ noPosts: true, web: false, refresh: true }), quiet)));
  } finally { pacing.on = false; }
  const gaps = at.slice(1).map((t, k) => t - at[k]);
  assert.ok(gaps.every(g => g >= 4000), `gaps between enrich calls: ${gaps.join(", ")} ms (limit is 15 a minute)`);
});
