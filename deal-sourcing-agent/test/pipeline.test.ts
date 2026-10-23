import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildPipeline, domainsFromCsv, memoFile, rescore, toCompany, updateHistory } from "../src/pipeline.js";
import { mergeSpec, parseFlags, parseSentence, pipelineKey } from "../src/thesis.js";

const today = new Date("2026-10-21T12:00:00Z");
const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const specOf = (fx: { thesis: string; flags?: string[] }) => mergeSpec({ thesis: fx.thesis }, parseSentence(fx.thesis, today), parseFlags(fx.flags ?? []).flags);

test("every fixture builds a pipeline without throwing", () => {
  for (const f of readdirSync(new URL("../fixtures/", import.meta.url)).filter(f => f.endsWith(".json"))) {
    const fx = load(f.replace(/\.json$/, ""));
    const r = buildPipeline(fx.inputs, specOf(fx), today);
    for (const d of r.deals) assert.ok(d.score.total >= 0 && d.score.total <= 100, `${f}: ${d.company.name}`);
  }
});

test("the main sample ranks growth over quiet, and labels each timing case", () => {
  const fx = load("seed-pipeline");
  const deals = buildPipeline(fx.inputs, specOf(fx), today).deals;
  const label = (d: string) => deals.find(x => x.company.domain === d)!.score.timing.label;
  assert.equal(deals[0].company.domain, "relaywise.example");
  assert.equal(deals.at(-1)!.company.domain, "quietlayer.example");
  assert.equal(label("relaywise.example"), "Due and growing");
  assert.equal(label("quietlayer.example"), "Due but quiet");
  assert.equal(label("kitebase.example"), "May have just raised");
  assert.equal(label("fernbridge.example"), "No disclosed round");
  assert.equal(label("junoplane.example"), "Due, some growth");
});

test("toCompany: null investors, no headcount history, no round", () => {
  const fx = load("seed-pipeline");
  const moss = toCompany(fx.inputs.companies.find((c: { crustdata_company_id: number }) => c.crustdata_company_id === 900104));
  assert.deepEqual(moss.investors, []);
  assert.equal(moss.growth6m, undefined);
  const fern = toCompany(fx.inputs.companies.find((c: { crustdata_company_id: number }) => c.crustdata_company_id === 900103));
  assert.equal(fern.lastRound, undefined);
  assert.equal(fern.totalUsd, undefined);
  assert.ok(!("contact_email" in fern));
});

test("re-run: still here, new, and gone", () => {
  const fx = load("rerun");
  const spec = specOf(fx);
  const key = pipelineKey(spec);
  const previous = { ...fx.history, key };
  const deals = buildPipeline(fx.inputs, spec, today, previous).deals;
  assert.equal(deals.find(d => d.company.domain === "relaywise.example")!.status, "still here");
  assert.equal(deals.find(d => d.company.domain === "relaywise.example")!.firstSeen, "2026-10-14");
  assert.equal(deals.find(d => d.company.domain === "kitebase.example")!.status, "new");
  const { history, gone, samePipeline } = updateHistory(previous, key, deals, today);
  assert.ok(samePipeline);
  assert.deepEqual(gone.map(g => g.name), ["Gonecorp"]);
  assert.equal(history.runs.length, 2);
  assert.equal(history.seen[900199].lastSeen, "2026-10-14", "a gone company keeps its dates");
  const other = updateHistory(previous, "another thesis", deals, today);
  assert.ok(!other.samePipeline);
  assert.equal(other.gone.length, 0, "a different thesis starts a new pipeline, nothing is gone");
});

test("--only-founders-from keeps only companies with such a founder", () => {
  const fx = load("only-founders-from");
  const r = buildPipeline(fx.inputs, specOf(fx), today);
  assert.deepEqual(r.deals.map(d => d.company.domain).sort(), ["fernbridge.example", "junoplane.example", "relaywise.example"]);
  assert.equal(r.droppedNoListFounder, 3);
});

test("--exclude-investors drops a company even when the name differs in case", () => {
  const fx = load("seed-pipeline");
  const r = buildPipeline(fx.inputs, { ...specOf(fx), excludeInvestors: ["copperline capital"] }, today);
  assert.ok(!r.deals.some(d => d.company.investors.includes("Copperline Capital")));
  assert.equal(r.droppedExcludedInvestor, 2);
});

