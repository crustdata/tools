/**
 * Crustdata API client: the only file that talks to Crustdata.
 *
 *   POST   /person/identify          email -> profile (1 credit per match, unmatched is free; 30 requests/min)
 *   POST   /watch/person             create an entity watch (up to 10,000 people each; 10 requests/min)
 *   GET    /watch/person             list your watches (to find and adopt an existing one)
 *   GET    /watch/person/{id}[/runs] status and run history
 *   PATCH  /watch/person/{id}        replace the list, change freshness or delivery URL, pause or resume
 *   DELETE /watch/person/{id}        cancel a watch
 *   POST   /watch/person/{id}/test   send a signed sample notification (free)
 *   GET    /account/credits          credit balance (free)
 *
 * Docs: https://docs.crustdata.com/watcher-docs/person/entity
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const BASE_URL = "https://api.crustdata.com";
const API_VERSION = "2025-11-01";
export const MAX_PEOPLE_PER_WATCH = 10_000;

export class CrustdataError extends Error {
  constructor(public status: number, public path: string, message: string) {
    super(`Crustdata ${path} failed (${status}): ${message}`);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** One request, retried on rate limits (429), server errors (5xx) and network errors, up to 6 attempts (about a minute). */
async function request<T>(method: string, path: string, body?: unknown, { retry = true } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.crustdataApiKey}`,
          "content-type": "application/json",
          "x-api-version": API_VERSION,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (!retry || attempt >= 6) throw new Error(`Could not reach Crustdata (${(err as Error).message}). Check your connection and try again.`);
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if ((res.status === 429 || (res.status >= 500 && retry)) && attempt < 6) {
      // Exponential backoff (2, 4, 8, 16, 32s), never shorter than what the server asks for.
      const wait = Math.max(retryAfterMs(res) ?? 0, 2 ** attempt * 1000);
      console.log(`  Crustdata answered ${res.status}; retrying in ${Math.ceil(wait / 1000)}s...`);
      await sleep(wait);
      continue;
    }

    const credits = Number(res.headers.get("x-credits-used") ?? 0);
    if (credits > 0) console.log(`  credits used: ${credits} (${method} ${path.split("?")[0]})`);
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
  if (reset > 0) return Math.min(reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000, 120_000); // seconds until reset (or, defensively, a timestamp)
  return undefined;
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return { message: text }; }
}

export async function getCreditBalance(): Promise<number | undefined> {
  const r = await request<{ account?: { credits?: number } }>("GET", "/account/credits");
  return r?.account?.credits;
}

// ---------------------------------------------------------------------------
// Profile URLs
// ---------------------------------------------------------------------------

export { normalizeProfileUrl } from "./profile-url.js";
import { normalizeProfileUrl } from "./profile-url.js";

// ---------------------------------------------------------------------------
// Identify: resolve emails to profile URLs
// ---------------------------------------------------------------------------

export type IdentifyResult = {
  input: string;
  status: "matched" | "not_found" | "redacted" | "invalid" | "no_profile_url" | "low_confidence";
  crustdataPersonId?: number;
  name?: string;
  title?: string;
  profileUrl?: string;
  confidence?: number;
};

const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
const RESERVED_DOMAINS = /@(example\.(com|org|net)|test\.com|localhost)$/i;
export const looksLikeEmail = (email: string): boolean => EMAIL_SHAPE.test(email) && !RESERVED_DOMAINS.test(email);

/**
 * Resolves emails 25 per request, paced under the 30 requests/min limit. `onBatch` runs after every request so the
 * caller can save results as they arrive: an interrupted import never pays twice for the same match.
 * One malformed address fails a whole batch with `400 Invalid emails: ...`, so addresses are screened first and any
 * the API still rejects are dropped and the batch retried.
 */
export async function identifyEmails(emails: string[], onBatch: (results: IdentifyResult[], done: number, total: number) => void): Promise<void> {
  const invalid = emails.filter(e => !looksLikeEmail(e));
  if (invalid.length) onBatch(invalid.map(input => ({ input, status: "invalid" as const })), 0, emails.length);
  const valid = emails.filter(looksLikeEmail);
  for (let i = 0; i < valid.length; i += 25) {
    if (i > 0) await sleep(2_100);
    onBatch(await identifyBatch(valid.slice(i, i + 25)), Math.min(i + 25, valid.length), valid.length);
  }
}

async function identifyBatch(batch: string[]): Promise<IdentifyResult[]> {
  if (!batch.length) return [];
  let rows: any[];
  try {
    rows = await request<any[]>("POST", "/person/identify", { emails: batch });
  } catch (err) {
    const rejected = err instanceof CrustdataError && err.status === 400 ? /Invalid emails?: (.+)$/i.exec(err.message)?.[1] : undefined;
    if (!rejected) throw err;
    const bad = new Set(rejected.split(/[,\s]+/).map(s => s.toLowerCase()).filter(Boolean));
    const dropped = batch.filter(e => bad.has(e.toLowerCase())).map(input => ({ input, status: "invalid" as const }));
    if (!dropped.length) throw err; // the API named none of these addresses: retrying would loop
    return [...dropped, ...(await identifyBatch(batch.filter(e => !bad.has(e.toLowerCase()))))];
  }

  return rows.map((row, i) => {
    const input: string = row.matched_on ?? batch[i];
    const match = row.matches?.[0];
    const person = match?.person_data ?? match;
    if (row.match_status !== "matched" || !person) return { input, status: row.match_status === "redacted" ? "redacted" : "not_found" };
    const confidence: number | undefined = match?.confidence_score;
    const profileUrl: string | undefined = person.social_handles?.professional_network_identifier?.profile_url;
    if (!profileUrl) return { input, status: "no_profile_url" };
    return {
      input,
      status: "matched",
      crustdataPersonId: person.crustdata_person_id,
      name: person.basic_profile?.name,
      title: person.basic_profile?.current_title,
      profileUrl: profileUrl ? normalizeProfileUrl(profileUrl) : undefined,
      confidence,
    };
  });
}

// ---------------------------------------------------------------------------
// Person entity watches
// ---------------------------------------------------------------------------

/**
 * What fires a notification: a new current position, a title change, or a role ending (which is how someone leaving
 * without a new job shows up). Fixed once a watch exists (unlike freshness and the report interval). The bot then classifies each change in notification.ts.
 */
export const JOB_CHANGE_TRACK = {
  op: "or",
  conditions: [
    { field: "experience.employment_details.current", type: "added" },
    { field: "basic_profile.current_title", type: "changed" },
    { field: "experience.employment_details.past", type: "added" },
  ],
};

/** What each notification carries about the person. Does not affect price. */
export const WATCH_FIELDS = ["basic_profile", "experience", "social_handles"];

export type Watch = {
  id: number;
  status: string;
  entities: { professional_network_profile_urls: string[] };
  track?: unknown;
  notifications?: { type: string; url?: string; [key: string]: unknown }[];
  config?: { refresh_frequency_days?: number; trigger?: { every_hours?: number } };
  notifications_count?: number;
  credits_consumed?: number;
  last_run_at?: string | null;
};

export function createWatch(profileUrls: string[], deliverTo: string): Promise<Watch> {
  return request<Watch>("POST", "/watch/person", {
    entities: { professional_network_profile_urls: profileUrls },
    track: JOB_CHANGE_TRACK,
    fields: WATCH_FIELDS,
    config: {
      trigger: { type: "interval", every_hours: config.checkEveryHours },
      refresh_frequency_days: config.refreshFrequencyDays,
      max_results_per_run: 1000,
    },
    notifications: [{ type: "webhook", url: deliverTo }],
  }, { retry: false }); // a retried create could make a second, billed watch; import looks for existing watches first
}

export const getWatch = (id: number) => request<Watch>("GET", `/watch/person/${id}`);
export async function listActiveWatches(): Promise<Watch[]> {
  const all: Watch[] = [];
  for (let offset = 0; offset < 5_000; offset += 100) {
    const page = await request<Watch[]>("GET", `/watch/person?status=active&limit=100&offset=${offset}`);
    all.push(...(page ?? []));
    if (!page || page.length < 100) break;
  }
  return all;
}
export const listRuns = (id: number, limit = 10, cursor?: string) =>
  request<{ runs: any[]; next_cursor?: string | null }>("GET", `/watch/person/${id}/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
