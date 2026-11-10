/**
 * The three runs, with every Crustdata call going through `Api` (the real client, or a fixture in tests and replay):
 *
 *   importPortfolio  resolve the portfolio, find leaders, find careers pages, save the starting point, set up watchers
 *   runCheck         the daily run: read new watcher runs, read careers pages when due, apply the rules, post alerts
 *   runDigest        the weekly summary: every signal since the last digest, grouped by company
 */

import { config, hasEmail, hasSlack } from "./config.js";
import { boardLinks, careersCandidates, countRoles } from "./careers.js";
import { orderCompanies } from "./digest.js";
import * as crustdata from "./crustdata.js";
import { CrustdataError, creditsUsed, LEADER_PRICE_WORST, LEADER_SEARCH_LIMIT, type CompanyMatch, type Dataset, type Watch } from "./crustdata.js";
import { atCompany, leaderEvent, leaderRole, pickLeaders, type Leader } from "./leaders.js";
import { normalizeProfileUrl, type Portfolio, type PortfolioRow } from "./portfolio.js";
import { fundingSignals, headcountSignals, hiringSignals, leaderJoinedSignal, leaderSignal, newsSignals, startingPoint, teamSignals, type Change, type CompanyRef } from "./signals.js";
import { LEFT_WATCH_DAYS, type Company, type Store, type StoredSignal } from "./store.js";
import type { Thresholds } from "./thresholds.js";
import { isoDate, type Signal } from "./types.js";

export type Api = Pick<typeof crustdata,
  | "identifyCompanies" | "enrichCompanies" | "searchLeaders" | "enrichPeople" | "fetchPages" | "jobIndexCounts"
  | "createCompanyWatch" | "createPersonWatch" | "setCompanyEntities" | "setPersonEntities" | "getWatch"
  | "listActiveWatches" | "setWatchStatus" | "deleteWatch" | "newRunRecords" | "listRuns" | "getCreditBalance">;

export type Ctx = { store: Store; api: Api; thresholds: Thresholds; now?: Date; log?: (s: string) => void };

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const ref = (c: Company): CompanyRef => ({ domain: c.domain, name: c.name, companyId: c.companyId });

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type Resolved = { row: PortfolioRow; domain: string; name: string; companyId: number };
export type Unresolved = { row: PortfolioRow; reason: string; candidates?: string[] };

export type ImportPlan = {
  add: Resolved[];
  keep: Resolved[];
  remove: Company[];
  unresolved: Unresolved[];
  skipped: Portfolio["skipped"];
  duplicates: number;
  /** Companies already stored whose leaders or careers page were never looked up (an import stopped halfway). */
  unfinished: string[];
  /** Of those, the ones still needing a leader search, and the ones still needing a careers page. */
  unfinishedLeaders: string[];
  unfinishedCareers: string[];
  /** Profile URLs listed in the portfolio and not watched yet. */
  newCsvLeaders: { url: string; domain: string }[];
};

const normName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Picks the company a name stands for, or says why it cannot. Only one company at the top confidence (or only one
 * whose name is exactly the one given) is taken; "Linear" matches three companies at full confidence, so it is not.
 */
export function pickByName(input: string, matches: CompanyMatch[]): { match?: CompanyMatch; reason?: string; candidates?: string[] } {
  const withSite = matches.filter(m => m.domain);
  if (!withSite.length) return { reason: matches.length ? "matched companies have no website in Crustdata; add the website" : "no company by that name in Crustdata; add the website" };
  const top = Math.max(...withSite.map(m => m.confidence));
  const best = withSite.filter(m => m.confidence >= top - 1e-9);
  const exact = best.filter(m => normName(m.name) === normName(input));
  if (best.length === 1) return { match: best[0] };
  if (exact.length === 1) return { match: exact[0] };
  return { reason: `${best.length} companies match "${input}"; add the website to pick one`, candidates: best.slice(0, 3).map(m => m.domain!) };
}

/** Resolves the portfolio against what is stored (identify is free) and works out what changes. Spends nothing. */
export async function planImport(ctx: Ctx, portfolio: Portfolio): Promise<ImportPlan> {
  const { store, api } = ctx;
  const stored = new Map(store.companies().map(c => [c.domain, c]));
  const resolved: Resolved[] = [];
  const unresolved: Unresolved[] = [];
  let duplicates = portfolio.duplicates;

  const byDomain = portfolio.rows.filter(r => r.domain);
  const needIdentify = byDomain.filter(r => !stored.get(r.domain!)?.companyId).map(r => r.domain!);
  const domainHits = needIdentify.length ? await api.identifyCompanies(needIdentify, "domains") : {};
  for (const row of byDomain) {
    const s = stored.get(row.domain!);
    if (s?.companyId) { resolved.push({ row, domain: s.domain, name: row.name ?? s.name, companyId: s.companyId }); continue; }
    const m = domainHits[row.domain!]?.[0];
    if (!m) { unresolved.push({ row, reason: "not in Crustdata's company data yet (check the website, or try again in a few weeks)" }); continue; }
    resolved.push({ row, domain: row.domain!, name: row.name ?? m.name, companyId: m.id });
  }

  const byName = portfolio.rows.filter(r => !r.domain && r.name);
  const storedByName = new Map([...stored.values()].map(c => [normName(c.name), c]));
  const toLookUp = byName.filter(r => !storedByName.get(normName(r.name!))?.companyId);
  const nameHits = toLookUp.length ? await api.identifyCompanies(toLookUp.map(r => r.name!), "names") : {};
  for (const row of byName) {
    const s = storedByName.get(normName(row.name!));
    if (s?.companyId) { resolved.push({ row, domain: s.domain, name: row.name!, companyId: s.companyId }); continue; }
    const pick = pickByName(row.name!, nameHits[row.name!] ?? []);
    if (!pick.match) { unresolved.push({ row, reason: pick.reason!, candidates: pick.candidates }); continue; }
    resolved.push({ row, domain: pick.match.domain!, name: row.name!, companyId: pick.match.id });
  }

  // Two rows that turn out to be the same company (same website, or two websites of one Crustdata company): keep the first.
  const seen = new Set<string>();
  const seenIds = new Set<number>();
  const unique = resolved.filter(r => {
    if (seen.has(r.domain) || seenIds.has(r.companyId)) { duplicates++; return false; }
    seen.add(r.domain); seenIds.add(r.companyId); return true;
  });
  const add = unique.filter(r => !stored.has(r.domain));
  const keep = unique.filter(r => stored.has(r.domain));
  // A row that could not be resolved this time keeps its company (no removal on a lookup hiccup).
  const holding = new Set(unresolved.flatMap(u => (u.row.domain ? [u.row.domain] : [])));
  const remove = [...stored.values()].filter(c => !seen.has(c.domain) && !holding.has(c.domain));
  const unfinishedLeaders = keep.filter(r => !store.getMeta(`leaders_searched:${r.domain}`) && !r.row.leaders.length).map(r => r.domain);
  // A careers page that changed in the portfolio is looked up again (its old readings are not comparable).
  // Compared with what the portfolio said last time, not with the page actually read (often the job board it links to).
  // A database from before careers_input existed has nothing to compare: the portfolio's value is simply adopted.
  const careersChanged = (r: Resolved) => Boolean(r.row.careers) && stored.get(r.domain)?.careersInput !== undefined && r.row.careers !== stored.get(r.domain)?.careersInput;
  // ("" means the row had no careers page; undefined means a database from before this was kept.)
  const unfinishedCareers = keep.filter(r => !store.getMeta(`careers_checked:${r.domain}`) || careersChanged(r)).map(r => r.domain);
  const unfinished = [...new Set([...unfinishedLeaders, ...unfinishedCareers])];

  const active = new Set(store.leaders().map(l => `${l.profileUrl}|${l.domain}`));
  const known = new Set(store.leaders(undefined, { all: true }).map(l => `${l.profileUrl}|${l.domain}`));
  // Listed leaders not watched now: new ones are looked up (1 credit each); known ones are simply watched again. One
  // that was looked up before and had no role at the company is not paid for again until the cell changes.
  const newCsvLeaders = unique.flatMap(r => r.row.leaders.filter(url => !active.has(`${url}|${r.domain}`) && !known.has(`${url}|${r.domain}`) && store.getMeta(`csv_unmatched:${r.domain}:${url}`) !== r.row.leaders.join(" ")).map(url => ({ url, domain: r.domain })));
  return { add, keep, remove, unresolved, skipped: portfolio.skipped, duplicates, unfinished, unfinishedLeaders, unfinishedCareers, newCsvLeaders };
}

