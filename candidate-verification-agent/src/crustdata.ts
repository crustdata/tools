/**
 * Crustdata API client: the only file that talks to Crustdata. Plain REST, no SDK.
 *
 *   GET  /account/endpoints        what this key can use (verification, the assessment field, email lookup), free
 *   GET  /account/credits          credit balance, free
 *   POST /person/identify          email to profile URL, 1 credit per match, free on a miss (25 per call)
 *   POST /person/enrich            profile details, work history, schools and the quick-screen score, 1 credit per
 *                                  person found (25 per call, 15 calls a minute)
 *   POST /batch/person/verify      the full check, 10 people per job, 10 credits per verdict (billed when the
 *                                  job finishes; people with no verdict are free)
 *   GET  /batch/{batch_id}         job status and the results file link, free
 *   GET  /batch/                   recent jobs, free (used to find a job whose submit answer was lost)
 *
 * Prices are in the README. Docs: https://docs.crustdata.com
 */

import { gunzipSync } from "node:zlib";
import { config } from "./config.js";

const BASE_URL = "https://api.crustdata.com";
const API_VERSION = "2025-11-01";

/** Credits this process has spent, summed from the x-credits-used header of every response. */
export const spend = { credits: 0 };
export const fmtCredits = (n: number): string => String(Math.round(n * 100) / 100);

export class CrustdataError extends Error {
  constructor(public status: number, message: string, public apiMessage = "", public path = "") { super(message); }
}

/** Waits. Replaced in tests so polling and pacing take no real time. */
export const clock = {
  sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
  /** Crustdata's clock minus ours, from the Date header of the last answer (so a wrong local clock does not matter). */
  serverOffset: 0,
};

/** Crustdata's time now, as best known. */
export const serverNow = () => clock.now() + clock.serverOffset;

/** A plain next step for each kind of failure, instead of a stack trace. */
function explainStatus(status: number, method: string, path: string, apiMessage: string): string {
  const said = apiMessage ? `: ${apiMessage}` : "";
  if (status === 401) return "Crustdata rejected the API key (401). Copy it again from https://app.crustdata.com and run npm run setup.";
  if (status === 402 || /insufficient credits|out of credits/i.test(apiMessage)) return `Your Crustdata account is out of credits (${status}). Top up at https://app.crustdata.com, then run again: finished work is kept.`;
  if (status === 403 && path === "/batch/person/verify") return "This Crustdata key cannot use the full check (/batch/person/verify is an add-on, enabled per account). Ask Crustdata to enable it, or run with --quick for the 1-credit quick screen.";
  if (status === 403 && path === "/person/identify") return "This Crustdata key cannot look up emails (/person/identify). Ask Crustdata to enable it, or add a profile URL column to your file.";
  if (status === 403) return `Crustdata refused ${method} ${path} for this key (403)${said}`;
  if (status === 429) return "Crustdata is still rate limiting this key (429) after waiting. Wait a minute and run again: finished work is kept.";
  if (status >= 500) return `Crustdata had a server error on ${method} ${path} (${status}). Finished work is saved; run again in a minute.`;
  return `Crustdata could not run ${method} ${path} (${status})${said}`;
}

