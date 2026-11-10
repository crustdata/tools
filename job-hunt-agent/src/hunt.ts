/**
 * The agent, in order (docs/how-it-works.md shows every request and answer):
 *
 *   1. Read your CV: skills, schools, years (on your machine)              free
 *   2. School spellings for the alumni search (person autocomplete)       free
 *   3. Count the matching jobs (job search, limit 0)                       free
 *   4. Read the newest `scan` jobs with their descriptions                 0.03 per job
 *   5. Fold duplicates, leave out agencies and skipped companies, score    free
 *   6. Check the best ones are still open, on their job board              free
 *   7. Headcount trend for those companies                                0.23 per company (list)
 *   8. Recruiter, hiring manager, team and alumni at each company          0.23 per person (list)
 *   9. Work emails for the recruiter and manager, only with --emails       1 per person matched
 *  10. Draft one note per person; write the report, JSON, CSV              free
 *
 * Companies and people are cached for CACHE_DAYS: a second run pays nothing for them again, and a second job at
 * the same company reuses its recruiters (manager, team and alumni searches use the job title, so a different
 * title pays for those again).
 */

import {
  accountEndpoints, budget, BudgetError, companiesByIds, listCost, usage, companyByDomain, countJobs, CrustdataError, fmtCredits, findJob,
  LIST_PRICES, peopleAt, pricesFrom, schoolSpellings, searchJobs, spend, workEmails, type Filter, type Prices,
  type RawCompany, type RawJob, type RawPerson,
} from "./crustdata.js";
import { momentumOf, type Momentum } from "./company.js";
import type { CvFacts } from "./cv.js";
import { daysSince, dedupe, skipReason, toJob, type Job } from "./jobs.js";
import { draftNote } from "./notes.js";
import { checkOpen as realCheckOpen, type Openness } from "./open-check.js";
import { chooseFirst, fold, pick, profileKey, searchesFor, type PeopleSearch, type Person } from "./people.js";
import type { Profile } from "./profile.js";
import { scoreJob, type Fit, type Seeker } from "./score.js";
import type { Store } from "./store.js";

export type PersonOut = Person & { note: string };

export type JobResult = {
  job: Job;
  fit: Fit;
  momentum: Momentum;
  open: Openness;
  daysAgo: number | null;
  isNew: boolean;
  people: PersonOut[];
};

export type Run = {
  id: string;
  createdAt: string;
  kind: "hunt" | "job";
  search: { titles: string[]; location: string; radiusMiles: number; remote: Profile["remote"]; country: string; days: number };
  me: { skills: string[]; schools: string[]; schoolSpellings: string[]; years: number | null; yearsFrom: "cv" | "you"; learning: string[]; needsSponsorship: boolean };
  counts: { matching: number; scanned: number; unique: number; skipped: Record<string, number>; closed: number; checked: number };
  jobs: JobResult[];
  closed: Array<{ title: string; company: string; url: string | null }>;
  credits: number;
  /** The worst case this run was allowed to spend, at the account's prices. */
  estimate: number;
  /** What the same rows cost at list price (plans that include premium groups pay less). */
  listCredits: number;
  notes: string[];
};

export type Deps = {
  store: Store;
  log: (line: string) => void;
  now?: Date;
  checkOpen?: (url: string | null) => Promise<Openness>;
  cacheDays: number;
};

// ---------------------------------------------------------------------------
// Filters (pure)
// ---------------------------------------------------------------------------

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The US is stored three ways in job rows; other countries by their full name. */
export function countryCondition(country: string): Filter {
  const us = /^(us|usa|u\.s\.a?\.?|united states(?: of america)?|america)$/i.test(country.trim());
  return us
    ? { field: "location.country", type: "in", value: ["United States", "United States of America", "USA"] }
    : { field: "location.country", type: "=", value: country.trim() };
}