/** Worst-case credits for an import plan, at list prices, with what each part is for. */
export function estimateImport(plan: ImportPlan): { total: number; typical: number; lines: string[] } {
  const n = plan.add.length;
  const searches = plan.add.filter(r => !r.row.leaders.length).length + plan.unfinishedLeaders.length;
  const careersCompanies = n + plan.unfinishedCareers.length;
  // Up to /careers, /jobs and the job board a thin careers page links to.
  const careersTries = plan.add.reduce((s, r) => s + (r.row.careers ? 2 : 3), 0) + plan.unfinishedCareers.length * 3;
  const lines: string[] = [];
  if (n) lines.push(`${n} company record${n === 1 ? "" : "s"} for the starting point: ${2 * n} credits (2 each)`);
  const searchWorst = LEADER_SEARCH_LIMIT * LEADER_PRICE_WORST;
  if (searches) lines.push(`founders and C-level at ${searches} compan${searches === 1 ? "y" : "ies"}: up to ${round2(searches * searchWorst)} credits at Crustdata's listed price (at least 1 a company; our live runs were billed less)`);
  if (careersCompanies) lines.push(`careers pages: up to ${careersTries} credits (1 per page read: /careers, /jobs, or the job board they link to)`);
  if (plan.newCsvLeaders.length) lines.push(`${plan.newCsvLeaders.length} leader${plan.newCsvLeaders.length === 1 ? "" : "s"} listed by profile URL: up to ${plan.newCsvLeaders.length} credits (1 each)`);
  const total = round2(2 * n + searches * searchWorst + careersTries + plan.newCsvLeaders.length);
  // Typical: each search billed at least 1 credit (fractional costs round up in the balance), careers pages 1.3 a company.
  const typical = round2(2 * n + searches * 1 + careersCompanies * 1.3 + plan.newCsvLeaders.length);
  return { total, typical, lines };
}

/**
 * Monthly cost at list prices. The watchers bill 5 credits for every company or leader that changed on a run, even a
 * change too small to alert on (one person joining, an ordinary article), so a quiet month assumes one change per
 * company and a busy one four, plus one leader in ten changing.
 */
export function estimateMonth(companies: number, leaders: number, leaderPrice: number, careersCompanies = companies): { quiet: number; busy: number; lines: string[] } {
  const pages = Math.round(careersCompanies * (30 / config.hiringCheckDays));
  // The monthly leader search: at least 1 credit a company (Crustdata rounds a fractional request up in the balance),
  // up to 2.76 at its listed price.
  const search = companies;
  const quiet = pages + search + companies * 5;
  const searchWorst = Math.ceil(companies * 25 * LEADER_PRICE_WORST); // the monthly search returns up to 25 people
  const busy = pages + searchWorst + companies * 4 * 5 + Math.ceil(leaders * 0.1) * leaderPrice;
  return {
    quiet,
    busy,
    lines: [
      `careers pages: about ${pages} credits (1 per company every ${config.hiringCheckDays} days)`,
      `company watcher: 5 credits each time a company's record changes on a run, even a change too small to alert on (most change one to four times a month)`,
      `leader watcher: ${leaderPrice} credits each time one of ${leaders} leaders' profile changes (rare)`,
      `monthly leader search: ${search} to ${searchWorst} credits (at least 1 a company; up to 5.75 at Crustdata's listed price)`,
    ],
  };
}

export type ImportResult = {
  added: number;
  removed: string[];
  leadersAdded: number;
  starting: { domain: string; name: string; line: string; leaders: string[]; hiring: string; flag?: Signal }[];
  watches: Partial<Record<Dataset, number>>;
  notes: string[];
  creditsUsed: number;
};

/**
 * Applies a plan. Saves after every step, so an import stopped halfway is finished by the next one without paying
 * twice. Ends by making the two watchers hold exactly the current companies and leaders.
 */