type RequestOptions = {
  /**
   * A request that may cost credits or create something. It is retried only when it surely did nothing: 429 (refused
   * before it reached the API) or a connection that never opened. A 502 or 503 from a gateway can come after the
   * request was processed, so it is not retried. A timeout, a reset connection or another 5xx may have gone through, so
   * it is not retried; the error says so and the caller decides.
   */
  billed?: boolean;
  /** Sent without x-api-version (the batch status and list endpoints do not need it). */
  noVersion?: boolean;
};

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const key = config.crustdataApiKey;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          ...(opts.noVersion ? {} : { "x-api-version": API_VERSION }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      const code = String((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message);
      const neverSent = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(code);
      if (attempt < 3 && (!opts.billed || neverSent)) { await clock.sleep(2000 * (attempt + 1)); continue; }
      throw new CrustdataError(0, `Could not reach Crustdata (${method} ${path}): ${(err as Error).message}.${opts.billed && !neverSent ? " The request may have gone through." : ""} Check your connection and run again.`, "", path);
    }
    spend.credits += Number(res.headers.get("x-credits-used") ?? 0) || 0;
    const date = Date.parse(res.headers.get("date") ?? "");
    if (Number.isFinite(date)) clock.serverOffset = date - clock.now();

    const retryable = res.status === 429 || (!opts.billed && res.status >= 500);
    if (retryable && attempt < 3) {
      // x-ratelimit-reset is the number of seconds until the per-minute window resets.
      const wait = Number(res.headers.get("retry-after")) || Number(res.headers.get("x-ratelimit-reset")) || 5 * (attempt + 1);
      await res.body?.cancel().catch(() => {});
      await clock.sleep(Math.min(wait + 1, 61) * 1000);
      continue;
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; }
    if (!res.ok) {
      const apiMessage = String(json?.error?.message ?? json?.message ?? res.statusText ?? "");
      throw new CrustdataError(res.status, explainStatus(res.status, method, path, apiMessage), apiMessage, path);
    }
    return json as T;
  }
}

// ---------------------------------------------------------------------------
// Account (free)
// ---------------------------------------------------------------------------

export type Endpoint = {
  path: string;
  status?: string;
  fields?: { enabled?: string[]; disabled?: string[] };
  base_credits?: number;
};

export async function accountEndpoints(): Promise<Endpoint[]> {
  const r = await request<Endpoint[] | { endpoints?: Endpoint[] }>("GET", "/account/endpoints");
  return Array.isArray(r) ? r : r?.endpoints ?? [];
}

export async function creditBalance(): Promise<number | undefined> {
  const r = await request<{ account?: { credits?: number } }>("GET", "/account/credits");
  return r?.account?.credits;
}

/** What this key can use, from /account/endpoints. Pure, so it is tested. */
export function capabilities(endpoints: Endpoint[]) {
  const find = (path: string) => endpoints.find(e => e.path === path);
  const enrich = find("/person/enrich");
  const enrichFields = new Set(enrich?.fields?.enabled ?? []);
  return {
    /** The full check: /batch/person/verify, an add-on enabled per account. */
    verify: find("/batch/person/verify")?.status === "enabled",
    verifyCredits: find("/batch/person/verify")?.base_credits ?? 10,
    enrich: enrich?.status === "enabled",
    /** The quick screen: the `assessment` field on /person/enrich, gated per key. */
    assessment: enrich?.status === "enabled" && [...enrichFields].some(f => f === "assessment" || f.startsWith("assessment.")),
    identify: find("/person/identify")?.status === "enabled",
  };
}
export type Capabilities = ReturnType<typeof capabilities>;

// ---------------------------------------------------------------------------
// Person records
// ---------------------------------------------------------------------------

export type Position = {
  title?: string | null;
  name?: string | null;                 // the employer's name
  start_date?: string | null;           // ISO date
  end_date?: string | null;
  employment_type?: string | null;      // often empty
  is_default?: boolean | null;
  company_website_domain?: string | null;
};

export type School = {
  school?: string | null;
  degree?: string | null;
  field_of_study?: string | null;
  start_year?: number | null;
  end_year?: number | null;
};

export type Authenticity = { verdict?: string | null; tier?: number | null };

export type PersonData = {
  crustdata_person_id?: number;
  basic_profile?: {
    name?: string | null;
    current_title?: string | null;
    headline?: string | null;
    location?: { full_location?: string | null; raw?: string | null } | null;
  } | null;
  experience?: { employment_details?: { current?: Position[] | null; past?: Position[] | null } | null } | null;
  education?: { schools?: School[] | null } | null;
  social_handles?: { professional_network_identifier?: { profile_url?: string | null } | null } | null;
  assessment?: { authenticity?: Authenticity | null } | null;
};

