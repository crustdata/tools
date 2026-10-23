/**
 * Crustdata API client: the only file that talks to Crustdata. Plain REST, no SDK.
 *
 *   POST /person/search/autocomplete   exact stored values for a filter (skills, countries, schools), free
 *   POST /person/search                the candidate search: { search: { query, mode: "hybrid" }, mode: "exact", filters }
 *                                      also the count per round, the "open to new roles" check, and explain on empty results
 *   POST /person/contact/enrich        personal email, work email, phone (only with contact access, only when asked)
 *   GET  /account/endpoints            what this key can use, free (contact access, skills, research records)
 *   GET  /account/credits              credit balance, free
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
  if (status === 403) return `Crustdata refused ${method} ${path} for this key (403)${said}`;
  if (status === 429) return "Crustdata is still rate limiting this key (429) after waiting. Wait a minute and run again.";
  if (status >= 500) return `Crustdata had a server error on ${method} ${path} (${status}). Everything found before it is saved; run again in a minute.`;
  return `Crustdata could not run ${method} ${path} (${status})${said}`;
}

/**
 * One request, with up to two retries on 429 (waiting until the rate limit window resets), on 5xx and on network
 * errors. A billed request (search, contacts) is retried only when it surely was not billed: 429, 502, 503, or a
 * connection that never opened. A timeout, a reset connection or another 5xx may have been billed, so it is not
 * retried and the message says so.
 */
async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const key = config.crustdataApiKey;
  const billed = method === "POST" && /^\/person\/(search|contact\/enrich|enrich)$/.test(path);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-api-version": API_VERSION },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      const neverSent = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(String((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message));
      if (attempt < 2 && (!billed || neverSent)) { await sleep(2000 * (attempt + 1)); continue; }
      throw new CrustdataError(0, `Could not reach Crustdata (${method} ${path}): ${(err as Error).message}.${billed && !neverSent ? " The request may have been billed; what was saved before it is kept." : ""} Check your connection and run again.`);
    }
    spend.credits += Number(res.headers.get("x-credits-used") ?? 0) || 0;

    const retryable = res.status === 429 || res.status === 502 || res.status === 503 || (!billed && res.status >= 500);
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
// Operators: = != < =< > => in not_in (.) [.] is_null geo_distance   (Crustdata writes >= as => and <= as =<)
// ---------------------------------------------------------------------------

export type Filter = { field: string; type: string; value: unknown } | { op: "and" | "or"; conditions: Filter[] };

export const leaf = (field: string, type: string, value: unknown): Filter => ({ field, type, value });
export const and = (...conditions: Array<Filter | undefined>): Filter => ({ op: "and", conditions: conditions.filter((c): c is Filter => c !== undefined) });
export const or = (...conditions: Array<Filter | undefined>): Filter => ({ op: "or", conditions: conditions.filter((c): c is Filter => c !== undefined) });

// ---------------------------------------------------------------------------
// Autocomplete (free, 300 requests a minute). Skills, countries and schools are stored values: "pytorch" is stored
// as "PyTorch", and a value that is not stored matches nobody.
// ---------------------------------------------------------------------------

export async function autocomplete(field: string, query: string, limit = 10): Promise<string[]> {
  const r = await request<{ suggestions?: Array<{ value: string }> }>("POST", "/person/search/autocomplete", { field, query, limit });
  return (r?.suggestions ?? []).map(s => s.value).filter(v => typeof v === "string");
}

// ---------------------------------------------------------------------------
// Person search
// ---------------------------------------------------------------------------

export type Role = {
  title?: string;
  name?: string;                      // the employer's name
  start_date?: string | null;
  end_date?: string | null;
  is_default?: boolean;               // the person's main role when they hold several
  company_headcount_latest?: number | null;
  company_headcount_range?: string | null;
  company_website?: string | null;    // a full URL in search results, sometimes with a query string
  crustdata_company_id?: number | null;
  seniority_level?: string | null;
  description?: string | null;
};

export type ResearchProfile = {
  h_index?: { all?: number | null } | null;
  citations_count?: { all?: number | null } | null;
  article_count?: number | null;
  affiliated_organisation?: string | null;
};

export type Person = {
  crustdata_person_id: number;
  /** Crustdata's relevance tier for the query, on the top of the ranked list (up to 200 people); null after that. */
  fit?: "strong" | "possible" | "weak" | null;
  basic_profile?: {
    name?: string;
    headline?: string | null;
    current_title?: string | null;
    location?: { full_location?: string | null; raw?: string | null; city?: string | null; state?: string | null; country?: string | null } | null;
  };
  experience?: { employment_details?: { current?: Role[] | null; past?: Role[] | null } };
  education?: { schools?: Array<{ school?: string | null; degree?: string | null; field_of_study?: string | null; end_year?: number | null }> | null };
  skills?: { professional_network_skills?: string[] | null };
  social_handles?: { professional_network_identifier?: { profile_url?: string | null } | null };
  research_profiles?: ResearchProfile[] | null;
};

