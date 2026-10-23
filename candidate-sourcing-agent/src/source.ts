/**
 * npm run source: a role in, a ranked and explained shortlist out, skipping everyone already pulled.
 *
 *   1. read the role into a spec      rule-based parser plus flags; role.json keeps it for the next run
 *   2. check stored values            autocomplete, free, before any credit is spent (--dry-run stops here)
 *   3. count each round               how many people the place, then skills and years, then employer filters keep
 *   4. ranked search                  the role sentence ranks people inside the filters (mode "exact"), seen people excluded;
 *                                     every page is written to seen.csv and profiles.json as soon as it is billed
 *   5. open to new roles              one cheap search over the people found, billed only for those who are open
 *   6. score, write, explain          candidates.csv, shortlist.md; and what to change when too few came back
 *
 * npm run rescore scores the saved candidates again (after you change a weight in src/score.ts), free.
 */

import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, relative } from "node:path";
import { aiAvailable, factsFor, whySentences } from "./ai.js";
import { config } from "./config.js";
import { accountEndpoints, and, countPeople, fmtCredits, leaf, openToNewRoles, searchPeople, spend, type Person, type Remark, type SearchBody } from "./crustdata.js";
import { loadStore, mergeStore, saveStore, scoreAll, shortlistMarkdown, writeCandidates, writeShortlist, type Row, type Stored } from "./output.js";
import { currentRoles, nameOf, primaryRole, profileUrl, sameDomain } from "./profile.js";
import {
  FLAG_HELP, LIST_PRICE, buildConditions, describeKept, describeSpec, estimateCost, filtersOf, keepAcrossSentences, lastRole, loadRole, mergeSpec,
  parseFlags, parseSentence, pricesFrom, resultFields, roleDir, roleName, roundTitle, saveRole, validateSpec, type Condition, type Parsed, type RoleSpec,
} from "./role.js";
import { csvText } from "./csv.js";
import { addToSeen, excludeList, isSeenFile, loadSeen, mergeSeen, normalizeProfileUrl, SEEN_HEADER, type SeenRow } from "./seen.js";

export const USAGE = `Describe the role in one sentence:
  npm run source -- --role "Machine learning engineer, 4+ years, PyTorch, United States, at a company under 500 people"
Add --dry-run to see what it understood and the cost without spending anything.
Then run it again (npm run source -- --name <role>) for the next batch of new people.`;

const show = (path: string) => { const r = relative(process.cwd(), path); const p = !r || r.startsWith("..") ? path : r; return /[\s'"]/.test(p) ? JSON.stringify(p) : p; };
const pad = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n - 1) + "." : t.padEnd(n); };
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
/** Seen lists longer than this are sent in part (the newest people); the rest are dropped locally, after billing. */
export const MAX_EXCLUDE = 20_000;
/** Runs estimated above this many credits ask first, and need --yes when there is no terminal to ask in. */
export const ASK_ABOVE = 30;

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

/** Above ASK_ABOVE credits: ask in a terminal (default no); refuse without one unless --yes. */
export async function allowSpend(credits: number, yes: boolean, what: string, askAbove = ASK_ABOVE): Promise<boolean> {
  if (yes || credits <= askAbove) return true;
  const amount = `about ${Math.round(credits)} credits`;
  if (!process.stdin.isTTY) {
    console.log(`Not run: ${what} is ${amount}. Add --yes to run it without a terminal (a script or a coding agent).`);
    process.exitCode = 1;
    return false;
  }
  if (await confirm(`${what[0].toUpperCase()}${what.slice(1)} is ${amount}. Go ahead?`)) return true;
  console.log("Stopped, nothing was charged. A smaller --limit costs less.");
  return false;
}

// ---------------------------------------------------------------------------
// 1 and 2. The spec
// ---------------------------------------------------------------------------

