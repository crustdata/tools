/**
 * npm run research -- <domain | deals.csv> [options]
 *
 *   npm run research -- linear.app                    one memo: out/linear.app/memo.md and memo.json
 *   npm run research -- deals.csv                     a memo per company plus out/deals/comparison.md and .csv
 *   npm run research -- acme.com --peers a.com,b.com  compare with the peers you name
 *   npm run research -- deals.csv --dry-run           the most it can cost, spends nothing
 *
 * Options: --peers a.com,b.com  --no-peers  --dry-run  --refresh  --ai  --yes  --json
 *
 * Exit codes: 0 every company was researched; 2 some were and some were not (see unresolved.csv); 1 nothing was
 * researched, the run stopped, or the command was wrong.
 */

import "./node-check.js";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { Cache } from "./cache.js";
import { LIST, SENIOR_LIMIT, cacheKey, collect, keysFor, pickMatch, safeIdentify, type Collected } from "./collect.js";
import { config } from "./config.js";
import { CrustdataError, isFatal, spend } from "./crustdata.js";
import { CsvError, hasPath, looksBinary, normalizeDomain, notASite, parseDeals, splitList, type DealRow, type Duplicate, type Skipped } from "./input.js";
import { buildMemo, type Memo } from "./memo.js";
import { isEntryPoint } from "./entry.js";
import { csvCell, renderComparisonCsv, renderComparisonMd, renderMemo, type ComparisonRow } from "./render.js";

export const PRICE = LIST;
export { SENIOR_LIMIT };
/** After this many companies in a row fail on Crustdata's side, the run stops instead of trying every row. */
export const MAX_FAILURES_IN_A_ROW = 3;

/** The clock, replaced by the offline replay so fixtures read the same every day. */
export const DEFAULTS = { now: undefined as Date | undefined };

const USAGE = `Usage:
  npm run research -- linear.app                      one company
  npm run research -- deals.csv                       a list (CSV with a website or domain column, or one domain per line)
  npm run research -- acme.com --peers a.com,b.com    compare with peers you name (one company only)

Options:
  --peers a.com,b.com   peers to compare with, instead of Crustdata's competitor list
  --no-peers            skip peers (saves up to ${(PRICE.peer * 5).toFixed(2)} credits a company)
  --dry-run             print the companies and the most it can cost, then stop; spends nothing
  --refresh             fetch again even if a saved answer is newer than CACHE_DAYS
  --ai                  add a short analyst note written by your own AI key (ANTHROPIC_API_KEY or OPENAI_API_KEY)
  --yes                 run even when the estimate is above MAX_CREDITS_PER_RUN
  --json                print the memo JSON (one company) instead of the summary

Put -- between "npm run research" and the domain, or npm keeps the options for itself.`;

type Args = { inputs: string[]; peers?: string[]; noPeers: boolean; dryRun: boolean; refresh: boolean; ai: boolean; yes: boolean; json: boolean; help: boolean };

export function parseArgs(argv: string[]): Args {
  const a: Args = { inputs: [], noPeers: false, dryRun: false, refresh: false, ai: false, yes: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const [flag, inline] = x.startsWith("--") && x.includes("=") ? [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] : [x, undefined];
    switch (flag) {
      case "--peers": {
        const v = inline ?? argv[++i];
        if (!v || v.startsWith("--")) throw new Error("--peers needs a list of domains, for example --peers otter.ai,fireflies.ai");
        a.peers = splitList(v).map(p => {
          const d = normalizeDomain(p);
          if (!d) throw new Error(`--peers: "${p}" is not a domain or website. Use domains, for example --peers otter.ai,fireflies.ai`);
          return d;
        });
        break;
      }
      case "--no-peers": a.noPeers = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "--refresh": a.refresh = true; break;
      case "--ai": a.ai = true; break;
      case "--yes": case "-y": a.yes = true; break;
      case "--json": a.json = true; break;
      case "--help": case "-h": a.help = true; break;
      default:
        if (x.startsWith("-")) throw new Error(`Unknown option ${x}.\n\n${USAGE}`);
        a.inputs.push(x);
    }
  }
  if (a.peers && a.noPeers) throw new Error("Use either --peers or --no-peers, not both.");
  return a;
}

