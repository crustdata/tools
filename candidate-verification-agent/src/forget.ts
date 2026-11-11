/**
 * npm run forget -- <profile URL or email>
 *   Removes one person from every file under OUT_DIR: the shared result cache, each list's progress, results,
 *   verified.csv, unresolved.csv, and report.md (rebuilt, so its counts stay right). For a candidate who asks to be
 *   removed, or a row added by mistake. Your own input files, Slack messages and data held by Crustdata are not
 *   touched (delete the Slack message yourself; send erasure requests for Crustdata's data to Crustdata).
 *
 * npm run purge -- --older-than <days>
 *   Deletes every list folder last run more than <days> days ago, and results older than that from the cache.
 *   For a retention policy (run it on a schedule).
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { csvText, reportMarkdown, type ReportMeta, type Row } from "./output.js";
import { csvDelimiter, parseCsv } from "./input.js";
import { findProfileUrls, normalizeProfileUrl } from "./profile-url.js";
import { addForgotten, cachePath, lock, undoForgotten, writeFileAtomic } from "./store.js";

const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

type Who = { url?: string; email?: string };

/** Whether a piece of text mentions this person (their profile URL, or their email as a whole word). */
export function mentions(text: string, who: Who): boolean {
  if (who.url && findProfileUrls(text).includes(who.url)) return true;
  if (who.email) {
    const e = who.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\w.+-])${e}($|[^\\w.-])`, "i").test(text)) return true;
  }
  return false;
}

/** Pure: the CSV text without the rows that mention this person (the header stays). */
export function dropCsvRows(text: string, who: Who | string): { text: string; removed: number } {
  const w = typeof who === "string" ? { url: who } : who;
  const sep = csvDelimiter(text);
  const rows = parseCsv(text);
  const [head, ...rest] = rows;
  if (!head) return { text, removed: 0 };
  const keep = rest.filter(r => !r.cells.some(c => mentions(c, w)));
  return { text: csvText(head.cells, keep.map(r => r.cells), sep), removed: rest.length - keep.length };
}

/** Pure: report.md without the candidate sections that mention this profile URL (used for older results files). */
export function dropReportSections(md: string, url: string): { text: string; removed: number } {
  const parts = md.split(/(?=^### )/m);
  const keep = parts.filter(p => !(p.startsWith("### ") && findProfileUrls(p).includes(url)));
  return { text: keep.join(""), removed: parts.length - keep.length };
}

const rowMentions = (row: Row, who: Who) =>
  (who.url && (row.result.profileUrl === who.url || row.candidate.profileUrl === who.url)) ||
  (who.email && row.candidate.email?.toLowerCase() === who.email) ||
  row.candidate.cells.some(c => mentions(c, who));

export async function runForget(args: string[]): Promise<void> {
  const arg = args.find(a => !a.startsWith("-"))?.trim() ?? "";
  const who: Who = /@/.test(arg) && !/linkedin\.com/i.test(arg) ? { email: arg.toLowerCase() } : { url: normalizeProfileUrl(arg) };
  if (!who.url && !who.email) throw new Error("Pass the person's profile URL or email: npm run forget -- https://www.linkedin.com/in/jane-doe");
  const out = config.outDir;
  const key = who.url ?? who.email!;
  if (args.includes("--undo")) {
    const had = undoForgotten(out, key);
    console.log(had ? `${key} can be checked again.` : `${key} was not on the forgotten list.`);
    return;
  }
  if (!existsSync(out)) { console.log(`Nothing to forget: ${out} does not exist.`); return; }
  const release = lock(out);
  let touched = 0;
  // The profile URLs this email was matched to, so their results go too.
  const urls = new Set<string>(who.url ? [who.url] : []);
  try {
    for (const name of readdirSync(out)) {
      // Rows found by this email in a list: their profile URLs go too.
      const resultsPath = join(out, name, "results.json");
      if (who.email && existsSync(resultsPath)) {
        const data = readJson(resultsPath);
        if (data?.version === 2) for (const row of data.rows as Row[]) {
          if (rowMentions(row, { email: who.email })) for (const u of [row.result.profileUrl, row.candidate.profileUrl]) if (u) urls.add(u);
        }
      }
      const statePath = join(out, name, "state.json");
      if (!existsSync(statePath)) continue;
      const s = readJson(statePath);
      for (const [email, r] of Object.entries<any>(s.identified ?? {})) {
        const matched = (r?.matches ?? []).map((m: any) => normalizeProfileUrl(m?.person_data?.social_handles?.professional_network_identifier?.profile_url)).filter(Boolean);
        if (who.email === email) matched.forEach((u: string) => urls.add(u));
      }
    }
    // Every other profile URL of the same Crustdata person (two spellings, or found by email).
    const ids = new Set<number>();
    const cacheNow = existsSync(cachePath(out)) ? readJson(cachePath(out)) : {};
    for (const u of urls) { const id = cacheNow[u]?.person?.personId; if (id) ids.add(id); }
    for (const name of readdirSync(out)) {
      const rp = join(out, name, "results.json");
      if (!existsSync(rp)) continue;
      const data = readJson(rp);
      if (data?.version === 2) for (const row of data.rows as Row[]) if (urls.has(row.result.profileUrl) && row.result.person?.personId) ids.add(row.result.person.personId);
    }
    for (const [u, r] of Object.entries<any>(cacheNow)) if (r?.person?.personId && ids.has(r.person.personId)) urls.add(u);
    const targets: Who[] = [who, ...[...urls].filter(u => u !== who.url).map(url => ({ url }))];
    const hit = (text: string) => targets.some(t => mentions(text, t));

    if (existsSync(cachePath(out))) {
      const cache = readJson(cachePath(out));
      const before = Object.keys(cache).length;
      for (const u of urls) delete cache[u];
      if (Object.keys(cache).length !== before) { writeFileAtomic(cachePath(out), JSON.stringify(cache, null, 1)); touched++; }
    }
    for (const name of readdirSync(out)) {
      const dir = join(out, name);
      if (!statSync(dir).isDirectory()) continue;
      const statePath = join(dir, "state.json");
      if (existsSync(statePath)) {
        const s = readJson(statePath);
        let changed = false;
        for (const key of ["enriched", "verified"] as const) for (const u of urls) if (s[key] && u in s[key]) { delete s[key][u]; changed = true; }
        for (const [email, r] of Object.entries<any>(s.identified ?? {})) {
          const matched = (r?.matches ?? []).some((m: any) => urls.has(normalizeProfileUrl(m?.person_data?.social_handles?.professional_network_identifier?.profile_url) ?? ""));
          if (matched || email === who.email) { delete s.identified[email]; changed = true; }
        }
        for (const j of s.jobs ?? []) if (j.done && j.urls?.some((u: string) => urls.has(u))) { j.urls = j.urls.filter((u: string) => !urls.has(u)); changed = true; }
        // A running job's or pending submission's people are never edited (their results must still line up):
        // the person is listed as forgotten, and their record is dropped when the job is read.
        const inFlight = [...(s.jobs ?? []).filter((j: any) => !j.done).flatMap((j: any) => j.urls ?? []), ...(s.pending ?? []).flatMap((p: any) => p.urls ?? [])];
        for (const u of urls) if (inFlight.includes(u) && !(s.forgotten ?? []).includes(u)) { s.forgotten = [...(s.forgotten ?? []), u]; changed = true; }
        if (s.checkedAt) for (const u of urls) if (u in s.checkedAt) { delete s.checkedAt[u]; changed = true; }
        if (changed) { writeFileAtomic(statePath, JSON.stringify(s, null, 1)); touched++; }
      }
      const resultsPath = join(dir, "results.json");
      const reportPath = join(dir, "report.md");
      if (existsSync(resultsPath)) {
        const data = readJson(resultsPath);
        if (data?.version === 2) {
          const keep = (data.rows as Row[]).filter(row => !targets.some(t => rowMentions(row, t)));
          if (keep.length !== data.rows.length) {
            writeFileAtomic(resultsPath, JSON.stringify({ ...data, rows: keep }, null, 1));
            const dupes = keep.filter(r => r.duplicateOf).length;
            // The AI overview was written from everyone, so it is dropped rather than left naming this person.
            writeFileAtomic(reportPath, reportMarkdown(keep, { ...(data.meta as ReportMeta), aiReport: undefined, duplicates: dupes, unresolved: keep.filter(r => r.result.check === "none" && !r.result.profileUrl).length }));
            writeFileAtomic(resultsPath, JSON.stringify({ ...data, meta: { ...data.meta, aiReport: undefined }, rows: keep }, null, 1));
            touched += 2;
          }
        } else if (Array.isArray(data)) {
          const keep = data.filter((r: any) => !urls.has(r.profileUrl));
          if (keep.length !== data.length) { writeFileAtomic(resultsPath, JSON.stringify(keep, null, 1)); touched++; }
          if (existsSync(reportPath) && who.url) {
            const { text, removed } = dropReportSections(readFileSync(reportPath, "utf8"), who.url);
            if (removed) { writeFileAtomic(reportPath, text); touched++; }
          }
        }
      }
      for (const file of ["verified.csv", "unresolved.csv"]) {
        const p = join(dir, file);
        if (!existsSync(p)) continue;
        const original = readFileSync(p, "utf8");
        const rows = parseCsv(original);
        const [head, ...rest] = rows;
        if (!head) continue;
        const keep = rest.filter(r => !r.cells.some(hit));
        if (keep.length !== rest.length) {

          writeFileAtomic(p, csvText(head.cells, keep.map(r => r.cells), csvDelimiter(original)));
          touched++;
        }
      }
    }
    // A fingerprint (not the URL or email itself) so a file that still lists them never checks them again.
    addForgotten(out, [key, ...urls]);
  } finally { release(); }
  const label = who.url ?? who.email;
  console.log(touched
    ? `Removed ${label} from ${touched} file${touched === 1 ? "" : "s"} under ${out}. Your own input files were not changed: delete their row there (a file that still lists them will skip them). Delete any Slack message about them yourself; for data held by Crustdata, contact Crustdata support.`
    : `${label} was not in any file under ${out}.`);
}

export async function runPurge(args: string[], now = Date.now()): Promise<void> {
  const force = args.includes("--force");
  const i = args.indexOf("--older-than");
  const days = Number(args[i + 1]);
  if (i === -1 || !Number.isFinite(days) || days < 0) throw new Error("Say how old: npm run purge -- --older-than 90 (days).");
  const out = config.outDir;
  if (!existsSync(out)) { console.log(`Nothing to purge: ${out} does not exist.`); return; }
  const cutoff = now - days * 86_400_000;
  const release = lock(out);
  let lists = 0, results = 0;
  const kept: string[] = [];
  try {
    for (const name of readdirSync(out)) {
      const dir = join(out, name);
      if (!statSync(dir).isDirectory()) continue;
      const newest = Math.max(...readdirSync(dir).map(f => statSync(join(dir, f)).mtimeMs), statSync(dir).mtimeMs);
      if (newest >= cutoff) continue;
      // A list with a running job or a pending submission holds paid work: deleting it would pay again.
      const st = existsSync(join(dir, "state.json")) ? readJson(join(dir, "state.json")) : undefined;
      if (!force && st && ((st.jobs ?? []).some((j: any) => !j.done) || (st.pending ?? []).length)) { kept.push(name); continue; }
      rmSync(dir, { recursive: true, force: true }); lists++;
    }
    if (existsSync(cachePath(out))) {
      const cache = readJson(cachePath(out));
      for (const [u, r] of Object.entries<any>(cache)) if (!(Date.parse(r?.checkedAt) >= cutoff)) { delete cache[u]; results++; }
      writeFileAtomic(cachePath(out), JSON.stringify(cache, null, 1));
    }
  } finally { release(); }
  console.log(`Deleted ${lists} list folder${lists === 1 ? "" : "s"} and ${results} cached result${results === 1 ? "" : "s"} older than ${days} days from ${out}.${kept.length ? ` Kept ${kept.join(", ")}: jobs still running (run those lists again first, or pass --force).` : ""}`);
}
