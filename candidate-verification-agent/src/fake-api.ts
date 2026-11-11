/**
 * A stand-in for the Crustdata API, fed from a fixture file. Used by `npm run replay` and by the tests, so a whole
 * run (reading the file, email lookup, profile details, verification jobs, the results file, the output) works
 * offline with no key and no credits. It answers in the shapes the live API returned on 2026-11-11.
 */

import { gzipSync } from "node:zlib";
import { clock } from "./crustdata.js";
import type { Endpoint, MatchResult, PersonData, VerifyData } from "./crustdata.js";
import { normalizeProfileUrl } from "./profile-url.js";

export type Fixture = {
  description?: string;
  /** The candidate file to read, relative to the project folder. */
  input: string;
  argv?: string[];
  /** What the key can use. Default: everything, including verification. */
  access?: { verify?: boolean; assessment?: boolean; identify?: boolean };
  /** Enrich answers by profile URL. A URL not here is "not found". */
  people: Record<string, PersonData>;
  /** Identify answers by email. An email not here is "not found". */
  identify?: Record<string, MatchResult>;
  /** Verification records by profile URL. A URL not here is left out of the results file (no verdict). */
  verify?: Record<string, VerifyData>;
  /** Status polls before a job completes (default 1). */
  polls?: number;
  /** The first n verification jobs fail (to test the free retry). */
  failJobs?: number;
  /**
   * Failures to inject, for tests: the nth call (from 1) to a path answers with this status and message. With
   * `after`, the request is carried out first (a job is created) and then the answer is lost: the hardest case.
   */
  faults?: Array<{ path: string; call: number; status: number; message?: string; after?: boolean }>;
  /** Jobs that already exist on the account (another person's runs), for tests. */
  otherJobs?: Array<{ urls: string[]; status?: string; agoMinutes?: number }>;
};

export type Call = { method: string; path: string; body: any };

const json = (data: unknown, status = 200, credits = 0) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-credits-used": String(credits) } });

export function endpointsFor(access: Fixture["access"] = {}): Endpoint[] {
  const { verify = true, assessment = true, identify = true } = access;
  return [
    { path: "/person/enrich", status: "enabled", fields: { enabled: ["basic_profile", "experience", "education", "social_handles", ...(assessment ? ["assessment", "assessment.authenticity"] : [])], disabled: assessment ? [] : ["assessment"] }, base_credits: 1 },
    { path: "/person/identify", status: identify ? "enabled" : "disabled", fields: { enabled: [], disabled: [] } },
    { path: "/batch/person/verify", status: verify ? "enabled" : "disabled", fields: { enabled: [], disabled: [] }, base_credits: 10 },
  ];
}

const STORAGE = "https://crustdata-batch-api-data.s3.amazonaws.com";

