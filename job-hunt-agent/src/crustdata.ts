/**
 * Crustdata API client: the only file that talks to Crustdata. Plain REST, no SDK, so it reads as documentation.
 *
 *   POST /job/search                     jobs by title, place and date, with description and company basics
 *                                        0.03 per job returned; a count with limit 0 is free
 *   POST /company/search                 headcount growth for the companies on the shortlist
 *                                        0.03 per company + 0.2 for the headcount group
 *   POST /person/search                  recruiter, hiring manager, team and alumni at one company
 *                                        0.03 per person + 0.1 experience filter + 0.1 experience
 *                                        returned; alumni also 0.1 + 0.1 for education
 *   GET  /account/endpoints              your account's own prices, free
 *   POST /person/search/autocomplete     how a school is spelled on profiles, free
 *   POST /person/contact/enrich          work emails, only with --emails (enabled per account)
 *   GET  /account/credits                credit balance, free
 *
 * Prices are list prices (docs.crustdata.com/general/pricing); some plans include the premium groups. The run
 * reads your own prices from GET /account/endpoints for its estimate. Docs: https://docs.crustdata.com
 */

import { config } from "./config.js";

const BASE_URL = "https://api.crustdata.com";
const API_VERSION = "2025-11-01";

/** Credits this process has spent, summed from the x-credits-used header of every response. */
export const spend = { credits: 0 };
/** Rows returned by each paid search, for "what this run costs at list price" (plans can include premium groups). */
export const usage = { job: 0, company: 0, person: 0, alumni: 0, email: 0 };
/**
 * A ceiling for this process: once spend passes it, the next paid call is not sent. A run sets it a little above
 * its worst-case estimate, so prices higher than expected stop the run instead of draining the account.
 */
export const budget = { limit: Infinity };
export const fmtCredits = (n: number): string => String(Math.round(n * 100) / 100);

/** Space between two calls to the same endpoint, under its published per-minute limit. Tests turn it off. */
export const pacing = { on: true };
const MIN_GAP_MS: Record<string, number> = {
  "/job/search": 2_100,                  // 30 a minute
  "/company/search": 2_100,              // 30 a minute
  "/person/search": 2_100,               // 30 a minute
  "/person/search/autocomplete": 1_400,  // 45 a minute
  "/person/contact/enrich": 4_100,       // 15 a minute
};
const lastCall = new Map<string, number>();

export class CrustdataError extends Error {
  constructor(public status: number, message: string, public apiMessage = "") { super(message); }
}

/** The run went past its spend ceiling: always stops the whole run, never skipped as one failed search. */
export class BudgetError extends CrustdataError {}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A plain next step for each kind of failure, instead of a stack trace. */
function explainStatus(status: number, method: string, path: string, apiMessage: string): string {
  const said = apiMessage ? `: ${apiMessage}` : "";
  if (status === 401) return "Crustdata rejected the API key (401). Copy it again from https://app.crustdata.com and run npm run setup. If CRUSTDATA_API_KEY is also set in your shell, update or unset it there too (the shell wins over .env).";
  if (status === 402 || /insufficient credits|out of credits/i.test(apiMessage)) return `Your Crustdata account is out of credits (${status}). Top up at https://app.crustdata.com, then run again. Everything already fetched is saved and costs nothing again.`;
  if (status === 403) return `Crustdata refused ${method} ${path} for this key (403)${said}`;
  if (status === 429) return "Crustdata is still rate limiting this key (429) after waiting. Wait a minute and run again; what was fetched is saved.";
  if (status >= 500) return `Crustdata had a server error on ${method} ${path} (${status}). Run again in a minute; what was fetched is saved and costs nothing again.`;
  return `Crustdata could not run ${method} ${path} (${status})${said}`;
}

/**
 * One request, paced under the endpoint's rate limit, with up to two retries on 429 (waiting until the window
 * resets), 502 and 503 that say nothing was charged, and connections that never opened. Searches are billed, so a
 * timeout or another 5xx is not retried (it may have been billed) and the message says so.
 */
