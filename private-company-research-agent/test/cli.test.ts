import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, freshOut, runCli } from "./helpers.js";
import { csvCell, md } from "../src/render.js";
import { isEntryPoint } from "../src/entry.js";
import { safeListName, swallowedByNpm } from "../src/cli.js";
import { statSync, mkdirSync } from "node:fs";

const paid = (calls: Array<{ path: string }>) => calls.filter(c => !["/company/identify", "/job/search"].includes(c.path) && !c.path.startsWith("/account"));
const deals = join(import.meta.dirname, "..", "fixtures", "inbound-deals.csv");

test("one company: memo.md and memo.json, a summary on stdout", async () => {
  const out = freshOut();
  const r = await runCli(fixture("fast-grower.json"), ["quillnote.example"]);
  assert.equal(r.code, 0, r.stderr);
  const memo = JSON.parse(readFileSync(join(out, "quillnote.example", "memo.json"), "utf8"));
  assert.equal(memo.company.name, "Quillnote");
  assert.match(readFileSync(join(out, "quillnote.example", "memo.md"), "utf8"), /^# Quillnote: private company research memo/);
  assert.match(r.stdout, /Quillnote: 3 red flags/);
  assert.match(r.stderr, /Quillnote \(quillnote.example\): 4.87 credits/);
});

test("a re-run within CACHE_DAYS makes no paid calls", async () => {
  freshOut();
  await runCli(fixture("fast-grower.json"), ["quillnote.example"]);
  const again = await runCli(fixture("fast-grower.json"), ["quillnote.example"]);
  assert.equal(again.code, 0);
  assert.equal(paid(again.calls).length, 0);
  assert.match(again.stderr, /0 credits/);
  const refreshed = await runCli(fixture("fast-grower.json"), ["quillnote.example", "--refresh"]);
  assert.ok(paid(refreshed.calls).length > 0, "--refresh fetches again");
});

test("--dry-run prints the estimate and calls nothing", async () => {
  freshOut();
  const r = await runCli(fixture("fast-grower.json"), [deals, "--dry-run"]);
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 0);
  assert.match(r.stderr, /5 companies: at most 66.15 credits at list price \(13.23 a company/);
  const noPeers = await runCli(fixture("fast-grower.json"), ["quillnote.example", "--dry-run", "--no-peers"]);
  assert.match(noPeers.stderr, /at most 10.08 credits/);
});

test("a list: a memo each, comparison.md and .csv, unresolved rows to fix", async () => {
  const out = freshOut();
  const r = await runCli(fixture("inbound-deals.json"), [deals]);
  assert.equal(r.code, 2, r.stderr);
  const csv = readFileSync(join(out, "inbound-deals", "comparison.csv"), "utf8").trim().split("\n");
  assert.equal(csv.length, 6);
  assert.match(csv[0], /^domain,company,status,what_it_does,categories,founded,hq,headcount,growth_6m_pct,growth_12m_pct/);
  assert.match(csv[0], /,input_Company name,input_Company Domain Name,input_Deal Stage,input_Founder Email$/);
  assert.match(csv[1], /^quillnote.example,Quillnote,ok,Meeting notes that write themselves\, for sales teams\.|^quillnote.example,Quillnote,ok,"Meeting notes that write themselves, for sales teams.",Artificial Intelligence \(AI\); Sales; SaaS,2023,"San Francisco, California, United States",94,27,74\.1/);
  const cmp = readFileSync(join(out, "inbound-deals", "comparison.md"), "utf8");
  assert.match(cmp, /^# inbound-deals: 3 of 7 rows researched; 3 in unresolved.csv; 1 duplicate skipped/);
  assert.match(cmp, /Not Quillnote \(quillnotes.example\) \| matched another company \(Ledgerlane\), skipped/);
  assert.match(cmp, /not enough data \(\d+\/10 sections\)/, "a company with little data is not shown as clean");
  assert.match(readFileSync(join(out, "inbound-deals", "comparison.md"), "utf8"), /\[Quillnote\]\(\.\.\/quillnote.example\/memo.md\)/);
  const unresolved = readFileSync(join(out, "inbound-deals", "unresolved.csv"), "utf8");
  assert.match(unresolved, /^line,company,domain,reason,input_Company name,input_Company Domain Name,input_Deal Stage,input_Founder Email/);
  assert.match(unresolved, /ghostco.example/);
  assert.match(unresolved, /quillnotes.example/);
  assert.match(unresolved, /gmail.com is a personal email provider/);
  assert.match(r.stderr, /Skipped line 5: a duplicate of line 2 \(quillnote.example\)/);
});

test("a run stopped by running out of credits resumes without paying twice", async () => {
  freshOut();
  const fx = fixture("inbound-deals.json");
  fx.faults = [{ path: "/company/enrich", call: 2, status: 402, message: "Insufficient credits" }];
  const first = await runCli(fx, [deals]);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /out of credits/);
  assert.match(first.stderr, /Run the same command again/);
  const fx2 = fixture("inbound-deals.json");
  const second = await runCli(fx2, [deals]);
  assert.equal(second.code, 2, second.stderr);
  const enriched = second.calls.filter(c => c.path === "/company/enrich").map(c => c.body.crustdata_company_ids[0]);
  assert.ok(!enriched.includes(9000001), "the company done before the stop is not paid for again");
});

test("the credit guard stops a big run unless --yes", async () => {
  freshOut();
  process.env.MAX_CREDITS_PER_RUN = "20";
  try {
    const r = await runCli(fixture("inbound-deals.json"), [deals]);
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
    assert.match(r.stderr, /above MAX_CREDITS_PER_RUN \(20\)/);
    const yes = await runCli(fixture("inbound-deals.json"), [deals, "--yes"]);
    assert.equal(yes.code, 2);
  } finally { process.env.MAX_CREDITS_PER_RUN = "150"; }
});

test("plain errors: bad key, unknown option, --peers with a list, Excel file, no domain", async () => {
  freshOut();
  const fx = fixture("fast-grower.json");
  fx.faults = [{ path: "/company/identify", call: 1, status: 401, message: "Invalid API key" }];
  const bad = await runCli(fx, ["quillnote.example"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /rejected the API key \(401\)/);
  assert.ok(!/at .*\.ts:\d+/.test(bad.stderr), "no stack trace");

  assert.match((await runCli(fx, ["acme.com", "--fast"])).stderr, /Unknown option --fast/);
  assert.match((await runCli(fx, [deals, "--peers", "a.com"])).stderr, /--peers works with one company/);
  const xlsx = join(freshOut(), "deals.xlsx");
  writeFileSync(xlsx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]));
  assert.match((await runCli(fx, [xlsx])).stderr, /spreadsheet file, not a CSV/);
  assert.match((await runCli(fx, ["not a domain"])).stderr, /no usable domain/);
});