/** One run, with `records_download.url`: a signed NDJSON file of every record the run delivered (or tried to). */
export const getRunSummary = (id: number, runId: number) => request<{ id: number; records_download?: { url?: string }; payload_delivery?: { url?: string }; notifications?: unknown[] }>("GET", `/watch/person/${id}/runs/${runId}/summary`);
export async function deleteWatch(id: number): Promise<void> {
  try { await request<void>("DELETE", `/watch/person/${id}`); }
  catch (err) { if (!(err instanceof CrustdataError && err.status === 404)) throw err; } // already gone
}

/** Replaces a watch's list. People new to the list are baselined silently on the next run. */
export const setWatchedPeople = (id: number, profileUrls: string[]) =>
  request<Watch>("PATCH", `/watch/person/${id}`, { entities: { professional_network_profile_urls: profileUrls } });

export const setWatchStatus = (id: number, status: "active" | "paused") =>
  request<Watch>("PATCH", `/watch/person/${id}`, { status });

/** Applies the current freshness and report interval to an existing watch (both can change after creation). */
export const setWatchSchedule = (id: number) =>
  request<Watch>("PATCH", `/watch/person/${id}`, {
    config: { trigger: { type: "interval", every_hours: config.checkEveryHours }, refresh_frequency_days: config.refreshFrequencyDays, max_results_per_run: 1000 },
  });

