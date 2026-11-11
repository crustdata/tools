/**
 * npm run verify -- candidates.csv
 *
 * Reads the list, finds each candidate's profile URL (looking up emails when there is none), fetches profile
 * details, runs the full check (batch verification, 10 people per job, up to 5 jobs at once) or the quick screen,
 * and writes the list back sorted so the doubtful candidates come first. Every step is saved as it finishes, so a
 * run that stops for any reason continues where it was on the next run and never pays twice.
 */

import { createInterface } from "node:readline/promises";
import { existsSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { aiAvailable, aiReport, aiSummaries } from "./ai.js";
import { config } from "./config.js";
import {
  CrustdataError, MAX_ACTIVE_JOBS, resolveLostSubmit, serverNow, type BatchJob, VERIFY_BATCH_SIZE, accountEndpoints, batchStatus, capabilities, clock, downloadResults,
  enrichPeople, fmtCredits, identifyEmails, spend, submitVerify, type Capabilities, type MatchResult,
  type VerifyRecord,
} from "./crustdata.js";
import { readCandidates, readTable, type Candidate } from "./input.js";
import { labelCounts, reportMarkdown, unresolvedCsv, verifiedCsv, type Row } from "./output.js";
import { normalizeProfileUrl } from "./profile-url.js";
import { connectedMessage, postToSlack, summaryMessage } from "./slack.js";
import { appendRunLog, fingerprint, jobsOnThisMachine, loadForgotten, listDir, listName, loadCache, loadState, lock, reusable, saveResults, saveState, whoRan, writeFileAtomic, type JobState, type ListState, type PendingSubmit } from "./store.js";
import { VERDICTS, enrichedPerson, labelFor, nameNote, namesDiffer, fullResult, quickResult, reviewOrder, sortForReview, summaryLine, verdictLabel, type Result } from "./verdict.js";

export const HELP = `npm run verify -- <file> [options]

  <file>              your candidate list: CSV or Excel (.xlsx), exported from Greenhouse, Lever, Ashby,
                      Workable or a spreadsheet. Each row needs a profile URL, or an email to look up.

  --dry-run           show what would be checked and what it costs; spends nothing
  --quick             the quick screen only: Crustdata's profile score and the date check, 1 credit per candidate
  --full              the full check only; stop if this key does not have it (default: full when available)
  --limit <n>         check only the first n candidates (try it on a few first)
  --ai                add a Claude-written summary per candidate and an overview (needs ANTHROPIC_API_KEY)
  --refresh           check everyone again, even people checked recently (costs again)
  --name <name>       the folder name under out/ (default: the file name)
  --sheet <name>      the sheet to read in an Excel file (default: the one with the most candidates)
  --wait <minutes>    how long to wait for running jobs before saving and stopping (default 30)
  --no-slack          do not post to Slack this time
  --yes               do not ask before spending (needed above CONFIRM_ABOVE_CREDITS without a terminal)`;

type Flags = {
  file?: string; dryRun: boolean; quick: boolean; full: boolean; limit?: number; ai: boolean; refresh: boolean;
  name?: string; sheet?: string; waitMinutes: number; slack: boolean; yes: boolean; help: boolean;
};

/** Options npm takes for itself when "--" is missing (npm run verify x.csv --dry-run): never run without them. */
const NPM_SWALLOWED = ["dry_run", "quick", "full", "yes", "refresh", "limit", "ai", "name", "wait", "slack"];

export function parseFlags(args: string[], env: NodeJS.ProcessEnv = process.env): Flags {
  // npm sets these (--no-slack sets npm_config_slack to an empty value) only when "--" is missing.
  const swallowed = NPM_SWALLOWED.filter(k => env[`npm_config_${k}`] !== undefined);
  if (swallowed.length) {
    const k = swallowed[0];
    const opt = k === "slack" ? "--no-slack" : `--${k.replace(/_/g, "-")}${["limit", "name", "wait"].includes(k) ? ` ${env[`npm_config_${k}`] || "<value>"}` : ""}`;
    const file = args.find(a => !a.startsWith("-")) ?? "candidates.csv";
    throw new Error(`npm took an option meant for this tool (${opt}). Put -- before your file, like this: npm run verify -- "${file}" ${opt}. Nothing was checked, spent or posted.`);
  }
  const f: Flags = { dryRun: false, quick: false, full: false, ai: false, refresh: false, waitMinutes: 30, slack: true, yes: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (name: string) => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value. See npm run verify -- --help`);
      return v;
    };
    const count = (name: string) => {
      const n = Number(value(name));
      if (!Number.isInteger(n) || n < 1) throw new Error(`${name} needs a whole number of 1 or more.`);
      return n;
    };
    switch (a) {
      case "--dry-run": f.dryRun = true; break;
      case "--quick": f.quick = true; break;
      case "--full": f.full = true; break;
      case "--limit": f.limit = count(a); break;
      case "--ai": f.ai = true; break;
      case "--refresh": f.refresh = true; break;
      case "--name": f.name = value(a); break;
      case "--sheet": f.sheet = value(a); break;
      case "--wait": f.waitMinutes = count(a); break;
      case "--no-slack": f.slack = false; break;
      case "--yes": case "-y": f.yes = true; break;
      case "--help": case "-h": f.help = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option ${a}. See npm run verify -- --help`);
        if (f.file) throw new Error(`One file at a time (got ${f.file} and ${a}). Put a path with spaces in quotes.`);
        f.file = a;
    }
  }
  if (f.quick && f.full) throw new Error("Pick one of --quick and --full.");
  return f;
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const log = (msg = "") => console.log(msg);