test("--json prints the memo; --ai without a key stops before spending", async () => {
  freshOut();
  const r = await runCli(fixture("sparse.json"), ["sproutkit.example", "--json"]);
  assert.equal(JSON.parse(r.stdout).company.name, "Sproutkit");
  const ai = await runCli(fixture("sparse.json"), ["sproutkit.example", "--ai"]);
  assert.equal(ai.code, 1);
  assert.equal(ai.calls.length, 0);
  assert.match(ai.stderr, /--ai needs ANTHROPIC_API_KEY or OPENAI_API_KEY/);
});

test("a field group the key cannot read is dropped and the memo says so", async () => {
  const out = freshOut();
  const fx = fixture("fast-grower.json");
  fx.faults = [{ path: "/company/enrich", call: 1, status: 403, message: "Access denied to fields: web_traffic" }];
  const r = await runCli(fx, ["quillnote.example"]);
  assert.equal(r.code, 0, r.stderr);
  const enrich = r.calls.filter(c => c.path === "/company/enrich");
  assert.equal(enrich.length, 2);
  assert.ok(!enrich[1].body.fields.includes("web_traffic"));
  const memo = JSON.parse(readFileSync(join(out, "quillnote.example", "memo.json"), "utf8"));
  assert.ok(memo.not_available.some((x: string) => /web_traffic \(not enabled/.test(x)));
});

test("escaping: markdown from the data and CSV formulas", () => {
  assert.equal(md("A | B [x](y) <b>"), "A \\| B \\[x\\](y) \\<b\\>");
  assert.equal(md("1. Not a list"), "1\\. Not a list");
  assert.equal(md("- not an item"), "\\- not an item");
  assert.equal(md("-0.2%"), "-0.2%");
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-2+3+cmd|' /C calc'!A0"), "'-2+3+cmd|' /C calc'!A0");
  assert.equal(csvCell(" =1+1"), "' =1+1");
  assert.equal(csvCell(-5), "-5");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.ok(!existsSync(join("/nonexistent")));
});

test("flags npm kept for itself stop the run before anything is spent", async () => {
  assert.match(swallowedByNpm({ npm_lifecycle_event: "research", npm_config_dry_run: "true" })!, /npm took --dry-run for itself/);
  assert.equal(swallowedByNpm({ npm_config_dry_run: "true" }), undefined, "only when run through npm");
  assert.equal(swallowedByNpm({ npm_lifecycle_event: "test", npm_config_dry_run: "true" }), undefined, "only npm run research");
  assert.match(swallowedByNpm({ npm_lifecycle_event: "research", npm_config_peers: "" }, ["deals.csv"])!, /npm took --no-peers for itself.*npm run research -- deals.csv --no-peers/);
  assert.match(swallowedByNpm({ npm_lifecycle_event: "research", npm_config_peers: "true" }, ["linear.app", "otter.ai"])!, /npm took --peers/);
  process.env.npm_lifecycle_event = "research"; process.env.npm_config_dry_run = "true";
  try {
    freshOut();
    const r = await runCli(fixture("fast-grower.json"), ["quillnote.example"]);
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
    assert.match(r.stderr, /Put -- right after "npm run research": npm run research -- quillnote.example --dry-run/);
  } finally { delete process.env.npm_lifecycle_event; delete process.env.npm_config_dry_run; }
});

test("one company Crustdata cannot answer is skipped; three in a row stop the run", async () => {
  freshOut();
  const fx = fixture("inbound-deals.json");
  fx.faults = [{ path: "/company/enrich", call: 1, status: 500, message: "boom" }];
  const r = await runCli(fx, [deals]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /quillnote.example: .*server error.*Skipped; the run goes on/);
  assert.match(r.stderr, /Ledgerlane \(ledgerlane.example\)/);

  freshOut();
  const fx2 = fixture("inbound-deals.json");
  fx2.faults = [1, 2, 3].map(call => ({ path: "/company/enrich", call, status: 500, message: "down" }));
  const stop = await runCli(fx2, [deals]);
  assert.equal(stop.code, 1);
  assert.match(stop.stderr, /Stopped:/);
});

test("an old unresolved.csv is removed when every row is researched; files are owner-only", async () => {
  const out = freshOut();
  const list = join(out, "deals.csv");
  writeFileSync(list, "domain\nquillnote.example\nghostco.example\n");
  await runCli(fixture("inbound-deals.json"), [list]);
  assert.ok(existsSync(join(out, "deals", "unresolved.csv")));
  writeFileSync(list, "domain\nquillnote.example\nledgerlane.example\n");
  const r = await runCli(fixture("inbound-deals.json"), [list]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!existsSync(join(out, "deals", "unresolved.csv")));
  assert.equal(statSync(join(out, "quillnote.example", "memo.json")).mode & 0o077, 0);
});

test("list names cannot leave OUT_DIR; --json needs one company; a second run on the same folder waits its turn", async () => {
  assert.equal(safeListName("..."), "list");
  assert.equal(safeListName(".cache"), "cache");
  const out = freshOut();
  assert.match((await runCli(fixture("fast-grower.json"), [deals, "--json"])).stderr, /--json prints one memo/);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, ".lock"), String(process.ppid));
  const locked = await runCli(fixture("fast-grower.json"), ["quillnote.example"]);
  assert.equal(locked.code, 1);
  assert.match(locked.stderr, /Another run \(process \d+\) is using/);
  writeFileSync(join(out, ".lock"), "999999");
  assert.equal((await runCli(fixture("fast-grower.json"), ["quillnote.example"])).code, 0, "a lock from a run that ended is taken over");
});

