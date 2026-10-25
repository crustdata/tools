/**
 * Crustdata API client: the only file that talks to Crustdata. Plain REST, no SDK, so it reads as documentation.
 *
 *   POST /person/enrich        the profile: by profile URL, or by work email (business_emails). 1 credit per match
 *   POST /person/contact/enrich  work email, personal email, phone, only with --contact (enabled per account)
 *   POST /person/identify      any email (personal too, or name at the company's domain) to a person. 1 credit per match
 *   POST /person/search        name (plus company) to a short list of people. 0.03 per person returned + premium filter
 *   POST /social_post/search   the person's most recent posts. 0.5 per post; a count with limit 0 is free
 *   POST /web/search/live      web and news results about the person. 1 credit per query (docs); 0 seen when empty
 *   GET  /account/credits      credit balance, free
 *   GET  /account/endpoints    what this key can use and at what price, free
 *
 * Misses are free on the person endpoints above. Docs: https://docs.crustdata.com
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";

const BASE_URL = "https://api.crustdata.com";
const API_VERSION = "2025-11-01";

/** Credits this process has spent, summed from the x-credits-used header of every response. */
export const spend = { credits: 0 };
/** Credits per research() call, kept apart even when several run at once in one process. */
export const meter = new AsyncLocalStorage<{ credits: number; denied?: Set<string> }>();
export const fmtCredits = (n: number): string => String(Math.round(n * 100) / 100);

/** Space between two calls to the same endpoint, under its published per-minute limit. Tests turn it off. */
export const pacing = { on: true };
const MIN_GAP_MS: Record<string, number> = {
  "/person/enrich": 4_100,        // 15 a minute
  "/person/identify": 2_100,      // 30 a minute
  "/person/contact/enrich": 4_100, // 15 a minute
  "/person/search": 2_100,        // 30 a minute
  "/social_post/search": 2_100,   // 30 a minute
  "/web/search/live": 6_100,      // 10 a minute
};
const lastCall = new Map<string, number>();

export class CrustdataError extends Error {
  constructor(public status: number, message: string, public apiMessage = "") { super(message); }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A plain next step for each kind of failure, instead of a stack trace. */
function explainStatus(status: number, method: string, path: string, apiMessage: string): string {
  const said = apiMessage ? `: ${apiMessage}` : "";
  if (status === 401) return "Crustdata rejected the API key (401). Copy it again from https://app.crustdata.com and run npm run setup. If CRUSTDATA_API_KEY is also set in your shell, update or unset it there too (the shell wins over .env).";
  if (status === 402 || /insufficient credits|out of credits/i.test(apiMessage)) return `Your Crustdata account is out of credits (${status}). Top up at https://app.crustdata.com, then run again.`;
  if (status === 403) return `Crustdata refused ${method} ${path} for this key (403)${said}`;
  if (status === 429) return "Crustdata is still rate limiting this key (429) after waiting. Wait a minute and run again.";
  if (status >= 500) return `Crustdata had a server error on ${method} ${path} (${status}). Run again in a minute; people already researched are saved and cost nothing again.`;
  return `Crustdata could not run ${method} ${path} (${status})${said}`;
}

/**
 * One request, paced under the endpoint's rate limit, with up to two retries on 429 (waiting until the window
 * resets), 502, 503 and connections that never opened. Every POST here is billed, so a timeout, a reset connection or
 * another 5xx is not retried (it may have been billed) and the message says so.
 */
async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const key = config.crustdataApiKey;
  const billed = method === "POST";
  for (let attempt = 0; ; attempt++) {
    // Each call reserves its slot before waiting, so concurrent runs in one process stay under the limit too.
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
      throw new CrustdataError(0, `Could not reach Crustdata (${method} ${path}): ${(err as Error).message}.${billed && !neverSent ? " The request may have been billed." : ""} Check your connection and run again; people already researched are saved.`);
    }
    const header = res.headers.get("x-credits-used");
    const charged = Number(header ?? 0) || 0;
    spend.credits += charged;
    const run = meter.getStore();
    if (run) run.credits += charged;

    // 502 and 503 are retried on billed calls only when the answer says nothing was charged.
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
    if (res.ok && unreadable) throw new CrustdataError(res.status, `Crustdata sent an answer to ${method} ${path} that is not JSON (a proxy or network page?).${charged ? ` It reported ${charged} credits used.` : ""} Run again in a minute.`);
    if (!res.ok) {
      const apiMessage = String(json?.error?.message ?? json?.message ?? res.statusText ?? "");
      throw new CrustdataError(res.status, explainStatus(res.status, method, path, apiMessage), apiMessage);
    }
    return json as T;
  }
}