/** A single exact email match, or why the email was not used. Pure. */
export function resolveIdentify(r: MatchResult | undefined): { url?: string; problem?: string; name?: string } {
  if (!r) return { problem: "The email lookup did not answer for this email. Run again." };
  if (r.match_status === "invalid_email") return { problem: "Crustdata rejected this email as invalid." };
  const matches = (r.matches ?? []).filter(m => m.person_data);
  if (r.match_status !== "matched" || !matches.length) return { problem: "No profile found for this email. Add the candidate's profile URL to the row." };
  const exact = matches.filter(m => (m.confidence_score ?? 0) >= 1);
  if (exact.length !== 1) return { problem: exact.length ? "This email matches more than one profile. Add the right profile URL to the row." : "This email only loosely matches a profile, so it was not used (checking the wrong person is worse than skipping). Add the profile URL to the row." };
  const url = normalizeProfileUrl(exact[0].person_data?.social_handles?.professional_network_identifier?.profile_url);
  const name = exact[0].person_data?.basic_profile?.name ?? undefined;
  return url ? { url, name } : { problem: "The profile found for this email has no profile URL. Add it to the row." };
}

/**
 * Profile URLs that are the same Crustdata person as an earlier one (two spellings of a URL, or a URL and an
 * email), mapped to that earlier URL. Pure.
 */
export function samePeople(urls: string[], enriched: ListState["enriched"], reused: Map<string, Result>): Map<string, string> {
  const byId = new Map<number, string>();
  for (const [u, r] of reused) if (r.person?.personId) byId.set(r.person.personId, u);
  const sameAs = new Map<string, string>();
  for (const u of urls) {
    const id = enriched[u]?.crustdata_person_id;
    if (!id) continue;
    const first = byId.get(id);
    if (first && first !== u) sameAs.set(u, first);
    else byId.set(id, u);
  }
  return sameAs;
}

