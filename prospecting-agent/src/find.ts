/**
 * npm run find: ICP in, accounts.csv and people.csv out, with a visible log of what was searched and why.
 *
 *   1. read the ICP into filters        rule-based parser plus flags (Claude instead, when ANTHROPIC_API_KEY is set)
 *   2. validate categorical values      autocomplete, free, before any credit is spent
 *   3. ranked company search            one search with all filters; a new sentence (or --explain) runs it in rounds,
 *                                       one group of filters at a time, showing what each caught and dropped
 *   4. decision-makers at the shortlist your titles first, then the most senior people where no title matched
 *   5. write accounts.csv, people.csv and icp.json
 */

import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { config, icpPath } from "./config.js";
import { fmtCredits, profileUrl, searchCompanies, searchPeople, spend, type Company, type Profile } from "./crustdata.js";
import { writeCsv } from "./csv.js";
import {
  FALLBACK_MAX_SIZE, FALLBACK_SENIORITY, USAGE, buildRounds, describeSpec, estimateCost, isSideRole, keepAcrossSentences, loadIcp, mergeSpec, parseFlags, parseSentence,
  peopleFilters, personRank, sameSpec, saveIcp, sentenceWarnings, titleIndex, validateSpec, whyDropped, type IcpSpec, type Round, type SpecLayer,
} from "./icp.js";

const COMPANY_FIELDS = ["crustdata_company_id", "basic_info", "headcount", "funding", "locations", "taxonomy"];
/** Company ids per person search. Small, so one big account cannot use up a whole batch's results. */
const PEOPLE_BATCH = 10;
/** Results asked for per account per kept person, so the best ones can be picked. Every result is billed. */
const PEOPLE_PER_ACCOUNT = 3;

