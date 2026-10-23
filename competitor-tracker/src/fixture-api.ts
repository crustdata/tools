/**
 * A Crustdata API stand-in driven by a fixture file, for tests and `npm run replay`. Fully offline. The fixture holds
 * what the real API would have answered for one weekly run, plus the state the store had before it (last week's page
 * HTML, company records, job counts).
 *
 * Fixture shape (all parts optional):
 * {
 *   "competitors": { "competitors": [{ "name", "domain", "crustdata_company_id", "pages" }], "cities": [] },
 *   "now": "2026-10-26T08:00:00Z",
 *   "state": {
 *     "lastDigestAt": "2026-10-19T08:00:00Z",
 *     "initializedAt": "2026-10-12T08:00:00Z",
 *     "pages": [{ "url", "domain", "title", "html" }],
 *     "companyRecords": { "<domain>": { ...company record... } },
 *     "weeklyJobs": [{ "domain", "week", "newJobs", "recentJobs" }],
 *     "watches": { "company": 1, "job": 2, "social_post": 3 }
 *   },
 *   "api": {
 *     "pages": { "<url>": { "title", "content" } | { "success": false, "http_status": 404 } },
 *     "news": { "<domain>": [{ "title", "url", "snippet" }] },
 *     "runs": { "company" | "job" | "social_post": [{ "run": { "id", "started_at", "status", "new_records_count" }, "records": [] }] },
 *     "jobSearch": { "<domain>": { "total_count", "job_listings": [] } },
 *     "postSearch": { "<domain>": { "posts": [] } },
 *     "identify": { "<domain>": { "id", "name" } },
 *     "enrich": { "<company id>": { ...company record... } }
 *   }
 * }
 */

import { readFileSync } from "node:fs";
import { validateCompetitors, type Competitors } from "./competitors.js";
import { creditsUsed, CrustdataError, FINISHED, type Condition, type Dataset, type Run, type Watch } from "./crustdata.js";
import type { Digest } from "./types.js";
import type { Api } from "./run.js";
import { Store } from "./store.js";
import { parsePage } from "./website.js";

export type Fixture = {
  name?: string;
  description?: string;
  competitors?: unknown;
  now?: string;
  state?: {
    lastDigestAt?: string;
    initializedAt?: string;
    pages?: { url: string; domain: string; title?: string; html?: string; repeat?: { block: string; times: number; before?: string; after?: string } }[];
    /** When the stored company records were taken (defaults to lastDigestAt). */
    recordedAt?: string;
    companyRecords?: Record<string, unknown>;
    weeklyJobs?: { domain: string; week: string; newJobs: number; recentJobs: number | null }[];
    watches?: Partial<Record<Dataset, number>>;
  };
  api?: {
    pages?: Record<string, { title?: string; content?: string; repeat?: { block: string; times: number; before?: string; after?: string }; success?: boolean; http_status?: number }>;
    news?: Record<string, { title: string; url: string; snippet?: string }[]>;
    runs?: Partial<Record<Dataset, { run: Run; records: unknown[]; baseline?: boolean }[]>>;
    jobSearch?: Record<string, { total_count?: number; job_listings?: unknown[] }>;
    postSearch?: Record<string, { posts?: unknown[] }>;
    identify?: Record<string, { id: number; name?: string }>;
    enrich?: Record<string, unknown>;
    /** Watches deleted outside the tool: reading their runs answers 404. */
    deletedWatches?: Dataset[];
    /** HTTP status the credits check answers with (401 rejected key, 402 out of credits). */
    creditsStatus?: number;
    /** HTTP status a watch create answers with, per dataset (403: not enabled on the account). */
    createStatus?: Partial<Record<Dataset, number>>;
    /** HTTP status post search answers with (403: not enabled). */
    postSearchStatus?: number;
    /** What GET /watch/{id} says about each watch (default: active, last run just before `now`). */
    watchInfo?: Partial<Record<Dataset, { status?: string; last_run_at?: string | null; created_at?: string }>>;
    /** Watches already on the account, as GET /watch/... lists them. */
    activeWatches?: Partial<Record<Dataset, unknown[]>>;
  };
};

type Html = { html?: string; content?: string; repeat?: { block: string; times: number; before?: string; after?: string } };
/** Page HTML, or a block repeated N times (keeps fixtures for very large pages small). */
export const expand = (p: Html): string => p.repeat ? `${p.repeat.before ?? ""}${Array.from({ length: p.repeat.times }, (_, i) => p.repeat!.block.replaceAll("{i}", String(i))).join("")}${p.repeat.after ?? ""}` : p.content ?? p.html ?? "";

