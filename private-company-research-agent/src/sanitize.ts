/**
 * Coerces an API answer into the shapes the memo reads, before any rule runs: a string where a string is expected, a
 * list where a list is expected, a real date or nothing. One record with an odd shape (a number for a name, a list
 * of investors instead of a comma string, a date of "N/A") then cannot crash a run, and every rule can trust its
 * input. Unknown fields are dropped. Pure, no I/O.
 */

import type { Bundle, CompanyData, EnrichPerson, EnrichRole, PeerData, PeopleResult, Point, SearchPerson, SearchRole } from "./types.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined =>
  typeof v === "string" ? (v.trim() ? v : undefined) : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined;
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** An ISO-looking date that is a real calendar date ("2026-13-01" and "N/A" are dropped). */
export function date(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : undefined;
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})/.exec(s) : null;
  if (!m) return undefined;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? s : undefined;
}
const strs = (v: unknown): string[] => arr(v).map(str).filter((x): x is string => !!x);
/** A comma-separated list, given either as a string or as a list of strings. */
const list = (v: unknown): string | undefined => (Array.isArray(v) ? strs(v).join(", ") || undefined : str(v));
const nums = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(v) ?? {})) { const n = num(x); if (n !== undefined) out[k] = n; }
  return out;
};
const pick = <T>(v: unknown, f: (o: Obj) => T): T | undefined => { const o = obj(v); return o ? f(o) : undefined; };
const points = (v: unknown): Point[] => arr(v).map(p => pick(p, o => ({ date: date(o.date), employee_count: num(o.employee_count) }))).filter(p => !!p?.date) as Point[];

const enrichRole = (v: unknown): EnrichRole | undefined => pick(v, o => ({
  employer_name: str(o.employer_name),
  employer_company_id: arr(o.employer_company_id).map(str).filter((x): x is string => !!x),
  employer_website: strs(o.employer_website),
  employee_title: str(o.employee_title),
  employee_start_date: date(o.employee_start_date),
  employee_end_date: date(o.employee_end_date),
}));
const enrichPerson = (v: unknown): EnrichPerson | undefined => pick(v, o => {
  const bp = obj(o.basic_profile), ed = obj(obj(o.experience)?.employment_details);
  return {
    crustdata_person_id: num(o.crustdata_person_id),
    updated_at: date(o.updated_at),
    basic_profile: bp ? { name: str(bp.name), current_title: str(bp.current_title), headline: str(bp.headline) } : null,
    social_handles: { professional_network_identifier: { profile_url: str(obj(obj(o.social_handles)?.professional_network_identifier)?.profile_url) } },
    experience: { employment_details: {
      current: arr(ed?.current).map(enrichRole).filter((r): r is EnrichRole => !!r),
      past: arr(ed?.past).map(enrichRole).filter((r): r is EnrichRole => !!r),
    } },
    education: { schools: arr(obj(o.education)?.schools).map(s => pick(s, x => ({ school: str(x.school) }))).filter(Boolean) as Array<{ school?: string }> },
  };
});

const searchRole = (v: unknown): SearchRole | undefined => pick(v, o => ({
  name: str(o.name),
  title: str(o.title),
  start_date: date(o.start_date),
  end_date: date(o.end_date),
  seniority_level: str(o.seniority_level),
  crustdata_company_id: num(o.crustdata_company_id) ?? (str(o.crustdata_company_id) ? Number(o.crustdata_company_id) : undefined),
}));
const searchPerson = (v: unknown): SearchPerson | undefined => pick(v, o => {
  const ed = obj(obj(o.experience)?.employment_details);
  return {
    crustdata_person_id: num(o.crustdata_person_id),
    basic_profile: { name: str(obj(o.basic_profile)?.name), current_title: str(obj(o.basic_profile)?.current_title) },
    social_handles: { professional_network_identifier: { profile_url: str(obj(obj(o.social_handles)?.professional_network_identifier)?.profile_url) } },
    experience: { employment_details: {
      current: arr(ed?.current).map(searchRole).filter((r): r is SearchRole => !!r),
      past: arr(ed?.past).map(searchRole).filter((r): r is SearchRole => !!r),
    } },
  };
});
const people = (v: PeopleResult | undefined): PeopleResult | undefined =>
  v ? { total: num(v.total) ?? 0, since: date(v.since), people: arr(v.people).map(searchPerson).filter((p): p is SearchPerson => !!p) } : undefined;

