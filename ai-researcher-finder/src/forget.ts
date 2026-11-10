/**
 * npm run forget -- <profile URL, Google Scholar URL or Crustdata person id> [more ...]
 *
 * For a removal request. Deletes the person from every search folder under out/ (people.json, then report.md and
 * researchers.csv are written again without them), from the seed lookups (seeds.json), Claude's answers (ai.json)
 * and any watcher request written (watch-request.json), and adds them to out/suppressed.json: no later run stores
 * them, a seed looked up before never fetches them again, and every search skips their profile URL so they are not
 * billed again. Offline, free.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { config, ROOT } from "./config.js";
import type { Person } from "./crustdata.js";
import { folderFor, readJson, readSuppressed, scholarId, scoreAndWrite, shown, suppressedFile, urlKey, writeJson } from "./find.js";
import { profileUrlOf, scholarUrl } from "./profile.js";
import { loadRubric, type Found, type Rubric } from "./rubric.js";
import { classify, type Seed } from "./seeds.js";
import { loadTaxonomy } from "./teams.js";

export async function runForget(argv: string[]): Promise<void> {
  const targets = argv.filter(a => !a.startsWith("--"));
  if (!targets.length) throw new Error("Pass who to remove: npm run forget -- <profile URL, Google Scholar URL or Crustdata person id>");
  const ids = targets.filter(t => /^\d+$/.test(t)).map(Number);
  const urls = targets.filter(t => !/^\d+$/.test(t));
  const bad = urls.filter(u => !/^https?:\/\//i.test(u));
  if (bad.length) throw new Error(`Not a person id or a URL: ${bad.join(", ")}`);
  // Google Scholar URLs are kept by their user id; profile URLs in their usual form (no query, www, https).
  const scholarIds = urls.map(u => (/scholar\.google\./i.test(u) ? scholarId(u) : undefined)).filter(Boolean) as string[];
  const profileUrls = urls.filter(u => !/scholar\.google\./i.test(u)).map(u => { const c = classify(u); return c && "kind" in c && c.kind === "profile" ? c.value : u.trim(); });
  const keys = profileUrls.map(urlKey);

  const matches = (p: Person) => ids.includes(p.crustdata_person_id)
    || (!!profileUrlOf(p) && keys.includes(urlKey(profileUrlOf(p))))
    || (!!scholarId(scholarUrl(p)) && scholarIds.includes(scholarId(scholarUrl(p))!));

  // The suppressed list is written first, so even if a folder below cannot be rewritten, no later run stores them.
  const suppressed = readSuppressed();
  suppressed.scholar ??= [];
  const addId = (id: number) => { if (!suppressed.ids.includes(id)) suppressed.ids.push(id); };
  const addUrl = (u: string) => { if (u && !suppressed.urls.some(x => urlKey(x) === urlKey(u))) suppressed.urls.push(u); };
  const addScholar = (id?: string) => { if (id && !suppressed.scholar!.includes(id)) suppressed.scholar!.push(id); };
  ids.forEach(addId); profileUrls.forEach(addUrl); scholarIds.forEach(addScholar);
  const folders = existsSync(config.outDir) ? readdirSync(config.outDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
  const found: Found[] = [];
  for (const name of folders) {
    const file = join(folderFor(name), "people.json");
    if (!existsSync(file)) continue;
    try { for (const f of readJson<Found[]>(file, [])) if (matches(f.person)) found.push(f); } catch { /* reported below */ }
  }
  for (const f of found) { addId(f.person.crustdata_person_id); addUrl(profileUrlOf(f.person)); addScholar(scholarId(scholarUrl(f.person))); }
  writeJson(suppressedFile(), suppressed);

  const taxNames = loadTaxonomy().map(t => t.team);
  const goneIds = new Set(suppressed.ids);
  const goneUrls = new Set(suppressed.urls.map(urlKey));
  let people = 0, places = 0, watchers = 0;
  const problems: string[] = [];
  for (const name of folders) {
    const dir = folderFor(name);
    try {
      const file = join(dir, "people.json");
      if (!existsSync(file)) continue;
      const list = readJson<Found[]>(file, []);
      const gone = list.filter(f => matches(f.person));
      // Seed lookups that point at them, Claude's cached answers, people dropped earlier, the saved seeds.
      const seedsFile = join(dir, "seeds.json");
      if (existsSync(seedsFile)) {
        const seeds = readJson<Record<string, { id?: number; status: string }>>(seedsFile, {});
        for (const [k, v] of Object.entries(seeds)) {
          if ((v.id && goneIds.has(v.id)) || (k.startsWith("scholar:") && scholarIds.includes(scholarId(k.slice(8)) ?? "")) || (k.startsWith("profile:") && goneUrls.has(urlKey(k.slice(8))))) delete seeds[k];
          else if (v.status.startsWith("authors:")) v.status = `authors:${v.status.slice(8).split(",").filter(x => x && !goneIds.has(Number(x))).join(",")}`;
        }
        writeJson(seedsFile, seeds);
      }
      const aiFile = join(dir, "ai.json");
      if (existsSync(aiFile)) {
        const ai = readJson<Record<string, unknown>>(aiFile, {});
        for (const k of Object.keys(ai)) if (goneIds.has(Number(k.split(":")[0]))) delete ai[k];
        writeJson(aiFile, ai);
      }
      const droppedFile = join(dir, "dropped.json");
      if (existsSync(droppedFile)) writeJson(droppedFile, readJson<string[]>(droppedFile, []).filter(u => !goneUrls.has(urlKey(u))));
      const runFile = join(dir, "run.json");
      if (existsSync(runFile)) {
        const run = readJson<{ seeds?: Seed[]; [k: string]: unknown }>(runFile, {});
        if (run.seeds) {
          run.seeds = run.seeds.filter(x => !(x.kind === "scholar" && scholarIds.includes(scholarId(x.value) ?? "")) && !(x.kind === "profile" && goneUrls.has(urlKey(x.value))));
          writeJson(runFile, run);
        }
      }
      const watchFile = join(dir, "watch-request.json");
      if (existsSync(watchFile)) {
        const body = readJson<{ entities?: { professional_network_profile_urls?: string[] } }>(watchFile, {});
        const urlsIn = body.entities?.professional_network_profile_urls ?? [];
        const kept = urlsIn.filter(u => !goneUrls.has(urlKey(u)));
        if (kept.length !== urlsIn.length) { body.entities!.professional_network_profile_urls = kept; writeJson(watchFile, body); watchers++; }
      }
      if (!gone.length) continue;
      writeJson(file, list.filter(f => !matches(f.person)));
      people += gone.length; places++;
      console.log(`Removed ${gone.length} ${gone.length === 1 ? "person" : "people"} from ${shown(dir)}`);
      // The report and CSV are written again with the folder's own rubric (or the default one if it is gone).
      const run = readJson<{ spec?: { rubricFile?: string; top?: number } }>(runFile, {});
      let rubric: Rubric;
      try { rubric = loadRubric(run.spec?.rubricFile ? resolve(run.spec.rubricFile) : join(ROOT, "rubric.json"), taxNames); }
      catch { rubric = loadRubric(join(ROOT, "rubric.json"), taxNames); }
      await scoreAndWrite(name, rubric, { ai: false, top: run.spec?.top ?? 25, silent: true });
    } catch (err) {
      // If a folder cannot be written again, its report and CSV are deleted so they cannot name the person.
      for (const f of ["report.md", "researchers.csv"]) rmSync(join(dir, f), { force: true });
      problems.push(`${shown(dir)}: ${(err as Error).message} (its report and CSV were deleted; run npm run rescore -- --name ${name} after fixing it)`);
    }
  }
  console.log(`${people ? `Removed ${people} ${people === 1 ? "person" : "people"} from ${places} folder${places === 1 ? "" : "s"}.` : "Not found in any search folder."} Added to ${shown(suppressedFile())}: no later run stores them or fetches them again.`);
  for (const pr of problems) console.log(`Problem: ${pr}`);
  if (watchers) console.log(`Also removed from ${watchers} watcher request${watchers === 1 ? "" : "s"}. If you already created a Crustdata watcher from one, remove them there too (PATCH the watch's entities, or edit it at https://app.crustdata.com/watch).`);
  const urlless = ids.filter(id => !found.some(f => f.person.crustdata_person_id === id && profileUrlOf(f.person)));
  if (urlless.length && !profileUrls.length) console.log("Forgotten by id only, with no profile URL on file: a search can skip people only by profile URL, so if one returns them, they are dropped after the search (billed). Pass their profile URL to keep them unbilled.");
  console.log("Delete any copies you shared outside out/ yourself.");
  if (problems.length) process.exitCode = 1;
}