// ---------------------------------------------------------------------------
// Shapes, as the live API returned them on 2026-10-23 (only the fields this tool reads)
// ---------------------------------------------------------------------------

export type Role = {
  title?: string | null;
  name?: string | null;                         // employer name as written on the profile
  start_date?: string | null;                   // ISO timestamp, month precision: "2024-01-01T00:00:00+00:00"
  end_date?: string | null;
  is_default?: boolean | null;                  // the main role when someone holds several
  employment_type?: string | null;
  seniority_level?: string | null;
  location?: { raw?: string | null } | string | null;
  description?: string | null;
  position_id?: string | number | null;
  crustdata_company_id?: number | string | null;
  company_website_domain?: string | null;
  company_website?: string | null;
  company_headcount_latest?: number | null;
  company_headcount_range?: string | null;
  company_industries?: string[] | null;
  company_professional_network_industry?: string | null;
  company_description?: string | null;
  company_status?: string | null;
  years_at_company_raw?: number | string | null;
};

export type School = {
  school?: string | null;
  degree?: string | null;
  field_of_study?: string | null;
  start_year?: number | null;
  end_year?: number | null;
};

export type Email = { email?: string; status?: string };

export type PersonData = {
  crustdata_person_id?: number;
  updated_at?: string | null;
  basic_profile?: {
    name?: string | null;
    headline?: string | null;
    current_title?: string | null;
    summary?: string | null;
    languages?: string[] | null;
    normalized_title?: { department?: string | null; sub_department?: string | null; confident?: boolean | null } | null;
    location?: { raw?: string | null; city?: string | null; state?: string | null; country?: string | null } | null;
  } | null;
  professional_network?: { connections?: number | null; followers?: number | null } | null;
  social_handles?: {
    professional_network_identifier?: { profile_url?: string | null } | null;
    dev_platform_identifier?: { profile_url?: string | null } | null;
    twitter_identifier?: { slug?: string | null } | null;
  } | null;
  experience?: {
    years_of_experience?: string | null;
    years_of_experience_raw?: number | null;
    employment_details?: { current?: Role[] | null; past?: Role[] | null } | null;
  } | null;
  education?: { schools?: School[] | null } | null;
  skills?: { professional_network_skills?: string[] | null } | null;
  certifications?: Array<{ name?: string | null; issuing_organization?: string | null; issue_date?: string | null }> | null;
  honors?: Array<{ title?: string | null; issuer?: string | null; issued_date?: string | null }> | null;
  contact?: { business_emails?: Email[] | null; personal_emails?: Email[] | null; phone_numbers?: string[] | null } | null;
};

/** One row per identifier, in request order: matched, not_found or redacted (never returned, never charged). */
export type MatchRow = {
  matched_on?: string;
  match_type?: string;
  match_status?: "matched" | "not_found" | "redacted" | string;
  matches?: Array<{ confidence_score?: number | string; person_data?: PersonData }>;
};

export type Post = {
  share_url?: string | null;
  text?: string | null;
  post_type?: string | null;
  date_posted?: string | null;
  engagement?: { total_reactions?: number | null; total_comments?: number | null; num_shares?: number | null; reactions_by_type?: Record<string, number> | null } | null;
};

export type WebResult = { source?: string; title?: string | null; url?: string | null; snippet?: string | null; position?: number };

export type Candidate = {
  crustdata_person_id?: number;
  basic_profile?: { name?: string | null; headline?: string | null; current_title?: string | null; location?: { raw?: string | null; full_location?: string | null } | null } | null;
  social_handles?: { professional_network_identifier?: { profile_url?: string | null } | null } | null;
};

// ---------------------------------------------------------------------------
// Person enrich. 25 identifiers per call, 15 calls a minute.
// ---------------------------------------------------------------------------

/** The sections every brief reads. All are in the 1 credit base profile. */
export const BRIEF_FIELDS = [
  "crustdata_person_id", "updated_at", "basic_profile", "professional_network", "social_handles",
  "experience", "education", "skills", "certifications", "honors",
];

export type ContactKind = "business" | "personal" | "phone";
/** Extra credits per matched person, from /account/endpoints and the pricing page. */
export const CONTACT_FIELDS: Record<ContactKind, { field: string; credits: number }> = {
  business: { field: "contact.business_emails", credits: 1 },
  personal: { field: "contact.personal_emails", credits: 2 },
  phone: { field: "contact.phone_numbers", credits: 2 },
};

/**
 * Enrich by profile URL or by work email. A field group this key may not read (for example contact data on a
 * self-serve key) fails the whole call with "Access denied to fields"; that group is dropped, said once through
 * `note`, and the call is sent again without it.
 */