export function sanitizeCompany(raw: unknown): CompanyData {
  const c = obj(raw) ?? {};
  const bi = obj(c.basic_info), hc = obj(c.headcount), fu = obj(c.funding), fo = obj(c.followers), seo = obj(c.seo);
  const er = obj(c.employee_reviews), pp = obj(c.people), pl = obj(c.public_launches), tx = obj(c.taxonomy), lo = obj(c.locations);
  const fts = obj(obj(hc?.by_function_timeseries)?.CURRENT_FUNCTION);
  const traffic = obj(obj(c.web_traffic)?.domain_traffic);
  return {
    crustdata_company_id: num(c.crustdata_company_id),
    basic_info: bi ? {
      name: str(bi.name), primary_domain: str(bi.primary_domain), all_domains: strs(bi.all_domains), website: str(bi.website),
      professional_network_url: str(bi.professional_network_url), description: str(bi.description), company_type: str(bi.company_type),
      status: str(bi.status), year_founded: num(bi.year_founded), employee_count_range: str(bi.employee_count_range), industries: strs(bi.industries),
    } : null,
    headcount: hc ? {
      total: num(hc.total), largest_headcount_country: str(hc.largest_headcount_country), timeseries: points(hc.timeseries),
      growth_percent: nums(hc.growth_percent), growth_absolute: nums(hc.growth_absolute),
      by_role_absolute: nums(hc.by_role_absolute), by_role_percent: nums(hc.by_role_percent),
      by_role_growth_6m_pct: nums(hc.by_role_growth_6m_pct), by_region_absolute: nums(hc.by_region_absolute),
      by_function_timeseries: fts ? { CURRENT_FUNCTION: Object.fromEntries(Object.entries(fts).map(([k, s]) => [k, points(s)])) } : null,
    } : null,
    funding: fu ? {
      total_investment_usd: num(fu.total_investment_usd), last_round_amount_usd: num(fu.last_round_amount_usd),
      last_fundraise_date: date(fu.last_fundraise_date), last_round_type: str(fu.last_round_type), num_funding_rounds: num(fu.num_funding_rounds),
      milestones: arr(fu.milestones).map(m => pick(m, o => ({
        date: date(o.date), funding_date: date(o.funding_date), amount_usd: num(o.amount_usd), round_type: str(o.round_type),
        investors: list(o.investors), lead_investors: list(o.lead_investors),
      }))).filter(Boolean) as NonNullable<NonNullable<CompanyData["funding"]>["milestones"]>,
      investors_detailed: arr(fu.investors_detailed).map(x => pick(x, o => ({ name: str(o.name), type: str(o.type) }))).filter(Boolean) as Array<{ name?: string; type?: string }>,
      acquired_by: arr(fu.acquired_by),
    } : null,
    followers: fo ? {
      count: num(fo.count), qoq_percent: num(fo.qoq_percent), six_months_growth_percent: num(fo.six_months_growth_percent), yoy_percent: num(fo.yoy_percent),
      timeseries: arr(fo.timeseries).map(p => pick(p, o => ({ date: date(o.date), follower_count: num(o.follower_count) }))).filter(p => p?.date) as Array<{ date: string; follower_count?: number }>,
    } : null,
    web_traffic: traffic ? { domain_traffic: Object.fromEntries(Object.entries(traffic).map(([d, t]) => [d, pick(t, o => ({
      domain: str(o.domain), monthly_visitors: num(o.monthly_visitors), mom_pct: num(o.mom_pct), qoq_pct: num(o.qoq_pct),
      source_search_pct: num(o.source_search_pct), source_direct_pct: num(o.source_direct_pct), source_social_pct: num(o.source_social_pct),
      source_paid_referral_pct: num(o.source_paid_referral_pct), source_referral_pct: num(o.source_referral_pct),
      monthly_visitors_timeseries: arr(o.monthly_visitors_timeseries).map(p => pick(p, x => ({ date: date(x.date), monthly_visitors: num(x.monthly_visitors) }))).filter(p => p?.date) as Array<{ date: string; monthly_visitors?: number }>,
    })) ?? {}])) } : null,
    seo: seo ? {
      total_organic_results: num(seo.total_organic_results), monthly_google_ads_budget: num(seo.monthly_google_ads_budget),
      monthly_paid_clicks: num(seo.monthly_paid_clicks), monthly_organic_clicks: num(seo.monthly_organic_clicks),
      gained_ranked_seo_keywords: num(seo.gained_ranked_seo_keywords), lost_ranked_seo_keywords: num(seo.lost_ranked_seo_keywords),
    } : null,
    competitors: pick(c.competitors, o => ({ paid_seo: strs(o.paid_seo), organic_seo: strs(o.organic_seo) })) ?? null,
    employee_reviews: er ? {
      overall_rating: pick(er.overall_rating, o => ({ rating: num(o.rating), total_count: num(o.total_count) })) ?? null,
      senior_management_rating: num(er.senior_management_rating), business_outlook_rating: num(er.business_outlook_rating),
      recommend_to_friend_rating: num(er.recommend_to_friend_rating),
    } : null,
    people: pp ? {
      founders: arr(pp.founders).map(enrichPerson).filter((p): p is EnrichPerson => !!p),
      cxos: arr(pp.cxos).map(enrichPerson).filter((p): p is EnrichPerson => !!p),
      decision_makers: arr(pp.decision_makers).map(enrichPerson).filter((p): p is EnrichPerson => !!p),
    } : null,
    news: arr(c.news).map(n => pick(n, o => ({
      article_url: str(o.article_url), article_title: str(o.article_title), article_publisher_name: str(o.article_publisher_name),
      article_publish_date: date(o.article_publish_date), confidence_score: num(o.confidence_score),
    }))).filter(Boolean) as NonNullable<CompanyData["news"]>,
    public_launches: pl ? {
      producthunt_url: str(pl.producthunt_url), rating: num(pl.rating), num_upvotes: num(pl.num_upvotes), num_reviews: num(pl.num_reviews),
      launches: arr(pl.launches).map(l => pick(l, o => ({ name: str(o.name), launched_at: num(o.launched_at) ?? date(o.launched_at), num_upvotes: num(o.num_upvotes) }))).filter(Boolean) as NonNullable<NonNullable<CompanyData["public_launches"]>["launches"]>,
    } : null,
    taxonomy: tx ? { categories: strs(tx.categories), professional_network_industry: str(tx.professional_network_industry) } : null,
    locations: lo ? { city: str(lo.city), state: str(lo.state), country: str(lo.country), headquarters: str(lo.headquarters) } : null,
  };
}

