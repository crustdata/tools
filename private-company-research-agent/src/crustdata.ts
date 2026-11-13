/**
 * Crustdata API client: the only file that talks to Crustdata. Plain REST, no SDK, so it reads as documentation.
 *
 *   POST /company/identify   domain to company (free)
 *   POST /company/enrich     the company record: headcount, funding, traffic, people, news, peers ... 2 credits
 *   POST /person/search      former staff and senior role changes. 0.03 + 0.1 experience filter + 0.1 experience
 *                            returned = 0.23 credits per person at list price
 *   POST /job/search         job postings counted by title and category (limit 0 with group_by: free); when
 *                            there are none, the newest posting on record (0.03 credits)
 *   POST /company/search     peers by id with headcount, funding, followers. 0.03 + 0.2 x 3 = 0.63 per peer
 *   GET  /account/credits    credit balance (free)
 *   GET  /account/endpoints  what this key can use and at what price (free)
 *
 * Docs: https://docs.crustdata.com (add .md to any page for markdown).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";
import type { CompanyData, JobCounts, PeerData, PeopleResult, SearchPerson } from "./types.js";

const BASE_URL = "https://api.crustdata.com";
const API_VERSION = "2025-11-01";

/** Credits per company, kept apart even when the calls for several companies interleave. */
export const meter = new AsyncLocalStorage<{ credits: number }>();
/** Credits this process has spent, summed from the x-credits-used header of every response. */
export const spend = { credits: 0 };

/** Space between two calls to the same endpoint, under its published per-minute limit. Tests turn it off. */
export const pacing = { on: true };
const MIN_GAP_MS: Record<string, number> = {
  "/company/enrich": 4_100,   // 15 a minute
  "/company/identify": 2_100, // 30 a minute
  "/company/search": 2_100,   // 30 a minute
  "/person/search": 2_100,    // 30 a minute
  "/job/search": 2_100,       // 30 a minute
};
const lastCall = new Map<string, number>();

export class CrustdataError extends Error {
  constructor(public status: number, message: string, public apiMessage = "") { super(message); }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** retry-after as seconds: a number of seconds, or an HTTP date. */
export function retryAfterSeconds(v: string | null, now = Date.now()): number {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : 0;
}

/** A plain next step for each kind of failure, instead of a stack trace. */
export function explainStatus(status: number, method: string, path: string, apiMessage: string): string {
  const said = apiMessage ? `: ${apiMessage.slice(0, 300)}` : "";
  if (status === 401) return "Crustdata rejected the API key (401). Copy it again from https://app.crustdata.com and run npm run setup. If CRUSTDATA_API_KEY is also set in your shell, update or unset it there too (the shell wins over .env).";
  if (status === 402 || /insufficient credits|out of credits|not enough credits/i.test(apiMessage)) return `Your Crustdata account is out of credits (${status}). Top up at https://app.crustdata.com, then run again: companies already researched are saved and cost nothing again.`;
  if (status === 403) return `Crustdata refused ${method} ${path} for this key (403)${said}`;
  if (status === 429) return "Crustdata is still rate limiting this key (429) after waiting. Wait a minute and run again.";
  if (status >= 500) return `Crustdata had a server error on ${method} ${path} (${status}). Run again in a minute; companies already researched are saved and cost nothing again.`;
  return `Crustdata could not run ${method} ${path} (${status})${said}`;
}

/**
 * One request, paced under the endpoint's rate limit, with up to two retries on 429 (waiting until the window
 * resets), on 502/503 answers that say nothing was charged, and on connections that never opened. A timeout or a
 * reset connection on a billed call is not retried (it may have been billed) and the message says so.
 */
async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const key = config.crustdataApiKey;
  const billed = method === "POST" && path !== "/company/identify";
  for (let attempt = 0; ; attempt++) {
    const gap = MIN_GAP_MS[path];
    if (pacing.on && gap) {
      const slot = Math.max(Date.now(), (lastCall.get(path) ?? 0) + gap);
      lastCall.set(path, slot);
      if (slot > Date.now()) await sleep(slot - Date.now());
    }
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
      const neverSent = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT/.test(code);
      if (attempt < 2 && (!billed || neverSent)) { if (pacing.on) await sleep(2000 * (attempt + 1)); continue; }
      throw new CrustdataError(0, `Could not reach Crustdata (${method} ${path}): ${(err as Error).message}.${billed && !neverSent ? " The request may have been billed." : ""} Check your connection and run again; companies already researched are saved.`);
    }
    const header = res.headers.get("x-credits-used");
    const charged = Number(header ?? 0) || 0;
    spend.credits += charged;
    const run = meter.getStore();
    if (run) run.credits += charged;