export function loadFixture(file: string): Fixture {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`Could not read fixture ${file}: ${(err as Error).message}`); }
  if (!parsed || typeof parsed !== "object") throw new Error(`Fixture ${file} must be a JSON object`);
  return parsed as Fixture;
}

export const fixtureCompetitors = (f: Fixture): Competitors =>
  validateCompetitors(f.competitors ?? { competitors: [{ name: "Acme", domain: "acme.example", crustdata_company_id: 1 }] }, "fixture.competitors");

/** An in-memory store holding the fixture's "before" state. */
export function storeFromFixture(f: Fixture): Store {
  const store = new Store(":memory:");
  const s = f.state ?? {};
  if (s.initializedAt) store.setMeta("initialized_at", s.initializedAt);
  if (s.lastDigestAt) {
    const previous: Digest = { week: "previous", from: s.lastDigestAt.slice(0, 10), to: s.lastDigestAt.slice(0, 10), firstRun: false, competitors: [], creditsUsed: 0, watcherCredits: 0, warnings: [] };
    const id = store.saveDigest(previous, "previous digest", s.lastDigestAt);
    store.markDigestSent(id, "slack");
    store.markDigestSent(id, "email");
  }
  const recordedAt = s.recordedAt ?? s.lastDigestAt ?? new Date(0).toISOString();
  for (const p of s.pages ?? []) {
    store.savePage(parsePage(p.url, p.domain, expand(p), p.title, s.lastDigestAt ?? new Date(0).toISOString()));
    store.setMeta(`pages_discovered_${p.domain}`, recordedAt);
  }
  for (const [domain, record] of Object.entries(s.companyRecords ?? {})) store.saveCompanyRecord(domain, record, recordedAt);
  for (const w of s.weeklyJobs ?? []) store.addWeeklyJobs(w.domain, w.week, w.newJobs, w.recentJobs);
  for (const [ds, id] of Object.entries(s.watches ?? {})) store.setWatchId(ds as Dataset, id as number);
  return store;
}

const leaf = (c: Condition, field: string): any => {
  if ("op" in c) return c.conditions.map(x => leaf(x, field)).find(v => v !== undefined);
  return c.field === field ? c.value : undefined;
};