export async function importPortfolio(ctx: Ctx, plan: ImportPlan): Promise<ImportResult> {
  const { store, api, thresholds: t } = ctx;
  const log = ctx.log ?? (() => {});
  const now = ctx.now ?? new Date();
  const nowIso = now.toISOString();
  const spentBefore = creditsUsed.total;
  const notes: string[] = [];
  const result: ImportResult = { added: 0, removed: [], leadersAdded: 0, starting: [], watches: {}, notes, creditsUsed: 0 };

  for (const c of plan.remove) { store.removeCompany(c.domain); result.removed.push(c.name); }
  for (const r of plan.keep) {
    const s = store.company(r.domain)!;
    const careersChanged = Boolean(r.row.careers) && s.careersInput !== undefined && r.row.careers !== s.careersInput;
    store.saveCompany({ ...s, name: r.name, owner: r.row.owner, careersUrl: careersChanged ? r.row.careers : s.careersUrl, careersInput: r.row.careers ?? "" });
    // A new careers page: its counts are not comparable with the old page's, so start its readings again.
    if (careersChanged) { store.clearReadings(r.domain); store.deleteMeta(`careers_checked:${r.domain}`); }
  }

  // 1. Starting point: one company record each (2 credits).
  if (plan.add.length) {
    log(`Reading ${plan.add.length} company record${plan.add.length === 1 ? "" : "s"}...`);
    const records = await api.enrichCompanies(plan.add.map(r => r.companyId));
    for (const r of plan.add) {
      const record = records[r.companyId];
      const odd = sizeMismatch(record);
      if (odd) notes.push(`${r.name}: Crustdata counts ${odd.total} people but sizes the company at ${odd.range} employees, so people at other companies with the same name are probably counted. Treat its headcount alerts with care, and list its leaders by profile URL in a "leaders" column (that list replaces the automatic search).`);
      const sp = startingPoint({ domain: r.domain, name: r.name, companyId: r.companyId }, record, t);
      store.saveCompany({ domain: r.domain, name: r.name, companyId: r.companyId, owner: r.row.owner, careersUrl: r.row.careers, careersInput: r.row.careers ?? "", hiringSource: "none", addedAt: nowIso, start: sp.line });
      if (record) store.saveRef(r.domain, record, nowIso);
      if (typeof record?.headcount?.total === "number") store.addPoint(r.domain, nowIso, record.headcount.total);
      if (sp.flag) store.addSignal(sp.flag, nowIso);
      result.added++;
    }
  }

  // A row that lists its leaders replaces the automatic search: anyone not on the list stops being watched, and
  // anyone on it who was watched before (or marked gone) is watched again.
  // A row whose leaders column was cleared: back to the automatic search.
  // The people the list had set aside are watched again, and the next search is a quiet first search (no "New leader").
  for (const r of plan.keep.filter(k => !k.row.leaders.length)) {
    const listedBefore = store.leaders(r.domain, { all: true }).filter(x => x.source === "csv");
    const setAside = store.leaders(r.domain, { all: true }).filter(x => x.status === "removed");
    if (!listedBefore.length && !setAside.length) continue;
    for (const l of listedBefore) store.setLeaderSource(l.profileUrl, r.domain, "search");
    for (const l of setAside) store.setLeaderStatus(l.profileUrl, r.domain, "active");
    store.deleteMeta(`leaders_searched:${r.domain}`);
  }
  const listed = new Map([...plan.add, ...plan.keep].filter(r => r.row.leaders.length).map(r => [r.domain, new Set(r.row.leaders)]));
  for (const [domain, urls] of listed) {
    for (const l of store.leaders(domain, { all: true })) {
      if (!urls.has(l.profileUrl) && l.status !== "removed") store.setLeaderStatus(l.profileUrl, domain, "removed");
      // Back on the list after being taken off: watched again. A leader recorded as gone stays gone (no second alert),
      // and the import says so.
      else if (urls.has(l.profileUrl) && l.status === "removed") store.setLeaderStatus(l.profileUrl, domain, "active");
      else if (urls.has(l.profileUrl) && l.status === "left") notes.push(`${l.company}: ${l.name} is in the leaders column but was recorded as leaving${l.leftAt ? ` on ${l.leftAt.slice(0, 10)}` : ""}, so they are not watched as a leader there. Remove them from the column, or keep them if they have come back (the monthly search picks up a return).`);
      // Listed by the fund: the monthly search leaves this company alone.
      if (urls.has(l.profileUrl) && l.source !== "csv") store.setLeaderSource(l.profileUrl, domain, "csv");
    }
    store.setMeta(`leaders_searched:${domain}`, nowIso);
  }

  const pending = [...plan.add.map(r => r.domain), ...plan.unfinished];

  // 2. Leaders: founders and C-level, one search per company.
  for (const domain of pending) {
    if (store.getMeta(`leaders_searched:${domain}`)) continue;
    const c = store.company(domain);
    if (!c?.companyId) continue;
    log(`Finding founders and C-level at ${c.name}...`);
    const found = pickLeaders(await api.searchLeaders(c.companyId), config.maxLeadersPerCompany);
    for (const p of found) {
      store.saveLeader({ profileUrl: normalizeProfileUrl(p.profileUrl!), personId: p.personId, name: p.name, title: p.title, role: p.role, domain, company: c.name, companyId: c.companyId });
      result.leadersAdded++;
    }
    if (!found.length) notes.push(`${c.name}: no founders or C-level found in Crustdata's people data. Add them by profile URL in a "leaders" column.`);
    store.setMeta(`leaders_searched:${domain}`, nowIso);
  }

  // 3. Leaders the fund listed by profile URL and not seen before (1 credit each).
  if (plan.newCsvLeaders.length) {
    const people = await api.enrichPeople([...new Set(plan.newCsvLeaders.map(l => l.url))]);
    for (const { url, domain } of plan.newCsvLeaders) {
      const c = store.company(domain);
      const p = people[url];
      if (!c) continue;
      const cell = plan.add.concat(plan.keep).find(r => r.domain === domain)?.row.leaders.join(" ") ?? "";
      if (!p) { notes.push(`${c.name}: ${url} was not found in Crustdata's people data, so it is not watched.`); store.setMeta(`csv_unmatched:${domain}:${url}`, cell); continue; }
      const here = p.current.find(x => atCompany(x, { profileUrl: url, name: "", title: "", role: "c_level", domain, company: c.name, companyId: c.companyId }));
      if (!here) { notes.push(`${c.name}: ${p.name ?? url} does not list a current role there, so they are not watched.`); store.setMeta(`csv_unmatched:${domain}:${url}`, cell); continue; }
      const title = here.title ?? "Leader";
      store.saveLeader({ profileUrl: url, personId: p.personId, name: p.name ?? url, title, role: leaderRole(title) ?? "c_level", domain, company: c.name, companyId: c.companyId }, "csv");
      result.leadersAdded++;
    }
  }

  // 4. Careers pages: /careers, then /jobs (or the page the portfolio names). The first reading is the baseline.
  const toFind = pending.filter(d => !store.getMeta(`careers_checked:${d}`)).map(d => store.company(d)!).filter(Boolean);
  if (toFind.length) {
    log(`Looking for careers pages at ${toFind.length} compan${toFind.length === 1 ? "y" : "ies"}...`);
    const tries = new Map(toFind.map(c => [c.domain, c.careersUrl ? [c.careersUrl] : careersCandidates(c.domain)]));
    const found = new Map<string, { url: string; roles: number; len: number }>();
    const loaded = new Map<string, { url: string; len: number }>();
    const boards = new Map<string, string[]>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const batch = toFind.filter(c => !found.has(c.domain) && tries.get(c.domain)![attempt]);
      if (!batch.length) break;
      const pages = await api.fetchPages(batch.map(c => tries.get(c.domain)![attempt]));
      batch.forEach((c, i) => {
        const page = pages[i];
        const count = page?.success ? countRoles(page.content, page.url) : undefined;
        const len = page?.content?.length ?? 0;
        if (page?.success && !boards.has(c.domain)) boards.set(c.domain, boardLinks(page.content));
        if (count && count.roles > 0) found.set(c.domain, { url: page.url, roles: count.roles, len });
        else if (count && !loaded.has(c.domain)) loaded.set(c.domain, { url: page.url, len });
      });
    }
    // A careers page showing fewer than 3 roles that links to a job board: the board often has the full list.
    const thin = toFind.filter(c => (found.get(c.domain)?.roles ?? 0) < 3 && boards.get(c.domain)?.length);
    if (thin.length) {
      const pages = await api.fetchPages(thin.map(c => boards.get(c.domain)![0]));
      thin.forEach((c, i) => {
        const count = pages[i]?.success ? countRoles(pages[i].content, pages[i].url) : undefined;
        if (count && count.roles > (found.get(c.domain)?.roles ?? 0)) found.set(c.domain, { url: pages[i].url, roles: count.roles, len: pages[i].content?.length ?? 0 });
      });
    }
    // No roles on a careers page: the job postings index, when it has recent postings for the company.
    const left = toFind.filter(c => !found.has(c.domain) && c.companyId);
    const since = new Date(now.getTime() - 60 * DAY).toISOString().slice(0, 10);
    const index = left.length ? await api.jobIndexCounts(left.map(c => c.companyId!), since) : {};
    for (const c of toFind) {
      const f = found.get(c.domain);
      const fromIndex = c.companyId ? index[c.companyId] ?? 0 : 0;
      if (f) {
        store.saveCompany({ ...c, careersUrl: f.url, hiringSource: "careers" });
        store.addReading(c.domain, nowIso, f.roles, "careers");
        store.setMeta(`careers_len:${c.domain}`, String(f.len));
      } else if (fromIndex >= 3) { store.saveCompany({ ...c, hiringSource: "index" }); store.addReading(c.domain, nowIso, fromIndex, "index"); }
      else if (loaded.has(c.domain)) {
        store.saveCompany({ ...c, careersUrl: loaded.get(c.domain)!.url, hiringSource: "careers" });
        store.addReading(c.domain, nowIso, 0, "careers");
        notes.push(`${c.name}: no open roles found on ${loaded.get(c.domain)!.url}. If they are hiring, put their jobs page in a "careers" column.`);
      } else {
        store.saveCompany({ ...c, hiringSource: "none" });
        notes.push(`${c.name}: no careers page at ${c.careersUrl ?? "/careers or /jobs"}; hiring is not tracked. Add their jobs page in a "careers" column.`);
      }
      store.setMeta(`careers_checked:${c.domain}`, nowIso);
    }
  }

  // 5. The watchers.
  result.watches = await ensureWatches(ctx, notes);

  for (const r of plan.add) {
    const c = store.company(r.domain);
    if (!c) continue;
    const flag = store.undigested().find(s => s.key === `start_headcount_down:${r.domain}`);
    result.starting.push({ domain: c.domain, name: c.name, line: c.start ?? "", leaders: store.leaders(c.domain).map(l => `${l.name} (${l.title})`), hiring: hiringLine(store, c), flag });
  }
  result.creditsUsed = round2(creditsUsed.total - spentBefore);
  store.addSpend(result.creditsUsed, 0, nowIso);
  return result;
}

