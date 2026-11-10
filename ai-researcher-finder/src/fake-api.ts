/**
 * A stand-in for the Crustdata API, fed from a fixture file. Used by `npm run replay` and by the tests, so the whole
 * run (labs, search, seeds, teams, scoring, files) works offline with no key and no credits.
 *
 * It answers the same requests the real client sends, in the shapes the live API returned on 2026-10-28.
 */

import type { Endpoint, Person } from "./crustdata.js";
import { normTitle } from "./seeds.js";

export type Fixture = {
  description?: string;
  argv: string[];
  endpoints?: Endpoint[];
  /** Companies /company/identify knows, by domain or name. */
  companies: Array<{ id: number; name: string; domain: string }>;
  autocomplete?: Record<string, string[]>;
  /** Every person the fake API knows, best match first (the order the role search returns them). */
  people: Person[];
  /** total_count reported by each role search. */
  totals?: number[];
  /** Scholar or profile URL to person id. */
  identify?: Record<string, number>;
  /** GitHub URL to person id (null: an account not linked to anyone). */
  github?: Record<string, number | null>;
  /** Person identify not enabled for this key. */
  noIdentify?: boolean;
  /** Credits reported per result returned, to test what a run says it spent. */
  creditsPerResult?: number;
  /** Identify leaves out the first row of its answer (to test a short answer). */
  identifyShort?: boolean;
  /** How api.anthropic.com answers --ai requests: an HTTP status, or a JSON answers list. */
  anthropic?: { status?: number; answers?: Array<{ answer: string; evidence: string }> };
  /** Failures to inject, for tests: the nth call (from 1) to a path answers with this status. */
  faults?: Array<{ path: string; call: number; status: number; message?: string }>;
};

export type Call = { method: string; path: string; body: any };

const json = (data: unknown, credits = 0) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", "x-credits-used": String(credits) } });
const fail = (status: number, message: string) => new Response(JSON.stringify({ error: { type: "invalid_request", message } }), { status });

/** Every leaf in a filter tree. */
function leaves(f: any): Array<{ field: string; type: string; value: any }> {
  if (!f) return [];
  if (Array.isArray(f.conditions)) return f.conditions.flatMap(leaves);
  return [f];
}

/**
 * What Crustdata would bill for a search page, from the fixture's account prices: per person, the base price, each
 * premium group filtered on, and each premium group returned (research only for people who have a research profile).
 */
function billFor(fx: Fixture, body: any, page: Person[]): number {
  const ep = fx.endpoints?.find(e => e.path === "/person/search");
  if (!ep) return 0;
  const price = (list: Array<{ field: string; credits: number }> | undefined, f: string) => list?.find(x => x.field === f)?.credits ?? 0;
  const fields: string[] = body.fields ?? [];
  const groups = new Set(leaves(body.filters).map(l => (l.field.startsWith("experience.") ? "experience" : l.field.startsWith("research_profiles.") ? "research_profiles" : "")).filter(Boolean));
  let total = 0;
  for (const p of page) {
    total += ep.base_credits ?? 0;
    for (const g of groups) total += price(ep.premium_filters, g);
    for (const f of ["experience", "education", "skills"]) if (fields.includes(f)) total += price(ep.premium_fields, f);
    if (fields.includes("research_profiles") && p.research_profiles?.length) total += price(ep.premium_fields, "research_profiles");
  }
  return Math.round(total * 100) / 100;
}

const phrase = (text: string, p: string) => ` ${normTitle(text)} `.includes(` ${normTitle(p)} `);

