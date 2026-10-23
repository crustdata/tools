/**
 * npm run source: thesis in, scored pipeline with founders and memos out.
 *
 *   1. read the thesis into filters      rule-based parser plus flags; flags win; printed before anything else
 *   2. validate categorical values       autocomplete, free, before any credit is spent
 *   3. ranked company search             one search with all filters (--explain runs it in rounds to show what each drops)
 *   4. founders at each company          person search on founder, CEO and CTO titles, checked again per company
 *   5. roles posted                      job search counts, free
 *   6. founders' posts                   counts for the top companies, free; quotes for the top few, 0.5 a post
 *   7. newest role titles                for the top hiring companies, 0.03 a listing
 *   8. score, rank, mark new and gone    score.ts and pipeline.ts, pure
 *   9. write pipeline.csv, founders.csv, pipeline.md, memos/, data.json, history.json, thesis.json
 *
 * Steps 3 to 7 are saved as they go (after every batch and every company), to .partial-<id>.json. If a run stops (out
 * of credits, a network error), running the same command again within 24 hours picks up where it stopped and does
 * not pay again for anything already paid.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { config, paths } from "./config.js";
import {
  CrustdataError, and, countPosts, distinctRoles, fetchPosts, fmtCredits, jobCounts, leaf, newestJobs, or, postFilters, raisePostFilters,
  searchCompanies, searchPeople, spend,
} from "./crustdata.js";
import { FOUNDER_TITLES, pickFounders } from "./founders.js";
import { EMPTY_JOBS, buildPipeline, domainsFromCsv, domainsInCell, rescore, updateHistory, type Inputs } from "./pipeline.js";
import { POST_WINDOW_MONTHS, RAISE_ACTIONS, RAISE_PHRASES, RAISE_ROUNDS, TRACTION_PHRASES, daysAgo, monthsAgo, toQuote } from "./signals.js";
import {
  USAGE, buildRounds, costOf, describeSpec, estimateCost, keepAcrossSentences, loadThesis, mergeSpec, parseFlags, parseSentence, pipelineKey,
  resolveDates, sameSpec, saveThesis, searchKey, sentenceWarnings, specWarnings, validateSpec, whyDropped, type SpecLayer, type ThesisSpec,
} from "./thesis.js";
import { clearPartial, historyFor, loadData, loadHistory, loadPartial, savePartial, writeAll, type PartialRun, type SavedData } from "./output.js";
import { aiProvider, analyse } from "./ai.js";
import type { Deal, RawCompany, RawProfile } from "./types.js";

/** Re-running the same search sooner than this asks for --force: a re-run costs credits and shows little that is new. */
const RERUN_HOURS = 20;
/** Founder results asked for per company, so a company with many co-founders cannot crowd out the rest of a batch. */
const PEOPLE_PER_COMPANY = 6;
const PEOPLE_BATCH = 10;
/** Over this many companies, a run asks first (in a terminal) or needs --yes (in a script). */
const CONFIRM_ABOVE = 25;

/** Text from the API printed to the terminal: no control characters or escape sequences, cut to a width. */
export const safe = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const pad = (s: unknown, n: number) => { const t = safe(s); return t.length > n ? t.slice(0, n - 1) + "." : t.padEnd(n); };
const r = (n: number) => (n < 10 ? Math.round(n * 10) / 10 : Math.round(n));