/** Headcount far above the company's size range: people at a same-name company are probably counted. */
export function sizeMismatch(record: any): { total: number; range: string } | undefined {
  const total = record?.headcount?.total;
  const range = String(record?.basic_info?.employee_count_range ?? "");
  const upper = /^\d+\s*-\s*(\d+)$/.exec(range.replace(/,/g, ""))?.[1];
  if (typeof total !== "number" || !upper) return undefined;
  return total > Number(upper) * 4 && total - Number(upper) > 50 ? { total, range } : undefined;
}

/** "24 open roles on the careers page" and similar, for the starting point. */
export function hiringLine(store: Store, c: Company): string {
  const last = store.lastReading(c.domain);
  if (c.hiringSource === "none" || !last) return "hiring not tracked";
  return `${last.roles} open role${last.roles === 1 ? "" : "s"} ${c.hiringSource === "careers" ? "on the careers page" : "in the job postings index (last 60 days)"}`;
}

/** A track as comparable leaves: field, type and keys. */
const leaves = (track: unknown): string[] => {
  const out: string[] = [];
  const key = (k: unknown): string => (Array.isArray(k) ? `[${k.map(key).sort().join(",")}]` : String(k));
  const walk = (n: any) => { if (!n || typeof n !== "object") return; if (Array.isArray(n.conditions)) n.conditions.forEach(walk); else if (n.field) out.push(`${n.field}:${n.type}:${key(n.keys ?? [])}`); };
  walk(track);
  return out.sort();
};
const sameSet = (a: (string | number)[], b: (string | number)[]) => a.length === b.length && [...a].map(String).sort().every((x, i) => x === [...b].map(String).sort()[i]);

/**
 * Makes the company watch hold every company and the person watch every watched leader. Reuses a stored watch
 * (PATCHing its list and config), or one on the account that does exactly this job (same track, fields and list, no
 * delivery channel), before creating a new one. A reused watch's past runs are marked read, so nothing old is posted.
 * Free.
 */
export async function ensureWatches(ctx: Ctx, notes: string[] = []): Promise<Partial<Record<Dataset, number>>> {
  const { store, api } = ctx;
  const out: Partial<Record<Dataset, number>> = {};
  const want: Record<Dataset, (string | number)[]> = {
    company: store.companies().flatMap(c => (c.companyId ? [c.companyId] : [])),
    person: store.watchedProfileUrls(ctx.now),
  };
  for (const ds of ["company", "person"] as Dataset[]) {
    const list = want[ds];
    const track = leaves(ds === "company" ? crustdata.COMPANY_TRACK : crustdata.PERSON_TRACK);
    const fields = ds === "company" ? crustdata.COMPANY_FIELDS : crustdata.PERSON_FIELDS;
    const entitiesOf = (w: Watch) => (ds === "company" ? w.entities?.crustdata_company_ids ?? [] : (w.entities?.professional_network_profile_urls ?? []).map(normalizeProfileUrl));
    let id = store.getWatchId(ds);
    let current: Watch | undefined;
    if (id) {
      try { current = await api.getWatch(ds, id); } catch (err) { if (!(err instanceof CrustdataError && err.status === 404)) throw err; }
      if (!current || current.status === "cancelled" || current.status === "expired") {
        notes.push(`The ${ds === "company" ? "company" : "leader"} watcher ${id} was ${current?.status ?? "deleted"} outside this tool; ${list.length ? "a new one was created" : "nothing to watch"}.`);
        store.clearWatch(ds);
        id = undefined;
        current = undefined;
      }
    }
    if (!list.length) {
      if (id) { await api.deleteWatch(ds, id); store.clearWatch(ds); }
      continue;
    }
    // A watcher made by an earlier version with a different track: track is fixed at creation, so replace it.
    if (id && current?.track && !sameSet(leaves(current.track), track)) {
      const old = id;
      const created = ds === "company" ? await api.createCompanyWatch(list as number[]) : await api.createPersonWatch(list as string[], config.leaderRefreshDays);
      if (current.status === "paused") await api.setWatchStatus(ds, created.id, "paused"); // keep a pause the user chose
      store.setWatchId(ds, created.id);
      // The old one is paused, read one last time by the next check, then deleted, so nothing it caught is lost.
      await api.setWatchStatus(ds, old, "paused").catch(() => undefined);
      store.setMeta(`retired:${ds}`, JSON.stringify([...new Set([...(JSON.parse(store.getMeta(`retired:${ds}`) ?? "[]") as number[]), old])]));
      notes.push(`Replaced the ${ds === "company" ? "company" : "leader"} watcher ${old} with ${created.id}: this version watches for changes differently. The old one is read once more by the next check, then deleted; the new one starts with a free baseline.`);
      out[ds] = created.id;
      continue;
    }
    let adopted = false;
    if (!id) {
      const existing = (await api.listActiveWatches(ds)).find(w =>
        sameSet(leaves(w.track), track) && sameSet(entitiesOf(w), list) && sameSet(w.fields ?? [], fields) && !(w.notifications ?? []).length);
      if (existing) {
        store.setWatchId(ds, existing.id); id = existing.id; current = existing; adopted = true;
        // What it caught before this copy of the tool knew about it is history, not news: listed and marked read.
        const runs: crustdata.Run[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
          const r = await api.listRuns(ds, existing.id, 100, cursor).catch(() => ({ runs: [], next_cursor: null }));
          runs.push(...(r.runs ?? []).filter(x => crustdata.FINISHED.has(x.status)));
          if (!r.next_cursor) break;
          cursor = r.next_cursor;
        }
        for (const r of runs) store.markRunSeen(ds, r.id, 0);
        notes.push(`Reused the ${ds === "company" ? "company" : "leader"} watcher ${existing.id} already on your account (its ${runs.length} earlier run${runs.length === 1 ? "" : "s"} marked as read).`);
      }
    }
    if (!id) {
      const created = ds === "company" ? await api.createCompanyWatch(list as number[]) : await api.createPersonWatch(list as string[], config.leaderRefreshDays);
      store.setWatchId(ds, created.id);
      out[ds] = created.id;
      continue;
    }
    const refresh = current?.config?.refresh_frequency_days;
    const refreshChanged = ds === "person" && typeof refresh === "number" && refresh !== config.leaderRefreshDays;
    const capWrong = typeof current?.config?.max_results_per_run === "number" && current.config.max_results_per_run < list.length;
    if (adopted || !current || !sameSet(entitiesOf(current), list) || refreshChanged || capWrong) {
      if (ds === "company") await api.setCompanyEntities(id, list as number[]);
      else await api.setPersonEntities(id, list as string[], config.leaderRefreshDays);
    }
    out[ds] = id;
  }
  return out;
}

