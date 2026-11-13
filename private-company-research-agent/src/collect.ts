/**
 * Fetches everything one memo needs, in order, and nothing more:
 *
 *   1. /company/identify   the domain to a company id (free)
 *   2. /company/enrich     the company record (2 credits)
 *   3. /person/search      people who left in the last 12 months (0.23 per person at list price, capped)
 *   4. /person/search      senior roles that ended in the last 12 months, people who stayed included (capped)
 *   5. /job/search         job postings in the last 90 days, counted (free)
 *   6. /company/identify + /company/search   peers (identify free, 0.63 per peer at list price)
 *
 * Every paid answer goes through the cache, so a re-run within CACHE_DAYS, or a list that was cut off, never pays
 * twice. A section the key cannot read (403) is marked unavailable and the memo says so; a bad key, no credits or a
 * network failure stops the run (the CLI also stops after several companies fail in a row).
 */

import { createHash } from "node:crypto";
import type { Cache } from "./cache.js";
import {
  CrustdataError, ENRICH_FIELDS, PEER_FIELDS, PERSON_FIELDS, SENIOR_LEVELS, enrichCompany, identifyDomains, isFatal, jobCounts,
  meter, peersById, searchDepartures, searchSeniorEnds, type IdentifyRow,
} from "./crustdata.js";
import { normalizeDomain } from "./input.js";
import { sanitizeCompany } from "./sanitize.js";
import type { Bundle, CompanyData, PeerData } from "./types.js";

export type CollectOptions = {
  today: Date;
  leaversLimit: number;
  peersLimit: number;
  /** Peers named by the user (replace the automatic list). Undefined: automatic. Empty: no peers. */
  peers?: string[];
};

/** Senior role changes read per company (leaders who stepped back as well as left). Used by the estimate too. */
export const SENIOR_LIMIT = 10;

/**
 * Cache keys name what was asked for, so a change to the fields or filters (by a code change or an upgrade) is
 * fetched fresh instead of reading an old answer that lacks it. Bump CACHE_VERSION when an answer's meaning changes.
 */
export const CACHE_VERSION = "v2";
export const cacheKey = (kind: string, params: unknown) =>
  `${CACHE_VERSION}:${kind}:${createHash("sha1").update(JSON.stringify(params)).digest("hex").slice(0, 16)}`;

/**
 * The cache keys collect() uses for one company, so the estimate can tell exactly which answers are saved. Peers are
 * marked done with their own key once fetched (their key depends on which competitors resolve).
 */
export function keysFor(id: number, opts: Pick<CollectOptions, "today" | "leaversLimit" | "peersLimit" | "peers">) {
  const yearAgo = isoDay(monthsBefore(opts.today, 12));
  const ninetyDays = isoDay(daysBefore(opts.today, 90));
  const seniorLimit = Math.min(SENIOR_LIMIT, opts.leaversLimit);
  return {
    enrich: cacheKey("enrich", [id, ENRICH_FIELDS]),
    departures: cacheKey("departures", [id, opts.leaversLimit, PERSON_FIELDS, yearAgo.slice(0, 7)]),
    senior: cacheKey("senior", [id, seniorLimit, PERSON_FIELDS, SENIOR_LEVELS, yearAgo.slice(0, 7)]),
    jobs: cacheKey("jobs", [id, ninetyDays.slice(0, 7)]),
    peersDone: cacheKey("peers-done", [id, opts.peers ?? opts.peersLimit, PEER_FIELDS]),
    yearAgo, ninetyDays, seniorLimit,
  };
}

/** An identify answer with every match's company data coerced, so odd shapes cannot throw. */
export function safeIdentify(row: unknown): IdentifyRow {
  const o = row && typeof row === "object" ? (row as IdentifyRow) : {};
  return { matched_on: typeof o.matched_on === "string" ? o.matched_on : undefined, matches: (Array.isArray(o.matches) ? o.matches : []).map(m => ({ confidence_score: typeof m?.confidence_score === "number" ? m.confidence_score : undefined, company_data: sanitizeCompany((m as { company_data?: unknown })?.company_data) })) };
}

export type Collected =
  | { status: "ok"; bundle: Bundle }
  | { status: "unmatched"; asked: string; reason: string; /** The other company identify matched, if any. */ matched?: string };

/** List prices in credits (docs.crustdata.com/general/pricing, checked 2026-11-13). */
export const LIST = {
  enrich: 2,
  /** 0.03 per person + 0.1 for filtering on experience + 0.1 for returning it. */
  person: 0.23,
  /** 0.03 per company + 0.2 each for headcount, funding and followers returned. */
  peer: 0.63,
};