/**
 * Without "--", `npm run research linear.app --dry-run` hands --dry-run (and --json, --yes, --no-peers) to npm, not
 * to this tool, so a "dry run" would spend credits. npm leaves a trace in the environment: stop on it.
 */
export function swallowedByNpm(env: NodeJS.ProcessEnv = process.env, argv: string[] = []): string | undefined {
  if (env.npm_lifecycle_event !== "research") return undefined;
  const set = (k: string) => env[k] !== undefined;
  const taken = [
    set("npm_config_dry_run") ? "--dry-run" : "",
    set("npm_config_json") ? "--json" : "",

    // npm 11 leaves npm_config_peers empty for --no-peers and "true" for --peers (its value lands in the inputs).
    set("npm_config_peers") ? (env.npm_config_peers === "" ? "--no-peers" : env.npm_config_peers === "true" ? "--peers" : `--peers ${env.npm_config_peers}`) : "",
    set("npm_config_refresh") ? "--refresh" : "",
    set("npm_config_ai") ? "--ai" : "",
  ].filter(f => f && !argv.includes(f.split(" ")[0]));
  // --yes swallowed by npm is left alone: without it the credit guard is only stricter, and npm_config_yes is a
  // common CI setting.
  if (!taken.length) return undefined;
  const target = argv.find(a => !a.startsWith("-")) ?? "linear.app";
  const again = taken.filter(t => t !== "--yes").map(t => (t === "--peers" ? "--peers a.com,b.com" : t));
  return `npm took ${taken.join(", ")} for itself, so nothing was run and nothing was charged. Put -- right after "npm run research": npm run research -- ${target}${again.length ? ` ${again.join(" ")}` : ""}${taken.includes("--yes") ? " (add --yes only if you mean to go past MAX_CREDITS_PER_RUN)" : ""}`;
}

const isFileArg = (x: string) => /\.(csv|tsv|txt|xlsx|xls|xlsm|numbers|ods)$/i.test(x) || (existsSync(x) && !normalizeDomain(x));

export type Inputs = { rows: DealRow[]; listName?: string; notes: string[]; skipped: Skipped[]; duplicates: Duplicate[] };

/** A list name safe as a folder inside OUT_DIR: no dots at the start, never ".", ".." or ".cache". */
export const safeListName = (s: string) => {
  const n = s.replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80) || "list";
  // A list named like a domain (quillnote.example.csv) would share that company's memo folder.
  return normalizeDomain(n) ? `${n}-list` : n;
};

/** The companies to research, from the arguments: domains, or one CSV or text file. */
export function readInputs(inputs: string[]): Inputs {
  const notes: string[] = [];
  const files = inputs.filter(isFileArg);
  if (files.length > 1 || (files.length && inputs.length > 1)) throw new Error("Pass one file, or one or more domains, not both.");
  if (files.length) {
    const file = files[0];
    if (!existsSync(file)) throw new Error(`Cannot find ${file}. Check the path (it is relative to the folder you run the command from).`);
    const buf = readFileSync(file);
    const bad = looksBinary(buf, basename(file));
    if (bad) throw new Error(bad);
    const list = parseDeals(buf.toString("utf8"));
    if (list.column) notes.push(`Reading domains from the "${list.column}" column of ${basename(file)}.`);
    return { rows: list.rows, listName: safeListName(basename(file, extname(file))), notes, skipped: list.skipped, duplicates: list.duplicates };
  }
  const rows: DealRow[] = [];
  const skipped: Skipped[] = [];
  const duplicates: Duplicate[] = [];
  inputs.forEach((x, i) => {
    // A domain typed on the command line is taken as given (gamma.app and cal.com are companies too); a pasted link
    // with a path (a deck, a profile) is checked like a CSV cell.
    const d = normalizeDomain(x);
    if (!d) { skipped.push({ line: i + 1, reason: "not a domain or website", text: x }); return; }
    const why = hasPath(x) ? notASite(d, true) : undefined;
    if (why) { skipped.push({ line: i + 1, reason: `${why}. Pass the company's own domain, for example acme.com`, text: x }); return; }
    const first = rows.find(r => r.domain === d);
    if (first) duplicates.push({ line: i + 1, domain: d, firstLine: first.line });
    else rows.push({ domain: d, line: i + 1 });
  });
  return { rows, listName: rows.length > 1 ? "list" : undefined, notes, skipped, duplicates };
}

