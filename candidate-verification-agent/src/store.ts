/**
 * Files on disk, all under OUT_DIR (default out/), owner-only because they hold data about real people:
 *
 *   out/checked.json             every result, by profile URL, so a person on two lists is paid for once
 *                                (a result is reused for REUSE_VERDICTS_DAYS days)
 *   out/<list>/state.json        this list's progress: email lookups, profile details, submitted job ids. A run
 *                                that stops (network, Ctrl+C, credits) picks up here and never pays twice.
 *   out/<list>/verified.csv      the list back, with the new columns, doubtful first
 *   out/<list>/report.md         the readable report
 *   out/<list>/unresolved.csv    rows that could not be checked, with the reason, to fix and run again
 *   out/<list>/results.json      every result in full (reasoning, flags, coverage, sources)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import type { BatchJob, MatchResult, PersonData, VerifyRecord } from "./crustdata.js";
import type { Result } from "./verdict.js";

export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { throw new Error(`${path} is damaged (not valid JSON). Move it away and run again; the files next to it are kept.`); }
}

/** A folder name for a list: the file name without extension, in safe characters. */
export function listName(inputPath: string): string {
  const base = basename(inputPath, extname(inputPath)).normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "").toLowerCase();
  return base.slice(0, 80) || "candidates";
}

// ---------------------------------------------------------------------------
// The shared result cache
// ---------------------------------------------------------------------------

export type Cache = Record<string, Result>;

export const cachePath = (outDir: string) => join(outDir, "checked.json");
export const loadCache = (outDir: string): Cache => readJson<Cache>(cachePath(outDir), {});

/** Merges into the file on disk (another list may have been checked meanwhile), then writes. */
export function saveResults(outDir: string, results: Result[]): void {
  if (!results.length) return;
  const cache = loadCache(outDir);
  for (const r of results) cache[r.profileUrl] = r;
  writeFileAtomic(cachePath(outDir), JSON.stringify(cache, null, 1));
}

/**
 * A cached result that can stand in for a new check: younger than `days`, and at least as strong as asked for (a
 * full result serves a quick run; a quick result never serves a full run). Results with no verdict are never reused.
 */
export function reusable(r: Result | undefined, wantFull: boolean, days: number, now = Date.now()): boolean {
  if (!r || days <= 0 || r.check === "none") return false;
  if (wantFull && r.check !== "full") return false;
  const age = now - Date.parse(r.checkedAt);
  return Number.isFinite(age) && age >= 0 && age < days * 86_400_000;
}

// ---------------------------------------------------------------------------
// Per-list progress
// ---------------------------------------------------------------------------

export type JobState = {
  batchId: string;
  urls: string[];
  submittedAt: string;
  status: BatchJob["status"];
  /** Set once the results file was read and every person in it saved. */
  done?: boolean;
  /** A failed job is not charged; it is sent again once. */
  retried?: boolean;
  error?: string;
  /** How many records in the results file matched no profile URL sent (left out, counted). */
  unmatched?: number;
  /** When status requests answered 404 (two, two minutes apart, mean the job is gone). */
  notFound?: string[];
  /** Polls that returned a status this version does not know. */
  unknownPolls?: number;
  /** Fingerprint of the API key the job was sent with. */
  key?: string;
  /** Runs in which the finished job's results were not complete yet. */
  shortRuns?: number;
  /** Set when some billed verdicts could never be read (reported with the batch id). */
  unreadable?: boolean;
};

/** A submission saved before it is sent; removed once its job id is known. */
export type PendingSubmit = { urls: string[]; at: string };

export type ListState = {
  version: 1;
  input: string;
  /** Email to the identify answer (or a reason it was not used). */
  identified: Record<string, MatchResult>;
  /** Profile URL to its enrich answer: person data, or null when Crustdata has no such profile. */
  enriched: Record<string, PersonData | null>;
  /** Profile URL to its full-check record, or null when the job returned no verdict for it (not charged). */
  verified: Record<string, VerifyRecord | null>;
  jobs: JobState[];
  /** Submissions sent (or being sent) whose job id is not known yet. Never sent again without checking Crustdata. */
  pending: PendingSubmit[];
  /** When each profile's details and verdict were fetched, so old progress is not reused as if it were new. */
  checkedAt: Record<string, string>;
  /** People removed with npm run forget while their job was running or pending: their results are dropped. */
  forgotten: string[];
};