export type Remark = { code: string; path?: string; matches_without?: number; message?: string };
export type SearchBody = {
  search?: { query: string; mode: "hybrid" | "lexical" | "semantic"; query_syntax?: "boolean" };
  mode?: "exact";
  filters?: Filter;
  fields?: string[];
  limit?: number;
  cursor?: string;
  post_processing?: { exclude_profiles?: string[] };
  explain?: boolean;
};
type SearchPage = { profiles?: Person[]; next_cursor?: string | null; total_count?: number | null; remarks?: Remark[] };

/** A safety cap on cursor pages per search. A ranked search stops after 10,000 people anyway. */
const MAX_PAGES = 20;

/**
 * The ranked candidate search. Pages of up to 1,000, with the same filters, query and mode on every page (the
 * cursor keeps the order for 20 minutes). A field group this key may not read (skills, research records) fails the
 * whole request with "Access denied to fields"; that group is dropped, said once through `note`, and the page is
 * asked for again.
 */
export async function searchPeople(body: SearchBody, max: number, note: (msg: string) => void = () => {}, onPage: (profiles: Person[]) => void = () => {}): Promise<{ profiles: Person[]; total: number | null }> {
  const profiles: Person[] = [];
  let fields = body.fields ? [...body.fields] : undefined;
  let cursor: string | undefined, total: number | null = null, pages = 0;
  for (;;) {
    let page: SearchPage;
    try {
      page = await request<SearchPage>("POST", "/person/search", { ...body, fields, limit: Math.min(1000, max - profiles.length), ...(cursor ? { cursor } : {}) });
    } catch (err) {
      const denied = err instanceof CrustdataError && !cursor && /(?:Access denied to fields|Invalid fields):\s*([\w.,\s]+)/i.exec(err.apiMessage);
      const names = denied ? denied[1].split(",").map(s => s.trim().split(/\s/)[0]).filter(Boolean) : [];
      const drop = new Set(names.map(n => n.split(".")[0]));
      if (fields && drop.size && fields.some(f => drop.has(f.split(".")[0]))) {
        fields = fields.filter(f => !drop.has(f.split(".")[0]));
        note(`This key cannot read ${[...drop].join(", ")} in search results, so the search ran without it (ask Crustdata to enable it).`);
        continue;
      }
      throw err;
    }
    const got = page.profiles ?? [];
    profiles.push(...got);
    // Billed people are handed over page by page, so a failure on a later page never loses (and re-bills) them.
    if (got.length) onPage(got);
    if (total === null && typeof page.total_count === "number") total = page.total_count;
    cursor = page.next_cursor ?? undefined;
    // An empty page can still carry a cursor (removed profiles keep their places), so keep going, within a cap.
    if (!cursor || profiles.length >= max || ++pages >= MAX_PAGES) break;
  }
  return { profiles, total };
}

/**
 * How many people match some filters, for the round log. Filters only, one result, no data groups returned, so it
 * bills one result plus the filter groups. With `explain`, an empty result names the condition that removed
 * everyone, and costs nothing.
 */
export async function countPeople(filters: Filter): Promise<{ total: number; remarks: Remark[] }> {
  const page = await request<SearchPage>("POST", "/person/search", { filters, fields: ["crustdata_person_id"], limit: 1, explain: true });
  return { total: page.total_count ?? page.profiles?.length ?? 0, remarks: page.remarks ?? [] };
}

/**
 * Which of these people say they are open to new roles. One filtered search over their ids, billed only for the
 * people who are (0.03 plus the professional network filter each), which is cheaper than returning that data group
 * for everyone.
 */
export async function openToNewRoles(ids: number[]): Promise<Set<number>> {
  const open = new Set<number>();
  for (let i = 0; i < ids.length; i += 1000) {
    const batch = ids.slice(i, i + 1000);
    const filters = and(leaf("crustdata_person_id", "in", batch), leaf("professional_network.open_to_cards", "in", ["CAREER_INTEREST"]));
    const { profiles } = await searchPeople({ filters, fields: ["crustdata_person_id"] }, batch.length);
    for (const p of profiles) open.add(p.crustdata_person_id);
  }
  return open;
}

// ---------------------------------------------------------------------------
// Contacts. Enabled per account; self-serve keys do not have it. 25 profile URLs per request, 15 requests a minute.
// ---------------------------------------------------------------------------

export type ContactField = "contact.personal_emails" | "contact.business_emails" | "contact.phone_numbers";
export type Email = { email?: string; status?: string };
export type ContactResult = {
  matched_on?: string;
  match_status?: "matched" | "not_found" | "redacted" | string;
  matches?: Array<{ person_data?: { contact?: { personal_emails?: Email[]; business_emails?: Email[]; phone_numbers?: string[] } } }>;
};

/** `/person/contact/enrich` bills per contact type found (no base credit); `/person/enrich` adds 1 base credit per person. */
export async function enrichContacts(path: "/person/contact/enrich" | "/person/enrich", urls: string[], fields: ContactField[]): Promise<ContactResult[]> {
  const r = await request<ContactResult[]>("POST", path, { professional_network_profile_urls: urls, fields: path === "/person/enrich" ? ["basic_profile.name", ...fields] : fields });
  return Array.isArray(r) ? r : [];
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
