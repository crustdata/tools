// Fixes from review round 1 that the other test files do not cover: input forms from real calendars and CRMs,
// team settings, the brief's order and warnings, the cache on disk, and retries.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeFetch, type Fixture } from "../src/fake-api.js";
import { companyName, pacing, spend } from "../src/crustdata.js";
import { DEFAULTS, research, type Options } from "../src/research.js";
import { main } from "../src/cli.js";
import { buildBrief, pickLinks, searchPhrase } from "../src/brief.js";
import { classify, headerKey, parseList, skipDomains, type Input } from "../src/input.js";
import { link, md, renderBrief } from "../src/render.js";
import { Cache } from "../src/cache.js";

pacing.on = false;
process.env.CRUSTDATA_API_KEY = "test-key";
const base = JSON.parse(readFileSync(new URL("../fixtures/meeting.json", import.meta.url), "utf8")) as Fixture;
const NOW = new Date(base.now!);
const opts = (o: Partial<Options> = {}): Options => ({ ...DEFAULTS, now: NOW, contact: [], ...o });
const inputs = (...raw: string[]): Input[] => raw.flatMap(r => classify(r).inputs);
const quiet = () => {};
let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "pr-r1-"));
  process.env.OUT_DIR = out;
  process.env.CACHE_HOURS = "24";
  process.env.SKIP_DOMAINS = "";
  process.env.MAX_CREDITS_PER_RUN = "150";
  spend.credits = 0;
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

test("a calendar paste: labels, summary lines, rooms and several names on one line", () => {
  const text = [
    "Required: Jane Doe <jane@acme.com>; Sam Lee <sam@globex.com>",
    "Optional: Bob Smith; Alice Wong",
    "4 guests",
    "2 yes, 2 awaiting",
    "Conference Room 4B <c_1889abc@resource.calendar.google.com>",
    "Jane Doe",
    "Ana Silva (she/her), Initech",
  ].join("\n");
  const { inputs, skipped } = parseList(text);
  assert.deepEqual(inputs.map(i => i.kind === "email" ? i.email : i.kind === "name" ? `${i.name}|${i.company ?? ""}` : i.url), ["jane@acme.com", "sam@globex.com", "Ana Silva|Initech"]);
  const reasons = skipped.map(s => s.reason).join(" / ");
  assert.match(reasons, /calendar summary line/);
  assert.match(reasons, /calendar room/);
  assert.match(reasons, /no company matches too many people/);
});

test("contact exports: Outlook, Google Contacts, Email (Work), Last, First names, footer rows, company websites", () => {
  assert.equal(headerKey("E-mail Address"), "email address");
  assert.equal(headerKey("E-mail 1 - Value"), "email 1 value");
  assert.equal(headerKey("Email (Work)"), "email");
  const outlook = parseList("First Name,Last Name,E-mail Address,Company\nJane,Doe,jane@acme.com,Acme\n");
  assert.deepEqual(outlook.inputs.map(i => i.kind), ["email"]);
  const google = parseList("Name,E-mail 1 - Value,Organization Name\nJane Doe,jane@acme.com,Acme\n");
  assert.deepEqual(google.inputs.map(i => i.kind), ["email"]);
  const sf = parseList('Full Name,Account Name,Website\n"Doe, Jane","Acme, Inc.",https://www.acme.com/\nDr. Mike Brown PhD,Globex,\nGrand Totals (2 records),,\nConfidential Information,,\n');
  assert.deepEqual(sf.inputs, [
    { kind: "name", raw: "Jane Doe, acme.com", name: "Jane Doe", company: "acme.com" },
    { kind: "name", raw: "Mike Brown, Globex", name: "Mike Brown", company: "Globex" },
  ]);
  assert.equal(sf.skipped.filter(s => /report title or total/.test(s.reason)).length, 1);
  // A lone two-word cell could be a person, so it is reported (not quietly dropped as a report title).
  assert.ok(sf.skipped.some(s => /Confidential Information/.test(s.raw) && !s.benign));
  const noEmail = parseList("Name,Company\nJane Doe,Acme\n");
  assert.match(noEmail.warnings[0], /No email or profile URL column/);
  const unknown = parseList("Contact Person,Contact Mail\nJane Doe,jane@acme.com\n");
  assert.match(unknown.warnings[0], /no column this tool reads/);
  assert.deepEqual(unknown.inputs.map(i => i.kind), ["email"]);
});