/**
 * Auto peers smaller than this are dropped: the competitor lists include look-alike sites and tiny tools. A peer
 * needs at least 10 people and at least a tenth of the company's own headcount.
 */
export const MIN_AUTO_PEER_HEADCOUNT = 10;
export const minPeerSize = (ownHeadcount: number | null | undefined) => Math.max(MIN_AUTO_PEER_HEADCOUNT, Math.ceil((ownHeadcount ?? 0) / 10));
/** Auto peers more than this many times the company's size are left out (Linear's list includes Atlassian). */
export const MAX_PEER_RATIO = 20;

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export function monthsBefore(d: Date, months: number): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate()));
  return x;
}
export const daysBefore = (d: Date, days: number) => new Date(d.getTime() - days * 86_400_000);

/** The domains a company answers to, from its record. */
export function domainsOf(c: CompanyData | undefined): string[] {
  const b = c?.basic_info;
  const out = [b?.primary_domain, ...(b?.all_domains ?? []), b?.website]
    .map(d => (d ? normalizeDomain(d) : undefined))
    .filter((d): d is string => !!d);
  return [...new Set(out)];
}

/**
 * The identify match that really is the company asked about: its own domains include the one asked (or the one asked
 * is a subdomain of one of them). Identify can return a different company that only links to the domain.
 */
export function pickMatch(row: IdentifyRow | undefined, asked: string): CompanyData | undefined {
  for (const m of row?.matches ?? []) {
    const own = domainsOf(m.company_data);
    if (own.some(d => d === asked || asked.endsWith(`.${d}`))) return m.company_data;
  }
  return undefined;
}