/**
 * Looks for founders and C-level again (0.03 credits per person found). New ones are watched and, unless this is the
 * company's first search, reported as a new leader. Leaders recorded as gone who are found again are watched again.
 */
export async function refreshLeaders(ctx: Ctx, domains?: string[]): Promise<{ signals: Signal[]; added: number; creditsUsed: number }> {
  const { store, api } = ctx;
  const now = ctx.now ?? new Date();
  const before = creditsUsed.total;
  const signals: Signal[] = [];
  let added = 0;
  for (const c of store.companies().filter(x => x.companyId && (!domains || domains.includes(x.domain)))) {
    // A company whose leaders the fund lists by hand is left as listed.
    if (store.leaders(c.domain, { all: true }).some(l => l.source === "csv")) continue;
    const lastSearch = store.getMeta(`leaders_searched:${c.domain}`);
    const known = new Map(store.leaders(c.domain, { all: true }).map(l => [l.profileUrl, l]));
    const activeCount = [...known.values()].filter(l => l.status === "active").length;
    const recentlyGone = (l: { status: string; leftAt?: string }) => l.status === "left" && Boolean(l.leftAt) && now.getTime() - new Date(l.leftAt!).getTime() < LEFT_WATCH_DAYS * DAY;
    // People not watched at this company now: a new leader, or one recorded as gone some time ago who is back. Set
    // aside first: people already watched, people the fund took off, and people who left recently (still watched,
    // so their own watcher reports a return). The cap applies after that, and always leaves room for two.
    const found = pickLeaders(await api.searchLeaders(c.companyId!, 25), 25).filter(p => {
      const k = known.get(normalizeProfileUrl(p.profileUrl!));
      return !k || (k.status === "left" && !recentlyGone(k));
    });
    const room = Math.max(2, config.maxLeadersPerCompany - activeCount);
    // Only someone who started in the role since the last search is news; anyone else was there all along and is
    // simply watched from now on.
    const since = lastSearch ? new Date(new Date(lastSearch).getTime() - 31 * DAY).toISOString().slice(0, 10) : undefined;
    for (const p of found.slice(0, room)) {
      const url = normalizeProfileUrl(p.profileUrl!);
      const k = known.get(url);
      const leader: Leader = { profileUrl: url, personId: p.personId, name: p.name, title: p.title, role: p.role, domain: c.domain, company: c.name, companyId: c.companyId };
      store.saveLeader(leader);
      added++;
      if (k?.status === "left") signals.push(leaderSignal({ ...leader }, { kind: "returned", newTitle: p.title }, now));
      else if (since && p.startDate && p.startDate.slice(0, 10) >= since) signals.push(leaderJoinedSignal(leader, now));
    }
    store.setMeta(`leaders_searched:${c.domain}`, now.toISOString());
  }
  for (const s of signals) store.addSignal(s, now.toISOString());
  const spent = round2(creditsUsed.total - before);
  store.addSpend(spent, 0, now.toISOString());
  await ensureWatches(ctx);
  return { signals, added, creditsUsed: spent };
}

// ---------------------------------------------------------------------------
// Check (daily)
// ---------------------------------------------------------------------------

export type CheckResult = { signals: Signal[]; warnings: string[]; creditsUsed: number; watcherCredits: number; readings: number; pending: boolean; inactive: boolean };

export function watchWarning(ds: Dataset, w: Watch | undefined): string | undefined {
  const name = ds === "company" ? "company watcher" : "leader watcher";
  if (!w) return `The ${name} was deleted outside this tool. Run npm run import to create a new one.`;
  if (w.status === "active") return undefined;
  if (w.status === "paused") return `The ${name} is paused, so nothing new is caught. Run npm run resume.`;
  if (w.status === "suspended") return `The ${name} is suspended, usually because the account ran out of credits. Top up at https://app.crustdata.com, then run npm run resume.`;
  return `The ${name} is ${w.status}. Run npm run import to create a new one.`;
}

/** Warnings that mean changes were lost, cut or not read: kept for the digest and the daily Slack note. */
export const SERIOUS = /Gave up|per-run cap|not read this time|watcher is|deleted outside/;

/** A run that cannot be read is retried on the next checks, then given up on with a warning after this many tries. */
export const MAX_RUN_TRIES = 3;

/**
 * The daily run. Everything is written in one transaction; a dry run rolls it back (and reads no careers pages unless
 * asked, so it spends nothing). Alerts are posted after the commit, so a failed post is retried by the next check.
 */
