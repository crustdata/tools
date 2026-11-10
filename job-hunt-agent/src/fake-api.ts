/**
 * A stand-in for the Crustdata API and the four job boards, fed from a fixture file. Used by `npm run replay` and
 * by the tests, so a whole run works offline with no key, no network and no credits. It answers the requests the
 * real client sends, in the shapes the live API returned on 2026-10-28, and reports list-price credits.
 * Every company and person in the fixtures is made up.
 */

import type { RawCompany, RawJob, RawPerson } from "./crustdata.js";

export type Fixture = {
  description?: string;
  argv: string[];
  /** The date the fixture is replayed "on", so "posted 2 days ago" reads the same every time. */
  now?: string;
  /** How many jobs the count says match (defaults to the number of jobs below). */
  matching?: number;
  jobs: RawJob[];
  companies: RawCompany[];
  /** Everyone at each company (by Crustdata company id); the fake ranks them per search. */
  people: Record<string, RawPerson[]>;
  /** School autocomplete answers, by query. */
  schools?: Record<string, string[]>;
  /** Job board ids (Greenhouse, Lever, SmartRecruiters numbers; Ashby UUIDs) that are closed. */
  closed?: string[];
  /** Profile URL to work emails. */
  emails?: Record<string, Array<{ email: string; crustdata_company_id?: number }>>;
  /** Paths that answer 403, to test keys without contact access. */
  forbidden?: string[];
  /** What GET /account/endpoints answers (prices); the price list when not given. */
  endpoints?: Array<Record<string, unknown>>;
  /** Prices actually charged, when they differ from what /account/endpoints says (tests the spend ceiling). */
  billAs?: Array<Record<string, unknown>>;
  /** Raw people answers to send instead of the ranked ones (tests malformed answers). */
  rawProfiles?: unknown[];
  /** Failures to inject: the nth call (from 1) to a path answers with this status. */
  faults?: Array<{ path: string; call: number; status: number; message?: string }>;
};

export type Call = { method: string; url: string; path: string; body: any };

