// The only file that talks to Crustdata. Plain fetch, no SDK, so it reads as documentation.
//
//   GET  /account/credits     credits remaining (free)
//   GET  /account/endpoints   which endpoints and premium fields this key can use, prices, rate limits (free)
//   POST /company/identify    domains or names -> Crustdata company id and basic info (free, 25 per call, 30 a minute)
//   POST /company/enrich      company ids -> field groups (2 credits per company, +2 technographics, 25 per call, 15 a minute)
//   POST /person/enrich       profile URLs or business emails -> person record (1 credit per match, 25 per call, 15 a minute)
//   POST /person/search       people at a company by title (0.03 per result + premium groups)
//
// Headers: authorization: Bearer <key>, x-api-version: 2025-11-01. Credits used come back in x-credits-used.
// Docs: https://docs.crustdata.com

export const BASE_URL = "https://api.crustdata.com";
export const API_VERSION = "2025-11-01";
export const BATCH = 25;

/** Default requests per minute per path, replaced by the account's own limits once /account/endpoints is read. */
export const DEFAULT_RPM: Record<string, number> = {
  "/company/identify": 30, "/company/enrich": 15, "/person/enrich": 15, "/person/search": 30,
};

export class CrustdataError extends Error {
  constructor(public status: number, public path: string, message: string, public body?: unknown) {
    super(message);
    this.name = "CrustdataError";
  }
}

export type Spend = { credits: number; byEndpoint: Record<string, number>; calls: number };

export type ClientOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  rpm?: Record<string, number>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called after every response with the credits it cost. */
  onCredits?: (path: string, credits: number) => void;
  /** Sleep function, replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** How many times a 429 is waited out and retried (default 4; 0 for a quick free probe). */
  retries429?: number;
};

export type IdentifyMatch = { confidence_score: number; company_data: any };
export type IdentifyResult = { matched_on: string; match_type: string; matches: IdentifyMatch[] };
export type EnrichResult = { matched_on: string; match_type: string; matches: Array<{ confidence_score: number; company_data: any }> };
export type PersonStatus = "matched" | "not_found" | "redacted" | "invalid";
export type PersonResult = { matched_on: string; match_type: string; match_status: PersonStatus; matches: Array<{ confidence_score: number; person_data: any }> };

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type Client = ReturnType<typeof createClient>;