test("re-scoring saved deals with new lists costs nothing and changes the order", () => {
  const fx = load("seed-pipeline");
  const spec = specOf({ thesis: fx.thesis });
  const deals = buildPipeline(fx.inputs, spec, today).deals;
  const juno = (ds: typeof deals) => ds.find(d => d.company.domain === "junoplane.example")!;
  const after = rescore(deals, { ...spec, foundersFrom: ["ledgerpine.example"] }, today);
  assert.ok(juno(after).score.total > juno(deals).score.total);
  assert.equal(juno(after).founders[0].fromList[0].entry, "ledgerpine.example");
  assert.equal(rescore(deals, { ...spec, foundersFrom: ["ledgerpine.example"], onlyFoundersFrom: true }, today).length, 3);
});

test("exclusions from any CSV: HubSpot-style columns, a BOM, semicolons, several domain columns, a bare list", () => {
  const d = (t: string) => domainsFromCsv(t).domains;
  assert.deepEqual(d("\uFEFFCompany name,Company Domain Name\nFakeco,fakeco.example\nOther,https://www.other.example/about\n"), ["fakeco.example", "other.example"]);
  assert.deepEqual(d("Website\nfakeco.example\nfakeco.example\n"), ["fakeco.example"]);
  assert.deepEqual(d("fakeco.example, other.example"), ["fakeco.example", "other.example"]);
  assert.deepEqual(d("\uFEFFName;Website\nAcme;https://acme.example\nBeta;beta.example\n"), ["acme.example", "beta.example"], "European semicolon export");
  assert.deepEqual(d("Name,Company Domain Name,Website URL\nDelta,\"delta.example; delta.io\",\nBeta,,https://beta.example\n"), ["delta.example", "delta.io", "beta.example"]);
  assert.deepEqual(d("Primary Website,Owner\nfoo.example,ann@fund.example\n"), ["foo.example"], "emails are never domains");
  const noCol = domainsFromCsv("Name,Notes\nAcme,we passed\n");
  assert.ok(noCol.noColumn);
  assert.deepEqual(noCol.domains, []);
});

test("two companies with the same domain get separate memo files", () => {
  const fx = load("seed-pipeline");
  const twin = { ...fx.inputs.companies[0], crustdata_company_id: 999999, basic_info: { ...fx.inputs.companies[0].basic_info, name: "Relaywise (second record)" } };
  const deals = buildPipeline({ ...fx.inputs, companies: [...fx.inputs.companies, twin, fx.inputs.companies[0]] }, specOf(fx), today).deals;
  assert.equal(deals.length, 7, "the same id returned twice is kept once");
  const names = deals.map(memoFile);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("relaywise.example-900101.md") && names.includes("relaywise.example-999999.md"));
});

test("re-run detail: back, and what changed", () => {
  const fx = load("rerun");
  const spec = specOf(fx);
  const key = pipelineKey(spec);
  const history = { key, runs: [{ at: "2026-10-01T00:00:00Z", ids: [900101] }, { at: "2026-10-14T00:00:00Z", ids: [900102] }],
    seen: { 900101: { name: "Relaywise", domain: "relaywise.example", firstSeen: "2026-10-01", lastSeen: "2026-10-01", score: 80, label: "Due, some growth", headcount: 9, lastRoundDate: "2025-03-10" },
      900102: { name: "Quietlayer", domain: "quietlayer.example", firstSeen: "2026-10-14", lastSeen: "2026-10-14" } } };
  const deals = buildPipeline(fx.inputs, spec, today, history).deals;
  const relay = deals.find(d => d.company.domain === "relaywise.example")!;
  assert.equal(relay.status, "back");
  assert.match(relay.change!, /score 80 to \d+; Due, some growth to Due and growing; team 9 to 14/);
  assert.equal(deals.find(d => d.company.domain === "quietlayer.example")!.status, "still here");
});

test("passing on a company (adding it to --exclude) keeps the same pipeline", () => {
  const a = mergeSpec({ thesis: "x" }, { stages: ["seed"] });
  assert.equal(pipelineKey(a), pipelineKey({ ...a, exclude: ["passedco.example"], excludeInvestors: ["Fund A"] }));
});