/** Returns a fetch that serves the fixture, and the list of calls it received (for tests). */
export function fakeFetch(fx: Fixture): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const jobs = new Map<string, { urls: string[]; polls: number; fail: boolean; created: string }>();
  let jobNo = 0;
  for (const o of fx.otherJobs ?? []) {
    jobNo++;
    jobs.set(`00000000-0000-4000-9000-${String(jobNo).padStart(12, "0")}`, { urls: o.urls, polls: o.status === "processing" ? 1e9 : 0, fail: false, created: new Date(clock.now() - (o.agoMinutes ?? 0) * 60_000).toISOString() });
  }
  const access = fx.access ?? {};

  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.origin === STORAGE ? "/download" : url.pathname.replace(/^\/batch\/[0-9a-f-]{36}$/, "/batch/{id}");
    calls.push({ method, path, body });
    counts.set(path, (counts.get(path) ?? 0) + 1);
    const fault = fx.faults?.find(f => f.path === path && f.call === counts.get(path));
    if (fault && !fault.after) return json({ error: { type: "fault", message: fault.message ?? `injected ${fault.status}` } }, fault.status);
    const answer = await serve(url, path, method, body);
    if (fault?.after) return json({ error: { type: "fault", message: fault.message ?? `injected ${fault.status} after the request was carried out` } }, fault.status);
    return answer;
  };

  const serve = async (url: URL, path: string, method: string, body: any): Promise<Response> => {

    if (path === "/account/endpoints") return json({ api_version: "2025-11-01", endpoints: endpointsFor(access) });
    if (path === "/account/credits") return json({ account: { credits: 1000 } });

    if (path === "/person/identify") {
      if (access.identify === false) return json({ error: { type: "permission_error", message: "You do not have permission to access /person/identify." } }, 403);
      const emails: string[] = body.emails ?? [];
      let matched = 0;
      const out = emails.map(e => {
        const r = fx.identify?.[e.toLowerCase()];
        if (r?.match_status === "matched") matched++;
        return r ? { matched_on: e, ...r } : { matched_on: e, match_type: "email", match_status: "not_found", matches: [] };
      });
      return json(out, 200, matched);
    }

    if (path === "/person/enrich") {
      const fields: string[] = body.fields ?? [];
      if (access.assessment === false && fields.includes("assessment")) return json({ error: { type: "permission_error", message: "Access denied to fields: assessment." } }, 403);
      let matched = 0;
      const out = (body.professional_network_profile_urls as string[]).map(u => {
        const p = fx.people[normalizeProfileUrl(u) ?? ""];
        if (!p) return { matched_on: u, match_type: "professional_network_profile_url", match_status: "not_found", matches: [] };
        matched++;
        const { assessment, ...rest } = p;
        return { matched_on: u, match_type: "professional_network_profile_url", match_status: "matched", matches: [{ confidence_score: 1, person_data: fields.includes("assessment") ? p : rest }] };
      });
      return json(out, 200, matched);
    }

    if (path === "/batch/person/verify") {
      if (access.verify === false) return json({ error: { type: "permission_error", message: "You do not have permission to access /batch/person/verify." } }, 403);
      const urls: string[] = body.professional_network_profile_urls ?? [];
      if (!urls.length) return json({ error: { type: "invalid_request", message: "Exactly one identifier must be provided: professional_network_profile_urls or business_emails" } }, 400);
      if ([...jobs.values()].filter(j => j.polls > 0 && !j.fail).length >= 5) return json({ error: { type: "rate_limit", message: "Too many active batch jobs" } }, 429);
      jobNo++;
      const id = `00000000-0000-4000-8000-${String(jobNo).padStart(12, "0")}`;
      jobs.set(id, { urls, polls: fx.polls ?? 1, fail: jobNo - (fx.otherJobs?.length ?? 0) <= (fx.failJobs ?? 0), created: new Date(clock.now()).toISOString() });
      return json({ batch_id: id, status: "pending", entity: "person", action: "verify", identifier_count: urls.length, entities_requested: urls.length, status_url: `/batch/${id}` });
    }

    if (path === "/batch/{id}") {
      const id = url.pathname.split("/").pop()!;
      const job = jobs.get(id);
      if (!job) return json({ error: { type: "not_found", message: "Batch job not found" } }, 404);
      const base = { batch_id: id, entity: "person", action: "verify", identifier_count: job.urls.length, entities_requested: job.urls.length, created_at: job.created };
      if (job.polls > 0) { job.polls--; return json({ ...base, status: "processing", result_count: 0, entities_fulfilled: 0, completed_at: null }); }
      if (job.fail) return json({ ...base, status: "failed", result_count: 0, entities_fulfilled: 0, completed_at: job.created, error_message: "Upstream timeout" });
      const n = job.urls.filter(u => fx.verify?.[normalizeProfileUrl(u) ?? ""]).length;
      return json({ ...base, status: "completed", result_count: n, entities_fulfilled: n, completed_at: job.created, download_url: `${STORAGE}/${id}/output/results.jsonl.gz?X-Amz-Signature=offline` });
    }

    if (path === "/batch/") {
      return json({ jobs: [...jobs.entries()].reverse().map(([id, j]) => {
        const n = j.urls.filter(u => fx.verify?.[normalizeProfileUrl(u) ?? ""]).length;
        return { batch_id: id, status: j.polls > 0 ? "processing" : j.fail ? "failed" : "completed", entity: "person", action: "verify", identifier_count: j.urls.length, result_count: j.polls > 0 ? 0 : n, created_at: j.created };
      }), next_cursor: null, has_more: false });
    }

    if (path === "/download") {
      const id = url.pathname.split("/")[1];
      const job = jobs.get(id);
      if (!job) return new Response("NoSuchKey", { status: 404 });
      const lines = job.urls
        .map(u => [u, fx.verify?.[normalizeProfileUrl(u) ?? ""]] as const)
        .filter(([, d]) => d)
        .map(([u, data], i) => JSON.stringify({ original_identifier: u, internal_id: 1000 + i, data }));
      return new Response(gzipSync(Buffer.from(lines.join("\n") + "\n")), { status: 200, headers: { "content-type": "application/gzip" } });
    }

    return json({ error: { message: `The offline fixture has no answer for ${method} ${url.pathname}` } }, 404);
  };
  return { fetch: fn as typeof fetch, calls };
}
