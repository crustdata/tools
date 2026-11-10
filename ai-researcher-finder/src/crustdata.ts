/**
 * Crustdata API client: the only file that talks to Crustdata. Plain REST, no SDK.
 *
 *   POST /person/search             the role search ({ search: { query, mode: "hybrid" }, mode: "exact", filters }),
 *                                   paper title lookups, and full records for people found by Scholar or GitHub
 *   POST /person/identify           Google Scholar profile URLs and profile URLs to people (1 credit a match)
 *   POST /dev_platform/enrich       a GitHub profile URL to the person it belongs to (1 credit a call)
 *   POST /company/identify          lab domains or names to Crustdata company ids, free
 *   POST /person/search/autocomplete  stored spellings (countries), free
 *   GET  /account/endpoints         what this key can use and its prices, free
 *   GET  /account/credits           credit balance, free
 *
 * Prices are in the README. Docs: https://docs.crustdata.com
 */

import { config } from "./config.js";

const BASE_URL = "https://api.crustdata.com";
const API_VERSION = "2025-11-01";

/** Credits this process has spent, summed from the x-credits-used header of every response. */
export const spend = { credits: 0 };
export const fmtCredits = (n: number): string => String(Math.round(n * 100) / 100);

export class CrustdataError extends Error {
  constructor(public status: number, message: string, public apiMessage = "") { super(message); }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A plain next step for each kind of failure, instead of a stack trace. */
function explainStatus(status: number, method: string, path: string, apiMessage: string): string {
  const said = apiMessage ? `: ${apiMessage}` : "";
  if (status === 401) return "Crustdata rejected the API key (401). Copy it again from https://app.crustdata.com and run npm run setup.";
  if (status === 402 || /insufficient credits|out of credits/i.test(apiMessage)) return `Your Crustdata account is out of credits (${status}). Top up at https://app.crustdata.com, then run again.`;
  if (status === 403) return `Crustdata refused ${method} ${path} for this key (403)${said}. Ask Crustdata to enable it for your account.`;
  if (status === 429) return "Crustdata is still rate limiting this key (429) after waiting. Wait a minute and run again.";
  if (status >= 500) return `Crustdata had a server error on ${method} ${path} (${status}). Everything found before it is saved and in the report; run the same command again in a minute (people already found are skipped).`;
  return `Crustdata could not run ${method} ${path} (${status})${said}`;
}

/** Requests a minute each endpoint allows; calls are spaced to stay under it. */
const PACE: Record<string, number> = { "/person/identify": 30, "/dev_platform/enrich": 15, "/person/search": 30 };
const lastCall = new Map<string, number>();
async function pace(path: string): Promise<void> {
  const perMinute = PACE[path];
  if (!perMinute || process.env.NODE_TEST_CONTEXT || process.env.ARF_REPLAY) return;
  const gap = 60_000 / perMinute, wait = (lastCall.get(path) ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(path, Date.now());
}

const BILLED = /^\/(person\/(search|identify)|dev_platform\/enrich)$/;

/**
 * One request, with up to two retries on 429 (waiting until the rate limit window resets), on 5xx and on network
 * errors. A billed request is retried only when it surely was not billed: a 429, or a connection that never opened.
 * A timeout or any 5xx may have been billed (a proxy can answer 502 after the work was done), so it is not retried
 * and the message says so.
 */
async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const key = config.crustdataApiKey;
  const billed = method === "POST" && BILLED.test(path);
  for (let attempt = 0; ; attempt++) {
    await pace(path);
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-api-version": API_VERSION },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      const code = String((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message);
      const neverSent = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(code);
      if (attempt < 2 && (!billed || neverSent)) { await sleep(2000 * (attempt + 1)); continue; }
      throw new CrustdataError(0, `Could not reach Crustdata (${method} ${path}): ${(err as Error).message}.${billed && !neverSent ? " The request may have been billed; what was saved before it is kept." : ""} Check your connection and run again.`);
    }
    spend.credits += Number(res.headers.get("x-credits-used") ?? 0) || 0;

    const retryable = res.status === 429 || (!billed && res.status >= 500);
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
      const apiMessage = String(json?.error?.message ?? json?.message ?? res.statusText ?? "");
      throw new CrustdataError(res.status, explainStatus(res.status, method, path, apiMessage), apiMessage);
    }
    return json as T;
  }
}

// ---------------------------------------------------------------------------
// Filters: a leaf is { field, type, value }, a group is { op, conditions }.
// Operators used here: = in (.) [.]   ([.] is an exact phrase, case-insensitive; (.) is every word, any order)
// ---------------------------------------------------------------------------

export type Filter = { field: string; type: string; value: unknown } | { op: "and" | "or"; conditions: Filter[] };