/** Field groups this key may not read: per research() run when one is running (the meter's set), else process-wide. */
const processDenied = new Set<string>();
export const deniedFieldsNow = (): Set<string> => meter.getStore()?.denied ?? processDenied;

export async function enrich(by: "profile_url" | "business_email", ids: string[], fields: string[], note: (msg: string) => void = () => {}): Promise<MatchRow[]> {
  const out: MatchRow[] = [];
  const deniedNow = deniedFieldsNow();
  let use = fields.filter(f => !deniedNow.has(f));
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    const key = by === "profile_url" ? "professional_network_profile_urls" : "business_emails";
    let send = batch;
    for (;;) {
      try {
        if (!send.length) break;
        const r = await request<MatchRow[]>("POST", "/person/enrich", { [key]: send, fields: use });
        out.push(...(Array.isArray(r) ? r : []));
        break;
      } catch (err) {
        // One address Crustdata refuses would fail the whole batch: take it out and send the rest.
        const bad = err instanceof CrustdataError && err.status === 400 ? /Invalid (?:business )?emails?:\s*(.+)$/i.exec(err.apiMessage) : null;
        if (bad && by === "business_email") {
          const refused = new Set(bad[1].split(",").map(x => x.trim().toLowerCase()));
          const left = send.filter(e => !refused.has(e.toLowerCase()));
          if (left.length < send.length) {
            out.push(...send.filter(e => refused.has(e.toLowerCase())).map(e => ({ matched_on: e, match_type: "business_email", match_status: "not_found", matches: [] })));
            send = left;
            continue;
          }
        }
        const denied = deniedFields(err);
        const drop = use.filter(f => denied.some(d => f === d || f.startsWith(`${d}.`) || d.startsWith(`${f}.`)));
        if (!drop.length) throw err;
        use = use.filter(f => !drop.includes(f));
        drop.forEach(f => deniedNow.add(f));
        note(`This key cannot read ${drop.join(", ")}, so briefs go without ${drop.length > 1 ? "them" : "it"}. Ask Crustdata to enable ${drop.length > 1 ? "these fields" : "this field"} on your key.`);
      }
    }
  }
  return out;
}

/** Field names from a 403 "Access denied to fields: a, b" or a 400 "Invalid fields: a". */
export function deniedFields(err: unknown): string[] {
  if (!(err instanceof CrustdataError) || (err.status !== 403 && err.status !== 400)) return [];
  const m = /(?:Access denied to fields|Invalid fields):\s*([\w.,\s]+)/i.exec(err.apiMessage);
  return m ? m[1].split(",").map(s => s.trim().split(/\s/)[0].replace(/\.$/, "")).filter(Boolean) : [];
}

/**
 * Contact data only, by profile URL: billed per contact type found (no base credit), so asking for contacts after a
 * brief never pays for the profile twice. Enabled per account; self-serve keys get 403.
 */
