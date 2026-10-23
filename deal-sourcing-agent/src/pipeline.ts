/**
 * The pure middle of a run: raw Crustdata records in, scored and ranked deals out, plus the re-run diff (new, still
 * here, back, gone, and what changed) and the CSV rows. No I/O, so `npm run replay` and the tests run the exact code a
 * live run does.
 */

import { annotate, domainOf, pickFounders } from "./founders.js";
import { monthYear, scoreDeal, stageName, type ScoreSpec } from "./score.js";
import { detectDelimiter, parseCsv } from "./csv.js";
import type { Company, Deal, Founder, Jobs, Posts, RawCompany, RawProfile } from "./types.js";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A YYYY-MM-DD date that is real and not after today; anything else is treated as not on record. */
function validDate(d: string | null | undefined, today: Date): string | undefined {
  const s = d?.slice(0, 10);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) return undefined;
  if (new Date(s + "T00:00:00Z").toISOString().slice(0, 10) !== s) return undefined; // 2026-02-30
  return s <= today.toISOString().slice(0, 10) ? s : undefined;
}

/** The fields a memo uses, from one company search result. Contact fields in `funding` are never copied. */
export function toCompany(r: RawCompany, today = new Date()): Company {
  const b = r.basic_info ?? {}, h = r.headcount ?? {}, f = r.funding ?? {}, l = r.locations ?? {}, fo = r.followers ?? {};
  return {
    id: r.crustdata_company_id,
    name: (b.name ?? "").trim() || "(no name)",
    domain: (b.primary_domain ?? domainOf(b.website) ?? "").toLowerCase(),
    website: b.website || undefined,
    profileUrl: b.professional_network_url || undefined,
    description: b.description?.trim() || undefined,
    founded: num(b.year_founded),
    hq: l.headquarters || [l.city, l.state, l.country].filter(Boolean).join(", ") || undefined,
    country: l.country || undefined,
    headcount: num(h.total),
    growth3m: num(h.growth_percent?.["3m"]),
    growth6m: num(h.growth_percent?.["6m"]),
    growth12m: num(h.growth_percent?.["12m"]),
    added6m: num(h.growth_absolute?.["6m"]),
    added3m: num(h.growth_absolute?.["3m"]),
    followers: num(fo.count),
    followers6m: num(fo.six_months_growth_percent),
    // Stored round types look like "seed" or "series_a"; anything else is not a round type and is not shown.
    lastRound: f.last_round_type && /^[a-z_]{2,30}$/.test(f.last_round_type) ? f.last_round_type : undefined,
    lastRoundDate: validDate(f.last_fundraise_date, today),
    lastRoundUsd: num(f.last_round_amount_usd) || undefined,
    totalUsd: num(f.total_investment_usd) || undefined,
    investors: (f.investors ?? []).filter(Boolean),
  };
}

export const EMPTY_JOBS: Jobs = { last30: null, last90: null, newest: [] };
export const EMPTY_POSTS: Posts = { traction: null, raise: null, quotes: [] };

export type Inputs = {
  companies: RawCompany[];
  profiles: RawProfile[];
  jobs: { [companyId: string]: Partial<Jobs> };
  posts: { [companyId: string]: Partial<Posts> };
};

export type Pipeline = { deals: Deal[]; droppedNoListFounder: number; droppedExcludedInvestor: number };

/** Memo file names: the domain, plus the company id when two companies share a domain or there is none. */
export function memoNames(companies: Company[]): Map<number, string> {
  const count = new Map<string, number>();
  for (const c of companies) count.set(c.domain, (count.get(c.domain) ?? 0) + 1);
  const safe = (s: string) => s.replace(/[^a-z0-9.-]/gi, "_").replace(/^\.+|\.+$/g, "");
  return new Map(companies.map(c => { const s = safe(c.domain); return [c.id, `${s && count.get(c.domain) === 1 ? s : `${s || "company"}-${c.id}`}.md`]; }));
}
export const memoFile = (d: Deal) => d.memo ?? `${(d.company.domain || `company-${d.company.id}`).replace(/[^a-z0-9.-]/gi, "_")}.md`;

/**
 * Builds and ranks the pipeline. Search order breaks ties, so two companies with the same score keep the order of
 * relevance to the thesis. The same company returned twice is kept once.
 */