export const leaf = (field: string, type: string, value: unknown): Filter => ({ field, type, value });
export const and = (...conditions: Array<Filter | undefined>): Filter => ({ op: "and", conditions: conditions.filter((c): c is Filter => c !== undefined) });
export const or = (...conditions: Array<Filter | undefined>): Filter => ({ op: "or", conditions: conditions.filter((c): c is Filter => c !== undefined) });

// ---------------------------------------------------------------------------
// Person records (the parts this tool reads)
// ---------------------------------------------------------------------------

export type Role = {
  title?: string | null;
  name?: string | null;                 // the employer's name
  crustdata_company_id?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  description?: string | null;
  is_default?: boolean | null;
};

export type ResearchProfile = {
  id?: string | null;
  name?: string | null;
  profile_url?: string | null;          // the Google Scholar profile
  designation?: string | null;
  affiliated_organisation?: string | null;
  research_interests?: string[] | null;
  article_count?: number | null;
  articles?: Array<{ title?: string | null; url?: string | null; publication_year?: string | number | null }> | null;
  co_authors?: Array<{ id?: string | null; name?: string | null }> | null;
  citations_count?: { all?: number | null; recent?: number | null; recent_since_year?: number | null } | null;
  h_index?: { all?: number | null; recent?: number | null } | null;
  metadata?: { last_scraped_source?: string | null } | null;
};

export type Person = {
  crustdata_person_id: number;
  /** Crustdata's relevance tier for the query, on the top of the ranked list (up to 200 people); null after that. */
  fit?: "strong" | "possible" | "weak" | null;
  basic_profile?: {
    name?: string | null;
    headline?: string | null;
    current_title?: string | null;
    location?: { full_location?: string | null; raw?: string | null; country?: string | null } | null;
  } | null;
  experience?: { employment_details?: { current?: Role[] | null; past?: Role[] | null } | null } | null;
  education?: { schools?: Array<{ school?: string | null; degree?: string | null; field_of_study?: string | null }> | null } | null;
  skills?: { professional_network_skills?: string[] | null } | null;
  social_handles?: { professional_network_identifier?: { profile_url?: string | null } | null } | null;
  research_profiles?: ResearchProfile[] | null;
};

/** Every data group the score and the team guess read. A group that comes back empty for a person is not billed. */
export const PERSON_FIELDS = ["fit", "basic_profile", "experience", "education", "skills", "social_handles", "research_profiles"];

export type SearchBody = {
  search?: { query: string; mode: "hybrid" };
  mode?: "exact";
  filters: Filter;
  fields?: string[];
  limit?: number;
  cursor?: string;
  post_processing?: { exclude_profiles?: string[] };
};
type SearchPage = { profiles?: Person[]; next_cursor?: string | null; total_count?: number | null };

/**
 * One search, cursor page by cursor page (up to 1,000 a page), until `max` people. A data group this key may not read
 * (research records are enabled per account) fails the whole request with "Access denied to fields"; that group is
 * dropped, said once through `note`, and the page is asked for again. People are handed to `onPage` as soon as a
 * page is billed, so a failure on a later page never loses them.
 */