    // Only an explicit x-credits-used: 0 proves a 502/503 on a billed call charged nothing.
    const retryable = res.status === 429 || ((res.status === 502 || res.status === 503) && (!billed || header === "0")) || (!billed && res.status >= 500);
    if (retryable && attempt < 2) {
      const wait = retryAfterSeconds(res.headers.get("retry-after")) || Number(res.headers.get("x-ratelimit-reset")) || 2 * (attempt + 1);
      if (pacing.on) await sleep(Math.min(wait + 1, 61) * 1000);
      continue;
    }
    const text = await res.text();
    let json: any = null;
    let unreadable = false;
    try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; unreadable = true; }
    if (res.ok && unreadable) throw new CrustdataError(res.status, `Crustdata sent an answer to ${method} ${path} that is not JSON (a proxy or network page?).${charged ? ` It reported ${charged} credits used.` : ""} Run again in a minute.`);
    if (!res.ok) {
      const apiMessage = String(json?.error?.message ?? json?.message ?? res.statusText ?? "");
      throw new CrustdataError(res.status, explainStatus(res.status, method, path, apiMessage), apiMessage);
    }
    return json as T;
  }
}

/** Errors that should stop the whole run rather than one section: bad key, no credits, rate limit, outage. */
export const isFatal = (err: unknown): boolean =>
  err instanceof CrustdataError && (err.status === 401 || err.status === 402 || err.status === 429 || err.status === 0 ||
    /credit|payment|billing|quota/i.test(err.apiMessage));

// ---------------------------------------------------------------------------
// Company identify (free). Accepts bare domains and full URLs.
// ---------------------------------------------------------------------------

export type IdentifyMatch = { confidence_score?: number; company_data?: CompanyData };
export type IdentifyRow = { matched_on?: string; match_type?: string; matches?: IdentifyMatch[] };