test("importing the CLI from another file does not run it", () => {
  assert.equal(isEntryPoint("file:///x/src/cli.ts", "/elsewhere/deal-cli.ts"), false);
});

test("a stop after --refresh says to run again without --refresh", async () => {
  freshOut();
  const fx = fixture("inbound-deals.json");
  fx.faults = [{ path: "/company/enrich", call: 2, status: 402, message: "Insufficient credits" }];
  const r = await runCli(fx, [deals, "--refresh"]);
  assert.match(r.stderr, /Run the same command again without --refresh/);
});

test("round 2 engineer: the estimate prices what is not saved; --peers takes URLs; npx --yes is not npm swallowing", async () => {
  freshOut();
  await runCli(fixture("fast-grower.json"), ["quillnote.example"]);
  process.env.LEAVERS_LIMIT = "30";
  try {
    const r = await runCli(fixture("fast-grower.json"), ["quillnote.example", "--dry-run"]);
    assert.match(r.stderr, /1 company: at most 6\.9 credits/, "30 former staff with a new limit are priced; the record, jobs, leaders and peers are saved");
  } finally { process.env.LEAVERS_LIMIT = "25"; }
  const peers = await runCli(fixture("fast-grower.json"), ["quillnote.example", "--peers", "https://www.tallyminutes.example/,Recapr.Example"]);
  const memo = JSON.parse(readFileSync(join(process.env.OUT_DIR!, "quillnote.example", "memo.json"), "utf8"));
  assert.equal(peers.code, 0, peers.stderr);
  assert.deepEqual(memo.peers.rows.map((p: any) => p.name), ["Quillnote", "Tally Minutes", "Recapr"]);
  assert.equal(swallowedByNpm({ npm_lifecycle_event: "npx", npm_config_yes: "true" }), undefined);
  assert.equal(swallowedByNpm({ npm_lifecycle_event: "research", npm_config_yes: "true" }, ["x.com", "--yes"]), undefined, "a flag that reached us was not swallowed");
  assert.equal(safeListName("quillnote.example"), "quillnote.example-list");
});