/** Competitor domains from the record: paid search first (closer rivals), then organic. Items carry stray spaces. */
export function competitorDomains(c: CompanyData): string[] {
  const own = new Set(domainsOf(c));
  const out: string[] = [];
  for (const d of [...(c.competitors?.paid_seo ?? []), ...(c.competitors?.organic_seo ?? [])]) {
    const n = normalizeDomain(String(d ?? ""));
    if (n && !own.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Runs `fn` for a section; a refusal for this key becomes "unavailable", anything fatal stops the run. */
async function section<T>(name: string, unavailable: Record<string, string>, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isFatal(err) || !(err instanceof CrustdataError)) throw err;
    unavailable[name] = err.status === 403 ? `not enabled on this Crustdata key (403)` : `Crustdata could not answer (${err.status})`;
    return undefined;
  }
}

export async function collect(asked: string, opts: CollectOptions, cache: Cache): Promise<Collected> {
  return meter.run({ credits: 0 }, async () => {
    const run = meter.getStore()!;
    const unavailable: Record<string, string> = {};
    const identify = async (d: string) => safeIdentify((await cache.through(cacheKey("identify", d), async () => (await identifyDomains([d]))[0])).value);

    const idRow = await identify(asked);
    const match = pickMatch(idRow, asked);
    if (!match?.crustdata_company_id) {
      const other = idRow?.matches?.[0]?.company_data;
      const reason = other
        ? `Crustdata matched ${asked} to ${other.basic_info?.name ?? "another company"} (${domainsOf(other).join(", ") || "no domain"}), which does not list ${asked} as its own. Check the domain, or run it with the company's main domain.`
        : `Crustdata has no company with the domain ${asked}. Check the spelling, or try the company's main website domain.`;
      return { status: "unmatched", asked, reason, ...(other ? { matched: other.basic_info?.name ?? undefined } : {}) };
    }
    const id = match.crustdata_company_id;
    const keys = keysFor(id, opts);

    // An answer without a record is not saved, so trying again later really asks again.
    const enriched = cache.get<{ data?: CompanyData; denied: string[]; fetched_at: string }>(keys.enrich)
      ?? await (async () => { const v = { ...(await enrichCompany(id)), fetched_at: opts.today.toISOString() }; if (v.data) cache.set(keys.enrich, v); return v; })();
    if (!enriched?.data) return { status: "unmatched", asked, reason: `Crustdata found ${asked} but has no full record for it yet. Try again in a few days.` };
    for (const f of Array.isArray(enriched.denied) ? enriched.denied : []) unavailable[String(f)] = "not enabled on this Crustdata key";
    // The rules below read the coerced record, so an odd shape cannot throw here; the memo sanitizes again.
    const company: CompanyData = sanitizeCompany(enriched.data);
    const industries = [...new Set([...industriesOf(match), ...industriesOf(company), ...(company.taxonomy?.professional_network_industry ? [company.taxonomy.professional_network_industry.trim().toLowerCase()] : [])])];

    let departures, seniorEnds;
    if (opts.leaversLimit > 0) {
      departures = (await section("departures", unavailable, async () =>
        (await cache.through(keys.departures, async () => ({ since: keys.yearAgo, ...(await searchDepartures(id, keys.yearAgo, opts.leaversLimit)) }))).value));
      seniorEnds = (await section("senior_ends", unavailable, async () =>
        (await cache.through(keys.senior, async () => ({ since: keys.yearAgo, ...(await searchSeniorEnds(id, keys.yearAgo, keys.seniorLimit)) }))).value));
    }

    const jobs = await section("jobs", unavailable, async () =>
      (await cache.through(keys.jobs, async () => ({ since: keys.ninetyDays, ...(await jobCounts(id, keys.ninetyDays)) }))).value);

    let peers: Bundle["peers"];
    let peersSkipped = false;
    const userPeers = opts.peers?.length ? opts.peers : undefined;
    if (opts.peers && !opts.peers.length) peersSkipped = true;
    const wanted = userPeers ?? competitorDomains(company);
    const limit = userPeers ? userPeers.length : opts.peersLimit;
    if (!userPeers && opts.peersLimit === 0) peersSkipped = true;
    if (!peersSkipped && wanted.length && limit > 0) {
      peers = await section("peers", unavailable, async () => {
        const candidates = wanted.slice(0, userPeers ? wanted.length : Math.max(limit * 2, 10));
        const rows = await Promise.all(candidates.map(async d => ({ d, row: await identify(d) })));
        const missing: string[] = [];
        const dropped: Array<{ domain: string; reason: "small" | "large" | "unrelated" }> = [];
        const picked: Array<{ d: string; id: number }> = [];
        for (const { d, row } of rows) {
          const m = pickMatch(row, d);
          if (!m?.crustdata_company_id || m.crustdata_company_id === id) { if (m?.crustdata_company_id !== id) missing.push(d); continue; }
          if (picked.some(p => p.id === m.crustdata_company_id)) continue;
          if (!userPeers) {
            // Competitor lists follow search keywords, so a company named after a common word gets unrelated
            // look-alikes (Linear got linear-motion hardware makers). A peer must share an industry; one with no
            // industry on record cannot be checked, so it is left out too. Industry first, then size.
            const theirs = industriesOf(m);
            if (industries.length && !theirs.some(x => industries.includes(x))) { dropped.push({ domain: d, reason: "unrelated" }); continue; }
            // Identify returns headcount.total today (checked live); a peer without it is kept rather than called small.
            const size = m.headcount?.total;
            if (typeof size === "number" && size < minPeerSize(company.headcount?.total)) { dropped.push({ domain: d, reason: "small" }); continue; }
            const own = company.headcount?.total;
            if (typeof size === "number" && typeof own === "number" && own > 0 && size > own * MAX_PEER_RATIO) { dropped.push({ domain: d, reason: "large" }); continue; }
          }
          if (picked.length < limit) picked.push({ d, id: m.crustdata_company_id });
        }
        const ids = picked.map(p => p.id).sort((a, b) => a - b);
        const found = ids.length ? (await cache.through(cacheKey("peers", [ids, PEER_FIELDS]), () => peersById(ids))).value : [];
        // Keep the order the peers were listed in.
        const byId = new Map(found.map(p => [p.crustdata_company_id, p] as const));
        const ordered = picked.map(p => byId.get(p.id)).filter((p): p is PeerData => !!p);
        cache.set(keys.peersDone, true);
        return { source: userPeers ? "user" as const : "auto" as const, asked: candidates, found: ordered, missing, dropped, industry_checked: industries.length > 0 };
      });
    } else if (!peersSkipped) {
      peers = { source: "auto", asked: [], found: [], missing: [], dropped: [] };
      cache.set(keys.peersDone, true);
    }

    const bundle: Bundle = {
      asked,
      fetched_at: enriched.fetched_at,
      company,
      industries,
      departures,
      senior_ends: seniorEnds,
      jobs,
      peers,
      ...(peersSkipped ? { peers_skipped: true } : {}),
      unavailable,
      credits: Math.round(run.credits * 100) / 100,
      list_credits: Math.round((LIST.enrich + LIST.person * ((departures?.people.length ?? 0) + (seniorEnds?.people.length ?? 0)) + LIST.peer * (peers?.found.length ?? 0) + (jobs?.newest ? 0.03 : 0)) * 100) / 100,
    };
    return { status: "ok", bundle };
  });
}

/** Industries from an identify match, lowercased (basic_info.industries). */
export function industriesOf(c: CompanyData | undefined): string[] {
  const v = (c?.basic_info as { industries?: unknown } | undefined)?.industries;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(x => x.trim().toLowerCase()).filter(Boolean) : [];
}
