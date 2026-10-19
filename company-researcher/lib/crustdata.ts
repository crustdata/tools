// A small client for the Crustdata endpoints this app uses. Plain fetch, no SDK, so it reads as documentation.
//   POST /company/identify   resolve a domain to a Crustdata company id (free)
//   POST /company/enrich     the full company profile, one call (2 credits, +2 tech stack, +5 recent posts)
//   POST /job/search         postings by title and the newest postings (aggregations free, 0.03 per row)
//   GET  /account/endpoints  which field groups your key can read (free)
// Docs: https://docs.crustdata.com/company-docs/enrichment/reference

import { AsyncLocalStorage } from "node:async_hooks";

const BASE = "https://api.crustdata.com";
const API_VERSION = "2025-11-01";

export class CrustdataError extends Error {
  constructor(public status: number, public path: string, message: string) {
    super(`Crustdata ${path} failed (${status}): ${message}`);
  }
}

export type CallResult<T> = { data: T; credits: number };

// Which key a call uses: the visitor's own key when they brought one (set per request with withApiKey), otherwise
// the server's CRUSTDATA_API_KEY. AsyncLocalStorage carries it through every call a request makes, so the
// research code never has to pass it around.
const keyStore = new AsyncLocalStorage<string>();

export class MissingKeyError extends Error {}

export function withApiKey<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  return key ? keyStore.run(key, fn) : fn();
}

function apiKey(): string {
  const key = keyStore.getStore() ?? process.env.CRUSTDATA_API_KEY;
  if (!key) throw new MissingKeyError("Add your Crustdata API key to run a research. Get one at https://crustdata.com");
  return key;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Retries a 429 or 5xx twice (after 0.5s, then 1.5s). Anything else fails straight away.
export async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<CallResult<T>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce<T>(method, path, body);
    } catch (err) {
      const retryable = err instanceof CrustdataError && (err.status === 429 || err.status >= 500);
      if (!retryable || attempt >= 2) throw err;
      await sleep(attempt === 0 ? 500 : 1500);
    }
  }
}

async function callOnce<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<CallResult<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      "x-api-version": API_VERSION,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const credits = Number(res.headers.get("x-credits-used") ?? 0) || 0;
  if (process.env.LOG_CREDITS === "true" && credits > 0) console.error(`  credits used: ${credits} (${method} ${path})`);
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? (text.startsWith("<") ? res.statusText : text) ?? res.statusText;
    throw new CrustdataError(res.status, path, String(msg).slice(0, 500));
  }
  return { data: json as T, credits };
}

// ---------- identify ----------

export type IdentifyMatch = {
  confidence_score: number;
  company_data: { crustdata_company_id: number; basic_info?: { name?: string; primary_domain?: string } };
};

// Look a company up by domain ("stripe.com") or by name ("Stripe"). Identify is fuzzy: take the highest confidence
// match, and among equal matches (common with names) the largest company that has a website.
export async function identifyCompany(query: { domain: string } | { name: string }) {
  const body = "domain" in query ? { domains: [query.domain] } : { names: [query.name] };
  const r = await call<Array<{ matched_on: string; matches: IdentifyMatch[] }>>("POST", "/company/identify", body);
  const matches = r.data?.[0]?.matches ?? [];
  const size = (m: IdentifyMatch) => ((m.company_data as any)?.headcount?.total ?? 0) + (m.company_data.basic_info?.primary_domain ? 1e9 : 0);
  const best = [...matches].sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0) || size(b) - size(a))[0];
  return { match: best ?? null, credits: r.credits };
}

// ---------- enrich ----------

export const ENRICH_GROUPS = [
  "basic_info", "headcount", "funding", "locations", "taxonomy", "revenue", "hiring", "followers",
  "web_traffic", "employee_reviews", "people", "news", "competitors", "social_profiles",
] as const;
// Billed add-ons: technographics +2 credits, social_posts +5 credits. Skipped in lite mode.
export const ADDON_GROUPS = ["technographics", "social_posts"] as const;

