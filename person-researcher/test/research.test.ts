import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeFetch, type Fixture } from "../src/fake-api.js";
import { pacing, spend } from "../src/crustdata.js";
import { DEFAULTS, research, writeFiles, type Options } from "../src/research.js";
import { parseArgs } from "../src/cli.js";
import { classify, type Input } from "../src/input.js";

pacing.on = false;
process.env.CRUSTDATA_API_KEY = "test-key";
const base = JSON.parse(readFileSync(new URL("../fixtures/meeting.json", import.meta.url), "utf8")) as Fixture;
const NOW = new Date(base.now!);
const opts = (o: Partial<Options> = {}): Options => ({ ...DEFAULTS, now: NOW, contact: [], ...o });
const inputs = (...raw: string[]): Input[] => raw.flatMap(r => classify(r).inputs);
const quiet = () => {};

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "pr-test-"));
  process.env.OUT_DIR = out;
  process.env.CACHE_HOURS = "24";
  spend.credits = 0;
});
const use = (fx: Partial<Fixture> = {}) => { const f = fakeFetch({ ...base, ...fx }); globalThis.fetch = f.fetch; return f.calls; };

test("a whole meeting: work email, profile URL, name and company, personal email, and a miss", async () => {
  const calls = use();
  const res = await research(inputs(...base.argv), opts(), quiet);
  assert.deepEqual(res.map(r => r.status), ["done", "done", "done", "done", "not_found"]);
  assert.deepEqual(res.map(r => r.brief?.matchedBy), ["work email", "profile URL", "name and company", "email", undefined]);
  assert.deepEqual(res.map(r => r.brief?.changes[0]?.kind), ["new_title", "new_company", "added_role", "left", undefined]);
  // Order of calls: name search, enrich by work email, identify the misses, enrich by URL, then per person posts, web, news.
  assert.deepEqual(calls.slice(0, 4).map(c => c.path), ["/person/search", "/person/enrich", "/person/identify", "/person/enrich"]);
  assert.deepEqual(calls[2].body.emails, ["wei.chen.home@mail.example", "nobody@northwind-analytics.example"]);
  assert.equal(calls.filter(c => c.path === "/social_post/search").length, 4);
  assert.equal(calls.filter(c => c.path === "/web/search/live").length, 8);
  // List price on the fake: 0.13 search + 1 work email + 1 identify + 3 enrich + 3.5 posts + 3 web/news with results.
  assert.equal(Math.round(spend.credits * 100) / 100, 11.63);
  const { rows, files } = writeFiles(res, out, NOW);
  assert.ok(files.some(f => f.endsWith("index.md")));
  assert.deepEqual(readdirSync(out).filter(f => f.endsWith(".md")).sort(), ["diego-alvarez.md", "index.md", "maya-okafor.md", "priya-raman.md", "wei-chen.md"]);
  assert.equal(rows[4].status, "not_found");
});

test("posts are asked for as original posts by the person, newest first", async () => {
  const calls = use();
  await research(inputs("maya@northwind-analytics.example"), opts({ posts: 3 }), quiet);
  const post = calls.find(c => c.path === "/social_post/search")!;
  assert.deepEqual(post.body.filters.conditions, [
    { field: "actor.crustdata_entity_id", type: "=", value: 9100001 },
    { field: "actor.actor_type", type: "=", value: "person" },
    { field: "post_type", type: "=", value: "original" },
  ]);
  assert.deepEqual(post.body.sorts, [{ field: "date_posted", order: "desc" }]);
  assert.equal(post.body.limit, 3);
  const news = calls.filter(c => c.path === "/web/search/live")[1].body;
  assert.deepEqual(news.sources, ["news"]);
  assert.equal(news.start_date, Math.floor(NOW.getTime() / 1000) - 90 * 86_400);
  assert.equal(news.query, '"Maya Okafor" Northwind Analytics');
});

