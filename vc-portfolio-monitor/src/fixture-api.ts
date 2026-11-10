/**
 * A Crustdata stand-in driven by a fixture file, for tests and `npm run replay`. Fully offline. A fixture holds the
 * state before a run (companies, leaders, reference records, careers readings) and what the API would answer.
 *
 * {
 *   "now": "2026-10-26T08:00:00Z",
 *   "state": {
 *     "companies": [{ "domain", "name", "companyId", "owner", "careersUrl", "hiringSource", "addedAt", "start" }],
 *     "refs": { "<domain>": { "record": {...}, "recordedAt": "..." } },
 *     "leaders": [{ "profileUrl", "personId", "name", "title", "role", "domain" }],
 *     "readings": [{ "domain", "at", "roles", "source" }],
 *     "watches": { "company": 1, "person": 2 },
 *     "lastDigestAt": "...", "lastCheckAt": "..."
 *   },
 *   "api": {
 *     "runs": { "company" | "person": [{ "run": { "id", "started_at", "status", "new_records_count", "credits_deducted" }, "records": [] }] },
 *     "pages": { "<url>": { "roles": 12 } | { "content": "<html>" } | { "success": false, "http_status": 404 } },
 *     "jobIndex": { "<company id>": 7 },
 *     "identify": { "domains": { "<domain>": [match] }, "names": { "<name>": [match] } },
 *     "enrich": { "<company id>": {...} }, "leaders": { "<company id>": [person] }, "people": { "<url>": {...} },
 *     "watchInfo": { "company": { "status": "paused" } }, "activeWatches": { "company": [...] }, "deletedWatches": ["person"]
 *   }
 * }
 */

import { readFileSync } from "node:fs";
import { creditsUsed, CrustdataError, FINISHED, type CompanyMatch, type Dataset, type FoundPerson, type Run, type Watch } from "./crustdata.js";
import type { Leader } from "./leaders.js";
import type { Api } from "./run.js";
import { Store, type Company } from "./store.js";
import type { Signal } from "./types.js";

export type Fixture = {
  name?: string;
  description?: string;
  now?: string;
  state?: {
    companies?: Company[];
    refs?: Record<string, { record: unknown; recordedAt: string }>;
    /** More headcount readings (the reference record's total is one already). */
    points?: { domain: string; at: string; total: number }[];
    leaders?: (Omit<Leader, "company" | "companyId"> & { source?: "search" | "csv" })[];
    readings?: { domain: string; at: string; roles: number; source?: string }[];
    watches?: Partial<Record<Dataset, number>>;
    lastDigestAt?: string;
    lastCheckAt?: string;
    /** Signals saved before (for example a starting-point flag from import). */
    signals?: (Signal & { createdAt?: string })[];
  };
  api?: {
    runs?: Partial<Record<Dataset, { run: Run; records: unknown[]; baseline?: boolean }[]>>;
    pages?: Record<string, { roles?: number; content?: string; success?: boolean; http_status?: number }>;
    jobIndex?: Record<string, number>;
    identify?: { domains?: Record<string, CompanyMatch[]>; names?: Record<string, CompanyMatch[]> };
    enrich?: Record<string, unknown>;
    leaders?: Record<string, FoundPerson[]>;
    people?: Record<string, { personId?: number; name?: string; current: any[] }>;
    watchInfo?: Partial<Record<Dataset, { status?: string; last_run_at?: string | null; config?: Watch["config"] }>>;
    activeWatches?: Partial<Record<Dataset, Watch[]>>;
    deletedWatches?: Dataset[];
    creditsStatus?: number;
  };
};

export function loadFixture(file: string): Fixture {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`Could not read fixture ${file}: ${(err as Error).message}`); }
  if (!parsed || typeof parsed !== "object") throw new Error(`Fixture ${file} must be a JSON object`);
  return parsed as Fixture;
}

/** A careers page listing `n` roles on an Ashby board (keeps fixtures small). */
export const careersHtml = (n: number, org = "example"): string =>
  `<html><head><title>Careers</title></head><body><nav><a href="/careers/benefits">Benefits</a></nav><h1>Join us</h1><p>${n ? "Open roles below." : "We have no open roles right now. Check back soon."}</p>${Array.from({ length: n }, (_, i) =>
    `<a href="https://jobs.ashbyhq.com/${org}/${String(i + 1).padStart(8, "0")}-0000-4000-8000-000000000000">Role ${i + 1}</a>`).join("")}</body></html>`;