/** Credits before spending: email lookups, profile details, verdicts. Upper bounds (misses are free). Pure. */
export function estimate(n: { emails: number; enrich: number; verify: number }, verifyCredits: number) {
  return { emails: n.emails, enrich: n.enrich, verify: n.verify * verifyCredits, total: n.emails + n.enrich + n.verify * verifyCredits };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} (y/N): `)).trim()); }
  catch { return false; }
  finally { rl.close(); }
}

// ---------------------------------------------------------------------------
// The full check: batch jobs
// ---------------------------------------------------------------------------

export type VerifyProgress = {
  verified: Record<string, VerifyRecord | null>;
  jobs: JobState[];
  pending: PendingSubmit[];
  /** When each verdict arrived (the job's completion time). */
  checkedAt?: Record<string, string>;
  /** Verdicts read from jobs that finished during this run: what this run was billed for. */
  newVerdicts?: number;
  /** People removed with npm run forget: their records are dropped when their job is read. */
  forgotten?: Set<string>;
  /** People whose billed verdict could not be read, with the batch id to raise with Crustdata. */
  unreadable?: Map<string, string>;
};

export type JobsOutcome = { running: string[]; unsent: string[] };

const sameUrl = (a: string | undefined, b: string) => normalizeProfileUrl(a) === b;
/** Which API key a job was sent with: a short one-way fingerprint, never the key. */
const keyId = () => fingerprint(config.crustdataApiKey).slice(0, 12);

/**
 * Runs verification jobs for `urls` (and finishes any jobs saved in `progress`), at most 5 at a time and 5
 * submissions a minute, polling every 10 seconds. `save` is called after every change. Returns the URLs that are
 * still running, waiting, or held when the time is up; the next run picks them up.
 *
 * Billing rules (a job is billed when it finishes, 10 credits per verdict, so a second job for the same people pays
 * twice):
 * - Every submission is saved as `pending` before it is sent, so a run that stops mid-submit leaves a record.
 * - A submission whose answer is unclear (no answer, a timeout, a 5xx) is never sent again in the same run: its
 *   people are held. The next run asks Crustdata (`resolveLostSubmit`) whether that job exists before sending.
 * - Only a 429 (refused before it reached the API) is safe to send again at once.
 * `known` is every job id this machine already knows (all lists), so another list's job is never taken for ours.
 */
export async function runJobs(urls: string[], progress: VerifyProgress, save: () => void, opts: { waitMs: number; say: (msg: string) => void; known?: Set<string> }): Promise<JobsOutcome> {
  const known = new Set([...(opts.known ?? []), ...progress.jobs.map(j => j.batchId)]);
  const forgotten = progress.forgotten ?? new Set<string>();
  // 404s seen in this run (a 404 from an earlier run, or one followed by a good answer, does not count).
  const notFound = new Map<string, number[]>();
  const unknownPolls = new Map<string, number>();
  const allowed = new Set(urls);
  const queue: Array<{ urls: string[]; retried?: boolean }> = [];

  // 1. Submissions from earlier runs whose answer never came: find their job, or learn that sending again is safe.
  for (const p of [...progress.pending]) {
    const found = await resolveLostSubmit(p.urls, Date.parse(p.at), known, sameUrl);
    if (found === "unsure") { opts.say(`  ${plural(p.urls.length, "person", "people")} from an earlier submission whose answer was lost are held until Crustdata shows that job (run again in a few minutes). Nothing is sent twice.`); continue; }
    progress.pending = progress.pending.filter(x => x !== p);
    if (found === "absent") {
      // Safe to send again, but only the people this run is for (--limit, forget): the rest wait for their own run.
      const again = p.urls.filter(u => allowed.has(u) && !forgotten.has(u));
      if (again.length) queue.push({ urls: again });
    }
    else {
      known.add(found.job.batch_id);
      progress.jobs.push({ batchId: found.job.batch_id, urls: p.urls, submittedAt: p.at, status: found.job.status });
      opts.say(`  Found the job for an earlier submission whose answer was lost; it is read now, not sent again.`);
    }
    save();
  }

  const busy = new Set([...progress.jobs.filter(j => !j.done).flatMap(j => j.urls), ...progress.pending.flatMap(p => p.urls), ...queue.flatMap(q => q.urls)]);
  const fresh = urls.filter(u => !(u in progress.verified) && !busy.has(u));
  for (let i = 0; i < fresh.length; i += VERIFY_BATCH_SIZE) queue.push({ urls: fresh.slice(i, i + VERIFY_BATCH_SIZE) });
  const submits: number[] = [];
  const started = clock.now();
  const stuck = new Set<string>();
  let held = false;
  let cooldownUntil = 0;
  let pollErrors = 0;
  let total = queue.length + progress.jobs.filter(j => !j.done).length;
  let finished = 0;
  if (total) opts.say(`Full check: ${plural(total, "job")} of up to ${VERIFY_BATCH_SIZE} people (at most ${MAX_ACTIVE_JOBS} at once; each usually takes a minute or two).`);

  const active = () => progress.jobs.filter(j => !j.done && !stuck.has(j.batchId));
  while ((queue.length && !held) || active().length) {
    // 2. Submit while there is room: 5 active jobs, 5 submissions in any minute.
    while (!held && queue.length && clock.now() >= cooldownUntil && active().length < MAX_ACTIVE_JOBS && submits.filter(t => clock.now() - t < 60_000).length < 5) {
      const { urls: batch, retried } = queue[0];
      const at = clock.now();
      // Saved in Crustdata's time, so the next run can match it to the job's created_at whatever the local clock says.
      const intent: PendingSubmit = { urls: batch, at: new Date(serverNow()).toISOString() };
      progress.pending.push(intent);
      save();
      let job: BatchJob;
      try {
        job = await submitVerify(batch);
      } catch (err) {
        if (err instanceof CrustdataError && err.status === 429) {
          // Refused before it reached the API: safe to send later. All job slots in use: wait a minute, not 10 seconds.
          progress.pending = progress.pending.filter(x => x !== intent); save();
          cooldownUntil = clock.now() + (/active/i.test(err.apiMessage) ? 60_000 : 10_000);
          break;
        }
        if (err instanceof CrustdataError && err.status > 0 && err.status < 500) { progress.pending = progress.pending.filter(x => x !== intent); save(); throw err; }
        // The answer was lost: the job may exist. Its people stay pending and nothing more is sent this run.
        queue.shift();
        held = true;
        opts.say(`  A submission's answer was lost (${(err as Error).message.slice(0, 120)}). To avoid paying twice, its ${plural(batch.length, "person", "people")} and the rest of the list are held: run the same command again in a few minutes.`);
        continue;
      }
      queue.shift();
      submits.push(at);
      known.add(job.batch_id);
      progress.pending = progress.pending.filter(x => x !== intent);
      progress.jobs.push({ batchId: job.batch_id, urls: batch, submittedAt: intent.at, status: job.status, key: keyId(), ...(retried ? { retried } : {}) });
      save();
    }

    if (clock.now() - started > opts.waitMs) break;
    await clock.sleep(10_000);
    if (!active().length) continue;

    // 3. Poll the running jobs.
    for (const job of active()) {
      let status: BatchJob;
      try { status = await batchStatus(job.batchId); pollErrors = 0; notFound.delete(job.batchId); job.notFound = undefined; }
      catch (err) {
        if (err instanceof CrustdataError && err.status === 404) {
          // One 404 can be a moment's lag right after the submit. Two, two minutes apart: not on this account, never
          // billed, and its people are sent again on the next run.
          const seen = [...(notFound.get(job.batchId) ?? []), clock.now()];
          notFound.set(job.batchId, seen);
          // A job made with another API key answers 404 to this one: never give it up then (the other account paid).
          if (job.key && job.key !== keyId()) { stuck.add(job.batchId); opts.say(`  Job ${job.batchId} was sent with another Crustdata API key, so this key cannot see it. Run with the key it was sent with to collect it.`); continue; }
          if (seen.length >= 2 && seen.at(-1)! - seen[0] >= 120_000) {
            job.done = true; job.error = "The job could not be found on Crustdata";
            opts.say(`  A job could not be found on Crustdata; its ${plural(job.urls.length, "person", "people")} will be sent again on the next run.`);
          }
          save(); continue;
        }
        // A short outage: try again next round; after six failures in a row, stop polling and keep everything.
        if (++pollErrors >= 6) { opts.say(`  Crustdata did not answer job status requests (${(err as Error).message.slice(0, 120)}). The jobs are kept; run again later to collect them (batch ${active().map(j => j.batchId).join(", ")}).`); for (const j of active()) stuck.add(j.batchId); }
        continue;
      }
      job.status = status.status;
      if (status.status !== "completed" && status.status !== "failed" && status.status !== "pending" && status.status !== "processing") {
        unknownPolls.set(job.batchId, (unknownPolls.get(job.batchId) ?? 0) + 1);
        if (unknownPolls.get(job.batchId)! > 30) { stuck.add(job.batchId); opts.say(`  Job ${job.batchId} reports the status "${status.status}", which this version does not know. It is kept and checked again on the next run.`); save(); }
        continue;
      }
      if (status.status === "completed") {
        // One merged file; or, when only the parts are given, every part. Read whenever a link is given.
        const links = status.download_url ? [status.download_url] : status.download_urls ?? [];
        const records: VerifyRecord[] = [];
        let badLines = 0;
        try {
          for (const link of links) {
            const part = await downloadResults(link);
            records.push(...part.records);
            badLines += part.badLines;
          }
        } catch (err) {
          records.length = 0;
          job.error = (err as Error).message.slice(0, 200);
        }
        // Verdicts were billed but not all are readable yet (no link, an empty, short or damaged file): keep the job
        // and read it again later; never mark these people "no verdict", never send them again. After 3 runs and 2
        // days the readable part is used, and the rest is reported with the batch id to raise with Crustdata.
        const short = (status.result_count ?? 0) > records.length || ((status.result_count ?? 0) > 0 && !links.length) || (job.error && !records.length && (status.result_count ?? 0) > 0);
        const since = Date.parse(status.completed_at ?? job.submittedAt);
        const giveUp = (job.shortRuns ?? 0) >= 3 && clock.now() - since > 2 * 86_400_000;
        if (short && !giveUp) {
          if (!stuck.has(job.batchId)) job.shortRuns = (job.shortRuns ?? 0) + 1;
          stuck.add(job.batchId);
          job.error ??= `results not complete yet (${records.length} of ${status.result_count} read)`;
          opts.say(`  Job ${job.batchId} finished, but its results are not complete yet (${records.length} of ${status.result_count} read). It is kept and read again on the next run.`);
          save(); continue;
        }
        if (short) { job.unreadable = true; opts.say(`  Job ${job.batchId}: ${plural((status.result_count ?? 0) - records.length, "verdict")} could not be read after several tries. They may have been billed: contact Crustdata support with this batch id.`); }
        if (badLines) opts.say(`  ${plural(badLines, "line")} in a results file could not be read and were skipped.`);
        const got: Record<string, VerifyRecord> = {};
        const unmatched: VerifyRecord[] = [];
        for (const rec of records) {
          // A forgotten person's record is dropped before anything else, so it can never be given to someone else.
          if ([...forgotten].some(f => sameUrl(rec.original_identifier, f))) continue;
          const url = job.urls.find(u => sameUrl(rec.original_identifier, u));
          if (url) got[url] = rec; else unmatched.push(rec);
        }
        // One record that did not match and one person without a record belong together, but only in a job whose
        // people are exactly the ones sent.
        const left = job.urls.filter(u => !got[u] && !forgotten.has(u));
        const intact = status.identifier_count === undefined || status.identifier_count === job.urls.length;
        const hasForgotten = job.urls.some(u => forgotten.has(u));
        if (intact && !hasForgotten && unmatched.length === 1 && left.length === 1) { got[left[0]] = unmatched[0]; unmatched.length = 0; }
        if (unmatched.length) { job.unmatched = unmatched.length; opts.say(`  ${plural(unmatched.length, "verdict")} in a results file did not match a profile URL that was sent; left out.`); }
        for (const u of job.urls) {
          if (forgotten.has(u)) continue;
          progress.verified[u] = got[u] ?? null;
          if (progress.checkedAt) progress.checkedAt[u] = status.completed_at ?? new Date(clock.now()).toISOString();
        }
        // Billed for every record in the file, including a forgotten person's (dropped) and unmatched ones.
        progress.newVerdicts = (progress.newVerdicts ?? 0) + Math.max(records.length, status.result_count ?? 0);
        if (job.unreadable) for (const u of job.urls) if (!got[u] && !forgotten.has(u)) (progress.unreadable ??= new Map()).set(u, job.batchId);
        // The job is read: a forgotten person's record is gone, so they leave the job and the forgotten list.
        if (hasForgotten) {
          job.urls = job.urls.filter(u => !forgotten.has(u));
          const stillOut = new Set([...progress.jobs.filter(j => !j.done && j !== job).flatMap(j => j.urls), ...progress.pending.flatMap(p => p.urls)]);
          for (const u of [...forgotten]) if (!stillOut.has(u)) forgotten.delete(u);
        }
        job.done = true;
        finished++;
        opts.say(`  Job ${finished} of ${total} done: ${plural(Object.keys(got).length, "verdict")} for ${plural(job.urls.length, "person", "people")}.`);
        save();
      } else if (status.status === "failed") {
        job.done = true;
        job.error = status.error_message ?? "failed";
        // A failed job is not charged: send its people once more.
        if (!job.retried) {
          const again = job.urls.filter(u => !forgotten.has(u));
          if (again.length) queue.push({ urls: again, retried: true });
          total++;
          opts.say(`  A job failed (${job.error}); its people are sent again (failed jobs are not charged).`);
        } else {
          for (const u of job.urls) progress.verified[u] ??= null;
          opts.say(`  A job failed twice (${job.error}); its people are marked not checked.`);
        }
        save();
      }
    }
  }
  // Forgotten people leave finished jobs (and the forgotten list) once nothing for them is in flight.
  const inFlight = new Set([...progress.jobs.filter(j => !j.done).flatMap(j => j.urls), ...progress.pending.flatMap(p => p.urls)]);
  for (const u of [...forgotten]) if (!inFlight.has(u)) {
    forgotten.delete(u);
    for (const j of progress.jobs) if (j.done) j.urls = j.urls.filter(x => x !== u);
    delete progress.verified[u];
  }
  // Still running, held, or not sent yet when the time ran out: the next run picks them up.
  return {
    running: [...progress.jobs.filter(j => !j.done).flatMap(j => j.urls), ...progress.pending.flatMap(p => p.urls)].filter(u => !forgotten.has(u)),
    unsent: queue.flatMap(q => q.urls),
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runVerify(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  if (flags.help) { log(HELP); return; }
  if (!flags.file) throw new Error(`Pass your candidate list: npm run verify -- candidates.csv\n\n${HELP}`);
  config.crustdataApiKey; // a clear message before anything else when the key is missing

  // 1. Read the list.
  const table = readTable(flags.file, flags.sheet);
  const list = readCandidates(table);
  const name = flags.name ? listName(flags.name) : listName(flags.file);
  const dir = listDir(config.outDir, name);
  let candidates = list.candidates;
  if (flags.limit) candidates = candidates.slice(0, flags.limit);
  log(`${flags.file}: ${plural(table.rows.length, "row")}, ${plural(list.candidates.length, "candidate")}${list.duplicates.length ? `; ${plural(list.duplicates.length, "row")} ${list.duplicates.length === 1 ? "repeats" : "repeat"} a candidate (line ${list.duplicates.slice(0, 8).map(d => `${d.line} repeats ${d.of}`).join(", ")}${list.duplicates.length > 8 ? ", ..." : ""}) and ${list.duplicates.length === 1 ? "gets" : "get"} the same verdict` : ""}${flags.limit ? `; checking the first ${candidates.length} (--limit)` : ""}.`);
  if (table.sheet && table.sheet.names.length > 1) log(`  Read the sheet "${table.sheet.name}" (${table.sheet.index + 1} of ${table.sheet.names.length}: ${table.sheet.names.join(", ")}).`);
  if (table.headerLine) log(`  Column names found on line ${table.headerLine}; the lines above it were skipped.`);
  if (table.noKnownHeaders) log(`  No column names were recognised in line 1 (found: ${table.headers.slice(0, 6).map(h => `"${h}"`).join(", ")}). If your column names are on a later line, delete the lines above them and run again.`);
  const c = list.columns;
  log(`  Profile URLs from ${c.profileUrl ? `the "${c.profileUrl}" column` : "any cell that holds one"}${c.profileUrl && c.scanned ? " (and other cells where that one was empty)" : ""}${c.email ? `; emails from "${c.email}"` : ""}${c.name ? `; names from "${c.name}"` : ""}.`);
  if (!candidates.some(x => x.profileUrl || x.email)) {
    throw new Error(`No row has a profile URL or an email, so there is nothing to check. Columns found: ${table.headers.join(", ") || "none"}.\nAdd a column with each candidate's profile URL (for example https://www.linkedin.com/in/jane-doe) or their email.${table.sheet && table.sheet.names.length > 1 ? " Your candidates may be on another sheet: run again with --sheet followed by its name, or save that sheet as CSV." : ""}`);
  }

  // 2. What this key can do (free).
  const release = flags.dryRun ? () => {} : lock(config.outDir);
  try {
  let caps: Capabilities;
  try { caps = capabilities(await accountEndpoints()); }
  catch (err) {
    if (flags.dryRun && err instanceof CrustdataError && (err.status === 401 || err.status === 403)) {
      const n = candidates.filter(x => x.profileUrl || x.email).length;
      const byMail = candidates.filter(x => !x.profileUrl && x.email).length;
      log(`\n${(err as Error).message}\nWithout a working key, here is the most each check can cost for ${plural(n, "candidate")}: the full check ${11 * n + byMail} credits (11 each, plus 1 per email lookup), the quick screen ${n + byMail}. Nothing was spent.`);
      return;
    }
    throw err;
  }
  let full = caps.verify && !flags.quick;
  if (flags.full && !caps.verify) throw new Error("This Crustdata key does not have the full check (/batch/person/verify is an add-on, enabled per account). Ask Crustdata to enable it, or run without --full for the 1-credit quick screen.");
  if (!caps.enrich) throw new Error("This Crustdata key cannot use Person Enrich (/person/enrich), which every check needs. Ask Crustdata to enable it.");
  if (!full && !flags.quick) log("  This key does not have the full check (verification is an add-on: ask Crustdata to enable it). Running the quick screen instead: Crustdata's profile score, no reasons or sources.");
  if (!full && !caps.assessment) log("  This key cannot read the profile score either (the assessment field), so only the date check runs. Ask Crustdata to enable the assessment field or the verification add-on.");
  full = full && !flags.quick;

  const state: ListState = loadState(dir, flags.file, config.reuseDays, clock.now());
  const verified = state.verified;
  // --refresh fetches everyone again; finished job ids are kept, so an old job is never taken for a new one.
  if (flags.refresh) { state.enriched = {}; for (const k of Object.keys(verified)) delete verified[k]; }
  // Every list's jobs, read before anything is spent (a damaged state file elsewhere stops the run here, for free).
  const machine = full ? jobsOnThisMachine(config.outDir) : { ids: new Set<string>(), inflight: new Map<string, string>(), inflightPeople: new Map<number, { list: string; url: string }>() };
  const cache = loadCache(config.outDir);
  const byPerson = new Map<number, Result>();
  for (const r of Object.values(cache)) if (r.person?.personId !== undefined && (!byPerson.has(r.person.personId) || (r.checkedAt > byPerson.get(r.person.personId)!.checkedAt))) byPerson.set(r.person.personId, r);
  // The job loop replaces its lists as it goes: every save copies them back first, so state.json always holds the
  // submissions in flight (the first billing rule: record intent before sending).
  let live: VerifyProgress | undefined;
  const sync = () => {
    if (!live) return;
    state.jobs = live.jobs;
    state.pending = live.pending;
    state.forgotten = [...(live.forgotten ?? [])];
  };
  const save = () => { if (!flags.dryRun) { sync(); saveState(dir, state); } };

  // People removed with npm run forget are never checked again from a file that still lists them (only a one-way
  // fingerprint of their profile URL or email is kept, in out/forgotten.json).
  const gone = loadForgotten(config.outDir);
  for (const x of candidates) {
    if ((x.profileUrl && (gone.has(fingerprint(x.profileUrl)) || state.forgotten.includes(x.profileUrl))) || (x.email && gone.has(fingerprint(x.email)))) {
      x.problem = "Removed with npm run forget, so not checked. Delete this row from your file (or run npm run forget -- --undo <profile URL> to allow it again).";
      x.profileUrl = undefined;
    }
  }

  // 3. Emails to profile URLs.
  const byEmail = candidates.filter(x => !x.profileUrl && !x.problem && x.email);
  if (byEmail.length && !caps.identify) for (const x of byEmail) x.problem = "No profile URL, and this key cannot look up emails (/person/identify). Add the profile URL to the row.";
  const emailsToLookUp = byEmail.filter(x => !x.problem && !(x.email! in state.identified)).map(x => x.email!);

  const reused = new Map<string, Result>();
  const pick = () => {
    const wanted = candidates.filter(x => x.profileUrl && !x.problem).map(x => x.profileUrl!);
    for (const u of wanted) {
      if (flags.refresh) break;
      if (reusable(cache[u], full, config.reuseDays, clock.now())) { reused.set(u, cache[u]); continue; }
      // The same person checked under another URL spelling (found by Crustdata's person id once the profile is read).
      const id = state.enriched[u]?.crustdata_person_id;
      const other = id ? byPerson.get(id) : undefined;
      if (other && reusable(other, full, config.reuseDays, clock.now())) reused.set(u, { ...other, profileUrl: u });
    }
    const todo = [...new Set(wanted.filter(u => !reused.has(u)))];
    return {
      todo,
      enrich: todo.filter(u => !(u in state.enriched)),
      verify: full ? todo.filter(u => !(u in verified)) : [],
    };
  };
  let plan = pick();
  const est = estimate({ emails: emailsToLookUp.length, enrich: plan.enrich.length + emailsToLookUp.length, verify: plan.verify.length + (full ? emailsToLookUp.length : 0) }, caps.verifyCredits);
  log("");
  log(`Plan (${full ? "full check" : "quick screen"}):`);
  if (emailsToLookUp.length) log(`  Look up ${plural(emailsToLookUp.length, "email")}: up to ${plural(est.emails, "credit")} (1 per match, misses are free)`);
  log(`  Profile details for ${plural(plan.enrich.length + emailsToLookUp.length, "person", "people")}: up to ${plural(est.enrich, "credit")} (1 per profile found)`);
  if (full) log(`  Full check for ${plural(plan.verify.length + emailsToLookUp.length, "person", "people")}: up to ${est.verify} credits (${caps.verifyCredits} per verdict; no verdict, no charge)`);
  if (reused.size) log(`  Reused from the last ${config.reuseDays} days: ${reused.size === 1 ? "at least 1 person" : `at least ${reused.size} people`}, free (--refresh checks them again)`);
  const unresolvable = candidates.filter(x => x.problem).length;
  if (unresolvable) log(`  Cannot check: ${plural(unresolvable, "row")} (listed in unresolved.csv)`);
  log(`  Total: at most ${fmtCredits(est.total)} credits`);
  if (flags.dryRun) {
    if (config.maxCredits && est.total > config.maxCredits) log(`\nThis is above MAX_CREDITS_PER_RUN (${config.maxCredits}): the real run would stop before spending.`);
    log("\nDry run: nothing was spent. Run the same command without --dry-run to check them."); return;
  }
  if (config.maxCredits && est.total > config.maxCredits) throw new Error(`This run may spend up to ${fmtCredits(est.total)} credits, above MAX_CREDITS_PER_RUN (${config.maxCredits}). Use --limit, split the file, or raise the limit in .env. Nothing was spent.`);

  if (est.total > config.confirmAbove && !flags.yes) {
    if (!process.stdin.isTTY) throw new Error(`This run may spend up to ${fmtCredits(est.total)} credits, above CONFIRM_ABOVE_CREDITS (${config.confirmAbove}). Add --yes to go ahead.`);
    if (!(await confirm(`Spend up to ${fmtCredits(est.total)} credits?`))) { log("Stopped. Nothing was spent."); return; }
  }
  log("");

  let runLog: Parameters<typeof appendRunLog>[1] | undefined;
  // Verdicts billed by jobs that finished in this run, kept outside the job loop so every exit path logs them.
  live = { verified, jobs: state.jobs, pending: state.pending, checkedAt: state.checkedAt, newVerdicts: 0, forgotten: new Set(state.forgotten) };
  const progressNow = live;
  const stoppedLog = () => ({ at: new Date(clock.now()).toISOString(), user: whoRan(), file: flags.file!, list: name, check: "stopped", candidates: candidates.length, credits: Math.round((spend.credits + (progressNow.newVerdicts ?? 0) * caps.verifyCredits) * 100) / 100 });
  // Ctrl+C or a stop signal: save, log and release before leaving, so the next run knows what was paid for.
  const onSignal = () => {
    try { sync(); saveState(dir, state); appendRunLog(config.outDir, stoppedLog()); } catch { /* best effort */ }
    release();
    console.log("\nStopped. Progress is saved: run the same command again to continue (nothing is charged twice).");
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    // 3b. Look up emails.
    if (emailsToLookUp.length) {
      log(`Looking up ${plural(emailsToLookUp.length, "email")}...`);
      await identifyEmails(emailsToLookUp, (sent, results) => {
        // Answers come in the order sent; matched_on is only a cross-check (its spelling can differ).
        const byPosition = results.length === sent.length;
        for (const [i, email] of sent.entries()) {
          // By position, unless the answer names another email: then by that name.
          const named = (x?: MatchResult) => x?.matched_on?.trim().toLowerCase();
          const r = byPosition && (!named(results[i]) || named(results[i]) === email) ? results[i] : results.find(x => named(x) === email);
          if (r) state.identified[email] = r;
        }
        save();
      });
    }
    const seenUrls = new Map(candidates.filter(x => x.profileUrl).map(x => [x.profileUrl!, x.line]));
    for (const x of byEmail) {
      if (x.problem) continue;
      const { url, problem, name: matchedName } = resolveIdentify(state.identified[x.email!]);
      if (problem) { x.problem = problem; continue; }
      // A match by email can still be a name match on the email's domain: the name in your file must agree.
      if (x.name && namesDiffer(x.name, matchedName)) { x.problem = `The profile found for this email is under another name ("${matchedName}", not "${x.name}"), so it was not used. If it is the same person, add the profile URL to the row.`; continue; }
      if (seenUrls.has(url!)) { x.problem = `Same person as line ${seenUrls.get(url!)} (found by email).`; continue; }
      seenUrls.set(url!, x.line);
      x.profileUrl = url;
      x.source = "email";
    }
    plan = pick();

    // 4. Profile details (and the quick-screen score).
    if (plan.enrich.length) {
      log(`Reading ${plural(plan.enrich.length, "profile")}...`);
      let done = 0;
      await enrichPeople(plan.enrich, results => {
        const byUrl = new Map<string, MatchResult>();
        for (const r of results) { const u = normalizeProfileUrl(r.matched_on); if (u) byUrl.set(u, r); }
        const batch = plan.enrich.slice(done, done + 25);
        for (const u of batch) { state.enriched[u] = enrichedPerson(byUrl.get(u)) ?? null; state.checkedAt[u] = new Date(clock.now()).toISOString(); }
        done += batch.length;
        save();
      }, () => log("  This key cannot read the profile score (the assessment field); continuing without it."));
    }

    // Now that profiles are read, the same person checked before under another URL spelling is reused.
    plan = pick();

    // The same person under two URL spellings (or found once by URL and once by email) is checked once.
    const sameAs = samePeople(plan.todo, state.enriched, reused);
    if (sameAs.size) log(`  ${plural(sameAs.size, "row")} turned out to be the same person as another row, checked once.`);

    // 5. The full check. People already in a running job of another list are not sent again: that list's next
    // run collects them, and this list reuses the verdict after that.
    let running: string[] = [];
    let unsent: string[] = [];
    let billedVerdicts = 0;
    const elsewhere = new Map<string, string>();
    if (full) {
      for (const u of plan.verify) {
        const other = machine.inflight.get(u);
        if (other && other !== name) { elsewhere.set(u, other); continue; }
        // The same person under another URL, already in a running job (this list or another): not sent again.
        const id = state.enriched[u]?.crustdata_person_id;
        const same = id ? machine.inflightPeople.get(id) : undefined;
        if (same && same.url !== u) elsewhere.set(u, same.list);
      }
      if (elsewhere.size) log(`  ${plural(elsewhere.size, "person", "people")} already in a running job of another list (${[...new Set(elsewhere.values())].join(", ")}); not sent again. Run that list again to collect them, then this one.`);
      const progress = progressNow;
      ({ running, unsent } = await runJobs(plan.verify.filter(u => !sameAs.has(u) && !elsewhere.has(u)), progress, save, { waitMs: flags.waitMinutes * 60_000, say: log, known: machine.ids }));
      running = [...running, ...unsent];
      state.jobs = progress.jobs;
      state.pending = progress.pending;
      state.forgotten = [...(progress.forgotten ?? [])];
      billedVerdicts = progress.newVerdicts ?? 0;
      save();
    }

    // 6. Results.
    const fresh: Result[] = [];
    const rows: Row[] = [];
    const now = clock.now();
    for (const x of candidates) {
      if (!x.profileUrl || x.problem) {
        // Kept in verified.csv (as "Not checked", with the reason) so the file goes back into the ATS whole.
        rows.push({ candidate: x, result: { profileUrl: "", check: "none", checkedAt: new Date(now).toISOString(), verdict: "not_checked", flags: [], citations: [], dateConflicts: [], note: (x.problem ?? "Not checked").replace(/\.$/, "") } });
        continue;
      }
      const own = x.profileUrl;
      const u = sameAs.get(own) ?? own;
      let r = reused.get(u);
      if (!r) {
        const enriched = state.enriched[u] ?? state.enriched[own] ?? undefined;
        const when = Date.parse(state.checkedAt[u] ?? "") || now;
        if (!full) r = quickResult(u, enriched, when);
        else if (elsewhere.has(u)) r = { ...quickResult(u, enriched, now), check: "none", verdict: "not_checked", note: `Being checked in the list "${elsewhere.get(u)}": run that list again, then this one (nothing is charged twice)` };
        else if (running.includes(u)) r = { ...quickResult(u, enriched, now), check: "none", verdict: "not_checked", note: "The full check is still running or held: run the same command again to collect it (nothing is charged twice)" };
        else if (progressNow.unreadable?.has(u)) r = { ...quickResult(u, enriched, now), check: "none", verdict: "not_checked", note: `Crustdata's verdict for this profile was billed but could not be read: contact Crustdata support with batch ${progressNow.unreadable.get(u)}` };
        else {
          r = fullResult(u, verified[u] ?? undefined, enriched, when);
          if (r.check === "none") {
            const q = quickResult(u, enriched, when);
            if (q.check === "quick") r = { ...q, note: "The full check returned no verdict (not charged); this is the quick screen" };
          }
        }
        if (!running.includes(u) && !elsewhere.has(u) && !sameAs.has(own)) fresh.push(r);
      }
      const first = sameAs.has(own) ? candidates.find(c => c.profileUrl === u || sameAs.get(c.profileUrl ?? "") === u) : undefined;
      const result: Result = { ...r, nameMismatch: undefined, ...(first && first !== x ? { note: `Same person as line ${first.line}`, profileUrl: own } : {}) };
      if (namesDiffer(x.name, result.person?.name)) result.nameMismatch = nameNote(result.person!.name!, x.name!, x.line);
      else if (x.sharedWith?.length) result.nameMismatch = `Another applicant gave this same profile URL under another name (${x.sharedWith.join(", ")}): confirm whose profile it is before reading this verdict`;
      rows.push({ candidate: x, result });
    }
    // Rows that repeat a candidate (one row per application) get the same verdict, checked once.
    for (const d of list.duplicates) {
      const firstRow = rows.find(r => r.candidate.line === d.of);
      if (firstRow) rows.push({ candidate: d.candidate, result: { ...firstRow.result }, duplicateOf: d.of });
    }
    saveResults(config.outDir, fresh.filter(r => r.check !== "none"));

    // 7. Optional AI summaries.
    let overview = "";
    if (flags.ai) {
      if (!aiAvailable()) log("--ai needs ANTHROPIC_API_KEY (run npm run setup). The rule-based summaries are used.");
      else {
        log(`Writing AI summaries for ${plural(rows.length, "candidate")}...`);
        const warn = (m: string) => log(`  ${m}`);
        const lines = await aiSummaries(rows.map(r => r.result), warn, rows.map(r => r.candidate.name));
        rows.forEach((r, i) => { if (lines[i]) r.result.aiSummary = lines[i]; });
        overview = await aiReport(rows.map(r => r.result), warn, rows.map(r => r.candidate.name));
      }
    }

    // 8. Files.
    const sorted = sortForReview(rows.map(r => ({ ...r, line: r.candidate.line })));
    const unresolved = candidates.filter(x => x.problem).map(x => ({ candidate: x, reason: x.problem! }));
    const sep = table.delimiter ?? ",";
    const verifyCredits = billedVerdicts * caps.verifyCredits;
    const credits = Math.round((spend.credits + verifyCredits) * 100) / 100;
    const meta = { listName: name, date: new Date(now).toISOString().slice(0, 10), creditsSpent: credits, reused: reused.size, unresolved: unresolved.length, duplicates: list.duplicates.length, quick: !full, aiReport: overview };
    writeFileAtomic(join(dir, "verified.csv"), verifiedCsv(table.headers, sorted, sep));
    writeFileAtomic(join(dir, "report.md"), reportMarkdown(sorted, meta));
    writeFileAtomic(join(dir, "results.json"), JSON.stringify({ version: 2, meta, headers: table.headers, delimiter: sep, rows: sorted.map(({ candidate, result, duplicateOf }) => ({ candidate, result, duplicateOf })) }, null, 1));
    runLog = { at: new Date(now).toISOString(), user: whoRan(), file: flags.file!, list: name, check: full ? "full" : "quick", candidates: candidates.length, credits };
    if (unresolved.length) writeFileAtomic(join(dir, "unresolved.csv"), unresolvedCsv(table.headers, unresolved, sep));
    else if (existsSync(join(dir, "unresolved.csv"))) rmSync(join(dir, "unresolved.csv"));

    // 9. Summary.
    log("");
    const review = sorted.filter(r => reviewOrder(r.result) <= 4 && !r.duplicateOf);
    const people = sorted.filter(r => !r.duplicateOf);
    log(`${plural(people.length, "candidate")}: ${people.filter(r => r.result.check !== "none").length} checked, ${review.length} to review first or clarify in the screen.`);
    for (const c of labelCounts(sorted.filter(r => !r.duplicateOf))) log(`  ${String(c.count).padStart(4)}  ${c.label}`);
    for (const r of review.slice(0, 10)) log(`  > ${r.candidate.name || r.result.person?.name || r.result.profileUrl}: ${r.result.aiSummary || summaryLine(r.result)}`);
    if (review.length > 10) log(`  > ...and ${review.length - 10} more in verified.csv`);
    const inJobs = running.length - unsent.length;
    if (inJobs) log(`\n${plural(inJobs, "person", "people")} still in running or held jobs. Run the same command again to collect them; nothing is charged twice.`);
    if (unsent.length) log(`${plural(unsent.length, "person", "people")} not sent yet (Crustdata's job slots were busy or the time ran out). Run the same command again.`);
    if (unresolved.length) log(`\n${plural(unresolved.length, "row")} could not be checked; reasons in unresolved.csv (fix them and run again: finished people are not charged again).`);
    log(`\nCredits: about ${fmtCredits(credits)}${verifyCredits ? ` (${verifyCredits} of them for ${plural(verifyCredits / caps.verifyCredits, "verdict")}, billed when each job finished)` : ""}.`);
    const rel = relative(process.cwd(), dir).startsWith("..") ? dir : relative(process.cwd(), dir) || dir;
    log(`Files: ${join(rel, "verified.csv")} (your list, doubtful first), ${join(rel, "report.md")}${unresolved.length ? `, ${join(rel, "unresolved.csv")}` : ""}`);
    log("A verdict is evidence for a person to review, not a hiring decision.");

    // 10. Slack.
    if (config.slackWebhookUrl && flags.slack) {
      const res = await postToSlack(config.slackWebhookUrl, summaryMessage(name, sorted, { unresolved: unresolved.length, credits, quick: !full, detail: config.slackDetail }));
      log(res.ok ? "Posted the summary to Slack." : `Slack: ${res.error} The files above are complete.`);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    save();
    appendRunLog(config.outDir, runLog ?? stoppedLog());
  }
  } finally {
    release();
  }
}

/** npm run test-slack: one short message to SLACK_WEBHOOK_URL. */
export async function runTestSlack(): Promise<void> {
  if (!config.slackWebhookUrl) throw new Error("SLACK_WEBHOOK_URL is not set. Run npm run setup and paste a Slack incoming webhook URL.");
  const res = await postToSlack(config.slackWebhookUrl, connectedMessage());
  if (!res.ok) throw new Error(`Slack did not take the message: ${res.error}`);
  log("Sent. Check the channel the webhook posts to.");
}

export { verdictLabel };
export type { Candidate };