const peer = (v: unknown): PeerData | undefined => pick(v, o => {
  const bi = obj(o.basic_info), hc = obj(o.headcount), fu = obj(o.funding);
  return {
    crustdata_company_id: num(o.crustdata_company_id),
    basic_info: { name: str(bi?.name), primary_domain: str(bi?.primary_domain), year_founded: num(bi?.year_founded), company_type: str(bi?.company_type) },
    headcount: { total: num(hc?.total), growth_percent: nums(hc?.growth_percent), growth_absolute: nums(hc?.growth_absolute) },
    funding: { total_investment_usd: num(fu?.total_investment_usd), last_round_amount_usd: num(fu?.last_round_amount_usd), last_fundraise_date: date(fu?.last_fundraise_date), last_round_type: str(fu?.last_round_type) },
    followers: { count: num(obj(o.followers)?.count) },
  };
});

/** The whole bundle, ready for buildMemo. */
export function sanitizeBundle(b: Bundle): Bundle {
  const j = b.jobs;
  return {
    ...b,
    company: sanitizeCompany(b.company),
    departures: people(b.departures),
    senior_ends: people(b.senior_ends),
    jobs: j ? {
      total: num(j.total) ?? 0,
      since: date(j.since),
      titles: arr(j.titles).map(t => pick(t, o => ({ title: str(o.title) ?? "", count: num(o.count) ?? 0 }))).filter(t => t?.title) as Array<{ title: string; count: number }>,
      categories: arr(j.categories).map(t => pick(t, o => ({ category: str(o.category) ?? "", count: num(o.count) ?? 0 }))).filter(t => t?.category) as Array<{ category: string; count: number }>,
      ...(j.newest !== undefined ? { newest: j.newest ? { date: date(j.newest.date), title: str(j.newest.title) ?? "", on_record: num(j.newest.on_record) ?? 1 } : null } : {}),
    } : undefined,
    peers: b.peers ? { ...b.peers, found: arr(b.peers.found).map(peer).filter((p): p is PeerData => !!p) } : undefined,
    industries: strs(b.industries),
  };
}