export const listDir = (outDir: string, name: string) => join(outDir, name);
const statePath = (dir: string) => join(dir, "state.json");

export function loadState(dir: string, input: string, maxAgeDays = Infinity, now = Date.now()): ListState {
  const s = readJson<Partial<ListState> | null>(statePath(dir), null);
  if (!s) return { version: 1, input, identified: {}, enriched: {}, verified: {}, jobs: [], pending: [], checkedAt: {}, forgotten: [] };
  // A state file this version cannot read is never replaced: it may hold running jobs that were paid for.
  if (s.version !== 1 || !Array.isArray(s.jobs) || typeof s.enriched !== "object" || typeof s.identified !== "object" || (s.pending !== undefined && !Array.isArray(s.pending))) {
    throw new Error(`${statePath(dir)} is from another version of this tool or was edited, and holds job ids that may have been paid for. Move it away only if you are sure no job is running for this list, then run again.`);
  }
  const state: ListState = { version: 1, input, identified: s.identified ?? {}, enriched: s.enriched ?? {}, verified: s.verified ?? {}, jobs: s.jobs, pending: s.pending ?? [], checkedAt: s.checkedAt ?? {}, forgotten: Array.isArray(s.forgotten) ? s.forgotten : [] };
  // Progress older than the reuse period is checked again (a file name like "candidates.csv" comes back months
  // later). Running jobs and pending submissions are never dropped: they may be paid for.
  // This list's own progress is kept at least 30 days, whatever REUSE_VERDICTS_DAYS says (that setting is about
  // reuse across lists): resuming a list, collecting its jobs or rerunning it after fixing rows never pays again.
  const keepDays = Math.max(maxAgeDays, 30);
  const old = (u: string) => { const t = Date.parse(state.checkedAt[u] ?? ""); return !(t > now - keepDays * 86_400_000); };
  for (const u of Object.keys(state.verified)) if (old(u)) { delete state.verified[u]; delete state.enriched[u]; delete state.checkedAt[u]; }
  for (const u of Object.keys(state.enriched)) if (old(u)) { delete state.enriched[u]; delete state.checkedAt[u]; }
  return state;
}

/** Every job id and every URL still running or pending in any list under OUT_DIR, with the list it belongs to. */
export function jobsOnThisMachine(outDir: string): { ids: Set<string>; inflight: Map<string, string>; inflightPeople: Map<number, { list: string; url: string }> } {
  const ids = new Set<string>(), inflight = new Map<string, string>(), inflightPeople = new Map<number, { list: string; url: string }>();
  if (!existsSync(outDir)) return { ids, inflight, inflightPeople };
  for (const name of readdirSync(outDir)) {
    const s = readJson<Partial<ListState> | null>(statePath(join(outDir, name)), null);
    if (!s || !Array.isArray(s.jobs)) continue;
    const add = (u: string) => {
      inflight.set(u, name);
      // The same person under another URL spelling is the same running job: keyed by Crustdata's person id too.
      const id = s.enriched?.[u]?.crustdata_person_id;
      if (id) inflightPeople.set(id, { list: name, url: u });
    };
    for (const j of s.jobs) { ids.add(j.batchId); if (!j.done) j.urls.forEach(add); }
    for (const p of s.pending ?? []) p.urls.forEach(add);
  }
  return { ids, inflight, inflightPeople };
}

export const saveState = (dir: string, s: ListState): void => writeFileAtomic(statePath(dir), JSON.stringify(s, null, 1));

