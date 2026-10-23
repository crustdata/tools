/**
 * Crustdata API client: the only file that talks to Crustdata. Plain REST, no SDK, so it reads as documentation.
 *
 *   POST /company/search/autocomplete   exact stored values for a company filter              free
 *   POST /company/search                ranked search { search: { query, mode: "hybrid" } }   0.03 per company + data groups
 *   POST /person/search                 founders, CEOs and CTOs at the shortlist              0.03 per person + data groups
 *   POST /job/search                    roles posted per company (limit 0 + group_by)         free
 *                                       newest role titles for the top companies              0.03 per role
 *   POST /social_post/search            founders' traction posts (limit 0 count)              free
 *                                       the posts themselves, quoted in memos                 0.5 per post
 *
 * Prices are list prices; GET /account/endpoints has your own. Docs: https://docs.crustdata.com
 */

import { config } from "./config.js";
import type { RawCompany, RawJob, RawPost, RawProfile } from "./types.js";

const BASE_URL = "https://api.crustdata.com";
const API_VERSION = "2025-11-01";

/** Credits this process has spent, summed from the x-credits-used header of every response. */
export const spend = { credits: 0 };
export const fmtCredits = (n: number): string => String(Math.round(n * 100) / 100);

export class CrustdataError extends Error {
  /** `type` is Crustdata's `error.type` (permission_error, insufficient_credits, ...) when the response had one. */
  constructor(public status: number, message: string, public path = "", public type = "") { super(message); }
  /** Out of credits: a 402, or a 403 whose type or message says credits. */
  get outOfCredits(): boolean { return this.status === 402 || (this.status === 403 && /credit/i.test(this.type + " " + this.message)); }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Search endpoints allow 30 requests a minute. Requests to one path are spaced 2.1 seconds apart, so a run of many
 * small calls (one post count per company) stays under the limit instead of bouncing off it.
 */
const MIN_GAP_MS = Number(process.env.CRUSTDATA_MIN_GAP_MS ?? 2100);
const lastCall = new Map<string, number>();
async function pace(path: string) {
  if (!/\/search$/.test(path)) return;
  const wait = (lastCall.get(path) ?? 0) + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(path, Date.now());
}

/**
 * One request, with up to two retries on 429 (waiting until the rate-limit window resets) and on 5xx or network
 * errors. A billed search is not retried after a timeout, because it may already have been billed.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = config.crustdataApiKey;
  const billedSearch = method === "POST" && /^\/(company|person|job|social_post)\/search$/.test(path);
  for (let attempt = 0; ; attempt++) {
    await pace(path);
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-api-version": API_VERSION },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError";
      if (attempt < 2 && !(billedSearch && timedOut)) { await sleep(2000 * (attempt + 1)); continue; }
      throw new CrustdataError(0, `Crustdata ${method} ${path} did not answer: ${(err as Error).message}`, path);
    }
    spend.credits += Number(res.headers.get("x-credits-used") ?? 0);

    // A paid search that failed with 500, 502 or 504 may already have been billed: only 429 and 503 are retried for it.
    const retryable = res.status === 429 || res.status === 503 || (res.status >= 500 && !billedSearch);
    if (retryable && attempt < 2) {
      // x-ratelimit-reset is the number of seconds until the per-minute window resets.
      const wait = Number(res.headers.get("retry-after")) || Number(res.headers.get("x-ratelimit-reset")) || 2 * (attempt + 1);
      await sleep(Math.min(wait + 1, 61) * 1000);
      continue;
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; }
    if (!res.ok) {
      const detail = json?.error?.message ?? json?.message ?? res.statusText;
      throw new CrustdataError(res.status, `Crustdata ${method} ${path} failed (${res.status}): ${detail}`, path, String(json?.error?.type ?? ""));
    }
    return json as T;
  }
}

// ---------------------------------------------------------------------------
// Filters: a leaf is { field, type, value }, a group is { op, conditions }.
// Operators: = != < =< > => in not_in is_null (.) [.]   (Crustdata writes >= as => and <= as =<)
// ---------------------------------------------------------------------------

export type Filter = { field: string; type: string; value: unknown } | { op: "and" | "or"; conditions: Filter[] };

export const leaf = (field: string, type: string, value: unknown): Filter => ({ field, type, value });
export const and = (...conditions: Array<Filter | undefined>): Filter => ({ op: "and", conditions: conditions.filter(c => c !== undefined) });
export const or = (...conditions: Array<Filter | undefined>): Filter => ({ op: "or", conditions: conditions.filter(c => c !== undefined) });

/** Free. Categorical values are closed sets: "Series A" matches nothing, the stored value is "series_a". */
export async function autocomplete(dataset: "company" | "person", field: string, query: string, limit = 20): Promise<string[]> {
  const r = await request<{ suggestions?: Array<{ value: string }> }>("POST", `/${dataset}/search/autocomplete`, { field, query, limit });
  return (r?.suggestions ?? []).map(s => s.value);
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

/**
 * Data groups returned for every company. headcount, funding and followers are premium groups (0.2 each per company
 * at list price); a group that comes back empty is not billed. taxonomy is left out: ranking already uses the thesis.
 * `hiring` comes back empty on search, so open roles are counted with /job/search instead.
 */
export const COMPANY_FIELDS = ["crustdata_company_id", "basic_info", "headcount", "funding", "locations", "followers"];

/** A safety cap on cursor pages (ranked search ends at 10 pages of 100 anyway). */
const MAX_PAGES = 20;

/**
 * Ranked search: up to 100 results per page, at most 1,000 in total, `total_count` always null. Cursors expire
 * 20 minutes after the first page, so pages are fetched back to back.
 */
export async function searchCompanies(query: string, filters: Filter | undefined, max: number, onPage?: (page: RawCompany[]) => void): Promise<RawCompany[]> {
  const companies: RawCompany[] = [];
  let cursor: string | undefined, pages = 0;
  do {
    const page = await request<{ companies?: RawCompany[]; next_cursor?: string | null }>("POST", "/company/search", {
      search: { query, mode: "hybrid" },
      ...(filters ? { filters } : {}),
      fields: COMPANY_FIELDS,
      limit: Math.min(100, max - companies.length),
      ...(cursor ? { cursor } : {}),
    });
    companies.push(...(page.companies ?? []));
    onPage?.(page.companies ?? []);
    cursor = page.next_cursor ?? undefined;
    // An empty page can still carry a cursor (removed companies keep their positions), so keep going, within a cap.
  } while (cursor && companies.length < max && ++pages < MAX_PAGES);
  return companies;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** experience and education are premium groups: 0.1 each to filter on or receive, per person, at list price. */
const PERSON_FIELDS = ["basic_profile", "experience", "education", "social_handles"];

export async function searchPeople(filters: Filter, max: number): Promise<RawProfile[]> {
  const profiles: RawProfile[] = [];
  let cursor: string | undefined, pages = 0;
  do {
    const page = await request<{ profiles?: RawProfile[]; next_cursor?: string | null }>("POST", "/person/search", {
      filters,
      fields: PERSON_FIELDS,
      limit: Math.min(1000, max - profiles.length),
      ...(cursor ? { cursor } : {}),
    });
    profiles.push(...(page.profiles ?? []));
    cursor = page.next_cursor ?? undefined;
  } while (cursor && profiles.length < max && ++pages < MAX_PAGES);
  return profiles;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Roles posted since a date, per company. `limit: 0` with a group_by returns counts only and costs nothing.
 * Listings stay in the index for a while after they close, so "posted in the last N days" is what can be measured for
 * hiring, not "open now".
 */
export async function jobCounts(companyIds: number[], since: string): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (let i = 0; i < companyIds.length; i += 500) {
    const ids = companyIds.slice(i, i + 500);
    const r = await request<{ aggregations?: Array<{ buckets?: Array<{ key: number | string; count: number }> }> }>("POST", "/job/search", {
      filters: and(leaf("company.basic_info.company_id", "in", ids), leaf("metadata.date_added", "=>", since)),
      limit: 0,
      aggregations: [{ type: "group_by", field: "company.basic_info.company_id", agg: "count", size: 1000 }],
    });
    for (const b of r.aggregations?.[0]?.buckets ?? []) counts.set(Number(b.key), b.count);
  }
  return counts;
}

/**
 * Distinct role titles one company posted since a date. One role is often listed on several job sites, so counting
 * titles is closer to the number of roles than counting listings. Free (limit 0 with a group_by).
 */
export async function distinctRoles(companyId: number, since: string): Promise<number> {
  const r = await request<{ aggregations?: Array<{ buckets?: unknown[] }> }>("POST", "/job/search", {
    filters: and(leaf("company.basic_info.company_id", "=", companyId), leaf("metadata.date_added", "=>", since)),
    limit: 0,
    aggregations: [{ type: "group_by", field: "job_details.title", agg: "count", size: 1000 }],
  });
  return r.aggregations?.[0]?.buckets?.length ?? 0;
}

/** The newest roles one company posted (0.03 credits per role returned). */
export async function newestJobs(companyId: number, limit: number): Promise<RawJob[]> {
  const r = await request<{ job_listings?: RawJob[] }>("POST", "/job/search", {
    filters: leaf("company.basic_info.company_id", "=", companyId),
    sorts: [{ field: "metadata.date_added", order: "desc" }],
    fields: ["job_details.title", "job_details.url", "metadata.date_added"],
    limit,
  });
  return r.job_listings ?? [];
}

// ---------------------------------------------------------------------------
// Social posts
// ---------------------------------------------------------------------------

/** Posts by these authors since a date that contain one of the phrases (exact phrase match, any case). */
export const postFilters = (authorIds: number[], since: string, phrases: string[]): Filter => and(
  // actor.crustdata_entity_id is a person id or a company id: actor_type keeps it to people.
  leaf("actor.actor_type", "=", "person"),
  leaf("actor.crustdata_entity_id", "in", authorIds),
  leaf("date_posted", "=>", since),
  or(...phrases.map(p => leaf("text", "[.]", p))),
);

/** Posts by these authors since a date with round news: an exact round phrase, or an announcement and a round together. */
export const raisePostFilters = (authorIds: number[], since: string, exact: string[], actions: string[], rounds: string[]): Filter => and(
  leaf("actor.actor_type", "=", "person"),
  leaf("actor.crustdata_entity_id", "in", authorIds),
  leaf("date_posted", "=>", since),
  or(
    ...exact.map(p => leaf("text", "[.]", p)),
    and(or(...actions.map(p => leaf("text", "[.]", p))), or(...rounds.map(p => leaf("text", "[.]", p)))),
  ),
);

/** How many posts match. `limit: 0` is free. Post search is enabled on request: a key without it gets a 403. */
export async function countPosts(filters: Filter): Promise<number> {
  const r = await request<{ total_count?: number }>("POST", "/social_post/search", { filters, limit: 0 });
  return r.total_count ?? 0;
}

/** The newest matching posts, 0.5 credits each. */
export async function fetchPosts(filters: Filter, limit: number): Promise<RawPost[]> {
  const r = await request<{ posts?: RawPost[] }>("POST", "/social_post/search", {
    filters,
    fields: ["share_url", "date_posted", "text", "actor"],
    sorts: [{ field: "date_posted", order: "desc" }],
    limit,
  });
  return r.posts ?? [];
}
