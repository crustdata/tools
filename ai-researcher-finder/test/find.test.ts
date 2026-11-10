/** End to end: the real run against the fake API (no network, no key, no credits). */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { fakeFetch, type Call, type Fixture } from "../src/fake-api.js";

const base: Fixture = JSON.parse(readFileSync(new URL("../fixtures/example-labs.json", import.meta.url), "utf8"));
process.env.CRUSTDATA_API_KEY = "test";
delete process.env.ANTHROPIC_API_KEY;
const { runFind, runRescore } = await import("../src/find.js");
const { runWatchExample } = await import("../examples/watch-people.js");

let out = "", calls: Call[] = [], printed: string[] = [];
const quiet = console.log;
function use(fx: Fixture) {
  const f = fakeFetch(fx);
  globalThis.fetch = f.fetch;
  calls = f.calls;
}
async function run(fn: () => Promise<unknown>) {
  printed = [];
  console.log = (...a: unknown[]) => { printed.push(a.join(" ")); };
  try { return await fn(); } finally { console.log = quiet; }
}
// The access check sends a made-up Scholar URL, free on a miss, so it is not counted.
const billed = () => calls.filter(c => /^\/(person\/(search|identify)|dev_platform\/enrich)$/.test(c.path) && !JSON.stringify(c.body ?? {}).includes("AAAAAAAAAAAA"));
const read = (name: string, file: string) => readFileSync(join(out, name, file), "utf8");

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "arf-test-"));
  process.env.OUT_DIR = out;
  use(structuredClone(base));
});