/** One row per domain, in request order. 25 domains per call. */
export async function identifyDomains(domains: string[]): Promise<IdentifyRow[]> {
  const out: IdentifyRow[] = [];
  for (let i = 0; i < domains.length; i += 25) {
    const batch = domains.slice(i, i + 25);
    const r = await request<IdentifyRow[]>("POST", "/company/identify", { domains: batch });
    const rows = Array.isArray(r) ? r : [];
    // Keep request order even if the answer is shorter (one row per asked domain).
    batch.forEach((_, j) => out.push(rows[j] ?? { matched_on: batch[j], matches: [] }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Company enrich. 2 credits per company with the groups below (technographics and social_posts would add more).
// ---------------------------------------------------------------------------

export const ENRICH_FIELDS = [
  "basic_info", "headcount", "funding", "followers", "web_traffic", "employee_reviews", "people",
  "news", "competitors", "seo", "public_launches", "taxonomy", "locations",
];

/** Field names from a 403 "Access denied to fields: a, b" or a 400 "Invalid fields: a". */
export function deniedFields(err: unknown): string[] {
  if (!(err instanceof CrustdataError) || (err.status !== 403 && err.status !== 400)) return [];
  const m = /(?:Access denied to fields|Invalid fields):\s*([\w.,\s]+)/i.exec(err.apiMessage);
  return m ? m[1].split(",").map(s => s.trim().split(/\s/)[0].replace(/\.$/, "")).filter(Boolean) : [];
}

/**
 * The full record for one company. A field group this key may not read fails the whole call; that group is dropped,
 * reported through `denied`, and the call is sent again without it.
 */
export async function enrichCompany(companyId: number): Promise<{ data?: CompanyData; denied: string[] }> {
  let fields = [...ENRICH_FIELDS];
  const denied: string[] = [];
  for (;;) {
    try {
      const r = await request<Array<{ matches?: Array<{ company_data?: CompanyData }> }>>("POST", "/company/enrich", { crustdata_company_ids: [companyId], fields });
      return { data: (Array.isArray(r) ? r[0]?.matches?.[0]?.company_data : undefined) ?? undefined, denied };
    } catch (err) {
      // The enrich docs answer an unknown company with 200 and no match, or with 404: both mean "no record".
      if (err instanceof CrustdataError && err.status === 404) return { data: undefined, denied };
      const drop = deniedFields(err).filter(f => fields.some(g => g === f || g.startsWith(`${f}.`) || f.startsWith(`${g}.`)));
      if (!drop.length) throw err;
      fields = fields.filter(g => !drop.some(f => g === f || f.startsWith(`${g}.`) || g.startsWith(`${f}.`)));
      denied.push(...drop);
      if (!fields.length) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Person search: former staff and senior role changes. 30 calls a minute.
// ---------------------------------------------------------------------------

export const PERSON_FIELDS = [
  "crustdata_person_id", "basic_profile.name", "basic_profile.current_title",
  "social_handles.professional_network_identifier.profile_url", "experience.employment_details",
];
/** Seniority levels read for step-backs. "Strategic" is left out: live, it tags account reps and strategy roles. */
export const SENIOR_LEVELS = ["CXO", "Vice President", "Director", "Owner / Partner"];

const leaf = (field: string, type: string, value: unknown) => ({ field, type, value });

/** The filter for "a role at this company ended on or after `since`". Both conditions match the same role. */
function endedRole(companyId: number, since: string) {
  return [
    leaf("experience.employment_details.company_id", "=", companyId),
    leaf("experience.employment_details.end_date", "=>", since),
  ];
}

/**
 * People who left: a role at the company ended since `since` and they hold no current role there. Without the last
 * condition, promotions show up as departures (the old title ended, the person stayed).
 */
export async function searchDepartures(companyId: number, since: string, limit: number): Promise<PeopleResult> {
  const r = await request<{ profiles?: SearchPerson[]; total_count?: number }>("POST", "/person/search", {
    filters: { op: "and", conditions: [...endedRole(companyId, since), leaf("experience.employment_details.current.company_id", "!=", companyId)] },
    fields: PERSON_FIELDS,
    limit,
  });
  const people = r?.profiles ?? [];
  return { total: typeof r?.total_count === "number" ? r.total_count : people.length, people };
}

/**
 * Senior roles at the company that ended since `since`, whether or not the person stayed (a CTO who became an
 * advisor still works there). Seniority is matched on the same role as the company and the end date.
 */
export async function searchSeniorEnds(companyId: number, since: string, limit: number): Promise<PeopleResult> {
  const r = await request<{ profiles?: SearchPerson[]; total_count?: number }>("POST", "/person/search", {
    filters: { op: "and", conditions: [...endedRole(companyId, since), leaf("experience.employment_details.seniority_level", "in", SENIOR_LEVELS)] },
    fields: PERSON_FIELDS,
    limit,
  });
  const people = r?.profiles ?? [];
  return { total: typeof r?.total_count === "number" ? r.total_count : people.length, people };
}

// ---------------------------------------------------------------------------
// Job search: counts only, free (limit 0 with group_by).
// ---------------------------------------------------------------------------

type Bucket = { key?: string | number; count?: number };

/** Job postings the index added since `since`, counted by title and by category. */
export async function jobCounts(companyId: number, since: string): Promise<JobCounts> {
  const r = await request<{ total_count?: number | null; aggregations?: Array<{ field?: string; buckets?: Bucket[] }> }>("POST", "/job/search", {
    filters: { op: "and", conditions: [leaf("company.basic_info.company_id", "=", companyId), leaf("metadata.date_added", "=>", since)] },
    limit: 0,
    aggregations: [
      { type: "group_by", field: "job_details.title", agg: "count", size: 200 },
      { type: "group_by", field: "job_details.category", agg: "count", size: 50 },
    ],
  });
  const aggs = r?.aggregations ?? [];
  const by = (field: string) => aggs.find(a => a.field === field)?.buckets ?? [];
  const total = Number(r?.total_count) || 0;
  let newest: JobCounts["newest"];
  if (total === 0) {
    // None in the window: is the company not hiring, or is the index behind? The newest posting on record says which.
    const n = await request<{ total_count?: number | null; job_listings?: Array<{ job_details?: { title?: string }; metadata?: { date_added?: string } }> }>("POST", "/job/search", {
      filters: leaf("company.basic_info.company_id", "=", companyId),
      sorts: [{ field: "metadata.date_added", order: "desc" }],
      fields: ["job_details.title", "metadata.date_added"],
      limit: 1,
    });
    const j = n?.job_listings?.[0];
    newest = j ? { date: j.metadata?.date_added?.slice(0, 10) || undefined, title: j.job_details?.title?.trim() ?? "", on_record: Number(n?.total_count) || 1 } : null;
  }
  return {
    total,
    newest,
    titles: by("job_details.title").map(b => ({ title: String(b.key ?? "").trim(), count: Number(b.count) || 0 })).filter(t => t.title),
    categories: by("job_details.category").map(b => ({ category: String(b.key ?? "").trim(), count: Number(b.count) || 0 })).filter(c => c.category),
  };
}

// ---------------------------------------------------------------------------
// Company search: peers by id. 0.03 per company + 0.2 per premium group returned (headcount, funding, followers).
// ---------------------------------------------------------------------------

export const PEER_FIELDS = [
  "crustdata_company_id", "basic_info.name", "basic_info.primary_domain", "basic_info.year_founded", "basic_info.company_type",
  "headcount.total", "headcount.growth_percent", "headcount.growth_absolute",
  "funding.total_investment_usd", "funding.last_round_amount_usd", "funding.last_fundraise_date", "funding.last_round_type",
  "followers.count",
];

export async function peersById(ids: number[]): Promise<PeerData[]> {
  if (!ids.length) return [];
  const r = await request<{ companies?: PeerData[] }>("POST", "/company/search", {
    filters: leaf("crustdata_company_id", "in", ids),
    fields: PEER_FIELDS,
    limit: ids.length,
  });
  return r?.companies ?? [];
}

// ---------------------------------------------------------------------------
// Account (free)
// ---------------------------------------------------------------------------

export type Endpoint = { path: string; status?: string; base_credits?: number };

export async function accountEndpoints(): Promise<Endpoint[]> {
  const r = await request<Endpoint[] | { endpoints?: Endpoint[] }>("GET", "/account/endpoints");
  return Array.isArray(r) ? r : r?.endpoints ?? [];
}

export async function creditBalance(): Promise<number | undefined> {
  const r = await request<{ account?: { credits?: number } }>("GET", "/account/credits");
  return r?.account?.credits;
}
