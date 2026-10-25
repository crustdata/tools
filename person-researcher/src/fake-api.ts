/**
 * A stand-in for the Crustdata API, fed from a fixture file. Used by `npm run replay` and by the tests, so the whole
 * run (inputs, lookups, posts, web, brief, files) works offline with no key and no credits. It answers the requests
 * the real client sends, in the shapes the live API returned on 2026-10-23, and reports list-price credits.
 */

import type { Candidate, MatchRow, PersonData, Post, WebResult } from "./crustdata.js";
import { normalizeProfileUrl } from "./input.js";

export type Fixture = {
  description?: string;
  argv: string[];
  /** The date the fixture is replayed "on", so "what changed lately" reads the same every time. */
  now?: string;
  people: PersonData[];
  /** Work email to profile URL (what /person/enrich with business_emails finds). */
  workEmails?: Record<string, string>;
  /** Any email to profile URL (what /person/identify finds). */
  emails?: Record<string, string>;
  /** Addresses /person/identify refuses as invalid. */
  invalidEmails?: string[];
  /** "name|company" (lowercase, company may be empty) to the people a name search returns. */
  names?: Record<string, { total?: number; people: Candidate[] }>;
  /** Person id to their posts, newest first, and the total in the index. */
  posts?: Record<string, { total: number; items: Post[] }>;
  /** Search phrase to results, per source. */
  web?: Record<string, WebResult[]>;
  news?: Record<string, WebResult[]>;
  contacts?: Record<string, PersonData["contact"]>;
  /** Paths that answer 403, to test keys without identify or contact access. */
  forbidden?: string[];
  /** Failures to inject: the nth call (from 1) to a path answers with this status. */
  faults?: Array<{ path: string; call: number; status: number; message?: string }>;
};

export type Call = { method: string; path: string; body: any };

const reply = (data: unknown, credits = 0, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-credits-used": String(credits) } });

export function fakeFetch(fx: Fixture): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const count = new Map<string, number>();
  const urlOf = (p: PersonData) => normalizeProfileUrl(p.social_handles?.professional_network_identifier?.profile_url ?? "") ?? "";
  const byUrl = (url: string) => fx.people.find(p => urlOf(p) === (normalizeProfileUrl(url) ?? url));
  const pick = (p: PersonData, fields?: string[]) => {
    if (!fields?.length) return p;
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const top = f.split(".")[0];
      if (top in p) out[top] = (p as Record<string, unknown>)[top];
    }
    return out as PersonData;
  };
  const row = (on: string, type: string, p: PersonData | undefined, fields?: string[]): MatchRow =>
    p ? { matched_on: on, match_type: type, match_status: "matched", matches: [{ confidence_score: 1, person_data: pick(p, fields) }] }
      : { matched_on: on, match_type: type, match_status: "not_found", matches: [] };

  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    const n = (count.get(path) ?? 0) + 1;
    count.set(path, n);
    const fault = fx.faults?.find(f => f.path === path && f.call === n);
    if (fault) return reply({ error: { type: "error", message: fault.message ?? "injected" } }, 0, fault.status);
    if (fx.forbidden?.includes(path)) return reply({ error: { type: "permission_error", message: "Access denied" } }, 0, 403);

    switch (path) {
      case "/account/credits": return reply({ account: { credits: 1234.5 } });
      case "/account/endpoints": return reply({ endpoints: [{ path: "/person/enrich", status: "enabled" }] });
      case "/person/enrich": {
        if (body.business_emails) {
          const rows = body.business_emails.map((e: string) => row(e, "business_email", fx.workEmails?.[e] ? byUrl(fx.workEmails[e]) : undefined, body.fields));
          return reply(rows, rows.filter((r: MatchRow) => r.match_status === "matched").length);
        }
        const rows = body.professional_network_profile_urls.map((u: string) => row(u, "professional_network_profile_url", byUrl(u), body.fields));
        return reply(rows, rows.filter((r: MatchRow) => r.match_status === "matched").length);
      }
      case "/person/identify": {
        const bad = body.emails.filter((e: string) => fx.invalidEmails?.includes(e));
        if (bad.length) return reply({ error: { type: "invalid_request", message: `Invalid emails: ${bad.join(", ")}` } }, 0, 400);
        const rows = body.emails.map((e: string) => row(e, "email", fx.emails?.[e] ? byUrl(fx.emails[e]) : undefined, ["crustdata_person_id", "basic_profile", "social_handles"]));
        return reply(rows, rows.filter((r: MatchRow) => r.match_status === "matched").length);
      }
      case "/person/contact/enrich": {
        let credits = 0;
        const rows = body.professional_network_profile_urls.map((u: string) => {
          const c = fx.contacts?.[normalizeProfileUrl(u) ?? u];
          if (!c) return row(u, "professional_network_profile_url", undefined);
          credits += (c.business_emails?.length ? 1 : 0) + (c.personal_emails?.length ? 2 : 0) + (c.phone_numbers?.length ? 2 : 0);
          return { matched_on: u, match_type: "professional_network_profile_url", match_status: "matched", matches: [{ person_data: { contact: c } }] };
        });
        return reply(rows, credits);
      }
      case "/person/search": {
        const conds = body.filters.conditions as Array<{ field: string; value: string }>;
        const name = String(conds.find(c => c.field === "basic_profile.name")?.value ?? "").toLowerCase();
        const company = String(conds.find(c => c.field.startsWith("experience."))?.value ?? "").toLowerCase();
        const hit = fx.names?.[`${name}|${company}`] ?? { people: [] };
        const people = hit.people.slice(0, body.limit ?? 5);
        return reply({ profiles: people, total_count: hit.total ?? hit.people.length, next_cursor: null }, people.length * (0.03 + (company ? 0.1 : 0)));
      }
      case "/social_post/search": {
        const id = String(body.filters.conditions.find((c: { field: string }) => c.field === "actor.crustdata_entity_id")?.value);
        const p = fx.posts?.[id] ?? { total: 0, items: [] };
        const items = p.items.slice(0, body.limit);
        return reply({ posts: items, total_count: p.total, next_cursor: null }, items.length * 0.5);
      }
      case "/web/search/live": {
        const map = body.sources?.[0] === "news" ? fx.news : fx.web;
        const results = map?.[body.query] ?? [];
        return reply({ success: true, query: body.query, results, metadata: { total_results: results.length } }, results.length ? 1 : 0);
      }
    }
    return reply({ error: { message: `fake API has no ${path}` } }, 0, 404);
  }) as typeof fetch;
  return { fetch: fake, calls };
}