export type MatchResult = {
  matched_on?: string;
  match_status?: string;              // "matched" | "not_found" | ...
  matches?: Array<{ confidence_score?: number; person_data?: PersonData }>;
};

// ---------------------------------------------------------------------------
// Identify: email to profile URL
// ---------------------------------------------------------------------------

/** Emails the API would reject. One malformed address fails the whole call, so they never reach it. */
export const plausibleEmail = (s: string): boolean => /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/i.test(s);

/**
 * Looks up emails, 25 per call. Each answer is kept as the API gave it; `resolveIdentify` decides which ones are
 * safe to use. If the API still rejects some addresses as invalid, they are dropped and the call is sent again.
 */
export async function identifyEmails(emails: string[], onBatch: (sent: string[], results: MatchResult[]) => void): Promise<void> {
  for (let i = 0; i < emails.length; i += 25) {
    let batch = emails.slice(i, i + 25);
    for (let tries = 0; batch.length; tries++) {
      try {
        const r = await request<MatchResult[]>("POST", "/person/identify", { emails: batch }, { billed: true });
        onBatch(batch, Array.isArray(r) ? r : []);
        break;
      } catch (err) {
        const bad = err instanceof CrustdataError && err.status === 400 && /Invalid emails?/i.test(err.apiMessage);
        if (!bad) throw err;
        // Whatever the format of the message ("a, b" or "['a']"), the addresses in it are the rejected ones.
        const named = (e: string) => new RegExp(`(^|[^\\w.+-])${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`, "i").test(err.apiMessage);
        const dropped = batch.filter(named);
        const rejected = new Set(dropped);
        if (!dropped.length || tries >= 2) throw new CrustdataError(400, `Crustdata rejected some emails in this file as invalid (${err.apiMessage.slice(0, 200)}). Fix or remove them and run again; nothing else was lost.`, err.apiMessage, "/person/identify");
        onBatch(dropped, dropped.map(e => ({ matched_on: e, match_status: "invalid_email", matches: [] })));
        batch = batch.filter(e => !rejected.has(e));
      }
    }
    // 30 calls a minute.
    if (i + 25 < emails.length) await clock.sleep(2100);
  }
}

// ---------------------------------------------------------------------------
// Enrich: profile details and the quick-screen score
// ---------------------------------------------------------------------------

export const ENRICH_FIELDS = ["basic_profile", "experience", "education", "social_handles", "assessment"];

/**
 * Enriches profile URLs, 25 per call, paced under 15 calls a minute. `onBatch` gets each answer as it arrives, so a
 * failure later never loses (and never re-bills) what was already fetched. A key without the `assessment` field
 * gets the same call without it (no quick-screen score; `noAssessment` is called once).
 */
export async function enrichPeople(urls: string[], onBatch: (results: MatchResult[]) => void, noAssessment: () => void = () => {}): Promise<void> {
  let fields = ENRICH_FIELDS;
  for (let i = 0; i < urls.length; i += 25) {
    const batch = urls.slice(i, i + 25);
    let r: MatchResult[];
    try {
      r = await request<MatchResult[]>("POST", "/person/enrich", { professional_network_profile_urls: batch, fields }, { billed: true });
    } catch (err) {
      if (err instanceof CrustdataError && err.status === 403 && /assessment/i.test(err.apiMessage) && fields.includes("assessment")) {
        fields = fields.filter(f => f !== "assessment");
        noAssessment();
        i -= 25;
        continue;
      }
      throw err;
    }
    onBatch(Array.isArray(r) ? r : []);
    if (i + 25 < urls.length) await clock.sleep(4100);
  }
}

// ---------------------------------------------------------------------------
// Batch verification: the full check
// ---------------------------------------------------------------------------

export type BatchJob = {
  batch_id: string;
  status: "pending" | "processing" | "completed" | "failed" | string;
  action?: string;
  entity?: string;
  identifier_count?: number;
  result_count?: number;
  entities_fulfilled?: number;
  created_at?: string;
  completed_at?: string | null;
  download_url?: string;
  download_urls?: string[];
  error_message?: string;
};