export function createClient(opts: ClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const rpm: Record<string, number> = { ...DEFAULT_RPM, ...(opts.rpm ?? {}) };
  const windows = new Map<string, number[]>();
  const spend: Spend = { credits: 0, byEndpoint: {}, calls: 0 };

  function setRpm(limits: Record<string, number>) { Object.assign(rpm, limits); }

  /** Waits until a call on this path fits under its per-minute limit. Calls are spread, not burst, so 429s are rare. */
  async function pace(path: string) {
    const limit = rpm[path];
    if (!limit) return;
    for (;;) {
      const now = Date.now();
      const recent = (windows.get(path) ?? []).filter(t => now - t < 60_000);
      if (recent.length < limit) { recent.push(now); windows.set(path, recent); return; }
      await sleep(Math.max(100, recent[0] + 60_000 - now + 50));
    }
  }

  const FREE = new Set(["/company/identify", "/account/credits", "/account/endpoints"]);

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ data: T; credits: number; status: number }> {
    const route = path.split("?")[0];
    for (let attempt = 0; ; attempt++) {
      if (method === "POST") await pace(route);
      let res: Response;
      try {
        res = await doFetch(`${BASE_URL}${path}`, {
          method,
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", "x-api-version": API_VERSION },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 90_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 90_000),
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        // A timed-out paid call may have been billed, so only free calls are retried after a network failure.
        if (attempt < 2 && FREE.has(route)) { await sleep(1500 * (attempt + 1)); continue; }
        throw new CrustdataError(0, route, `Could not reach Crustdata (${(err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message}). Check your connection and try again.`);
      }
      const credits = Number(res.headers.get("x-credits-used") ?? 0) || 0;
      if (credits) { spend.credits = round(spend.credits + credits); spend.byEndpoint[route] = round((spend.byEndpoint[route] ?? 0) + credits); }
      spend.calls++;
      opts.onCredits?.(route, credits);
      if (res.status === 429 && attempt < (opts.retries429 ?? 4)) {
        const wait = Number(res.headers.get("retry-after")) || Number(res.headers.get("x-ratelimit-reset")) || 5;
        await sleep(Math.min(wait + 1, 61) * 1000);
        continue;
      }
      // A 5xx on a paid call may come from a gateway after the backend billed the batch, so only free calls are retried.
      if (res.status >= 500 && attempt < 2 && FREE.has(route)) { await sleep(1500 * (attempt + 1)); continue; }
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; }
      if (!res.ok) {
        const msg = json?.error?.message ?? json?.message ?? json?.detail ?? res.statusText;
        throw new CrustdataError(res.status, route, describe(res.status, route, msg), json);
      }
      return { data: json as T, credits, status: res.status };
    }
  }

  // ---- account ----
  async function credits(): Promise<number | null> {
    const r = await call<any>("GET", "/account/credits");
    const n = r.data?.account?.credits;
    return typeof n === "number" ? n : null;
  }
  async function endpoints(): Promise<any[]> {
    const r = await call<any>("GET", "/account/endpoints");
    return r.data?.endpoints ?? [];
  }

  // ---- companies ----
  async function identifyCompanies(ids: { domains?: string[]; names?: string[] }): Promise<IdentifyResult[]> {
    const r = await call<IdentifyResult[]>("POST", "/company/identify", ids);
    return Array.isArray(r.data) ? r.data : [];
  }

  /** Company enrich. A field group the key cannot read fails the whole call naming the group; it is dropped and the call retried. */
  async function enrichCompanies(companyIds: number[], fields: string[]): Promise<{ results: EnrichResult[]; credits: number; dropped: string[] }> {
    let groups = [...fields];
    const dropped: string[] = [];
    for (;;) {
      try {
        const r = await call<EnrichResult[]>("POST", "/company/enrich", { crustdata_company_ids: companyIds, fields: groups });
        return { results: Array.isArray(r.data) ? r.data : [], credits: r.credits, dropped };
      } catch (err) {
        const bad = invalidFields(err);
        if (!bad.length || !groups.some(g => bad.includes(g))) throw err;
        dropped.push(...bad.filter(g => groups.includes(g)));
        groups = groups.filter(g => !bad.includes(g));
        if (!groups.length) return { results: [], credits: 0, dropped };
      }
    }
  }

  // ---- people ----
  /** Person enrich by profile URL or business email. One malformed address fails the whole batch; those are pulled out and reported as invalid. */
  async function enrichPeople(ids: { urls?: string[]; emails?: string[] }, fields: string[]): Promise<{ results: PersonResult[]; credits: number; dropped: string[] }> {
    const byUrl = !!ids.urls;
    let list = [...(byUrl ? ids.urls! : ids.emails!)];
    let groups = [...fields];
    const invalid: string[] = [];
    const dropped: string[] = [];
    for (;;) {
      if (!list.length) return { results: invalid.map(v => ({ matched_on: v, match_type: byUrl ? "professional_network_profile_url" : "business_email", match_status: "invalid" as const, matches: [] })), credits: 0, dropped };
      try {
        const body = byUrl ? { professional_network_profile_urls: list, fields: groups } : { business_emails: list, fields: groups };
        const r = await call<PersonResult[]>("POST", "/person/enrich", body);
        const results = (Array.isArray(r.data) ? r.data : []).filter(x => x && typeof x === "object").map(x => ({ ...x, match_status: x.match_status ?? (x.matches?.length ? "matched" : "not_found") }));
        for (const v of invalid) results.push({ matched_on: v, match_type: byUrl ? "professional_network_profile_url" : "business_email", match_status: "invalid", matches: [] });
        return { results, credits: r.credits, dropped };
      } catch (err) {
        const badIds = invalidIdentifiers(err);
        if (badIds.length) {
          const bad = new Set(badIds.map(s => s.toLowerCase()));
          const removed = list.filter(v => bad.has(v.toLowerCase()));
          if (!removed.length) throw err;
          invalid.push(...removed);
          list = list.filter(v => !bad.has(v.toLowerCase()));
          continue;
        }
        const badFields = invalidFields(err);
        if (badFields.length && groups.some(g => badFields.includes(g))) {
          dropped.push(...badFields.filter(g => groups.includes(g)));
          groups = groups.filter(g => !badFields.includes(g));
          continue;
        }
        throw err;
      }
    }
  }

  async function searchPeople(body: Record<string, unknown>): Promise<{ profiles: any[]; credits: number }> {
    const r = await call<any>("POST", "/person/search", body);
    return { profiles: r.data?.profiles ?? [], credits: r.credits };
  }

  return { call, credits, endpoints, identifyCompanies, enrichCompanies, enrichPeople, searchPeople, spend, setRpm };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** "Invalid business emails: a@b, c@d" -> ["a@b", "c@d"]. Also "Invalid emails: ..." and "Invalid profile urls: ...". */
export function invalidIdentifiers(err: unknown): string[] {
  if (!(err instanceof CrustdataError) || err.status !== 400) return [];
  const m = err.message.match(/invalid (?:business )?(?:emails?|profile urls?|professional_network_profile_urls)\s*:\s*(.+)$/i);
  if (!m) return [];
  // Identifiers are separated by commas; a profile URL may itself contain a space once decoded, so never split on whitespace.
  return m[1].split(",").map(s => s.trim().replace(/\.$/, "")).filter(Boolean);
}

/** "Invalid fields: technographics" -> ["technographics"]. */
export function invalidFields(err: unknown): string[] {
  if (!(err instanceof CrustdataError) || (err.status !== 400 && err.status !== 403)) return [];
  const m = err.message.match(/invalid fields?\s*:\s*(.+)$/i) ?? err.message.match(/not (?:enabled|available|entitled)[^:]*:\s*(.+)$/i);
  if (!m) return [];
  // Only the list itself, up to the first sentence end; tokens are field paths, nothing else.
  const list = m[1].split(/\.\s|\n|;/)[0];
  return list.split(",").map(s => s.trim().replace(/["']/g, "")).filter(t => /^[a-z_][a-z0-9_.]*$/.test(t));
}

function describe(status: number, path: string, msg: string): string {
  if (status === 401) return "That Crustdata API key was not accepted. Check it at https://app.crustdata.com and try again.";
  if (status === 402) return "Your Crustdata account is out of credits. Top up at https://app.crustdata.com.";
  if (status === 403) return `Your key cannot use ${path}: ${msg}. Contact Crustdata to enable it.`;
  if (status === 429) return "Crustdata rate limit reached. Wait a minute and try again.";
  if (status >= 500) return "Crustdata did not respond. Try again in a minute.";
  return `Crustdata ${path} failed (${status}): ${msg}`;
}
