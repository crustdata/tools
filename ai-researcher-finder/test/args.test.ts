import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.js";
import { estimate, LIST_PRICE, pricesFrom } from "../src/cost.js";
import { FRONTIER_LABS, asDomain, parseLabList } from "../src/labs.js";
import { searchFilters } from "../src/find.js";

test("labs: frontier expands, URLs become domains, names stay names", () => {
  assert.deepEqual(parseLabList("frontier").length, FRONTIER_LABS.length);
  assert.deepEqual(parseLabList("https://www.Anthropic.com/careers, Google DeepMind"), ["anthropic.com", "Google DeepMind"]);
  assert.equal(asDomain("deepmind.google"), "deepmind.google");
  assert.equal(asDomain("Google DeepMind"), undefined);
});

test("find: defaults, folder name, limit split across labs", () => {
  const s = parseArgs(["--labs", "frontier", "--topic", "inference, kv cache"], "find");
  assert.equal(s.name, "inference-kv-cache-frontier-labs");
  assert.equal(parseArgs(["--labs", "frontier"], "find").name, "frontier-labs");
  assert.equal(s.limit, 25);
  assert.deepEqual(s.topics, ["inference", "kv cache"]);
  const p = parseArgs(["--labs", "a.example,b.example", "--per-lab", "10"], "find");
  assert.equal(p.limit, 20);
});

test("map takes exactly one lab and defaults to 100 people", () => {
  const s = parseArgs(["--lab", "anthropic.com"], "map");
  assert.equal(s.limit, 100);
  assert.equal(s.name, "map-anthropic");
  assert.throws(() => parseArgs(["--lab", "a.example,b.example"], "map"), /exactly one lab/);
});

test("seed flags are checked against their kind", () => {
  const s = parseArgs(["--github", "https://github.com/example-dev", "--scholar", "https://github.com/x"], "find");
  assert.equal(s.seeds.length, 1);
  assert.match(s.seedProblems[0].why, /given with --scholar/);
});

test("plain mistakes get a plain message", () => {
  assert.throws(() => parseArgs([], "find"), /Say who to look for/);
  assert.throws(() => parseArgs(["--role", "x", "--limit", "0"], "find"), /--limit takes a whole number/);
  assert.throws(() => parseArgs(["research", "engineer"], "find"), /Put quotes around sentences/);
  assert.throws(() => parseArgs(["--labz", "x"], "find"), /Unknown flag --labz/);
});

test("search filters: lab by company id, the title group, past labs", () => {
  const f = JSON.stringify(searchFilters({ labIds: [9001], pastLabIds: [9002], anyTitle: false, country: "Canada" }));
  assert.match(f, /"experience.employment_details.current.company_id","type":"in","value":\[9001\]/);
  assert.match(f, /"experience.employment_details.past.company_id"/);
  assert.match(f, /member of technical staff/);
  assert.doesNotMatch(JSON.stringify(searchFilters({ labIds: [1], anyTitle: true })), /current.title/);
});

test("cost: account prices win over list prices; the ceiling adds every step", () => {
  const prices = pricesFrom([{ path: "/person/search", base_credits: 0.03, premium_fields: [{ field: "experience", credits: 0 }, { field: "education", credits: 0 }, { field: "skills", credits: 0 }, { field: "research_profiles", credits: 0.2 }], premium_filters: [{ field: "experience", credits: 0 }, { field: "research_profiles", credits: 0.2 }] }]);
  const plan = { searches: [{ label: "x", people: 10, filters: ["experience" as const] }], scholar: 2, profiles: 0, github: 1, papers: 1, perPaper: 10 };
  assert.equal(estimate(plan, prices).ceiling, 2.3 + 2 * 1.23 + 1.23 + 4.3);
  // 25 people across labs at list price: 0.83 each.
  assert.equal(estimate({ ...plan, searches: [{ label: "x", people: 25, filters: ["experience"] }], scholar: 0, github: 0, papers: 0 }, LIST_PRICE).ceiling, 20.75);
});

test("folder names say what was searched; a single dash gets the right hint", () => {
  assert.notEqual(parseArgs(["--labs", "frontier", "--topic", "inference"], "find").name, parseArgs(["--labs", "frontier", "--topic", "pretraining"], "find").name);
  assert.match(parseArgs(["--role", "研究员"], "find").name, /^search-[a-z0-9]+$/);
  assert.throws(() => parseArgs(["-labs", "frontier"], "find"), /two dashes/);
});

test("report links are https only and cannot break out of the link", async () => {
  const { mdLink } = await import("../src/output.js");
  assert.equal(mdLink("profile", "javascript:alert(1)"), "");
  assert.equal(mdLink("profile", "https://x.example/a) [click](https://evil.example"), "");
  assert.equal(mdLink("profile", "https://x.example/a(b)"), "[profile](https://x.example/a%28b%29)");
});

test("non-research titles are dropped only when no research role leads", async () => {
  const { notResearch } = await import("../src/find.js");
  assert.ok(notResearch("UX Researcher"));
  assert.ok(notResearch("Technical Recruiter, Research"));
  assert.ok(!notResearch("Research Scientist, User Modeling"));
  assert.ok(!notResearch("Research Engineer, Chip Design"));
  assert.ok(!notResearch("Research Scientist, Protein Design"));
});

test("report text that starts like a list is escaped", async () => {
  const { md } = await import("../src/output.js");
  assert.equal(md("1. Founder"), "1\\. Founder");
  assert.equal(md("- MTS"), "\\- MTS");
});

test("a watcher over more than 1,000 people asks for the results as a link", async () => {
  const { watchBody } = await import("../examples/watch-people.js");
  const urls = Array.from({ length: 1001 }, (_, i) => `https://profiles.example/in/p${i}`);
  assert.equal(watchBody(urls, [{ type: "email", to: ["a@b.example"] }]).config.payload_delivery_type, "link");
  assert.equal("payload_delivery_type" in watchBody(urls.slice(0, 5), []).config, false);
});