export type Citation = { url?: string; title?: string; cited_text?: string };
export type Coverage = {
  social_ran?: boolean;
  posts_fetched?: number;
  posts_checked?: number;
  engagers_seen?: number;
  engagers_resolved?: number;
  coworker_hits?: number;
  timeline_flags?: number;
  flags?: string[];
};
export type VerifyData = {
  verdict?: string;
  confidence?: number;
  reasoning?: string;
  flags?: string[];
  coverage?: Coverage;
  citations?: Citation[];
};
export type VerifyRecord = { original_identifier?: string; internal_id?: number; data?: VerifyData };

/** Up to 10 profile URLs per job. */
export const VERIFY_BATCH_SIZE = 10;
/** An account may have 5 active batch jobs (a sixth submit gets 429), and may submit 5 a minute. */
export const MAX_ACTIVE_JOBS = 5;

/**
 * Submits one job. A submit is not billed (the verdicts are, when the job finishes), but a retried submit could
 * create a second job and bill twice, so a submit whose answer was lost is never sent again here: `resolveLostSubmit`
 * looks for it instead.
 */
export async function submitVerify(urls: string[]): Promise<BatchJob> {
  const r = await request<BatchJob>("POST", "/batch/person/verify", { professional_network_profile_urls: urls }, { billed: true });
  if (!r?.batch_id) throw new CrustdataError(0, "Crustdata accepted the verification job but sent no job id. Run again in a minute.", "", "/batch/person/verify");
  return r;
}

export async function batchStatus(batchId: string): Promise<BatchJob> {
  return request<BatchJob>("GET", `/batch/${encodeURIComponent(batchId)}`, undefined, { noVersion: true });
}

/**
 * The account's batch jobs, newest first, back to `since` (100 a page, at most 10 pages). A busy account has many
 * jobs of other kinds, so one page is not enough to find a verification job from earlier today.
 */