export async function runSource(argv: string[]): Promise<void> {
  const { flags, out: outDir, excludeReset, yes, fresh, explain, force, ai, noWatchHint } = parseFlags(argv);
  if (outDir) process.env.OUT_DIR = outDir;
  const now = new Date();
  if (ai && !aiProvider()) throw new Error("--ai needs ANTHROPIC_API_KEY or OPENAI_API_KEY in .env. Without it, leave out --ai: the memos are complete without it.");

  // 1. The thesis: saved thesis.json, then what the sentence says, then flags.
  const saved = fresh ? undefined : loadThesis();
  if (flags.exclude) {
    // Exclusions add up across runs (last week's passes stay out); --exclude none clears them.
    const added = expandExclude(flags.exclude);
    const before = excludeReset ? [] : saved?.spec.exclude ?? [];
    const fresh = added.filter(d => !before.includes(d));
    // Sorted, so passing a domain that is already saved changes nothing (and costs nothing).
    flags.exclude = [...new Set([...before, ...added])].sort();
    const n = (k: number) => `${k} domain${k === 1 ? "" : "s"}`;
    console.log(`exclude: ${n(flags.exclude.length)} (${before.length} kept from the last run, ${fresh.length} new; --exclude none clears them)`);
  }
  const sentence = flags.thesis ?? saved?.spec.thesis;
  if (!sentence) throw new Error(USAGE);
  const newSentence = !saved || sentence !== saved.spec.thesis;
  const base: SpecLayer | undefined = !saved ? undefined : newSentence ? keepAcrossSentences(saved.spec) : saved.spec;
  const parsed = newSentence ? parseSentence(sentence, now) : undefined;
  const warnings = newSentence ? sentenceWarnings(sentence, parsed!, flags) : [];
  const spec = mergeSpec(base, { thesis: sentence }, parsed, flags);
  if (saved && newSentence) console.log(`New thesis. Your lists, limits and timing from the last run are kept (${paths.thesis()}); --fresh drops them.`);

  // Same search as last time: re-score for free when only scoring flags changed; refuse a quick paid repeat.
  const data = loadData();
  if (saved && !newSentence && data && searchKey(spec) === searchKey(saved.spec) && !force) {
    // Companies left out by --only-founders-from were never saved, so a change to that list needs a new search.
    const listChanged = JSON.stringify([spec.foundersFrom, spec.onlyFoundersFrom]) !== JSON.stringify([saved.spec.foundersFrom, saved.spec.onlyFoundersFrom]);
    const canRescore = !(listChanged && (spec.onlyFoundersFrom || saved.spec.onlyFoundersFrom));
    const hours = (now.getTime() - Date.parse(saved.savedAt)) / 3_600_000;
    // Within 20 hours, a scoring change or a missing analysis is handled on the saved data; after that, search again.
    const missingAnalysis = ai && data.deals.some(d => !d.analysis);
    if (canRescore && hours < RERUN_HOURS && (!sameSpec(spec, saved.spec) || missingAnalysis)) return rescoreSaved(spec, data, now, ai, saved.savedAt);
    if (canRescore && !sameSpec(spec, saved.spec) && hours >= RERUN_HOURS) console.log("Scoring settings changed, and the saved data is over 20 hours old: searching again.");
    else if (canRescore && hours < RERUN_HOURS) {
      console.log(`Nothing changed since the last run (${saved.savedAt.slice(0, 16).replace("T", " ")} UTC), so nothing was searched.`);
      console.log("Running the same thesis again later shows what is new, what changed and what is gone; --force runs it now (it costs credits).");
      return;
    }
  }

  // 2. Show what was understood, then validate (free).
  const run = resolveDates(spec, now);
  const rounds = buildRounds(run);
  const runRounds = explain ? rounds : rounds.slice(-1);
  console.log("\nThesis filters:\n" + describeSpec(run));
  for (const w of [...warnings, ...specWarnings(run)]) console.log(`  note:          ${w}`);
  console.log(`  cost:          ${estimateCost(run, runRounds.length)}\n`);
  const { spec: valid, problems } = await validateSpec(run);
  if (problems.length) {
    console.error("Fix these and run again (nothing was charged):\n" + problems.map(p => `  - ${p}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  if (valid.limit > CONFIRM_ABOVE && !yes) {
    const { typical, max } = costOf(valid, runRounds.length);
    const what = `${valid.limit} companies (about ${r(typical)} credits at list price, at most ${r(max)})`;
    if (!process.stdin.isTTY) throw new Error(`Sourcing ${what} needs --yes when it is not run in a terminal, so a script never spends that by surprise.`);
    if (!(await confirm(`Source ${what}?`))) { console.log("Stopped. --limit 10 runs a small first pass."); return; }
  }

  // Steps 3 to 7, saved as they go so a failure never pays twice.
  const runKey = `${searchKey(spec)}|rounds:${runRounds.length}`;
  const partial = fresh ? undefined : loadPartial(runKey, now);
  const state: PartialRun = partial ?? { key: runKey, startedAt: now.toISOString(), done: [], inputs: { companies: [], profiles: [], jobs: {}, posts: {} }, progress: {} };
  const inputs = state.inputs;
  const done = new Set(state.done);
  const save = () => { state.done = [...done]; savePartial(state); };
  const step = (name: string) => { done.add(name); save(); };
  const progress = (name: string) => new Set(state.progress[name] ?? []);
  const mark = (name: string, ids: number[]) => { state.progress[name] = [...new Set([...(state.progress[name] ?? []), ...ids])]; save(); };
  if (partial) console.log(`Resuming the run started ${state.startedAt.slice(0, 16).replace("T", " ")} UTC: ${[...done].join(", ") || "part of the first step"} already done and not paid for again.\n`);

  // 3. Company search. Every page is saved; a resumed search asks only for the companies it does not have yet (the
  // ranking of the rest stays the same), so pages already paid for are not paid again.
  if (!done.has("companies")) {
    const savePage = (page: RawCompany[]) => { inputs.companies.push(...page); save(); };
    if (inputs.companies.length) {
      const have = inputs.companies.map(c => c.crustdata_company_id);
      const last = runRounds.at(-1)!;
      console.log(`Company search: ${have.length} companies already fetched, asking for the remaining ${Math.max(0, valid.limit - have.length)}.`);
      if (valid.limit > have.length)
        await searchCompanies(valid.query, and(last.filters, leaf("crustdata_company_id", "not_in", have)), valid.limit - have.length, savePage);
    } else {
      await searchRounds(valid, runRounds, rounds.length, savePage);
    }
    if (!inputs.companies.length) {
      console.log("No companies matched, nothing was saved. Loosen a filter (a wider --size, another --stage, --founded none) or describe the space differently.");
      clearPartial(runKey);
      return;
    }
    step("companies");
  }
  const ids = [...new Set(inputs.companies.map(c => c.crustdata_company_id))];

  // 4. Founders, saved after every batch.
  if (!done.has("founders")) {
    const before = spend.credits;
    await findFounders(ids, inputs, progress("founders"), batch => mark("founders", batch));
    const withFounders = ids.filter(id => pickFounders(inputs.profiles, id).length).length;
    console.log(`Founders: ${inputs.profiles.length} people, founders found at ${withFounders} of ${ids.length} companies, credits ${fmtCredits(spend.credits - before)}`);
    step("founders");
  }

  // 5. Roles posted (free counts). Listings repeat across job sites, so distinct titles are counted per company.
  if (!done.has("roles")) {
    try {
      const [d90, d30] = [await jobCounts(ids, daysAgo(now, 90)), await jobCounts(ids, daysAgo(now, 30))];
      const hiring = ids.filter(id => d90.get(id));
      for (const [i, id] of ids.entries()) {
        if (inputs.jobs[id]) continue;
        const listings = d90.get(id) ?? 0;
        if (!listings) { inputs.jobs[id] = { last90: 0, last30: 0, newest: [] }; continue; }
        const distinct = async (since: string, fallback: number) => {
          try { return await distinctRoles(id, since); } catch (err) { if (fatal(err)) throw err; return fallback; }
        };
        inputs.jobs[id] = { last90: await distinct(daysAgo(now, 90), listings), last30: d30.get(id) ? await distinct(daysAgo(now, 30), d30.get(id)!) : 0, listings90: listings, newest: [] };
        save();
        if (hiring.length > 20 && (i + 1) % 20 === 0) console.log(`  roles: ${i + 1} of ${ids.length} companies`);
      }
      const roles = Object.values(inputs.jobs).reduce((n, j) => n + (j.last90 ?? 0), 0);
      console.log(`Roles: ${roles} distinct roles posted in the last 90 days across ${hiring.length} companies (free)`);
    } catch (err) {
      if (fatal(err) || !(err instanceof CrustdataError && err.status === 403)) throw err;
      // A key without job search: roles are not counted, for every company, and the run goes on.
      for (const id of ids) inputs.jobs[id] = { last90: null, last30: null, newest: [] };
      console.log("Roles: not counted, job search is not enabled on this Crustdata key (everything else works without it).");
    }
    step("roles");
  }

  // 6. Founders' posts, for the companies that rank highest so far.
  if (!done.has("posts")) {
    await countFounderPosts(buildPipeline(inputs, valid, now).deals, inputs, valid, now, save);
    step("posts");
  }
  if (!done.has("quotes")) {
    await quotePosts(buildPipeline(inputs, valid, now).deals, inputs, valid, now, progress("quotes"), id => mark("quotes", [id]));
    step("quotes");
  }

  // 7. Newest role titles for the top hiring companies (0.03 a listing).
  if (!done.has("titles")) {
    const before = spend.credits;
    const already = progress("titles");
    const hiring = buildPipeline(inputs, valid, now).deals.filter(d => (d.jobs.last90 ?? 0) > 0).slice(0, valid.jobsFor);
    for (const d of hiring) {
      if (already.has(d.company.id)) continue;
      try {
        // 10 listings, kept once per title: the same role listed on two sites shows once.
        const seen = new Set<string>();
        const newest = (await newestJobs(d.company.id, 10))
          .map(j => ({ title: (j.job_details?.title ?? "").trim(), date: j.metadata?.date_added, url: j.job_details?.url }))
          .filter(j => j.title && !seen.has(j.title.toLowerCase()) && seen.add(j.title.toLowerCase()))
          .slice(0, 5);
        inputs.jobs[d.company.id] = { ...(inputs.jobs[d.company.id] ?? EMPTY_JOBS), newest };
      } catch (err) {
        if (fatal(err)) throw err;
        if (err instanceof CrustdataError && err.status === 403) break;
      }
      mark("titles", [d.company.id]);
    }
    if (hiring.length) console.log(`Role titles: newest roles for ${hiring.length} companies, credits ${fmtCredits(spend.credits - before)}`);
    step("titles");
  }

  // 8. Final score, rank, and what changed since the last run of this thesis (--fresh keeps the history).
  const historyFile = loadHistory();
  const key = pipelineKey(spec);
  const previous = historyFor(historyFile, key, spec.thesis);
  const result = buildPipeline(inputs, valid, now, previous);
  if (result.droppedNoListFounder) console.log(`--only-founders-from: ${result.droppedNoListFounder} companies left out (no founder worked at ${valid.foundersFrom!.join(", ")}).`);
  if (result.droppedExcludedInvestor) console.log(`${result.droppedExcludedInvestor} companies left out: backed by an excluded investor.`);
  const { history, gone, samePipeline } = updateHistory(previous, key, result.deals, now);
  if (!samePipeline && Object.keys(historyFile.pipelines).length) console.log(`A new pipeline for this thesis and these filters (the history of your other theses in ${config.outDir} is kept).`);

  const retrieved = now.toISOString().slice(0, 10);
  const out: SavedData = { thesis: valid.thesis, retrieved, savedAt: now.toISOString(), deals: result.deals, gone, samePipeline };
  if (ai) await addAnalysis(out.deals, retrieved);
  writeAll(out, { file: historyFile, current: history }, data);
  // Saved with relative dates kept relative, and stages and countries as validated.
  saveThesis({ ...spec, stages: valid.stages, countries: valid.countries, states: valid.states }, rounds.at(-1)!.filters, now);
  clearPartial(runKey);

  // 9. Report.
  printPipeline(out.deals);
  if (samePipeline) {
    const count = (s: Deal["status"]) => out.deals.filter(d => d.status === s).length;
    console.log(`Since the last run: ${count("new")} new, ${count("still here")} still here, ${count("back")} back, ${gone.length} gone${gone.length ? ` (${gone.slice(0, 5).map(g => safe(g.name)).join(", ")}${gone.length > 5 ? ", ..." : ""})` : ""}. Changes are in pipeline.md.`);
  }
  console.log(`\nDone. ${out.deals.length} companies, ${out.deals.reduce((n, d) => n + d.founders.length, 0)} founders, ${fmtCredits(spend.credits)} credits ${partial ? "in this attempt (the earlier attempt's credits are not counted)" : "in total"}.`);
  console.log(`  ${paths.pipelineMd()}  (ranked, links to every memo)\n  ${paths.pipelineCsv()}\n  ${paths.foundersCsv()}\n  ${paths.memos()}/`);
  console.log("pipeline.csv and the memos are rewritten on every run: keep your own notes in a copy or your CRM.");
  if (!ai && !aiProvider()) console.log("Memos are complete without AI. Add ANTHROPIC_API_KEY or OPENAI_API_KEY and run with --ai for a written analysis in each.");
  if (config.watchHint && !noWatchHint)
    console.log("\nOptional: Crustdata can watch this for you and post to Slack or email when a new company matches these filters, or one in this pipeline raises, grows or starts hiring. Set it up at https://app.crustdata.com/watch (nothing is created until you do). See \"How do I watch\" in the README.");
}

// ---------------------------------------------------------------------------

/** Errors that must stop the run (what was paid is saved, so a re-run resumes): no key, no credits. */
const fatal = (err: unknown) => err instanceof CrustdataError && (err.status === 401 || err.outOfCredits);

/** --exclude values: CSV files (any file that exists), or domains separated by commas. */
function expandExclude(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (existsSync(v)) {
      if (statSync(v).isDirectory()) throw new Error(`--exclude: ${v} is a folder. Pass a CSV file or domains.`);
      if (/\.(xlsx|xls|numbers|ods)$/i.test(v) || readFileSync(v).subarray(0, 2).toString("latin1") === "PK")
        throw new Error(`--exclude: ${v} is a spreadsheet file. Save it as CSV first (File, Download or Export, CSV).`);
      const res = domainsFromCsv(readFileSync(v, "utf8"));
      if (res.noColumn) throw new Error(`--exclude: ${v} has no domain or website column. Add one, or pass domains: --exclude "acme.com, beta.io".`);
      if (!res.domains.length) throw new Error(`--exclude: no domains found in ${v}.`);
      console.log(`--exclude: ${res.domains.length} domains read from ${v} (for example ${res.domains.slice(0, 3).join(", ")})${res.rowsWithout ? `; ${res.rowsWithout} rows had no domain` : ""}`);
      out.push(...res.domains);
    } else if (/\.(csv|tsv|txt|xlsx|xls|numbers|ods)$/i.test(v)) {
      throw new Error(`--exclude: file ${v} not found.`);
    } else {
      for (const part of v.split(",").map(s => s.trim()).filter(Boolean)) {
        const d = domainsInCell(part);
        if (d.length) out.push(...d); else console.log(`--exclude: "${safe(part)}" is not a domain, so it is ignored.`);
      }
    }
  }
  return [...new Set(out)];
}

/** Spending credits needs a yes: Enter alone stops. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

/** The search, or with --explain one search per round. Only the last round's pages are kept (and saved as they come). */
async function searchRounds(spec: ThesisSpec, rounds: ReturnType<typeof buildRounds>, total: number, savePage: (page: RawCompany[]) => void): Promise<RawCompany[]> {
  let previous: RawCompany[] | undefined;
  if (rounds.length < total) console.log(`One search with all filters (--explain runs ${total} rounds, one per group of filters, to show what each drops; it costs ${total}x).`);
  else if (rounds.length > 1) console.log("--explain: only the last round is saved as it goes; if the run stops in an earlier round, that round runs again.");
  for (const round of rounds) {
    const before = spend.credits;
    const companies = await searchCompanies(spec.query, round.filters, spec.limit, round === rounds.at(-1) ? savePage : undefined);
    console.log(rounds.length < total || total === 1 ? "Company search" : round.name);
    console.log(`  "${safe(spec.query)}"${round.describe.length ? " + " + round.describe.join(", ") : ""}`);
    console.log(`  ${companies.length} companies, ranked by relevance (limit ${spec.limit}), credits ${fmtCredits(spend.credits - before)}`);
    if (previous) {
      const now = new Set(companies.map(c => c.crustdata_company_id));
      const dropped = previous.filter(c => !now.has(c.crustdata_company_id));
      console.log(`  dropped ${dropped.length} from the round before${dropped.length ? ":" : ""}`);
      for (const d of dropped.slice(0, 5)) console.log(`    - ${pad(d.basic_info?.name ?? d.crustdata_company_id, 40).trim()} (${whyDropped(d, spec)})`);
    }
    previous = companies;
  }
  console.log("");
  return previous ?? [];
}

/** Founders in batches of 10 companies; every finished batch is saved, so a resumed run skips it. */
async function findFounders(companyIds: number[], inputs: Inputs, already: Set<number>, onBatch: (ids: number[]) => void): Promise<void> {
  const titles = or(...FOUNDER_TITLES.map(t => leaf("experience.employment_details.current.title", "[.]", t)));
  const byId = new Map<number, RawProfile>(inputs.profiles.map(p => [p.crustdata_person_id, p]));
  const keep = (found: RawProfile[]) => { for (const p of found) byId.set(p.crustdata_person_id, p); inputs.profiles = [...byId.values()]; };
  const todo = companyIds.filter(id => !already.has(id));
  for (let i = 0; i < todo.length; i += PEOPLE_BATCH) {
    const batch = todo.slice(i, i + PEOPLE_BATCH);
    const limit = batch.length * PEOPLE_PER_COMPANY;
    const found = await searchPeople(and(leaf("experience.employment_details.current.company_id", "in", batch), titles), limit);
    keep(found);
    // A full batch can hide the founders of its smaller companies: those are searched one by one. The batch is saved
    // first, and each of those companies as it is done, so nothing here is paid twice.
    const hidden = found.length >= limit && batch.length > 1 ? batch.filter(id => !pickFounders(inputs.profiles, id).length) : [];
    onBatch(batch.filter(id => !hidden.includes(id)));
    for (const id of hidden) {
      keep(await searchPeople(and(leaf("experience.employment_details.current.company_id", "in", [id]), titles), PEOPLE_PER_COMPANY));
      onBatch([id]);
    }
  }
}

/**
 * Counts founders' traction and round posts for the top --posts companies (free). Companies below that are scored as
 * having none, so a company that was not checked never outranks one that was. Round posts only count after the last
 * round on record (plus 60 days), so the round already in the data does not read as a new one.
 */
async function countFounderPosts(ranked: Deal[], inputs: Inputs, spec: ThesisSpec, now: Date, save: () => void): Promise<void> {
  const since = monthsAgo(now, POST_WINDOW_MONTHS);
  const off = (why: string) => { for (const d of ranked) inputs.posts[d.company.id] = { traction: null, raise: null, quotes: [], skipped: why, unchecked: "off" }; };
  if (spec.postsFor === 0) return off("--no-posts");
  let checked = 0;
  for (const [i, d] of ranked.entries()) {
    const existing = inputs.posts[d.company.id];
    if (existing && existing.traction !== null && existing.traction !== undefined) { checked++; continue; } // counted before a resume
    const founders = d.founders.map(f => f.personId);
    if (i >= spec.postsFor) { inputs.posts[d.company.id] = { traction: null, raise: null, quotes: [], skipped: `outside the top ${spec.postsFor} companies checked (--posts sets how many)`, unchecked: "rank" }; continue; }
    if (!founders.length) { inputs.posts[d.company.id] = { traction: null, raise: null, quotes: [], skipped: "no founder profile found", unchecked: "rank" }; continue; }
    const afterRound = d.company.lastRoundDate ? new Date(Date.parse(d.company.lastRoundDate) + 60 * 86_400_000).toISOString().slice(0, 10) : since;
    try {
      const traction = await countPosts(postFilters(founders, since, TRACTION_PHRASES));
      const raise = await countPosts(raisePostFilters(founders, afterRound > since ? afterRound : since, RAISE_PHRASES, RAISE_ACTIONS, RAISE_ROUNDS));
      inputs.posts[d.company.id] = { traction, raise, quotes: [] };
      checked++;
      save();
      if (spec.postsFor > 20 && (i + 1) % 20 === 0) console.log(`  posts: ${i + 1} of ${Math.min(ranked.length, spec.postsFor)} companies`);
    } catch (err) {
      if (fatal(err)) throw err;
      if (err instanceof CrustdataError && err.status === 403) {
        const why = "post search is not enabled on this Crustdata key (ask Crustdata to turn it on; everything else works without it)";
        console.log(`Founders' posts: skipped, ${why}.`);
        return off(why);
      }
      // A failed count is unknown, not zero: this company's posts are left out of its score.
      inputs.posts[d.company.id] = { traction: null, raise: null, quotes: [], skipped: `post search failed (${err instanceof CrustdataError ? err.status : "error"})`, unchecked: "off" };
    }
  }
  const hits = Object.values(inputs.posts).filter(p => (p.traction ?? 0) + (p.raise ?? 0) > 0).length;
  console.log(`Founders' posts: checked ${checked} companies (free), ${hits} have traction or round posts in the last ${POST_WINDOW_MONTHS} months`);
}

