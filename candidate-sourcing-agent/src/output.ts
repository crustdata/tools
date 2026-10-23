/**
 * What a role's folder holds, and the files written from it:
 *
 *   out/<role>/profiles.json   every candidate any run returned, with the record Crustdata sent (source of truth)
 *   out/<role>/candidates.csv  all of them, scored and ranked again on every run (and by npm run rescore)
 *   out/<role>/shortlist.md    the top of this run's new candidates, for the hiring manager
 *
 * Everything here except loadStore and the two writers is pure.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Person } from "./crustdata.js";
import { writeCsv } from "./csv.js";
import { locationOf, nameOf, pastRoles, primaryRole, profileUrl } from "./profile.js";
import { writeFileSafe, type RoleSpec } from "./role.js";
import { rank, scoreCandidate, type Scored } from "./score.js";
import { normalizeProfileUrl } from "./seen.js";

export type Stored = {
  url: string;           // profile URL as Crustdata returned it
  person: Person;        // the record, as returned
  batch: string;         // when this person was found (ISO time of the run)
  apiRank: number;       // position in Crustdata's ranked list in that run, 1 is best
  open?: boolean;        // says they are open to new roles (checked in that run)
  why?: string;          // the optional AI sentence
};

export const storePath = (dir: string) => join(dir, "profiles.json");

export function loadStore(dir: string): Stored[] {
  const file = storePath(dir);
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    throw new Error(`${file} is not valid JSON. Restore it or delete it (it holds the candidates found so far).`);
  }
}

/** Adds new people and refreshes people seen again (with --fresh), keyed by normalised profile URL. */
export function mergeStore(existing: Stored[], found: Stored[]): Stored[] {
  const byUrl = new Map(existing.map(s => [normalizeProfileUrl(s.url) || `id:${s.person.crustdata_person_id}`, s]));
  for (const s of found) byUrl.set(normalizeProfileUrl(s.url) || `id:${s.person.crustdata_person_id}`, s);
  return [...byUrl.values()];
}

export function saveStore(dir: string, store: Stored[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSafe(storePath(dir), JSON.stringify(store, null, 1) + "\n");
}

export type Row = Stored & { scored: Scored };

export function scoreAll(spec: RoleSpec, store: Stored[], today = new Date()): Row[] {
  return rank(store.map(s => ({ ...s, scored: scoreCandidate(spec, s.person, { open: s.open, today }) })));
}

const fitOf = (p: Person) => p.fit ?? "";

/** Where someone worked before, newest first: "Example AI (Machine Learning Engineer, 2019 to 2023)". */
export function pastSummary(p: Person, n = 3): string[] {
  const year = (d?: string | null) => (d && /^\d{4}/.test(d) ? d.slice(0, 4) : "");
  return [...pastRoles(p)].sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? "")).slice(0, n)
    .map(r => { const span = [...new Set([year(r.start_date), year(r.end_date)].filter(Boolean))].join(" to "); return `${r.name ?? "unknown"} (${[r.title, span].filter(Boolean).join(", ")})`; });
}
export const educationSummary = (p: Person): string[] =>
  (p.education?.schools ?? []).filter(s => s.school).slice(0, 3).map(s => [s.degree, s.field_of_study].filter(Boolean).join(", ") ? `${[s.degree, s.field_of_study].filter(Boolean).join(", ")}, ${s.school}` : s.school!);

export const CANDIDATE_HEADER = ["rank", "score", "name", "current title", "company", "location", "headline", "years worked", "months in role", "fit",
  "open to new roles", "skills matched", "skills missing", "nice to have missing", "past employers", "education", "reasons", "why (AI)", "profile URL",
  "found", "crustdata person id"];

export function candidateRows(rows: Row[]): unknown[][] {
  return rows.map((r, i) => {
    const role = primaryRole(r.person);
    return [i + 1, r.scored.score, nameOf(r.person), role?.title ?? r.person.basic_profile?.current_title ?? "", role?.name ?? "", locationOf(r.person),
      r.person.basic_profile?.headline ?? "", r.scored.years ?? "", r.scored.monthsInRole ?? "", fitOf(r.person), r.scored.open ? "yes" : "",
      r.scored.matched, r.scored.missing, r.scored.niceMissing, pastSummary(r.person), educationSummary(r.person),
      r.scored.reasons.join("; "), r.why ?? "", r.url || profileUrl(r.person), r.batch.slice(0, 10), r.person.crustdata_person_id];
  });
}

export function writeCandidates(dir: string, rows: Row[]): string {
  const file = join(dir, "candidates.csv");
  writeCsv(file, CANDIDATE_HEADER, candidateRows(rows));
  return file;
}

/** Markdown text from a profile: no headings, links, autolinks or emphasis can be injected by a name or a title. */
const md = (s: string) => s.replace(/[\\`*_{}[\]<>#|]/g, m => `\\${m}`).replace(/\b(www)\./gi, "$1\\.").replace(/:\/\//g, ":\\/\\/").replace(/\s+/g, " ").trim();

export function shortlistMarkdown(spec: RoleSpec, rows: Row[], opts: { batch: string; top: number; totalNew: number; totalAll: number }): string {
  const pick = rows.filter(r => r.batch === opts.batch).slice(0, opts.top);
  const lines = [
    `# Shortlist: ${md(spec.title ?? spec.role)}`,
    "",
    `Role: ${md(spec.query ?? spec.role)}`,
    "",
    `Found ${opts.batch.slice(0, 10)}: ${opts.totalNew} new ${opts.totalNew === 1 ? "candidate" : "candidates"}, the top ${pick.length} below. candidates.csv has all ${opts.totalAll}. Each score is rules: every bullet is one reason.`,
    "",
  ];
  pick.forEach((r, i) => {
    const role = primaryRole(r.person);
    const at = [role?.title, role?.name && `at ${role.name}`].filter(Boolean).join(" ");
    lines.push(`## ${i + 1}. ${md(nameOf(r.person))} (score ${r.scored.score})`, "");
    lines.push([md(at || "No current role"), md(locationOf(r.person))].filter(Boolean).join(", "), "");
    const before = pastSummary(r.person), edu = educationSummary(r.person);
    if (before.length) lines.push(`Before: ${md(before.join("; "))}`, "");
    if (edu.length) lines.push(`Education: ${md(edu.join("; "))}`, "");
    if (r.why) lines.push(`> ${md(r.why)}`, "");
    for (const reason of r.scored.reasons) lines.push(`- ${md(reason)}`);
    const url = r.url || profileUrl(r.person);
    if (url && /^https:\/\//.test(url)) lines.push("", `[Profile](${url.replace(/[()\s]/g, encodeURIComponent)})`);
    lines.push("");
  });
  if (!pick.length) lines.push("No new candidates in this run.", "");
  return lines.join("\n");
}

export function writeShortlist(dir: string, text: string): string {
  const file = join(dir, "shortlist.md");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSafe(file, text);
  return file;
}