/** Points a watch at a new delivery URL, for example after PUBLIC_URL changes. */
export const setWatchDelivery = (w: Watch, deliverTo: string) => {
  // Keep any other channels (an email or Slack channel added in the dashboard); replace only the webhook.
  const others = (w.notifications ?? []).filter(n => n.type !== "webhook");
  return request<Watch>("PATCH", `/watch/person/${w.id}`, { notifications: [...others, { type: "webhook", url: deliverTo }] });
};

/** Asks Crustdata to send one signed sample notification (flagged `metadata.test: true`) to the watch's URL. Free. */
export const sendTestNotification = (id: number) => request<any>("POST", `/watch/person/${id}/test`, {});

/** True when an existing watch tracks exactly what this version of the bot expects. */
export function tracksJobChanges(w: Watch): boolean {
  const leaves = (t: any): string[] => (t?.conditions ?? [t]).flatMap((c: any) => (c?.conditions ? leaves(c) : [`${c?.field}:${c?.type}`])).sort();
  return JSON.stringify(leaves(w.track)) === JSON.stringify(leaves(JOB_CHANGE_TRACK));
}

// ---------------------------------------------------------------------------
// Webhook signature
// ---------------------------------------------------------------------------

/**
 * Checks `x-crustdata-signature: t=<unix seconds>,v1=<hex>`, where hex = HMAC-SHA256(apiKey, `${t}.${rawBody}`).
 * Several v1 values are allowed (key rotation). Rejects timestamps more than `toleranceSeconds` away from now.
 * Returns null when valid, or the reason it is not.
 */
export function signatureProblem(header: string | undefined, rawBody: string, secret: string, toleranceSeconds = 300, nowSeconds = Date.now() / 1000): string | null {
  if (!header) return "missing x-crustdata-signature header";
  let timestamp = "";
  const signatures: string[] = [];
  for (const pair of header.split(",")) {
    const [k, v] = pair.trim().split("=", 2);
    if (k === "t") timestamp = v ?? "";
    if (k === "v1" && v) signatures.push(v);
  }
  const t = Number(timestamp);
  if (!t) return "no timestamp in signature header";
  if (t > 1e12) return "timestamp is in milliseconds; expected seconds";
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return "timestamp is outside the 5 minute window";
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const ok = signatures.some(s => /^[0-9a-f]{64}$/i.test(s) && timingSafeEqual(Buffer.from(s, "hex"), expected));
  return ok ? null : "signature does not match (wrong API key, or the body was changed)";
}

export const verifySignature = (header: string | undefined, rawBody: string, secret: string, toleranceSeconds = 300, nowSeconds = Date.now() / 1000): boolean =>
  signatureProblem(header, rawBody, secret, toleranceSeconds, nowSeconds) === null;