export function buildPipeline(inputs: Inputs, spec: ScoreSpec & { onlyFoundersFrom?: boolean; excludeInvestors?: string[] }, today: Date, history?: History): Pipeline {
  let droppedNoListFounder = 0, droppedExcludedInvestor = 0;
  const seenIds = new Set<number>();
  const companies = inputs.companies.filter(c => !seenIds.has(c.crustdata_company_id) && seenIds.add(c.crustdata_company_id)).map(c => toCompany(c, today));
  const names = memoNames(companies);
  const lastRun = new Set(history?.runs.at(-1)?.ids ?? []);
  const deals: Array<Deal & { order: number }> = [];
  companies.forEach((company, order) => {
    // The search filters on excluded investors already; this catches investor names that differ only in case.
    const ex = (spec.excludeInvestors ?? []).map(s => s.toLowerCase());
    if (ex.length && company.investors.some(i => ex.includes(i.toLowerCase()))) { droppedExcludedInvestor++; return; }
    const founders = pickFounders(inputs.profiles, company.id, spec.foundersFrom, spec.schools);
    if (spec.onlyFoundersFrom && !founders.some(f => f.fromList.length)) { droppedNoListFounder++; return; }
    const jobs: Jobs = { ...EMPTY_JOBS, ...inputs.jobs[company.id] };
    // When posts were counted in this run, a company with no entry (a resumed run, changed flags) was not checked.
    const postsRan = Object.keys(inputs.posts).length > 0;
    const posts: Posts = inputs.posts[company.id] ? { ...EMPTY_POSTS, ...inputs.posts[company.id] }
      : postsRan ? { ...EMPTY_POSTS, unchecked: "rank", skipped: "not checked in this run" } : { ...EMPTY_POSTS };
    const score = scoreDeal(company, founders, jobs, posts, spec, today);
    const seen = history?.seen[company.id];
    deals.push({
      company, founders, jobs, posts, score,
      status: !seen ? "new" : lastRun.has(company.id) ? "still here" : "back",
      firstSeen: seen?.firstSeen ?? today.toISOString().slice(0, 10),
      change: seen ? changeSince(seen, company, score.total, score.timing.label) : undefined,
      lastScore: seen?.score,
      memo: names.get(company.id),
      order,
    });
  });
  deals.sort((a, b) => b.score.total - a.score.total || a.order - b.order);
  return { deals: deals.map(({ order, ...d }) => d), droppedNoListFounder, droppedExcludedInvestor };
}

/** Re-scores saved deals after a change to --founders-from, --schools or --timing. Costs nothing. */
export function rescore(deals: Deal[], spec: ScoreSpec & { onlyFoundersFrom?: boolean }, today: Date): Deal[] {
  return deals
    .map(d => {
      const founders: Founder[] = d.founders.map(f => annotate(f, d.company.id, spec.foundersFrom, spec.schools));
      return { ...d, founders, score: scoreDeal(d.company, founders, d.jobs, d.posts, spec, today) };
    })
    .filter(d => !spec.onlyFoundersFrom || d.founders.some(f => f.fromList.length))
    .sort((a, b) => b.score.total - a.score.total);
}

// ---------------------------------------------------------------------------
// Re-runs: the same thesis again marks new, still here, back and gone, and says what changed.
// ---------------------------------------------------------------------------

export type Seen = {
  name: string; domain: string; firstSeen: string; lastSeen: string;
  score?: number; label?: string; headcount?: number; lastRound?: string; lastRoundDate?: string;
};
export type History = { key: string; runs: Array<{ at: string; ids: number[] }>; seen: { [id: string]: Seen } };
/** history.json holds one history per pipeline (thesis and filters), so trying another thesis loses nothing. */
export type HistoryFile = { pipelines: { [key: string]: History } };
export type Gone = { id: number; name: string; domain: string; firstSeen: string; lastSeen: string };

/** "score 61 to 74; Due, some growth to Due and growing; team 9 to 14; new round: Series A". Empty when nothing moved. */
export function changeSince(seen: Seen, c: Company, score: number, label: string): string | undefined {
  const parts: string[] = [];
  if (seen.score !== undefined && seen.score !== score) parts.push(`score ${seen.score} to ${score}`);
  if (seen.label && seen.label !== label) parts.push(`${seen.label} to ${label}`);
  if (seen.headcount !== undefined && c.headcount !== undefined && seen.headcount !== c.headcount) parts.push(`team ${seen.headcount} to ${c.headcount}`);
  if (c.lastRoundDate && seen.lastRoundDate !== undefined && c.lastRoundDate !== seen.lastRoundDate) parts.push(`new round: ${stageName(c.lastRound) || "round"} (${monthYear(c.lastRoundDate)})`);
  return parts.length ? parts.join("; ") : undefined;
}

/** The history after this run, and the companies of the last run of this pipeline that are not in this one. */
export function updateHistory(previous: History | undefined, key: string, deals: Deal[], now: Date): { history: History; gone: Gone[]; samePipeline: boolean } {
  const samePipeline = !!previous && previous.key === key && previous.runs.length > 0;
  const base: History = previous && previous.key === key ? previous : { key, runs: [], seen: {} };
  const today = now.toISOString().slice(0, 10);
  const ids = deals.map(d => d.company.id);
  const lastIds = base.runs.at(-1)?.ids ?? [];
  const current = new Set(ids);
  const gone = lastIds.filter(id => !current.has(id)).map(id => ({ id, ...base.seen[id] }));
  const seen = { ...base.seen };
  for (const d of deals) seen[d.company.id] = {
    name: d.company.name, domain: d.company.domain, firstSeen: seen[d.company.id]?.firstSeen ?? today, lastSeen: today,
    score: d.score.total, label: d.score.timing.label, headcount: d.company.headcount, lastRound: d.company.lastRound, lastRoundDate: d.company.lastRoundDate ?? "",
  };
  return { history: { key, runs: [...base.runs, { at: now.toISOString(), ids }].slice(-50), seen }, gone, samePipeline };
}