export async function resolveSpec(argv: string[]) {
  const { flags, options } = parseFlags(argv);
  if (options.help) return { help: true as const };
  const sentence = flags.role ?? undefined;
  let parsed: Parsed | undefined = sentence ? parseSentence(sentence) : undefined;
  const name = flags.name ?? (sentence ? roleName({ ...parsed!.spec, ...(flags as Partial<RoleSpec>) }, sentence) : lastRole());
  if (!name) throw new Error(USAGE);
  const saved = loadRole(name);
  if (!sentence && !saved) throw new Error(`No saved role called "${name}" in ${show(config.outDir)}.\n${USAGE}`);
  const role = sentence ?? saved!.spec.role;
  const newSentence = !saved || saved.spec.role !== role;
  if (newSentence && !parsed) parsed = parseSentence(role);
  const base = !saved ? undefined : newSentence ? keepAcrossSentences(saved.spec, saved.fromFlags) : saved.spec;
  const spec = mergeSpec(base, { role, name }, newSentence ? parsed!.spec : undefined, flags);
  // Fields set by a flag, now or in an earlier run, are kept when the sentence changes.
  const fromFlags = [...new Set([...(saved?.fromFlags ?? []), ...Object.keys(flags).filter(k => k !== "role" && k !== "name" && flags[k as keyof typeof flags] != null)])];
  // What is kept is what the new sentence does not set itself.
  const keptLayer = saved && newSentence ? keepAcrossSentences(saved.spec, saved.fromFlags) : {};
  for (const k of Object.keys(parsed?.spec ?? {})) delete (keptLayer as Record<string, unknown>)[k];
  const kept = saved && newSentence ? describeKept(keptLayer) : "";
  return { help: false as const, spec, options, parsed: newSentence ? parsed : undefined, saved, newSentence, kept, fromFlags };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runSource(argv: string[]): Promise<void> {
  const resolved = await resolveSpec(argv);
  if (resolved.help) { console.log(`${USAGE}\n\n${FLAG_HELP}`); return; }
  const { spec: draft, options, parsed, saved, newSentence, kept, fromFlags } = resolved;
  const dir = roleDir(draft.name);
  console.log(`${saved ? (newSentence ? "New sentence for" : "Next batch for") : "New role"}: ${draft.name}  (files in ${show(dir)})`);
  if (kept) console.log(`  Same role folder, so these are kept from before: ${kept}. Clear one with --x none, or use --name <other> for a separate role.`);

  const { spec, problems, notes } = await validateSpec(draft, parsed?.skillCandidates ?? [], parsed?.sources ?? {});
  const conditions = buildConditions(spec);
  console.log("\n" + describeSpec(spec, conditions));
  for (const n of [...options.notes, ...(parsed?.notes ?? []), ...notes]) console.log(`  note:        ${n}`);
  if (problems.length) {
    console.error("\nFix these and run again (checking values is free, nothing was charged):\n" + problems.map(p => `  - ${p}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  // The seen lists: the role's own (or a shared one made by this tool), plus read-only --skip-from files.
  const seenFile = options.seen ?? saved?.seenFile ?? join(dir, "seen.csv");
  if (!isSeenFile(seenFile)) {
    const own = seenFile === join(dir, "seen.csv");
    throw new Error(own
      ? `${show(seenFile)} no longer looks like the seen list this tool wrote (was it saved again by a spreadsheet, with semicolons?). Save it as a plain comma CSV with the header "${SEEN_HEADER.join(",")}", or move it away and pass it with --skip-from.`
      : `${show(seenFile)} is not a seen list made by this tool, so it is never written to. Read it with --skip-from ${show(seenFile)} instead.`);
  }
  // Everyone this role has paid for counts, wherever it was written: the role's own seen.csv (also after switching to
  // a shared --seen list), the shared list, people saved in profiles.json, and fallback files from a run that could not
  // write its seen list (merged back in when possible).
  const roleSeen = join(dir, "seen.csv");
  const unsavedPrefix = `seen-unsaved-${draft.name}--`;
  const unsavedFiles = existsSync(config.outDir) ? readdirSync(config.outDir).filter(f => f.startsWith(unsavedPrefix) && f.endsWith(".csv")).map(f => join(config.outDir, f)).filter(f => !options.skipFrom.includes(f)) : [];
  for (const f of options.dryRun ? [] : unsavedFiles) {
    try { addToSeen(seenFile, [...loadSeen(f).byUrl.values()]); unlinkSync(f); console.log(`  note:        added the people in ${show(f)} (a run that could not write its seen list) to ${show(seenFile)}.`); }
    catch { console.log(`  note:        ${show(f)} still holds people billed in an earlier run; they are skipped.`); }
  }
  const storeSeen = { byUrl: new Map(loadStore(dir).filter(s => normalizeProfileUrl(s.url)).map(s => [normalizeProfileUrl(s.url), { url: s.url, name: "", firstSeen: "", id: s.person.crustdata_person_id }])), ids: new Set(loadStore(dir).map(s => s.person.crustdata_person_id)), rowsWithoutUrl: 0 };
  const own = mergeSeen([loadSeen(seenFile), ...(seenFile !== roleSeen ? [loadSeen(roleSeen)] : []), ...unsavedFiles.filter(existsSync).map(loadSeen), storeSeen]);
  // --skip-from files are remembered by the role, so a later --name run keeps skipping them.
  const skipFrom = options.skipFrom.length ? options.skipFrom : (saved?.skipFrom ?? []).filter(f => existsSync(f));
  if (!options.skipFrom.length && skipFrom.length) console.log(`  note:        still skipping the people in ${skipFrom.map(show).join(", ")} (saved with this role).`);
  const skips = skipFrom.map(f => ({ file: f, list: loadSeen(f) }));
  for (const s of skips) if (!s.list.byUrl.size) console.log(`  note:        ${s.file} has no profile URLs in it (${s.list.rowsWithoutUrl} rows read), so it skips nobody. Is it saved as a plain CSV?`);
  const seen = mergeSeen(options.fresh ? skips.map(s => s.list) : [own, ...skips.map(s => s.list)]);
  const seenBefore = seen.byUrl.size;
  // The role's own people come first (they were paid for); --skip-from lists fill what room is left.
  const ownUrls = options.fresh ? [] : excludeList(own);
  const ownPart = ownUrls.slice(-MAX_EXCLUDE);
  const skipUrls = excludeList(mergeSeen(skips.map(s => s.list))).filter(u => !own.byUrl.has(u));
  const exclude = [...ownPart, ...skipUrls.slice(0, Math.max(0, MAX_EXCLUDE - ownPart.length))];
  const allExclude = { length: ownUrls.length + skipUrls.length };
  // People seen before without a profile URL can only be excluded by their Crustdata id.
  const idsWithoutUrl = options.fresh ? [] : [...own.ids].filter(id => ![...own.byUrl.values()].some(r => r.id === id)).slice(-5000);
  // Read before anything is billed, so a broken file stops the run for free.
  const store = loadStore(dir);

  const prices = await accountEndpoints().then(pricesFrom).catch(() => LIST_PRICE);
  const userRounds = [...new Set(conditions.filter(c => c.clear).map(c => c.round))].sort();
  const probes = userRounds.slice(0, -1);
  const cost = estimateCost(spec, conditions, probes, prices);
  const ownCount = own.byUrl.size + idsWithoutUrl.length;
  const skipping = [options.fresh ? "nobody from this role's seen list (--fresh: they can come back and are billed again)" : ownCount ? `${plural(ownCount, "person", "people")} already pulled for this role, not billed again` : "nobody from this role yet",
    ...skips.map(s => `${plural(s.list.byUrl.size, "person", "people")} in ${show(s.file)}`)].join("; ");
  console.log(`  skipping:    ${skipping}`);
  if (allExclude.length > MAX_EXCLUDE) console.log(`  note:        ${allExclude.length.toLocaleString("en-US")} people to skip; ${MAX_EXCLUDE.toLocaleString("en-US")} are sent to Crustdata (this role's newest first, then --skip-from), so the others can come back, be billed again and be dropped here.`);
  console.log(`  cost:        ${cost.text}\n`);
  if (options.dryRun) {
    console.log("Dry run: nothing was searched or charged. Run the same command without --dry-run to search.");
    return;
  }
  if (!(await allowSpend(cost.credits, options.yes, "this search"))) return;
  // Saved before anything is billed, so a run that fails halfway can be resumed with --name.
  const remember = { seenFile: options.seen ?? saved?.seenFile, skipFrom, fromFlags };
  saveRole(spec, filtersOf(conditions), remember);

  // 3. Rounds: how many people each group of filters keeps, so you can see which one narrows the most.
  const funnel: Array<{ round: number; total: number }> = [];
  for (const round of probes) {
    const upTo = conditions.filter(c => c.round <= round);
    const before = spend.credits;
    const { total, remarks } = await countPeople(filtersOf(upTo)!);
    funnel.push({ round, total });
    console.log(`${roundTitle(round, conditions)}: ${plural(total, "person", "people")} (${fmtCredits(spend.credits - before)} credits)`);
    if (!total) return stopEmpty(spec, upTo, remarks, true);
  }

  // 4. The ranked search. Each billed page is checked and written to seen.csv and profiles.json at once.
  // The second guard is local: duplicates, seen people (any URL form, or by id), and anyone with any current role
  // at an excluded company (the API tests current roles one at a time).
  const batch = new Date().toISOString();
  let current = store;
  let rank = 0;
  const keep: Person[] = [], dropped: string[] = [];
  const ids = new Set<number>(), urls = new Set<string>();
  const unsaved: SeenRow[] = [];
  const onPage = (page: Person[]) => {
    const rows = page.map((p): SeenRow => ({ url: profileUrl(p), name: nameOf(p), firstSeen: batch.slice(0, 10), id: p.crustdata_person_id }));
    // A seen list that cannot be written (open in Excel on Windows, a read-only folder) must not lose people already
    // paid for: they are kept and written to a separate file at the end.
    try { addToSeen(seenFile, [...unsaved, ...rows]); unsaved.length = 0; } catch (err) { unsaved.push(...rows); if (unsaved.length === rows.length) console.log(`  note:        could not write ${show(seenFile)} (${(err as Error).message}).`); }
    const fresh: Person[] = [];
    for (const p of page) {
      const key = normalizeProfileUrl(profileUrl(p));
      if (ids.has(p.crustdata_person_id) || (key && urls.has(key))) continue;
      ids.add(p.crustdata_person_id);
      if (key) urls.add(key);
      if ((key && seen.byUrl.has(key)) || seen.ids.has(p.crustdata_person_id)) { dropped.push(`${nameOf(p)} (already seen)`); continue; }
      const at = spec.exclude?.find(d => currentRoles(p).some(r => sameDomain(r.company_website, d)));
      if (at) { dropped.push(`${nameOf(p)} (currently at ${at})`); continue; }
      fresh.push(p);
    }
    keep.push(...fresh);
    current = mergeStore(current, fresh.map(p => ({ url: profileUrl(p), person: p, batch, apiRank: ++rank, open: !!spec.openOnly })));
    try { saveStore(dir, current); } catch (err) { console.log(`  note:        could not write profiles.json (${(err as Error).message}).`); }
  };
  const flushUnsaved = () => {
    if (!unsaved.length) return;
    const file = join(config.outDir, `seen-unsaved-${spec.name}--${batch.replace(/[:.]/g, "-")}.csv`);
    let where = file;
    try { writeFileSync(file, csvText(SEEN_HEADER, unsaved.map(r => [r.url, r.name, r.firstSeen, r.id ?? ""])), { mode: 0o600 }); }
    catch { where = "(could not write a file either)"; console.log(unsaved.map(r => `  ${r.url} ${r.id}`).join("\n")); }
    console.log(`\n${plural(unsaved.length, "person", "people")} billed in this run could not be added to ${show(seenFile)}. They are in ${show(where)}: close the seen list if a spreadsheet has it open; the next run of this role adds them back to the seen list automatically, so they are not billed again.`);
  };
  const body: SearchBody = {
    search: spec.keywords ? { query: spec.keywords, mode: "lexical", query_syntax: "boolean" } : { query: spec.query ?? spec.role, mode: "hybrid" },
    mode: "exact",
    filters: idsWithoutUrl.length ? and(filtersOf(conditions), leaf("crustdata_person_id", "not_in", idsWithoutUrl)) : filtersOf(conditions),
    fields: resultFields(spec),
    ...(exclude.length ? { post_processing: { exclude_profiles: exclude } } : {}),
  };
  const before = spend.credits;
  let result: Awaited<ReturnType<typeof searchPeople>>;
  try {
    result = await searchPeople(body, spec.limit, msg => console.log(`  note:        ${msg}`), onPage);
  } catch (err) {
    flushUnsaved();
    throw new Error(`${(err as Error).message}\nRun again with: npm run source -- --name ${spec.name}   (everyone already billed is skipped)`);
  }
  flushUnsaved();
  const { profiles, total } = result;
  const lastRound = userRounds[userRounds.length - 1];
  if (lastRound) console.log(`${roundTitle(lastRound, conditions)}: ${plural(total ?? profiles.length, "new person matches", "new people match")} every filter${seenBefore ? " (not counting those already seen)" : ""}`);
  console.log(`Ranked search: ${profiles.length} returned and billed, ${fmtCredits(spend.credits - before)} credits`);
  try { saveRole(spec, filtersOf(conditions), remember); } catch { /* saved before the search already */ }

  if (!profiles.length) {
    if (total) {
      console.log(`\nNo more ranked results for this query, although ${plural(total, "person matches", "people match")} the filters: Crustdata's ranked list ends after 10,000 people. Make the sentence more specific, add a filter, or try --keywords.`);
      return;
    }
    // Free when nobody matches; one counted result when everyone who matches was seen before.
    const { total: matching, remarks } = await countPeople(filtersOf(conditions)!);
    if (matching) {
      console.log(`\nNobody new: all ${plural(matching, "person", "people")} who match were pulled before (${show(seenFile)}). Widen a filter, or add --fresh to see them again (billed again).`);
      return;
    }
    return stopEmpty(spec, conditions, remarks, true, true);
  }

  if (dropped.length) console.log(`  dropped here: ${dropped.length} (${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? ", ..." : ""})`);
  const elsewhere = pulledForOtherRoles(spec.name, keep);
  if (elsewhere) console.log(`  note:        ${elsewhere}`);

  // 5. Open to new roles. A failure here keeps everything found; only the bonus is missing.
  let open = new Set<number>();
  if (!spec.openOnly && keep.length) {
    const b = spend.credits;
    try {
      open = await openToNewRoles(keep.map(p => p.crustdata_person_id));
      console.log(`Open to new roles: ${open.size} of ${keep.length} (${fmtCredits(spend.credits - b)} credits, billed only for those who are)`);
    } catch (err) {
      console.log(`  note:        the open-to-new-roles check failed (${(err as Error).message}); everyone found is saved without it.`);
    }
  }

  // 6. Score, write, explain.
  let final: Stored[] = current.map(s => (s.batch === batch ? { ...s, open: !!spec.openOnly || open.has(s.person.crustdata_person_id) } : s));
  let rows = scoreAll(spec, final);

  if (options.ai) {
    if (!aiAvailable()) console.log("  note:        --ai needs ANTHROPIC_API_KEY (or OPENAI_API_KEY and OPENAI_MODEL) in .env; the shortlist is written without the AI sentence.");
    else {
      const top = rows.filter(r => r.batch === batch).slice(0, options.top);
      console.log(`Writing the "why this candidate" sentence for ${plural(top.length, "person", "people")} with ${aiAvailable() === "anthropic" ? "Claude" : "OpenAI"}...`);
      const sentences = await whySentences(top.map(r => ({ facts: factsFor(spec, r.person, r.scored) })), msg => console.log(`  note:        ${msg}`));
      const why = new Map(top.map((r, i) => [r.person.crustdata_person_id, sentences[i]]));
      final = final.map(s => (why.get(s.person.crustdata_person_id) ? { ...s, why: why.get(s.person.crustdata_person_id) } : s));
      rows = scoreAll(spec, final);
    }
  }

  saveStore(dir, final);
  const csv = writeCandidates(dir, rows);
  const md = writeShortlist(dir, shortlistMarkdown(spec, rows, { batch, top: options.top, totalNew: keep.length, totalAll: rows.length }));
  const seenNow = loadSeen(seenFile).byUrl.size;

  printTop(rows.filter(r => r.batch === batch), options.top);
  console.log(`\nDone. ${plural(keep.length, "new candidate")} (${rows.length} in total for this role), ${fmtCredits(spend.credits)} credits in this run.`);
  console.log(`  ${show(md)}   the top ${Math.min(options.top, keep.length)} for the hiring manager`);
  console.log(`  ${show(csv)}   everyone, with every reason`);
  console.log(`  ${show(seenFile)}   ${plural(seenNow, "person", "people")} the next run skips`);
  const again = `npm run source -- --name ${spec.name}`;
  if ((total ?? profiles.length) < spec.limit) tooFew(spec, conditions, funnel, total ?? profiles.length, seenBefore);
  else console.log(`Next batch: ${again}   (the people above are skipped and not billed again)`);
  if (!options.noWatchHint && config.watchHint) {
    console.log(`Want new matches for this role every week? \`npm run watch-example -- --name ${spec.name}\` writes the Crustdata watcher request; nothing is created until you send it.`);
  }
}

/** People in this batch who were already pulled for another role in out/ (each role has its own seen list). */
function pulledForOtherRoles(name: string, people: Person[]): string {
  if (!existsSync(config.outDir)) return "";
  const hits: string[] = [];
  for (const d of readdirSync(config.outDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === name) continue;
    const other = loadSeen(join(config.outDir, d.name, "seen.csv"));
    const n = people.filter(p => other.byUrl.has(normalizeProfileUrl(profileUrl(p))) || other.ids.has(p.crustdata_person_id)).length;
    if (n) hits.push(`${n} for ${d.name}`);
  }
  return hits.length ? `some of these people were also pulled for other roles (${hits.join(", ")}). Each role has its own seen list; share one with --seen out/team-seen.csv.` : "";
}

function printTop(rows: Row[], n: number) {
  if (!rows.length) return;
  console.log(`\n  ${pad("#", 3)} ${pad("score", 5)} ${pad("name", 26)} ${pad("current title", 34)} ${pad("company", 22)} years`);
  rows.slice(0, n).forEach((r, i) => {
    const role = primaryRole(r.person);
    console.log(`  ${pad(i + 1, 3)} ${pad(r.scored.score, 5)} ${pad(nameOf(r.person), 26)} ${pad(role?.title, 34)} ${pad(role?.name, 22)} ${r.scored.years === undefined ? "" : Math.floor(r.scored.years)}`);
  });
}

/** An empty result. The free explain step names the filter that removed everyone; this turns it into a flag to change. */
function stopEmpty(spec: RoleSpec, used: Condition[], remarks: Remark[], roleSaved: boolean, afterSearch = false) {
  console.log(afterSearch ? "\nNobody matches these filters." : "\nNobody matches these filters, so no ranked search ran.");
  const again = roleSaved ? `npm run source -- --name ${spec.name}` : `npm run source -- --role ${JSON.stringify(spec.role)}`;
  const named = remarks
    .filter(r => r.code === "condition_eliminates_all")
    .map(r => ({ c: r.path === "filters" ? used[0] : used[Number(/conditions\[(\d+)\]/.exec(r.path ?? "")?.[1] ?? -1)], without: r.matches_without }))
    .filter(x => x.c?.clear);
  for (const { c, without } of named) console.log(`  "${c!.label}" removes everyone${without ? ` (${without.toLocaleString("en-US")} match without it)` : ""}. Try: ${again} ${c!.clear}`);
  if (!named.length) {
    console.log(`  No single filter is to blame${used.length > 6 ? " (Crustdata checks the first six filters one at a time)" : ""}. Loosen two of them (fewer --must skills, a lower --years, --size none) and run again.`);
  }
  process.exitCode = 1;
}

/** Fewer new people than asked for: name the round that narrowed the most, and the flags that widen it. */
function tooFew(spec: RoleSpec, conditions: Condition[], funnel: Array<{ round: number; total: number }>, matching: number, seenCount: number) {
  console.log(`\nOnly ${plural(matching, "new person matches", "new people match")} every filter${seenCount ? ` (${seenCount} already seen were skipped)` : ""}, fewer than the ${spec.limit} asked for.`);
  const steps = [...funnel, { round: [...conditions].reverse().find(c => c.clear)?.round ?? 3, total: matching + seenCount }];
  let worst: { round: number; ratio: number; from: number; to: number } | undefined;
  for (let i = 1; i < steps.length; i++) {
    const ratio = steps[i - 1].total ? steps[i].total / steps[i - 1].total : 1;
    if (!worst || ratio < worst.ratio) worst = { round: steps[i].round, ratio, from: steps[i - 1].total, to: steps[i].total };
  }
  const round = worst?.round ?? steps[0].round;
  const flags = [...new Set(conditions.filter(c => c.round === round && c.clear).map(c => c.clear))];
  if (worst) console.log(`The step that cut the most: ${roundTitle(round, conditions).replace(/^Round \d: /, "")} (from ${worst.from.toLocaleString("en-US")} to ${worst.to.toLocaleString("en-US")}).`);
  if (flags.length) console.log(`To widen it, change one of: ${flags.join(", ")}. For example: npm run source -- --name ${spec.name} ${flags[0]}`);
  console.log("Nothing more was searched or charged.");
}

// ---------------------------------------------------------------------------
// npm run rescore: score the saved candidates again, free. Use it after changing a weight in src/score.ts.
// ---------------------------------------------------------------------------

export async function runRescore(argv: string[]): Promise<void> {
  const { flags, options } = parseFlags(argv);
  const extra = Object.keys(flags).filter(k => k !== "name");
  if (extra.length) throw new Error(`rescore keeps the saved role and takes only --name and --top. To change the role, pass ${extra.map(k => `--${k}`).join(", ")} to npm run source instead.`);
  const name = flags.name ?? lastRole();
  const saved = name ? loadRole(name) : undefined;
  if (!name || !saved) throw new Error(`No saved role${name ? ` called "${name}"` : ""} to rescore. Run npm run source first.`);
  const dir = roleDir(name);
  const store = loadStore(dir);
  if (!store.length) throw new Error(`No candidates saved for ${name} yet. Run npm run source first.`);
  const rows = scoreAll(saved.spec, store);
  const latest = store.map(s => s.batch).sort().pop()!;
  writeCandidates(dir, rows);
  writeShortlist(dir, shortlistMarkdown(saved.spec, rows, { batch: latest, top: options.top, totalNew: rows.filter(r => r.batch === latest).length, totalAll: rows.length }));
  printTop(rows, options.top);
  console.log(`\nRescored ${plural(rows.length, "candidate")} for ${name} with the weights in src/score.ts. No credits used.`);
  console.log(`  ${show(join(dir, "candidates.csv"))}\n  ${show(join(dir, "shortlist.md"))}`);
}
