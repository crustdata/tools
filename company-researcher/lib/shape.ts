// Turns raw Crustdata responses into the small, typed shapes in types.ts. Pure functions, no network,
// so the tests run them on the saved fixtures. Each block names the enrich field it reads.

import type { Company, Funding, FundingRound, Growth, Headcount, Hiring, NewsSignal, Ownership, People, Person } from "./types";
import { isCountry } from "./countries";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// Dates arrive as ISO ("2026-10-07", "2026-10-07T12:00:00Z") or, from some news sources, day first ("14-09-2026").
// Everything leaves as YYYY-MM-DD.
export function day(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{2})-(\d{2})-(\d{4})/.exec(v);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

// Free text from the data is shown as written, with a few fixes: unicode "bold" and "italic" letters become plain
// letters, em and en dashes become commas or hyphens (house style), and sentences glued together get a space.
export function cleanText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\s*[—]\s*/g, ", ")
    .replace(/–/g, "-")
    .replace(/([a-z])\.([A-Z])/g, "$1. $2")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  return cut.slice(0, cut.lastIndexOf(" ")) + "...";
}

const ROUND_NAMES: Record<string, string> = {
  pre_seed: "Pre-seed", seed: "Seed", angel: "Angel", series_unknown: "Venture round", private_equity: "Private equity",
  debt_financing: "Debt financing", secondary_market: "Secondary sale", convertible_note: "Convertible note",
  grant: "Grant", corporate_round: "Corporate round", undisclosed: "Undisclosed round", post_ipo_equity: "Post-IPO equity",
  post_ipo_debt: "Post-IPO debt", post_ipo_secondary: "Post-IPO secondary", initial_coin_offering: "Token sale", equity_crowdfunding: "Crowdfunding",
};
export function roundName(t: string | null): string | null {
  if (!t) return null;
  if (ROUND_NAMES[t]) return ROUND_NAMES[t];
  const m = /^series_([a-z])$/.exec(t);
  if (m) return `Series ${m[1].toUpperCase()}`;
  return t.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());
}

// ---------- headcount ----------
// headcount.total, growth_percent / growth_absolute keyed mom, qoq, six_months, yoy, two_years,
// by_role_absolute / by_role_percent / by_role_growth_yoy_pct, by_region_absolute / by_region_percent, timeseries.

function growth(m: any): Growth {
  return { m1: num(m?.mom), m3: num(m?.qoq), m6: num(m?.six_months), m12: num(m?.yoy), m24: num(m?.two_years) };
}

// Region labels are free text at mixed levels ("United States", "California, United States", "Dublin",
// "San Francisco Bay Area") and they overlap. Real countries (checked against a country list) go under countries;
// everything else is a place, one row per metro.
function placeKey(name: string): string {
  return name.toLowerCase().replace(/^(greater|county)\s+/, "").split(",")[0]
    .replace(/\s+(city\s+)?(metropolitan\s+area|metro\s+area|bay\s+area|area)$/, "").trim();
}
// "San Francisco Bay Area" stays; "London Area, United Kingdom" -> "London Area"; "New York, NY" -> "New York"
function placeLabel(name: string): string {
  return name.replace(/\s+Metropolitan Area$/i, " Area").split(",")[0].trim();
}
// "California, United States" is a state, not a place to show.
const STATE_LEVEL = /^[A-Za-z .]+,\s*(United States|Canada|Australia|India)$/;
// Parts of a country that are not a city or a metro.
const SUBNATIONAL = /^(england|scotland|wales|northern ireland|punjab|tamil nadu|telangana|haryana|gujarat|kerala|uttar pradesh|west bengal|ontario|quebec|british columbia|bavaria|catalonia|new south wales|victoria|maharashtra|karnataka|california|texas|new york state|florida|washington state)$/i;

const NOT_A_TEAM = new Set(["Entrepreneurship", "Education", "Military and Protective Services", "Community and Social Services", "Healthcare Services", "Real Estate"]);