export async function recentJobs(since: number, maxPages = 10): Promise<BatchJob[]> {
  const out: BatchJob[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await request<{ jobs?: BatchJob[]; next_cursor?: string | null; has_more?: boolean }>("GET", `/batch/?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, { noVersion: true });
    const jobs = r?.jobs ?? [];
    out.push(...jobs);
    const oldest = jobs.at(-1)?.created_at;
    if (!r?.has_more || !r.next_cursor || (oldest && Date.parse(oldest) < since)) return out;
    cursor = r.next_cursor;
  }
  throw new CrustdataError(0, "Too many batch jobs on this account to look back a full day.", "", "/batch/");
}

/**
 * Whether a submission whose answer was lost (or that was in flight when the run stopped) created a job. Jobs on the
 * account made within a day of it (by Crustdata's clock) with the same number of people, not known to any list, are
 * looked at:
 *   { job }      found it: its results name only our people, and either a verdict for every one of them or a
 *                creation time within 5 minutes of the submission (by Crustdata's clock)
 *   "absent"     no such job, or only jobs that are someone else's or billed nothing: sending again is safe
 *   "unsure"     a matching job is still running or cannot be read yet, or the job list could not be read: wait
 */
export async function resolveLostSubmit(urls: string[], at: number, known: Set<string>, sameUrl: (a: string | undefined, b: string) => boolean): Promise<{ job: BatchJob } | "absent" | "unsure"> {
  let jobs: BatchJob[];
  try { jobs = await recentJobs(at - 86_400_000); } catch { return "unsure"; }
  const candidates = jobs.filter(j => (j.action === "verify" || !j.action) && j.identifier_count === urls.length && !known.has(j.batch_id) &&
    (!j.created_at || Math.abs(Date.parse(j.created_at) - at) < 86_400_000));
  // Anything not finished yet: wait before adopting anything (it may be ours, newer than a finished one).
  // A status this version does not know, on a job more than 6 hours old, is treated as finished (it would otherwise
  // hold the people for a day).
  const known6h = (j: BatchJob) => j.status === "pending" || j.status === "processing" || !j.created_at || Date.parse(j.created_at) > serverNow() - 6 * 3_600_000;
  if (candidates.some(j => j.status !== "completed" && j.status !== "failed" && known6h(j))) return "unsure";
  let waiting = false;
  for (const j of candidates) {
    if (j.status !== "completed") continue; // failed (not billed) or an old unknown status
    let status: BatchJob, records: VerifyRecord[] = [];
    try {
      status = await batchStatus(j.batch_id);
      const links = status.download_url ? [status.download_url] : status.download_urls ?? [];
      const expected = status.result_count ?? j.result_count;
      if (expected === 0) continue; // billed nothing
      if (!links.length) { waiting = true; continue; }
      for (const link of links) records.push(...(await downloadResults(link)).records);
      if (expected !== undefined && records.length < expected) { waiting = true; continue; }
    } catch { waiting = true; continue; }
    const ours = records.length > 0 && records.every(rec => urls.some(u => sameUrl(rec.original_identifier, u)));
    const complete = records.length === urls.length;
    const close = j.created_at ? Math.abs(Date.parse(j.created_at) - at) < 5 * 60_000 : false;
    if (ours && (complete || close)) return { job: { ...status, batch_id: j.batch_id } };
    if (ours) waiting = true; // our people, but it cannot be told apart from someone else's job: never send again blindly
  }
  return waiting ? "unsure" : "absent";
}

/** Results files come only from Crustdata's own storage, over https. */
export function safeDownloadUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^crustdata-[a-z0-9.-]*\.s3[a-z0-9.-]*\.amazonaws\.com$/i.test(u.hostname);
  } catch { return false; }
}

const MAX_RESULTS_BYTES = 50 * 1024 * 1024;

/**
 * Downloads and reads a results file: gzipped JSON lines, one person per line. A line that is not valid JSON is
 * skipped and counted, so one bad line never loses the rest.
 */
export async function downloadResults(url: string): Promise<{ records: VerifyRecord[]; badLines: number }> {
  if (!safeDownloadUrl(url)) throw new CrustdataError(0, `The results link is not a Crustdata storage link over https (${String(url).slice(0, 80)}). Nothing was downloaded.`, "", "download");
  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
      if (res.ok || res.status < 500) break;
    } catch (err) {
      if (attempt === 2) throw new CrustdataError(0, `Could not download the results file: ${(err as Error).message}. Run again: the job is saved and will be read again.`, "", "download");
    }
    await clock.sleep(3000 * (attempt + 1));
  }
  if (!res || !res.ok) throw new CrustdataError(res?.status ?? 0, `Could not download the results file (${res?.status}). Run again: the job is saved and its link will be asked for again.`, "", "download");
  // Read with a byte cap, so a wrong or huge answer cannot fill memory.
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  for (;;) {
    const { done, value } = reader ? await reader.read() : { done: true, value: undefined };
    if (done) break;
    size += value!.length;
    if (size > MAX_RESULTS_BYTES) { await reader!.cancel().catch(() => {}); throw new CrustdataError(0, "The results file is larger than 50 MB, which a job of 10 people never is. Nothing was read.", "", "download"); }
    chunks.push(Buffer.from(value!));
  }
  try { return parseResults(Buffer.concat(chunks)); }
  catch (err) { throw new CrustdataError(0, `The results file could not be unpacked (${(err as Error).message.slice(0, 120)}). Nothing was read.`, "", "download"); }
}

/** Pure: gzipped (or plain) JSON lines to records. */
export function parseResults(raw: Buffer): { records: VerifyRecord[]; badLines: number } {
  const text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: 100 * 1024 * 1024 }) : raw).toString("utf8");
  const records: VerifyRecord[] = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === "object" && !Array.isArray(rec)) records.push(rec);
      else badLines++;
    } catch { badLines++; }
  }
  return { records, badLines };
}