/**
 * The most a run can cost at list price. A company counts as saved (free) only when every answer collect() would
 * reuse is saved; a company with some answers saved is priced for the rest (a new month re-reads departures).
 */
export function estimate(rows: DealRow[], cache: Cache, opts: { today: Date; leavers: number; peers: number; userPeers?: string[]; refresh?: boolean }) {
  const seniorN = Math.min(SENIOR_LIMIT, opts.leavers);
  const leavers = opts.leavers > 0 ? (opts.leavers + seniorN) * PRICE.person : 0;
  const peers = (opts.userPeers?.length ?? opts.peers) * PRICE.peer;
  // + 0.03: the newest job posting is read when none was added in 90 days.
  const perCompany = PRICE.enrich + leavers + peers + 0.03;
  let saved = 0, total = 0;
  for (const r of rows) {
    const idRow = opts.refresh ? undefined : cache.get(cacheKey("identify", r.domain));
    const id = pickMatch(safeIdentify(idRow), r.domain)?.crustdata_company_id;
    // A saved identify answer that matched nothing costs nothing again (identify is free and nothing else is called).
    if (idRow !== undefined && id === undefined) { saved++; continue; }
    if (id === undefined) { total += perCompany; continue; }
    const k = keysFor(id, { today: opts.today, leaversLimit: opts.leavers, peersLimit: opts.peers, peers: opts.userPeers });
    const has = (key: string) => cache.get(key) !== undefined;
    const cost = (has(k.enrich) ? 0 : PRICE.enrich)
      + (opts.leavers > 0 ? (has(k.departures) ? 0 : opts.leavers * PRICE.person) + (has(k.senior) ? 0 : seniorN * PRICE.person) : 0)
      + (has(k.jobs) ? 0 : 0.03)
      + (peers > 0 && !has(k.peersDone) ? peers : 0);
    if (cost === 0) saved++;
    total += cost;
  }
  return { perCompany: round(perCompany), total: round(total), saved, leavers: round(leavers), peers: round(peers) };
}
const round = (n: number) => Math.round(n * 100) / 100;

const log = (s = "") => process.stderr.write(`${s}\n`);
const slug = (d: string) => d.replace(/[^a-z0-9.-]/gi, "_").replace(/^\.+/, "_");

/** Memos name real people: written owner-only, like the cache. */
function writePrivate(file: string, text: string) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600); // the mode above applies only when the file is created
}

function writeMemo(m: Memo): string {
  const dir = join(config.outDir, slug(m.asked));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(join(dir, "memo.json"), JSON.stringify(m, null, 2) + "\n");
  const file = join(dir, "memo.md");
  writePrivate(file, renderMemo(m));
  return file;
}

export type Unresolved = { line?: number; company?: string; domain?: string; reason: string; original?: string; fields?: Record<string, string> };

/** Rows not researched, in a file you can fix and run again (fill in the domain column). An old file is removed. */
function writeUnresolved(dir: string, rows: Unresolved[]): string | undefined {
  const file = join(dir, "unresolved.csv");
  if (!rows.length) { rmSync(file, { force: true }); return undefined; }
  mkdirSync(dir, { recursive: true });
  // The input file's own columns follow ours, so the file joins back to the CRM (Record ID, owner, stage).
  const extra = [...new Set(rows.flatMap(r => Object.keys(r.fields ?? {})))];
  const lines = [["line", "company", "domain", "reason", ...(extra.length ? extra.map(h => `input_${h}`) : ["original_row"])].map(h => csvCell(h)).join(","),
    ...rows.map(r => [r.line ?? "", csvCell(r.company), csvCell(r.domain), csvCell(r.reason), ...(extra.length ? extra.map(h => csvCell(r.fields?.[h])) : [csvCell(r.original)])].join(","))];
  writePrivate(file, lines.join("\n") + "\n");
  return file;
}