export function fakeFetch(fx: Fixture): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  let searchNo = 0;
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    if (url.hostname === "api.anthropic.com") {
      calls.push({ method, path: `anthropic:${url.pathname}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const a = fx.anthropic ?? {};
      if (a.status && a.status !== 200) return new Response(JSON.stringify({ type: "error", error: { type: a.status === 401 ? "authentication_error" : "api_error", message: "fake" } }), { status: a.status, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ id: "msg_fake", type: "message", role: "assistant", model: "fake", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answers: a.answers ?? [] }) }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
    const fault = fx.faults?.find(f => f.path === url.pathname && f.call === counts.get(url.pathname));
    if (fault) return fail(fault.status, fault.message ?? `injected ${fault.status}`);

    switch (url.pathname) {
      case "/account/endpoints": return json({ endpoints: fx.endpoints ?? [] });
      case "/account/credits": return json({ account: { credits: 1000 } });
      case "/company/identify": {
        const kind = body.domains ? "domains" : "names";
        return json((body[kind] as string[]).map(v => {
          const c = fx.companies.find(x => (kind === "domains" ? x.domain : x.name).toLowerCase() === v.toLowerCase());
          return { matched_on: v, match_type: kind.slice(0, -1), matches: c ? [{ confidence_score: 1, company_data: { crustdata_company_id: c.id, basic_info: { name: c.name, primary_domain: c.domain } } }] : [] };
        }));
      }
      case "/person/search/autocomplete": {
        const q = String(body.query ?? "").toLowerCase();
        return json({ suggestions: (fx.autocomplete?.[body.field] ?? []).filter(v => v.toLowerCase().includes(q)).slice(0, body.limit ?? 10).map(value => ({ value })) });
      }
      case "/person/identify": {
        if (fx.noIdentify) return fail(403, "Access denied");
        const key = Object.keys(body)[0];
        if (Object.keys(body).length !== 1) return fail(400, "Exactly one identifier must be provided");
        const values: string[] = body[key];
        if (values.length > 25) return fail(400, `Maximum 25 values allowed for ${key}. Found ${values.length}`);
        let billed = 0;
        // identifyShort: the first row is missing from the answer, as if the API had dropped it.
        const rows = values.slice(fx.identifyShort ? 1 : 0).map(v => {
          const id = fx.identify?.[v];
          const p = fx.people.find(x => x.crustdata_person_id === id);
          if (!p) return { matched_on: v, match_type: key.replace(/s$/, ""), match_status: "not_found", matches: [] };
          billed++;
          return { matched_on: v, match_type: key.replace(/s$/, ""), match_status: "matched", matches: [{ confidence_score: 1, person_data: { crustdata_person_id: p.crustdata_person_id, basic_profile: { name: p.basic_profile?.name } } }] };
        });
        return json(rows, billed);
      }
      case "/dev_platform/enrich": {
        if (!fx.github || !(body.profile_url in fx.github)) return json({ crustdata_person_id: null, dev_platform_profiles: [] }, 1);
        const id = fx.github[body.profile_url];
        return json({ crustdata_person_id: id, dev_platform_profiles: [{ profile_url: body.profile_url, name: "Example Account", account_type: "User", confidence_score: id ? 0.99 : 0 }] }, 1);
      }
      case "/person/search": {
        const all = leaves(body.filters);
        const fields: string[] = body.fields ?? [];
        const search = fx.endpoints?.find(e => e.path === "/person/search");
        const denied = fields.filter(f => search?.fields?.disabled?.includes(f));
        if (denied.length) return fail(403, `Access denied to fields: ${denied.join(", ")}`);
        let pool = fx.people;
        let total: number | undefined;
        for (const l of all) {
          if (l.field === "crustdata_person_id") pool = pool.filter(p => (l.value as number[]).includes(p.crustdata_person_id));
          else if (l.field === "experience.employment_details.current.company_id") pool = pool.filter(p => (p.experience?.employment_details?.current ?? []).some(r => (l.value as number[]).includes(r.crustdata_company_id ?? -1)));
          else if (l.field === "experience.employment_details.past.company_id") pool = pool.filter(p => (p.experience?.employment_details?.past ?? []).some(r => (l.value as number[]).includes(r.crustdata_company_id ?? -1)));
          else if (l.field === "research_profiles.articles.title") pool = pool.filter(p => (p.research_profiles?.[0]?.articles ?? []).some(a => phrase(a.title ?? "", l.value)));
          else if (l.field === "basic_profile.location.country") pool = pool.filter(p => (l.value as string[]).includes(p.basic_profile?.location?.country ?? ""));
        }
        const titles = all.filter(l => l.field === "experience.employment_details.current.title");
        if (titles.length) pool = pool.filter(p => (p.experience?.employment_details?.current ?? []).some(r => titles.some(t => phrase(r.title ?? "", t.value))));
        if (body.search) total = fx.totals?.[searchNo++];
        const excluded = new Set((body.post_processing?.exclude_profiles ?? []).map((u: string) => u.toLowerCase()));
        pool = pool.filter(p => !excluded.has((p.social_handles?.professional_network_identifier?.profile_url ?? "").toLowerCase()));
        // Only the search block ranks with a tier; lookups by id or title return no tier.
        const strip = (p: Person): Person => {
          const out: any = { crustdata_person_id: p.crustdata_person_id };
          for (const f of fields) if (f !== "fit" && (p as any)[f] !== undefined) out[f] = (p as any)[f];
          if (body.search && fields.includes("fit")) out.fit = p.fit ?? null;
          return out;
        };
        const start = body.cursor ? Number(body.cursor) : 0;
        const page = pool.slice(start, start + (body.limit ?? 20));
        const next = start + page.length < pool.length ? String(start + page.length) : null;
        return json({ profiles: page.map(strip), next_cursor: next, total_count: total ?? pool.length, total_count_relation: "eq" }, fx.creditsPerResult !== undefined ? page.length * fx.creditsPerResult : billFor(fx, body, page));
      }
    }
    return fail(404, `The offline fixture has no answer for ${method} ${url.pathname}`);
  };
  return { fetch: fn as typeof fetch, calls };
}