export async function enrichContacts(urls: string[], kinds: ContactKind[]): Promise<MatchRow[]> {
  const out: MatchRow[] = [];
  for (let i = 0; i < urls.length; i += 25) {
    const r = await request<MatchRow[]>("POST", "/person/contact/enrich", { professional_network_profile_urls: urls.slice(i, i + 25), fields: kinds.map(k => CONTACT_FIELDS[k].field) });
    out.push(...(Array.isArray(r) ? r : []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Person identify. Any email, personal ones included. Enabled per account (403 otherwise).
// ---------------------------------------------------------------------------

/**
 * One address Crustdata does not accept fails the whole batch with 400 "Invalid emails: a, b". Those addresses are
 * taken out and the rest sent again; they come back as `invalid`.
 */
export async function identifyEmails(emails: string[]): Promise<{ rows: MatchRow[]; invalid: string[] }> {
  const rows: MatchRow[] = [];
  const invalid: string[] = [];
  for (let i = 0; i < emails.length; i += 25) {
    let batch = emails.slice(i, i + 25);
    while (batch.length) {
      try {
        const r = await request<MatchRow[]>("POST", "/person/identify", { emails: batch });
        rows.push(...(Array.isArray(r) ? r : []));
        break;
      } catch (err) {
        const m = err instanceof CrustdataError && err.status === 400 ? /Invalid emails:\s*(.+)$/i.exec(err.apiMessage) : null;
        if (!m) throw err;
        const bad = new Set(m[1].split(",").map(s => s.trim().toLowerCase()));
        const before = batch.length;
        invalid.push(...batch.filter(e => bad.has(e.toLowerCase())));
        batch = batch.filter(e => !bad.has(e.toLowerCase()));
        if (batch.length === before) throw err;
      }
    }
  }
  return { rows, invalid };
}

// ---------------------------------------------------------------------------
// Person search by name, for "--name Jane Doe --company Acme". 30 calls a minute.
// ---------------------------------------------------------------------------

/**
 * Up to `limit` people whose name contains the phrase, at the company when one is given (a domain such as acme.com
 * matches the employer's website exactly; a name matches the employer name as a phrase). Returns no experience data,
 * so it bills the 0.03 base per person plus the experience filter when a company is given.
 */
export async function searchByName(name: string, company: string | undefined, limit = 5, scope: "current" | "any" = "current"): Promise<{ people: Candidate[]; total: number }> {
  const conditions: unknown[] = [{ field: "basic_profile.name", type: "[.]", value: name }];
  if (company) {
    const domain = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#].*)?$/i.exec(company.trim());
    const where = scope === "current" ? "experience.employment_details.current" : "experience.employment_details";
    conditions.push(domain
      ? { field: `${where}.company_website_domain`, type: "=", value: domain[1].toLowerCase() }
      : { field: `${where}.${scope === "current" ? "name" : "company_name"}`, type: "[.]", value: companyName(company) });
  }
  const r = await request<{ profiles?: Candidate[]; total_count?: number }>("POST", "/person/search", {
    filters: { op: "and", conditions },
    fields: ["crustdata_person_id", "basic_profile.name", "basic_profile.headline", "basic_profile.current_title", "basic_profile.location", "social_handles.professional_network_identifier.profile_url"],
    limit,
  });
  const people = r?.profiles ?? [];
  return { people, total: r?.total_count ?? people.length };
}

/** "Acme, Inc." to "Acme": legal suffixes rarely appear in the employer name people put on profiles. */
export const companyName = (s: string): string =>
  s.trim().replace(/[,\s]+(inc|incorporated|llc|l\.l\.c|ltd|limited|gmbh|corp|corporation|co|plc|s\.?a|ag|b\.?v|pty|pvt|srl|sas|oy|ab)\.?$/i, "").trim() || s.trim();

// ---------------------------------------------------------------------------
// Posts the person wrote, newest first. 0.5 per post returned; limit 0 is a free count.
// ---------------------------------------------------------------------------

/**
 * `post_type = original` keeps the posts they wrote. Without it, other people's reposts of their posts come back too
 * (those rows carry the person as the author and someone else as `reposter`), each billed as a post.
 */
export async function recentPosts(personId: number, limit: number): Promise<{ posts: Post[]; total: number | null }> {
  const r = await request<{ posts?: Post[]; total_count?: number }>("POST", "/social_post/search", {
    filters: { op: "and", conditions: [
      { field: "actor.crustdata_entity_id", type: "=", value: personId },
      { field: "actor.actor_type", type: "=", value: "person" },
      { field: "post_type", type: "=", value: "original" },
    ] },
    sorts: [{ field: "date_posted", order: "desc" }],
    ...(limit > 0 ? { fields: ["share_url", "text", "post_type", "date_posted", "engagement"] } : {}),
    limit,
  });
  return { posts: r?.posts ?? [], total: typeof r?.total_count === "number" ? r.total_count : null };
}

// ---------------------------------------------------------------------------
// Web Search. 1 credit per query (the docs' price; an empty search cost 0 on 2026-10-23). 10 calls a minute.
// ---------------------------------------------------------------------------

/** `since` is a unix time in seconds. Results carry no date; the window comes from `start_date`. */
export async function webSearch(query: string, source: "web" | "news", since?: number): Promise<WebResult[]> {
  const r = await request<{ results?: WebResult[] }>("POST", "/web/search/live", { query, sources: [source], ...(since ? { start_date: since } : {}) });
  return (r?.results ?? []).filter(x => x && typeof x.url === "string");
}

// ---------------------------------------------------------------------------
// Account (free)
// ---------------------------------------------------------------------------

export type Endpoint = {
  path: string;
  status?: string;
  base_credits?: number;
  premium_fields?: Array<{ field: string; credits: number }>;
  fields?: { enabled?: string[]; disabled?: string[] };
};

export async function accountEndpoints(): Promise<Endpoint[]> {
  const r = await request<Endpoint[] | { endpoints?: Endpoint[] }>("GET", "/account/endpoints");
  return Array.isArray(r) ? r : r?.endpoints ?? [];
}

export async function creditBalance(): Promise<number | undefined> {
  const r = await request<{ account?: { credits?: number } }>("GET", "/account/credits");
  return r?.account?.credits;
}
