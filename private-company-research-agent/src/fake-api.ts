/**
 * A stand-in for the Crustdata API, fed from a fixture file. Used by `npm run replay` and by the tests, so a whole run
 * (identify, enrich, former staff, jobs, peers, memo, files) works offline with no key and no credits. It answers
 * the requests the real client sends, in the shapes the live API returned on 2026-11-13, and reports list-price
 * credits. The companies and people in the fixtures are made up.
 */

import { domainsOf } from "./collect.js";
import { sanitizeCompany } from "./sanitize.js";
import type { CompanyData, JobCounts, PeerData, SearchPerson } from "./types.js";

export type Fixture = {
  description?: string;
  argv: string[];
  /** The date the fixture is replayed "on", so "months since the last round" reads the same every time. */
  now?: string;
  /** Every company the fake API knows, in Company Enrich shape. Peers are taken from here too. */
  companies: CompanyData[];
  /** Domains that identify returns a different company for (it only links to the domain). */
  lookalikes?: Record<string, number>;
  /** Company id to the people who left (departures search). */
  departures?: Record<string, { total?: number; people: SearchPerson[] }>;
  /** Company id to senior roles that ended (senior search). */
  senior?: Record<string, { total?: number; people: SearchPerson[] }>;
  /** Company id to job counts. */
  jobs?: Record<string, JobCounts>;
  /** Paths that answer 403, to test keys without access. */
  forbidden?: string[];
  /** Failures to inject: the nth call (from 1) to a path answers with this status. */
  faults?: Array<{ path: string; call: number; status: number; message?: string }>;
};

export type Call = { method: string; path: string; body: any };

const reply = (data: unknown, credits = 0, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-credits-used": String(credits) } });

/** Company Enrich shape to the subset /company/search returns (its growth keys are 1m/3m/6m/12m). */
export function asPeer(c: CompanyData): PeerData {
  const g = c.headcount?.growth_percent ?? {}, a = c.headcount?.growth_absolute ?? {};
  return {
    crustdata_company_id: c.crustdata_company_id,
    basic_info: { name: c.basic_info?.name, primary_domain: c.basic_info?.primary_domain, year_founded: c.basic_info?.year_founded, company_type: c.basic_info?.company_type },
    headcount: {
      total: c.headcount?.total,
      growth_percent: { "1m": g.mom ?? null, "3m": g.qoq ?? null, "6m": g.six_months ?? null, "12m": g.yoy ?? null },
      growth_absolute: { "1m": a.mom ?? null, "3m": a.qoq ?? null, "6m": a.six_months ?? null, "12m": a.yoy ?? null },
    },
    funding: c.funding ? {
      total_investment_usd: c.funding.total_investment_usd, last_round_amount_usd: c.funding.last_round_amount_usd,
      last_fundraise_date: c.funding.last_fundraise_date, last_round_type: c.funding.last_round_type,
    } : undefined,
    followers: c.followers ? { count: c.followers.count } : undefined,
  };
}

export function fakeFetch(fx: Fixture): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const count = new Map<string, number>();
  const byId = (id: number) => fx.companies.find(c => c.crustdata_company_id === id);
  const byDomain = (d: string) => {
    const host = d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
    const look = fx.lookalikes?.[host];
    if (look !== undefined) return byId(look);
    return fx.companies.find(c => domainsOf(sanitizeCompany(c)).includes(host));
  };

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
      case "/account/endpoints": return reply({ endpoints: ["/company/enrich", "/company/identify", "/person/search", "/job/search", "/company/search"].map(p => ({ path: p, status: "enabled" })) });
      case "/company/identify": {
        const rows = (body.domains as string[]).map(d => {
          const c = byDomain(d);
          return {
            matched_on: d, match_type: "domain",
            matches: c ? [{ confidence_score: 1, company_data: { crustdata_company_id: c.crustdata_company_id, basic_info: c.basic_info, headcount: { total: c.headcount?.total ?? null } } }] : [],
          };
        });
        return reply(rows, 0);
      }
      case "/company/enrich": {
        const ids: number[] = body.crustdata_company_ids ?? [];
        const rows = ids.map(id => {
          const c = byId(id);
          if (!c) return { matched_on: String(id), match_type: "crustdata_company_id", matches: [] };
          const picked: Record<string, unknown> = { crustdata_company_id: c.crustdata_company_id };
          for (const f of body.fields ?? Object.keys(c)) if (f in c) picked[f] = (c as Record<string, unknown>)[f];
          return { matched_on: String(id), match_type: "crustdata_company_id", matches: [{ confidence_score: 1, company_data: picked }] };
        });
        return reply(rows, rows.filter(r => r.matches.length).length * 2);
      }
      case "/person/search": {
        const conds = body.filters.conditions as Array<{ field: string; type: string; value: unknown }>;
        const id = String(conds.find(c => c.field === "experience.employment_details.company_id")?.value);
        const senior = conds.some(c => c.field === "experience.employment_details.seniority_level");
        const set = (senior ? fx.senior : fx.departures)?.[id] ?? { people: [] };
        const people = set.people.slice(0, body.limit ?? 20);
        return reply({ profiles: people, total_count: set.total ?? set.people.length, next_cursor: null }, Math.round(people.length * 0.23 * 100) / 100);
      }
      case "/job/search": {
        const conds: Array<{ field: string; value: unknown }> = body.filters.conditions ?? [body.filters];
        const id = String(conds.find(c => c.field === "company.basic_info.company_id")?.value);
        const j = fx.jobs?.[id] ?? { total: 0, titles: [], categories: [] };
        if (body.limit > 0) {
          const n = j.newest;
          return reply({ job_listings: n ? [{ job_details: { title: n.title }, ...(n.date ? { metadata: { date_added: `${n.date}T00:00:00` } } : {}) }] : [], next_cursor: null, total_count: n ? n.on_record : 0 }, n ? 0.03 : 0);
        }
        return reply({
          job_listings: [], next_cursor: null, total_count: j.total,
          aggregations: [
            { type: "group_by", field: "job_details.title", buckets: j.titles.map(t => ({ key: t.title, count: t.count })) },
            { type: "group_by", field: "job_details.category", buckets: j.categories.map(c => ({ key: c.category, count: c.count })) },
          ],
        }, 0);
      }
      case "/company/search": {
        const ids: number[] = body.filters?.value ?? [];
        const found = ids.map(byId).filter((c): c is CompanyData => !!c).map(asPeer);
        return reply({ companies: found, total_count: found.length, next_cursor: null }, Math.round(found.length * 0.63 * 100) / 100);
      }
    }
    return reply({ error: { message: `fake API has no ${path}` } }, 0, 404);
  }) as typeof fetch;
  return { fetch: fake, calls };
}