export async function runCheck(ctx: Ctx, { dryRun = false, hiring = "due" as "due" | "force" | "skip" } = {}): Promise<CheckResult> {
  const { store, api, thresholds: t } = ctx;
  const now = ctx.now ?? new Date();
  const nowIso = now.toISOString();
  const log = ctx.log ?? (() => {});
  const spentBefore = creditsUsed.total;
  const warnings: string[] = [];
  const found: Signal[] = [];
  let watcherCredits = 0;
  let pending = false;
  let inactive = false;
  let leadersChanged = false;
  let readings = 0;

  // An unreadable run is retried on the next checks, then given up with a warning.
  const onRunError = (ds: Dataset) => (run: crustdata.Run, err: unknown): "skip" => {
    const k = `run_tries:${ds}:${run.id}`;
    const tries = Number(store.getMeta(k) ?? 0) + 1;
    store.setMeta(k, String(tries));
    if (tries < MAX_RUN_TRIES) warnings.push(`Could not read the ${ds === "company" ? "company" : "leader"} watcher's run of ${run.started_at.slice(0, 10)} (${crustdata.explain(err)}); trying again next time.`);
    else warnings.push(`Gave up on the ${ds === "company" ? "company" : "leader"} watcher's run of ${run.started_at.slice(0, 10)} after ${tries} tries (${crustdata.explain(err)}). Its changes are lost; check them in the Crustdata dashboard.`);
    return "skip";
  };
  store.begin();
  const retiredDone: { ds: Dataset; id: number }[] = [];
  try {
    // Watchers replaced by an import: read what they caught one last time, then delete them (after the commit).
    for (const ds of ["company", "person"] as Dataset[]) {
      for (const old of JSON.parse(store.getMeta(`retired:${ds}`) ?? "[]") as number[]) {
        try {
          const runs = await api.newRunRecords(ds, old, store.seenRunIds(ds), onRunError(ds));
          let holding = false;
          for (const { run, records, failed } of runs) {
            if (failed && Number(store.getMeta(`run_tries:${ds}:${run.id}`) ?? 0) < MAX_RUN_TRIES) { holding = true; continue; }
            watcherCredits += Number(run.credits_deducted ?? 0);
            for (const rec of records) {
              try {
                if (ds === "company") found.push(...companySignals(store, rec, t, nowIso, warnings));
                else { const r = personSignals(store, rec, now); found.push(...r.signals); leadersChanged ||= r.changed; }
              } catch (err) { warnings.push(`Skipped one unreadable ${ds} record: ${(err as Error).message}`); }
            }
            store.markRunSeen(ds, run.id, Number(run.credits_deducted ?? 0));
          }
          if (!runs.pending && !holding) retiredDone.push({ ds, id: old });
        } catch (err) {
          if (err instanceof CrustdataError && err.status === 404) retiredDone.push({ ds, id: old });
          else warnings.push(`Could not read the replaced ${ds === "company" ? "company" : "leader"} watcher ${old} (${crustdata.explain(err)}); trying again next time.`);
        }
      }
    }
    for (const ds of ["company", "person"] as Dataset[]) {
      const id = store.getWatchId(ds);
      if (!id) { if (ds === "company" || store.watchedProfileUrls(now).length) { warnings.push(`No ${ds === "company" ? "company" : "leader"} watcher yet. Run npm run import.`); inactive = true; } continue; }
      let w: Watch | undefined;
      try { w = await api.getWatch(ds, id); } catch (err) { if (!(err instanceof CrustdataError && err.status === 404)) throw err; }
      const warn = watchWarning(ds, w);
      if (warn) { warnings.push(warn); inactive = true; }
      if (!w) continue;
      const runs = await api.newRunRecords(ds, id, store.seenRunIds(ds), onRunError(ds));
      pending ||= Boolean(runs.pending);
      for (const { run, records, failed } of runs) {
        if (failed && Number(store.getMeta(`run_tries:${ds}:${run.id}`) ?? 0) < MAX_RUN_TRIES) continue; // read again next time
        watcherCredits += Number(run.credits_deducted ?? 0);
        for (const rec of records) {
          try {
            if (ds === "company") found.push(...companySignals(store, rec, t, nowIso, warnings));
            else { const r = personSignals(store, rec, now); found.push(...r.signals); leadersChanged ||= r.changed; }
          } catch (err) { warnings.push(`Skipped one unreadable ${ds} record: ${(err as Error).message}`); }
        }
        if (run.status !== "SUCCESS") warnings.push(`A ${ds === "company" ? "company" : "leader"} watcher run on ${run.started_at.slice(0, 10)} ended ${run.status.toLowerCase()}; changes from it may arrive on the next run.`);
        if (typeof run.records_after_filter === "number" && typeof run.new_records_count === "number" && run.records_after_filter > run.new_records_count) {
          warnings.push(`The ${ds === "company" ? "company" : "leader"} watcher run on ${run.started_at.slice(0, 10)} found ${run.records_after_filter} changes but delivered ${run.new_records_count} (its per-run cap). Run npm run import to raise the cap.`);
        }
        store.markRunSeen(ds, run.id, Number(run.credits_deducted ?? 0));
      }
    }

    // Careers pages: a failure here (no Web Fetch access, an outage) must not hold back the watchers' alerts.
    const doHiring = hiring === "force" || (hiring === "due" && !dryRun);
    if (doHiring) {
      try {
        const r = await readHiring(ctx, now, hiring === "force", warnings);
        found.push(...r.signals);
        readings = r.readings;
      } catch (err) { warnings.push(`Careers pages not read this time: ${crustdata.explain(err)}`); }
    }

    const fresh = found.filter(s => store.addSignal(s, nowIso));
    const own = round2(creditsUsed.total - spentBefore);
    store.addSpend(own, watcherCredits, nowIso);
    store.setMeta("last_check_at", nowIso);
    // Warnings that mean something was lost or skipped are kept for the digest (and said in Slack by the CLI).
    // Watcher status is checked live by the digest, so only lost or unread changes are kept, once each.
    const serious = warnings.filter(w => SERIOUS.test(w) && !/watcher (is|was) |No (company|leader) watcher/.test(w));
    if (serious.length) {
      const kept = JSON.parse(store.getMeta("serious_warnings") ?? "[]") as string[];
      const body = (w: string) => w.replace(/^\d{4}-\d{2}-\d{2}: /, "");
      for (const w of serious) if (!kept.some(k => body(k) === w)) kept.push(`${nowIso.slice(0, 10)}: ${w}`);
      store.setMeta("serious_warnings", JSON.stringify(kept.slice(-20)));
    }
    if (!dryRun) for (const { ds, id } of retiredDone) {
      const left = (JSON.parse(store.getMeta(`retired:${ds}`) ?? "[]") as number[]).filter(x => x !== id);
      store.setMeta(`retired:${ds}`, JSON.stringify(left));
    }
    if (dryRun) store.rollback(); else store.commit();
    if (!dryRun) for (const { ds, id } of retiredDone) await api.deleteWatch(ds, id).catch(err => warnings.push(`Could not delete the replaced watcher ${id}: ${crustdata.explain(err)}`));
    if (leadersChanged && !dryRun) await ensureWatches(ctx).catch(err => warnings.push(`Could not update the leader watcher's list: ${crustdata.explain(err)}`));
    return { signals: fresh, warnings, creditsUsed: own, watcherCredits, readings, pending, inactive };
  } catch (err) {
    store.rollback();
    throw err;
  }
}

/**
 * Signals from one company watch record. Each rule runs on its own, so one odd field never loses the others.
 * Headcount is compared with its highest and lowest reading since the last headcount alert (within reference_days);
 * departments with the stored reference record, which moves on a department alert or when it is older than
 * reference_days.
 */
