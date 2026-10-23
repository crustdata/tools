/**
 * The seen list: every person a run has returned (and been billed for), one CSV per role in out/<role>/seen.csv.
 * The next run sends it to Crustdata as `post_processing.exclude_profiles`, so those people are neither returned
 * nor billed again, and drops them locally as a second guard (by profile URL and by Crustdata person id).
 *
 * It is a CSV on purpose: recruiters open it. Other files with profile URLs in them (an ATS export) are read with
 * --skip-from and never written to.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { csvText, parseCsv } from "./csv.js";
import { writeFileSafe } from "./role.js";

/**
 * One form for every profile URL, so a lookup never misses because of case, scheme, "www.", a mobile or country
 * subdomain, a trailing slash, a query string, angle brackets or percent-encoding:
 * "<http://UK.Example.com/in/Jane-Doe/?x=1>" becomes "https://www.example.com/in/jane-doe".
 * Returns "" for anything that is not a person profile URL.
 */
export function normalizeProfileUrl(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.trim().replace(/^<|>$/g, "").trim();
  if (!s) return "";
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try { url = new URL(s); } catch { return ""; }
  const path = (() => { try { return decodeURIComponent(url.pathname); } catch { return url.pathname; } })();
  const m = /^\/in\/([^/]+)/i.exec(path);
  if (!m) return "";
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|[a-z]{2})\./, "");
  return `https://www.${host}/in/${encodeURIComponent(m[1].toLowerCase())}`;
}

export type SeenRow = { url: string; name: string; firstSeen: string; id?: number };
export type SeenList = { byUrl: Map<string, SeenRow>; ids: Set<number>; rowsWithoutUrl: number };

export const SEEN_HEADER = ["profile URL", "name", "first seen", "crustdata person id"];

/** True when the file is a seen list this tool wrote (or does not exist yet), so it may be written to. */
export function isSeenFile(path: string): boolean {
  if (!existsSync(path)) return true;
  const first = readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "";
  return first.trim() === "" || first.startsWith(SEEN_HEADER.slice(0, 3).join(","));
}

const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** A lock file next to the seen list, so two runs sharing it never write at the same moment. Taken over after 30 s. */
export function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  for (let i = 0; ; i++) {
    try { closeSync(openSync(lock, "wx")); break; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; } } catch { continue; }
      if (i > 300) throw new Error(`${path} is locked by another run (${lock}). Wait for it to finish, or delete the lock file if no run is going.`);
      sleepSync(50 + Math.random() * 50);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

/** Reads a seen list, or any CSV with profile URLs in it. A missing file is an empty list. */
export function loadSeen(path: string): SeenList {
  const out: SeenList = { byUrl: new Map(), ids: new Set(), rowsWithoutUrl: 0 };
  if (!existsSync(path)) return out;
  const text = readFileSync(path);
  // A spreadsheet saved as UTF-16 reads as nothing; say so rather than skipping nobody.
  const decoded = text[0] === 0xff && text[1] === 0xfe ? text.toString("utf16le") : text.toString("utf8");
  const rows = parseCsv(decoded.replace(/^\uFEFF/, ""));
  const own = isSeenFile(path);
  rows.forEach((row, i) => {
    if (i === 0 && row.some(c => /profile|url|name|email/i.test(c)) && !row.some(c => normalizeProfileUrl(c))) return;
    const cell = row.find(c => normalizeProfileUrl(c));
    const id = own ? Number(row[3]) || undefined : undefined;
    if (id) out.ids.add(id);
    if (!cell) { if (row.some(c => c.trim())) out.rowsWithoutUrl++; return; }
    const key = normalizeProfileUrl(cell);
    if (!out.byUrl.has(key)) out.byUrl.set(key, { url: cell.trim(), name: own ? row[1] ?? "" : "", firstSeen: own ? row[2] ?? "" : "", id });
  });
  return out;
}

/**
 * Adds people to a seen list file. The file is read again just before writing and merged, so two sourcers sharing a
 * list do not overwrite each other's people, and it is replaced in one step (never half written).
 */
export function addToSeen(path: string, rows: SeenRow[]): SeenList {
  if (!isSeenFile(path)) throw new Error(`${path} is not a seen list made by this tool, so it is not changed. Pass it with --skip-from to only read it.`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withLock(path, () => mergeInto(path, rows));
}

function mergeInto(path: string, rows: SeenRow[]): SeenList {
  const current = loadSeen(path);
  for (const r of rows) {
    const key = normalizeProfileUrl(r.url);
    if (!key && !r.id) continue;
    if (key) {
      const prev = current.byUrl.get(key);
      // A person seen again moves to the end, so the newest people are the ones sent when the list is very long.
      if (prev) current.byUrl.delete(key);
      current.byUrl.set(key, prev ? { ...prev, id: prev.id ?? r.id } : r);
    }
    if (r.id) current.ids.add(r.id);
  }
  const urlIds = new Set([...current.byUrl.values()].map(r => r.id).filter(Boolean));
  const lines: unknown[][] = [...current.byUrl.values()].map(r => [r.url, r.name, r.firstSeen, r.id ?? ""]);
  for (const id of current.ids) if (!urlIds.has(id)) lines.push(["", "(no profile URL)", "", id]);
  writeFileSafe(path, csvText(SEEN_HEADER, lines));
  return current;
}

/** The URLs to send as `exclude_profiles`, in the one normalised form (checked live: Crustdata matches it). */
export const excludeList = (seen: SeenList): string[] => [...seen.byUrl.keys()];

/** Several lists read as one (the role's own list plus --skip-from files). */
export function mergeSeen(lists: SeenList[]): SeenList {
  const out: SeenList = { byUrl: new Map(), ids: new Set(), rowsWithoutUrl: 0 };
  for (const l of lists) {
    for (const [k, v] of l.byUrl) if (!out.byUrl.has(k)) out.byUrl.set(k, v);
    for (const id of l.ids) out.ids.add(id);
    out.rowsWithoutUrl += l.rowsWithoutUrl;
  }
  return out;
}