/**
 * One run at a time per out folder: two runs on the same folder would both pay for the same companies. A lock left
 * by a run that no longer exists is taken over.
 */
function takeLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // OUT_DIR/.lock, outside out/.cache, so a saved cache (CI) never carries a lock along.
  const file = join(dir, ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch {
      let pid = 0;
      try { pid = Number(readFileSync(file, "utf8").trim()); } catch { continue; /* removed meanwhile: try again */ }
      let alive = false;
      try { if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch { /* not running */ }
      if (alive) throw new Error(`Another run (process ${pid}) is using ${dir}. Wait for it to finish, or set OUT_DIR to another folder.`);
      // Take over a lock left by a run that ended: rename it away, then check the moved file still holds the dead
      // pid. If another run took it over in between, the moved file is that run's lock: put it back and stop.
      const moved = `${file}.old.${process.pid}`;
      try { renameSync(file, moved); } catch { continue; /* another run took it first */ }
      let movedPid = 0;
      try { movedPid = Number(readFileSync(moved, "utf8").trim()); } catch { /* gone */ }
      if (movedPid && movedPid !== pid) {
        try { renameSync(moved, file); } catch { /* best effort */ }
        throw new Error(`Another run (process ${movedPid}) is using ${dir}. Wait for it to finish, or set OUT_DIR to another folder.`);
      }
      rmSync(moved, { force: true });
    }
  }
  throw new Error(`Could not lock ${dir}. Delete ${file} if no other run is going.`);
}

/** A path to print: relative when the file is under the current folder, else in full. */
const show = (file: string) => { const r = relative(process.cwd(), file); return r && !r.startsWith("..") ? r : file; };