test("round 3: a failed departures search is not a number anywhere; pasted links on the command line; --peers=x hint; all-saved wording", async () => {
  const out = freshOut();
  const fx = fixture("inbound-deals.json");
  fx.faults = [{ path: "/person/search", call: 1, status: 400, message: "bad" }];
  await runCli(fx, [deals]);
  const { parseCsv } = await import("../src/input.js");
  const [h0, r1] = parseCsv(readFileSync(join(out, "inbound-deals", "comparison.csv"), "utf8"), ",");
  const head = h0.cells, row = r1.cells;
  assert.equal(row[head.indexOf("staff_left_12m")], "");
  assert.match(readFileSync(join(out, "inbound-deals", "comparison.md"), "utf8"), /not available \(search failed\)/);
  const memo = JSON.parse(readFileSync(join(out, "quillnote.example", "memo.json"), "utf8"));
  assert.equal(memo.team.departures.total, null);
  assert.equal(memo.coverage.missing.includes("departures"), true);

  freshOut();
  const link = await runCli(fixture("fast-grower.json"), ["https://docsend.com/view/abc", "--dry-run"]);
  assert.match(link.stderr, /docsend\.com is a link .*Pass the company's own domain/);
  const bare = await runCli(fixture("fast-grower.json"), ["gamma.app", "--dry-run"]);
  assert.match(bare.stderr, /line 1  gamma\.app/);

  assert.match(swallowedByNpm({ npm_lifecycle_event: "research", npm_config_peers: "atlassian.com" }, ["linear.app"])!, /npm run research -- linear\.app --peers atlassian\.com/);

  await runCli(fixture("fast-grower.json"), ["quillnote.example"]);
  const again = await runCli(fixture("fast-grower.json"), ["quillnote.example", "--dry-run"]);
  assert.match(again.stderr, /1 company, saved in the last 7 days: free\. --refresh fetches it again/);
});

test("round 3 engineer: unmatched rows already looked up cost nothing in the estimate", async () => {
  freshOut();
  await runCli(fixture("inbound-deals.json"), [deals]);
  const again = await runCli(fixture("inbound-deals.json"), [deals, "--dry-run"]);
  assert.match(again.stderr, /5 companies, saved in the last 7 days: free/);
});