/** The Api interface, answered from the fixture. Records every call so tests can assert on cost and order. */
export function fixtureApi(f: Fixture): Api & { calls: string[]; created: { dataset: Dataset; body: unknown }[] } {
  const api = f.api ?? {};
  const calls: string[] = [];
  const created: { dataset: Dataset; body: unknown }[] = [];
  let nextId = 900;
  const domainOf = (filters: Condition): string => {
    const v = leaf(filters, "company.basic_info.primary_domain");
    return Array.isArray(v) ? v[0] : String(v ?? "");
  };
  const companyIdOf = (filters: Condition): number | undefined => leaf(filters, "actor.crustdata_entity_id");
  const comps = fixtureCompetitors(f);
  /** Charges what the real API would, at list prices, so a replay's cost line reads like a real run's. */
  const charge = (n: number) => { creditsUsed.total += n; };
  const failCreate = (ds: Dataset) => { const status = api.createStatus?.[ds]; if (status) throw new CrustdataError(status, `POST /watch/${ds}`, "not enabled for this account"); };
  return {
    calls,
    created,
    async identifyCompanies(inputs, by = "domains") {
      calls.push(`identify:${by}:${inputs.join(",")}`);
      return inputs.map(input => { const hit = api.identify?.[input.toLowerCase()]; return hit ? { input, id: hit.id, name: hit.name ?? input, domain: input } : { input }; });
    },
    async enrichCompanies(ids) {
      calls.push(`enrich:${ids.join(",")}`);
      const found = ids.filter(id => api.enrich?.[String(id)]);
      charge(2 * found.length);
      return Object.fromEntries(found.map(id => [id, api.enrich![String(id)]]));
    },
    async searchJobs(filters, o) {
      const domain = domainOf(filters);
      calls.push(`jobs:${domain}:limit=${o.limit}`);
      const hit = api.jobSearch?.[domain] ?? {};
      if (o.limit === 0) return { job_listings: [], total_count: hit.total_count ?? 0 };
      const listings = ((hit.job_listings ?? []) as any[]).slice(0, o.limit);
      charge(0.03 * listings.length);
      return { job_listings: listings, total_count: hit.total_count };
    },
    async searchPosts(filters, o) {
      if (api.postSearchStatus) throw new CrustdataError(api.postSearchStatus, "POST /social_post/search", "not enabled");
      const id = companyIdOf(filters);
      const c = comps.competitors.find(x => x.crustdata_company_id === id);
      calls.push(`posts:${c?.domain ?? id}:limit=${o.limit}`);
      const posts = (((c && api.postSearch?.[c.domain]?.posts) ?? []) as any[]).slice(0, o.limit);
      charge(0.5 * posts.length);
      return { posts };
    },
    async fetchPages(urls) {
      calls.push(`fetch:${urls.join(",")}`);
      return urls.map(url => {
        const p = api.pages?.[url];
        if (!p || p.success === false) return { url, success: false, title: null, content: null, http_status: p?.http_status ?? 404 };
        charge(1);
        return { url, success: true, title: p.title ?? null, content: expand(p), http_status: 200 };
      });
    },
    async searchNews(query) {
      const name = /"([^"]+)"/.exec(query)?.[1] ?? "";
      const domain = comps.competitors.find(c => c.name === name)?.domain ?? query.split(" ").pop() ?? "";
      calls.push(`news:${domain}`);
      charge(1);
      return (api.news?.[domain] ?? []).map(n => ({ ...n, source: "news" }));
    },
    async createCompanyWatch(ids) { failCreate("company"); calls.push(`create:company`); created.push({ dataset: "company", body: ids }); return { id: nextId++, status: "active", created_at: f.now, credits: { per_notification: 5 } } as Watch; },
    async createJobWatch(domains, max) { failCreate("job"); calls.push(`create:job`); created.push({ dataset: "job", body: { domains, max } }); return { id: nextId++, status: "active", created_at: f.now, credits: { per_notification: 0.5 } } as Watch; },
    async createPostWatch(companies, keywords, max) { failCreate("social_post"); calls.push(`create:social_post`); created.push({ dataset: "social_post", body: { companies, keywords, max } }); return { id: nextId++, status: "active", created_at: f.now, credits: { per_notification: 2 } } as Watch; },
    async getWatch(ds, id) {
      calls.push(`get:${ds}:${id}`);
      const info = api.watchInfo?.[ds] ?? {};
      return { id, dataset: ds, status: info.status ?? "active", last_run_at: info.last_run_at === undefined ? f.now ?? null : info.last_run_at, created_at: info.created_at ?? "2000-01-01T00:00:00Z" } as Watch;
    },
    async setWatchStatus(ds, id, status) { calls.push(`status:${ds}:${id}:${status}`); return { id, status } as Watch; },
    async setWatchedCompanies(id, ids) { calls.push(`patch:company:${id}:${ids.join(",")}`); return { id, status: "active" } as Watch; },
    async deleteWatch(ds, id) { calls.push(`delete:${ds}:${id}`); },
    async newRunRecords(ds, id, seen) {
      calls.push(`runs:${ds}:${id}`);
      if (api.deletedWatches?.includes(ds)) throw new CrustdataError(404, `GET /watch/${ds}/${id}/runs`, "not found");
      const all = api.runs?.[ds] ?? [];
      const out = all
        .filter(r => !seen.has(r.run.id) && FINISHED.has(r.run.status))
        .sort((a, b) => a.run.id - b.run.id)
        .map(r => ({ run: r.run, records: r.baseline ? [] : (r.records as any[]), baseline: Boolean(r.baseline) }));
      return Object.assign(out, { pending: all.some(r => !FINISHED.has(r.run.status)) });
    },
    async listRuns(ds, id) {
      calls.push(`listRuns:${ds}:${id}`);
      const runs = (api.runs?.[ds] ?? []).map(r => r.run).sort((a, b) => b.id - a.id);
      return { runs, next_cursor: null };
    },
    async listActiveWatches(ds) { calls.push(`list:${ds}`); return (api.activeWatches?.[ds] ?? []) as Watch[]; },
    async getCreditBalance() {
      if (api.creditsStatus) throw new CrustdataError(api.creditsStatus, "GET /account/credits", api.creditsStatus === 402 ? "out of credits" : "invalid key");
      return 1000;
    },
  };
}