/** An in-memory store holding the fixture's "before" state. */
export function storeFromFixture(f: Fixture): Store {
  const store = new Store(":memory:");
  const s = f.state ?? {};
  for (const c of s.companies ?? []) {
    store.saveCompany(c);
    store.setMeta(`leaders_searched:${c.domain}`, c.addedAt);
    store.setMeta(`careers_checked:${c.domain}`, c.addedAt);
  }
  for (const [domain, r] of Object.entries(s.refs ?? {})) {
    store.saveRef(domain, r.record, r.recordedAt);
    const total = (r.record as any)?.headcount?.total;
    if (typeof total === "number") store.addPoint(domain, r.recordedAt, total);
  }
  for (const p of s.points ?? []) store.addPoint(p.domain, p.at, p.total);
  for (const l of s.leaders ?? []) {
    const c = store.company(l.domain);
    store.saveLeader({ ...l, company: c?.name ?? l.domain, companyId: c?.companyId }, l.source ?? "search");
  }
  for (const r of s.readings ?? []) store.addReading(r.domain, r.at, r.roles, r.source ?? "careers");
  for (const [ds, id] of Object.entries(s.watches ?? {})) store.setWatchId(ds as Dataset, id as number);
  if (s.lastCheckAt) store.setMeta("last_check_at", s.lastCheckAt);
  for (const sig of s.signals ?? []) store.addSignal(sig, sig.createdAt);
  if (s.lastDigestAt) {
    const id = store.saveDigest({ from: s.lastDigestAt, to: s.lastDigestAt, markdown: "previous digest", payload: {}, want: { slack: false, email: false } }, s.lastDigestAt);
    store.assignDigest([], id);
  }
  return store;
}

/** The Api interface, answered from the fixture. Records every call; charges list prices so cost lines read true. */
export function fixtureApi(f: Fixture): Api & { calls: string[] } {
  const api = f.api ?? {};
  const calls: string[] = [];
  let nextId = 900;
  const charge = (n: number) => { creditsUsed.total += n; };
  const watchLists: Partial<Record<Dataset, (string | number)[]>> = {};
  return {
    calls,
    async identifyCompanies(inputs, by) {
      calls.push(`identify:${by}:${inputs.join(",")}`);
      const table = by === "domains" ? api.identify?.domains : api.identify?.names;
      return Object.fromEntries(inputs.map(i => [i, table?.[i] ?? table?.[i.toLowerCase()] ?? []]));
    },
    async enrichCompanies(ids) {
      calls.push(`enrich:${ids.join(",")}`);
      const hits = ids.filter(id => api.enrich?.[String(id)]);
      charge(2 * hits.length);
      return Object.fromEntries(hits.map(id => [id, api.enrich![String(id)]]));
    },
    async searchLeaders(companyId) {
      calls.push(`leaders:${companyId}`);
      const found = api.leaders?.[String(companyId)] ?? [];
      charge(0.03 * found.length);
      return found;
    },
    async enrichPeople(urls) {
      calls.push(`people:${urls.length}`);
      const hits = urls.filter(u => api.people?.[u]);
      charge(hits.length);
      return Object.fromEntries(hits.map(u => [u, api.people![u]]));
    },
    async fetchPages(urls) {
      calls.push(`fetch:${urls.join(",")}`);
      return urls.map(url => {
        const p = api.pages?.[url];
        if (!p || p.success === false) return { url, success: false, content: null, http_status: p?.http_status ?? 404 };
        charge(1);
        return { url, success: true, content: p.content ?? careersHtml(p.roles ?? 0), http_status: 200 };
      });
    },
    async jobIndexCounts(ids) {
      calls.push(`jobIndex:${ids.join(",")}`);
      return Object.fromEntries(ids.map(id => [id, api.jobIndex?.[String(id)] ?? 0]));
    },
    async createCompanyWatch(ids) { calls.push(`create:company:${ids.length}`); watchLists.company = ids; return { id: nextId++, status: "active" } as Watch; },
    async createPersonWatch(urls) { calls.push(`create:person:${urls.length}`); watchLists.person = urls; return { id: nextId++, status: "active" } as Watch; },
    async setCompanyEntities(id, ids) { calls.push(`patch:company:${id}:${ids.length}`); watchLists.company = ids; return { id, status: "active" } as Watch; },
    async setPersonEntities(id, urls) { calls.push(`patch:person:${id}:${urls.length}`); watchLists.person = urls; return { id, status: "active" } as Watch; },
    async getWatch(ds, id) {
      calls.push(`get:${ds}:${id}`);
      if (api.deletedWatches?.includes(ds)) throw new CrustdataError(404, `GET /watch/${ds}/${id}`, "not found");
      const info = api.watchInfo?.[ds] ?? {};
      const list = watchLists[ds];
      return { id, dataset: ds, status: info.status ?? "active", last_run_at: info.last_run_at ?? f.now ?? null, config: info.config, ...(list ? { entities: ds === "company" ? { crustdata_company_ids: list as number[] } : { professional_network_profile_urls: list as string[] } } : {}) } as Watch;
    },
    async listActiveWatches(ds) { calls.push(`list:${ds}`); return api.activeWatches?.[ds] ?? []; },
    async setWatchStatus(ds, id, status) { calls.push(`status:${ds}:${id}:${status}`); return { id, status } as Watch; },
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
      return { runs: (api.runs?.[ds] ?? []).map(r => r.run).sort((a, b) => b.id - a.id), next_cursor: null };
    },
    async getCreditBalance() {
      if (api.creditsStatus) throw new CrustdataError(api.creditsStatus, "GET /account/credits", api.creditsStatus === 402 ? "out of credits" : "invalid key");
      return 1000;
    },
  };
}