function shapeHeadcount(h: any): Headcount | null {
  if (!h || num(h.total) === null) return null;
  const total = num(h.total);
  const rolesAbs: Record<string, number> = h.by_role_absolute ?? {};
  const rolesPct: Record<string, number> = h.by_role_percent ?? {};
  const rolesYoy: Record<string, number> = h.by_role_growth_yoy_pct ?? {};
  const regionsAbs: Record<string, number> = h.by_region_absolute ?? {};
  const regionsPct: Record<string, number> = h.by_region_percent ?? {};

  const byDepartment = Object.entries(rolesAbs)
    .map(([name, count]) => ({ name, count, share: num(rolesPct[name]), growth12m: num(rolesYoy[name]) }))
    .sort((a, b) => b.count - a.count);

  const regions = Object.entries(regionsAbs).map(([name, count]) => ({ name, count, share: num(regionsPct[name]) }))
    .sort((a, b) => b.count - a.count);
  const byCountry = regions.filter(r => isCountry(r.name));
  const seen = new Set<string>();
  const byMetro = regions
    .filter(r => !isCountry(r.name) && !STATE_LEVEL.test(r.name) && !SUBNATIONAL.test(r.name.split(",")[0].trim()))
    .filter(r => { const k = placeKey(r.name); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(r => ({ ...r, name: placeLabel(r.name) }));

  // timeseries is weekly; keep the last point of each month for the last 24 months.
  const months = new Map<string, number>();
  for (const p of h.timeseries ?? []) {
    const d = day(p?.date), c = num(p?.employee_count);
    if (d && c !== null) months.set(d.slice(0, 7), c);
  }
  const monthly = [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-25)
    .map(([date, count]) => ({ date, count }));
  const last = (h.timeseries ?? []).at(-1);
  const asOf = day(last?.date);

  const fn: Record<string, any[]> = h.by_function_timeseries?.CURRENT_FUNCTION ?? {};
  // Groups like "Entrepreneurship" (founders) or "Education" are functions on a profile, not teams; leave them out of the chart.
  const departmentsMonthly = byDepartment.filter(d => !NOT_A_TEAM.has(d.name)).slice(0, 5)
    .map(d => {
      const points = (fn[d.name] ?? [])
        .map((p: any) => ({ date: day(p?.date)?.slice(0, 7) ?? "", count: num(p?.employee_count) ?? 0 }))
        .filter((p: any) => p.date)
        .sort((a: any, b: any) => a.date.localeCompare(b.date));
      // End every line on today's count, so the chart's last value matches the table next to it.
      const month = asOf?.slice(0, 7);
      if (month && points.length && points.at(-1)!.date < month) points.push({ date: month, count: d.count });
      else if (month && points.length && points.at(-1)!.date === month) points[points.length - 1].count = d.count;
      return { name: d.name, points };
    })
    .filter(d => d.points.length >= 3);

  const g = growth(h.growth_percent);
  // A one month swing of 5% or more, larger than the whole quarter's, is more often a data correction than reality.
  const monthlyJumpWarning = g.m1 !== null && Math.abs(g.m1) >= 5 && (g.m3 === null || Math.abs(g.m1) >= Math.abs(g.m3) * 0.8);

  return { total, asOf, growthPercent: g, growthAbsolute: growth(h.growth_absolute), monthlyJumpWarning, byDepartment, byCountry, byMetro, monthly, departmentsMonthly };
}

// ---------- funding ----------
// funding.total_investment_usd, last_round_type, last_round_amount_usd, last_fundraise_date, investors,
// milestones (one per round), acquisitions, acquired_by. Secondary sales move existing shares, so they are kept
// in the round list but not counted as money raised.

function shapeFunding(f: any): Funding | null {
  if (!f) return null;
  const splitList = (s: unknown) => (typeof s === "string" ? s.split(",").map(x => x.trim()).filter(Boolean) : []);
  const rounds: FundingRound[] = (f.milestones ?? [])
    .map((m: any) => {
      const type = roundName(str(m.round_type));
      // Secondary sales and debt are listed but not counted as money raised.
      return { date: day(m.funding_date ?? m.date), type, amountUsd: num(m.amount_usd), leadInvestors: splitList(m.lead_investors), secondary: /secondary|debt/i.test(type ?? "") };
    })
    .sort((a: FundingRound, b: FundingRound) => (b.date ?? "").localeCompare(a.date ?? ""));
  const secondaryUsd = rounds.filter(r => r.secondary).reduce((a, r) => a + (r.amountUsd ?? 0), 0);
  const reported = num(f.total_investment_usd);
  const totalUsd = reported === null ? null : Math.max(0, reported - secondaryUsd);
  const primary = rounds.filter(r => !r.secondary);
  // The last round is the latest primary round, so a secondary sale never shows as "last raised".
  const last = primary[0] ?? null;
  const out: Funding = {
    totalUsd,
    secondaryUsd: secondaryUsd || null,
    roundCount: primary.length,
    lastRound: last ?? (f.last_round_type ? { date: day(f.last_fundraise_date), type: roundName(str(f.last_round_type)), amountUsd: num(f.last_round_amount_usd), leadInvestors: [], secondary: false } : null),
    rounds,
    investors: (f.investors ?? []).filter((x: unknown) => typeof x === "string"),
    acquisitions: (f.acquisitions ?? [])
      .map((a: any) => ({ name: str(a.acquiree_company_name) ?? "Unknown", date: day(a.announced_on_date) }))
      .sort((a: any, b: any) => (b.date ?? "").localeCompare(a.date ?? "")),
    acquiredBy: (f.acquired_by ?? []).map((a: any) => str(a?.acquirer_company_name) ?? str(a)).filter(Boolean) as string[],
  };
  if (!out.totalUsd && !out.rounds.length && !out.investors.length && !out.acquisitions.length && !out.acquiredBy.length) return null;
  return out;
}

// ---------- people ----------
// people.founders, people.cxos, people.decision_makers. Each is a person record; the role at this company and its
// start date are in experience.employment_details.current[] where employer_company_id includes this company's id.

const NOT_LEADERSHIP = /\b(assistant|partner|expert|creator|freelance|ambassador|advisor|adviser|intern|chief of staff|executive business|field cto|office|strategist|marketer|consultant|certified|certification|student|volunteer|ea|driver|author|coach|coaching|speaker|investor)\b/i;
// A real C-suite title: "Chief <function> Officer" for a known function, or the common abbreviations, as whole words.
const C_FUNCTIONS = "executive|technology|technical|financial|finance|operating|operations|marketing|product|revenue|people|information|security|information security|customer|commercial|business|legal|data|data and analytics|ai|artificial intelligence|growth|strategy|strategic|accounting|design|experience|human resources|hr|communications|compliance|risk|trust|medical|science|scientific|innovation|digital|sales|brand|transformation|investment|administrative|development|privacy|partnership|partnerships";
const EXEC_TITLES = `chief (${C_FUNCTIONS})( and [a-z ]+)? officer|ceo|cto|cfo|coo|cmo|cpo|cro|cio|ciso|cso|cdo|cco|cxo|cpto|cdao|chro|(?<!vice[ -])(?<!vice president and )president|founder|co-?founder|managing director|general manager`;
const EXECUTIVE = new RegExp(`\\b(${EXEC_TITLES})\\b`, "i");
// An executive's title starts with the role ("CEO", "Co-founder & CTO", "Chief Revenue Officer"). Titles that only
// mention a C-level word later ("Director, CEO Communications", "EA to the CEO", "Author of CEO Coaching") are not executives.
const EXECUTIVE_START = new RegExp(`^\\s*(${EXEC_TITLES})\\b`, "i");
const SENIOR = /\b(chief|ceo|cto|cfo|coo|cmo|cpo|cro|cio|ciso|founder|co-?founder|president|vp|vice president|svp|evp|head|director|general manager|gm)\b/i;
// Rank for sorting: CEO, founders, C-suite, presidents (not vice presidents), SVP/EVP, VP, head, director.
const RANK: Array<[RegExp, number]> = [
  [/\b(ceo|chief executive)\b/i, 0], [/founder/i, 1],
  [/\b(svp|evp|senior vice president|executive vice president)\b/i, 4], [/\b(vp|vice president)\b/i, 5],
  [EXECUTIVE, 2], [/\bhead\b/i, 6], [/\bdirector\b/i, 7],
];
// A title scoped to a subsidiary or a region ("CEO, Stripe Payments UK Ltd", "CRO, Asia Pacific") ranks after the
// company-wide C-suite.
const SCOPED = /(,|\bof\b|\bfor\b|\s-\s).*\b(ltd|limited|gmbh|inc|llc|bank|apac|asia|pacific|emea|europe|americas|japan|india|uk|latam|region|country)\b/i;
const rank = (title: string) => (RANK.find(([re]) => re.test(title))?.[1] ?? 9) + (SCOPED.test(title) ? 3 : 0);

function toPerson(p: any, companyId: number): Person | null {
  const current: any[] = p?.experience?.employment_details?.current ?? [];
  const here = current.find(e => (e?.employer_company_id ?? []).map(String).includes(String(companyId)));
  // "Jane Doe, CIPP/US, CIPM" -> "Jane Doe"
  const name = str(p?.basic_profile?.name)?.split(",")[0].trim() ?? null;
  const title = str(here?.employee_title) ?? str(p?.basic_profile?.current_title);
  if (!name || !title) return null;
  return {
    name,
    title: cleanText(title).replace(/\s+-\s+|-\s+(?=[A-Z])/g, ", "),
    startDate: day(here?.employee_start_date),
    location: str(p?.basic_profile?.location?.raw),
    profileUrl: str(p?.social_handles?.professional_network_identifier?.profile_url),
  };
}

// Start dates are month level ("2026-07-01" means July 2026), so compare by month.
const monthsBetween = (fromIso: string, now: Date) => (now.getUTCFullYear() - Number(fromIso.slice(0, 4))) * 12 + (now.getUTCMonth() + 1 - Number(fromIso.slice(5, 7)));

export function shapePeople(raw: any, companyId: number, foundedYear: number | null, now = new Date(), companyName = ""): People {
  const used = new Set<string>();
  const take = (list: any[], keep: (p: Person) => boolean) => {
    const out: Person[] = [];
    for (const r of list ?? []) {
      const p = toPerson(r, companyId);
      if (!p || !keep(p)) continue;
      const key = p.name.toLowerCase();
      if (used.has(key)) continue;
      used.add(key);
      out.push(p);
    }
    return out.sort((a, b) => rank(a.title) - rank(b.title) || (a.startDate ?? "9").localeCompare(b.startDate ?? "9"));
  };

  // A record without a start date at this company is usually a namesake or a duplicate profile. A start date before
  // the company existed is a fake or joke profile. A "founder" who joined years after the start is usually a partner.
  const year = (p: Person) => Number(p.startDate!.slice(0, 4));
  const plausibleDate = (p: Person) => !!p.startDate && year(p) >= 1950 && (foundedYear === null || year(p) >= foundedYear - 1);
  // "Founder/CEO of Kurtie" is someone else's company.
  const otherCompany = (p: Person) => { const m = /\b(founder|ceo|owner|president)\b.*\bof\s+([A-Z][\w&.'-]+)/i.exec(p.title); return !!m && !!companyName && !companyName.toLowerCase().startsWith(m[2].toLowerCase()); };
  const lateFounder = (p: Person) => /founder/i.test(p.title) && foundedYear !== null && year(p) > foundedYear + 5;
  const ok = (p: Person) => plausibleDate(p) && !NOT_LEADERSHIP.test(p.title) && !lateFounder(p) && !otherCompany(p);

  // Founders: anyone the founders list names (whatever their title now, e.g. "CEO"), if they were there from the start.
  const founders = take(raw?.founders ?? [], p => ok(p) && (/founder/i.test(p.title) || (foundedYear !== null && year(p) <= foundedYear + 1)));
  const executives = take(raw?.cxos ?? [], p => ok(p) && EXECUTIVE_START.test(p.title));
  const decisionMakers = take(raw?.decision_makers ?? [], p => ok(p) && SENIOR.test(p.title)).slice(0, 15);

  const everyone = [...founders, ...executives, ...decisionMakers];
  return {
    founders,
    executives,
    decisionMakers,
    recentJoins: everyone.filter(p => p.startDate && monthsBetween(p.startDate, now) <= 3).sort((a, b) => b.startDate!.localeCompare(a.startDate!)),
    executiveStarts12m: executives.filter(p => p.startDate && monthsBetween(p.startDate, now) <= 12).length,
    startDatesKnown: everyone.some(p => p.startDate),
  };
}

// ---------- the rest of the profile ----------

// Search competitors: drop hosting subdomains, SEO and review sites, and lookalike names (domains that share a name
// with the company but are someone else).
const NOT_A_COMPETITOR = /(\.vercel\.app|\.github\.io|\.netlify\.app|\.herokuapp\.com|\.wordpress\.com|\.blogspot\.com|stackoverflow\.com|wikipedia\.org|youtube\.com|reddit\.com|medium\.com|quora\.com|g2\.com|capterra\.com|trustradius\.com|getapp\.com|neilpatel\.com|hubspot\.com\/blog|forbes\.com|techcrunch\.com|top\d*[-a-z]*\.com|best[-a-z]*\.com)$/i;
function cleanCompetitors(list: unknown, selfDomain: string, name: string): string[] {
  const stem = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
  const selfRoot = selfDomain.split(".")[0];
  return [...new Set(((list as string[]) ?? [])
    .map(d => String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
    .filter(d => d && d !== selfDomain && d.includes(".") && !NOT_A_COMPETITOR.test(d))
    .filter(d => { const root = d.split(".")[0].replace(/-/g, ""); return stem.length < 4 || (!root.startsWith(stem) && root !== selfRoot); }))];
}

const TECH_LABELS: Record<string, string> = {
  "sales-marketing": "Sales and marketing", "customer-success-support": "Customer support", "data-analytics": "Data and analytics",
  "collaboration-productivity": "Collaboration", "data-ml-platform": "Data and ML platform", "cloud-infrastructure": "Cloud infrastructure",
  "engineering-devops": "Engineering and DevOps", "languages-frameworks": "Languages and frameworks", "security": "Security",
  "finance-operations": "Finance and operations", "hr-workforce": "HR", "ecommerce-payments": "Commerce and payments",
};
// Sales and marketing tools first: they say the most about how a company sells.
const TECH_ORDER = Object.keys(TECH_LABELS);
// Generic terms, protocols and file formats that technographics sometimes lists as "technologies".
const VAGUE_TECH = new Set(["saas", "next", "dns", "ci/cd", "sql", "api", "apis", "rest", "cloud", "ai", "crm", "js", "json", "markdown", "cron", "tcp", "tls", "ssl", "http", "https", "linux", "windows", "macos", "html", "css", "xml", "yaml", "csv", "email", "whatsapp", "excel", "microsoft excel", "pdf", "node", "edge", "meta", "embeddings", "spark", "hris", "oauth", "saml", "sso", "vpn", "git"]);
// "Salesforce CRM" and "Salesforce" are the same tool; so are "Outreach.io" and "Outreach".
const techKey = (n: string) => n.toLowerCase().replace(/\.(io|com|ai|so|app)$/, "").replace(/\s+(crm|inc|cloud|platform|software)$/, "").replace(/[^a-z0-9]/g, "");

// Words that suggest a headline is about a company, used when the company's name is also an everyday word.
const BUSINESS_CONTEXT = /\b(startup|company|raises?|raised|funding|series [a-z]|valuation|ceo|cto|founder|launch(es|ed)?|acquir\w*|partners?|partnership|customers?|platform|saas|software|gtm|revenue|hires?|layoffs?|cuts|ipo|integration|announces?|unveils?)\b/i;
const QUOTE_PAGE = /(stock price|news, quote|share price|stock quote|\(nyse:|\(nasdaq:)/i;
const SIGNALS: Array<[NewsSignal["kind"], RegExp]> = [
  ["layoffs", /\b(lay(s|ing)? off|layoffs?|job cuts|cuts? (nearly |about |over )?\d+%? (of )?(its )?(workforce|staff|jobs)|workforce reduction|restructur\w*)\b/i],
  // An exit needs both an executive and a leaving verb: "Vercel Labs ships a compiler that leaves the engine behind" is not one.
  ["exec_exit", /\b(ceo|cto|cfo|coo|cmo|cro|cpo|chief [a-z]+ officer|co-?founder|founder|president|executive|head of [a-z]+)\b.*\b(steps? down|to (exit|depart|leave)|departs?|resigns?|exits?|leaves( the company)?|ousted|replaced)\b|\b(steps? down|resigns?|departs?|ousted) as (ceo|cto|cfo|coo|chief|president|founder)/i],
  ["funding", /\b(raises?|raised|funding|series [a-z]|valuation|ipo)\b/i],
  ["acquisition", /\b(acquires?|acquired|acquisition|buys|to buy|merger)\b/i],
  ["launch", /\b(launch(es|ed)?|unveils?|introduces?|releases?)\b/i],
];

export function shapeCompany(cd: any, now = new Date()): Company {
  const b = cd.basic_info ?? {};
  const domain = str(b.primary_domain) ?? "";
  const name = str(b.name) ?? domain;

  // web_traffic.domain_traffic.<domain>.monthly_visitors, mom_pct, qoq_pct, source_*_pct. Side domains with under 1% of
  // the main site's traffic are usually someone else's site attached by mistake, so they are left out.
  const trafficAll = Object.values(cd.web_traffic?.domain_traffic ?? {}).map((t: any) => ({
    domain: String(t.domain), monthlyVisitors: num(t.monthly_visitors) ?? 0, mom: num(t.mom_pct), qoq: num(t.qoq_pct),
    searchShare: num(t.source_search_pct), directShare: num(t.source_direct_pct),
  })).filter(t => t.monthlyVisitors > 0).sort((a, b) => (b.domain === domain ? 1 : 0) - (a.domain === domain ? 1 : 0) || b.monthlyVisitors - a.monthlyVisitors);
  const mainVisits = trafficAll[0]?.monthlyVisitors ?? 0;
  const traffic = trafficAll.filter((t, i) => i === 0 || t.monthlyVisitors >= mainVisits * 0.01);

  // technographics.technologies[].name, categories[0].super_slug
  const techGroups = new Map<string, string[]>();
  const seenTech = new Set<string>();
  for (const t of cd.technographics?.technologies ?? []) {
    const n = str(t?.name);
    if (!n || n.length < 3 || VAGUE_TECH.has(n.toLowerCase()) || n.toLowerCase().startsWith(name.toLowerCase().split(" ")[0]) || /\b(windows server|pci dss)\b/i.test(n)) continue;
    const k = techKey(n);
    if (seenTech.has(k)) continue;
    seenTech.add(k);
    const slug = t.categories?.[0]?.super_slug ?? "other";
    const list = techGroups.get(slug) ?? [];
    if (list.length < 8) list.push(n);
    techGroups.set(slug, list);
  }
  const techStack = cd.technographics
    ? {
        total: num(cd.technographics.total_technologies) ?? 0,
        byCategory: [...techGroups.entries()].filter(([slug, names]) => slug !== "other" && names.length)
          .sort(([a], [b]) => (TECH_ORDER.indexOf(a) + 99) % 99 - (TECH_ORDER.indexOf(b) + 99) % 99)
          .map(([slug, names]) => ({ category: TECH_LABELS[slug] ?? slug.replace(/-/g, " "), names })).slice(0, 8),
      }
    : null;

  // employee_reviews: ratings out of 5; recommend_to_friend_rating and business_outlook_rating are 0 to 1. The overall
  // score comes from the star buckets, which can be far fewer than the total review count, so both are kept.
  const er = cd.employee_reviews;
  const pct = (v: unknown) => (num(v) === null ? null : Math.round((v as number) * 100));
  const buckets = er?.overall_rating ? [1, 2, 3, 4, 5].map(i => num(er.overall_rating[`rating_${i}_count`]) ?? 0).reduce((a, x) => a + x, 0) : 0;
  const ratingsCount = buckets || num(er?.overall_rating?.total_count) || null;
  const employeeRatings = er && num(er.overall_rating?.rating) !== null
    ? {
        overall: num(er.overall_rating?.rating), reviews: num(er.overall_rating?.total_count) ?? num(er.review_count),
        ratingsCount, lowSample: (ratingsCount ?? 0) < 10,
        culture: num(er.culture_and_values_rating), workLife: num(er.work_life_balance_rating),
        careerGrowth: num(er.career_opportunities_rating), management: num(er.senior_management_rating),
        compensation: num(er.compensation_and_benefits_rating),
        recommendPercent: pct(er.recommend_to_friend_rating), outlookPercent: pct(er.business_outlook_rating),
      }
    : null;

  // news[].article_title, article_url, article_publisher_name, article_publish_date. Only articles that name the
  // company count. When the name is also an everyday word ("Unify", "Retool"), the headline must also read as business
  // news, or name the domain. Quote pages and repeats are dropped.
  const since90 = new Date(now.getTime() - 90 * 86400_000).toISOString().slice(0, 10);
  const root = domain.split(".")[0].toLowerCase();
  const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const rawTitles: string[] = (cd.news ?? []).map((n: any) => String(n?.article_title ?? ""));
  const everyday = /^[A-Za-z]+$/.test(name) && (root !== name.toLowerCase() || rawTitles.some(t => new RegExp(`\\b${name.toLowerCase()}[a-z]*\\b`).test(t)));
  const about = (title: string, url: string) =>
    title.toLowerCase().includes(domain.toLowerCase()) || url.toLowerCase().includes(root) && root.length > 4 ||
    (nameRe.test(title) && (!everyday || BUSINESS_CONTEXT.test(title)));
  const seenNews = new Set<string>();
  const news = (cd.news ?? []).map((n: any) => ({
    title: cleanText(str(n.article_title) ?? ""), url: str(n.article_url) ?? "",
    publisher: str(n.article_publisher_name)?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null,
    date: day(n.article_publish_date),
  }))
    .filter((n: any) => n.title && n.url && n.date && n.date >= since90 && !QUOTE_PAGE.test(n.title) && about(n.title, n.url))
    .filter((n: any) => {
      const k = n.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 8).join(" ");
      if (seenNews.has(k) || seenNews.has(n.url)) return false;
      seenNews.add(k); seenNews.add(n.url); return true;
    })
    .sort((a: any, b: any) => (b.date ?? "").localeCompare(a.date ?? ""));
  // A headline where the company is only a backer or a former employer is about someone else: "Vercel-backed Photon
  // raises $4.5M" is Photon's round, not Vercel's. Such a headline stays in the news list but is never a signal.
  const n0 = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const otherSubject = new RegExp(`\\b${n0}[-\\s](backed|owned|funded|alums?|alumni|veterans?)\\b|\\b(ex|former)[-\\s]${n0}\\b|\\bbacked by ${n0}\\b`, "i");
  // Funding, acquisitions and launches count only when the company itself does it: "Clay raises", "HubSpot (HUBS)
  // unveils", "Stripe's Bridge launches". Not "Truist raises price target on HubSpot", "Clay Cooley acquires", or a
  // "funding rounds and investors" directory page.
  const SUBJECT_VERBS: Partial<Record<NewsSignal["kind"], string>> = {
    funding: "raises|raised|closes|secures|lands|nabs|bags|valued at",
    acquisition: "acquires|acquired|buys|to acquire|to buy|completes acquisition of|snaps up",
    launch: "launch(es|ed)?|unveils|introduces|releases|debuts|rolls out",
  };
  const doesIt = (kind: NewsSignal["kind"], title: string) => {
    const verbs = SUBJECT_VERBS[kind];
    if (!verbs) return true;
    if (kind === "funding" && /price target|list of investors|funding rounds|stock|shares/i.test(title)) return false;
    return new RegExp(`\\b${n0}(\\s*\\([A-Z.:]+\\))?('s\\s+\\S+)?\\s+(${verbs})\\b`, "i").test(title);
  };
  const newsSignals: NewsSignal[] = [];
  for (const n of news) {
    if (otherSubject.test(n.title)) continue;
    const hit = SIGNALS.find(([kind, re]) => re.test(n.title) && doesIt(kind, n.title));
    if (hit && !newsSignals.some(s => s.kind === hit[0])) newsSignals.push({ kind: hit[0], title: n.title, date: n.date, url: n.url });
  }

  // social_posts[].text, share_url, date_posted, engagement.total_reactions, total_comments. A count of 0 is often
  // missing data, so it is kept as null.
  const posts = (cd.social_posts ?? []).map((p: any) => ({
    date: day(p.date_posted), text: cleanText(String(p.text ?? "")).replace(/https?:\/\/\S+/g, "").replace(/([^\s.!?:;,])[ \t]*\n+\s*/g, "$1. ").replace(/\s+/g, " ").trim(), url: str(p.share_url)?.split("?")[0] ?? null,
    reactions: num(p.engagement?.total_reactions) || null, comments: num(p.engagement?.total_comments) || null,
  })).filter((p: any) => p.text).slice(0, 6);

  const comp = cd.competitors;
  const competitors = comp
    ? { paidSearch: cleanCompetitors(comp.paid_seo, domain, name).slice(0, 8), organicSearch: cleanCompetitors(comp.organic_seo, domain, name).slice(0, 6) }
    : null;

  // Ownership: public companies and acquired ones should not be described by their last venture round.
  const type = str(b.company_type) ?? "";
  const ownership: Ownership = /public/i.test(type) || num(cd.revenue?.public_markets?.ipo_date) !== null || !!str(cd.revenue?.public_markets?.ipo_date)
    ? "public" : (cd.funding?.acquired_by ?? []).length || str(cd.revenue?.acquisition_status) ? "acquired" : "private";

  const fo = cd.followers;
  return {
    id: cd.crustdata_company_id,
    name,
    domain,
    website: str(b.website),
    logoUrl: str(b.logo_permalink),
    description: str(b.description) ? shorten(cleanText(b.description), 320) : null,
    founded: num(b.year_founded),
    companyType: type || null,
    ownership,
    industry: str(cd.taxonomy?.professional_network_industry) ?? str(b.industries?.[0]),
    categories: (cd.taxonomy?.categories ?? []).slice(0, 6),
    headquarters: str(cd.locations?.headquarters),
    employeeRange: str(b.employee_count_range),
    headcount: shapeHeadcount(cd.headcount),
    funding: shapeFunding(cd.funding),
    webTraffic: cd.web_traffic ? traffic.slice(0, 5) : null,
    followers: fo && num(fo.count) !== null
      ? { count: fo.count, m1: num(fo.mom_percent), m3: num(fo.qoq_percent), m6: num(fo.six_months_growth_percent), m12: num(fo.yoy_percent) }
      : null,
    techStack,
    employeeRatings,
    competitors: competitors && (competitors.paidSearch.length || competitors.organicSearch.length) ? competitors : null,
    news: news.slice(0, 8),
    newsLast90d: news.length,
    newsSignals,
    posts,
  };
}

// ---------- hiring ----------
// /job/search: total_count of postings added in the last 90 days, the same for the 90 days before, a group_by on
// job_details.title for the last 90 days, and the newest 15 listings. The source's category field is mostly "Others",
// so the role type is read from the title instead ("Account Executive" and "SDR" are Sales).

const ROLE_TYPES: Array<[string, RegExp]> = [
  ["Sales", /\b(sales|account executive|ae|sdr|bdr|business development|account manager|revops|revenue operations|partnerships?|solutions? (consultant|engineer|architect)|pre-?sales|growth strategist|deployment strategist|gtm)\b/i],
  ["Marketing", /\b(marketing|marketer|brand|content|seo|growth|demand gen|communications|pr|social media|events?|community)\b/i],
  ["Customer success", /\b(customer (success|support|experience)|support (engineer|specialist)|implementation|onboarding|account management|technical account)\b/i],
  ["Engineering", /\b(engineer(ing)?|developer|software|devops|sre|infrastructure|platform|backend|frontend|full[- ]?stack|mobile|ios|android|security|qa|test|architect|cto|machine learning|ml|ai)\b/i],
  ["Data", /\b(data|analytics|analyst|scientist|bi)\b/i],
  ["Product and design", /\b(product|design(er)?|ux|ui|research(er)?)\b/i],
  ["Finance and legal", /\b(finance|financial|accountant|accounting|controller|fp&a|tax|legal|counsel|lawyer|compliance|cfo|treasury|payroll)\b/i],
  ["People and operations", /\b(recruit(er|ing)|talent|people|hr|human resources|operations|office|workplace|executive assistant|chief of staff|it support|procurement)\b/i],
];
export function roleType(title: string): string {
  return ROLE_TYPES.find(([, re]) => re.test(title))?.[0] ?? "Other";
}

// The same role is often listed once per location string on the same day: keep one.
function dedupeJobs<T extends { title: string; date: string | null }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter(j => { const k = `${j.title.toLowerCase()}|${j.date}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function shapeHiring(jobs: { recent: any; previous: any; newest: any; window: { from90: string; from180: string } }): Hiring {
  const recentCount = num(jobs.recent?.total_count);
  const prevCount = num(jobs.previous?.total_count) ?? num(jobs.previous?.aggregations?.[0]?.value);
  const counts = new Map<string, number>();
  let counted = 0;
  for (const bucket of jobs.recent?.aggregations?.[0]?.buckets ?? []) {
    const type = roleType(String(bucket.key ?? ""));
    counts.set(type, (counts.get(type) ?? 0) + bucket.count);
    counted += bucket.count;
  }
  // Titles beyond the bucket limit are rare; they are counted as Other so the bars add up to the total.
  if (recentCount !== null && recentCount > counted) counts.set("Other", (counts.get("Other") ?? 0) + recentCount - counted);
  const byRoleType = [...counts.entries()].map(([type, count]) => ({ type, count }))
    .sort((a, b) => (a.type === "Other" ? 1 : 0) - (b.type === "Other" ? 1 : 0) || b.count - a.count);
  const changePercent = recentCount !== null && prevCount ? ((recentCount - prevCount) / prevCount) * 100 : null;
  return {
    postingsLast90d: recentCount,
    postingsPrev90d: prevCount,
    changePercent,
    byRoleType,
    salesRoles: recentCount === null ? null : counts.get("Sales") ?? 0,
    newest: dedupeJobs((jobs.newest?.job_listings ?? []).map((j: any) => {
      const title = cleanText(str(j.job_details?.title) ?? "Untitled role");
      return { title, roleType: roleType(title), location: str(j.location?.raw), workplace: str(j.job_details?.workplace_type), date: day(j.metadata?.date_added), url: str(j.job_details?.url) };
    })),
    window: jobs.window,
  };
}