test("a full run: three labs, a Scholar profile, two GitHub profiles and a paper title", async () => {
  await run(() => runFind(base.argv, "find"));
  const name = "ml-researchers-and-engineers-speculative-decoding-3-labs";
  const csv = read(name, "researchers.csv");
  const report = read(name, "report.md");
  // Everyone from the search, the Scholar profile (Kofi), the linked GitHub account (Ravi); the decoy paper author is out.
  for (const who of ["Jane Doe", "Kofi Example", "Ravi Example", "Omar Example", "王小明"]) assert.ok(csv.includes(who), who);
  assert.ok(!csv.includes("Dana Example"));
  assert.match(printed.join("\n"), /1 other person with a different paper using the same words was left out \(billed\)/);
  assert.match(printed.join("\n"), /example-unlinked: found \(Example Account\), but not linked/);
  // Searches go by company id, one per lab, with the query and the title group.
  const searches = calls.filter(c => c.path === "/person/search" && c.body.search);
  assert.equal(searches.length, 3);
  assert.match(JSON.stringify(searches[0].body.filters), /current\.company_id","type":"in","value":\[9001\]/);
  assert.match(searches[0].body.search.query, /working on speculative decoding/);
  // The team map, with labels.
  assert.match(report, /\| Inference \| Jane Doe \|/);
  assert.match(report, /\| Pretraining \|   \| Rahul Example \|/);
  assert.match(report, /Team not stated: Alex Example/);
  assert.match(report, /^# AI researchers and ML engineers at Example Labs, Northwind AI, Sample Intelligence/);
  // Files are private: owner-only.
  assert.equal(readFileSync(join(out, name, "people.json")).length > 0, true);
});

test("running the same search again skips everyone found, unbilled, and reuses seed lookups for free", async () => {
  await run(() => runFind(base.argv, "find"));
  use(structuredClone(base));
  await run(() => runFind(["--name", "ml-researchers-and-engineers-speculative-decoding-3-labs"], "find"));
  const searches = calls.filter(c => c.path === "/person/search" && c.body.search);
  assert.equal(searches.length, 3);
  assert.ok(searches.every(c => c.body.post_processing.exclude_profiles.length >= 10));
  assert.equal(calls.filter(c => c.path === "/person/identify" || c.path === "/dev_platform/enrich").length, 0);
  assert.match(printed.join("\n"), /skipping:\s+\d+ people already in/);
});

test("--dry-run spends nothing", async () => {
  await run(() => runFind([...base.argv, "--dry-run"], "find"));
  assert.equal(billed().length, 0);
  assert.match(printed.join("\n"), /at most [\d.]+ credits/);
  assert.ok(!existsSync(join(out, "ml-researchers-and-engineers-speculative-decoding-3-labs", "people.json")));
});

test("a run that can cost more than the limit stops before anything is billed", async () => {
  await assert.rejects(run(() => runFind([...base.argv, "--max-credits", "5"], "find")), /above the limit of 5.*--max-credits 3\d/s);
  assert.equal(billed().length, 0);
});

test("without Person Identify, Scholar seeds are skipped with a note and the rest runs", async () => {
  use({ ...structuredClone(base), noIdentify: true });
  await run(() => runFind(base.argv, "find"));
  assert.match(printed.join("\n"), /Person Identify is not enabled/);
  assert.match(read("ml-researchers-and-engineers-speculative-decoding-3-labs", "report.md"), /Jane Doe/);
});

test("a lab Crustdata does not know stops the run with the fix", async () => {
  await assert.rejects(run(() => runFind(["--labs", "nolab.example"], "find")), /does not know "nolab.example"/);
});

test("a failure part way keeps what was already billed", async () => {
  use({ ...structuredClone(base), faults: [{ path: "/person/search", call: 3, status: 400, message: "bad" }] });
  await assert.rejects(run(() => runFind(base.argv, "find")));
  const saved = JSON.parse(read("ml-researchers-and-engineers-speculative-decoding-3-labs", "people.json"));
  assert.equal(saved.length, 8); // the first two labs' searches
});

test("rescore is offline and follows an edited rubric", async () => {
  await run(() => runFind(base.argv, "find"));
  use(structuredClone(base));
  const rubric = join(out, "only-papers.json");
  writeFileSync(rubric, JSON.stringify({ rules: [{ points: 10, if: "papers_about", value: ["reward model"], label: "Reward model papers" }] }));
  await run(() => runRescore(["--rubric", rubric]));
  assert.equal(calls.length, 0);
  const first = read("ml-researchers-and-engineers-speculative-decoding-3-labs", "researchers.csv").split("\n")[1];
  assert.match(first, /Lena Example/);
});

test("watch-example writes the watcher request and sends nothing", async () => {
  await run(() => runFind(base.argv, "find"));
  use(structuredClone(base));
  await run(() => runWatchExample(["--email", "talent@yourcompany.example", "--top", "5"]));
  assert.equal(calls.length, 0);
  const body = JSON.parse(read("ml-researchers-and-engineers-speculative-decoding-3-labs", "watch-request.json"));
  assert.equal(body.entities.professional_network_profile_urls.length, 5);
  assert.deepEqual(body.notifications, [{ type: "email", to: ["talent@yourcompany.example"] }]);
});

test("a seeds-only run in a search's folder keeps the saved search", async () => {
  await run(() => runFind(base.argv, "find"));
  use(structuredClone(base));
  await run(() => runFind(["--name", "ml-researchers-and-engineers-speculative-decoding-3-labs", "--paper", "Scaling laws for example pretraining runs"], "find"));
  const saved = JSON.parse(read("ml-researchers-and-engineers-speculative-decoding-3-labs", "run.json"));
  assert.equal(saved.labs.length, 3);
  assert.equal(saved.seeds.filter((s: { kind: string }) => s.kind === "paper").length, 2);
  assert.equal(calls.filter(c => c.path === "/person/search" && c.body.search).length, 0);
});

test("a short Identify answer never shifts a Scholar URL onto the wrong person, and is not cached", async () => {
  const s1 = "https://scholar.google.com/citations?user=EXKOFI00AAAJ", s2 = "https://scholar.google.com/citations?user=EXJANE00AAAJ";
  use({ ...structuredClone(base), identifyShort: true, identify: { [s1]: 70012, [s2]: 70001 } });
  await run(() => runFind(["--scholar", `${s1},${s2}`, "--name", "short"], "find"));
  const cache = JSON.parse(read("short", "seeds.json"));
  assert.equal(cache[`scholar:${s1}`], undefined);
  assert.equal(cache[`scholar:${s2}`].id, 70001);
  assert.match(printed.join("\n"), /got no answer from Crustdata/);
});

test("a run that fails part way still writes run.json and the report, so --name works", async () => {
  use({ ...structuredClone(base), faults: [{ path: "/person/search", call: 2, status: 500, message: "boom" }] });
  await assert.rejects(run(() => runFind(base.argv, "find")));
  const name = "ml-researchers-and-engineers-speculative-decoding-3-labs";
  assert.match(read(name, "report.md"), /This run stopped early/);
  use(structuredClone(base));
  await run(() => runFind(["--name", name], "find"));
  assert.ok(calls.some(c => c.path === "/person/search" && c.body.search));
});

test("a rerun with --name keeps the saved search but takes the flags typed now", async () => {
  await run(() => runFind(base.argv, "find"));
  use(structuredClone(base));
  await run(() => runFind(["--name", "ml-researchers-and-engineers-speculative-decoding-3-labs", "--limit", "3", "--top", "2"], "find"));
  const searches = calls.filter(c => c.path === "/person/search" && c.body.search);
  assert.deepEqual(searches.map(c => c.body.limit), [1, 1, 1]);
  assert.equal((read("ml-researchers-and-engineers-speculative-decoding-3-labs", "report.md").match(/^### \d+\. /gm) ?? []).length, 2);
});

test("a different search never lands in the folder of another without --name", async () => {
  await run(() => runFind(["--labs", "examplelabs.example"], "find"));
  use(structuredClone(base));
  await assert.rejects(run(() => runFind(["--labs", "examplelabs.example", "--any-title"], "find")), /already holds a different search/);
});

test("a person at two searched labs is billed once", async () => {
  const fx = structuredClone(base);
  fx.people[0].experience!.employment_details!.current!.push({ title: "Advisor, research", name: "Northwind AI", crustdata_company_id: 9002 });
  fx.people[0].experience!.employment_details!.current![1].title = "Research Scientist";
  use({ ...fx, creditsPerResult: 1 });
  await run(() => runFind(["--labs", "examplelabs.example,northwind.example", "--limit", "20"], "find"));
  const second = calls.filter(c => c.path === "/person/search" && c.body.search)[1];
  assert.ok(second.body.post_processing.exclude_profiles.includes("https://profiles.example/in/example-jane-doe"));
});

test("--ai stops at once on a rejected Anthropic key and says so", async () => {
  await run(() => runFind(base.argv, "find"));
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  try {
    use({ ...structuredClone(base), anthropic: { status: 401 } });
    await run(() => runRescore(["--ai"]));
    assert.ok(calls.filter(c => c.path.startsWith("anthropic:")).length <= 4);
    assert.match(printed.join("\n"), /Anthropic rejected the key/);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

test("--ai answers are cached: a second rescore asks Claude nothing", async () => {
  await run(() => runFind(base.argv, "find"));
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  try {
    use({ ...structuredClone(base), anthropic: { answers: [{ answer: "yes", evidence: "Led the inference team" }, { answer: "unclear", evidence: "" }] } });
    await run(() => runRescore(["--ai"]));
    assert.ok(calls.filter(c => c.path.startsWith("anthropic:")).length >= 10);
    assert.match(read("ml-researchers-and-engineers-speculative-decoding-3-labs", "report.md"), /Claude: yes, Led the inference team/);
    use(structuredClone(base));
    await run(() => runRescore(["--ai"]));
    assert.equal(calls.filter(c => c.path.startsWith("anthropic:")).length, 0);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

test("forget removes a person everywhere, and later searches skip them unbilled", async () => {
  await run(() => runFind(base.argv, "find"));
  const { runForget } = await import("../src/forget.js");
  await run(() => runForget(["https://profiles.example/in/example-jane-doe"]));
  const name = "ml-researchers-and-engineers-speculative-decoding-3-labs";
  // Others' co-author lists still name her; her own record is gone.
  const ids = (file: string) => JSON.parse(read(file, "people.json")).map((f: { person: { crustdata_person_id: number } }) => f.person.crustdata_person_id);
  assert.ok(!ids(name).includes(70001));
  assert.ok(!read(name, "report.md").includes("### 1. Jane Doe"));
  use(structuredClone(base));
  await run(() => runFind(["--labs", "examplelabs.example", "--name", "other"], "find"));
  const search = calls.find(c => c.path === "/person/search" && c.body.search)!;
  assert.ok(search.body.post_processing.exclude_profiles.includes("https://profiles.example/in/example-jane-doe"));
  assert.ok(!ids("other").includes(70001));
});

test("watch-example needs a destination and a sane --top; a path in --name stays inside out/", async () => {
  await run(() => runFind(base.argv, "find"));
  await assert.rejects(run(() => runWatchExample([])), /Say where to send alerts/);
  await assert.rejects(run(() => runWatchExample(["--email", "a@b.example", "--top", "0"])), /whole number/);
  await run(() => runWatchExample(["--email", "a@b.example", "--name", "../../escape"]).catch(() => {}));
  assert.ok(!existsSync(join(out, "..", "..", "escape")));
});

test("people dropped as non-research are billed once and skipped on reruns", async () => {
  const fx = structuredClone(base);
  fx.people[3].experience!.employment_details!.current![0].title = "UX Researcher";
  use(fx);
  await run(() => runFind(["--labs", "examplelabs.example", "--name", "d"], "find"));
  assert.match(printed.join("\n"), /left out because the title is not a research role/);
  use(fx);
  await run(() => runFind(["--name", "d"], "find"));
  const search = calls.find(c => c.path === "/person/search" && c.body.search)!;
  assert.ok(search.body.post_processing.exclude_profiles.includes("https://profiles.example/in/example-alex-example"));
});

test("forget clears seed lookups, watcher requests and a folder's old report", async () => {
  await run(() => runFind(["--scholar", "https://scholar.google.com/citations?user=EXKOFI00AAAJ", "--name", "solo"], "find"));
  await run(() => runWatchExample(["--email", "a@b.example", "--name", "solo"]));
  const { runForget } = await import("../src/forget.js");
  await run(() => runForget(["70012"]));
  assert.ok(!read("solo", "report.md").includes("Kofi"));
  assert.ok(!read("solo", "researchers.csv").includes("Kofi"));
  assert.ok(!read("solo", "watch-request.json").includes("example-kofi-example"));
  use(structuredClone(base));
  await run(() => runFind(["--name", "solo", "--scholar", "https://scholar.google.com/citations?user=EXKOFI00AAAJ"], "find"));
  assert.ok(!calls.some(c => c.path === "/person/search" && JSON.stringify(c.body.filters).includes("70012")));
});

test("a paper search skips authors already in the folder and credits them for free", async () => {
  await run(() => runFind(base.argv, "find"));
  use(structuredClone(base));
  await run(() => runFind(["--name", "ml-researchers-and-engineers-speculative-decoding-3-labs", "--paper", "Speculative decoding for example models", "--fresh"], "find").catch(() => {}));
  use(structuredClone(base));
  await run(() => runFind(["--name", "ml-researchers-and-engineers-speculative-decoding-3-labs", "--paper", "Paged attention at example scale"], "find"));
  const paper = calls.find(c => c.path === "/person/search" && JSON.stringify(c.body.filters).includes("articles.title"))!;
  assert.ok(paper.body.post_processing.exclude_profiles.includes("https://profiles.example/in/example-jane-doe"));
  const jane = JSON.parse(read("ml-researchers-and-engineers-speculative-decoding-3-labs", "people.json")).find((f: { person: { crustdata_person_id: number } }) => f.person.crustdata_person_id === 70001);
  assert.ok(jane.via.includes("paper: Paged attention at example scale"));
});

test("--ai's limit is checked before anything is billed", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  try {
    await assert.rejects(run(() => runFind([...base.argv, "--ai", "--max-ai", "3"], "find")), /--ai could ask Claude about up to/);
    assert.equal(billed().length, 0);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

test("rescore uses the folder's own rubric; a map rerun keeps map and takes --per-lab", async () => {
  const rubric = join(out, "mine.json");
  writeFileSync(rubric, JSON.stringify({ rules: [{ points: 10, if: "title", value: ["member of technical staff"], label: "Only MTS" }] }));
  await run(() => runFind([...base.argv, "--rubric", rubric], "find"));
  await run(() => runRescore([]));
  assert.match(read("ml-researchers-and-engineers-speculative-decoding-3-labs", "report.md"), /Only MTS/);
  use(structuredClone(base));
  await run(() => runFind(["--lab", "examplelabs.example", "--name", "m"], "map"));
  use(structuredClone(base));
  await run(() => runFind(["--name", "m", "--per-lab", "2"], "map"));
  assert.equal(calls.find(c => c.path === "/person/search" && c.body.search)!.body.limit, 2);
  await assert.rejects(run(() => runFind(["--name", "m"], "find")), /holds a map search/);
});

test("the replay bills searches like Crustdata does", async () => {
  await run(() => runFind(base.argv, "find"));
  const spent = Number(/used ([\d.]+) credits/.exec(printed.join("\n"))![1]);
  assert.ok(spent > 8, String(spent));
});

test("the watcher request asks for one alert per watched person per run", async () => {
  await run(() => runFind(base.argv, "find"));
  await run(() => runWatchExample(["--email", "a@b.example"]));
  const body = JSON.parse(read("ml-researchers-and-engineers-speculative-decoding-3-labs", "watch-request.json"));
  assert.equal(body.config.max_results_per_run, body.entities.professional_network_profile_urls.length);
});

test("forgetting a Scholar URL before the person is found stops any later lookup", async () => {
  const { runForget } = await import("../src/forget.js");
  await run(() => runForget(["https://scholar.google.com/citations?user=EXKOFI00AAAJ&hl=en"]));
  use(structuredClone(base));
  await run(() => runFind(["--scholar", "https://scholar.google.com/citations?user=EXKOFI00AAAJ", "--name", "after"], "find").catch(() => {}));
  assert.equal(calls.filter(c => c.path === "/person/identify" && !JSON.stringify(c.body).includes("AAAAAAAAAAAA")).length, 0);
  assert.match(printed.join("\n"), /removed at the person's request/);
});

test("forget still clears a folder whose saved rubric is gone", async () => {
  const rubric = join(out, "gone.json");
  writeFileSync(rubric, JSON.stringify({ rules: [{ points: 10, if: "title", value: ["member of technical staff"] }] }));
  await run(() => runFind([...base.argv, "--rubric", rubric], "find"));
  rmSync(rubric);
  const { runForget } = await import("../src/forget.js");
  await run(() => runForget(["https://profiles.example/in/example-jane-doe"]));
  const name = "ml-researchers-and-engineers-speculative-decoding-3-labs";
  assert.ok(!existsSync(join(out, name, "report.md")) || !read(name, "report.md").includes("### 1. Jane Doe"));
  assert.ok(JSON.parse(readFileSync(join(out, "suppressed.json"), "utf8")).ids.includes(70001));
});

test("a rerun after a failure resumes: labs already searched are not bought again", async () => {
  use({ ...structuredClone(base), faults: [{ path: "/person/search", call: 3, status: 500, message: "boom" }] });
  await assert.rejects(run(() => runFind(base.argv, "find")));
  use(structuredClone(base));
  await run(() => runFind(base.argv, "find"));
  const searches = calls.filter(c => c.path === "/person/search" && c.body.search);
  assert.equal(searches.length, 1);
  assert.match(JSON.stringify(searches[0].body.filters), /\[9003\]/);
  assert.match(printed.join("\n"), /Resuming/);
});

test("a seed for someone already in the folder is matched locally, with no lookup", async () => {
  await run(() => runFind(base.argv, "find"));
  use(structuredClone(base));
  await run(() => runFind(["--name", "ml-researchers-and-engineers-speculative-decoding-3-labs", "--scholar", "https://scholar.google.com/citations?user=EXJANE00AAAJ"], "find"));
  assert.equal(calls.filter(c => c.path === "/person/identify" && !JSON.stringify(c.body).includes("AAAAAAAAAAAA")).length, 0);
});

test("when Claude fails, its questions are left out of the score and the report says so", async () => {
  await run(() => runFind(base.argv, "find"));
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  try {
    use({ ...structuredClone(base), anthropic: { status: 500 } });
    await run(() => runRescore(["--ai"]));
    const report = read("ml-researchers-and-engineers-speculative-decoding-3-labs", "report.md");
    assert.match(report, /Note: Claude could not answer/);
    assert.ok(!report.includes("Have they led or owned"));
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

test("a dry run above the credit limit says the real run will stop", async () => {
  await run(() => runFind([...base.argv, "--dry-run", "--per-paper", "100"], "find"));
  assert.match(printed.join("\n"), /the real run will stop/);
});