export function companySignals(store: Store, result: { changes?: Change[]; record?: any }, t: Thresholds, nowIso: string, warnings: string[] = []): Signal[] {
  const rec = result?.record;
  const changes = Array.isArray(result?.changes) ? result.changes.filter(c => c && typeof c === "object") : [];
  if (!rec || !changes.length) return [];
  const domain = String(rec.basic_info?.primary_domain ?? "").replace(/^www\./, "").toLowerCase();
  const c = (rec.crustdata_company_id ? store.companyById(rec.crustdata_company_id) : undefined) ?? (domain ? store.company(domain) : undefined);
  if (!c) return []; // removed from the portfolio since
  const out: Signal[] = [];
  const rule = (name: string, fn: () => Signal[]) => { try { out.push(...fn()); } catch (err) { warnings.push(`${c.name}: the ${name} rule could not read this change (${(err as Error).message}).`); } };

  rule("headcount", () => {
    const total = rec.headcount?.total;
    if (typeof total !== "number") return [];
    const alertAt = store.getMeta(`hc_alert_at:${c.domain}`);
    const windowStart = new Date(new Date(nowIso).getTime() - t.reference_days * DAY).toISOString();
    const since = alertAt && alertAt > windowStart ? alertAt : windowStart;
    // The reading before the window only stands in when the window is empty and is not one restarted by an alert.
    const s = headcountSignals(ref(c), store.points(c.domain, since, { prior: !(alertAt && alertAt > windowStart) }), { at: nowIso, total }, t);
    store.addPoint(c.domain, nowIso, total);
    if (s.length) store.setMeta(`hc_alert_at:${c.domain}`, nowIso);
    return s;
  });
  rule("department", () => {
    if (!rec.headcount) return [];
    const r = store.getRef(c.domain);
    const s = r ? teamSignals(ref(c), r.record, rec, t) : [];
    const old = !r || new Date(nowIso).getTime() - new Date(r.recordedAt).getTime() > t.reference_days * DAY;
    if (s.length || old) store.saveRef(c.domain, rec, nowIso);
    return s;
  });
  const funding: Signal[] = [];
  const news: Signal[] = [];
  rule("funding", () => { funding.push(...fundingSignals(ref(c), changes, rec)); return []; });
  rule("news", () => { news.push(...newsSignals(ref(c), changes, new Date(nowIso))); return []; });
  // A round's type and date can arrive on different runs: a date-only change soon after a reported round is that round.
  // Folded only when the reported round was dated near this date (or had none) and was reported in the last 120 days.
  const prev = store.lastSignalOf(c.domain, ["round", "bridge_round"]);
  const newDate = isoDate(String(changes.find(ch => ch.field === "funding.last_fundraise_date")?.to ?? ""));
  // A round reported from a type change still carried the old round's date (older than 60 days when reported): the
  // date that follows belongs to it. A round reported with a fresh date is its own round, unless the dates are close.
  const carriedOldDate = prev?.date ? new Date(prev.createdAt).getTime() - new Date(prev.date).getTime() > 60 * DAY : true;
  const close = prev?.date && newDate ? Math.abs(new Date(newDate).getTime() - new Date(prev.date).getTime()) <= 30 * DAY : false;
  const near = Boolean(prev) && (carriedOldDate || close);
  if (prev && near && new Date(nowIso).getTime() - new Date(prev.createdAt).getTime() < 120 * DAY && !changes.some(ch => ch.field === "funding.last_round_type")) {
    const folded = funding.filter(s => s.kind === "round" || s.kind === "bridge_round");
    for (const s of folded) funding.splice(funding.indexOf(s), 1);
    // New investors that came with it still count.
    const inv = changes.find(ch => ch.field === "funding.investors");
    if (inv) funding.push(...fundingSignals(ref(c), [inv], rec));
  }
  // A round and the article about it: one line, the round, linking the article.
  const round = funding.find(s => s.kind === "round" || s.kind === "bridge_round");
  const article = news.find(s => s.kind === "funding_news");
  if (round && article) { round.url = article.url; round.linkLabel = "article"; }
  out.push(...funding, ...news.filter(s => !(round && s === article)));
  return out;
}

/** After an acquisition, founders leaving is expected: reported as a note for this many days. */
const AFTER_ACQUISITION_DAYS = 120;

/** Signals from one person watch record, for every portfolio company that person leads. */
export function personSignals(store: Store, result: { changes?: Change[]; record?: any }, now: Date): { signals: Signal[]; changed: boolean } {
  const rec = result?.record;
  if (!rec || !Array.isArray(result?.changes) || !result.changes.length) return { signals: [], changed: false };
  const raw = rec.social_handles?.professional_network_identifier?.profile_url;
  const url = raw ? normalizeProfileUrl(String(raw)) : undefined;
  const out: Signal[] = [];
  let changed = false;
  for (const l of store.leadersFor(rec.crustdata_person_id, url, now)) {
    const e = leaderEvent(rec, l, now);
    if (!e) continue;
    // A side role is reported once, not again on every later edit to the profile.
    if (e.kind === "side_role") {
      const k = `side_role:${l.domain}:${l.profileUrl}`;
      const v = `${e.newCompany ?? ""}|${e.newTitle ?? ""}`.toLowerCase();
      if (store.getMeta(k) === v) continue;
      store.setMeta(k, v);
    }
    let s = leaderSignal(l, e, now);
    // Only an acquisition in Crustdata's funding data (not a headline) makes a founder leaving expected.
    const acquiredAt = store.lastSignalAtKey(l.domain, "acquired:");
    if (e.kind === "left" && acquiredAt && now.getTime() - new Date(acquiredAt).getTime() < AFTER_ACQUISITION_DAYS * DAY) {
      s = { ...s, severity: "note", why: "Expected after the acquisition: founders often leave once the deal closes." };
    }
    out.push(s);
    if (e.kind === "left") { store.setLeaderStatus(l.profileUrl, l.domain, "left", now.toISOString()); changed = true; }
    if (e.kind === "returned") { store.setLeaderStatus(l.profileUrl, l.domain, "active"); if (e.newTitle) store.setLeaderTitle(l.profileUrl, l.domain, e.newTitle); }
    if (e.kind === "role" || e.kind === "stepped_back" || e.kind === "ceo_changed") store.setLeaderTitle(l.profileUrl, l.domain, e.newTitle);
  }
  return { signals: out, changed };
}

/**
 * Reads open roles for every company that is due, saves the readings and applies the hiring rules. A company is due
 * `HIRING_CHECK_DAYS` after its last reading or last attempt, so a page that keeps failing is not paid for every day.
 */
