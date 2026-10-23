/**
 * Writing a run to disk: data.json (everything, so memos re-render for free), pipeline.csv, founders.csv,
 * pipeline.md and one memo per company. A memo whose company left the pipeline moves to memos/gone/, never deleted,
 * and only memos this tool wrote are ever moved. A run in progress is saved to .partial-<id>.json after every paid
 * batch, so a failure halfway does not pay twice. Files are written to a temporary name and renamed into place, so a
 * run killed mid-write never leaves a half-written file.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, paths } from "./config.js";
import { writeCsv } from "./csv.js";
import { renderIndex, renderMemo } from "./memo.js";
import { FOUNDERS_HEADER, PIPELINE_HEADER, founderRows, memoFile, pipelineRows, type Gone, type History, type HistoryFile, type Inputs } from "./pipeline.js";
import type { Deal } from "./types.js";

export type SavedData = { thesis: string; retrieved: string; savedAt: string; deals: Deal[]; gone: Gone[]; samePipeline: boolean };

/** Writes a file atomically: a temporary file, then a rename. */
export function writeAtomic(file: string, text: string, mode?: number) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  renameSync(tmp, file);
}

/** Reads a JSON file. A damaged file names itself in the error, so you know which one to delete or restore. */
export function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")) as T; }
  catch (err) { throw new Error(`${file} is damaged (${(err as Error).message}). Restore it from a backup, or delete it to start that file over.`); }
}

export const loadData = (): SavedData | undefined => readJson<SavedData>(paths.data());

/** Every pipeline's history. An older history.json with a single pipeline is kept under its thesis, see `historyFor`. */
export function loadHistory(): HistoryFile {
  const file = readJson<HistoryFile & Partial<History>>(paths.history());
  if (!file) return { pipelines: {} };
  if (!file.pipelines && file.key) return { pipelines: { [file.key]: file as History } };
  return { pipelines: file.pipelines ?? {} };
}

/**
 * The history for this pipeline key. A history saved under an older key for the same thesis sentence (written before
 * the key changed shape) is adopted, so upgrading the tool does not reset what is new and what is gone.
 */
export function historyFor(file: HistoryFile, key: string, thesis: string): History | undefined {
  if (file.pipelines[key]) return file.pipelines[key];
  // Only keys from before key version 2: a current key for the same sentence with other filters is another pipeline.
  const same = Object.values(file.pipelines).filter(h => { try { const k = JSON.parse(h.key); return k.thesis === thesis && (k.keyVersion ?? 1) < 2; } catch { return false; } });
  return same.length === 1 ? { ...same[0], key } : undefined;
}

export function saveData(data: SavedData) {
  mkdirSync(paths.memos(), { recursive: true });
  writeAtomic(paths.data(), JSON.stringify(data, null, 1) + "\n");
}

export function writeMemo(d: Deal, retrieved: string): string {
  mkdirSync(paths.memos(), { recursive: true });
  const file = join(paths.memos(), memoFile(d));
  writeAtomic(file, renderMemo(d, retrieved));
  return file;
}

/**
 * Writes every output. `previous` is the last saved run: memos of its companies that are not in this run move to
 * memos/gone/ (decided by company, not by file name; an older memo of the same name there gets a date).
 */
export function writeAll(data: SavedData, history?: { file: HistoryFile; current: History }, previous?: SavedData) {
  const now = new Set(data.deals.map(d => d.company.id));
  const keep = new Set(data.deals.map(memoFile));
  for (const old of previous?.deals ?? []) {
    const name = memoFile(old), from = join(paths.memos(), name);
    if (now.has(old.company.id) || keep.has(name) || !existsSync(from)) continue;
    const goneDir = join(paths.memos(), "gone");
    mkdirSync(goneDir, { recursive: true });
    const to = existsSync(join(goneDir, name)) ? join(goneDir, name.replace(/\.md$/, `-${data.retrieved}.md`)) : join(goneDir, name);
    renameSync(from, to);
  }
  saveData(data);
  writeCsv(paths.pipelineCsv(), PIPELINE_HEADER, pipelineRows(data.deals));
  writeCsv(paths.foundersCsv(), FOUNDERS_HEADER, founderRows(data.deals));
  for (const d of data.deals) writeMemo(d, data.retrieved);
  writeAtomic(paths.pipelineMd(), renderIndex(data.deals, data.gone, data.thesis, data.retrieved, data.samePipeline));
  if (history) {
    const file: HistoryFile = { pipelines: { ...history.file.pipelines, [history.current.key]: history.current } };
    writeAtomic(paths.history(), JSON.stringify(file, null, 1) + "\n");
  }
}

// ---------------------------------------------------------------------------
// A run in progress: one file per run key, so a second thesis in the same folder never overwrites it.
// ---------------------------------------------------------------------------

/** `progress` lists, per paid step, the company ids already paid for, so a resumed step skips them. */
export type PartialRun = { key: string; startedAt: string; done: string[]; inputs: Inputs; progress: { [step: string]: number[] } };
const partialPath = (key: string) => join(config.outDir, `.partial-${createHash("sha256").update(key).digest("hex").slice(0, 12)}.json`);
/** A saved partial run is used for this long; after that the data would be too old to mix with a fresh search. */
const PARTIAL_HOURS = 24;

export function loadPartial(key: string, now: Date): PartialRun | undefined {
  let p: PartialRun | undefined;
  try { p = readJson<PartialRun>(partialPath(key)); }
  catch { console.log(`Note: the saved unfinished run in ${config.outDir} is damaged, so this run starts from the beginning.`); return undefined; }
  if (p === undefined) return undefined;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(p)) { console.log(`Note: the saved unfinished run in ${config.outDir} is damaged, so this run starts from the beginning.`); return undefined; }
  if (p.key !== key) return undefined;
  const i = p.inputs as Partial<Inputs> | undefined;
  const ids = (v: unknown) => Array.isArray(v) && v.every(n => typeof n === "number");
  const ok = typeof p.startedAt === "string" && !Number.isNaN(Date.parse(p.startedAt))
    && Array.isArray(p.done) && p.done.every(d => typeof d === "string")
    && isObj(i) && Array.isArray(i.companies) && i.companies.every(c => isObj(c) && typeof c.crustdata_company_id === "number")
    && Array.isArray(i.profiles) && i.profiles.every(x => isObj(x) && typeof x.crustdata_person_id === "number")
    && isObj(i.jobs) && isObj(i.posts)
    && (p.progress === undefined || (isObj(p.progress) && Object.values(p.progress).every(ids)))
    && (!p.done.includes("companies") || i.companies.length > 0);
  if (!ok) { console.log(`Note: the saved unfinished run in ${config.outDir} is damaged, so this run starts from the beginning.`); return undefined; }
  if (now.getTime() - Date.parse(p.startedAt) > PARTIAL_HOURS * 3_600_000) {
    console.log(`Note: an unfinished run of this thesis from ${p.startedAt.slice(0, 10)} is over ${PARTIAL_HOURS} hours old, so this run starts fresh.`);
    return undefined;
  }
  return { ...p, progress: p.progress ?? {} };
}
export function savePartial(p: PartialRun) {
  mkdirSync(config.outDir, { recursive: true });
  writeAtomic(partialPath(p.key), JSON.stringify(p) + "\n");
}
export function clearPartial(key: string) {
  if (existsSync(partialPath(key))) rmSync(partialPath(key));
}