async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const key = config.crustdataApiKey;
  const billed = method === "POST" && !path.endsWith("/autocomplete");
  // Fails closed: a ceiling that is not a number stops paid calls too. Free counts (limit 0) always pass.
  const free = (body as { limit?: number } | undefined)?.limit === 0;
  if (billed && !free && !(spend.credits <= budget.limit)) {
    throw new BudgetError(0, `Stopped: this run has spent ${fmtCredits(spend.credits)} credits, more than its estimate allows (${fmtCredits(budget.limit)}). Your account may be charged more than the prices the estimate used; check GET /account/endpoints or app.crustdata.com, then run again with a smaller --top or --scan. What was fetched is saved.`);
  }
  for (let attempt = 0; ; attempt++) {
    const gap = MIN_GAP_MS[path];
    if (pacing.on && gap) {
      const slot = Math.max(Date.now(), (lastCall.get(path) ?? 0) + gap);
      lastCall.set(path, slot);
      if (slot > Date.now()) await sleep(slot - Date.now());
    } else lastCall.set(path, Date.now());
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
      throw new CrustdataError(0, `Could not reach Crustdata (${method} ${path}): ${(err as Error).message}.${billed && !neverSent ? " The request may have been billed." : ""} Check your connection and run again; what was fetched is saved.`);
    }
    const header = res.headers.get("x-credits-used");
    spend.credits += Number(header ?? 0) || 0;

    // A 502/503 from a proxy carries no x-credits-used header at all; only an explicit 0 proves nothing was charged.
    const retryable = res.status === 429 || ((res.status === 502 || res.status === 503) && (!billed || header === "0")) || (!billed && res.status >= 500);
    if (retryable && attempt < 2) {
      // x-ratelimit-reset is the number of seconds until the per-minute window resets.
      const wait = Number(res.headers.get("retry-after")) || Number(res.headers.get("x-ratelimit-reset")) || 2 * (attempt + 1);
      if (pacing.on) await sleep(Math.min(wait + 1, 61) * 1000);
      continue;
    }
    const text = await res.text();
    let json: any = null;
    let unreadable = false;
    try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; unreadable = true; }
    if (res.ok && unreadable) throw new CrustdataError(res.status, `Crustdata sent an answer to ${method} ${path} that is not JSON (a proxy or network page?). Run again in a minute.`);
    if (!res.ok) {
      const apiMessage = String(json?.error?.message ?? json?.message ?? res.statusText ?? "");
      throw new CrustdataError(res.status, explainStatus(res.status, method, path, apiMessage), apiMessage);
    }
    return json as T;
  }
}

// ---------------------------------------------------------------------------
// Shapes, as the live API returned them on 2026-10-28 (only the fields this tool reads)
// ---------------------------------------------------------------------------

export type RawJob = {
  crustdata_job_id?: number | string;
  job_details?: {
    title?: string | null; url?: string | null; category?: string | null; workplace_type?: string | null;
    employment_type?: string | null; source?: string | null;
  } | null;
  location?: { raw?: string | null; city?: string | null; state?: string | null; country?: string | null } | null;
  metadata?: { date_added?: string | null } | null;
  content?: { description?: string | null } | null;
  company?: {
    basic_info?: { crustdata_company_id?: number | null; name?: string | null; primary_domain?: string | null; industries?: string[] | null } | null;
    headcount?: { total?: number | null } | null;
    funding?: { last_fundraise_date?: string | null; last_round_type?: string | null; total_investment_usd?: number | null } | null;
  } | null;
};

export type RawCompany = {
  crustdata_company_id?: number;
  basic_info?: { name?: string | null; primary_domain?: string | null } | null;
  headcount?: {
    total?: number | null;
    growth_percent?: Partial<Record<"1m" | "3m" | "6m" | "12m", number | null>> | null;
  } | null;
  funding?: {
    last_round_type?: string | null; last_fundraise_date?: string | null; last_round_amount_usd?: number | null;
    total_investment_usd?: number | null;
  } | null;
};

export type RawRole = { title?: string | null; crustdata_company_id?: number | null; start_date?: string | null };
export type RawPerson = {
  crustdata_person_id?: number;
  fit?: string | null;
  basic_profile?: { name?: string | null; headline?: string | null; location?: { full_location?: string | null } | null } | null;
  experience?: { employment_details?: { current?: RawRole[] | null } | null } | null;
  education?: { schools?: Array<{ school?: string | null; end_year?: number | null }> | null } | null;
  social_handles?: { professional_network_identifier?: { profile_url?: string | null } | null } | null;
};

/** A list from an answer: only the objects in it, whatever shape came back (a null, a single object, a string). */
export const rows = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []).filter((x): x is T => Boolean(x) && typeof x === "object" && !Array.isArray(x));

export type Filter = { field: string; type: string; value: unknown } | { op: "and" | "or"; conditions: Filter[] };

// ---------------------------------------------------------------------------
// Jobs. 0.03 per job returned, 100 per page at most, 30 calls a minute.
// ---------------------------------------------------------------------------

/** What is asked for on every job: enough to score it and to name the company, nothing more. */
export const JOB_FIELDS = [
  "crustdata_job_id", "job_details.title", "job_details.url", "job_details.category", "job_details.workplace_type",
  "job_details.employment_type", "job_details.source", "location.raw", "location.city", "location.state",
  "location.country", "metadata.date_added", "content.description",
  "company.basic_info.crustdata_company_id", "company.basic_info.name", "company.basic_info.primary_domain",
  "company.basic_info.industries", "company.headcount.total", "company.funding.last_fundraise_date",
  "company.funding.last_round_type", "company.funding.total_investment_usd",
];