/** Quotes for the top companies with matching posts: the 2 newest, 0.5 credits each. Saved per company. */
async function quotePosts(ranked: Deal[], inputs: Inputs, spec: ThesisSpec, now: Date, already: Set<number>, onDone: (id: number) => void): Promise<void> {
  const before = spend.credits;
  const since = monthsAgo(now, POST_WINDOW_MONTHS);
  const withPosts = ranked.filter(d => { const p = inputs.posts[d.company.id]; return p && (p.traction ?? 0) + (p.raise ?? 0) > 0; }).slice(0, spec.quotes);
  for (const d of withPosts) {
    if (already.has(d.company.id)) continue;
    try {
      const founders = d.founders.map(f => f.personId);
      // Round posts from the same window the count used: after the last round on record plus 60 days.
      const afterRound = d.company.lastRoundDate ? new Date(Date.parse(d.company.lastRoundDate) + 60 * 86_400_000).toISOString().slice(0, 10) : since;
      const filters = or(postFilters(founders, since, TRACTION_PHRASES), raisePostFilters(founders, afterRound > since ? afterRound : since, RAISE_PHRASES, RAISE_ACTIONS, RAISE_ROUNDS));
      const posts = await fetchPosts(filters, 2);
      inputs.posts[d.company.id] = { ...inputs.posts[d.company.id], quotes: posts.map(toQuote).filter((q): q is NonNullable<typeof q> => !!q) };
    } catch (err) {
      if (fatal(err)) throw err;
      if (err instanceof CrustdataError && err.status === 403) break;
    }
    onDone(d.company.id);
  }
  if (withPosts.length) console.log(`Quoted posts: ${withPosts.length} companies, credits ${fmtCredits(spend.credits - before)}`);
}

