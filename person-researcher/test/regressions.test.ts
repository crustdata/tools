// Regressions found in review round 1 (one test per bug). Each failed before its fix.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeFetch, type Fixture } from "../src/fake-api.js";
import { pacing, spend, type PersonData } from "../src/crustdata.js";
import { DEFAULTS, estimate, research, slug, writeFiles, type Options } from "../src/research.js";
import { main } from "../src/cli.js";
import { buildBrief, changes } from "../src/brief.js";
import { classify, findEmails, parseList, type Input } from "../src/input.js";
import { envText } from "../src/setup.js";

pacing.on = false;
process.env.CRUSTDATA_API_KEY = "test-key";
const base = JSON.parse(readFileSync(new URL("../fixtures/meeting.json", import.meta.url), "utf8")) as Fixture;
const NOW = new Date(base.now!);
const opts = (o: Partial<Options> = {}): Options => ({ ...DEFAULTS, now: NOW, contact: [], ...o });
const inputs = (...raw: string[]): Input[] => raw.flatMap(r => classify(r).inputs);
const quiet = () => {};
const MAYA_EMAIL = "maya@northwind-analytics.example";
const MAYA_URL = "https://www.linkedin.com/in/example-maya-okafor";
const DIEGO_URL = "https://www.linkedin.com/in/example-diego-alvarez";

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "pr-review-"));
  process.env.OUT_DIR = out;
  process.env.CACHE_HOURS = "24";
  spend.credits = 0;
});
const use = (fx: Partial<Fixture> = {}) => { const f = fakeFetch({ ...base, ...fx }); globalThis.fetch = f.fetch; return f.calls; };
const credits = () => Math.round(spend.credits * 100) / 100;

async function cli(argv: string[]): Promise<{ code: number | string; stdout: string; stderr: string }> {
  const o: string[] = [], e: string[] = [];
  const log = console.log, write = process.stderr.write.bind(process.stderr);
  console.log = (...a: unknown[]) => { o.push(a.join(" ")); };
  (process.stderr as any).write = (s: string) => { e.push(String(s)); return true; };
  try { return { code: await main(argv), stdout: o.join("\n"), stderr: e.join("") }; }
  catch (err) { return { code: `threw: ${(err as Error).message}`, stdout: o.join("\n"), stderr: e.join("") }; }
  finally { console.log = log; (process.stderr as any).write = write; }
}

// --- failure handling ------------------------------------------------------------------------------------------

test("R1 out of credits halfway: the briefs already finished (and paid for) are written", async () => {
  use({ faults: [{ path: "/web/search/live", call: 3, status: 402 }] });
  const r = await cli([MAYA_EMAIL, DIEGO_URL]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /out of credits/);
  assert.match(r.stderr, /1 brief finished before it is saved/);
  assert.ok(readdirSync(out).includes("maya-okafor.md"), `nothing written; files: ${readdirSync(out)} (message promised "briefs finished before it are saved")`);
});

test("R2 a 500 on the name search for one person does not lose the other people", async () => {
  use({ faults: [{ path: "/person/search", call: 1, status: 500 }] });
  const res = await research(inputs("Priya Raman, Hooli", MAYA_EMAIL), opts({ noPosts: true, web: false }), quiet).catch(e => e as Error);
  assert.ok(Array.isArray(res), `whole run threw: ${(res as Error).message}`);
});

test("R3 a key without name search (403) still researches the emails and URLs in the same list", async () => {
  use({ forbidden: ["/person/search"] });
  const res = await research(inputs("Priya Raman, Hooli", MAYA_EMAIL), opts({ noPosts: true, web: false }), quiet).catch(e => e as Error);
  assert.ok(Array.isArray(res), `whole run threw: ${(res as Error).message}`);
});

test("R4 one malformed profile field fails that brief only, not the run", async () => {
  const bad = structuredClone(base.people[1]);
  (bad.basic_profile as any).languages = "English"; // string instead of array
  use({ people: [base.people[0], bad, ...base.people.slice(2)] });
  const res = await research(inputs(MAYA_EMAIL, DIEGO_URL), opts({ noPosts: true, web: false }), quiet).catch(e => e as Error);
  assert.ok(Array.isArray(res), `whole run threw: ${(res as Error).message}`);
});

// --- billing ---------------------------------------------------------------------------------------------------

test("R5 a personal email researched again within CACHE_HOURS costs nothing", async () => {
  use();
  await research(inputs("wei.chen.home@mail.example"), opts({ noPosts: true, web: false }), quiet);
  const calls = use();
  spend.credits = 0;
  await research(inputs("wei.chen.home@mail.example"), opts({ noPosts: true, web: false }), quiet);
  assert.deepEqual(calls.map(c => c.path), [], `paid again: ${calls.map(c => c.path)} for ${credits()} credits`);
});

