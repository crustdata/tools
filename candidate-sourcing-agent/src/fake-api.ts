/**
 * A stand-in for the Crustdata API, fed from a fixture file. Used by `npm run replay` and by the tests, so the whole
 * run (parsing, rounds, search, seen list, scoring, files) works offline with no key and no credits.
 *
 * It answers the same requests the real client sends, in the same shapes the live API returned on 2026-10-21.
 */

import type { ContactResult, Endpoint, Person, Remark } from "./crustdata.js";
import { normalizeProfileUrl } from "./seen.js";

export type Fixture = {
  description?: string;
  argv: string[];
  /** Stored values per autocomplete field; a query returns the values that contain it. */
  autocomplete?: Record<string, string[]>;
  /** total_count for each round count, in order. */
  counts?: number[];
  /** Remarks returned with an empty count (the explain step). */
  remarks?: Remark[];
  /** The ranked search: total_count and every profile, best first. */
  search: { total_count: number; profiles: Person[] };
  /** Ids of the people who are open to new roles. */
  open?: number[];
  endpoints?: Endpoint[];
  contacts?: ContactResult[];
  /** Page size of the ranked search, to test cursor pages (default: everything on one page). */
  pageSize?: number;
  /** Failures to inject, for tests: the nth call (from 1) to a path answers with this status and message. */
  faults?: Array<{ path: string; call: number; status: number; message?: string; search?: boolean }>;
  /** Credits reported per result, to test what a run reports it spent. */
  creditsPerResult?: number;
};

export type Call = { method: string; path: string; body: any };

const json = (data: unknown, credits = 0) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", "x-credits-used": String(credits) } });

/** Returns a fetch that serves the fixture, and the list of calls it received (for tests). */
export function fakeFetch(fx: Fixture): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const counts = [...(fx.counts ?? [])];
  const seenCalls = new Map<string, number>();
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const kind = `${url.pathname}${body?.search ? ":search" : ""}`;
    seenCalls.set(kind, (seenCalls.get(kind) ?? 0) + 1);
    const fault = fx.faults?.find(f => f.path === url.pathname && !!f.search === !!body?.search && f.call === seenCalls.get(kind));
    if (fault) return new Response(JSON.stringify({ error: { message: fault.message ?? `injected ${fault.status}` } }), { status: fault.status });

    if (url.pathname === "/person/search/autocomplete") {
      const q = String(body.query ?? "").toLowerCase();
      const values = (fx.autocomplete?.[body.field] ?? []).filter(v => v.toLowerCase().includes(q));
      values.sort((a, b) => Number(b.toLowerCase() === q) - Number(a.toLowerCase() === q));
      return json({ suggestions: values.slice(0, body.limit ?? 10).map(value => ({ value })) });
    }
    if (url.pathname === "/person/search") {
      const idFilter = JSON.stringify(body.filters ?? {}).includes('"crustdata_person_id"');
      if (idFilter) {
        // The open-to-new-roles check: the ids asked about who are open.
        const ids: number[] = body.filters.conditions.find((c: any) => c.field === "crustdata_person_id").value;
        const profiles = ids.filter(id => fx.open?.includes(id)).map(id => ({ crustdata_person_id: id }));
        return json({ profiles, next_cursor: null, total_count: profiles.length, remarks: [] });
      }
      if (!body.search) {
        // A round count (filters only, one result).
        const total = counts.length ? counts.shift()! : fx.search.total_count;
        return json({ profiles: total ? [{ crustdata_person_id: 1 }] : [], next_cursor: null, total_count: total, remarks: total ? [] : fx.remarks ?? [] });
      }
      const excluded = new Set((body.post_processing?.exclude_profiles ?? []).map(normalizeProfileUrl));
      const pool = fx.search.profiles.filter(p => !excluded.has(normalizeProfileUrl(p.social_handles?.professional_network_identifier?.profile_url)));
      const start = body.cursor ? Number(body.cursor) : 0;
      const page = pool.slice(start, start + Math.min(body.limit ?? 20, fx.pageSize ?? Infinity));
      const fields: string[] | undefined = body.fields;
      if (fields && fx.endpoints) {
        // Answer like the live API for a group this key may not read.
        const search = fx.endpoints.find(e => e.path === "/person/search");
        const denied = fields.filter(f => search?.fields?.disabled?.includes(f));
        if (denied.length) return new Response(JSON.stringify({ error: { message: `Access denied to fields: ${denied.join(", ")}` } }), { status: 403 });
      }
      const next = start + page.length < pool.length ? String(start + page.length) : null;
      const total = Math.max(0, fx.search.total_count - (fx.search.profiles.length - pool.length));
      return json({ profiles: page, next_cursor: next, total_count: total, total_count_relation: "eq", remarks: [] }, page.length * (fx.creditsPerResult ?? 0));
    }
    if (url.pathname === "/account/endpoints") return json(fx.endpoints ?? []);
    if (url.pathname === "/account/credits") return json({ account: { credits: 1000 } });
    if (url.pathname === "/person/contact/enrich" || url.pathname === "/person/enrich") {
      const urls: string[] = body.professional_network_profile_urls ?? [];
      return json(urls.map(u => fx.contacts?.find(c => normalizeProfileUrl(c.matched_on) === normalizeProfileUrl(u)) ?? { matched_on: u, match_status: "not_found", matches: [] }));
    }
    return new Response(JSON.stringify({ error: { message: `The offline fixture has no answer for ${method} ${url.pathname}` } }), { status: 404 });
  };
  return { fetch: fn as typeof fetch, calls };
}
