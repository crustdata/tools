/**
 * Crustdata API client: the only file that talks to Crustdata.
 *
 *   GET    /account/credits                      credit balance (free)
 *   POST   /company/identify                     website or name -> company id (free)
 *   POST   /company/enrich                       headcount, funding, news for a company (2 credits)
 *   POST   /person/search                        founders and C-level at one company (0.03 credits per person)
 *   POST   /person/enrich                        a leader listed by profile URL in the portfolio (1 credit each)
 *   POST   /web/enrich/live                      Web Fetch: a careers page, to count open roles (1 credit per page)
 *   POST   /job/search                           job postings counted per company with `limit: 0` (free)
 *   POST   /watch/company                        company entity watch (5 credits per changed company)
 *   POST   /watch/person                         person entity watch on the leaders (5 credits per changed person)
 *   GET    /watch/{dataset}/{id}/runs[/{run}/summary]  what a watch caught, as a signed NDJSON download
 *
 * Docs: https://docs.crustdata.com (append .md to any page for markdown)
 */

import { config } from "./config.js";

const BASE_URL = "https://api.crustdata.com";
const API_VERSION = "2025-11-01";

export class CrustdataError extends Error {
  constructor(public status: number, public path: string, message: string) {
    super(`Crustdata ${path} failed (${status}): ${message}`);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Credits reported by the API for this process, summed from the `x-credits-used` header. */
export const creditsUsed = { total: 0 };

/** Smallest gap between two requests to the same endpoint, under its published per-minute limit. */
const MIN_GAP_MS: [RegExp, number][] = [
  [/^\/person\/enrich/, 4_100],
  [/^\/web\//, 6_100],
  [/^\/watch\//, 6_100],
  [/^\/company\/enrich/, 4_100],
  [/^\/person\/search/, 2_100],
  [/^\/job\/search/, 2_100],
  [/^\/company\/identify/, 2_100],
];
const lastCall = new Map<string, number>();
async function pace(path: string): Promise<void> {
  const rule = MIN_GAP_MS.find(([re]) => re.test(path));
  if (!rule) return;
  const key = rule[0].source;
  const wait = (lastCall.get(key) ?? 0) + rule[1] - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(key, Date.now());
}

/** One request, paced, retried on rate limits (429), server errors (5xx) and network errors, up to 6 attempts. */
async function request<T>(method: string, path: string, body?: unknown, { retry = true } = {}): Promise<T> {
  const key = config.crustdataApiKey; // throws a plain "not set" message before anything is sent
  for (let attempt = 1; ; attempt++) {
    await pace(path);
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-api-version": API_VERSION },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      if (!retry || attempt >= 6) throw new Error(`Could not reach Crustdata (${(err as Error).message}). Check your connection and try again.`);
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if ((res.status === 429 || (res.status >= 500 && retry)) && attempt < 6) {
      const wait = Math.max(retryAfterMs(res) ?? 0, 2 ** attempt * 1000);
      console.log(`  Crustdata answered ${res.status}; retrying in ${Math.ceil(wait / 1000)}s...`);
      await sleep(wait);
      continue;
    }

    const credits = Number(res.headers.get("x-credits-used") ?? 0);
    if (credits > 0) creditsUsed.total += credits;
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) throw new CrustdataError(res.status, `${method} ${path.split("?")[0]}`, json?.error?.message ?? json?.message ?? text ?? res.statusText);
    return json as T;
  }
}

function retryAfterMs(res: Response): number | undefined {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (retryAfter > 0) return Math.min(retryAfter * 1000, 120_000);
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (reset > 0) return Math.min(reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000, 120_000);
  return undefined;
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return { message: text }; }
}

/** Plain-words explanation of an API failure, with the next step. */
export function explain(err: unknown): string {
  if (err instanceof CrustdataError) {
    if (err.status === 401) return "Crustdata rejected the API key (401). Check CRUSTDATA_API_KEY in .env (or the repository secret on GitHub Actions), or run npm run setup.";
    if (err.status === 402) return "Your Crustdata account is out of credits (402). Top up at https://app.crustdata.com and run again.";
    if (err.status === 403) return `Your Crustdata plan does not include this endpoint (403): ${err.path}. Ask support@crustdata.com to enable it.`;
    if (err.status === 429) return "Crustdata rate limit reached (429) even after retries. Wait a minute and run again.";
    return err.message;
  }
  return (err as Error)?.message ?? String(err);
}

export async function getCreditBalance(): Promise<number | undefined> {
  const r = await request<{ account?: { credits?: number } }>("GET", "/account/credits");
  return r?.account?.credits;
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export type CompanyMatch = { id: number; name: string; domain?: string; employeeRange?: string; confidence: number };

/**
 * Resolves websites or names to Crustdata companies. Free. Each input gets its matches, best first (a website gives at
 * most one; a name can give up to 25, often several at full confidence: "Linear" matches three companies).
 */
export async function identifyCompanies(inputs: string[], by: "domains" | "names"): Promise<Record<string, CompanyMatch[]>> {
  const out: Record<string, CompanyMatch[]> = {};
  for (let i = 0; i < inputs.length; i += 25) {
    const batch = inputs.slice(i, i + 25);
    const rows = await request<any[]>("POST", "/company/identify", { [by]: batch });
    batch.forEach((input, j) => {
      const row = (rows ?? []).find(r => String(r?.matched_on ?? "").toLowerCase() === input.toLowerCase()) ?? rows?.[j];
      out[input] = (row?.matches ?? []).flatMap((m: any) => {
        const c = m?.company_data;
        if (!c?.crustdata_company_id) return [];
        return [{ id: c.crustdata_company_id, name: c.basic_info?.name ?? input, domain: c.basic_info?.primary_domain ?? undefined, employeeRange: c.basic_info?.employee_count_range ?? undefined, confidence: Number(m.confidence_score ?? 0) }];
      });
    });
  }
  return out;
}

/** Field groups read from a company record. The company watch delivers the same groups. */
export const COMPANY_FIELDS = ["basic_info", "headcount", "funding", "news"];

/** Full company records, 2 credits each, 10 per request. */
export async function enrichCompanies(ids: number[]): Promise<Record<number, any>> {
  const out: Record<number, any> = {};
  for (let i = 0; i < ids.length; i += 10) {
    const rows = await request<any[]>("POST", "/company/enrich", { crustdata_company_ids: ids.slice(i, i + 10), fields: COMPANY_FIELDS });
    for (const row of rows ?? []) {
      const c = row?.matches?.[0]?.company_data;
      if (c?.crustdata_company_id) out[c.crustdata_company_id] = c;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leaders
// ---------------------------------------------------------------------------

export type Condition = { field: string; type: string; value?: unknown } | { op: "and" | "or"; conditions: Condition[] };

/** Words that find founders and C-level in a title. The search also returns "Chief of Staff"; leaders.ts sorts that out. */
export const LEADER_TITLE_WORDS = ["founder", "chief", "CEO", "CTO", "COO", "CFO", "CPO", "CRO", "CMO", "president", "fondateur", "fundador", "gründer", "geschäftsführer", "PDG"];

export type FoundPerson = { personId?: number; name: string; title: string; profileUrl?: string; startDate?: string };

/**
 * Founders and C-level currently at one company. Our account was billed 0.03 credits per person returned; Crustdata's
 * pricing page lists 0.23 for a search that filters on and returns experience fields, so the estimates use that as
 * the worst case and the limit is kept small.
 */
export const LEADER_SEARCH_LIMIT = 12;
export const LEADER_PRICE_WORST = 0.23;
export async function searchLeaders(companyId: number, limit = LEADER_SEARCH_LIMIT): Promise<FoundPerson[]> {
  const r = await request<{ profiles?: any[] }>("POST", "/person/search", {
    filters: {
      op: "and",
      conditions: [
        { field: "experience.employment_details.current.company_id", type: "in", value: [companyId] },
        { op: "or", conditions: LEADER_TITLE_WORDS.map(w => ({ field: "experience.employment_details.current.title", type: "[.]", value: w })) },
      ],
    },
    fields: [
      "basic_profile.name",
      "basic_profile.current_title",
      "social_handles.professional_network_identifier.profile_url",
      "experience.employment_details.current.title",
      "experience.employment_details.current.crustdata_company_id",
      "experience.employment_details.current.start_date",
    ],
    limit,
  });
  return (r?.profiles ?? []).flatMap(p => {
    // The title held at this company, not a side role elsewhere.
    const role = (p?.experience?.employment_details?.current ?? []).find((x: any) => x?.crustdata_company_id === companyId);
    const title = role?.title ?? p?.basic_profile?.current_title;
    const name = p?.basic_profile?.name;
    if (!name || !title) return [];
    return [{ personId: p.crustdata_person_id, name: String(name), title: String(title), profileUrl: p?.social_handles?.professional_network_identifier?.profile_url ?? undefined, startDate: role?.start_date ?? undefined }];
  });
}

/** Name and current roles for people listed by profile URL, 1 credit each, 25 per request. Misses are free. */
export async function enrichPeople(urls: string[]): Promise<Record<string, { personId?: number; name?: string; current: { title?: string; name?: string; crustdata_company_id?: number; company_website_domain?: string }[] }>> {
  const out: Record<string, any> = {};
  for (let i = 0; i < urls.length; i += 25) {
    const batch = urls.slice(i, i + 25);
    const rows = await request<any[]>("POST", "/person/enrich", { professional_network_profile_urls: batch, fields: ["basic_profile", "experience"] });
    for (const [j, row] of (rows ?? []).entries()) {
      const p = row?.matches?.[0]?.person_data;
      const input = batch.find(u => u.toLowerCase().replace(/\/+$/, "") === String(row?.matched_on ?? "").toLowerCase().replace(/\/+$/, "")) ?? batch[j];
      if (!p || !input) continue;
      out[input] = { personId: p.crustdata_person_id, name: p.basic_profile?.name, current: p.experience?.employment_details?.current ?? [] };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hiring
// ---------------------------------------------------------------------------

export type FetchedPage = { url: string; success: boolean; content?: string | null; http_status?: number | null };

/** Same page: protocol, "www.", host case and a trailing slash do not matter. */
export function sameUrl(a: string, b: string): boolean {
  const n = (s: string) => s.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+(?=$|[?#])/, "").replace(/^[^/?#]+/, h => h.toLowerCase());
  return n(a) === n(b);
}

/** Fetches pages live, up to 10 per request (1 credit per page). */
export async function fetchPages(urls: string[]): Promise<FetchedPage[]> {
  const out: FetchedPage[] = [];
  for (let i = 0; i < urls.length; i += 10) {
    const batch = urls.slice(i, i + 10);
    const rows = await request<any[]>("POST", "/web/enrich/live", { urls: batch });
    // The response order may differ from the request order: match by URL only, never by position.
    for (const u of batch) {
      const row = (rows ?? []).find(r => typeof r?.url === "string" && sameUrl(r.url, u));
      out.push({ url: u, success: Boolean(row?.success), content: row?.content ?? null, http_status: row?.http_status ?? null });
    }
  }
  return out;
}

/** Job postings per company posted since a date, from the job index, in one free call (limit 0 with a group_by). */
export async function jobIndexCounts(companyIds: number[], since: string): Promise<Record<number, number>> {
  const out: Record<number, number> = Object.fromEntries(companyIds.map(id => [id, 0]));
  for (let i = 0; i < companyIds.length; i += 100) {
    const batch = companyIds.slice(i, i + 100);
    const r = await request<{ aggregations?: { buckets?: { key: number | string; count: number }[] }[] }>("POST", "/job/search", {
      filters: { op: "and", conditions: [{ field: "company.basic_info.company_id", type: "in", value: batch }, { field: "metadata.date_added", type: "=>", value: since }] },
      limit: 0,
      aggregations: [{ type: "group_by", field: "company.basic_info.company_id", agg: "count", size: batch.length }],
    });
    for (const b of r?.aggregations?.[0]?.buckets ?? []) if (Number(b.key) in out) out[Number(b.key)] = Number(b.count) || 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Watches
// ---------------------------------------------------------------------------

export type Dataset = "company" | "person";

const watchPath = (ds: Dataset, id?: number) => `/watch/${ds}${id ? `/${id}` : ""}`;

export type Watch = {
  id: number;
  dataset?: Dataset;
  status: string;
  fields?: string[] | null;
  notifications?: unknown[];
  entities?: { crustdata_company_ids?: number[]; professional_network_profile_urls?: string[] };
  track?: unknown;
  config?: { trigger?: { every_hours?: number }; max_results_per_run?: number; refresh_frequency_days?: number };
  created_at?: string;
  last_run_at?: string | null;
  credits_consumed?: number;
};

/** Daily runs at 06:00 UTC. Watches bill per change caught, not per run, so daily costs the same as weekly. */
const DAILY = { type: "interval", every_hours: 24 };
export const PREFERRED_HOUR = 6;

/** What fires the company watch: headcount, news, a new round, new investors, an acquisition, a status change. */
export const COMPANY_TRACK = {
  op: "or",
  conditions: [
    { field: "headcount.total", type: "changed" },
    // Keyed by URL, so the same article reposted is not billed again.
    { field: "news", type: "added", keys: ["article_url"] },
    { field: "funding.last_round_type", type: "changed" },
    { field: "funding.last_fundraise_date", type: "changed" },
    { field: "funding.investors", type: "added" },
    { field: "funding.acquisitions", type: "added" },
    { field: "funding.acquired_by", type: "added" },
    { field: "basic_info.status", type: "changed" },
  ],
};

/** What fires the person watch: a role ended, a role started, or the headline title changed. */
export const PERSON_TRACK = {
  op: "or",
  conditions: [
    // A role is identified by company and title together (nested entries are composite; flat entries would match on
    // either one alone and silence a CEO moving to another CEO role), with the company name as the fallback when the
    // company id is missing. A role re-listed with edits is not billed again.
    { field: "experience.employment_details.past", type: "added", keys: [["crustdata_company_id", "title"], ["name", "title"]] },
    { field: "experience.employment_details.current", type: "added", keys: [["crustdata_company_id", "title"], ["name", "title"]] },
    { field: "basic_profile.current_title", type: "changed" },
  ],
};
export const PERSON_FIELDS = ["basic_profile", "experience", "social_handles"];

/** Every watched company or leader can change in one run; link delivery allows up to 10,000 a run. */
const cap = (n: number) => Math.min(Math.max(n, 1), 10_000);
const companyConfig = (n: number) => ({ trigger: DAILY, preferred_hour: PREFERRED_HOUR, max_results_per_run: cap(n), payload_delivery_type: "link" });
const personConfig = (n: number, refreshDays: number) => ({ ...companyConfig(n), refresh_frequency_days: refreshDays });

/** Watch creates are never retried: a retry could make a second, billed watch. */
export const createCompanyWatch = (ids: number[]) =>
  request<Watch>("POST", watchPath("company"), { entities: { crustdata_company_ids: ids }, track: COMPANY_TRACK, fields: COMPANY_FIELDS, config: companyConfig(ids.length), notifications: [] }, { retry: false });

export const createPersonWatch = (urls: string[], refreshDays: number) =>
  request<Watch>("POST", watchPath("person"), { entities: { professional_network_profile_urls: urls }, track: PERSON_TRACK, fields: PERSON_FIELDS, config: personConfig(urls.length, refreshDays), notifications: [] }, { retry: false });

/** A new list in place. The config block is sent whole (the API validates it as one block). */
export const setCompanyEntities = (id: number, ids: number[]) =>
  request<Watch>("PATCH", watchPath("company", id), { entities: { crustdata_company_ids: ids }, config: companyConfig(ids.length) });
export const setPersonEntities = (id: number, urls: string[], refreshDays: number) =>
  request<Watch>("PATCH", watchPath("person", id), { entities: { professional_network_profile_urls: urls }, config: personConfig(urls.length, refreshDays) });

export const getWatch = (ds: Dataset, id: number) => request<Watch>("GET", watchPath(ds, id));
/** Active watches of one kind on the account (free), so import can reuse one instead of creating a duplicate. */
export async function listActiveWatches(ds: Dataset): Promise<Watch[]> {
  const page = await request<Watch[] | { watches?: Watch[] }>("GET", `${watchPath(ds)}?status=active&limit=100`);
  return Array.isArray(page) ? page : page?.watches ?? [];
}
export const setWatchStatus = (ds: Dataset, id: number, status: "active" | "paused") => request<Watch>("PATCH", watchPath(ds, id), { status });

export async function deleteWatch(ds: Dataset, id: number): Promise<void> {
  try { await request<void>("DELETE", watchPath(ds, id)); }
  catch (err) { if (!(err instanceof CrustdataError && err.status === 404)) throw err; } // already gone
}

export type Run = { id: number; started_at: string; completed_at?: string | null; status: string; new_records_count?: number | null; credits_deducted?: number | null; records_after_filter?: number | null };

export const listRuns = (ds: Dataset, id: number, limit = 20, cursor?: string) =>
  request<{ runs: Run[]; next_cursor?: string | null }>("GET", `${watchPath(ds, id)}/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);

export const getRunSummary = (ds: Dataset, id: number, runId: number) =>
  request<{ id: number; records_download?: { url?: string }; payload_delivery?: { url?: string }; notifications?: { payload?: { notifications?: any[] } }[] }>("GET", `${watchPath(ds, id)}/runs/${runId}/summary`);

/** Crustdata's own storage for run downloads. Nothing else is fetched. */
const DOWNLOAD_HOSTS = /^crustdata-batch-api-data\.s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com$/;
export const MAX_DOWNLOAD_BYTES = 50_000_000;

/** Downloads the NDJSON file a run summary points at: https, Crustdata's storage host only, no redirects, size-capped. */
export async function downloadRecords(url: string): Promise<any[]> {
  const u = new URL(url);
  const pathStyle = /^s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com$/.test(u.hostname) && u.pathname.startsWith("/crustdata-batch-api-data/");
  if (u.protocol !== "https:" || !(DOWNLOAD_HOSTS.test(u.hostname) || pathStyle)) throw new Error(`Refusing to download run records from ${u.hostname}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "error" });
  if (!res.ok) throw new Error(`Run download failed (${res.status})`);
  const text = await readCapped(res, MAX_DOWNLOAD_BYTES, "Run download is over 50 MB.");
  return text.split("\n").filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** Reads a response body, stopping (and throwing `message`) as soon as it passes `max` bytes. */
export async function readCapped(res: Response, max: number, message: string): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new Error(message);
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new Error(message); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A run that has finished one way or another. RUNNING (and anything else) is left for the next check. */
export const FINISHED = new Set(["SUCCESS", "FAILED", "SKIPPED"]);

export type RunRecords = { run: Run; records: any[]; baseline: boolean; failed?: boolean };
/** Run records, oldest first; `pending` is true while a run of the watch is still in progress. */
export type RunList = RunRecords[] & { pending?: boolean };

/**
 * Every finished run of a watch not read yet, oldest first, with the records it delivered. The watch's first run (its
 * free baseline sample) comes back with `baseline: true` and no records. Runs still going are read next time.
 */
export async function newRunRecords(ds: Dataset, id: number, seenRunIds: Set<number>, onRunError?: (run: Run, err: unknown) => "skip" | "throw"): Promise<RunList> {
  const all: Run[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < 10; page++) {
    const { runs, next_cursor } = await listRuns(ds, id, 20, cursor);
    all.push(...(runs ?? []));
    if (!next_cursor) { complete = true; break; }
    const newestFirst = (runs ?? []).every((r, k, a) => k === 0 || a[k - 1].id > r.id);
    if (newestFirst && (runs ?? []).length && (runs ?? []).every(r => seenRunIds.has(r.id))) break;
    cursor = next_cursor;
  }
  const baselineId = complete && all.length ? Math.min(...all.map(r => r.id)) : undefined;
  const out: RunRecords[] = [];
  for (const run of [...all].sort((a, b) => a.id - b.id)) {
    if (seenRunIds.has(run.id) || !FINISHED.has(run.status)) continue;
    const baseline = run.id === baselineId;
    // Only an explicit 0 means nothing was delivered; a missing count is read to be safe.
    if (baseline || run.status !== "SUCCESS" || run.new_records_count === 0) { out.push({ run, records: [], baseline }); continue; }
    try {
      const summary = await getRunSummary(ds, id, run.id);
      const url = summary?.payload_delivery?.url ?? summary?.records_download?.url;
      const records = url ? await downloadRecords(url) : (summary?.notifications ?? []).flatMap(n => n?.payload?.notifications ?? []);
      out.push({ run, records, baseline });
    } catch (err) {
      // A run that cannot be read: the caller decides (stop and retry next time, or give up on it after a few tries).
      if (!onRunError || onRunError(run, err) === "throw") throw err;
      out.push({ run, records: [], baseline, failed: true });
    }
  }
  return Object.assign(out, { pending: all.some(r => !FINISHED.has(r.status)) });
}