test("R6 the same person by work email and by profile URL is enriched once, also with --refresh", async () => {
  const calls = use();
  await research(inputs(MAYA_EMAIL, MAYA_URL), opts({ noPosts: true, web: false, refresh: true }), quiet);
  assert.equal(calls.filter(c => c.path === "/person/enrich").length, 1, `enrich bodies: ${JSON.stringify(calls.map(c => c.body))}; credits ${credits()}`);
});

test("R7 a name and a profile URL that resolve to the same person are sent once", async () => {
  const calls = use();
  await research(inputs("Priya Raman, Hooli", "https://www.linkedin.com/in/example-priya-raman"), opts({ noPosts: true, web: false }), quiet);
  const urls = calls.find(c => c.path === "/person/enrich")!.body.professional_network_profile_urls;
  assert.deepEqual(urls, [...new Set(urls)], `duplicate identifiers in one billed call: ${JSON.stringify(urls)}; credits ${credits()}`);
});

test("R8 contacts for the same person reached twice are bought once", async () => {
  const calls = use();
  await research(inputs(MAYA_EMAIL, MAYA_URL), opts({ noPosts: true, web: false, contact: ["business"] }), quiet);
  const urls = calls.find(c => c.path === "/person/contact/enrich")!.body.professional_network_profile_urls;
  assert.deepEqual(urls, [...new Set(urls)], `bought twice: ${JSON.stringify(urls)}`);
});

test("R9 contacts are cached when the profile URL Crustdata returns is not in normalised form (capitals)", async () => {
  const maya = structuredClone(base.people[0]);
  maya.social_handles!.professional_network_identifier!.profile_url = "https://www.linkedin.com/in/Example-Maya-Okafor";
  use({ people: [maya, ...base.people.slice(1)] });
  const first = await research(inputs(MAYA_EMAIL), opts({ noPosts: true, web: false, contact: ["business"] }), quiet);
  assert.deepEqual(first[0].brief?.contact?.business, [MAYA_EMAIL]);
  const calls = use({ people: [maya, ...base.people.slice(1)] });
  const again = await research(inputs(MAYA_EMAIL), opts({ noPosts: true, web: false, contact: ["business"] }), quiet);
  assert.deepEqual(calls.map(c => c.path), [], "contact lookup paid again inside CACHE_HOURS");
  assert.deepEqual(again[0].brief?.contact?.business, [MAYA_EMAIL]);
});

test("R10 the estimate is really the most a personal email can cost (identify + enrich)", async () => {
  use();
  const x = inputs("wei.chen.home@mail.example");
  const o = opts({ noPosts: true, web: false });
  await research(x, o, quiet);
  assert.ok(credits() <= estimate(x, o), `"at most ${estimate(x, o)}" but spent ${credits()}`);
});

test("R11 credits in index.md are this run's, not the process total (research() called from a long-lived worker)", async () => {
  use();
  const o = opts({ noPosts: true, web: false, refresh: true });
  await research(inputs(MAYA_EMAIL, DIEGO_URL), o, quiet);
  const res = await research(inputs(MAYA_EMAIL, DIEGO_URL), o, quiet);
  writeFiles(res, out, NOW);
  assert.match(readFileSync(join(out, "index.md"), "utf8"), /Credits used: 2\./);
});

// --- matching rows back to inputs ------------------------------------------------------------------------------

test("R12 rows in another order with one echo in another form never give one person another's profile", async () => {
  const inner = fakeFetch(base).fetch;
  globalThis.fetch = (async (u: any, init?: any) => {
    const r = await inner(u, init);
    if (!String(u).endsWith("/person/enrich")) return r;
    const rows = (await r.json()) as any[];
    rows.reverse();
    const d = rows.find(x => x.matched_on.includes("diego"));
    d.matched_on = "https://www.linkedin.com/in/example-diego-alvarez-canonical"; // e.g. a vanity slug that redirected
    return new Response(JSON.stringify(rows), { headers: { "x-credits-used": "2" } });
  }) as typeof fetch;
  const res = await research(inputs(DIEGO_URL, MAYA_URL), opts({ noPosts: true, web: false }), quiet);
  const maya = res.find(r => r.input.raw === MAYA_URL);
  assert.equal(maya?.brief?.person.name ?? "(none)", "Maya Okafor", `Maya's input got: ${maya?.brief?.person.name}`);
});

// --- input -----------------------------------------------------------------------------------------------------

test("R13 an apostrophe in an email does not research a different address", () => {
  assert.deepEqual(findEmails("o'neil@acme.com"), ["o'neil@acme.com"]);
});

test("R14 a quoted CSV field with a line break does not become an extra person", () => {
  const csv = 'Name,Email,Notes\nJane Doe,jane@acme.com,"met at the expo\nAna Silva, Initech, wants a demo"\nSam Lee,sam@globex.example,\n';
  const { inputs } = parseList(csv);
  assert.deepEqual(inputs.map(i => i.raw), ["jane@acme.com", "sam@globex.example"]);
});

// --- brief rules -----------------------------------------------------------------------------------------------