async function readHiring(ctx: Ctx, now: Date, force: boolean, warnings: string[]): Promise<{ signals: Signal[]; readings: number }> {
  const { store, api, thresholds: t } = ctx;
  const nowIso = now.toISOString();
  const dueAfter = (config.hiringCheckDays - 0.5) * DAY;
  const lastTouch = (d: string) => [store.lastReading(d)?.at, store.getMeta(`careers_tried:${d}`)].filter(Boolean).sort().at(-1);
  const due = store.companies().filter(c => c.hiringSource !== "none" && (force || !lastTouch(c.domain) || now.getTime() - new Date(lastTouch(c.domain)!).getTime() >= dueAfter));
  if (!due.length) return { signals: [], readings: 0 };
  const read = new Map<string, number>();
  const careers = due.filter(c => c.hiringSource === "careers" && c.careersUrl);
  if (careers.length) {
    (ctx.log ?? (() => {}))(`Reading ${careers.length} careers page${careers.length === 1 ? "" : "s"}...`);
    const pages = await api.fetchPages(careers.map(c => c.careersUrl!));
    careers.forEach((c, i) => {
      store.setMeta(`careers_tried:${c.domain}`, nowIso);
      const p = pages[i];
      const count = p?.success ? countRoles(p.content, p.url) : undefined;
      const len = p?.content?.length ?? 0;
      // Some sites answer now and then with a stripped-down page that has no job links. A page with no roles that is
      // under half the size of the last page that listed roles is believed only when it comes back like that on two
      // different days (a real empty job board), and then becomes the new normal size.
      const goodLen = Number(store.getMeta(`careers_len:${c.domain}`) ?? 0);
      if (count && count.roles === 0 && goodLen && len < goodLen / 2) {
        const seenShort = store.getMeta(`careers_short:${c.domain}`);
        if (!seenShort || seenShort.slice(0, 10) === nowIso.slice(0, 10)) {
          store.setMeta(`careers_short:${c.domain}`, nowIso);
          warnings.push(`${c.name}'s careers page came back much smaller than usual with no roles listed; read again next time before counting it.`);
          return;
        }
        store.setMeta(`careers_len:${c.domain}`, String(len));
      }
      store.deleteMeta(`careers_short:${c.domain}`);
      if (count) { read.set(c.domain, count.roles); if (count.roles > 0) store.setMeta(`careers_len:${c.domain}`, String(len)); }
      else warnings.push(`Could not read ${c.name}'s careers page (${c.careersUrl}: ${p?.success ? "it came back empty or behind a bot check" : `HTTP ${p?.http_status ?? "error"}`}); read again in ${config.hiringCheckDays} days.`);
    });
  }
  const index = due.filter(c => c.hiringSource === "index" && c.companyId);
  if (index.length) {
    const counts = await api.jobIndexCounts(index.map(c => c.companyId!), new Date(now.getTime() - 60 * DAY).toISOString().slice(0, 10));
    for (const c of index) read.set(c.domain, counts[c.companyId!] ?? 0);
  }
  const out: Signal[] = [];
  for (const c of due) {
    if (!read.has(c.domain)) continue;
    store.addReading(c.domain, nowIso, read.get(c.domain)!, c.hiringSource);
    const label = c.hiringSource === "careers" ? "careers page" : "job postings index";
    for (const s of hiringSignals(ref(c), store.readings(c.domain, 70, now), t, label)) {
      const last = store.lastSignalAt(c.domain, s.kind);
      if (last && now.getTime() - new Date(last).getTime() < t.repeat_after_days * DAY && s.kind !== "hiring_stopped") continue;
      out.push(c.careersUrl && c.hiringSource === "careers" ? { ...s, url: c.careersUrl, linkLabel: "careers page" } : s);
    }
  }
  return { signals: out, readings: read.size };
}

// ---------------------------------------------------------------------------
// Digest (weekly)
// ---------------------------------------------------------------------------

export type DigestCompany = { domain: string; name: string; owner?: string; signals: Signal[]; start?: string; leaders?: number; hiring?: string };

export type Digest = {
  fund: string;
  from: string;
  to: string;
  firstDigest: boolean;
  companies: DigestCompany[];
  /** Companies with nothing new. */
  quiet: string[];
  credits: { own: number; watchers: number };
  warnings: string[];
};

/** Builds the digest model from stored signals (pure apart from reading the store). */
export function buildDigest(store: Store, signals: StoredSignal[], from: string, to: string, warnings: string[], firstDigest: boolean): Digest {
  const companies = store.companies();
  const byDomain = new Map<string, DigestCompany>();
  for (const c of companies) {
    const isNew = new Date(c.addedAt).getTime() > new Date(from).getTime() || firstDigest;
    byDomain.set(c.domain, { domain: c.domain, name: c.name, owner: c.owner, signals: [], ...(isNew ? { start: c.start, leaders: store.leaders(c.domain).length, hiring: hiringLine(store, c) } : {}) });
  }
  for (const s of signals) {
    if (!byDomain.has(s.domain)) byDomain.set(s.domain, { domain: s.domain, name: s.company, signals: [] });
    byDomain.get(s.domain)!.signals.push(s);
  }
  const all = [...byDomain.values()];
  const busy = all.filter(c => c.signals.length || c.start);
  const quiet = all.filter(c => !c.signals.length && !c.start).map(c => c.name).sort((a, b) => a.localeCompare(b));
  const spend = store.spendSince(from);
  return { fund: config.fundName, from, to, firstDigest, companies: orderCompanies(busy), quiet, credits: { own: round2(spend.own), watchers: round2(spend.watchers) }, warnings };
}

/** Health notes for the digest: watchers not running, or no daily check lately. */
export async function digestWarnings(ctx: Ctx): Promise<string[]> {
  const { store, api } = ctx;
  const now = ctx.now ?? new Date();
  const out: string[] = [];
  for (const ds of ["company", "person"] as Dataset[]) {
    const id = store.getWatchId(ds);
    if (!id) continue;
    let w: Watch | undefined;
    try { w = await api.getWatch(ds, id); }
    catch (err) {
      if (!(err instanceof CrustdataError && err.status === 404)) { out.push(`Could not check the ${ds === "company" ? "company" : "leader"} watcher: ${crustdata.explain(err)}`); continue; }
    }
    const warn = watchWarning(ds, w);
    if (warn) out.push(warn);
  }
  for (const w of JSON.parse(store.getMeta("serious_warnings") ?? "[]") as string[]) out.push(w);
  const last = store.getMeta("last_check_at");
  if (!last) out.push("npm run check has not run yet, so this digest has only the starting point. Schedule it daily (docs/deploy.md).");
  else if (now.getTime() - new Date(last).getTime() > 3 * DAY) out.push(`npm run check last ran on ${last.slice(0, 10)}. Schedule it daily (docs/deploy.md).`);
  return out;
}

export type DigestRun = { id?: number; digest: Digest; signalIds: number[] };

/** Collects every signal since the last digest and saves the digest (sending is the caller's job, after this). */
export async function runDigest(ctx: Ctx, { dryRun = false } = {}): Promise<DigestRun> {
  const { store } = ctx;
  const now = ctx.now ?? new Date();
  const warnings = await digestWarnings(ctx);
  const last = store.lastDigest();
  const companies = store.companies();
  const from = last?.to ?? (companies.length ? companies.map(c => c.addedAt).sort()[0] : now.toISOString());
  store.begin();
  try {
    const signals = store.undigested();
    const digest = buildDigest(store, signals, from, now.toISOString(), warnings, !last);
    if (dryRun) { store.rollback(); return { digest, signalIds: signals.map(s => s.id) }; }
    const { digestMarkdown } = await import("./digest.js");
    const id = store.saveDigest({ from, to: digest.to, markdown: digestMarkdown(digest), payload: digest, want: { slack: hasSlack(), email: hasEmail() } }, digest.to);
    store.deleteMeta("serious_warnings"); // said in this digest
    store.assignDigest(signals.map(s => s.id), id);
    store.commit();
    return { id, digest, signalIds: signals.map(s => s.id) };
  } catch (err) {
    store.rollback();
    throw err;
  }
}