// ---------------------------------------------------------------------------
// Exclusions: domains typed on the command line, or any CSV with a domain or website column.
// ---------------------------------------------------------------------------

/** Column names that hold a domain or website, in CRM and spreadsheet exports (HubSpot, Salesforce, Affinity, Attio). */
const DOMAIN_COLUMN = /domain|website|url|homepage|web site/i;
/** Columns with someone's social profile (a profile URL column, a social handle) are not the company's domain. */
const SOCIAL_COLUMN = /linked|twitter|facebook|instagram|crunchbase|profile|social|\bx\b/i;
const SOCIAL_DOMAIN = /(^|\.)(?:linked\w*|twitter|x|facebook|instagram|crunchbase|angel)\.(?:com|co)$/;

/** Every domain in one cell: "acme.com; acme.io", "https://www.acme.com/about". Emails and words are ignored. */
export function domainsInCell(cell: string): string[] {
  return cell.split(/[;,\s|]+/).map(v => v.trim()).filter(v => v && !v.includes("@") && /\./.test(v))
    .map(v => domainOf(v.includes("://") ? v : `https://${v}`)).filter((d): d is string => !!d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && !SOCIAL_DOMAIN.test(d));
}

/**
 * Domains from a CSV file's text. Reads every column whose name says domain, website or URL; with no such column, it
 * returns nothing and says so (a file of names alone cannot be matched). A plain list of domains with no header works.
 */
export function domainsFromCsv(text: string): { domains: string[]; rows: number; rowsWithout: number; noColumn: boolean } {
  const rows = parseCsv(text, detectDelimiter(text));
  if (!rows.length) return { domains: [], rows: 0, rowsWithout: 0, noColumn: false };
  const header = rows[0].map(h => h.trim());
  const cols = header.map((h, i) => (DOMAIN_COLUMN.test(h) && !SOCIAL_COLUMN.test(h) ? i : -1)).filter(i => i >= 0);
  const headerIsData = header.some(h => domainsInCell(h).length);
  if (!cols.length && !headerIsData) return { domains: [], rows: rows.length - 1, rowsWithout: rows.length - 1, noColumn: true };
  const body = cols.length ? rows.slice(1) : rows;
  const out = new Set<string>();
  let rowsWithout = 0;
  for (const row of body) {
    const found = (cols.length ? cols.map(i => row[i] ?? "") : row).flatMap(domainsInCell);
    if (!found.length) rowsWithout++;
    found.forEach(d => out.add(d));
  }
  return { domains: [...out], rows: body.length, rowsWithout, noColumn: false };
}

// ---------------------------------------------------------------------------
// CSV rows
// ---------------------------------------------------------------------------

const r1 = (n?: number) => (n === undefined ? undefined : Math.round(n * 10) / 10);

export const PIPELINE_HEADER = ["rank", "score", "points scored on", "status", "change since last run", "timing", "name", "domain", "stage", "last round date", "last round USD",
  "total raised USD", "investors", "founded", "HQ", "headcount", "growth 3m %", "growth 6m %", "roles posted 30d", "roles posted 90d",
  "followers growth 6m %", "founder traction posts 6m", "founders", "repeat founder", "profile URL", "crustdata id", "memo", "first seen"];

export function pipelineRows(deals: Deal[]): unknown[][] {
  return deals.map((d, i) => {
    const c = d.company;
    return [i + 1, d.score.total, d.score.scoredOn !== undefined ? `${d.score.scoredOn} of ${d.score.applies}` : "", d.status, d.change, d.score.timing.label, c.name, c.domain, stageName(c.lastRound) || "No round", c.lastRoundDate, c.lastRoundUsd, c.totalUsd,
      c.investors, c.founded, c.hq, c.headcount, r1(c.growth3m), r1(c.growth6m), d.jobs.last30, d.jobs.last90, r1(c.followers6m),
      d.posts.traction, d.founders.map(f => `${f.name} (${f.title})`), d.founders.some(f => f.priorFounder.length) ? "yes" : "no",
      c.profileUrl, c.id, `memos/${memoFile(d)}`, d.firstSeen];
  });
}

export const FOUNDERS_HEADER = ["company", "domain", "name", "title", "since", "repeat founder", "past founder roles", "from your list", "past roles",
  "schools", "also now", "profile URL", "crustdata person id"];

export function founderRows(deals: Deal[]): unknown[][] {
  return deals.flatMap(d => d.founders.map(f => [
    d.company.name, d.company.domain, f.name, f.title, monthYear(f.since), f.priorFounder.length ? "yes" : "no",
    f.priorFounder.map(r => `${r.title} at ${r.company}`), f.fromList.map(h => h.role.company || h.entry),
    f.past.slice(0, 5).map(r => `${r.title} at ${r.company}`), f.schools.map(s => s.school), f.alsoNow.map(r => `${r.title} at ${r.company}`),
    f.profileUrl, f.personId,
  ]));
}
