/**
 * Crustdata API client: the only file that talks to Crustdata. Plain REST, no SDK.
 *
 *   POST   /company/search/autocomplete     exact stored values for a company filter (free)
 *   POST   /person/search/autocomplete      exact stored values for a person filter (free)
 *   POST   /company/search                  ranked search { search: { query, mode: "hybrid" }, filters }
 *   POST   /person/search                   decision-makers at the shortlist
 *
 * Watching the accounts afterwards is done with Crustdata directly; see examples/watch-accounts.ts.
 * Prices are in the README. Docs: https://docs.crustdata.com
 */

import { config } from "./config.js";

const BASE_URL = "https://api.crustdata.com";
const API_VERSION = "2025-11-01";

/** Credits this process has spent, summed from the x-credits-used header of every response. */
export const spend = { credits: 0 };
export const fmtCredits = (n: number): string => String(Math.round(n * 100) / 100);

export class CrustdataError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One request, with up to two retries on 429 (rate limit, waiting until the window resets) and on 5xx or network errors.
 * A billed search is not retried after a timeout, because it may have been billed.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = config.crustdataApiKey;
  const billedSearch = method === "POST" && /^\/(company|person|job|social_post)\/search$/.test(path);
  for (let attempt = 0; ; attempt++) {
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
      throw new CrustdataError(0, `Crustdata ${method} ${path} failed: ${(err as Error).message}`);
    }
    spend.credits += Number(res.headers.get("x-credits-used") ?? 0);

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 2) {
      // x-ratelimit-reset is the number of seconds until the per-minute window resets.
      const wait = Number(res.headers.get("retry-after")) || Number(res.headers.get("x-ratelimit-reset")) || 2 * (attempt + 1);
      await sleep(Math.min(wait + 1, 61) * 1000);
      continue;
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; }
    if (!res.ok) throw new CrustdataError(res.status, `Crustdata ${method} ${path} failed (${res.status}): ${json?.error?.message ?? json?.message ?? res.statusText}`);
    return json as T;
  }
}

// ---------------------------------------------------------------------------
// Filters: a leaf is { field, type, value }, a group is { op, conditions }.
// Operators: = != < =< > => in not_in (.) [.]   (Crustdata writes >= as => and <= as =<)
// ---------------------------------------------------------------------------

export type Filter = { field: string; type: string; value: unknown } | { op: "and" | "or"; conditions: Filter[] };

export const leaf = (field: string, type: string, value: unknown): Filter => ({ field, type, value });
export const and = (...conditions: Array<Filter | undefined>): Filter => ({ op: "and", conditions: conditions.filter(c => c !== undefined) });
export const or = (...conditions: Array<Filter | undefined>): Filter => ({ op: "or", conditions: conditions.filter(c => c !== undefined) });

// ---------------------------------------------------------------------------
// Autocomplete (free). Categorical values are closed sets: "Series A" matches nothing, the stored value is "series_a".
// ---------------------------------------------------------------------------

export async function autocomplete(dataset: "company" | "person", field: string, query: string, limit = 20): Promise<string[]> {
  const r = await request<{ suggestions?: Array<{ value: string }> }>("POST", `/${dataset}/search/autocomplete`, { field, query, limit });
  return (r?.suggestions ?? []).map(s => s.value);
}

// ---------------------------------------------------------------------------
// Company search
// ---------------------------------------------------------------------------

/** A safety cap on cursor pages per search (ranked search ends at 10 pages of 100 anyway). */
const MAX_PAGES = 20;

export type Company = {
  crustdata_company_id: number;
  basic_info?: { name?: string; primary_domain?: string };
  headcount?: { total?: number; growth_percent?: Record<string, number> };
  funding?: { last_round_type?: string; last_fundraise_date?: string; investors?: string[] };
  locations?: { country?: string };
  taxonomy?: { professional_network_industries?: string[] };
};

/**
 * Ranked search: up to 100 results per page, at most 1,000 candidates, `total_count` always null. Cursors expire
 * 20 minutes after the first page, so pages are fetched back to back. Field groups like headcount, funding and
 * taxonomy are premium: each one you filter on or receive adds to the per-result price.
 */
export async function searchCompanies(query: string, filters: Filter | undefined, max: number, fields: string[]): Promise<Company[]> {
  const companies: Company[] = [];
  let cursor: string | undefined, pages = 0;
  do {
    const page = await request<{ companies?: Company[]; next_cursor?: string | null }>("POST", "/company/search", {
      search: { query, mode: "hybrid" },
      ...(filters ? { filters } : {}),
      fields,
      limit: Math.min(100, max - companies.length),
      ...(cursor ? { cursor } : {}),
    });
    companies.push(...(page.companies ?? []));
    cursor = page.next_cursor ?? undefined;
    // An empty page can still carry a cursor (deleted companies keep their positions), so keep going, within a cap.
  } while (cursor && companies.length < max && ++pages < MAX_PAGES);
  return companies;
}

// ---------------------------------------------------------------------------
// Person search
// ---------------------------------------------------------------------------

export type Profile = {
  crustdata_person_id: number;
  basic_profile?: { name?: string; current_title?: string };
  /** A filter on current.company_id comes back under current[].crustdata_company_id. */
  experience?: { employment_details?: { current?: Array<{ crustdata_company_id?: number; title?: string; seniority_level?: string }> } };
  social_handles?: { professional_network_identifier?: { profile_url?: string } };
};

export const profileUrl = (p: Profile): string | undefined => p.social_handles?.professional_network_identifier?.profile_url;

/** Never request professional_network.followers here: it is plan-gated and fails the whole call with 403. */
export async function searchPeople(filters: Filter, max: number, excludeProfiles: string[] = []): Promise<Profile[]> {
  const profiles: Profile[] = [];
  let cursor: string | undefined, pages = 0;
  do {
    const page = await request<{ profiles?: Profile[]; next_cursor?: string | null }>("POST", "/person/search", {
      filters,
      fields: ["basic_profile", "experience", "social_handles"],
      limit: Math.min(1000, max - profiles.length),
      ...(excludeProfiles.length ? { post_processing: { exclude_profiles: excludeProfiles } } : {}),
      ...(cursor ? { cursor } : {}),
    });
    profiles.push(...(page.profiles ?? []));
    cursor = page.next_cursor ?? undefined;
  } while (cursor && profiles.length < max && ++pages < MAX_PAGES);
  return profiles;
}