const role = (r: Record<string, unknown>) => r;
test("R15 a boomerang hire (left, worked elsewhere, came back) is not a 'new title'", () => {
  const p: PersonData = { experience: { employment_details: {
    current: [role({ name: "Acme", crustdata_company_id: 1, title: "VP Sales", start_date: "2026-08-01T00:00:00+00:00" })],
    past: [
      role({ name: "Globex", crustdata_company_id: 2, title: "Head of Sales", start_date: "2021-01-01T00:00:00+00:00", end_date: "2026-07-01T00:00:00+00:00" }),
      role({ name: "Acme", crustdata_company_id: 1, title: "Account Executive", start_date: "2017-01-01T00:00:00+00:00", end_date: "2020-12-01T00:00:00+00:00" }),
    ],
  } } } as PersonData;
  const c = changes(p, NOW, 180);
  assert.notEqual(c[0]?.kind, "new_title", c.map(x => x.text).join(" | "));
});

test("R16 a promotion where only one role carries the company id is still a promotion", () => {
  const p: PersonData = { experience: { employment_details: {
    current: [role({ name: "Acme", crustdata_company_id: 1, title: "VP Sales", start_date: "2026-08-01T00:00:00+00:00" })],
    past: [role({ name: "Acme", title: "Director of Sales", start_date: "2023-01-01T00:00:00+00:00", end_date: "2026-08-01T00:00:00+00:00" })],
  } } } as PersonData;
  const c = changes(p, NOW, 180);
  assert.equal(c[0]?.kind, "new_title", c.map(x => x.text).join(" | "));
});

test("R17 a role that starts in the future is not 'what changed lately'", () => {
  const p: PersonData = { experience: { employment_details: {
    current: [
      role({ name: "Acme", crustdata_company_id: 1, title: "CEO", start_date: "2027-01-01T00:00:00+00:00" }),
    ],
    past: [role({ name: "Globex", crustdata_company_id: 2, title: "VP", start_date: "2020-01-01T00:00:00+00:00", end_date: "2026-09-01T00:00:00+00:00" })],
  } } } as PersonData;
  const c = changes(p, NOW, 180);
  assert.ok(!c.some(x => /Jan 2027/.test(x.text)), c.map(x => x.text).join(" | "));
});

test("R18 --days 30 on the 1st of the month still sees a change from last month", () => {
  const p: PersonData = { experience: { employment_details: {
    current: [role({ name: "Acme", crustdata_company_id: 1, title: "CEO", start_date: "2026-09-01T00:00:00+00:00" })],
    past: [],
  } } } as PersonData;
  assert.equal(changes(p, new Date("2026-10-01T09:00:00Z"), 30).length, 1);
});

// --- output ----------------------------------------------------------------------------------------------------

test("R19 a person whose name slugs to 'index' does not get overwritten by index.md", () => {
  const mk = (name: string) => buildBrief({ input: name, matchedBy: "profile URL", person: { basic_profile: { name } }, now: NOW, days: 180 });
  writeFiles([
    { input: { kind: "url", raw: "a", url: "a" }, status: "done", brief: mk("Index") },
    { input: { kind: "url", raw: "b", url: "b" }, status: "done", brief: mk("Jane Doe") },
  ], out, NOW);
  const files = readdirSync(out).filter(f => f.endsWith(".md"));
  assert.equal(files.length, 3, `files: ${files}`);
});

test("R20 file names keep Indic and Japanese names readable", () => {
  assert.equal(slug("प्रिया शर्मा"), "प्रिया-शर्मा");
  assert.equal(slug("山田 ガク"), "山田-ガク".normalize("NFC"));
  assert.equal(slug("con"), "con-person");
  assert.equal(slug("José Núñez"), "jose-nunez");
});

test("R21 --json has one shape whatever the count, and keeps the reason for a miss or a pick", async () => {
  use();
  const one = await cli(["Sam Lee", "--json"]);
  assert.notEqual(one.stdout.trim(), "null", "a pick with --json prints null: the candidates and the note are lost");
});

// --- setup -----------------------------------------------------------------------------------------------------

test("R22 .env written by setup reads back the same value in Node; a value Node cannot read back is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-env-"));
  for (const value of ["ab'c", 'a"b', "x y#z", "plain-key_123", "$dollar", `ab'c"d`]) {
    writeFileSync(join(dir, ".env"), envText("CRUSTDATA_API_KEY=\n", { CRUSTDATA_API_KEY: value }));
    delete process.env.ROUNDTRIP;
    writeFileSync(join(dir, ".env2"), readFileSync(join(dir, ".env"), "utf8").replace("CRUSTDATA_API_KEY", "ROUNDTRIP"));
    process.loadEnvFile(join(dir, ".env2"));
    assert.equal(process.env.ROUNDTRIP, value);
  }
  assert.throws(() => envText("CRUSTDATA_API_KEY=\n", { CRUSTDATA_API_KEY: "a'b`c\"d" }), /quote marks/);
});
