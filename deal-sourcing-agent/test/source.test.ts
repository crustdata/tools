/**
 * End to end: the real `npm run source` code against a stubbed Crustdata (no network, no key), built from the
 * seed-pipeline fixture. Checks the requests it sends, the files it writes, re-runs and the free re-score.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dsa-test-"));
process.env.CRUSTDATA_API_KEY = "test-key";
process.env.OUT_DIR = dir;
process.env.CRUSTDATA_MIN_GAP_MS = "0";
process.env.DSA_NO_DOTENV = "1";
// Settings from the developer's shell must not change what the tests see.
for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_MODEL", "OPENAI_MODEL", "WATCH_HINT"]) delete process.env[k];

const fx = JSON.parse(readFileSync(new URL("../fixtures/seed-pipeline.json", import.meta.url), "utf8"));
type Call = { path: string; body: any };
let calls: Call[] = [];
let postsDisabled = false;
let failQuotesWith = 0;
let logs: string[] = [];
const realFetch = globalThis.fetch;
const realLog = console.log;

const idsIn = (f: any): number[] => {
  if (!f) return [];
  if (f.conditions) return f.conditions.flatMap(idsIn);
  return /company_id$|crustdata_entity_id$/.test(f.field) ? [].concat(f.value) : [];
};
const valueOf = (f: any, field: string): any => f?.conditions ? f.conditions.map((c: any) => valueOf(c, field)).find((v: any) => v !== undefined) : f?.field === field ? f.value : undefined;
const phrasesIn = (f: any): string[] => f?.conditions ? f.conditions.flatMap(phrasesIn) : f?.field === "text" ? [f.value] : [];
const personCompany = new Map<number, number[]>(fx.inputs.profiles.map((p: any) => [p.crustdata_person_id, p.experience.employment_details.current.map((c: any) => c.crustdata_company_id)]));

function respond(path: string, body: any): { status: number; json: unknown; credits: number } {
  if (path === "/company/search/autocomplete") return { status: 200, json: { suggestions: [{ value: body.query.replace(/ /g, "_") }] }, credits: 0 };
  if (path === "/company/search") return { status: 200, json: { companies: fx.inputs.companies.slice(0, body.limit), next_cursor: null }, credits: 0.03 * fx.inputs.companies.length };
  if (path === "/person/search") {
    const ids = new Set(idsIn(body.filters));
    const profiles = fx.inputs.profiles.filter((p: any) => p.experience.employment_details.current.some((c: any) => ids.has(c.crustdata_company_id)));
    return { status: 200, json: { profiles, next_cursor: null }, credits: 0.03 * profiles.length };
  }
  if (path === "/job/search") {
    const since = valueOf(body.filters, "metadata.date_added");
    if (body.limit === 0) {
      const days = Math.round((Date.now() - Date.parse(since)) / 86_400_000);
      if (body.aggregations[0].field === "job_details.title") {
        const n = fx.inputs.jobs[valueOf(body.filters, "company.basic_info.company_id")]?.[days > 60 ? "last90" : "last30"] ?? 0;
        return { status: 200, json: { job_listings: [], aggregations: [{ buckets: Array.from({ length: n }, (_, i) => ({ key: `Role ${i}`, count: 2 })) }] }, credits: 0 };
      }
      const buckets = idsIn(body.filters).map(id => ({ key: id, count: fx.inputs.jobs[id]?.[days > 60 ? "last90" : "last30"] ?? 0 })).filter(b => b.count);
      return { status: 200, json: { job_listings: [], aggregations: [{ buckets }] }, credits: 0 };
    }
    const id = valueOf(body.filters, "company.basic_info.company_id");
    const listings = [...(fx.inputs.jobs[id]?.newest ?? []), ...(fx.inputs.jobs[id]?.newest ?? [])].map((j: any) => ({ job_details: { title: j.title, url: j.url }, metadata: { date_added: j.date } }));
    return { status: 200, json: { job_listings: listings }, credits: 0.03 * listings.length };
  }
  if (path === "/social_post/search") {
    if (postsDisabled) return { status: 403, json: { error: { type: "permission_error", message: "Endpoint not enabled" } }, credits: 0 };
    if (failQuotesWith && body.limit > 0) return { status: failQuotesWith, json: { error: { type: "insufficient_credits", message: "Not enough credits" } }, credits: 0 };
    const company = personCompany.get(idsIn(body.filters)[0])?.find(c => fx.inputs.posts[c]);
    const p = fx.inputs.posts[company ?? -1] ?? { traction: 0, raise: 0, quotes: [] };
    const phrases = phrasesIn(body.filters);
    const isRaise = phrases.includes("closed our seed");
    const isBoth = isRaise && phrases.includes("MRR");
    if (body.limit === 0) return { status: 200, json: { posts: [], total_count: isBoth ? p.traction + p.raise : isRaise ? p.raise : p.traction }, credits: 0 };
    const posts = p.quotes.slice(0, body.limit).map((q: any) => ({ date_posted: q.date + "T10:00:00Z", text: q.text, share_url: q.url, actor: { name: q.author } }));
    return { status: 200, json: { posts }, credits: 0.5 * posts.length };
  }
  return { status: 404, json: { message: "not stubbed" }, credits: 0 };
}

before(() => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    assert.equal((init?.headers as Record<string, string>)["x-api-version"], "2025-11-01");
    calls.push({ path, body });
    const r = respond(path, body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "x-credits-used": String(r.credits) } });
  }) as typeof fetch;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
});
after(() => { globalThis.fetch = realFetch; console.log = realLog; rmSync(dir, { recursive: true, force: true }); });

const { runSource } = await import("../src/source.js");
const THESIS = ["--thesis", "AI infrastructure, pre-seed, seed or unfunded, US, founded 2024 or later", "--founders-from", "ledgerpine.example"];

test("a full run: requests in order, every output written, contact data never saved", async () => {
  calls = []; logs = [];
  await runSource(THESIS);
  const paths = calls.map(c => c.path);
  assert.equal(paths[0], "/company/search/autocomplete");
  const search = calls.find(c => c.path === "/company/search")!;
  assert.equal(search.body.search.mode, "hybrid");
  assert.equal(search.body.search.query, "AI infrastructure");
  assert.ok(!search.body.fields.includes("hiring"), "hiring comes back empty on search, so it is not requested");
  assert.match(JSON.stringify(search.body.filters), /"is_null"/);
  assert.ok(paths.includes("/person/search") && paths.includes("/job/search") && paths.includes("/social_post/search"));
  const counts = calls.filter(c => c.path === "/social_post/search" && c.body.limit === 0);
  assert.ok(counts.length >= 2, "post counts are limit 0 (free)");
  for (const f of ["pipeline.csv", "founders.csv", "pipeline.md", "data.json", "history.json", "thesis.json"]) assert.ok(existsSync(join(dir, f)), f);
  assert.equal(readdirSync(join(dir, "memos")).length, 6);
  const saved = readFileSync(join(dir, "data.json"), "utf8") + readFileSync(join(dir, "pipeline.csv"), "utf8");
  assert.doesNotMatch(saved, /team@|555 0100/);
  assert.ok(logs.some(l => /app\.crustdata\.com\/watch/.test(l)), "ends with the watcher line");
  assert.ok(logs.some(l => /Memos are complete without AI/.test(l)));
  const relay = readFileSync(join(dir, "memos", "relaywise.example.md"), "utf8");
  assert.equal(relay.match(/Founding Solutions Engineer/g)?.length, 1, "a role listed twice shows once");
  const kite = readFileSync(join(dir, "memos", "kitebase.example.md"), "utf8");
  assert.match(kite, /May have just raised/);
  assert.match(kite, /closed our seed extension/);
});

test("the same thesis again right away is refused (it would cost credits); --force runs it", async () => {
  calls = []; logs = [];
  await runSource(["--thesis", THESIS[1]]);
  assert.equal(calls.length, 0);
  assert.ok(logs.some(l => /Nothing changed since the last run/.test(l)));
  await runSource(["--thesis", THESIS[1], "--force", "--no-watch-hint"]);
  assert.ok(calls.some(c => c.path === "/company/search"));
  assert.ok(!logs.slice(-5).some(l => /crustdata\.com\/watch/.test(l)), "--no-watch-hint turns the line off");
  const md = readFileSync(join(dir, "pipeline.md"), "utf8");
  assert.match(md, /Since the last run: 0 new, 6 still here, 0 back, 0 gone/);
});

test("changing only --schools or --timing re-scores the saved data with no request at all", async () => {
  calls = []; logs = [];
  await runSource(["--schools", "Stanford", "--timing", "fresh"]);
  assert.equal(calls.length, 0);
  assert.ok(logs.some(l => /re-scored: 0 credits/.test(l)));
  const csv = readFileSync(join(dir, "pipeline.csv"), "utf8");
  assert.match(csv, /Not a recent round/);
});

test("a key without post search: the signal is skipped, the run completes", async () => {
  postsDisabled = true; calls = []; logs = [];
  await runSource(["--thesis", THESIS[1], "--fresh", "--timing", "due"]);
  postsDisabled = false;
  assert.ok(logs.some(l => /post search is not enabled/.test(l)));
  assert.equal(calls.filter(c => c.path === "/social_post/search").length, 1, "stops asking after the first 403");
  const memo = readFileSync(join(dir, "memos", "relaywise.example.md"), "utf8");
  assert.match(memo, /Not checked: post search is not enabled/);
});

test("a bad stage is caught by autocomplete before any paid call", async () => {
  calls = []; logs = [];
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
  const realRespond = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ suggestions: [{ value: "seed" }, { value: "series_a" }] }), { status: 200 });
  }) as typeof fetch;
  try { await runSource(["--thesis", "fintech", "--stage", "series_z", "--fresh"]); }
  finally { globalThis.fetch = realRespond; console.error = realError; }
  assert.ok(calls.every(c => c.path.endsWith("/autocomplete")));
  assert.match(errors.join("\n"), /Stage "series_z"/);
  process.exitCode = 0;
});

test("a run that stops (out of credits) resumes without paying for finished steps again", async () => {
  const resumeDir = join(dir, "resume");
  failQuotesWith = 402; calls = []; logs = [];
  await assert.rejects(runSource(["--thesis", THESIS[1], "--out", resumeDir]), (e: Error & { outOfCredits?: boolean }) => !!e.outOfCredits);
  failQuotesWith = 0;
  const partials = () => readdirSync(resumeDir).filter(f => /^\.partial-[0-9a-f]+\.json$/.test(f));
  assert.equal(partials().length, 1, "finished steps are saved");
  assert.ok(!existsSync(join(resumeDir, "pipeline.csv")));
  calls = [];
  await runSource(["--thesis", THESIS[1], "--out", resumeDir]);
  assert.ok(logs.some(l => /Resuming the run started/.test(l)));
  assert.ok(!calls.some(c => c.path === "/company/search" || c.path === "/person/search"), "company and founder searches are not paid for twice");
  assert.ok(existsSync(join(resumeDir, "pipeline.csv")));
  assert.equal(partials().length, 0, "cleared once the run finishes");
  process.env.OUT_DIR = dir;
});

test("over 25 companies from a script needs --yes; an exclude file with no domain column is refused", async () => {
  calls = [];
  await assert.rejects(runSource(["--thesis", "robotics, seed", "--limit", "30", "--fresh", "--out", join(dir, "big")]), /needs --yes/);
  assert.ok(calls.every(c => c.path.endsWith("/autocomplete")), "nothing paid before the refusal");
  const csv = join(dir, "portfolio.csv");
  writeFileSync(csv, "Name,Notes\nAcme,we passed\n");
  await assert.rejects(runSource(["--thesis", "robotics, seed", "--exclude", csv, "--fresh", "--out", join(dir, "ex")]), /no domain or website column/);
  process.env.OUT_DIR = dir;
});

test("a key without job search still finishes the run, with roles not counted", async () => {
  const realFetch2 = globalThis.fetch;
  const wrapped = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (new URL(String(url)).pathname === "/job/search") return new Response(JSON.stringify({ error: { type: "permission_error", message: "Endpoint not enabled" } }), { status: 403 });
    return wrapped(url, init);
  }) as typeof fetch;
  logs = [];
  try { await runSource(["--thesis", THESIS[1], "--fresh", "--out", join(dir, "nojobs")]); }
  finally { globalThis.fetch = realFetch2; process.env.OUT_DIR = dir; }
  assert.ok(logs.some(l => /job search is not enabled/.test(l)));
  assert.ok(existsSync(join(dir, "nojobs", "pipeline.csv")));
});

test("exclusions add up across runs; --exclude none clears them", async () => {
  const exDir = join(dir, "excl");
  calls = []; logs = [];
  await runSource(["--thesis", "robotics, seed", "--exclude", "relaywise.example", "--fresh", "--out", exDir, "--force"]);
  await runSource(["--thesis", "robotics, seed", "--exclude", "kitebase.example", "--out", exDir, "--force"]);
  const saved = JSON.parse(readFileSync(join(exDir, "thesis.json"), "utf8")).spec.exclude;
  assert.deepEqual(saved.sort(), ["kitebase.example", "relaywise.example"]);
  await runSource(["--thesis", "robotics, seed", "--exclude", "none", "--out", exDir, "--force"]);
  assert.equal(JSON.parse(readFileSync(join(exDir, "thesis.json"), "utf8")).spec.exclude, undefined);
  process.env.OUT_DIR = dir;
});

test("a company search that stops on page 2 resumes without paying for page 1 again", async () => {
  const pageDir = join(dir, "pages");
  const realFetch3 = globalThis.fetch;
  const base = globalThis.fetch;
  let companyCalls: any[] = [];
  let failSecond = true;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/company/search") {
      const body = JSON.parse(String(init?.body));
      companyCalls.push(body);
      const all = fx.inputs.companies;
      if (!body.cursor && !JSON.stringify(body.filters).includes("not_in")) return new Response(JSON.stringify({ companies: all.slice(0, 3), next_cursor: "c2" }), { status: 200, headers: { "x-credits-used": "3" } });
      if (body.cursor && failSecond) return new Response(JSON.stringify({ error: { type: "insufficient_credits", message: "Not enough credits" } }), { status: 402 });
      return new Response(JSON.stringify({ companies: all.slice(3, 6), next_cursor: null }), { status: 200, headers: { "x-credits-used": "3" } });
    }
    return base(url, init);
  }) as typeof fetch;
  try {
    await assert.rejects(runSource(["--thesis", THESIS[1], "--fresh", "--out", pageDir]));
    assert.equal(companyCalls.length, 2);
    failSecond = false; companyCalls = []; logs = [];
    await runSource(["--thesis", THESIS[1], "--out", pageDir]);
    assert.equal(companyCalls.length, 1, "only the remaining companies are asked for");
    assert.match(JSON.stringify(companyCalls[0].filters), /"crustdata_company_id","type":"not_in","value":\[900101,900102,900103\]/);
    assert.equal(companyCalls[0].limit, 7);
    assert.ok(logs.some(l => /3 companies already fetched/.test(l)));
  } finally { globalThis.fetch = realFetch3; process.env.OUT_DIR = dir; }
});