export async function searchPeople(body: SearchBody, max: number, note: (msg: string) => void = () => {}, onPage: (people: Person[]) => void = () => {}): Promise<{ people: Person[]; total: number | null }> {
  const people: Person[] = [];
  let fields = body.fields ? [...body.fields] : undefined;
  let cursor: string | undefined, total: number | null = null;
  const seen = new Set<number>();
  for (let pages = 0; pages < 20 && people.length < max; pages++) {
    let page: SearchPage;
    try {
      page = await request<SearchPage>("POST", "/person/search", { ...body, fields, limit: Math.min(1000, max - people.length), ...(cursor ? { cursor } : {}) });
    } catch (err) {
      const denied = err instanceof CrustdataError && !cursor && /(?:Access denied to fields|Invalid fields):\s*([\w.,\s]+)/i.exec(err.apiMessage);
      const drop = new Set((denied ? denied[1].split(",") : []).map(s => s.trim().split(/[.\s]/)[0]).filter(Boolean));
      if (fields && drop.size && fields.some(f => drop.has(f.split(".")[0]))) {
        fields = fields.filter(f => !drop.has(f.split(".")[0]));
        note(`This key cannot read ${[...drop].join(", ")} in search results, so the search ran without it (ask Crustdata to enable it).`);
        pages--;
        continue;
      }
      throw err;
    }
    // A person repeated across cursor pages is kept once; a page that adds nobody new ends the search.
    const got = (page.profiles ?? []).filter(p => p?.crustdata_person_id && !seen.has(p.crustdata_person_id));
    for (const p of got) seen.add(p.crustdata_person_id);
    people.push(...got);
    if (got.length) onPage(got);
    else if (pages > 0) break;
    if (total === null && typeof page.total_count === "number") total = page.total_count;
    cursor = page.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return { people, total };
}

/** Full records for people already identified, one search over their ids (1,000 a request). */
export async function peopleById(ids: number[], note: (msg: string) => void = () => {}): Promise<Person[]> {
  const out: Person[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const batch = ids.slice(i, i + 1000);
    const { people } = await searchPeople({ filters: and(leaf("crustdata_person_id", "in", batch)), fields: PERSON_FIELDS }, batch.length, note);
    out.push(...people);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identify: Google Scholar profile URLs and profile URLs to people. 25 per request, 30 requests a minute, 1 credit per
// match, free on a miss. Enabled per account. The response is one row per identifier, in the order sent.
// ---------------------------------------------------------------------------

export type IdentifyRow = {
  matched_on: string;
  match_status: "matched" | "not_found" | "redacted" | string;
  matches?: Array<{ confidence_score?: number; person_data?: { crustdata_person_id?: number; basic_profile?: { name?: string | null } } }>;
};

/**
 * Rows keyed by the identifier they answer. Each batch is read on its own: a row is matched on `matched_on`, and by
 * position only when a batch answers every identifier without one, so a short answer can never shift a row onto the
 * wrong person. An identifier with no row is simply absent from the map.
 */
export async function identifyPeople(kind: "research_profile_urls" | "professional_network_profile_urls", values: string[]): Promise<Map<string, IdentifyRow>> {
  const out = new Map<string, IdentifyRow>();
  for (let i = 0; i < values.length; i += 25) {
    const batch = values.slice(i, i + 25);
    const r = await request<IdentifyRow[]>("POST", "/person/identify", { [kind]: batch });
    const rows = Array.isArray(r) ? r : [];
    // Compared in one form (no scheme, no www, no trailing slash), in case the API echoes the URL differently.
    const k = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
    const byValue = new Map(rows.filter(x => x?.matched_on).map(x => [k(x.matched_on), x]));
    batch.forEach((v, j) => {
      const row = byValue.get(k(v)) ?? (rows.length === batch.length && !rows[j]?.matched_on ? rows[j] : undefined);
      if (row) out.set(v, row);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dev platform: a GitHub profile URL to the person it is linked to. One URL a request, 15 requests a minute,
// 1 credit a call even when no person is linked (crustdata_person_id comes back null). Enterprise plans.
// ---------------------------------------------------------------------------

export type DevPlatformResult = {
  crustdata_person_id?: number | null;
  dev_platform_profiles?: Array<{ profile_url?: string | null; name?: string | null; account_type?: string | null; company_text?: string | null; confidence_score?: number | null; all_topics?: string[] | null }> | null;
};

export async function githubToPerson(profileUrl: string): Promise<DevPlatformResult> {
  return request<DevPlatformResult>("POST", "/dev_platform/enrich", { profile_url: profileUrl });
}

// ---------------------------------------------------------------------------
// Companies (free): lab domains or names to Crustdata company ids, so lab filters match the company itself rather
// than everyone with a matching website (people's roles carry crustdata_company_id).
// ---------------------------------------------------------------------------

export type CompanyMatch = { matched_on: string; matches?: Array<{ confidence_score?: number; company_data?: { crustdata_company_id?: number; basic_info?: { name?: string; primary_domain?: string; employee_count_range?: string } } }> };

export async function identifyCompanies(kind: "domains" | "names", values: string[]): Promise<CompanyMatch[]> {
  if (!values.length) return [];
  const r = await request<CompanyMatch[]>("POST", "/company/identify", { [kind]: values });
  return Array.isArray(r) ? r : [];
}

export async function autocomplete(field: string, query: string, limit = 10): Promise<string[]> {
  const r = await request<{ suggestions?: Array<{ value: string }> }>("POST", "/person/search/autocomplete", { field, query, limit });
  return (r?.suggestions ?? []).map(s => s.value).filter(v => typeof v === "string");
}

// ---------------------------------------------------------------------------
// Account (free)
// ---------------------------------------------------------------------------

export type Endpoint = {
  path: string;
  status?: string;
  fields?: { enabled?: string[]; disabled?: string[] };
  base_credits?: number;
  premium_filters?: Array<{ field: string; credits: number }>;
  premium_fields?: Array<{ field: string; credits: number }>;
};

export async function accountEndpoints(): Promise<Endpoint[]> {
  const r = await request<Endpoint[] | { endpoints?: Endpoint[] }>("GET", "/account/endpoints");
  return Array.isArray(r) ? r : r?.endpoints ?? [];
}

export async function creditBalance(): Promise<number | undefined> {
  const r = await request<{ account?: { credits?: number } }>("GET", "/account/credits");
  return r?.account?.credits;
}

/** Whether /person/identify works for this key: it is not listed in /account/endpoints, so ask with a made-up Scholar URL (free). */
export async function canIdentify(): Promise<boolean> {
  try {
    await identifyPeople("research_profile_urls", ["https://scholar.google.com/citations?user=AAAAAAAAAAAA"]);
    return true;
  } catch (err) {
    if (err instanceof CrustdataError && (err.status === 403 || err.status === 404)) return false;
    throw err;
  }
}