const reply = (data: unknown, credits = 0, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-credits-used": String(credits) } });

type Cond = { field?: string; type?: string; value?: any; op?: string; conditions?: Cond[] };
const leaves = (f: Cond | undefined): Cond[] => (!f ? [] : f.conditions ? f.conditions.flatMap(leaves) : [f]);

/** The price list (docs.crustdata.com/general/pricing), charged per row like the live API at list price. */
const LIST_ENDPOINTS = [
  { path: "/job/search", status: "enabled", base_credits: 0.03 },
  { path: "/company/search", status: "enabled", base_credits: 0.03, premium_fields: [{ field: "headcount", credits: 0.2 }, { field: "funding", credits: 0.2 }], premium_filters: [{ field: "headcount", credits: 0.2 }] },
  { path: "/person/search", status: "enabled", base_credits: 0.03, premium_fields: [{ field: "experience", credits: 0.1 }, { field: "education", credits: 0.1 }], premium_filters: [{ field: "experience", credits: 0.1 }, { field: "education", credits: 0.1 }] },
  { path: "/person/contact/enrich", status: "enabled", base_credits: 1, premium_fields: [{ field: "contact.business_emails", credits: 1 }] },
];

/** Credits for one row: the base plus every premium group the request filters on or asks for. */
function rowPrice(path: string, body: any, endpoints: Array<Record<string, any>>): number {
  const ep = endpoints.find(e => e.path === path);
  if (!ep) return 0;
  const groups = (list: string[]) => new Set(list.map(f => f.split(".")[0]));
  const asked = groups(Array.isArray(body?.fields) ? body.fields : []);
  const filtered = groups(leaves(body?.filters).map(c => String(c.field ?? "")));
  let price = Number(ep.base_credits ?? 0);
  for (const g of asked) price += Number((ep.premium_fields ?? []).find((x: any) => x.field === g)?.credits ?? 0);
  for (const g of filtered) price += Number((ep.premium_filters ?? []).find((x: any) => x.field === g)?.credits ?? 0);
  return price;
}

const RECRUIT = /recruit|talent|sourc/i;
const MANAGE = /manager|head of|director|vp|lead|chief|founder/i;

export function fakeFetch(fx: Fixture): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const count = new Map<string, number>();
  const closed = new Set((fx.closed ?? []).map(s => s.toLowerCase()));

  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", url: url.toString(), path, body });

    // Job boards (the free open check).
    if (url.hostname === "boards-api.greenhouse.io" || url.hostname.endsWith("lever.co") || url.hostname === "api.smartrecruiters.com") {
      const id = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "").toLowerCase();
      return new Response("{}", { status: closed.has(id) ? 404 : 200 });
    }
    if (url.hostname === "api.ashbyhq.com") {
      const org = decodeURIComponent(path.split("/").pop() ?? "");
      const jobs = fx.jobs
        .map(j => /jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i.exec(String(j.job_details?.url ?? "")))
        .filter((m): m is RegExpExecArray => Boolean(m) && m![1] === org && !closed.has(m![2].toLowerCase()))
        .map(m => ({ id: m[2] }));
      return new Response(JSON.stringify({ jobs }), { status: 200 });
    }
    if (url.hostname !== "api.crustdata.com") return new Response("not in the fixture", { status: 404 });

    const n = (count.get(path) ?? 0) + 1;
    count.set(path, n);
    const fault = fx.faults?.find(f => f.path === path && f.call === n);
    if (fault) return reply({ error: { type: "error", message: fault.message ?? "injected" } }, 0, fault.status);
    if (fx.forbidden?.includes(path)) return reply({ error: { type: "permission_error", message: "Access denied" } }, 0, 403);

    switch (path) {
      case "/account/credits": return reply({ account: { credits: 1234.5 } });
      case "/account/endpoints": return reply(fx.endpoints ?? LIST_ENDPOINTS);

      case "/job/search": {
        const conds = leaves(body.filters);
        const byUrl = conds.find(c => c.field === "job_details.url");
        const byId = conds.find(c => c.field === "crustdata_job_id");
        if (byUrl || byId) {
          const hit = fx.jobs.filter(j => (byUrl && j.job_details?.url === byUrl.value) || (byId && String(j.crustdata_job_id) === String(byId.value)));
          return reply({ job_listings: hit.slice(0, 1), next_cursor: null, total_count: hit.length }, hit.length ? 0.03 : 0);
        }
        if (body.limit === 0) return reply({ job_listings: [], next_cursor: null, total_count: fx.matching ?? fx.jobs.length, aggregations: [{ type: "count", value: fx.matching ?? fx.jobs.length }] });
        const start = body.cursor ? Number(body.cursor) : 0;
        const page = fx.jobs.slice(start, start + body.limit);
        const next = start + page.length < fx.jobs.length ? String(start + page.length) : null;
        return reply({ job_listings: page, next_cursor: next, total_count: fx.jobs.length }, page.length * 0.03);
      }

      case "/company/search": {
        const c = leaves(body.filters)[0];
        const hit = c?.field === "crustdata_company_id"
          ? fx.companies.filter(x => (c.value as number[]).includes(Number(x.crustdata_company_id)))
          : fx.companies.filter(x => x.basic_info?.primary_domain === c?.value);
        return reply({ companies: hit.slice(0, body.limit), next_cursor: null }, hit.slice(0, body.limit).length * rowPrice(path, body, fx.billAs ?? fx.endpoints ?? LIST_ENDPOINTS));
      }

      case "/person/search/autocomplete": return reply({ suggestions: (fx.schools?.[body.query] ?? []).map(value => ({ value })) });

      case "/person/search": {
        const conds = leaves(body.filters);
        const companyId = Number(conds.find(c => c.field === "experience.employment_details.current.company_id")?.value);
        const schoolValues = conds.filter(c => c.field === "education.schools.school").map(c => String(c.value).toLowerCase());
        const country = conds.find(c => c.field === "basic_profile.location.country");
        const query = String(body.search?.query ?? "").toLowerCase();
        let pool = (fx.people[String(companyId)] ?? []).filter(p => (p.experience?.employment_details?.current ?? []).some(r => Number(r.crustdata_company_id) === companyId));
        if (schoolValues.length) pool = pool.filter(p => (p.education?.schools ?? []).some(s => schoolValues.some(v => String(s.school ?? "").toLowerCase().includes(v))));
        if (country) {
          const want = (Array.isArray(country.value) ? country.value : [country.value]).map((v: string) => v.toLowerCase());
          pool = pool.filter(p => want.some((w: string) => String(p.basic_profile?.location?.full_location ?? "").toLowerCase().includes(w)));
        }
        const title = (p: RawPerson) => (p.experience?.employment_details?.current ?? []).find(r => Number(r.crustdata_company_id) === companyId)?.title ?? "";
        const rank = (p: RawPerson) => {
          const t = title(p);
          if (/recruiter/.test(query)) return RECRUIT.test(t) ? 0 : 2;
          if (/manager|director|head of/.test(query)) return MANAGE.test(t) && !RECRUIT.test(t) ? 0 : 2;
          return RECRUIT.test(t) ? 3 : MANAGE.test(t) ? 1 : 0;
        };
        const ranked = pool.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.p).slice(0, body.limit);
        if (fx.rawProfiles) return reply({ profiles: fx.rawProfiles, next_cursor: null }, 0.03);
        return reply({ profiles: ranked, next_cursor: null, total_count: pool.length }, ranked.length * rowPrice(path, body, fx.billAs ?? fx.endpoints ?? LIST_ENDPOINTS));
      }

      case "/person/contact/enrich": {
        let credits = 0;
        const rows = body.professional_network_profile_urls.map((u: string) => {
          const e = fx.emails?.[u];
          if (!e?.length) return { matched_on: u, match_type: "professional_network_profile_url", match_status: "not_found", matches: [] };
          credits += 1; // billed per person matched, even when the address turns out to be at a former employer
          return { matched_on: u, match_type: "professional_network_profile_url", match_status: "matched", matches: [{ person_data: { contact: { business_emails: e.map(x => ({ ...x, status: "deliverable" })) } } }] };
        });
        return reply(rows, credits);
      }
    }
    return reply({ error: { message: `fake API has no ${path}` } }, 0, 404);
  }) as typeof fetch;
  return { fetch: fake, calls };
}