// ---------------------------------------------------------------------------
// One run at a time per output folder
// ---------------------------------------------------------------------------

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * Takes out/.lock. Another live run holding it stops this one. A lock left by a run that died is taken over under
 * a second lock (`.lock.takeover`, created exclusively), and only if it still names the dead run, so two runs
 * taking over at once cannot both win.
 */
export function lock(outDir: string): () => void {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const path = join(outDir, ".lock");
  const guard = `${path}.takeover`;
  const mine = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  const holder = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } };
  const deadHolder = (held: string | undefined) => { const pid = Number(held?.split(":")[0]); return !pid || (pid !== process.pid && !alive(pid)); };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(path, mine, { flag: "wx", mode: 0o600 });
      const release = () => { process.off("exit", release); if (holder(path) === mine) rmSync(path, { force: true }); };
      process.on("exit", release);
      return release;
    } catch {
      const held = holder(path);
      if (held === undefined) continue;
      if (!deadHolder(held)) throw new Error(`Another run is using ${outDir} (process ${held.split(":")[0]}). Wait for it to finish, or stop it, then run again.`);
      // The guard itself may be left by a run that died mid-takeover.
      if (existsSync(guard) && deadHolder(holder(guard))) rmSync(guard, { force: true });
      try {
        writeFileSync(guard, mine, { flag: "wx", mode: 0o600 });
        try { if (holder(path) === held) rmSync(path, { force: true }); }
        finally { rmSync(guard, { force: true }); }
      } catch { /* another run is taking over: try again */ }
    }
  }
  throw new Error(`Could not take the lock file ${path}. If no other run is going, delete it and run again.`);
}

// ---------------------------------------------------------------------------
// Run log: who ran what, when, for how many credits (out/runs.csv). No candidate data.
// ---------------------------------------------------------------------------

export const whoRan = (): string => { try { return userInfo().username; } catch { return process.env.USER ?? "unknown"; } };

export function appendRunLog(outDir: string, run: { at: string; user: string; file: string; list: string; check: string; candidates: number; credits: number }): void {
  const path = join(outDir, "runs.csv");
  const cell = (v: unknown) => { let t = String(v); if (/^[=+\-@\t\r]/.test(t) && !/^-?\d/.test(t)) t = `'${t}`; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  if (!existsSync(path)) writeFileSync(path, "at,user,file,list,check,candidates,credits\n", { mode: 0o600 });
  appendFileSync(path, [run.at, run.user, basename(run.file), run.list, run.check, run.candidates, run.credits].map(cell).join(",") + "\n");
}

// ---------------------------------------------------------------------------
// Forgotten people: one-way fingerprints only, so a file that still lists them never checks them again
// ---------------------------------------------------------------------------

export const fingerprint = (id: string): string => createHash("sha256").update(id.trim().toLowerCase()).digest("hex");
const forgottenPath = (outDir: string) => join(outDir, "forgotten.json");
/** Groups of fingerprints: one group per forget (a person's email and profile URLs together). */
type Forgotten = { groups: string[][] };
function readForgotten(outDir: string): Forgotten {
  const raw = readJson<string[] | Forgotten>(forgottenPath(outDir), { groups: [] });
  return Array.isArray(raw) ? { groups: raw.map(f => [f]) } : { groups: raw.groups ?? [] };
}
export const loadForgotten = (outDir: string): Set<string> => new Set(readForgotten(outDir).groups.flat());
export function addForgotten(outDir: string, ids: string[]): void {
  const f = readForgotten(outDir);
  f.groups.push([...new Set(ids.map(fingerprint))]);
  writeFileAtomic(forgottenPath(outDir), JSON.stringify(f, null, 1));
}
/** Removes every group that holds this profile URL or email; true when one was found. */
export function undoForgotten(outDir: string, id: string): boolean {
  const f = readForgotten(outDir), fp = fingerprint(id);
  const keep = f.groups.filter(g => !g.includes(fp));
  if (keep.length === f.groups.length) return false;
  writeFileAtomic(forgottenPath(outDir), JSON.stringify({ groups: keep }, null, 1));
  return true;
}