export function jobFilters(p: Profile, now = new Date()): Filter {
  const titles: Filter[] = p.titles.map(t => ({ field: "job_details.title", type: "(.)", value: t }));
  const near: Filter = { field: "location", type: "geo_distance", value: { location: p.location, distance: p.radiusMiles, unit: "mi" } };
  const remote: Filter = { op: "and", conditions: [
    { field: "job_details.workplace_type", type: "=", value: "Remote" },
    countryCondition(p.country),
  ] };
  const place = p.remote === "only" ? remote : p.remote === "also" ? { op: "or" as const, conditions: [near, remote] } : near;
  const since = isoDay(new Date(now.getTime() - p.days * 86_400_000));
  return { op: "and", conditions: [
    titles.length === 1 ? titles[0] : { op: "or", conditions: titles },
    place,
    { field: "metadata.date_added", type: "=>", value: since },
  ] };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Short names with one clear meaning. Ambiguous ones (UW is Washington and Wisconsin, USC, Penn) are left out on
 * purpose: setup asks for the full name instead.
 */
export const KNOWN_SCHOOLS: Record<string, string> = {
  mit: "Massachusetts Institute of Technology", caltech: "California Institute of Technology",
  cmu: "Carnegie Mellon University", ucla: "University of California, Los Angeles",
  ucsd: "University of California, San Diego", nyu: "New York University", "georgia tech": "Georgia Institute of Technology",
  gatech: "Georgia Institute of Technology", uiuc: "University of Illinois Urbana-Champaign",
  umich: "University of Michigan", "ut austin": "University of Texas at Austin", upenn: "University of Pennsylvania",
  "eth zurich": "ETH Zurich", epfl: "EPFL", ucl: "University College London", lse: "London School of Economics",
  // A flagship campus written with its city: profiles mostly use the plain name.
  "university of michigan, ann arbor": "University of Michigan",
  "university of texas, austin": "University of Texas at Austin",
  "the university of texas at austin": "University of Texas at Austin",
  "university of illinois, urbana-champaign": "University of Illinois Urbana-Champaign",
  "university of wisconsin, madison": "University of Wisconsin-Madison",
};

/** Short names people write for schools, both ways. Add yours to KNOWN_SCHOOLS. */
export function schoolAliases(school: string): string[] {
  const out: string[] = [];
  const uc = /^University of California,?\s+(.+)$/i.exec(school);
  if (uc) out.push(`UC ${uc[1]}`);
  const uc2 = /^UC\s+(.+)$/i.exec(school);
  if (uc2) out.push(`University of California, ${uc2[1]}`);
  const iit = /^IIT[\s,-]+(.+)$/i.exec(school);
  if (iit) out.push(`Indian Institute of Technology, ${iit[1]}`, `Indian Institute of Technology ${iit[1]}`);
  const iit2 = /^Indian Institute of Technology,?\s+(.+)$/i.exec(school);
  if (iit2) out.push(`IIT ${iit2[1]}`);
  // "University of Texas, Austin" is also written "University of Texas at Austin" and "University of Texas Austin".
  const campus = /^(University of [\p{L} ]+?),\s*([\p{L} .-]+)$/u.exec(school.trim());
  if (campus && !/^University of California$/i.test(campus[1])) out.push(`${campus[1]} at ${campus[2]}`, `${campus[1]} ${campus[2]}`);
  const k = KNOWN_SCHOOLS[school.trim().toLowerCase()];
  if (k) out.push(k);
  // The short forms only as people write them in capitals (MIT, CMU, UIUC); longer keys are lookup only.
  for (const [short, long] of Object.entries(KNOWN_SCHOOLS)) {
    if (long.toLowerCase() === school.trim().toLowerCase() && /^[a-z]{2,5}$/.test(short)) out.push(short.toUpperCase());
  }
  return out;
}

/**
 * The spellings to search a school by: the name, its aliases, and the autocomplete suggestions that contain every
 * word of it. A spelling that already contains another one is dropped, because the phrase filter matches it anyway.
 */
export function spellingsFor(school: string, suggestions: string[]): string[] {
  const all = [school, ...schoolAliases(school)];
  // A suggestion counts only when it starts with the school's name or a known short name: "University of
  // Washington Bothell" yes, "Washington State University" or "Central Washington University" no.
  const starts = all.map(x => norm(x)).filter(Boolean);
  for (const s of suggestions) {
    const n = norm(s);
    if (starts.some(st => n === st || n.startsWith(`${st} `))) all.push(s);
  }
  const uniq = [...new Map(all.map(s => [s.toLowerCase(), s.trim()])).values()];
  const kept = uniq.filter(s => !uniq.some(o => o !== s && o.length < s.length && s.toLowerCase().includes(o.toLowerCase())));
  return kept.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Steps with I/O
// ---------------------------------------------------------------------------

/**
 * The most a run should cost, at your account's prices: every job read, and for each of the best `top` its
 * company, the people searches (2 + 2 + 3 asked for, and each asked again outside the country if needed) and
 * 3 alumni, plus 3 emails a job with --emails. Cached companies and people cost nothing, so runs usually cost less.
 */
export function estimate(scan: number, top: number, emails: boolean, prices: Prices = LIST_PRICES): number {
  return scan * prices.job + top * (prices.company + 14 * prices.person + 3 * prices.alumni) + (emails ? top * 3 * prices.email : 0);
}

/** Your account's prices (free call), or the price list when they cannot be read. */
export async function accountPrices(): Promise<Prices> {
  try { return pricesFrom(await accountEndpoints()); } catch { return LIST_PRICES; }
}

/** Which of your schools each spelling stands for, so an alumni note names the school you share with that person. */
const spellingOwner = new Map<string, string>();

/** The school of yours that a person's school entry matches (whole words), or null. */
export function sharedSchool(theirs: string | null, owners: Map<string, string> = spellingOwner): string | null {
  if (!theirs) return null;
  const t = ` ${fold(theirs)} `;
  for (const [spelling, mine] of owners) if (t.includes(` ${fold(spelling)} `)) return mine;
  return null;
}

async function schoolSpellingSet(schools: string[], deps: Deps): Promise<string[]> {
  const out: string[] = [];
  spellingOwner.clear();
  for (const s of schools) {
    const key = `school:${s.toLowerCase()}`;
    let sug = deps.store.cached<string[]>(key, 30);
    if (!sug) {
      try { sug = await schoolSpellings(s); deps.store.save(key, sug); } catch { sug = []; }
    }
    const mine = spellingsFor(s, sug);
    for (const sp of mine) if (!spellingOwner.has(sp.toLowerCase())) spellingOwner.set(sp.toLowerCase(), s);
    out.push(...mine);
  }
  return [...new Set(out)].slice(0, 10);
}

/** Companies by id, from the cache when fresh, else one call for all the missing ones. */
async function companies(ids: number[], deps: Deps): Promise<Map<number, RawCompany>> {
  const out = new Map<number, RawCompany>();
  const missing: number[] = [];
  for (const id of ids) {
    const c = deps.store.cached<RawCompany>(`company:${id}`, deps.cacheDays);
    if (c) out.set(id, c); else missing.push(id);
  }
  if (missing.length) {
    for (const c of await companiesByIds(missing)) {
      const id = Number(c.crustdata_company_id);
      if (!Number.isFinite(id)) continue;
      out.set(id, c);
      deps.store.save(`company:${id}`, c);
    }
    // Remember companies with no record too, so a re-run does not ask again.
    for (const id of missing) if (!out.has(id)) deps.store.save(`company:${id}`, {});
  }
  return out;
}

const STOP_STATUSES = new Set([401, 402]);

/** People shown per job, by kind. */
export const WANT = { recruiter: 2, manager: 1, team: 3, alumni: 3 };

/** One people search, from the cache or the API. Null when it failed (the reason goes to `notes`). */
async function searchOnce(companyId: number, companyName: string, s: PeopleSearch, spellings: string[], deps: Deps, notes: string[]): Promise<RawPerson[] | null> {
  const key = `people:${companyId}:${s.kind}:${s.query.toLowerCase()}:${s.limit}:${JSON.stringify(s.extra ?? null)}`;
  const saved = deps.store.cached<RawPerson[]>(key, deps.cacheDays);
  if (saved) return saved;
  try {
    const raw = await peopleAt(companyId, s.query, s.limit, s.extra, s.kind === "alumni");
    deps.store.save(key, raw);
    return raw;
  } catch (err) {
    if (err instanceof BudgetError || (err instanceof CrustdataError && STOP_STATUSES.has(err.status))) throw err;
    notes.push(`People search (${s.kind}) at ${companyName} failed: ${(err as Error).message}`);
    return null;
  }
}

/** People for one job: each search in the job's country first, anywhere when that finds nobody; nobody twice. */
async function peopleFor(job: Job, spellings: string[], country: string, deps: Deps, notes: string[]): Promise<Person[]> {
  const id = job.company.id;
  if (id === null) return [];
  const taken = new Set<string>();
  const out: Person[] = [];
  const want = WANT;
  for (const s of searchesFor(job, spellings, want, job.country ?? country)) {
    const raw = await searchOnce(id, job.company.name, s, spellings, deps, notes);
    let got = raw ? pick(s.kind, raw, id, want[s.kind], spellings, taken, job) : [];
    if (!got.length && s.local && raw) {
      const anywhere = await searchOnce(id, job.company.name, { ...s, extra: undefined, local: false }, spellings, deps, notes);
      got = anywhere ? pick(s.kind, anywhere, id, want[s.kind], spellings, taken, job) : [];
    }
    out.push(...got);
  }
  return out;
}

/** Work emails for the recruiter and the hiring manager, matched to this company. */
async function addEmails(results: JobResult[], deps: Deps, notes: string[]): Promise<void> {
  const targets = results.flatMap(r => r.people.filter(p => (p.kind === "recruiter" || p.kind === "manager") && p.profileUrl).map(p => ({ p, r })));
  const todo: string[] = [];
  for (const { p } of targets) {
    const cached = deps.store.cached<string | null>(`email:${profileKey(p.profileUrl)}`, deps.cacheDays);
    if (cached !== undefined) p.email = cached; else todo.push(p.profileUrl!);
  }
  if (!todo.length) return;
  let rows;
  try { rows = await workEmails([...new Set(todo)]); } catch (err) {
    if (err instanceof CrustdataError && err.status === 403) {
      notes.push("Work emails are not enabled on this Crustdata key (contact data needs enabling on your account; self-serve keys do not have it). Profile URLs are in the report.");
      return;
    }
    if (err instanceof BudgetError || (err instanceof CrustdataError && STOP_STATUSES.has(err.status))) throw err;
    notes.push(`Work emails failed: ${(err as Error).message}`);
    return;
  }
  const byUrl = new Map(rows.filter(r => typeof r.matched_on === "string").map(r => [profileKey(r.matched_on), r]));
  for (const { p, r } of targets) {
    if (p.email || !todo.includes(p.profileUrl!)) continue;
    const found = byUrl.get(profileKey(p.profileUrl))?.matches?.[0]?.person_data?.contact?.business_emails;
    const emails = (Array.isArray(found) ? found : []).filter(e => e && typeof e.email === "string");
    const domain = r.job.company.domain;
    // A business email list can include addresses at former employers: keep one at this company only.
    const hit = emails.find(e => Number(e.crustdata_company_id) === r.job.company.id || (domain && String(e.email).toLowerCase().endsWith(`@${domain}`)));
    p.email = hit?.email ?? null;
    deps.store.save(`email:${profileKey(p.profileUrl)}`, p.email);
  }
}

function seekerOf(p: Profile, cv: CvFacts): Seeker {
  return {
    skills: [...new Set([...cv.skills, ...p.skills])],
    titles: p.titles,
    years: p.yearsExperience ?? cv.years,
    remote: p.remote,
    needsSponsorship: p.needsSponsorship,
  };
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";

let runCount = 0;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function runId(kind: "hunt" | "job", label: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace("T", "-").replace(/:/g, "");
  // Two runs in the same second get their own folders.
  const n = (runCount = (runCount + 1) % 100);
  return `${stamp}${n > 1 ? `-${n}` : ""}-${kind === "job" ? "job-" : ""}${slug(label)}`;
}

/** Steps 6 to 10 for the chosen jobs: open check (already done for hunts), trend, score, people, notes. */
async function finish(chosen: Array<{ job: Job; open: Openness }>, p: Profile, cv: CvFacts, me: Seeker, spellings: string[], deps: Deps, opts: { emails: boolean; all?: boolean }, notes: string[]): Promise<JobResult[]> {
  const now = deps.now ?? new Date();
  const ids = [...new Set(chosen.map(c => c.job.company.id).filter((x): x is number => x !== null))];
  deps.log(`Headcount trend for ${ids.length} compan${ids.length === 1 ? "y" : "ies"}...`);
  const cos = ids.length ? await companies(ids, deps) : new Map<number, RawCompany>();
  // A role can come back under another listing's id; every folded id counts.
  const idsOf = (j: Job) => j.aliases?.length ? j.aliases : [j.id];
  const seen = deps.store.seenBefore(chosen.flatMap(c => idsOf(c.job)));
  const results: JobResult[] = [];
  let i = 0;
  for (const { job, open } of chosen) {
    i++;
    const momentum = momentumOf(job.company.id !== null ? cos.get(job.company.id) : undefined, job.company);
    const fit = scoreJob(job, me, momentum, now);
    // A weak fit is not worth paying for people (one job asked for by URL always is).
    const skip = !opts.all && fit.score < MIN_SCORE_FOR_PEOPLE;
    if (!skip) deps.log(`People at ${job.company.name} (${i} of ${chosen.length})...`);
    const people = skip ? [] : await peopleFor(job, spellings, p.country, deps, notes);
    results.push({ job, fit, momentum, open, daysAgo: daysSince(job.postedAt, now), isNew: !idsOf(job).some(id => seen.has(id)), people: people.map(x => ({ ...x, note: "" })) });
  }
  if (opts.emails) {
    deps.log("Work emails for recruiters and hiring managers...");
    await addEmails(results, deps, notes);
  }
  results.sort((a, b) => b.fit.score - a.fit.score);
  markRepeats(results);
  // An alumni note names the school of yours that this person also went to, in your own words for it.
  for (const r of results) {
    for (const x of r.people) x.note = draftNote(x, r.job, { handYears: p.yearsExperience, matched: r.fit.matched, school: x.kind === "alumni" ? sharedSchool(x.school) : null });
  }
  return results;
}

/**
 * Two jobs at one company find the same people. One person to write to first per company (on its best job), and
 * a person already listed under a better job is marked `alsoFor` that job: write to them once, about both roles.
 */
export function markRepeats(results: Array<{ job: Job; people: Person[] }>): void {
  const firstAt = new Set<string>();
  const seen = new Map<string, number>();
  results.forEach((r, i) => {
    const company = String(r.job.company.id ?? r.job.company.name.toLowerCase());
    for (const x of r.people) {
      const key = `${company}|${profileKey(x.profileUrl) ?? x.name.toLowerCase()}`;
      const before = seen.get(key);
      if (before !== undefined) x.alsoFor = before + 1;
      else seen.set(key, i);
    }
    if (!firstAt.has(company)) {
      chooseFirst(r.people.filter(x => x.alsoFor === undefined), r.job.title);
      if (r.people.some(x => x.first)) firstAt.add(company);
    }
  });
}

/** Jobs scoring below this get no people search unless --all. */
export const MIN_SCORE_FOR_PEOPLE = 50;

export type HuntOptions = { emails: boolean; dryRun: boolean; yes: boolean; maxCredits: number; all?: boolean };

/** A search: many jobs scanned and scored, people for the best `top`. */
export async function hunt(p: Profile, cv: CvFacts, opts: HuntOptions, deps: Deps): Promise<Run | { estimate: number; matching: number; stopped: string }> {
  try { return await huntRun(p, cv, opts, deps); } finally { budget.limit = Infinity; }
}

async function huntRun(p: Profile, cv: CvFacts, opts: HuntOptions, deps: Deps): Promise<Run | { estimate: number; matching: number; stopped: string }> {
  const now = deps.now ?? new Date();
  const startCredits = spend.credits;
  const startUsage = { ...usage };
  budget.limit = Infinity;
  const me = seekerOf(p, cv);
  const schools = p.schools.length ? p.schools : cv.schools;
  const notes: string[] = [];
  deps.store.purge(deps.cacheDays);

  const filters = jobFilters(p, now);
  const matching = await countJobs(filters);
  const scan = Math.min(p.scan, matching);
  const prices = await accountPrices();
  const worst = estimate(scan, Math.min(p.top, scan), opts.emails, prices);
  deps.log(`${matching.toLocaleString("en-US")} jobs match "${p.titles.join(" or ")}" ${p.remote === "only" ? `(remote, ${p.country})` : `within ${p.radiusMiles} miles of ${p.location}${p.remote === "also" ? `, plus remote jobs in ${p.country},` : ""}`} posted in the last ${p.days} days.`);
  if (!matching) return { estimate: 0, matching, stopped: "No jobs match. Try another title, a bigger --radius, more --days, or --also-remote." };
  deps.log(`Reading the newest ${scan} and looking up people for the best ${Math.min(p.top, scan)}: up to ${fmtCredits(worst)} credits (less when companies are cached).`);
  if (opts.dryRun) return { estimate: worst, matching, stopped: "Dry run: nothing was spent." };
  if (opts.maxCredits > 0 && worst > opts.maxCredits && !opts.yes) {
    return { estimate: worst, matching, stopped: `That is more than MAX_CREDITS_PER_RUN (${opts.maxCredits}). Run again with --yes, or lower --scan / --top.` };
  }

  // Stop the run if real charges go past the estimate (an account billed more than the prices read above).
  budget.limit = startCredits + worst * 1.25 + 0.5;
  const spellings = schools.length ? await schoolSpellingSet(schools, deps) : [];
  deps.log(`Reading ${scan} jobs...`);
  const raw: RawJob[] = await searchJobs(filters, scan);
  const all = raw.map(toJob).filter((j): j is Job => j !== null);
  const unique = dedupe(all);
  const skipped: Record<string, number> = {};
  const kept = unique.filter(j => {
    const why = skipReason(j, { agencies: !p.includeAgencies, companies: p.skipCompanies, titleWords: p.skipTitleWords });
    if (why) skipped[why] = (skipped[why] ?? 0) + 1;
    return !why;
  });

  // First pass: score without company growth (that is fetched only for the shortlist).
  const prelim = kept.map(job => ({ job, fit: scoreJob(job, me, momentumOf(undefined, job.company), now) }))
    .sort((a, b) => b.fit.score - a.fit.score);

  // Walk down the list until `top` jobs are open or cannot be checked; closed ones drop out.
  const check = deps.checkOpen ?? realCheckOpen;
  const chosen: Array<{ job: Job; open: Openness }> = [];
  const closed: Run["closed"] = [];
  let checked = 0;
  // Jobs whose company has no Crustdata record cannot get people: they only fill places left over.
  const ordered = [...prelim.filter(x => x.job.company.id !== null), ...prelim.filter(x => x.job.company.id === null)];
  for (let i = 0; i < ordered.length && chosen.length < p.top; i += 4) {
    const batch = ordered.slice(i, i + 4);
    const states = await Promise.all(batch.map(x => check(x.job.url)));
    batch.forEach((x, k) => {
      if (states[k] !== "not checked") checked++;
      if (states[k] === "closed") closed.push({ title: x.job.title, company: x.job.company.name, url: x.job.url });
      else if (chosen.length < p.top) chosen.push({ job: x.job, open: states[k] });
    });
  }

  const results = await finish(chosen, p, cv, me, spellings, deps, opts, notes);
  const weak = results.filter(r => !r.people.length && r.fit.score < MIN_SCORE_FOR_PEOPLE && !opts.all).length;
  if (weak) notes.push(`${weak} weak fit${weak === 1 ? "" : "s"} (under ${MIN_SCORE_FOR_PEOPLE}) got no people search, to save credits. Add --all to include them.`);
  const id = runId("hunt", `${p.titles[0]} ${p.remote === "only" ? "remote" : p.location}`, now);
  deps.store.markSeen(results.flatMap(r => (r.job.aliases?.length ? r.job.aliases : [r.job.id]).map(a => ({ id: a, company: r.job.company.name, title: r.job.title, url: r.job.url }))), id, now.toISOString());
  return {
    id, createdAt: now.toISOString(), kind: "hunt",
    search: { titles: p.titles, location: p.location, radiusMiles: p.radiusMiles, remote: p.remote, country: p.country, days: p.days },
    me: { skills: me.skills, schools, schoolSpellings: spellings, years: me.years, yearsFrom: p.yearsExperience !== null ? "you" : "cv", learning: cv.learning ?? [], needsSponsorship: p.needsSponsorship },
    counts: { matching, scanned: all.length, unique: unique.length, skipped, closed: closed.length, checked },
    jobs: results, closed, credits: round2(spend.credits - startCredits), estimate: round2(worst), listCredits: listCost(startUsage), notes,
  };
}

export type OneJob = { url?: string; id?: number; company?: string; title?: string };

/** "Try it on one job": a posting URL (or Crustdata job id), or a company website plus a title. */
export async function oneJob(target: OneJob, p: Profile, cv: CvFacts, opts: { emails: boolean }, deps: Deps): Promise<Run> {
  try { return await oneJobRun(target, p, cv, opts, deps); } finally { budget.limit = Infinity; }
}

async function oneJobRun(target: OneJob, p: Profile, cv: CvFacts, opts: { emails: boolean }, deps: Deps): Promise<Run> {
  const now = deps.now ?? new Date();
  const startCredits = spend.credits;
  const startUsage = { ...usage };
  budget.limit = Infinity;
  const me = seekerOf(p, cv);
  const schools = p.schools.length ? p.schools : cv.schools;
  const notes: string[] = [];
  deps.store.purge(deps.cacheDays);

  let job: Job | null = null;
  if (target.url || target.id !== undefined) {
    deps.log("Looking up the posting...");
    const variants = target.url ? urlVariants(target.url) : [undefined];
    for (const v of variants) {
      const raw = await findJob(target.id !== undefined ? { id: target.id } : { url: v });
      if (raw) { job = toJob(raw); break; }
    }
    if (!job && !target.company) {
      throw new Error("That posting is not in the Crustdata job index (it may be new, or on a site the index does not cover). The lookup cost nothing. Try the company's website and the job title instead: npm run job -- --company <company website> --title \"<job title>\"");
    }
  }
  if (!job) {
    const domain = (target.company ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
    if (!domain || !domain.includes(".")) throw new Error("--company needs the company's website, for example --company acme.com");
    if (!target.title) throw new Error("--company needs --title too, for example --title \"Backend Engineer\"");
    deps.log(`Looking up ${domain}...`);
    const c = await companyByDomain(domain);
    if (!c?.crustdata_company_id) throw new Error(`Crustdata has no company with the website ${domain}. Check the spelling (the main website, not a careers site).`);
    job = {
      id: `manual-${c.crustdata_company_id}-${slug(target.title)}`, title: target.title, url: target.url ?? null, source: null,
      category: null, workplace: null, employmentType: null, location: null, city: null, state: null, country: null, postedAt: null, description: "",
      company: { id: c.crustdata_company_id, name: c.basic_info?.name ?? domain, domain, industries: [], headcount: c.headcount?.total ?? null, lastRound: null, lastRoundDate: null, totalRaisedUsd: null },
      alsoListed: 0,
    };
    deps.store.save(`company:${c.crustdata_company_id}`, c);
    notes.push("No posting text, so the fit score uses the title, level and company only.");
  }
  const spellings = schools.length ? await schoolSpellingSet(schools, deps) : [];
  const open = await (deps.checkOpen ?? realCheckOpen)(job.url);
  if (open === "closed") notes.push("The job board says this posting is closed.");
  const worst = estimate(3, 1, opts.emails, await accountPrices());
  budget.limit = startCredits + worst * 1.25 + 0.5;
  const results = await finish([{ job, open }], p, cv, me, spellings, deps, { ...opts, all: true }, notes);
  const id = runId("job", `${job.company.name} ${job.title}`, now);
  deps.store.markSeen(results.map(r => ({ id: r.job.id, company: r.job.company.name, title: r.job.title, url: r.job.url })), id, now.toISOString());
  return {
    id, createdAt: now.toISOString(), kind: "job",
    search: { titles: p.titles, location: p.location, radiusMiles: p.radiusMiles, remote: p.remote, country: p.country, days: p.days },
    me: { skills: me.skills, schools, schoolSpellings: spellings, years: me.years, yearsFrom: p.yearsExperience !== null ? "you" : "cv", learning: cv.learning ?? [], needsSponsorship: p.needsSponsorship },
    counts: { matching: 1, scanned: 1, unique: 1, skipped: {}, closed: open === "closed" ? 1 : 0, checked: open === "not checked" ? 0 : 1 },
    jobs: results, closed: [], credits: round2(spend.credits - startCredits), estimate: round2(worst), listCredits: listCost(startUsage), notes,
  };
}

/**
 * The URL as pasted, then cleaned: tracking parameters dropped, and a job board link copied from a search or
 * collection page ("?currentJobId=123", "/jobs/view/some-title-123") turned into the posting's own address.
 */
export function urlVariants(url: string): string[] {
  const out = [url.trim()];
  try {
    const u = new URL(url.trim());
    const id = u.searchParams.get("currentJobId") ?? /\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/.exec(u.pathname)?.[1];
    if (id && /^\d{6,}$/.test(id)) out.unshift(`https://www.${u.hostname.replace(/^www\./, "")}/jobs/view/${id}`);
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (!/^(utm_|ref|source|src|trk|refid|trackingid|lipi|gh_src|lever-|currentjobid|origin)/i.test(k)) keep.set(k, v);
    u.search = keep.toString();
    u.hash = "";
    out.push(u.toString(), u.toString().replace(/\/+$/, ""));
  } catch { /* not a URL: try as pasted */ }
  return [...new Set(out)].slice(0, 3);
}
