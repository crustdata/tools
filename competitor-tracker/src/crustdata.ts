/**
 * Crustdata API client: the only file that talks to Crustdata.
 *
 *   GET    /account/credits                      credit balance (free)
 *   POST   /company/identify                     name or domain -> company id (free)
 *   POST   /company/enrich                       headcount, funding, news, hiring for a company (2 credits)
 *   POST   /job/search                           job postings; `limit: 0` returns total_count free
 *   POST   /social_post/search                   posts by a company page or its staff (0.5 credits per post)
 *   POST   /web/enrich/live                      Web Fetch: full HTML of up to 10 pages (1 credit per page)
 *   POST   /web/search/live                      Web Search: news from this week (1 credit per query)
 *   POST   /watch/company                        company entity watch (5 credits per changed company)
 *   POST   /watch/job/search                     job watch (0.5 credits per new job)
 *   POST   /watch/social_post/search             post watch (2 credits per new post)
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

/**
 * Smallest gap between two requests to the same endpoint, under its published per-minute limit, so a run over many
 * competitors does not hit 429s: Web Fetch and Web Search 10/min, company enrich 15/min, watch endpoints 10/min.
 */
const MIN_GAP_MS: [RegExp, number][] = [
  [/^\/web\//, 6_100],
  [/^\/watch\//, 6_100],
  [/^\/company\/enrich/, 4_100],
  [/^\/(job|social_post)\/search/, 2_100],
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
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-api-version": API_VERSION,
        },
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

export type IdentifiedCompany = {
  input: string;
  id?: number;
  name?: string;
  domain?: string;
  profileUrl?: string;
  employeeRange?: string;
  description?: string;
  confidence?: number;
};

/** Resolves domains (or names) to Crustdata companies. Free. Unmatched inputs come back without an id. */
export async function identifyCompanies(inputs: string[], by: "domains" | "names" = "domains"): Promise<IdentifiedCompany[]> {
  if (!inputs.length) return [];
  const rows = await request<any[]>("POST", "/company/identify", { [by]: inputs });
  return inputs.map((input, i) => {
    const row = rows.find(r => String(r.matched_on ?? "").toLowerCase() === input.toLowerCase()) ?? rows[i];
    const match = row?.matches?.[0];
    const c = match?.company_data;
    if (!c) return { input };
    return {
      input,
      id: c.crustdata_company_id,
      name: c.basic_info?.name,
      domain: c.basic_info?.primary_domain,
      profileUrl: c.basic_info?.professional_network_url,
      employeeRange: c.basic_info?.employee_count_range,
      description: c.basic_info?.description,
      confidence: match.confidence_score,
    };
  });
}

/** Field groups the tracker reads from a company record. Same groups the company watch delivers. */
export const COMPANY_FIELDS = ["basic_info", "headcount", "funding", "news", "hiring"];

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
// Jobs and posts (index searches)
// ---------------------------------------------------------------------------

export type Condition = { field: string; type: string; value?: unknown } | { op: "and" | "or"; conditions: Condition[] };

export const jobsAtDomains = (domains: string[]): Condition =>
  domains.length === 1
    ? { field: "company.basic_info.primary_domain", type: "=", value: domains[0] }
    : { field: "company.basic_info.primary_domain", type: "in", value: domains };

/** Posts by a competitor's company page (by Crustdata id, the reliable handle) or by anyone who works there. */
export const postsByCompany = (c: { id: number; name: string }): Condition => ({
  op: "or",
  conditions: [
    { op: "and", conditions: [{ field: "actor.actor_type", type: "=", value: "company" }, { field: "actor.crustdata_entity_id", type: "=", value: c.id }] },
    { op: "and", conditions: [{ field: "actor.actor_type", type: "=", value: "person" }, { field: "actor.company_name", type: "=", value: c.name }] },
  ],
});

export const anyKeyword = (keywords: string[]): Condition => ({ op: "or", conditions: keywords.map(k => ({ field: "text", type: "[.]", value: k })) });

export type SearchOptions = { limit: number; sorts?: { field: string; order: "asc" | "desc" }[]; aggregations?: unknown[]; cursor?: string };

export const searchJobs = (filters: Condition, o: SearchOptions) =>
  request<{ job_listings: any[]; total_count?: number; next_cursor?: string | null; aggregations?: any[] }>("POST", "/job/search", { filters, ...o });

export const searchPosts = (filters: Condition, o: SearchOptions) =>
  request<{ posts: any[]; total_count?: number; next_cursor?: string | null }>("POST", "/social_post/search", { filters, ...o });

// ---------------------------------------------------------------------------
// Web Fetch and Web Search
// ---------------------------------------------------------------------------

export type FetchedPage = { url: string; success: boolean; title?: string | null; content?: string | null; http_status?: number | null };

/** Fetches up to 10 pages per request (1 credit per page). */
export async function fetchPages(urls: string[]): Promise<FetchedPage[]> {
  const out: FetchedPage[] = [];
  for (let i = 0; i < urls.length; i += 10) {
    const batch = urls.slice(i, i + 10);
    const rows = await request<any[]>("POST", "/web/enrich/live", { urls: batch });
    for (const [j, u] of batch.entries()) {
      const row = rows.find(r => r?.url === u) ?? rows[j];
      out.push({ url: u, success: Boolean(row?.success), title: row?.title ?? null, content: row?.content ?? null, http_status: row?.http_status ?? null });
    }
  }
  return out;
}

export type NewsResult = { title: string; url: string; snippet?: string; source?: string };

/** News articles about a company since `since`. 1 credit per query. Results carry no date of their own. */
export async function searchNews(query: string, since: Date): Promise<NewsResult[]> {
  const r = await request<{ results?: any[] }>("POST", "/web/search/live", {
    query,
    sources: ["news"],
    start_date: Math.floor(since.getTime() / 1000),
  });
  return (r?.results ?? []).filter(x => x?.url && x?.title).map(x => ({ title: String(x.title), url: String(x.url), snippet: x.snippet ? String(x.snippet) : undefined, source: x.source }));
}

// ---------------------------------------------------------------------------
// Watches
// ---------------------------------------------------------------------------

export type Dataset = "company" | "job" | "social_post";

/** Create and manage paths differ by kind: entity watches live at /watch/company, discovery watches at /watch/<ds>/search. */
const managePath = (ds: Dataset, id?: number) => (ds === "company" ? `/watch/company${id ? `/${id}` : ""}` : `/watch/${ds}/search${id ? `/${id}` : ""}`);
/** Runs and summaries drop the `search/` segment for every kind. */
const readPath = (ds: Dataset, id: number) => `/watch/${ds}/${id}`;

export type Watch = {
  id: number;
  kind?: "entity" | "discovery";
  dataset?: Dataset;
  status: string;
  entities?: { crustdata_company_ids?: number[]; domains?: string[] };
  filters?: unknown;
  track?: unknown;
  config?: { trigger?: { every_hours?: number }; max_results_per_run?: number; refresh_frequency_days?: number; preferred_hour?: number | null };
  created_at?: string;
  notifications_count?: number;
  credits_consumed?: number;
  last_run_at?: string | null;
  credits?: { per_notification?: number };
};

/**
 * When the watchers run. Jobs and posts are checked daily (they bill per item caught, not per run, so this costs the
 * same and the Monday digest never races a weekly run). The company watcher stays weekly: it bills per company that
 * changed in a run, so weekly runs fold several changes into one charge. All prefer 06:00 UTC, ahead of a digest at
 * 08:00 UTC on Mondays.
 */
export const PREFERRED_HOUR = 6;
const WEEKLY = { type: "interval", every_hours: 168 };
const DAILY = { type: "interval", every_hours: 24 };
/** A weekly cap spread over seven daily runs (items over a run's cap arrive on a later run). */
export const perDailyRun = (perWeek: number) => Math.max(5, Math.ceil(perWeek / 7));

/** What fires the company watch: a headcount move, a news mention, a new round type, an acquisition or a new investor. */
export const COMPANY_TRACK = {
  op: "or",
  conditions: [
    { field: "headcount.total", type: "changed" },
    { field: "news", type: "added" },
    { field: "funding.last_round_type", type: "changed" },
    { field: "funding.acquisitions", type: "added" },
    { field: "funding.investors", type: "added" },
    { field: "funding.acquired_by", type: "added" },
  ],
};

/** Watch creates are never retried: a retry could make a second, billed watch. */
export const createCompanyWatch = (ids: number[]) =>
  request<Watch>("POST", managePath("company"), {
    entities: { crustdata_company_ids: ids },
    track: COMPANY_TRACK,
    fields: COMPANY_FIELDS,
    config: { trigger: WEEKLY, preferred_hour: PREFERRED_HOUR, max_results_per_run: Math.max(ids.length, 1) },
    notifications: [],
  }, { retry: false });

/** The job watch's filter: postings at these domains, posted in the last 30 days (rolling; keeps old listings out). */
export const jobWatchFilters = (domains: string[]): Condition => ({ op: "and", conditions: [jobsAtDomains(domains), { field: "metadata.date_added", type: "=>", value: "now-30d" }] });
/** The post watch's filter: posts in the last 3 months by these companies or their staff, with one of the words. */
export const postWatchFilters = (companies: { id: number; name: string }[], keywords: string[]): Condition => ({
  op: "and",
  conditions: [{ field: "date_posted", type: "=>", value: "now-3M" }, { op: "or", conditions: companies.map(postsByCompany) }, anyKeyword(keywords)],
});

export const createJobWatch = (domains: string[], maxPerWeek: number) =>
  request<Watch>("POST", managePath("job"), {
    filters: jobWatchFilters(domains),
    config: { trigger: DAILY, preferred_hour: PREFERRED_HOUR, max_results_per_run: perDailyRun(maxPerWeek) },
    notifications: [],
  }, { retry: false });

export const createPostWatch = (companies: { id: number; name: string }[], keywords: string[], maxPerWeek: number) =>
  request<Watch>("POST", managePath("social_post"), {
    filters: postWatchFilters(companies, keywords),
    config: { trigger: DAILY, preferred_hour: PREFERRED_HOUR, max_results_per_run: perDailyRun(maxPerWeek) },
    notifications: [],
  }, { retry: false });

export const getWatch = (ds: Dataset, id: number) => request<Watch>("GET", managePath(ds, id));
/** Active watches of one kind on the account (free), so init can reuse one instead of creating a duplicate. */
export async function listActiveWatches(ds: Dataset): Promise<Watch[]> {
  const page = await request<Watch[] | { watches?: Watch[] }>("GET", `${managePath(ds)}?status=active&limit=100`);
  return Array.isArray(page) ? page : page?.watches ?? [];
}
export const setWatchStatus = (ds: Dataset, id: number, status: "active" | "paused") => request<Watch>("PATCH", managePath(ds, id), { status });
/** Company entity watches take a new list in place; discovery watch filters are fixed, so those are recreated instead. */
export const setWatchedCompanies = (id: number, ids: number[]) =>
  request<Watch>("PATCH", managePath("company", id), { entities: { crustdata_company_ids: ids }, config: { trigger: WEEKLY, preferred_hour: PREFERRED_HOUR, max_results_per_run: Math.max(ids.length, 1) } });

export async function deleteWatch(ds: Dataset, id: number): Promise<void> {
  try { await request<void>("DELETE", managePath(ds, id)); }
  catch (err) { if (!(err instanceof CrustdataError && err.status === 404)) throw err; } // already gone
}

export type Run = {
  id: number;
  started_at: string;
  completed_at?: string | null;
  status: string;
  new_records_count?: number | null;
  credits_deducted?: number | null;
};

export const listRuns = (ds: Dataset, id: number, limit = 20, cursor?: string) =>
  request<{ runs: Run[]; next_cursor?: string | null }>("GET", `${readPath(ds, id)}/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);

export const getRunSummary = (ds: Dataset, id: number, runId: number) =>
  request<{ id: number; records_download?: { url?: string }; notifications?: { payload?: { notifications?: any[] } }[] }>("GET", `${readPath(ds, id)}/runs/${runId}/summary`);

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
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error("Run download is over 50 MB; lower MAX_POSTS_PER_WEEK or MAX_JOBS_PER_WEEK.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("Run download is over 50 MB; lower MAX_POSTS_PER_WEEK or MAX_JOBS_PER_WEEK.");
  return new TextDecoder().decode(bytes).split("\n").filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** A run that has finished one way or another. RUNNING (and anything else) is left for the next digest. */
export const FINISHED = new Set(["SUCCESS", "FAILED", "SKIPPED"]);

export type RunRecords = { run: Run; records: any[]; baseline: boolean };

/**
 * Every finished run of a watch the caller has not read yet, oldest first, with the records it delivered. The
 * watch's first run (its free baseline sample) comes back with `baseline: true` and no records. Runs still going are
 * not returned, so they are read next time instead of being marked as read.
 */
/** Run records, oldest first; `pending` is true while a run of the watch is still in progress. */
export type RunList = RunRecords[] & { pending?: boolean };

export async function newRunRecords(ds: Dataset, id: number, seenRunIds: Set<number>): Promise<RunList> {
  const all: Run[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < 10; page++) {
    const { runs, next_cursor } = await listRuns(ds, id, 20, cursor);
    all.push(...(runs ?? []));
    if (!next_cursor) { complete = true; break; }
    // Runs come newest first: a page that was all read before means older pages were too. If the order ever
    // differs, keep listing (up to the page cap) rather than stop early and miss new runs.
    const newestFirst = (runs ?? []).every((r, k, a) => k === 0 || a[k - 1].id > r.id);
    if (newestFirst && (runs ?? []).length && (runs ?? []).every(r => seenRunIds.has(r.id))) break;
    cursor = next_cursor;
  }
  // The baseline is the watch's first run; it is only known for sure when the whole history was listed.
  const baselineId = complete && all.length ? Math.min(...all.map(r => r.id)) : undefined;
  const out: RunRecords[] = [];
  for (const run of [...all].sort((a, b) => a.id - b.id)) {
    if (seenRunIds.has(run.id) || !FINISHED.has(run.status)) continue;
    const baseline = run.id === baselineId;
    if (baseline || run.status !== "SUCCESS" || !run.new_records_count) { out.push({ run, records: [], baseline }); continue; }
    const summary = await getRunSummary(ds, id, run.id);
    const url = (summary as any)?.payload_delivery?.url ?? summary?.records_download?.url;
    const records = url ? await downloadRecords(url) : (summary?.notifications ?? []).flatMap(n => n?.payload?.notifications ?? []);
    out.push({ run, records, baseline });
  }
  return Object.assign(out, { pending: all.some(r => !FINISHED.has(r.status)) });
}