export async function runFind(argv: string[]): Promise<void> {
  const resolved = await resolveSpec(argv);
  if (!resolved) return;
  const { spec: valid, problems } = await validateSpec(resolved.spec);
  if (problems.length) {
    console.error("Fix these and run again (autocomplete is free, nothing was charged):\n" + problems.map(p => `  - ${p}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  const rounds = buildRounds(valid);
  const { shortlist } = await searchRounds(valid, resolved.explain ? rounds : rounds.slice(-1), rounds.length);
  if (!shortlist.length) {
    console.log("No accounts matched, nothing was saved. Loosen a filter (a wider --size, more --raised stages, --since none) or describe the business differently with --icp.");
    return;
  }
  const chosen = await findPeople(shortlist, valid);
  writeOutputs(valid, rounds[rounds.length - 1], shortlist, chosen);

  const covered = new Set(chosen.map(c => c.companyId)).size;
  console.log(`Done. ${shortlist.length} accounts, ${chosen.length} people at ${covered} of them, ${fmtCredits(spend.credits)} credits in total.`);
  console.log(`  ${join(config.outDir, "accounts.csv")}\n  ${join(config.outDir, "people.csv")}\n  ${icpPath()} (the exact query; later runs start from it)`);
  console.log("Optional next step: hear when these accounts raise, hire or grow. Crustdata watchers do that and post to Slack or email;");
  console.log("npm run watch-example writes the request for this shortlist, and docs/watch-accounts.md shows how to set it up with Crustdata.");
}

// ---------------------------------------------------------------------------
// 1. The spec: saved icp.json, then what the sentence says, then flags.
// ---------------------------------------------------------------------------

async function resolveSpec(argv: string[]): Promise<{ spec: IcpSpec; explain: boolean } | undefined> {
  const { flags, yes, fresh, explain, force } = parseFlags(argv);
  const saved = fresh ? undefined : loadIcp();
  const sentence = flags.icp ?? saved?.spec.icp;
  if (!sentence) throw new Error(USAGE);

  const newSentence = !saved || sentence !== saved.spec.icp;
  // A new sentence resets what the parser decides and keeps your titles, exclusions and limits.
  const base: SpecLayer | undefined = !saved ? undefined : newSentence ? keepAcrossSentences(saved.spec) : saved.spec;
  if (saved && newSentence) {
    const kept = describeKept(base!);
    const when = saved.savedAt ? ` saved ${saved.savedAt.slice(0, 16).replace("T", " ")} UTC` : "";
    console.log(kept ? `New sentence. Kept from the last run (${icpPath()},${when}): ${kept}. --fresh drops them.` : "New sentence.");
  }

  let parsed: Partial<IcpSpec> | undefined;
  let warnings: string[] = [];
  if (newSentence) {
    if (config.anthropicApiKey) {
      const { specFromSentence } = await import("./llm.js");
      console.log("Reading the ICP with Claude...");
      parsed = await specFromSentence(sentence);
      // Your saved buyers (titles and seniority together) win over the ones Claude guesses from a new sentence.
      if (base?.titles || base?.seniority) { delete parsed.titles; delete parsed.seniority; }
    } else {
      parsed = parseSentence(sentence);
      warnings = sentenceWarnings(sentence, parsed);
    }
  }
  const spec = mergeSpec(base, { icp: sentence }, parsed, flags);
  // The "no size" note is for a sentence that left it out. A --size flag (including --size none) or a saved size is a choice.
  if (flags.size !== undefined || (saved && !newSentence)) warnings = warnings.filter(w => !w.startsWith("No size"));

  if (saved && !newSentence && sameSpec(spec, saved.spec) && !force && !explain) {
    const cleared = Object.entries(flags).filter(([, v]) => v === null).map(([k]) => k);
    console.log(cleared.length
      ? `${cleared.map(k => `--${k} none`).join(", ")}: that filter was not set, so nothing changed since the last run. Nothing was searched (re-running costs credits; --force runs it anyway).`
      : "Nothing changed since the last run, so nothing was searched (re-running costs credits; --force runs it anyway). Change a flag or give a new --icp sentence.");
    return undefined;
  }

  console.log("\nICP filters:\n" + describeSpec(spec));
  for (const w of warnings) console.log(`  note:        ${w}`);
  // Staged rounds (and their caught/dropped log) on a new sentence or on request; a flag tweak runs one search.
  const runRounds = newSentence || explain;
  const roundCount = runRounds ? buildRounds(spec).length : 1;
  console.log(`  cost:        ${estimateCost(spec, roundCount)}${roundCount > 1 ? ` (${roundCount} rounds; the people search runs once)` : ""}\n`);
  if (config.anthropicApiKey && newSentence && !yes && !(await confirm("Search with these filters?"))) {
    console.log("Stopped. Adjust with flags (for example --size 50-500 --raised series_a,series_b) and run again.");
    return undefined;
  }
  return { spec, explain: runRounds };
}

function describeKept(kept: SpecLayer): string {
  const parts: string[] = [];
  if (kept.titles?.length) parts.push(`titles ${kept.titles.join(", ")}`);
  if (kept.seniority?.length) parts.push(`seniority ${kept.seniority.join(", ")}`);
  if (kept.exclude?.length) parts.push(`exclude ${kept.exclude.join(", ")}`);
  if (kept.limit && kept.limit !== 100) parts.push(`limit ${kept.limit}`);
  if (kept.perCompany && kept.perCompany !== 3) parts.push(`${kept.perCompany} people per account`);
  if (kept.minConnections) parts.push(`min connections ${kept.minConnections}`);
  return parts.join("; ");
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer === "y" || answer === "yes";
}

// ---------------------------------------------------------------------------
// 3. Ranked company search, one round per group of hard filters.
// ---------------------------------------------------------------------------

const pad = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n - 1) + "." : t.padEnd(n); };
const nameOf = (c: Company) => c.basic_info?.name || "(no name)";

function printTop(companies: Company[], n = 10) {
  console.log(`  top ${Math.min(n, companies.length)}:`);
  console.log(`    ${pad("company", 30)} ${pad("domain", 24)} ${pad("people", 7)} ${pad("last round", 12)} ${pad("raised", 11)} country`);
  for (const c of companies.slice(0, n)) {
    console.log(`    ${pad(nameOf(c), 30)} ${pad(c.basic_info?.primary_domain, 24)} ${pad(c.headcount?.total, 7)} ${pad(c.funding?.last_round_type, 12)} ${pad(c.funding?.last_fundraise_date, 11)} ${c.locations?.country ?? ""}`);
  }
}

async function searchRounds(spec: IcpSpec, rounds: Round[], totalRounds: number): Promise<{ shortlist: Company[]; log: string[] }> {
  const log: string[] = [];
  let previous: Company[] | undefined;
  if (rounds.length < totalRounds) console.log(`One search with all filters (${totalRounds} staged rounds would cost ${totalRounds}x; --explain runs them to see what each filter drops).`);
  for (const round of rounds) {
    const before = spend.credits;
    const companies = await searchCompanies(spec.query, round.filters, spec.limit, COMPANY_FIELDS);
    console.log(rounds.length < totalRounds ? "Search" : round.name);
    console.log(`  filters: "${spec.query}"${round.describe.length ? " + " + round.describe.join(", ") : ""}`);
    // Ranked search returns the best matches up to the limit; it does not count everything that matches.
    console.log(`  returned ${companies.length}, ranked by relevance (limit ${spec.limit}), credits ${fmtCredits(spend.credits - before)}`);
    let line = `${round.name}: ${companies.length} accounts`;
    if (previous) {
      const now = new Set(companies.map(c => c.crustdata_company_id));
      const was = new Set(previous.map(c => c.crustdata_company_id));
      const dropped = previous.filter(c => !now.has(c.crustdata_company_id));
      const caught = companies.filter(c => !was.has(c.crustdata_company_id));
      console.log(`  dropped ${dropped.length} from the round before${dropped.length ? ", for example:" : ""}`);
      for (const d of dropped.slice(0, 5)) console.log(`    - ${nameOf(d)} (${whyDropped(d, spec)})`);
      console.log(`  caught ${caught.length} new ones the tighter filters let rank higher${caught.length ? ": " + caught.slice(0, 5).map(nameOf).join(", ") : ""}`);
      line += `, dropped ${dropped.length}, caught ${caught.length}`;
    }
    printTop(companies);
    console.log("");
    log.push(line);
    previous = companies;
  }
  return { shortlist: previous ?? [], log };
}

// ---------------------------------------------------------------------------
// 4. Decision-makers at the shortlist.
// ---------------------------------------------------------------------------

type Chosen = { profile: Profile; companyId: number; title: string; seniority: string; rank: number; matched: string };

/** Placeholder profiles come back with a generic "... Member" name; they are not people you can write to. */
const isPlaceholderName = (name?: string) => !name || /^[a-z]+ member$/i.test(name);

async function findPeople(shortlist: Company[], spec: IcpSpec): Promise<Chosen[]> {
  const ids = shortlist.map(c => c.crustdata_company_id);
  const sizeOf = new Map(shortlist.map(c => [c.crustdata_company_id, c.headcount?.total ?? 0]));
  const found = new Map<number, Chosen[]>(); // company id -> candidates
  let returned = 0;
  const byTitle = !!(spec.titles?.length || spec.seniority?.length);

  // Search in batches of company ids; keep each person once, under the account they were found for. The search
  // matches a title on any current role, so the title of the role at the account is checked again here, and side
  // roles (advisor, investor, intern) are dropped. Returns the ids of batches that came back full (a crowded batch
  // can hide people at its smaller accounts).
  const search = async (companyIds: number[], mode: "titles" | "fallback", batchSize: number, exclude: string[] = []): Promise<number[]> => {
    const crowded: number[] = [];
    for (let i = 0; i < companyIds.length; i += batchSize) {
      const batch = new Set(companyIds.slice(i, i + batchSize));
      const limit = batch.size * spec.perCompany * PEOPLE_PER_ACCOUNT;
      const profiles = await searchPeople(peopleFilters([...batch], spec, mode), limit, exclude);
      returned += profiles.length;
      if (profiles.length >= limit && batch.size > 1) crowded.push(...batch);
      for (const profile of profiles) {
        const job = profile.experience?.employment_details?.current?.find(j => batch.has(j.crustdata_company_id ?? -1));
        const title = job?.title ?? profile.basic_profile?.current_title ?? "";
        if (!job?.crustdata_company_id || isSideRole(title) || isPlaceholderName(profile.basic_profile?.name)) continue;
        const idx = titleIndex(title, spec.titles);
        if (mode === "titles" && spec.titles?.length && idx < 0) continue;
        const list = found.get(job.crustdata_company_id) ?? [];
        if (list.some(c => c.profile.crustdata_person_id === profile.crustdata_person_id)) continue;
        const seniority = job.seniority_level ?? "";
        const matched = mode === "fallback" ? "fallback (most senior)" : spec.titles?.length ? spec.titles[idx] : "most senior";
        list.push({ profile, companyId: job.crustdata_company_id, title, seniority, rank: personRank(title, seniority, spec.titles), matched });
        found.set(job.crustdata_company_id, list);
      }
    }
    return crowded;
  };

  const before = spend.credits;
  const crowded = await search(ids, byTitle ? "titles" : "fallback", PEOPLE_BATCH);
  console.log(`People, round 1: ${byTitle ? [spec.titles?.length && `titles ${spec.titles.join(", ")}`, spec.seniority?.length && `seniority ${spec.seniority.join(", ")}`].filter(Boolean).join(" and ") : "the most senior people (no --titles given)"}`);
  console.log(`  found people at ${found.size} of ${ids.length} accounts`);

  // Accounts that shared a full batch with a big account get their own search before anyone gives up on them.
  const hidden = crowded.filter(id => !found.has(id));
  if (hidden.length) {
    const sizeBefore = found.size;
    await search(hidden, byTitle ? "titles" : "fallback", 1);
    console.log(`  ${hidden.length} accounts shared a crowded batch and were searched one by one: ${found.size - sizeBefore} more filled`);
  }

  // Accounts where no title matched get their most senior people, unless they are too big for that to mean anything.
  const empty = ids.filter(id => !found.has(id));
  if (byTitle && empty.length && spec.fallback !== false) {
    const small = empty.filter(id => (sizeOf.get(id) ?? 0) <= FALLBACK_MAX_SIZE);
    const sizeBefore = found.size;
    const already = [...found.values()].flat().map(c => profileUrl(c.profile)).filter((u): u is string => !!u);
    if (small.length) await search(small, "fallback", PEOPLE_BATCH, already);
    console.log(`People, round 2: ${FALLBACK_SENIORITY.join(", ")} at the ${small.length} accounts round 1 left empty (--fallback none to skip this)`);
    console.log(`  filled ${found.size - sizeBefore} of ${small.length}${empty.length > small.length ? `; skipped ${empty.length - small.length} over ${FALLBACK_MAX_SIZE} people, where a senior title alone is not a buyer` : ""}`);
  }

  const chosen = ids.flatMap(id => (found.get(id) ?? []).sort((a, b) => a.rank - b.rank).slice(0, spec.perCompany));
  console.log(`  ${returned} people returned and billed, ${chosen.length} kept (up to ${spec.perCompany} per account), credits ${fmtCredits(spend.credits - before)}\n`);
  return chosen;
}

// ---------------------------------------------------------------------------
// 5. Outputs. icp.json is written last, so a failed run never leaves it out of step with the shortlist.
// ---------------------------------------------------------------------------

function writeOutputs(spec: IcpSpec, last: Round, shortlist: Company[], chosen: Chosen[]) {
  const why = (rank: number) => `rank ${rank} for "${spec.query}"${last.describe.length ? "; " + last.describe.join("; ") : ""}`;
  const growth = (c: Company) => { const g = c.headcount?.growth_percent?.["12m"]; return typeof g === "number" ? Math.round(g * 10) / 10 : undefined; };
  const names = new Map(shortlist.map(c => [c.crustdata_company_id, c.basic_info?.name]));

  writeCsv(join(config.outDir, "accounts.csv"),
    ["name", "domain", "headcount", "growth 12m %", "last round", "last raise date", "country", "industries", "crustdata id", "why matched"],
    shortlist.map((c, i) => [c.basic_info?.name, c.basic_info?.primary_domain, c.headcount?.total, growth(c), c.funding?.last_round_type, c.funding?.last_fundraise_date,
      c.locations?.country, c.taxonomy?.professional_network_industries, c.crustdata_company_id, why(i + 1)]));
  writeCsv(join(config.outDir, "people.csv"),
    ["name", "title", "company", "seniority", "matched", "profile URL", "crustdata id"],
    chosen.map(c => [c.profile.basic_profile?.name, c.title, names.get(c.companyId), c.seniority, c.matched, profileUrl(c.profile), c.profile.crustdata_person_id]));

  saveIcp(spec, last.filters);
}