test("the same person again within CACHE_HOURS makes no paid call", async () => {
  use();
  await research(inputs("maya@northwind-analytics.example"), opts(), quiet);
  const first = spend.credits;
  assert.ok(first > 0);
  const calls = use();
  spend.credits = 0;
  const again = await research(inputs("maya@northwind-analytics.example"), opts(), quiet);
  assert.equal(again[0].status, "done");
  assert.equal(calls.length, 0);
  assert.equal(spend.credits, 0);
  // --refresh fetches again.
  const fresh = use();
  await research(inputs("maya@northwind-analytics.example"), opts({ refresh: true }), quiet);
  assert.ok(fresh.length > 0);
});

test("a person found by work email is free later by profile URL", async () => {
  use();
  await research(inputs("maya@northwind-analytics.example"), opts({ noPosts: true, web: false }), quiet);
  const calls = use();
  await research(inputs("https://www.linkedin.com/in/example-maya-okafor"), opts({ noPosts: true, web: false }), quiet);
  assert.equal(calls.length, 0);
});

test("--no-posts and --no-web skip those calls; --posts 0 asks only for the free count", async () => {
  let calls = use();
  const res = await research(inputs("maya@northwind-analytics.example"), opts({ noPosts: true, web: false }), quiet);
  assert.deepEqual(calls.map(c => c.path), ["/person/enrich"]);
  assert.equal(res[0].brief?.posts, undefined);
  calls = use();
  const zero = await research(inputs("https://www.linkedin.com/in/example-maya-okafor"), opts({ posts: 0, web: false, refresh: true }), quiet);
  const post = calls.find(c => c.path === "/social_post/search")!;
  assert.equal(post.body.limit, 0);
  assert.equal(post.body.fields, undefined);
  assert.equal(zero[0].brief?.posts?.total, 64);
});

test("an address Crustdata calls invalid is taken out and the rest of the batch still runs", async () => {
  const calls = use();
  const res = await research(inputs("typo@nowhere.invalid", "wei.chen.home@mail.example"), opts({ noPosts: true, web: false }), quiet);
  assert.deepEqual(res.map(r => r.status), ["not_found", "done"]);
  assert.match(res[0].note ?? "", /does not accept this address/);
  assert.equal(calls.filter(c => c.path === "/person/identify").length, 2);
});

test("without email lookup on the key, a work email miss says personal emails need it", async () => {
  use({ forbidden: ["/person/identify"] });
  const res = await research(inputs("wei.chen.home@mail.example"), opts(), quiet);
  assert.equal(res[0].status, "not_found");
  assert.match(res[0].note ?? "", /not enabled on this key/);
});

test("post search not enabled: said once, briefs go on without posts", async () => {
  use({ forbidden: ["/social_post/search"] });
  const log: string[] = [];
  const res = await research(inputs("maya@northwind-analytics.example", "https://www.linkedin.com/in/example-diego-alvarez"), opts(), m => log.push(m));
  assert.deepEqual(res.map(r => r.status), ["done", "done"]);
  assert.equal(log.filter(m => /Post search/.test(m)).length, 1);
  assert.equal(res[0].brief?.posts, undefined);
  assert.ok(res[0].brief?.web?.length);
});

test("a server error on one section is a note in that brief, not a failed run", async () => {
  use({ faults: [{ path: "/web/search/live", call: 1, status: 500 }] });
  const res = await research(inputs("maya@northwind-analytics.example"), opts(), quiet);
  assert.equal(res[0].status, "done");
  assert.match(res[0].brief?.notes[0] ?? "", /Web results are missing/);
  assert.ok(res[0].brief?.posts?.shown.length);
});

test("a bad key stops the run with the setup hint", async () => {
  use({ faults: [{ path: "/person/enrich", call: 1, status: 401 }] });
  await assert.rejects(research(inputs("maya@northwind-analytics.example"), opts(), quiet), /rejected the API key \(401\)/);
});