test("company names lose legal suffixes before the employer phrase match", () => {
  assert.equal(companyName("Acme, Inc."), "Acme");
  assert.equal(companyName("Globex GmbH"), "Globex");
  assert.equal(companyName("Initech"), "Initech");
});

test("SKIP_DOMAINS and --skip-domain leave out your own people for free", async () => {
  const { kept, skipped } = skipDomains(inputs("me@mycompany.com", "sam@eu.mycompany.com", "jane@acme.com", "Bob Smith, mycompany.com"), ["mycompany.com"]);
  assert.deepEqual(kept.map(k => k.raw), ["jane@acme.com"]);
  assert.equal(skipped.length, 3);
  const calls = use();
  process.env.SKIP_DOMAINS = "northwind-analytics.example";
  const r = await cli(["maya@northwind-analytics.example", "--no-web", "--no-posts"]);
  assert.equal(calls.length, 0);
  assert.match(r.stderr, /one of your own domains; not charged/);
  assert.match(r.stderr, /Nobody to research/);
});

test("MAX_CREDITS_PER_RUN refuses a big run without --yes; --dry-run says 'Would research'", async () => {
  use();
  process.env.MAX_CREDITS_PER_RUN = "5";
  const refused = await cli(["maya@northwind-analytics.example"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /more than MAX_CREDITS_PER_RUN \(5\)/);
  const yes = await cli(["maya@northwind-analytics.example", "--yes", "--no-web"]);
  assert.equal(yes.code, 0);
  const dry = await cli(["maya@northwind-analytics.example", "--dry-run"]);
  assert.match(dry.stderr, /Would research 1 person: at most 6\.5 credits/);
});

test("exit codes: 0 all done, 2 some missed, 0 for an empty attendee file; JSON is always an array", async () => {
  use();
  assert.equal((await cli(["maya@northwind-analytics.example", "--no-web", "--no-posts"])).code, 0);
  const some = await cli(["maya@northwind-analytics.example", "nobody@northwind-analytics.example", "--no-web", "--no-posts", "--json"]);
  assert.equal(some.code, 2);
  const parsed = JSON.parse(some.stdout);
  assert.deepEqual(parsed.map((x: { status: string }) => x.status), ["done", "not_found"]);
  const empty = join(out, "empty.txt");
  writeFileSync(empty, "# no meetings today\n");
  const none = await cli(["--file", empty, "--json"]);
  assert.equal(none.code, 0);
  assert.equal(none.stdout.trim(), "[]");
});

test("--file is read relative to where the command was run (INIT_CWD under npm)", async () => {
  use();
  const dir = mkdtempSync(join(tmpdir(), "pr-cwd-"));
  writeFileSync(join(dir, "people.txt"), "maya@northwind-analytics.example\n");
  process.env.INIT_CWD = dir;
  try {
    const r = await cli(["--file", "people.txt", "--dry-run"]);
    assert.match(r.stderr, /email: maya@northwind-analytics\.example/);
  } finally { delete process.env.INIT_CWD; }
});

test("briefs and the cache are owner-only; old cache entries are deleted at the start of a run", async () => {
  use();
  const cacheDir = join(out, ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const old = join(cacheDir, "old.json");
  writeFileSync(old, "{}");
  utimesSync(old, new Date(Date.now() - 48 * 3_600_000), new Date(Date.now() - 48 * 3_600_000));
  await cli(["maya@northwind-analytics.example", "--no-web", "--no-posts"]);
  assert.ok(!readdirSync(cacheDir).includes("old.json"));
  assert.equal(statSync(join(out, "maya-okafor.md")).mode & 0o777, 0o600);
  for (const f of readdirSync(cacheDir)) assert.equal(statSync(join(cacheDir, f)).mode & 0o777, 0o600);
  const c = new Cache(cacheDir, 0);
  c.set("x", 1);
  assert.equal(c.get("x"), 1, "kept in memory for the run even with the cache off");
});

test("a different person with the same name later gets their own file, not an overwrite", async () => {
  use();
  await cli(["maya@northwind-analytics.example", "--no-web", "--no-posts"]);
  const other = structuredClone(base.people[0]);
  other.crustdata_person_id = 9199999;
  other.social_handles!.professional_network_identifier!.profile_url = "https://www.linkedin.com/in/example-maya-okafor-2";
  use({ people: [...base.people, other] });
  await cli(["https://www.linkedin.com/in/example-maya-okafor-2", "--no-web", "--no-posts"]);
  assert.ok(readdirSync(out).includes("maya-okafor.md"));
  assert.ok(readdirSync(out).includes("maya-okafor-9199999.md"));
});

test("no one at the company now: the name is tried against past employers and labelled so", async () => {
  const calls = use({ names: { "diego alvarez|umbrella-insurance.example": { people: [] } } });
  const fx = fakeFetch({ ...base, names: { "diego alvarez|umbrella-insurance.example": { people: [{ crustdata_person_id: 9100002, basic_profile: { name: "Diego Alvarez" }, social_handles: { professional_network_identifier: { profile_url: "https://www.linkedin.com/in/example-diego-alvarez" } } }] } } });
  // First search (current employer) finds nobody, the second (any employer) finds him.
  let n = 0;
  globalThis.fetch = (async (u: any, init?: any) => {
    const path = new URL(String(u)).pathname;
    calls.push({ method: "POST", path, body: JSON.parse(String(init.body)) });
    if (path === "/person/search" && n++ === 0) return new Response(JSON.stringify({ profiles: [], total_count: 0 }), { headers: { "x-credits-used": "0" } });
    return fx.fetch(u, init);
  }) as typeof fetch;
  const res = await research([{ kind: "name", raw: "Diego Alvarez, umbrella-insurance.example", name: "Diego Alvarez", company: "umbrella-insurance.example" }], opts({ noPosts: true, web: false }), quiet);
  assert.equal(res[0].brief?.matchedBy, "name and a past company");
  const searches = calls.filter(c => c.path === "/person/search").map(c => c.body.filters.conditions[1].field);
  assert.deepEqual(searches, ["experience.employment_details.current.company_website_domain", "experience.employment_details.company_website_domain"]);
});

test("an email matched by name at the domain carries its match score and a warning", async () => {
  const fx = fakeFetch(base).fetch;
  globalThis.fetch = (async (u: any, init?: any) => {
    const r = await fx(u, init);
    if (new URL(String(u)).pathname !== "/person/identify") return r;
    const rows = await r.json();
    rows[0].matches[0].confidence_score = 0.62;
    return new Response(JSON.stringify(rows), { headers: { "x-credits-used": "1" } });
  }) as typeof fetch;
  const res = await research(inputs("wei.chen.home@mail.example"), opts({ noPosts: true, web: false }), quiet);
  assert.equal(res[0].brief?.matchScore, 0.62);
  assert.match(renderBrief(res[0].brief!), /Check this is the right person.*match score 0\.62/);
});

test("work emails rejected by /person/enrich (400) fall back to identify", async () => {
  const calls = use({ faults: [{ path: "/person/enrich", call: 1, status: 400, message: "Unknown parameter business_emails" }], emails: { "maya@northwind-analytics.example": "https://www.linkedin.com/in/example-maya-okafor" } });
  const res = await research(inputs("maya@northwind-analytics.example"), opts({ noPosts: true, web: false }), quiet);
  assert.equal(res[0].status, "done");
  assert.deepEqual(calls.map(c => c.path), ["/person/enrich", "/person/identify", "/person/enrich"]);
});

test("the brief reads in call order: posts and news before company and career; found-by in the footer", async () => {
  use();
  const res = await research(inputs("maya@northwind-analytics.example"), opts(), quiet);
  const text = renderBrief(res[0].brief!);
  const at = (h: string) => text.indexOf(h);
  assert.ok(at("## What changed lately") < at("## Recent posts"));
  assert.ok(at("## Recent posts") < at("## In the news"));
  assert.ok(at("## In the news") < at("## About Northwind"));
  assert.ok(at("## About Northwind") < at("## Career"));
  assert.match(text, /\nFound by work email: maya@northwind-analytics\.example\. Profile refreshed on 2026-10-20\.\n/);
  assert.ok(!/Vice President|Director ·/.test(text.split("## Career")[1]), "seniority labels stay out of career lines");
  assert.ok(!text.includes("company-researcher"), "the company researcher pointer lives in the index, not every brief");
});

test("a headline that only repeats 'title at company' is hidden; email statuses other than deliverable are shown", () => {
  const b = buildBrief({ input: "x", matchedBy: "x", now: NOW, days: 180, person: {
    basic_profile: { name: "Diego Alvarez", headline: "Head of Data at Initech", current_title: "Head of Data" },
    experience: { employment_details: { current: [{ name: "Initech", title: "Head of Data", start_date: "2026-07-01", is_default: true }] } },
    contact: { business_emails: [{ email: "d@initech.example", status: "deliverable" }, { email: "da@initech.example", status: "catch_all" }], personal_emails: [{ email: "d@mail.example", status: "invalid" }] },
  } });
  assert.equal(b.person.headline, undefined);
  assert.deepEqual(b.contact?.business, ["d@initech.example", "da@initech.example (catch all)"]);
  assert.deepEqual(b.contact?.personal, ["d@mail.example (invalid)"]);
});

test("web results must mention the last name; people between jobs are searched with their last employer", () => {
  const links = pickLinks([{ url: "https://a.example/x", title: "Wei Chen on product" }, { url: "https://b.example/y", title: "Wei Zhang podcast" }], [], undefined, 5, "Chen");
  assert.deepEqual(links.map(l => l.url), ["https://a.example/x"]);
  assert.equal(searchPhrase(base.people[3]), '"Wei Chen" Massive Dynamic');
});

test("links only for http(s); external text cannot start a list or heading", () => {
  assert.equal(link("Open", "javascript:alert(1)"), "Open");
  assert.equal(md("- not a list"), "\\- not a list");
  assert.equal(md("# not a heading"), "\\# not a heading");
  assert.equal(md("a|b"), "a|b");
});

test("a 502 that reports credits is not retried; a 200 that is not JSON is an error, not a miss", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("bad gateway", { status: 502, headers: { "x-credits-used": "1" } }); }) as typeof fetch;
  const res = await research(inputs("https://www.linkedin.com/in/example-maya-okafor"), opts({ noPosts: true, web: false }), quiet);
  assert.equal(calls, 1);
  assert.equal(res[0].status, "failed");
  globalThis.fetch = (async () => new Response("<html>proxy</html>", { status: 200 })) as typeof fetch;
  const html = await research(inputs("https://www.linkedin.com/in/example-diego-alvarez"), opts({ noPosts: true, web: false }), quiet);
  assert.equal(html[0].status, "failed");
  assert.match(html[0].note ?? "", /not JSON/);
});

test("fields the key cannot read are named plainly and not asked for again next run", async () => {
  const log: string[] = [];
  const calls = use({ faults: [{ path: "/person/enrich", call: 1, status: 403, message: "Access denied to fields: certifications, honors" }] });
  await research(inputs("https://www.linkedin.com/in/example-maya-okafor"), opts({ noPosts: true, web: false }), m => log.push(m));
  assert.ok(log.some(m => /cannot read certifications, honors, so briefs go without them\. Ask Crustdata/.test(m)));
  assert.ok(!log.some(m => /self-serve/.test(m)));
  const again = use();
  await research(inputs("https://www.linkedin.com/in/example-diego-alvarez"), opts({ noPosts: true, web: false }), quiet);
  assert.ok(!again[0].body.fields.includes("certifications"));
  assert.equal(calls.filter(c => c.path === "/person/enrich").length, 2);
});