export async function main(argv: string[]): Promise<number> {
  spend.credits = 0;
  const npm = swallowedByNpm(process.env, argv);
  if (npm) { log(npm); return 1; }
  let args: Args;
  try { args = parseArgs(argv); } catch (err) { log((err as Error).message); return 1; }
  if (args.help || !args.inputs.length) { log(USAGE); return args.help ? 0 : 1; }

  let input: Inputs;
  try { input = readInputs(args.inputs); } catch (err) { log(err instanceof CsvError || err instanceof Error ? err.message : String(err)); return 1; }
  for (const n of input.notes) log(n);
  const notes = [...input.skipped.map(s => ({ line: s.line, text: `Skipped line ${s.line}: ${s.reason} (${s.text})` })), ...input.duplicates.map(d => ({ line: d.line, text: `Skipped line ${d.line}: a duplicate of line ${d.firstLine} (${d.domain})` }))];
  for (const x of notes.sort((a, b) => a.line - b.line)) log(x.text);
  if (!input.rows.length) { log("Nothing to research: no usable domain found."); return 1; }
  if (args.peers && input.rows.length > 1) { log("--peers works with one company at a time. For a list, leave it out (each company gets its own peers) or use --no-peers."); return 1; }
  if (args.json && input.rows.length > 1) { log("--json prints one memo. For a list, read out/<domain>/memo.json, or comparison.csv in the list's folder."); return 1; }

  const now = DEFAULTS.now ?? new Date();
  let leavers: number, peersLimit: number, maxCredits: number, cacheDays: number, peopleDetail: "all" | "leaders";
  try {
    leavers = config.leaversLimit; peersLimit = args.noPeers ? 0 : config.peersLimit; maxCredits = config.maxCreditsPerRun;
    cacheDays = config.cacheDays; peopleDetail = config.peopleDetail;
  } catch (err) { log((err as Error).message); return 1; }
  const outDir = config.outDir;
  const cache = new Cache(join(outDir, ".cache"), cacheDays, args.refresh);

  const est = estimate(input.rows, cache, { today: now, leavers, peers: peersLimit, userPeers: args.peers, refresh: args.refresh });
  const n = input.rows.length;
  const todo = n - est.saved;
  const total = est.total;
  const parts = [`${PRICE.enrich} for the company record`, est.leavers ? `up to ${est.leavers} for former staff` : "", est.peers ? `up to ${est.peers} for peers` : ""].filter(Boolean);
  const plan = est.saved === n ? `${n} compan${n === 1 ? "y" : "ies"}, saved in the last ${cacheDays} days: free. --refresh fetches ${n === 1 ? "it" : "them"} again (up to ${est.perCompany} credits a company at list price).` : `${n} compan${n === 1 ? "y" : "ies"}${est.saved ? ` (${est.saved} saved in the last ${cacheDays} days, free)` : ""}: at most ${total} credits at list price (${est.perCompany} a company: ${parts.join(", ")}). Most companies cost less: you pay only for people and peers found.`;
  if (args.dryRun) {
    for (const r of input.rows) log(`  line ${r.line}  ${r.domain}${r.name || r.source === "email" ? `  (${[r.name, r.source === "email" ? "from the founder's email" : ""].filter(Boolean).join(", ")})` : ""}`);
    log(plan);
    log(`Dry run: nothing was fetched and nothing was charged. Check the domains above, then run again without --dry-run. Your own plan's prices are at https://app.crustdata.com/endpoints.`);
    return 0;
  }
  if (maxCredits > 0 && total > maxCredits && !args.yes) {
    log(plan);
    log(`That is above MAX_CREDITS_PER_RUN (${maxCredits}). Run again with --yes to go ahead, or raise MAX_CREDITS_PER_RUN in .env.`);
    return 1;
  }
  try { void config.crustdataApiKey; } catch (err) { log((err as Error).message); return 1; }
  if (args.ai) {
    // The model list is free: check the AI key before spending any Crustdata credits.
    const { aiProvider, checkKey, pickModel } = await import("./ai.js");
    const ai = aiProvider();
    if (!ai) { log("--ai needs ANTHROPIC_API_KEY or OPENAI_API_KEY in .env (your own key, billed by that provider). Run without --ai for the rule-based memo."); return 1; }
    try { await checkKey(ai.provider, ai.key); await pickModel(ai.provider, ai.key); } catch (err) { log(`--ai cannot run: ${(err as Error).message} Nothing was charged.`); return 1; }
  }
  const listDir = input.listName ? join(outDir, slug(input.listName)) : undefined;
  if (listDir && !resolve(listDir).startsWith(resolve(outDir) + sep)) { log(`The list name would write outside ${outDir}. Rename the file.`); return 1; }

  let release: () => void;
  try { release = takeLock(outDir); } catch (err) { log((err as Error).message); return 1; }
  try {
    cache.purge();
    if (todo > 0) log(plan);

    const rows: ComparisonRow[] = [];
    const unresolved: Unresolved[] = input.skipped.map(s => ({ line: s.line, company: s.name, reason: s.reason, original: s.text, fields: s.fields }));
    let stopped: string | undefined;
    let failuresInARow = 0;
    let possiblyBilled = false;
    let lastMemo: Memo | undefined;
    for (const [i, r] of input.rows.entries()) {
      const tag = n > 1 ? `[${i + 1}/${n}] ` : "";
      const base = { asked: r.domain, name: r.name, fields: r.fields };
      let got: Collected;
      try {
        got = await collect(r.domain, { today: now, leaversLimit: leavers, peersLimit, peers: args.noPeers ? [] : args.peers }, cache);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/may have been billed/.test(msg)) possiblyBilled = true;
        if (isFatal(err) || ++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          stopped = msg;
          for (const rest of input.rows.slice(i)) {
            rows.push({ asked: rest.domain, name: rest.name, fields: rest.fields, error: "not researched (run stopped)" });
            unresolved.push({ line: rest.line, company: rest.name, domain: rest.domain, reason: rest === r ? `the run stopped here: ${msg}` : "not researched: the run stopped before this row", fields: rest.fields });
          }
          break;
        }
        log(`${tag}${r.domain}: ${msg} Skipped; the run goes on.`);
        rows.push({ ...base, error: err instanceof CrustdataError ? "Crustdata could not answer for this company" : "the answer for this company could not be read" });
        unresolved.push({ line: r.line, company: r.name, domain: r.domain, reason: msg, fields: r.fields });
        continue;
      }
      failuresInARow = 0;
      if (got.status === "unmatched") {
        log(`${tag}${r.domain}: ${got.reason}`);
        unresolved.push({ line: r.line, company: r.name, domain: r.domain, reason: got.reason, fields: r.fields });
        rows.push({ ...base, error: got.matched ? `matched another company (${got.matched}), skipped` : "not found in Crustdata" });
        continue;
      }
      let memo: Memo;
      try {
        memo = buildMemo(got.bundle, now, { peopleDetail });
      } catch (err) {
        // A record the rules cannot read must not stop the list: the answer is saved, the next version may read it.
        const msg = `the memo could not be built (${(err as Error).message}). Please report it with the domain.`;
        log(`${tag}${r.domain}: ${msg}`);
        unresolved.push({ line: r.line, company: r.name, domain: r.domain, reason: msg, fields: r.fields });
        rows.push({ ...base, error: "memo failed" });
        continue;
      }
      if (args.ai) {
        try {
          const { analystNote } = await import("./ai.js");
          memo.ai_note = await analystNote(memo);
        } catch (err) {
          log(`${tag}${r.domain}: the AI note was skipped: ${(err as Error).message}`);
        }
      }
      const file = writeMemo(memo);
      lastMemo = memo;
      const flags = memo.findings.filter(f => f.kind === "red_flag").length;
      log(`${tag}${memo.company.name} (${r.domain}): ${got.bundle.credits} credits charged (${got.bundle.list_credits} at list price), ${flags} red flag${flags === 1 ? "" : "s"}, ${memo.questions.length} questions -> ${show(file)}`);
      rows.push({ ...base, memo, memoPath: listDir ? relative(listDir, file) : file });
    }

    const researched = rows.filter(r => r.memo).length;
    if (listDir && researched) {
      mkdirSync(listDir, { recursive: true, mode: 0o700 });
      writePrivate(join(listDir, "comparison.csv"), renderComparisonCsv(rows));
      writePrivate(join(listDir, "comparison.md"), renderComparisonMd(rows, input.listName!, now.toISOString().slice(0, 10), { rows: n + input.skipped.length + input.duplicates.length, unresolved: unresolved.length, duplicates: input.duplicates.length }));
      log(`Comparison: ${show(join(listDir, "comparison.md"))} and comparison.csv`);
    }
    const unresolvedFile = writeUnresolved(listDir ?? outDir, unresolved);
    if (unresolvedFile && n > 1 && !stopped) log(`${unresolved.length} row${unresolved.length === 1 ? "" : "s"} not researched: ${show(unresolvedFile)} (fill in the domain column and run that file).`);
    log(`Credits used this run: ${round(spend.credits)}.`);

    if (n === 1 && lastMemo) {
      if (args.json) process.stdout.write(JSON.stringify(lastMemo, null, 2) + "\n");
      else {
        const flags = lastMemo.findings.filter(f => f.kind === "red_flag");
        process.stdout.write(`\n${lastMemo.company.name}: ${flags.length ? `${flags.length} red flag${flags.length === 1 ? "" : "s"}` : "no red flags from the rules"}\n`);
        for (const f of flags.slice(0, 5)) process.stdout.write(`  - ${f.text}\n`);
        if (lastMemo.questions.length) process.stdout.write(`First question for the founder call: ${lastMemo.questions[0]}\n`);
      }
    }
    if (stopped) {
      log(`\nStopped: ${stopped}`);
      if (cacheDays === 0) log("CACHE_DAYS is 0, so nothing was saved: running again pays again for every company.");
      else if (researched || spend.credits > 0) log(`Run the same command${args.refresh ? " again without --refresh" : " again"}: answers already paid for are saved and cost nothing again.`);
      else log(possiblyBilled ? "Nothing was researched; one request may have been billed (see above)." : "Nothing was researched and nothing was charged.");
      return 1;
    }
    if (!researched) return 1;
    return researched < n || input.skipped.length ? 2 : 0;
  } finally {
    release();
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => { log(err instanceof Error ? err.message : String(err)); process.exitCode = 1; });
}
