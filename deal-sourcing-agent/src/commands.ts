/** npm run memo (re-render one memo from saved data) and npm run replay (the whole pipeline on a saved sample, offline). */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config, paths } from "./config.js";
import { aiProvider, analyse } from "./ai.js";
import { renderMemo } from "./memo.js";
import { buildPipeline, updateHistory, type History, type Inputs } from "./pipeline.js";
import { loadData, saveData, writeAll, writeMemo } from "./output.js";
import { mergeSpec, parseFlags, parseSentence, pipelineKey, resolveDates } from "./thesis.js";

export async function runMemo(argv: string[]): Promise<void> {
  const ai = argv.includes("--ai");
  const outAt = argv.indexOf("--out");
  if (outAt >= 0) {
    const dir = argv[outAt + 1];
    if (!dir || dir.startsWith("--")) throw new Error("--out needs a folder, for example --out out/replay/seed-pipeline.");
    process.env.OUT_DIR = dir;
  }
  const target = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out")[0]?.toLowerCase();
  const data = loadData();
  if (!data) {
    const replays = existsSync(join("out", "replay")) ? readdirSync(join("out", "replay")) : [];
    throw new Error(`No saved pipeline in ${config.outDir}. Run npm run source -- --thesis "..." first.`
      + (replays.length ? ` For a replay, pass its folder: npm run memo -- relaywise.example --out out/replay/${replays[0]}` : ""));
  }
  if (!target) throw new Error(`Which company? npm run memo -- <domain>. In this pipeline: ${data.deals.slice(0, 5).map(d => d.company.domain).join(", ")}${data.deals.length > 5 ? ", ..." : ""}`);
  const matches = data.deals.filter(d => d.company.domain === target || d.company.name.toLowerCase() === target || String(d.company.id) === target);
  if (!matches.length) throw new Error(`"${target}" is not in the saved pipeline (${paths.pipelineCsv()}).`);
  if (matches.length > 1) throw new Error(`${matches.length} companies match "${target}". Pass the crustdata id instead: ${matches.map(d => `${d.company.id} (${d.company.name})`).join(", ")}`);
  const deal = matches[0];
  if (ai) {
    if (!aiProvider()) throw new Error("--ai needs ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.");
    deal.analysis = await analyse(deal, data.retrieved);
    saveData(data);
  }
  const file = writeMemo(deal, data.retrieved);
  console.log(renderMemo(deal, data.retrieved));
  console.log(`\nWritten to ${file}${ai ? "" : " (0 credits)"}`);
}

/**
 * A fixture holds a thesis, the raw API records a live run would have fetched, the role and post counts, and
 * optionally the history of an earlier run. Replay runs the same pure code as a live run and writes the outputs to
 * out/replay/<fixture>/ so you can open them. No key, no network.
 */
export type Fixture = { description?: string; today: string; thesis: string; flags?: string[]; inputs: Inputs; history?: History };

export async function runReplay(argv: string[]): Promise<void> {
  const file = argv.find(a => !a.startsWith("--"));
  if (!file) throw new Error("Which sample? npm run replay -- fixtures/seed-pipeline.json");
  if (!existsSync(file)) throw new Error(`${file} not found. The samples are in fixtures/.`);
  const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
  const now = new Date(fx.today + "T12:00:00Z");
  const { flags } = parseFlags(fx.flags ?? []);
  const spec = mergeSpec({ thesis: fx.thesis }, parseSentence(fx.thesis, now), flags);
  if (fx.description) console.log(fx.description + "\n");
  if (!fx.inputs.companies.length) { console.log("No companies in this sample: a live run would stop here and write nothing."); return; }
  process.env.OUT_DIR = join(config.outDir, "replay", basename(file, ".json"));
  mkdirSync(config.outDir, { recursive: true });
  const key = pipelineKey(spec);
  const previous = fx.history ? { ...fx.history, key } : undefined;
  const result = buildPipeline(fx.inputs, resolveDates(spec, now), now, previous);
  const { history, gone, samePipeline } = updateHistory(previous, key, result.deals, now);
  writeAll({ thesis: spec.thesis, retrieved: fx.today, savedAt: now.toISOString(), deals: result.deals, gone, samePipeline }, { file: { pipelines: {} }, current: history });
  for (const [i, d] of result.deals.entries()) console.log(`${i + 1}. ${d.company.name}: ${d.score.total}/100, ${d.score.timing.label}, ${d.status}${d.change ? ` (${d.change})` : ""}`);
  if (gone.length) console.log(`Gone since the last run: ${gone.map(g => g.name).join(", ")}`);
  if (result.droppedNoListFounder) console.log(`Left out by --only-founders-from: ${result.droppedNoListFounder}`);
  if (result.droppedExcludedInvestor) console.log(`Left out, backed by an excluded investor: ${result.droppedExcludedInvestor}`);
  if (result.deals[0]) console.log("\n" + renderMemo(result.deals[0], fx.today, { aiHint: !aiProvider() }));
  console.log(`Offline replay, nothing sent. Outputs in ${config.outDir}/ (open one memo: npm run memo -- ${result.deals[0]?.company.domain} --out ${config.outDir})`);
}