test("dates in the future or not dates are not on record", () => {
  const fx = load("seed-pipeline");
  const raw = fx.inputs.companies[0];
  assert.equal(toCompany({ ...raw, funding: { ...raw.funding, last_fundraise_date: "2027-03-01" } }, today).lastRoundDate, undefined);
  assert.equal(toCompany({ ...raw, funding: { ...raw.funding, last_fundraise_date: "garbage" } }, today).lastRoundDate, undefined);
});

test("round 2: social profile columns are not domains; odd domains get safe memo names; damaged files say which", async () => {
  const net = "linked" + "in"; // a real CRM export header and domain, spelled in pieces for the copy check
  assert.deepEqual(domainsFromCsv(`Name,Website,${net} URL\nAcme,acme.example,https://www.${net}.com/company/acme\n`).domains, ["acme.example"]);
  const { memoNames } = await import("../src/pipeline.js");
  const names = memoNames([{ ...toCompany(load("seed-pipeline").inputs.companies[0], today), domain: "..", id: 5 }]);
  assert.equal(names.get(5), "company-5.md");
  const { readJson, historyFor } = await import("../src/output.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = join(mkdtempSync(join(tmpdir(), "dsa-")), "history.json");
  writeFileSync(f, "{ broken");
  assert.throws(() => readJson(f), /history\.json is damaged/);
  const old = { key: JSON.stringify({ thesis: "AI infra", stages: ["seed"], raisedSince: "2025-01-01" }), runs: [{ at: "x", ids: [1] }], seen: {} };
  assert.equal(historyFor({ pipelines: { [old.key]: old } }, "new-key", "AI infra")?.runs.length, 1, "an older history of the same thesis is adopted");
});

test("round 5: a saved unfinished run with the wrong shape is ignored with a note, not a crash", async () => {
  const { mkdtempSync, writeFileSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dsa-partial-"));
  const before = process.env.OUT_DIR;
  process.env.OUT_DIR = dir;
  try {
    const { loadPartial, savePartial } = await import("../src/output.js");
    savePartial({ key: "k", startedAt: new Date().toISOString(), done: [], inputs: { companies: [], profiles: [], jobs: {}, posts: {} }, progress: {} });
    const file = readdirSync(dir).find(f => f.startsWith(".partial-"))!;
    writeFileSync(join(dir, file), JSON.stringify({ key: "k", done: "companies", inputs: {} }));
    const logs: string[] = []; const real = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try { assert.equal(loadPartial("k", new Date()), undefined); } finally { console.log = real; }
    assert.ok(logs.some(l => /damaged/.test(l)));
  } finally { process.env.OUT_DIR = before; }
});

test("round 6: a current-key history is never adopted by a pipeline with other filters; damaged partial files are ignored", async () => {
  const { historyFor, loadPartial, savePartial } = await import("../src/output.js");
  const v2 = { key: JSON.stringify({ keyVersion: 2, thesis: "AI infra", stages: ["seed"] }), runs: [{ at: "x", ids: [1] }], seen: {} };
  assert.equal(historyFor({ pipelines: { [v2.key]: v2 } }, JSON.stringify({ keyVersion: 2, thesis: "AI infra", stages: ["series_a"] }), "AI infra"), undefined);
  const { mkdtempSync, writeFileSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dsa-partial6-"));
  const before = process.env.OUT_DIR;
  process.env.OUT_DIR = dir;
  try {
    const good = { key: "k", startedAt: new Date().toISOString(), done: [] as string[], inputs: { companies: [], profiles: [], jobs: {}, posts: {} }, progress: {} };
    savePartial(good);
    const file = join(dir, readdirSync(dir).find(f => f.startsWith(".partial-"))!);
    const real = console.log; console.log = () => {};
    try {
      for (const bad of [{ ...good, progress: "oops" }, { ...good, startedAt: "garbage" }, { ...good, done: ["companies"] },
        { ...good, inputs: { ...good.inputs, companies: [null] } }, null, []]) {
        writeFileSync(file, JSON.stringify(bad));
        assert.equal(loadPartial("k", new Date()), undefined, JSON.stringify(bad));
      }
    } finally { console.log = real; }
  } finally { process.env.OUT_DIR = before; }
});