async function addAnalysis(deals: Deal[], today: string): Promise<void> {
  let done = 0;
  for (const d of deals) {
    try { d.analysis = await analyse(d, today); done++; }
    catch (err) { console.log(`AI analysis skipped for ${pad(d.company.name, 40).trim()}: ${(err as Error).message}`); if (/not accepted|rate limit/.test((err as Error).message)) break; }
  }
  if (done) console.log(`AI analysis: written for ${done} of ${deals.length} memos (${deals.find(d => d.analysis)?.analysis?.model}).`);
}

async function rescoreSaved(spec: ThesisSpec, data: SavedData, now: Date, ai: boolean, savedAt: string): Promise<void> {
  const deals = rescore(data.deals, resolveDates(spec, now), now);
  const out: SavedData = { ...data, deals, savedAt: now.toISOString() };
  if (ai) await addAnalysis(out.deals.filter(d => !d.analysis), data.retrieved);
  writeAll(out, undefined, data);
  // The search time stays the time of the search, so a re-score never pushes the next real search further away.
  saveThesis(spec, loadThesis()?.filters, new Date(savedAt));
  console.log(`Only scoring settings changed (--founders-from, --schools, --timing${ai ? ", --ai" : ""}), so the saved data was re-scored: 0 credits.`);
  if (spec.onlyFoundersFrom && deals.length < data.deals.length) console.log(`--only-founders-from: ${data.deals.length - deals.length} companies left out.`);
  printPipeline(deals);
}

function printPipeline(deals: Deal[], n = 15) {
  console.log(`\n  ${pad("#", 3)} ${pad("company", 26)} ${pad("score", 5)} ${pad("timing", 24)} ${pad("stage", 9)} ${pad("team", 10)} ${pad("roles", 5)} status`);
  deals.slice(0, n).forEach((d, i) => {
    const g = d.company.growth6m;
    const team = `${d.company.headcount ?? "?"}${typeof g === "number" ? ` ${g > 0 ? "+" : ""}${Math.round(g)}%` : ""}`;
    const stage = d.company.lastRound?.replace("_", "-") ?? "no round";
    console.log(`  ${pad(i + 1, 3)} ${pad(d.company.name, 26)} ${pad(d.score.total, 5)} ${pad(d.score.timing.label, 24)} ${pad(stage, 9)} ${pad(team, 10)} ${pad(d.jobs.last90 ?? "", 5)} ${d.status}`);
  });
  if (deals.length > n) console.log(`  ... ${deals.length - n} more in pipeline.md`);
}