/** How many jobs match, for free (limit 0 with a count aggregation). */
export async function countJobs(filters: Filter): Promise<number> {
  const r = await request<{ total_count?: number }>("POST", "/job/search", { filters, limit: 0, aggregations: [{ type: "count" }] });
  const n = Number(r?.total_count ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The newest `max` jobs matching the filters, page by page. */
export async function searchJobs(filters: Filter, max: number, onPage?: (n: number) => void): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  let cursor: string | undefined;
  do {
    const page = await request<{ job_listings?: RawJob[]; next_cursor?: string | null }>("POST", "/job/search", {
      filters, sorts: [{ field: "metadata.date_added", order: "desc" }], fields: JOB_FIELDS,
      limit: Math.min(100, max - jobs.length), ...(cursor ? { cursor } : {}),
    });
    const got = rows<RawJob>(page?.job_listings);
    usage.job += got.length;
    jobs.push(...got);
    onPage?.(jobs.length);
    cursor = typeof page?.next_cursor === "string" ? page.next_cursor : undefined;
    if (!got.length) break;
  } while (cursor && jobs.length < max);
  return jobs;
}

/** One job by its posting URL or Crustdata job id. 0.03 when found, nothing when not. */
export async function findJob(by: { url?: string; id?: number }): Promise<RawJob | undefined> {
  const filters: Filter = by.id !== undefined
    ? { field: "crustdata_job_id", type: "=", value: by.id }
    : { field: "job_details.url", type: "=", value: by.url };
  const r = await request<{ job_listings?: RawJob[] }>("POST", "/job/search", { filters, fields: JOB_FIELDS, limit: 1 });
  const got = rows<RawJob>(r?.job_listings)[0];
  if (got) usage.job++;
  return got;
}

// ---------------------------------------------------------------------------
// Companies. 0.23 per company at list price (0.03 base + 0.2 headcount group), by id, up to 100 a call.
// ---------------------------------------------------------------------------

/** Headcount only: the last round and total raised already come with every job row, for free. */
const COMPANY_FIELDS = ["crustdata_company_id", "basic_info.name", "basic_info.primary_domain", "headcount"];

export async function companiesByIds(ids: number[]): Promise<RawCompany[]> {
  const out: RawCompany[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const r = await request<{ companies?: RawCompany[] }>("POST", "/company/search", {
      filters: { field: "crustdata_company_id", type: "in", value: batch }, fields: COMPANY_FIELDS, limit: batch.length,
    });
    const got = rows<RawCompany>(r?.companies);
    usage.company += got.length;
    out.push(...got);
  }
  return out;
}

/** A company by its website, for `job --company acme.com` when the posting is not in the index. */
export async function companyByDomain(domain: string): Promise<RawCompany | undefined> {
  const r = await request<{ companies?: RawCompany[] }>("POST", "/company/search", {
    filters: { field: "basic_info.primary_domain", type: "=", value: domain }, fields: COMPANY_FIELDS, limit: 1,
  });
  const got = rows<RawCompany>(r?.companies)[0];
  if (got) usage.company++;
  return got;
}

// ---------------------------------------------------------------------------
// People at one company. 0.23 per person at list price (0.43 with education), 30 calls a minute.
// ---------------------------------------------------------------------------

/**
 * What a people search returns. Experience (0.1) is needed to read the person's title at this company (people
 * hold several current roles); education (0.1) only for alumni, to show the school and year.
 */
export const PERSON_FIELDS = [
  "crustdata_person_id", "fit", "basic_profile.name", "basic_profile.location.full_location",
  "experience.employment_details.current.title", "experience.employment_details.current.crustdata_company_id",
  "experience.employment_details.current.start_date", "social_handles.professional_network_identifier.profile_url",
];
export const ALUMNI_FIELDS = [...PERSON_FIELDS, "education.schools.school", "education.schools.end_year"];

/**
 * People who work at the company now, ranked by how well they fit `query` (for example "technical recruiter hiring
 * software engineers"). The top-level `mode: "exact"` keeps the filters hard: without it the ranked query also
 * brings in people from other companies.
 */
export async function peopleAt(companyId: number, query: string, limit: number, extra?: Filter, withEducation = false): Promise<RawPerson[]> {
  const company: Filter = { field: "experience.employment_details.current.company_id", type: "=", value: companyId };
  const r = await request<{ profiles?: RawPerson[] }>("POST", "/person/search", {
    search: { query, mode: "hybrid" },
    mode: "exact",
    filters: extra ? { op: "and", conditions: [company, extra] } : company,
    fields: withEducation ? ALUMNI_FIELDS : PERSON_FIELDS,
    limit,
  });
  const got = rows<RawPerson>(r?.profiles);
  if (withEducation) usage.alumni += got.length; else usage.person += got.length;
  return got;
}

/** How a school is spelled on profiles ("UC Berkeley" also lives as "University of California, Berkeley"). Free. */
export async function schoolSpellings(query: string): Promise<string[]> {
  const r = await request<{ suggestions?: Array<{ value?: string }> }>("POST", "/person/search/autocomplete", {
    field: "education.schools.school", query, limit: 10,
  });
  return rows<{ value?: unknown }>(r?.suggestions).map(s => (typeof s.value === "string" ? s.value : "")).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Work emails, only with --emails. 1 credit per person matched, even when the only email is at a former employer. Enabled per account; self-serve keys get 403.
// ---------------------------------------------------------------------------

export type ContactRow = {
  matched_on?: string;
  matches?: Array<{ person_data?: { contact?: { business_emails?: Array<{ email?: string; status?: string; crustdata_company_id?: number | null }> | null } | null } }>;
};

export async function workEmails(profileUrls: string[]): Promise<ContactRow[]> {
  const out: ContactRow[] = [];
  for (let i = 0; i < profileUrls.length; i += 25) {
    const r = await request<ContactRow[]>("POST", "/person/contact/enrich", {
      professional_network_profile_urls: profileUrls.slice(i, i + 25), fields: ["contact.business_emails"],
    });
    const got = rows<ContactRow>(r);
    usage.email += got.filter(x => (x.matches ?? []).length).length;
    out.push(...got);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Account (free)
// ---------------------------------------------------------------------------

export async function creditBalance(): Promise<number | undefined> {
  const r = await request<{ account?: { credits?: number } }>("GET", "/account/credits");
  return r?.account?.credits;
}

export type Endpoint = {
  path: string; status?: string; base_credits?: number;
  premium_fields?: Array<{ field: string; credits: number }>; premium_filters?: Array<{ field: string; credits: number }>;
};

/** Credits per row for what this agent asks for. LIST is the price list; `pricesFrom` reads your account's. */
export type Prices = { job: number; company: number; person: number; alumni: number; email: number };
export const LIST_PRICES: Prices = { job: 0.03, company: 0.23, person: 0.23, alumni: 0.43, email: 1 };

/** What the rows fetched since `from` cost at list price. */
export function listCost(from: typeof usage = { job: 0, company: 0, person: 0, alumni: 0, email: 0 }): number {
  const d = (k: keyof typeof usage) => usage[k] - from[k];
  return Math.round((d("job") * LIST_PRICES.job + d("company") * LIST_PRICES.company + d("person") * LIST_PRICES.person + d("alumni") * LIST_PRICES.alumni + d("email") * LIST_PRICES.email) * 100) / 100;
}

/** A price, or undefined when the answer holds something other than a plain non-negative number. */
const price = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

export function pricesFrom(endpoints: Endpoint[]): Prices {
  const ep = (p: string) => endpoints.find(e => e && e.path === p);
  const base = (p: string, d: number) => price(ep(p)?.base_credits) ?? d;
  // Anything odd (no list, a group not priced as a number) falls back to the list price, never to 0.
  const extra = (p: string, kind: "premium_fields" | "premium_filters", group: string, d: number) => {
    const e = ep(p);
    const list = e?.[kind];
    if (!e || !Array.isArray(list)) return d;
    const hit = list.find(x => x && typeof x.field === "string" && (x.field === group || x.field.split(".")[0] === group));
    return hit ? price(hit.credits) ?? d : 0;
  };
  const person = base("/person/search", 0.03) + extra("/person/search", "premium_filters", "experience", 0.1) + extra("/person/search", "premium_fields", "experience", 0.1);
  return {
    job: base("/job/search", 0.03),
    company: base("/company/search", 0.03) + extra("/company/search", "premium_fields", "headcount", 0.2),
    person,
    alumni: person + extra("/person/search", "premium_filters", "education", 0.1) + extra("/person/search", "premium_fields", "education", 0.1),
    email: extra("/person/contact/enrich", "premium_fields", "contact.business_emails", 1) || 1,
  };
}

/** What this key can use. Free. */
export async function accountEndpoints(): Promise<Endpoint[]> {
  const r = await request<Endpoint[] | { endpoints?: Endpoint[] }>("GET", "/account/endpoints");
  return rows<Endpoint>(Array.isArray(r) ? r : r?.endpoints);
}