// `fields` is a whitelist. A group the key is not entitled to fails the whole call (403, or 400 "Invalid fields: x")
// naming the group, so drop exactly the named groups and retry. The dropped groups are reported as "not on this plan".
export async function enrichCompany(companyId: number, groups: string[]) {
  let fields = [...groups];
  const unavailable: string[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await call<any[]>("POST", "/company/enrich", { crustdata_company_ids: [companyId], exact_match: true, fields });
      const cd = r.data?.[0]?.matches?.[0]?.company_data ?? null;
      return { companyData: cd, credits: r.credits, unavailable };
    } catch (err) {
      if (!(err instanceof CrustdataError) || (err.status !== 403 && err.status !== 400)) throw err;
      const named = fields.filter(f => new RegExp(`\\b${f}\\b`).test(err.message));
      if (!named.length || named.length === fields.length) throw err;
      unavailable.push(...named);
      fields = fields.filter(f => !named.includes(f));
    }
  }
  throw new Error("Crustdata /company/enrich kept rejecting field groups");
}

// ---------- job search ----------

export type JobListing = {
  crustdata_job_id: number;
  job_details?: { title?: string; category?: string; url?: string; workplace_type?: string; employment_type?: string };
  location?: { raw?: string; city?: string | null; country?: string | null };
  metadata?: { date_added?: string; date_updated?: string };
};

type JobSearchResponse = {
  job_listings: JobListing[];
  total_count?: number;
  aggregations?: Array<{ type: string; field?: string | null; value?: number; buckets?: Array<{ key: string; count: number }> }>;
};

const byCompany = (companyId: number) => ({ field: "company.basic_info.company_id", type: "=", value: companyId });
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// Three calls in parallel. The two aggregations return no rows, so they cost nothing; the newest 15 cost 0.03 each.
export async function searchJobs(companyId: number, now = new Date()) {
  const d90 = isoDay(new Date(now.getTime() - 90 * 86400_000));
  const d180 = isoDay(new Date(now.getTime() - 180 * 86400_000));

  const [recent, previous, newest] = await Promise.all([
    call<JobSearchResponse>("POST", "/job/search", {
      filters: { op: "and", conditions: [byCompany(companyId), { field: "metadata.date_added", type: "=>", value: d90 }] },
      aggregations: [{ type: "group_by", field: "job_details.title", agg: "count", size: 200 }],
      limit: 0,
    }),
    call<JobSearchResponse>("POST", "/job/search", {
      filters: {
        op: "and",
        conditions: [
          byCompany(companyId),
          { field: "metadata.date_added", type: "=>", value: d180 },
          { field: "metadata.date_added", type: "<", value: d90 },
        ],
      },
      aggregations: [{ type: "count" }],
      limit: 0,
    }),
    call<JobSearchResponse>("POST", "/job/search", {
      filters: { op: "and", conditions: [byCompany(companyId)] },
      sorts: [{ field: "metadata.date_added", order: "desc" }],
      fields: ["crustdata_job_id", "job_details", "location", "metadata"],
      limit: 15,
    }),
  ]);

  return {
    recent: recent.data,
    previous: previous.data,
    newest: newest.data,
    window: { from90: d90, from180: d180 },
    credits: recent.credits + previous.credits + newest.credits,
  };
}

// ---------- account ----------

export async function enrichEntitlements() {
  const r = await call<any>("GET", "/account/endpoints?path=/company/enrich");
  const ep = r.data?.endpoints?.[0];
  const enabled = new Set<string>((ep?.fields?.enabled ?? []).map((f: string) => f.split(".")[0]));
  return {
    status: ep?.status as string | undefined,
    rateLimitRpm: ep?.effective_rate_limit_rpm as number | undefined,
    groups: [...ENRICH_GROUPS, ...ADDON_GROUPS].map(g => ({ group: g, enabled: enabled.has(g) })),
  };
}