test("a common name stops with a numbered list; --pick chooses one", async () => {
  let calls = use();
  const res = await research(inputs("Sam Lee"), opts(), quiet);
  assert.equal(res[0].status, "pick");
  assert.equal(res[0].candidates?.length, 3);
  assert.match(res[0].note ?? "", /412 people match "Sam Lee"/);
  assert.deepEqual(calls.map(c => c.path), ["/person/search"]);
  calls = use({ people: [...base.people, { crustdata_person_id: 9100012, basic_profile: { name: "Sam Lee" }, social_handles: { professional_network_identifier: { profile_url: "https://www.linkedin.com/in/example-sam-lee-2" } } }] });
  const picked = await research(inputs("Sam Lee"), opts({ pick: 2, noPosts: true, web: false }), quiet);
  assert.equal(picked[0].status, "done");
  assert.deepEqual(calls.find(c => c.path === "/person/enrich")?.body.professional_network_profile_urls, ["https://www.linkedin.com/in/example-sam-lee-2"]);
});

test("a name at a company domain filters on the website domain exactly", async () => {
  const calls = use({ names: { "priya raman|hooli.example": base.names!["priya raman|hooli"] } });
  const res = await research([{ kind: "name", raw: "x", name: "Priya Raman", company: "https://www.hooli.example/" }], opts({ noPosts: true, web: false }), quiet);
  assert.equal(res[0].status, "done");
  assert.deepEqual(calls[0].body.filters.conditions[1], { field: "experience.employment_details.current.company_website_domain", type: "=", value: "hooli.example" });
});

test("the same person by email and by profile URL gets one brief", async () => {
  use();
  const res = await research(inputs("maya@northwind-analytics.example", "https://www.linkedin.com/in/example-maya-okafor"), opts({ noPosts: true, web: false }), quiet);
  assert.deepEqual(res.map(r => r.status), ["done", "skipped"]);
  assert.match(res[1].note ?? "", /Same person as "maya@northwind-analytics.example"/);
});

test("contacts come from the contact-only endpoint, and a key without access says so", async () => {
  let calls = use();
  const res = await research(inputs("maya@northwind-analytics.example"), opts({ contact: ["business"], noPosts: true, web: false }), quiet);
  assert.deepEqual(res[0].brief?.contact?.business, ["maya@northwind-analytics.example"]);
  assert.deepEqual(calls.find(c => c.path === "/person/contact/enrich")?.body.fields, ["contact.business_emails"]);
  calls = use({ forbidden: ["/person/contact/enrich"] });
  const log: string[] = [];
  const denied = await research(inputs("https://www.linkedin.com/in/example-diego-alvarez"), opts({ contact: ["personal"], noPosts: true, web: false }), m => log.push(m));
  assert.equal(denied[0].status, "done");
  assert.ok(log.some(m => /self-serve keys do not have it/.test(m)));
});

test("argument parsing: flags, files, and plain messages for mistakes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-args-"));
  writeFileSync(join(dir, "people.csv"), "Email\njane@acme.com\nbad-row\n");
  const a = parseArgs(["--name", "Jane Doe", "--company", "acme.com", "--posts", "3", "--days=90", "--contact", "--no-web"]);
  assert.deepEqual(a.inputs, [{ kind: "name", raw: "Jane Doe, acme.com", name: "Jane Doe", company: "acme.com" }]);
  assert.equal(a.opts.posts, 3);
  assert.equal(a.opts.days, 90);
  assert.deepEqual(a.opts.contact, ["business"]);
  assert.equal(a.opts.web, false);
  assert.deepEqual(parseArgs(["--contact", "all", "x@y.com"]).opts.contact, ["business", "personal", "phone"]);
  assert.deepEqual(parseArgs(["--contact", "x@y.com"]).inputs.map(i => i.kind), ["email"]);
  const f = parseArgs(["--file", join(dir, "people.csv")]);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.skipped[0].line, 3);
  assert.throws(() => parseArgs(["--posts", "11"]), /from 0 to 10/);
  assert.throws(() => parseArgs(["--file", "list.xlsx"]), /Save it as CSV/);
  assert.throws(() => parseArgs(["--file", join(dir, "missing.csv")]), /Cannot read/);
  assert.throws(() => parseArgs(["--company", "acme"]), /goes with --name/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown flag/);
});
