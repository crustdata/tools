/**
 * npm run forget -- <profile URL>: remove one person from every role's files, for example when they ask you to.
 *
 * The person is taken out of profiles.json, candidates.csv, shortlist.md and contacts.csv in every role folder. Their
 * profile URL stays in every seen list (each role's seen.csv, any shared --seen list a role uses, and seen lists at
 * the top of out/), with the name blanked, so no later run pulls them again; --erase removes that line too (then a
 * later search can return them again). Files passed with --skip-from (an ATS export) are never changed: remove the
 * person there yourself. No credits, no network.
 */

import "./node-check.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { config } from "./config.js";
import { csvText, parseCsv } from "./csv.js";
import { loadStore, saveStore, scoreAll, shortlistMarkdown, writeCandidates, writeShortlist } from "./output.js";
import { profileUrl } from "./profile.js";
import { loadRole, writeFileSafe } from "./role.js";
import { isSeenFile, normalizeProfileUrl, withLock } from "./seen.js";

/** Rewrites one CSV without the rows whose profile URL is `key`; with `blankName`, keeps the row and empties column 1. */
function filterCsv(file: string, key: string, blankName: boolean): number {
  if (!existsSync(file)) return 0;
  const rows = parseCsv(readFileSync(file, "utf8"));
  if (!rows.length) return 0;
  const [header, ...body] = rows;
  let hits = 0;
  const kept = body.flatMap(r => {
    if (!r.some(c => normalizeProfileUrl(c) === key)) return [r];
    hits++;
    return blankName ? [r.map((c, i) => (i === 1 ? "" : c))] : [];
  });
  if (hits) writeFileSafe(file, csvText(header, kept));
  return hits;
}

export async function runForget(argv: string[]): Promise<void> {
  const erase = argv.includes("--erase");
  const target = argv.find(a => !a.startsWith("--"));
  const key = normalizeProfileUrl(target);
  if (!key) throw new Error("Give the person's profile URL: npm run forget -- <profile URL> [--erase]");
  if (!existsSync(config.outDir)) { console.log(`Nothing to do: there is no ${config.outDir} folder.`); return; }

  let touched = 0;
  const seenFiles = new Set<string>();
  const skipFiles = new Set<string>();
  for (const f of readdirSync(config.outDir, { withFileTypes: true })) if (f.isFile() && f.name.endsWith(".csv")) seenFiles.add(resolve(config.outDir, f.name));
  for (const d of readdirSync(config.outDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(config.outDir, d.name);
    let here = 0;
    const store = loadStore(dir);
    const rest = store.filter(s => normalizeProfileUrl(s.url || profileUrl(s.person)) !== key);
    if (rest.length !== store.length) {
      here++;
      saveStore(dir, rest);
      const saved = loadRole(d.name);
      if (saved) {
        const rows = scoreAll(saved.spec, rest);
        writeCandidates(dir, rows);
        const latest = rest.map(s => s.batch).sort().pop() ?? "";
        writeShortlist(dir, shortlistMarkdown(saved.spec, rows, { batch: latest, top: 10, totalNew: rows.filter(r => r.batch === latest).length, totalAll: rows.length }));
      }
    }
    here += filterCsv(join(dir, "contacts.csv"), key, false);
    seenFiles.add(resolve(dir, "seen.csv"));
    const role = loadRole(d.name);
    if (role?.seenFile) seenFiles.add(resolve(role.seenFile));
    for (const f of role?.skipFrom ?? []) skipFiles.add(resolve(f));
    if (here) { touched++; console.log(`  ${d.name}: removed`); }
  }
  for (const file of seenFiles) {
    if (!existsSync(file) || !isSeenFile(file)) continue;
    // Locked like a run's own writes, so a run sharing the list at this moment loses nobody.
    if (withLock(file, () => filterCsv(file, key, !erase))) { touched++; console.log(`  ${file}: ${erase ? "removed" : "name blanked, profile URL kept so no later run pulls them"}`); }
  }
  for (const file of skipFiles) {
    if (existsSync(file) && readFileSync(file, "utf8").split(/\r?\n/).some(line => line.split(/[,;]/).some(c => normalizeProfileUrl(c) === key))) {
      console.log(`  ${file}: this person is in a --skip-from file, which this tool never changes. Remove them there yourself.`);
    }
  }
  console.log(touched
    ? `Done. ${erase ? "Removed everywhere, including the seen lists (a later search can return this person again)." : "Removed from every role's files; the profile URL stays in seen.csv (name blanked) so no later run pulls them again. --erase removes that too."}`
    : "That profile URL is in no role folder.");
}
