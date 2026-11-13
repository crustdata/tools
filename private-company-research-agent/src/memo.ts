/**
 * Turns what was fetched for one company (a Bundle) into a diligence memo: plain rules, no AI, no I/O. Every number
 * carries the Crustdata field it came from and a date (the date it describes where Crustdata gives one, otherwise the
 * day it was fetched), and a missing section says "not available" instead of showing zero. The bundle is sanitized
 * first, so an odd API shape cannot crash a run. Tests call `buildMemo` directly with fixture data.
 */

import { domainsOf, isoDay, monthsBefore } from "./collect.js";
import { sanitizeBundle } from "./sanitize.js";
import type { Bundle, CompanyData, EnrichPerson, EnrichRole, PeerData, Point, SearchPerson, SearchRole } from "./types.js";

// ---------------------------------------------------------------------------
// Memo shape (memo.json)
// ---------------------------------------------------------------------------

/** One number with where it came from. `as_of` is the date the number describes, or the day it was fetched. */
export type Fact = { label: string; value: number | string | null; text: string; source: string; as_of?: string };

export type Leader = {
  name: string;
  title: string;
  founder: boolean;
  joined?: string;
  prior: string[];
  /** Companies this person founded and left before joining (founder roles held at the same time are not counted). */
  founded_before: string[];
  repeat_founder: boolean;
  /** A founder or CEO role at another company that is current now. */
  also_running?: string;
  schools: string[];
  years_experience?: number;
  profile_url?: string;
  source: string;
  as_of?: string;
};

export type Leaver = {
  /** Empty when PEOPLE_DETAIL=leaders and this person is not a leader. */
  name: string;
  title: string;
  ended?: string;
  /** The end month as YYYY-MM, for sorting. */
  ended_month?: string;
  seniority?: string;
  /** A leader or a director. */
  senior: boolean;
  /** C-level, VP, founder, president (and head of, below 500 people): a departure that becomes a red flag. */
  leader: boolean;
  /** Interns and program members, advisors and contractors are listed but do not count toward attrition. */
  category: "staff" | "intern" | "advisor or contractor";
  now: string;
  /** "left" the company, or "stepped back" into a lesser role there (advisor, board, part time). */
  kind: "left" | "stepped back";
  profile_url?: string;
};

export type FunctionRow = { function: string; now: number; before?: number; change?: number; change_pct?: number };

export type Round = { date: string; type: string; amount_usd?: number; lead?: string; investors: number; secondary: boolean };

export type PeerRow = {
  name: string;
  domain?: string;
  self: boolean;
  /** "Public Company", "Privately Held" ... as Crustdata lists it. */
  type?: string;
  headcount?: number;
  growth_6m_pct?: number;
  growth_12m_pct?: number;
  followers?: number;
  total_raised_usd?: number;
  last_round?: string;
  last_round_date?: string;
};

export type Finding = {
  id: string;
  kind: "red_flag" | "signal";
  text: string;
  evidence: string;
  question?: string;
};

export type Memo = {
  schema: 1;
  asked: string;
  generated_at: string;
  data_fetched_at: string;
  credits_used: number;
  /** What a fresh run for this company costs at list price. */
  list_price_credits: number;
  company: {
    name: string;
    domain: string;
    crustdata_company_id?: number;
    description?: string;
    website?: string;
    profile_url?: string;
    founded?: number;
    hq?: string;
    status?: string;
    categories: string[];
  };
  snapshot: Fact[];
  /** The last primary round (secondary sales left out). */
  last_round?: { type: string; date?: string; amount_usd?: number };
  /** How many of the memo's main sections had data. */
  coverage: { available: number; of: number; missing: string[] };
  team: {
    leaders: Leader[];
    other_leaders: Array<{ name: string; title: string }>;
    functions: { rows: FunctionRow[]; as_of?: string; before_date?: string; source: string } | null;
    engineering_share?: Fact;
    countries: Array<{ country: string; people: number }>;
    departures: null | {
      since: string;
      /** Everyone Crustdata counts as having left (total_count), interns and contractors included. Null when the search failed. */
      total: number | null;
      /** Profiles read (LEAVERS_LIMIT caps it), plus leaders from the second search. */
      shown: number;
      /** Leavers excluding interns, advisors and contractors: exact when every leaver was read, else estimated. */
      staff_total: number | null;
      staff_estimated: boolean;
      excluded: { interns: number; advisors_or_contractors: number };
      share_of_headcount_pct?: number;
      /** True when not every leaver was read, so leaders can be missed. */
      capped: boolean;
      /** False when the departures search failed and only leaders from the second search are shown. */
      searched: boolean;
      people: Leaver[];
      stepped_back: Leaver[];
    };
    hiring: null | { since: string; postings: number; roles: number; titles: string[]; categories: Array<{ category: string; count: number }>; newest_posting?: { date?: string; title: string; on_record: number } | null; thin_for_growth?: { added_3m: number } };
  };
  growth: {
    headcount: Fact[];
    web: null | { domain: string; other_domains: string[]; facts: Fact[] };
    followers: Fact[];
    search: Fact[];
    launches: Fact[];
    reviews: Fact[];
  };
  funding: {
    facts: Fact[];
    rounds: Round[];
    funds: number;
    angels: number;
    repeat_investors: Array<{ name: string; rounds: number }>;
  };
  peers: null | { source: "auto" | "user"; rows: PeerRow[]; missing: string[]; dropped: Array<{ domain: string; reason: "small" | "large" | "unrelated" }> };
  peers_skipped?: boolean;
  news: Array<{ date: string; title: string; publisher?: string; url?: string }>;
  findings: Finding[];
  questions: string[];
  not_available: string[];
  warnings: string[];
  ai_note?: { model: string; text: string };
};

export type MemoOptions = { peopleDetail?: "all" | "leaders" };

// ---------------------------------------------------------------------------
// Formatting (shared with the markdown renderer)
// ---------------------------------------------------------------------------

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export function fmtUsd(n: number): string {
  const a = Math.abs(n);
  const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x >= 10 ? (Math.round(x * 10) / 10).toString() : (Math.round(x * 100) / 100).toString());
  if (a >= 1e9) return `$${trim(n / 1e9)}B`;
  if (a >= 1e6) return `$${trim(n / 1e6)}M`;
  if (a >= 1e3) return `$${trim(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}
/** Rounds half away from zero, so -35.5 shows as -36 like 35.5 shows as 36. */
const roundAway = (n: number, step = 1) => Math.sign(n) * Math.round(Math.abs(n) / step) * step;
export const fmtPct = (n: number, signed = true) => {
  const r = Math.abs(n) >= 10 || Number.isInteger(n) ? roundAway(n) : Math.round(roundAway(n, 0.1) * 10) / 10;
  return `${signed && r > 0 ? "+" : ""}${Object.is(r, -0) ? 0 : r}%`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-05-01T00:00:00" to "May 2026". */
export function fmtMonth(d: string | null | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})/.exec(d ?? "");
  return m && +m[2] >= 1 && +m[2] <= 12 ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : undefined;
}
/** Unix seconds (Product Hunt launches) or an ISO string, as an ISO string. */
export function whenIso(v: string | number | null | undefined): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  return typeof v === "string" && /^\d{4}-\d{2}/.test(v) ? v : undefined;
}
/** A percentage after "grew" or "fell": no sign. */
const pctBy = (n: number) => fmtPct(Math.abs(n), false);
const day = (d: string | null | undefined) => (/^\d{4}-\d{2}-\d{2}/.test(d ?? "") ? d!.slice(0, 10) : undefined);
const ROUND_NAMES: Record<string, string> = {
  pre_seed: "Pre-seed", seed: "Seed", angel: "Angel", series_unknown: "Venture round", venture: "Venture round",
  convertible_note: "Convertible note", debt_financing: "Debt", grant: "Grant", corporate_round: "Corporate round",
  private_equity: "Private equity", secondary_market: "Secondary", post_ipo_equity: "Post-IPO equity", undisclosed: "Undisclosed round",
  equity_crowdfunding: "Equity crowdfunding", initial_coin_offering: "Token sale", non_equity_assistance: "Non-equity assistance",
};
export function roundName(t: string | null | undefined): string {
  if (!t) return "Round";
  const k = t.toLowerCase();
  if (ROUND_NAMES[k]) return ROUND_NAMES[k];
  const s = /^series_([a-z])$/.exec(k);
  if (s) return `Series ${s[1].toUpperCase()}`;
  return k.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
}
const SECONDARY = /^secondary(_market)?$/i;
const fact = (label: string, value: number | string | null, text: string, source: string, as_of?: string): Fact => ({ label, value, text, source, ...(as_of ? { as_of } : {}) });
/** Whole months between two ISO dates. */
export function monthsBetween(from: string, to: string): number {
  const a = new Date(from), b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m--;
  return Math.max(0, m);
}
/** Names without emoji or stray symbols ("🥷🏽 Jane Doe, OLY" stays readable). */
export const cleanName = (s: string | null | undefined) =>
  (s ?? "").replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, "").replace(/\s+/g, " ").trim();

const ISO3: Record<string, string> = {
  USA: "United States", GBR: "United Kingdom", DEU: "Germany", FRA: "France", CAN: "Canada", IND: "India", ISR: "Israel",
  NLD: "Netherlands", SWE: "Sweden", ESP: "Spain", ITA: "Italy", IRL: "Ireland", CHE: "Switzerland", AUS: "Australia",
  SGP: "Singapore", BRA: "Brazil", JPN: "Japan", CHN: "China", KOR: "South Korea", DNK: "Denmark", FIN: "Finland",
  NOR: "Norway", BEL: "Belgium", AUT: "Austria", POL: "Poland", PRT: "Portugal", EST: "Estonia", ARE: "United Arab Emirates",
  MEX: "Mexico", ARG: "Argentina", NZL: "New Zealand", ZAF: "South Africa", NGA: "Nigeria", KEN: "Kenya", EGY: "Egypt",
  TUR: "Turkey", UKR: "Ukraine", CZE: "Czechia", ROU: "Romania", HKG: "Hong Kong", TWN: "Taiwan", IDN: "Indonesia",
  VNM: "Vietnam", PHL: "Philippines", THA: "Thailand", MYS: "Malaysia", PAK: "Pakistan", CHL: "Chile", COL: "Colombia",
  LUX: "Luxembourg", LTU: "Lithuania", LVA: "Latvia", GRC: "Greece", HUN: "Hungary", BGR: "Bulgaria", HRV: "Croatia",
  SVN: "Slovenia", SRB: "Serbia", SAU: "Saudi Arabia", QAT: "Qatar", PER: "Peru", URY: "Uruguay", ISL: "Iceland", CYP: "Cyprus", MLT: "Malta",
};
export const countryName = (c: string | null | undefined) => (c && ISO3[c.toUpperCase()]) || c || undefined;

/** Country names (English), to tell countries from states, metros and cities in headcount.by_region_absolute. */
const COUNTRY_NAMES: Set<string> = (() => {
  const names = new Set<string>(Object.values(ISO3).map(x => x.toLowerCase()));
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const a of A) for (const b of A) {
      const n = dn.of(a + b);
      if (n && n !== a + b) names.add(n.toLowerCase());
    }
  } catch { /* the built-in list above is enough */ }
  for (const extra of ["united states", "united kingdom", "czech republic", "south korea", "turkey", "russia", "vietnam"]) names.add(extra);
  return names;
})();

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** The point at or just before `date` in a time series sorted by date. */
export function pointAt<T extends { date?: string | null }>(series: T[], date: string): T | undefined {
  let best: T | undefined;
  for (const p of series) if (p.date && p.date.slice(0, 10) <= date.slice(0, 10)) best = p;
  return best;
}
const sortByDate = <T extends { date?: string | null }>(xs: T[] | null | undefined) =>
  [...(xs ?? [])].filter(p => p?.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));

/** "11-50" to [11, 50]; "10001+" to [10001, Infinity]. */
export function parseRange(r: string | null | undefined): [number, number] | undefined {
  const m = /^(\d[\d,]*)\s*(?:-|to)\s*(\d[\d,]*)$/.exec((r ?? "").trim());
  if (m) return [Number(m[1].replace(/,/g, "")), Number(m[2].replace(/,/g, ""))];
  const p = /^(\d[\d,]*)\+$/.exec((r ?? "").trim());
  if (p) return [Number(p[1].replace(/,/g, "")), Infinity];
  return undefined;
}

const FOUNDER = /\b(co-?\s?founder|founder|founding partner)\b/i;
const RUNS_COMPANY = /\b(co-?\s?founder|founder|ceo|chief executive)\b/i;
const NOT_A_COMPANY = /^(stealth|stealth mode|stealth startup|stealth ai startup|self-?employed|freelance|independent|confidential|various|n\/a|none|personal|sabbatical|career break)$/i;
const ADVISORY = /\b(advis[oe]r|advisory|board|consultant|consulting|fractional|part[- ]time|emeritus|observer|investor|venture partner|mentor|angel)\b/i;
/** Leadership titles: C-level, VP, head of, founder, president, general manager. Not "chief of staff". */
const LEADER_TITLE = /\b(chief(?! of staff)\b|ceo|cto|cfo|coo|cmo|cro|cpo|ciso|chro|vp|svp|evp|vice president|head of|founder|co-?founder|president(?!'s club)|general manager|managing director)\b/i;
/**
 * "GTM Leader" names the person who runs a team: a leader below 500 people. "Engineering Lead" is often a senior
 * engineer: a leader only below 100 people, senior above.
 */
const FUNCTION_LEADER = /^(?:gtm|go-to-market|sales|revenue|engineering|product|marketing|design|people|operations) leader$/i;
const FUNCTION_LEAD = /^(?:gtm|go-to-market|sales|revenue|engineering|product|marketing|design|people|operations) lead(?:er)?$/i;
export const SMALL_COMPANY = 100;
/** At 500 people and more, "head of" is a middle manager: only C-level, VP, founders and presidents are leaders. */
const LEADER_TITLE_BIG = /\b(chief(?! of staff)\b|ceo|cto|cfo|coo|cmo|cro|cpo|ciso|chro|vp|svp|evp|vice president|founder|co-?founder|president)\b/i;
export const BIG_COMPANY = 500;
/** Titles that read like leadership but are not a staff role: programs, contractors, advisors. */
const NOT_STAFF = /\b(advis[oe]r|ambassador|intern|fellow|volunteer|mentor|community member|creator|via\b|contract(or)?\b|freelance|agency)\b|\(via /i;
const INTERN = /\b(intern|internship|student|ambassador|trainee|apprentice|working student|werkstudent|fellow|volunteer)\b/i;
const ASSISTANT = /\b(executive assistant|personal assistant|assistant to|ea to|office manager|executive business partner)\b/i;
const DIRECTOR_TITLE = /\b(director|principal)\b/i;
/** Quota-carrying sales titles that say "director": individual contributors, not managers. */
const REP_TITLE = /^(senior |sr\.? |strategic |enterprise |global |regional )*(account|client|partner) director\b/i;
/** "Owner / Partner" and "Strategic" are left out: live, they tag talent partners and account reps. */
const LEADER_LEVELS = new Set(["CXO", "Vice President"]);

const atCompany = (r: EnrichRole, id: number | undefined) => id !== undefined && (r.employer_company_id ?? []).some(x => Number(x) === id);

function leaderFrom(p: EnrichPerson, id: number | undefined, isFounder: boolean, today: string): Leader | undefined {
  const name = cleanName(p.basic_profile?.name);
  if (!name) return undefined;
  const cur = p.experience?.employment_details?.current ?? [];
  const past = p.experience?.employment_details?.past ?? [];
  const here = cur.find(r => atCompany(r, id));
  const title = here?.employee_title?.trim() || p.basic_profile?.current_title?.trim() || "title not listed";
  const joined = here?.employee_start_date;
  const prior = past
    .filter(r => !atCompany(r, id) && r.employer_name)
    .sort((a, b) => String(b.employee_start_date ?? "").localeCompare(String(a.employee_start_date ?? "")))
    .slice(0, 3)
    .map(r => {
      const from = r.employee_start_date?.slice(0, 4), to = r.employee_end_date?.slice(0, 4);
      return `${r.employee_title?.trim() || "role"}, ${r.employer_name!.trim()}${from ? ` (${from}${to && to !== from ? ` to ${to}` : ""})` : ""}`;
    });
  // Founded before: a founder role elsewhere that ended before this person joined (a role held at the same time is
  // not a track record, it is a second job).
  const foundedBefore = [...new Set(past
    .filter(r => !atCompany(r, id) && FOUNDER.test(r.employee_title ?? "") && r.employer_name && !NOT_A_COMPANY.test(r.employer_name.trim()))
    .filter(r => r.employee_end_date && (!joined || r.employee_end_date.slice(0, 7) <= joined.slice(0, 7)))
    .sort((a, b) => String(b.employee_end_date).localeCompare(String(a.employee_end_date)))
    .map(r => `${r.employer_name!.trim()}${r.employee_end_date ? ` (to ${r.employee_end_date.slice(0, 4)})` : ""}`))].slice(0, 2);
  const elsewhere = cur.filter(r => !atCompany(r, id) && !r.employee_end_date && RUNS_COMPANY.test(r.employee_title ?? "") && !ADVISORY.test(r.employee_title ?? "")
    && r.employer_name && !NOT_A_COMPANY.test(r.employer_name.trim()) && r.employer_name.trim().toLowerCase() !== (here?.employer_name ?? "").trim().toLowerCase());
  const also = elsewhere[0];
  const starts = [...cur, ...past].map(r => r.employee_start_date).filter((d): d is string => !!d && /^\d{4}/.test(d)).sort();
  const years = starts.length ? Math.max(0, Math.floor(monthsBetween(starts[0], today) / 12)) : undefined;
  return {
    name,
    title,
    founder: isFounder || FOUNDER.test(title),
    joined: fmtMonth(joined),
    prior,
    founded_before: foundedBefore,
    repeat_founder: foundedBefore.length > 0,
    ...(also ? { also_running: `${also.employee_title!.trim()}, ${also.employer_name!.trim()}${also.employee_start_date ? ` (since ${fmtMonth(also.employee_start_date)})` : ""}` } : {}),
    schools: [...new Set((p.education?.schools ?? []).map(s => s.school?.trim()).filter((s): s is string => !!s))].slice(0, 2),
    years_experience: years,
    profile_url: p.social_handles?.professional_network_identifier?.profile_url ?? undefined,
    source: isFounder ? "people.founders" : "people.cxos",
    as_of: day(p.updated_at),
  };
}

/** The role at the company that ended most recently. */
function endedRoleAt(p: SearchPerson, id: number): SearchRole | undefined {
  const all = [...(p.experience?.employment_details?.past ?? []), ...(p.experience?.employment_details?.current ?? [])];
  return all.filter(r => r.crustdata_company_id === id && r.end_date).sort((a, b) => String(b.end_date).localeCompare(String(a.end_date)))[0];
}
const currentAt = (p: SearchPerson, id: number) => (p.experience?.employment_details?.current ?? []).filter(r => r.crustdata_company_id === id && !r.end_date);
/**
 * A leader: C-level, VP, founder, president, or head of something below 500 people, on staff (not an advisor,
 * contractor, program member or chief of staff).
 */
export function isLeader(r: SearchRole | undefined, big = false, small = false): boolean {
  if (!r || NOT_STAFF.test(r.title ?? "") || ASSISTANT.test(r.title ?? "")) return false;
  if (/chief of staff|president's club/i.test(r.title ?? "")) return false;
  const t = (r.title ?? "").trim();
  if ((!big && FUNCTION_LEADER.test(t)) || (small && FUNCTION_LEAD.test(t))) return true;
  return (big ? LEADER_TITLE_BIG : LEADER_TITLE).test(r.title ?? "") || LEADER_LEVELS.has(r.seniority_level ?? "");
}
/** Senior: a leader, a head of something, or a director. Shown in the departures table; only leaders become red flags. */
const isSenior = (r: SearchRole | undefined) =>
  isLeader(r) || (!!r && !NOT_STAFF.test(r.title ?? "") && !REP_TITLE.test((r.title ?? "").trim()) && (r.seniority_level === "Director" || DIRECTOR_TITLE.test(r.title ?? "") || FUNCTION_LEAD.test((r.title ?? "").trim())));
const categoryOf = (r: SearchRole): Leaver["category"] =>
  INTERN.test(r.title ?? "") || r.seniority_level === "In Training" ? "intern" : NOT_STAFF.test(r.title ?? "") || ADVISORY.test(r.title ?? "") ? "advisor or contractor" : "staff";

function nowText(p: SearchPerson, id: number): string {
  const cur = (p.experience?.employment_details?.current ?? []).filter(r => !r.end_date);
  const here = cur.filter(r => r.crustdata_company_id === id);
  if (here.length) return `${here[0].title?.trim() || "a role"} at the same company`;
  const other = cur.find(r => r.crustdata_company_id !== id);
  if (!other) return "no current role listed";
  return `${other.title?.trim() || "a role"}, ${other.name?.trim() || "another company"}`;
}

function leaverFrom(p: SearchPerson, id: number, kind: Leaver["kind"], big: boolean, small = false): Leaver | undefined {
  const role = endedRoleAt(p, id);
  const name = cleanName(p.basic_profile?.name);
  if (!name || !role) return undefined;
  return {
    name,
    title: role.title?.trim() || "title not listed",
    ended: fmtMonth(role.end_date),
    ended_month: role.end_date?.slice(0, 7) || undefined,
    seniority: role.seniority_level || undefined,
    senior: isSenior(role),
    leader: isLeader(role, big, small),
    category: categoryOf(role),
    now: nowText(p, id),
    kind,
    profile_url: p.social_handles?.professional_network_identifier?.profile_url ?? undefined,
  };
}

/**
 * A leader whose leadership role ended but who is still listed at the company in an advisory, board or part-time
 * role (a CTO who became an advisor). Promotions and lateral moves are not reported.
 */
export function steppedBack(p: SearchPerson, id: number, big = false): boolean {
  const ended = endedRoleAt(p, id);
  const now = currentAt(p, id);
  if (!ended || !now.length || !isLeader(ended, big)) return false;
  return now.every(r => ADVISORY.test(r.title ?? "") && !LEADER_TITLE.test((r.title ?? "").replace(ADVISORY, "")));
}

/** Country-level keys of headcount.by_region_absolute (the map mixes countries, states, metros and cities). */
export function countries(regions: Record<string, number> | null | undefined): Array<{ country: string; people: number }> {
  return Object.entries(regions ?? {})
    .filter(([k, v]) => typeof v === "number" && v > 0 && COUNTRY_NAMES.has(k.trim().toLowerCase()))
    .map(([country, people]) => ({ country, people }))
    .sort((a, b) => b.people - a.people)
    .slice(0, 6);
}

/** Functions a senior title belongs to, for "several leaders left from one team". */
const FUNCTION_GROUPS: Array<[string, RegExp]> = [
  ["Sales", /\b(sales|accounts?|revenue|business development|partnerships?|commercial|cro)\b/i],
  ["Engineering", /\b(engineer\w*|technology|technical|platform|infrastructure|cto|security|data|ml|ai research)\b/i],
  ["Product", /\b(product|cpo|design)\b/i],
  ["Marketing", /\b(marketing|brand|content|growth|communications?|community|cmo)\b/i],
  ["People", /\b(talent|people|recruit\w*|hr|human resources|chro)\b/i],
  ["Finance and operations", /\b(finance|cfo|operations|coo|legal|counsel|accounting)\b/i],
  ["Customer success", /\b(customer|support|success|services)\b/i],
];

const LAYOFF_WORDS = /\b(lay ?offs?|laid off|lays off|job cuts?|cuts? \d+ (?:jobs|staff|employees)|redundanc(?:y|ies)|restructur\w*|lawsuits?|sued|sues|suing|class action|investigat\w+|probe|data breach|breach|bankrupt\w*|insolven\w*|shut(?:s|ting)? down|wind(?:s|ing)? down|resign(?:s|ed)?|steps? down|stepping down|fraud|down round|fined|penalty|antitrust)\b/i;

const coreName = (name: string) => name.replace(/\s*\(.*?\)\s*/g, " ").replace(/[,.]?\s+(inc|llc|ltd|limited|gmbh|corp|co|plc|ai|labs|hq|technologies|technology)\.?$/i, "").trim();
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a headline names this company: its name as a word (any case) or its domain. News for a company is matched
 * by name upstream, so headlines about other things with the same name (Linear TV, the breakfast food) come back too.
 */
export function namesCompany(title: string, name: string, domain?: string | null): boolean {
  const core = coreName(name);
  if (core.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(core)}($|[^\\p{L}\\p{N}])`, "iu").test(title)) return true;
  return !!domain && title.toLowerCase().includes(domain.toLowerCase());
}

/**
 * Stricter, for a red flag: the domain is in the headline or link, or the name is written exactly as the company
 * writes it, Crustdata is confident the article is about the company (0.9 or more), and the name is not used as an
 * ordinary word next to it ("Linear TV", "linear regression").
 */
export function aboutCompany(n: { title: string; url?: string; confidence?: number }, name: string, domain?: string | null, allowUnscored = false): boolean {
  const d = (domain ?? "").toLowerCase();
  if (d) {
    let host = "";
    try { host = new URL(n.url ?? "").hostname.toLowerCase().replace(/^www\./, ""); } catch { /* no usable link */ }
    if (host === d || host.endsWith(`.${d}`)) return true;
    if (new RegExp(`(^|[^\\p{L}\\p{N}.-])${esc(d)}($|(?![.-][\\p{L}\\p{N}])[^\\p{L}\\p{N}])`, "iu").test(n.title)) return true;
  }
  if (SPAM_TITLE.test(n.title)) return false;
  try { if (DATA_SITES.test(new URL(n.url ?? "").hostname)) return false; } catch { /* no link */ }
  const core = coreName(name);
  if (core.length < 3) return false;
  if (n.confidence === undefined ? !allowUnscored : n.confidence < 0.9) return false;
  const exact = new RegExp(`(^|[^\\p{L}\\p{N}])${esc(core)}($|[^\\p{L}\\p{N}])`, "u");
  const ordinaryWord = new RegExp(`${esc(core)}\\s+(?:tv|television|networks?|motion|regression|optics|algebra|scalability|walking|trail|living)\\b`, "iu");
  return exact.test(n.title) && !ordinaryWord.test(n.title);
}

/** Download and app-store pages that ride on a company's name ("Synthesia alternatives Download Latest Release"). */
const SPAM_TITLE = /\b(download|apk|installer|latest (release|version)|free trial crack|alternatives? (download|latest)|funding rounds? & list of investors|revenue \d{4}|company profile)\b/i;
/** Company database pages are profiles, not news. */
const DATA_SITES = /(^|\.)(tracxn\.com|getlatka\.com|cbinsights\.com|pitchbook\.com|crunchbase\.com|craft\.co|owler\.com|zoominfo\.com|growjo\.com|dealroom\.co|cbinsights\.com|leadiq\.com|rocketreach\.co)$/i;

/** News deduplicated by title and link, newest first. */
export function cleanNews(items: CompanyData["news"], since: string): Array<Memo["news"][number] & { confidence?: number }> {
  const seen = new Set<string>();
  const out: Array<Memo["news"][number] & { confidence?: number }> = [];
  for (const n of [...(items ?? [])].sort((a, b) => String(b.article_publish_date ?? "").localeCompare(String(a.article_publish_date ?? "")))) {
    const date = day(n.article_publish_date);
    const title = n.article_title?.replace(/\s+/g, " ").trim();
    if (!date || !title || date < since) continue;
    const key = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 60);
    if (seen.has(key) || (n.article_url && seen.has(n.article_url))) continue;
    seen.add(key);
    if (n.article_url) seen.add(n.article_url);
    out.push({ date, title, publisher: n.article_publisher_name?.trim() || undefined, url: n.article_url ?? undefined, ...(typeof n.confidence_score === "number" ? { confidence: n.confidence_score } : {}) });
  }
  return out;
}

/** The main web domain: the one with the most monthly visitors. */
function mainDomain(c: CompanyData) {
  const entries = Object.entries(c.web_traffic?.domain_traffic ?? {}).filter(([, v]) => v && num(v.monthly_visitors) !== undefined);
  entries.sort((a, b) => (b[1].monthly_visitors ?? 0) - (a[1].monthly_visitors ?? 0));
  return entries.length ? { domain: entries[0][0], t: entries[0][1], others: entries.slice(1).map(e => e[0]) } : undefined;
}

// ---------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------

/** Question order: the most serious first. Questions are capped at 10, so the order decides what is kept. */
const RANK: Record<string, number> = {
  news_words: 0, founder_elsewhere: 1, leader_departure: 2, leader_step_back: 2, leadership_churn: 3, team_contraction: 4,
  high_attrition: 4, headcount_down_3m: 4, headcount_down_6m: 4, function_shrinking: 5, traffic_falling: 6,
  low_employee_rating: 7, weak_business_outlook: 7, long_gap_flat_team: 8,
};

export function buildMemo(input: Bundle, now: Date, opts: MemoOptions = {}): Memo {
  const b = sanitizeBundle(input);
  const c = b.company;
  const id = c.crustdata_company_id;
  const today = isoDay(now);
  const fetched = day(b.fetched_at) ?? today;
  const name = cleanName(c.basic_info?.name) || b.asked;
  const notAvailable: string[] = [];
  const warnings: string[] = [];
  const findings: Array<Finding & { rank?: number }> = [];
  const extraQuestions: string[] = [];

  // Headcount
  const hcSeries = sortByDate(c.headcount?.timeseries);
  const hcAsOf = day(hcSeries.at(-1)?.date) ?? fetched;
  const total = num(c.headcount?.total);
  const big = (total ?? 0) >= BIG_COMPANY;
  const small = total !== undefined && total < SMALL_COMPANY;
  const gp = c.headcount?.growth_percent ?? {}, ga = c.headcount?.growth_absolute ?? {};
  const growthFact = (k: "qoq" | "six_months" | "yoy" | "two_years", label: string) => {
    const p = num(gp[k]), a = num(ga[k]);
    if (p === undefined && a === undefined) return undefined;
    const text = a !== undefined && p !== undefined ? `${a > 0 ? "+" : ""}${fmtInt(a)} people (${fmtPct(p)})` : a !== undefined ? `${a > 0 ? "+" : ""}${fmtInt(a)} people` : fmtPct(p!);
    return fact(label, p ?? a ?? null, text, `headcount.growth_percent.${k}, headcount.growth_absolute.${k}`, hcAsOf);
  };
  const headcountFacts = [
    total !== undefined ? fact("Headcount", total, fmtInt(total), "headcount.total", hcAsOf) : undefined,
    growthFact("qoq", "3-month change"),
    growthFact("six_months", "6-month change"),
    growthFact("yoy", "12-month change"),
    growthFact("two_years", "24-month change"),
  ].filter((f): f is Fact => !!f);
  if (total === undefined) notAvailable.push("Headcount (headcount.total is empty for this company)");

  const range = parseRange(c.basic_info?.employee_count_range);
  if (total !== undefined && range && (total > range[1] * 3 || total * 3 < range[0])) {
    warnings.push(`Headcount from profiles is ${fmtInt(total)}, but the company page says ${c.basic_info?.employee_count_range} employees. The page range is often out of date for fast growers; if another employer shares this name, the count and the leaders below can include the wrong people. Check the leaders before relying on team numbers.`);
  }

  // Funding basics. A secondary sale is not money raised by the company: "last round" means the last primary round,
  // and total raised leaves secondaries out.
  const f = c.funding ?? {};
  const milestones = sortByDate((f.milestones ?? []).map(m => ({ ...m, date: day(m.date ?? m.funding_date) ?? null })));
  const primaries = milestones.filter(m => !SECONDARY.test(m.round_type ?? ""));
  const secondaries = milestones.filter(m => SECONDARY.test(m.round_type ?? ""));
  const lastPrimary = primaries.at(-1);
  const useMilestone = !!lastPrimary && (SECONDARY.test(f.last_round_type ?? "") || !f.last_fundraise_date || String(lastPrimary.date) >= String(day(f.last_fundraise_date)));
  const lastType = useMilestone ? lastPrimary!.round_type ?? undefined : SECONDARY.test(f.last_round_type ?? "") ? undefined : f.last_round_type ?? undefined;
  const lastDate = useMilestone ? lastPrimary!.date ?? undefined : lastType ? day(f.last_fundraise_date) : undefined;
  const lastAmount = useMilestone ? num(lastPrimary!.amount_usd) : lastType ? num(f.last_round_amount_usd) : undefined;
  const lastSource = useMilestone ? "funding.milestones" : "funding.last_round_type, funding.last_round_amount_usd, funding.last_fundraise_date";
  const secondaryDate = SECONDARY.test(f.last_round_type ?? "") ? day(f.last_fundraise_date) : undefined;
  const onRecord = num(f.total_investment_usd);
  const primarySum = primaries.reduce((s, m) => s + (num(m.amount_usd) ?? 0), 0);
  const secondarySum = secondaries.reduce((s, m) => s + (num(m.amount_usd) ?? 0), 0);
  // The total on record includes secondaries when it is at least the primary rounds plus the secondaries (5% slack).
  const totalIncludesSecondary = onRecord !== undefined && secondarySum > 0 && onRecord >= (primarySum + secondarySum) * 0.95;
  const totalRaised = onRecord === undefined ? (primarySum > 0 ? primarySum : undefined) : totalIncludesSecondary ? onRecord - secondarySum : onRecord;
  const totalFact = totalRaised === undefined ? undefined : totalIncludesSecondary
    ? fact("Total raised", totalRaised, `${fmtUsd(totalRaised)} in primary rounds (the ${fmtUsd(onRecord!)} on record also counts ${fmtUsd(secondarySum)} of secondary sales, which is not new money)`, "funding.total_investment_usd minus secondary sales in funding.milestones", fetched)
    : fact("Total raised", totalRaised, fmtUsd(totalRaised), onRecord === undefined ? "funding.milestones (sum of rounds)" : "funding.total_investment_usd", fetched);
  const hq = [c.locations?.city, c.locations?.state, countryName(c.locations?.country)].map(x => x?.trim()).filter(Boolean).join(", ") || undefined;
  const snapshot: Fact[] = [
    c.basic_info?.year_founded ? fact("Founded", c.basic_info.year_founded, String(c.basic_info.year_founded), "basic_info.year_founded", fetched) : undefined,
    hq ? fact("Headquarters", hq, hq, "locations.city, locations.state, locations.country", fetched) : undefined,
    headcountFacts[0]?.label === "Headcount" ? headcountFacts[0] : undefined,
    totalFact,
    lastType || lastDate ? fact("Last round", lastType ?? null, `${roundName(lastType)}${lastAmount !== undefined ? `, ${fmtUsd(lastAmount)}` : ""}${lastDate ? `, ${fmtMonth(lastDate)}` : ""}`, lastSource, lastDate ?? fetched) : undefined,
    secondaryDate ? fact("Latest secondary sale", secondaryDate, `${fmtMonth(secondaryDate)} (shares sold by holders, not new money)`, "funding.last_round_type, funding.last_fundraise_date", secondaryDate) : undefined,
  ].filter((x): x is Fact => !!x);
  if (totalRaised === undefined && !milestones.length) notAvailable.push("Funding (no rounds on record; the company may be bootstrapped or its rounds unannounced)");

  // Team: leaders
  const leaders: Leader[] = [];
  const seenPeople = new Set<string>();
  const keyOf = (p: EnrichPerson) => String(p.crustdata_person_id ?? cleanName(p.basic_profile?.name));
  const titleHere = (p: EnrichPerson) => (p.experience?.employment_details?.current ?? []).find(r => atCompany(r, id))?.employee_title?.trim() || p.basic_profile?.current_title?.trim() || "";
  const addLeader = (p: EnrichPerson, founder: boolean) => {
    const key = keyOf(p);
    if (!key || seenPeople.has(key)) return;
    // Executive assistants and program members sometimes come back among the executives.
    if (!founder && (ASSISTANT.test(titleHere(p)) || NOT_STAFF.test(titleHere(p)))) return;
    const l = leaderFrom(p, id, founder, today);
    if (l) { seenPeople.add(key); leaders.push(l); }
  };
  (c.people?.founders ?? []).forEach(p => addLeader(p, true));
  (c.people?.cxos ?? []).forEach(p => addLeader(p, false));
  const otherLeaders = (c.people?.decision_makers ?? [])
    .filter(p => !seenPeople.has(keyOf(p)))
    .map(p => ({ name: cleanName(p.basic_profile?.name), title: titleHere(p) }))
    .filter(p => p.name && p.title && (LEADER_TITLE.test(p.title) || DIRECTOR_TITLE.test(p.title)) && !NOT_STAFF.test(p.title) && !ASSISTANT.test(p.title) && !/chief of staff/i.test(p.title))
    .slice(0, 10);
  if (!leaders.length) notAvailable.push("Founders and executives (people.founders and people.cxos are empty)");
  const founded = c.basic_info?.year_founded;
  for (const l of leaders) {
    const joinedYear = Number(/\d{4}/.exec(l.joined ?? "")?.[0]);
    if (!l.founder && /\b(ceo|chief executive)\b/i.test(l.title) && founded && joinedYear && joinedYear <= founded + 1) {
      warnings.push(`${l.name} (${l.title} since ${l.joined}, near the founding year ${founded}) is not listed among the founders: check whether they are one.`);
    }
  }

  // Team: functions
  let functions: Memo["team"]["functions"] = null;
  const fts = c.headcount?.by_function_timeseries?.CURRENT_FUNCTION;
  if (fts && Object.keys(fts).length) {
    const lastDates = Object.values(fts).map(s => sortByDate(s).at(-1)?.date).filter((d): d is string => !!d).sort();
    const asOf = lastDates.at(-1);
    if (asOf) {
      const before = isoDay(monthsBefore(new Date(asOf.slice(0, 10) + "T00:00:00Z"), 6));
      const rows: FunctionRow[] = Object.entries(fts).map(([fn, s]) => {
        const sorted = sortByDate(s);
        const nowP = pointAt(sorted, asOf), beforeP = pointAt(sorted, before);
        const n = num(nowP?.employee_count) ?? 0;
        const bf = beforeP ? num(beforeP.employee_count) : undefined;
        return { function: fn, now: n, before: bf, change: bf !== undefined ? n - bf : undefined, change_pct: bf ? Math.round(((n - bf) / bf) * 1000) / 10 : undefined };
      }).filter(r => r.now > 0 || (r.before ?? 0) > 0).sort((a, b2) => b2.now - a.now);
      functions = { rows, as_of: day(asOf), before_date: before, source: "headcount.by_function_timeseries.CURRENT_FUNCTION" };
    }
  } else if (c.headcount?.by_role_absolute && Object.keys(c.headcount.by_role_absolute).length) {
    const g = c.headcount.by_role_growth_6m_pct ?? {};
    const rows = Object.entries(c.headcount.by_role_absolute).map(([fn, n]) => ({ function: fn, now: n, change_pct: num(g[fn]) })).sort((a, b2) => b2.now - a.now);
    functions = { rows, as_of: hcAsOf, source: "headcount.by_role_absolute, headcount.by_role_growth_6m_pct" };
  }
  if (!functions) notAvailable.push("Team by function (headcount.by_function_timeseries is empty)");
  const engPct = num(c.headcount?.by_role_percent?.Engineering);
  const engineering_share = engPct !== undefined ? fact("Engineering share", engPct, fmtPct(engPct, false), "headcount.by_role_percent.Engineering", hcAsOf) : undefined;

  // Team: departures
  let departures: Memo["team"]["departures"] = null;
  if (id !== undefined && (b.departures || b.senior_ends)) {
    const people = (b.departures?.people ?? []).map(p => leaverFrom(p, id, "left", big, small)).filter((l): l is Leaver => !!l);
    const read = people.length;
    const sample = [...people];
    const ids = new Set((b.departures?.people ?? []).map(p => p.crustdata_person_id));
    // Leaders the capped departures list did not reach.
    for (const p of b.senior_ends?.people ?? []) {
      if (ids.has(p.crustdata_person_id) || currentAt(p, id).length) continue;
      const l = leaverFrom(p, id, "left", big, small);
      if (l) { people.push(l); ids.add(p.crustdata_person_id); }
    }
    const stepped = (b.senior_ends?.people ?? []).filter(p => steppedBack(p, id, big)).map(p => leaverFrom(p, id, "stepped back", big)).filter((l): l is Leaver => !!l);
    people.sort((a, b2) => Number(b2.leader) - Number(a.leader) || Number(b2.senior) - Number(a.senior) || String(b2.ended_month ?? "").localeCompare(String(a.ended_month ?? "")));
    // The staff share is estimated from the departures sample only (the leaders added from the second search would
    // skew it toward staff). Without the departures search, there is no total to report.
    const searched = !!b.departures;
    const totalLeft = searched ? Math.max(b.departures!.total, read) : people.length;
    const interns = sample.filter(p => p.category === "intern").length;
    const others = sample.filter(p => p.category === "advisor or contractor").length;
    const staffRead = sample.length - interns - others;
    const allRead = sample.length >= totalLeft;
    const staffTotal = !sample.length ? 0 : allRead ? staffRead + (people.length - sample.length) : Math.round(totalLeft * (staffRead / sample.length));
    const seniorCapped = (b.senior_ends?.people.length ?? 0) < (b.senior_ends?.total ?? 0);
    departures = {
      since: b.departures?.since ?? b.senior_ends?.since ?? isoDay(monthsBefore(now, 12)),
      total: searched ? totalLeft : null,
      shown: people.length,
      staff_total: searched ? staffTotal : null,
      staff_estimated: searched && !allRead,
      excluded: { interns, advisors_or_contractors: others },
      share_of_headcount_pct: total && searched && (sample.length || !totalLeft) ? Math.round((staffTotal / total) * 1000) / 10 : undefined,
      searched,
      capped: searched && (read < (b.departures?.total ?? 0) || seniorCapped || !b.senior_ends),
      people,
      stepped_back: stepped,
    };
  }
  if (b.unavailable.departures) notAvailable.push(`Departures (${b.unavailable.departures}${b.senior_ends ? "; only senior role changes are shown" : ""})`);
  if (b.unavailable.senior_ends) notAvailable.push(`Leader step-backs (${b.unavailable.senior_ends}; leaders who stayed in a lesser role, or left beyond the people read, can be missed)`);

  // Team: hiring
  let hiring: Memo["team"]["hiring"] = null;
  if (b.jobs) {
    const titles = [...new Map(b.jobs.titles
      .filter(t => !/talent (pool|network|community)|general application|open application|spontaneous|future opportunit/i.test(t.title))
      .map(t => [t.title.toLowerCase().replace(/\s+/g, " ").trim(), t.title.replace(/\s+/g, " ").trim()] as const)).values()];
    hiring = {
      since: b.jobs.since ?? isoDay(new Date(now.getTime() - 90 * 86_400_000)),
      postings: b.jobs.total, roles: titles.length, titles: titles.slice(0, 12), categories: b.jobs.categories,
      ...(b.jobs.newest !== undefined ? { newest_posting: b.jobs.newest } : {}),
    };
    // Few postings next to fast hiring: the index is likely missing them (Modal: 1 posting while adding 39 people).
    const added3 = num(ga.qoq);
    if (hiring.postings > 0 && added3 !== undefined && added3 >= 8 && hiring.postings * 4 < added3) hiring.thin_for_growth = { added_3m: added3 };
  } else if (b.unavailable.jobs) notAvailable.push(`Hiring (${b.unavailable.jobs})`);

  // Growth: web traffic
  let web: Memo["growth"]["web"] = null;
  const mdom = mainDomain(c);
  if (mdom) {
    const ts = sortByDate(mdom.t.monthly_visitors_timeseries);
    const asOf = day(ts.at(-1)?.date) ?? fetched;
    const visitors = num(mdom.t.monthly_visitors)!;
    const src = `web_traffic.domain_traffic["${mdom.domain}"]`;
    const facts: Fact[] = [fact("Monthly visitors", visitors, fmtInt(visitors), `${src}.monthly_visitors`, asOf)];
    const mom = num(mdom.t.mom_pct), qoq = num(mdom.t.qoq_pct);
    if (mom !== undefined) facts.push(fact("1-month change", mom, fmtPct(mom), `${src}.mom_pct`, asOf));
    if (qoq !== undefined) facts.push(fact("3-month change", qoq, fmtPct(qoq), `${src}.qoq_pct`, asOf));
    const sixAgo = ts.length ? pointAt(ts, isoDay(monthsBefore(new Date(asOf + "T00:00:00Z"), 6))) : undefined;
    const sixV = num(sixAgo?.monthly_visitors);
    if (sixV && sixAgo?.date && sixAgo.date.slice(0, 7) !== asOf.slice(0, 7)) {
      const ch = ((visitors - sixV) / sixV) * 100;
      facts.push(fact("6-month change", Math.round(ch * 10) / 10, `${fmtPct(ch)} (from ${fmtInt(sixV)} in ${fmtMonth(sixAgo.date)})`, `${src}.monthly_visitors_timeseries`, asOf));
    }
    const mix = ([["search", mdom.t.source_search_pct], ["direct", mdom.t.source_direct_pct], ["social", mdom.t.source_social_pct], ["referral", mdom.t.source_referral_pct], ["paid referral", mdom.t.source_paid_referral_pct]] as const)
      .filter(([, v]) => num(v) !== undefined).map(([k, v]) => `${k} ${Math.round(v as number)}%`);
    if (mix.length) facts.push(fact("Traffic sources", mix.join(", "), mix.join(", "), `${src}.source_*_pct`, asOf));
    web = { domain: mdom.domain, other_domains: mdom.others, facts };
  } else notAvailable.push("Web traffic (web_traffic is empty for this company)");

  // Growth: followers
  const fol = c.followers ?? {};
  const folAsOf = day(sortByDate(fol.timeseries).at(-1)?.date) ?? fetched;
  const followers = [
    num(fol.count) !== undefined ? fact("Followers", fol.count!, fmtInt(fol.count!), "followers.count", folAsOf) : undefined,
    num(fol.qoq_percent) !== undefined ? fact("3-month change", fol.qoq_percent!, fmtPct(fol.qoq_percent!), "followers.qoq_percent", folAsOf) : undefined,
    num(fol.six_months_growth_percent) !== undefined ? fact("6-month change", fol.six_months_growth_percent!, fmtPct(fol.six_months_growth_percent!), "followers.six_months_growth_percent", folAsOf) : undefined,
    num(fol.yoy_percent) !== undefined ? fact("12-month change", fol.yoy_percent!, fmtPct(fol.yoy_percent!), "followers.yoy_percent", folAsOf) : undefined,
  ].filter((x): x is Fact => !!x);
  if (!followers.length) notAvailable.push("Followers (followers is empty)");

  // Growth: search and ads
  const seo = c.seo ?? {};
  const search = [
    num(seo.monthly_organic_clicks) !== undefined ? fact("Organic search clicks a month", seo.monthly_organic_clicks!, fmtInt(seo.monthly_organic_clicks!), "seo.monthly_organic_clicks", fetched) : undefined,
    num(seo.monthly_paid_clicks) !== undefined ? fact("Paid search clicks a month", seo.monthly_paid_clicks!, fmtInt(seo.monthly_paid_clicks!), "seo.monthly_paid_clicks", fetched) : undefined,
    num(seo.monthly_google_ads_budget) !== undefined ? fact("Estimated search ad spend a month", seo.monthly_google_ads_budget!, fmtUsd(seo.monthly_google_ads_budget!), "seo.monthly_google_ads_budget", fetched) : undefined,
    num(seo.gained_ranked_seo_keywords) !== undefined || num(seo.lost_ranked_seo_keywords) !== undefined
      ? fact("Ranked keywords gained and lost", `${seo.gained_ranked_seo_keywords ?? 0}/${seo.lost_ranked_seo_keywords ?? 0}`, `${fmtInt(seo.gained_ranked_seo_keywords ?? 0)} gained, ${fmtInt(seo.lost_ranked_seo_keywords ?? 0)} lost`, "seo.gained_ranked_seo_keywords, seo.lost_ranked_seo_keywords", fetched) : undefined,
  ].filter((x): x is Fact => !!x);
  if (!search.length) notAvailable.push("Search and ads (seo is empty)");

  // Growth: launches
  const pl = c.public_launches ?? {};
  const launchesList = (pl.launches ?? [])
    .map(l => ({ name: l.name, at: whenIso(l.launched_at) }))
    .filter((l): l is { name: string | null | undefined; at: string } => !!l.at)
    .sort((a, b2) => b2.at.localeCompare(a.at));
  const launches = [
    num(pl.rating) !== undefined ? fact("Product Hunt rating", pl.rating!, `${pl.rating} from ${fmtInt(pl.num_reviews ?? 0)} reviews`, "public_launches.rating, public_launches.num_reviews", fetched) : undefined,
    num(pl.num_upvotes) !== undefined ? fact("Product Hunt upvotes", pl.num_upvotes!, fmtInt(pl.num_upvotes!), "public_launches.num_upvotes", fetched) : undefined,
    launchesList.length ? fact("Launches", launchesList.length, `${launchesList.length}, latest ${launchesList[0].name?.trim() || "launch"} in ${fmtMonth(launchesList[0].at)}`, "public_launches.launches", day(launchesList[0].at)) : undefined,
  ].filter((x): x is Fact => !!x);
  if (!launches.length) notAvailable.push("Product launches (public_launches is empty)");

  // Growth: employee reviews
  const er = c.employee_reviews ?? {};
  const reviewCount = num(er.overall_rating?.total_count) ?? 0;
  const reviews = [
    num(er.overall_rating?.rating) ? fact("Employee rating", er.overall_rating!.rating!, `${er.overall_rating!.rating} of 5 from ${fmtInt(reviewCount)} reviews`, "employee_reviews.overall_rating", fetched) : undefined,
    num(er.senior_management_rating) ? fact("Senior management rating", er.senior_management_rating!, `${er.senior_management_rating} of 5`, "employee_reviews.senior_management_rating", fetched) : undefined,
    num(er.business_outlook_rating) !== undefined && reviewCount ? fact("Positive business outlook", er.business_outlook_rating!, fmtPct(er.business_outlook_rating! * 100, false), "employee_reviews.business_outlook_rating", fetched) : undefined,
    num(er.recommend_to_friend_rating) !== undefined && reviewCount ? fact("Would recommend to a friend", er.recommend_to_friend_rating!, fmtPct(er.recommend_to_friend_rating! * 100, false), "employee_reviews.recommend_to_friend_rating", fetched) : undefined,
  ].filter((x): x is Fact => !!x);
  if (!reviews.length) notAvailable.push("Employee reviews (employee_reviews is empty)");
  else if (reviewCount < 10) warnings.push(`Employee ratings come from ${reviewCount} review${reviewCount === 1 ? "" : "s"}: too few to read much into.`);

  // Funding
  const splitNames = (s: string | null | undefined) => (s ?? "").split(",").map(x => x.replace(/[‎‏]/g, "").trim()).filter(Boolean);
  const rounds: Round[] = [...milestones].reverse().map(m => ({
    date: m.date!,
    type: roundName(m.round_type),
    amount_usd: num(m.amount_usd),
    lead: m.lead_investors?.trim() || undefined,
    investors: splitNames(m.investors).length,
    secondary: SECONDARY.test(m.round_type ?? ""),
  }));
  const invCount = new Map<string, number>();
  for (const m of primaries) for (const n of new Set(splitNames(m.investors))) invCount.set(n, (invCount.get(n) ?? 0) + 1);
  const repeatInvestors = [...invCount].filter(([, n]) => n >= 2).map(([name2, n]) => ({ name: name2, rounds: n })).sort((a, b2) => b2.rounds - a.rounds || a.name.localeCompare(b2.name));
  const detailed = f.investors_detailed ?? [];
  const fundingFacts: Fact[] = [];
  if (totalFact) fundingFacts.push(totalFact);
  if (primaries.length) fundingFacts.push(fact("Rounds", primaries.length, `${primaries.length}${secondaries.length ? ` (plus ${secondaries.length} secondary sale${secondaries.length === 1 ? "" : "s"})` : ""}`, "funding.milestones", fetched));
  else if (num(f.num_funding_rounds) !== undefined) fundingFacts.push(fact("Rounds", f.num_funding_rounds!, String(f.num_funding_rounds), "funding.num_funding_rounds", fetched));
  let monthsSince: number | undefined;
  let addedSince: number | undefined;
  if (lastDate) {
    monthsSince = monthsBetween(lastDate, today);
    fundingFacts.push(fact("Months since last round", monthsSince, `${monthsSince === 0 ? "under 1" : monthsSince} (${roundName(lastType)}, ${fmtMonth(lastDate)})`, useMilestone ? "funding.milestones" : "funding.last_fundraise_date", lastDate));
    const atRound = pointAt(hcSeries, lastDate);
    const atRoundCount = num(atRound?.employee_count);
    if (atRoundCount !== undefined && total !== undefined && atRound?.date) {
      addedSince = total - atRoundCount;
      fundingFacts.push(fact("Headcount change since last round", addedSince, `${addedSince >= 0 ? "+" : ""}${fmtInt(addedSince)} people (${fmtInt(atRoundCount)} in ${fmtMonth(atRound.date)} to ${fmtInt(total)})`, "headcount.timeseries, headcount.total", hcAsOf));
    }
  }
  if ((f.acquired_by ?? []).length) warnings.push("Crustdata lists this company as acquired (funding.acquired_by): check its status before spending time on it.");

  // Peers
  let peers: Memo["peers"] = null;
  if (b.peers) {
    const self: PeerRow = {
      name, domain: c.basic_info?.primary_domain ?? b.asked, self: true, type: c.basic_info?.company_type ?? undefined, headcount: total,
      growth_6m_pct: num(gp.six_months), growth_12m_pct: num(gp.yoy), followers: num(fol.count),
      total_raised_usd: totalRaised, last_round: lastType ? roundName(lastType) : undefined, last_round_date: lastDate,
    };
    const rows = [self, ...b.peers.found.map((p: PeerData): PeerRow => ({
      name: cleanName(p.basic_info?.name) || p.basic_info?.primary_domain || "unknown",
      domain: p.basic_info?.primary_domain ?? undefined,
      self: false,
      type: p.basic_info?.company_type ?? undefined,
      headcount: num(p.headcount?.total),
      growth_6m_pct: num(p.headcount?.growth_percent?.["6m"]),
      growth_12m_pct: num(p.headcount?.growth_percent?.["12m"]),
      followers: num(p.followers?.count),
      total_raised_usd: num(p.funding?.total_investment_usd) || undefined,
      last_round: p.funding?.last_round_type ? roundName(p.funding.last_round_type) : undefined,
      last_round_date: day(p.funding?.last_fundraise_date),
    }))];
    peers = { source: b.peers.source, rows, missing: b.peers.missing, dropped: b.peers.dropped };
    if (!b.peers.found.length) {
      notAvailable.push(b.peers.source === "user" ? "Peers (none of the domains given were found)"
        : b.peers.asked.length ? "Peers (none of the competitors Crustdata lists is close enough in size and industry; pass --peers a.com,b.com)"
        : "Peers (Crustdata lists no competitors for this company; pass --peers a.com,b.com)");
    }
  } else if (b.unavailable.peers) notAvailable.push(`Peers (${b.unavailable.peers})`);

  const domain = c.basic_info?.primary_domain ?? b.asked;
  // The headline list uses the same test as the bad-news flag (unscored headlines allowed), so a common-word name
  // (Linear TV, a capacitive encoder) does not fill it with other things.
  const news = cleanNews(c.news, isoDay(new Date(now.getTime() - 90 * 86_400_000))).filter(n => aboutCompany(n, name, domain, true));
  for (const [k, why] of Object.entries(b.unavailable)) if (!["departures", "senior_ends", "jobs", "peers"].includes(k)) notAvailable.push(`${k} (${why})`);

  // People detail (before any finding is written, so no text names them): with PEOPLE_DETAIL=leaders, only leaders are named.
  if (opts.peopleDetail === "leaders" && departures) {
    for (const l of [...departures.people, ...departures.stepped_back]) if (!l.leader) { l.name = ""; l.profile_url = undefined; }
  }

  // -------------------------------------------------------------------------
  // Findings: red flags and signals, each with its evidence and a question
  // -------------------------------------------------------------------------
  const flag = (x: Finding) => findings.push({ ...x, rank: RANK[x.id] ?? 9 });

  for (const l of leaders.filter(x => x.also_running)) {
    flag({
      id: "founder_elsewhere", kind: "red_flag",
      text: `${l.name} (${l.title}) is also listed as ${l.also_running}.`,
      evidence: `${l.source}: experience.employment_details.current (a current founder or CEO role at another company)`,
      question: `${l.name} is also listed as ${l.also_running}: how much of their time goes to this company, and what is their role here now?`,
    });
  }

  const dep = departures as Memo["team"]["departures"];
  const leaversOut = dep?.people.filter(p => p.leader) ?? [];
  const who = (l: Leaver) => (l.name ? `${l.name} (${l.title})` : `The ${l.title}`);
  for (const l of leaversOut.slice(0, 3)) {
    flag({
      id: "leader_departure", kind: "red_flag",
      text: `${who(l)} left${l.ended ? ` in ${l.ended}` : ""}; now ${l.now}.`,
      evidence: "person search: experience.employment_details (role at this company ended, no current role there)",
      question: `${l.name || "The person"} left the ${l.title} role${l.ended ? ` in ${l.ended}` : ""}: who owns that work now, and why did they leave?`,
    });
  }
  if (leaversOut.length > 3) {
    flag({
      id: "leader_departure", kind: "red_flag",
      text: `${leaversOut.length - 3} more leader${leaversOut.length - 3 === 1 ? "" : "s"} left in the last 12 months: ${leaversOut.slice(3, 8).map(who).join(", ")}${leaversOut.length > 8 ? ", and others" : ""}.`,
      evidence: "person search: experience.employment_details",
      question: `${leaversOut.length} people in leadership roles left in the last 12 months: is that a reorganisation, and which of those roles are filled?`,
    });
  }
  for (const l of dep?.stepped_back ?? []) {
    flag({
      id: "leader_step_back", kind: "red_flag",
      text: `${l.name || `The ${l.title}`} moved from ${l.title} to ${l.now.replace(/ at the same company$/, "")}${l.ended ? ` in ${l.ended}` : ""}.`,
      evidence: "person search: experience.employment_details (senior role ended, still listed at the company)",
      question: `${l.name || "The person"} stepped back from ${l.title}${l.ended ? ` in ${l.ended}` : ""}: what prompted the change, and who replaced them?`,
    });
  }
  // Several senior people (leaders or directors) from one function leaving is a pattern even when none is C-level.
  if (dep) {
    const groups = new Map<string, Leaver[]>();
    for (const l of dep.people.filter(p => p.senior && p.category === "staff")) {
      const g = FUNCTION_GROUPS.find(([, re]) => re.test(l.title))?.[0];
      if (g) groups.set(g, [...(groups.get(g) ?? []), l]);
    }
    for (const [g, ls] of groups) {
      if (ls.length < (big ? 5 : 3)) continue;
      flag({
        id: "leadership_churn", kind: "red_flag",
        text: `${ls.length} senior ${g.toLowerCase()} people left in the last 12 months: ${ls.slice(0, 5).map(l => `${l.title}${l.ended ? ` (${l.ended})` : ""}`).join(", ")}.`,
        evidence: "person search: experience.employment_details (directors and leaders who left, grouped by title)",
        question: `${ls.length} senior people left ${g.toLowerCase()} in the last year: what happened in that team, and who leads it now?`,
      });
    }
  }

  // Team contraction: headcount down, departments shrinking and high attrition are one story, told once.
  const contraction: Array<{ id: string; text: string; evidence: string }> = [];
  const hcDrop = (k: "qoq" | "six_months", span: string) => {
    const a = num(ga[k]), p = num(gp[k]);
    if (a !== undefined && p !== undefined && a <= -3 && p <= -5) {
      contraction.push({ id: k === "qoq" ? "headcount_down_3m" : "headcount_down_6m", text: `Headcount fell by ${fmtInt(-a)} people (${pctBy(p)}) over ${span}.`, evidence: `headcount.growth_absolute.${k}, headcount.growth_percent.${k} as of ${hcAsOf}` });
      return true;
    }
    return false;
  };
  const hcDown = hcDrop("qoq", "3 months") || hcDrop("six_months", "6 months");
  for (const r of functions?.rows ?? []) {
    if (r.before !== undefined && r.before >= 5 && r.change !== undefined && r.change <= -2 && (r.change_pct ?? 0) <= -20) {
      contraction.push({ id: "function_shrinking", text: `${r.function} shrank from ${r.before} to ${r.now} people (down ${pctBy(r.change_pct!)}) in 6 months.`, evidence: `headcount.by_function_timeseries.CURRENT_FUNCTION["${r.function}"], ${functions!.before_date} to ${functions!.as_of}` });
    }
  }
  if (dep && dep.searched && dep.staff_total !== null && dep.share_of_headcount_pct !== undefined && dep.staff_total >= 5 && dep.share_of_headcount_pct >= 15) {
    contraction.push({
      id: "high_attrition",
      text: `${dep.staff_estimated ? "About " : ""}${fmtInt(dep.staff_total)} people left in the last 12 months, ${fmtPct(dep.share_of_headcount_pct, false)} of today's headcount (interns, advisors and contractors not counted).`,
      evidence: `person search total_count since ${dep.since}; headcount.total`,
    });
  }
  if (contraction.length === 1) {
    const only = contraction[0];
    flag({ id: only.id, kind: "red_flag", text: only.text, evidence: only.evidence, question: `${only.text.replace(/\.$/, "")}: what happened, and was it planned?` });
  } else if (contraction.length > 1) {
    flag({
      id: "team_contraction", kind: "red_flag",
      text: `The team is shrinking: ${contraction.map(x => x.text.replace(/\.$/, "").replace(/^(Headcount|About)\b/, w => w.toLowerCase())).join("; ")}.`,
      evidence: contraction.map(x => x.evidence).join("; "),
      question: `${hcDown ? "Headcount is down and " : ""}${contraction.length} signs point to the team shrinking: was this a planned cut, which teams were affected, and how long is the runway now?`,
    });
  }

  if (web) {
    const v = num(web.facts[0].value) ?? 0;
    const q = web.facts.find(x => x.label === "3-month change");
    const six = web.facts.find(x => x.label === "6-month change");
    if (v >= 10_000 && ((typeof q?.value === "number" && q.value <= -20) || (typeof six?.value === "number" && six.value <= -30))) {
      const used = typeof q?.value === "number" && q.value <= -20 ? q : six!;
      flag({
        id: "traffic_falling", kind: "red_flag",
        text: `Monthly visitors to ${web.domain} fell ${pctBy(used.value as number)} (${used.label.toLowerCase()}) to ${fmtInt(v)}.`,
        evidence: `${used.source} as of ${used.as_of}`,
        question: `Web visits fell ${pctBy(used.value as number)} over ${used.label.startsWith("3") ? "3" : "6"} months: is usage moving into the product, or is demand slowing?`,
      });
    } else if (v >= 10_000 && typeof q?.value === "number" && q.value >= 20) {
      flag({
        id: "traffic_growing", kind: "signal",
        text: `Monthly visitors to ${web.domain} grew ${pctBy(q.value)} over 3 months to ${fmtInt(v)}.`,
        evidence: `${q.source} as of ${q.as_of}`,
        question: `Web visits grew ${pctBy(q.value)} in 3 months to ${fmtInt(v)} a month: how many of those visitors become paying users?`,
      });
    }
  }

  if (reviewCount >= 10) {
    const r = num(er.overall_rating?.rating);
    if (r !== undefined && r > 0 && r < 3.5) flag({ id: "low_employee_rating", kind: "red_flag", text: `Employees rate the company ${r} of 5 (${reviewCount} reviews).`, evidence: "employee_reviews.overall_rating", question: `Employee reviews average ${r} of 5: what do people who leave say about the company?` });
    const o = num(er.business_outlook_rating);
    if (o !== undefined && o < 0.5) flag({ id: "weak_business_outlook", kind: "red_flag", text: `Only ${fmtPct(o * 100, false)} of reviewing employees have a positive business outlook.`, evidence: "employee_reviews.business_outlook_rating", question: `Fewer than half of reviewing employees are positive about the business outlook: what do they see that we do not?` });
  }

  const yoy = num(gp.yoy);
  if (monthsSince !== undefined && monthsSince >= 24 && (yoy === undefined || yoy <= 5)) {
    const change = yoy === undefined ? "growth over 12 months is unknown" : yoy < 0 ? `fell ${pctBy(yoy)} over 12 months` : `grew only ${pctBy(yoy)} over 12 months`;
    flag({
      id: "long_gap_flat_team", kind: "red_flag",
      text: `${monthsSince} months since the last round, and headcount ${change}.`,
      evidence: `${useMilestone ? "funding.milestones" : "funding.last_fundraise_date"}, headcount.growth_percent.yoy`,
      question: `It has been ${monthsSince} months since the last round and headcount ${change}: how long is the runway, and is the company profitable?`,
    });
  }

  const yearAgoDay = isoDay(monthsBefore(now, 12));
  const badNews = cleanNews(c.news, yearAgoDay).filter(n => LAYOFF_WORDS.test(n.title) && aboutCompany(n, name, domain));
  for (const n of badNews.slice(0, 3)) {
    flag({
      id: "news_words", kind: "red_flag",
      text: `News on ${n.date}: "${n.title}"${n.publisher ? ` (${n.publisher})` : ""}.`,
      evidence: `news.article_title${n.url ? `, ${n.url}` : ""}`,
      question: `About the ${n.date} story "${n.title.slice(0, 80)}${n.title.length > 80 ? "..." : ""}": what happened, and is it resolved?`,
    });
  }

  // Signals
  const a12 = num(ga.yoy);
  if (yoy !== undefined && a12 !== undefined && yoy >= 50 && a12 >= 10) {
    flag({ id: "fast_headcount_growth", kind: "signal", text: `Headcount grew ${pctBy(yoy)} (${fmtInt(a12)} more people) over 12 months.`, evidence: `headcount.growth_percent.yoy as of ${hcAsOf}` });
  }
  if (functions) {
    const rows = functions.rows.filter(r => r.before !== undefined && r.change !== undefined);
    const eng = rows.find(r => /^engineering$/i.test(r.function));
    const gtm = /^(sales|marketing|business development|customer success and support)$/i;
    const fastest = rows.filter(r => gtm.test(r.function) && r.now >= Math.max(5, (total ?? 0) * 0.03) && (r.change ?? 0) >= 3).sort((a, b2) => (b2.change_pct ?? 0) - (a.change_pct ?? 0))[0];
    if (fastest && eng && (fastest.change_pct ?? 0) > (eng.change_pct ?? 0) + 20) {
      flag({
        id: "function_mix_shift", kind: "signal",
        text: `${fastest.function} grew from ${fastest.before} to ${fastest.now} people (${fmtPct(fastest.change_pct!)}) in 6 months while engineering went from ${eng.before} to ${eng.now} (${fmtPct(eng.change_pct ?? 0)}).`,
        evidence: `headcount.by_function_timeseries.CURRENT_FUNCTION, ${functions.before_date} to ${functions.as_of}`,
        question: `${fastest.function} went from ${fastest.before} to ${fastest.now} people in 6 months while engineering went from ${eng.before} to ${eng.now}: what is the go-to-market motion, and how long until a new hire is productive?`,
      });
    }
  }
  const repeatFounders = leaders.filter(l => l.repeat_founder && l.founder);
  if (repeatFounders.length) {
    const names = repeatFounders.map(l => `${l.name} (${l.founded_before.join(", ")})`);
    const firstCo = repeatFounders[0].founded_before[0]?.replace(/\s*\(to \d{4}\)$/, "");
    flag({
      id: "repeat_founder", kind: "signal", text: `Founded a company before: ${names.join("; ")}.`,
      evidence: "people.founders / people.cxos experience (a founder role at another company that ended before they joined)",
      question: (() => {
        const core = (x: string) => x.replace(/\s*\(to \d{4}\)$/, "").split(/\s+\/\s+|\s+\(/)[0].trim();
        const cos = [...new Map(repeatFounders.flatMap(l => l.founded_before).map(x => [core(x).toLowerCase(), core(x)] as const)).values()].slice(0, 3);
        const who = repeatFounders.map(l => l.name);
        const people = who.length === 1 ? who[0] : `${who.slice(0, -1).join(", ")} and ${who.at(-1)}`;
        return `${people} founded ${cos.length === 1 ? cos[0] : `companies before (${cos.join(", ")})`}${cos.length === 1 ? " before" : ""}: what happened to ${cos.length === 1 ? "it" : "those companies"}, and what are you doing differently at ${name}?`;
      })(),
    });
  }
  const insiders = repeatInvestors.filter(r => r.rounds >= 3 || (primaries.length <= 3 && r.rounds >= 2));
  if (insiders.length) {
    flag({
      id: "insider_support", kind: "signal", text: `Investors back in several rounds: ${insiders.slice(0, 4).map(r => `${r.name} (${r.rounds} rounds)`).join(", ")}.`,
      evidence: "funding.milestones[].investors (primary rounds only)",
      ...(monthsSince !== undefined && monthsSince >= 9 ? { question: "If you are raising now: which existing investors are taking their pro rata?" } : {}),
    });
  }

  // Questions from the data that are not findings
  if (monthsSince !== undefined && monthsSince >= 3 && monthsSince < 24 && addedSince !== undefined && addedSince >= 5) {
    extraQuestions.push(`You have added ${fmtInt(addedSince)} people since the ${roundName(lastType)} ${monthsSince} month${monthsSince === 1 ? "" : "s"} ago: how many months of runway does the current hiring plan leave?`);
  }
  const paid = num(seo.monthly_paid_clicks), organic = num(seo.monthly_organic_clicks), budget = num(seo.monthly_google_ads_budget);
  if (paid !== undefined && organic !== undefined && paid > organic * 3 && paid >= 1000) {
    extraQuestions.push(`Paid search brings about ${fmtInt(paid)} clicks a month against ${fmtInt(organic)} organic${budget ? ` (estimated ${fmtUsd(budget)} a month on search ads)` : ""}: what is the payback on paid acquisition?`);
  }
  const cs = countries(c.headcount?.by_region_absolute);
  if (cs.length >= 2 && total) {
    const share = Math.round((cs[0].people / total) * 100);
    const second = Math.round((cs[1].people / total) * 100);
    const the = (c: string) => (/^(united |netherlands$|philippines$|czech republic$|bahamas$|gambia$)/i.test(c) ? `the ${c}` : c);
    if (share >= 40 && second >= 15) extraQuestions.push(`About ${share}% of the team is in ${the(cs[0].country)} and ${second}% in ${the(cs[1].country)}: which teams sit where, and where will the next hires go?`);
  }
  // Peer questions only from peers the user named: automatic peers are not checked by a person.
  if (peers && peers.source === "user" && peers.rows.length > 1) {
    const bigger = peers.rows.filter(r => !r.self && (r.total_raised_usd ?? 0) > (totalRaised ?? 0)).sort((a, b2) => (b2.total_raised_usd ?? 0) - (a.total_raised_usd ?? 0))[0];
    if (bigger?.total_raised_usd) extraQuestions.push(`${bigger.name} has raised ${fmtUsd(bigger.total_raised_usd)}${totalRaised !== undefined ? ` against your ${fmtUsd(totalRaised)}` : ""}: where do you win against them, and where do you lose?`);
  }
  const indexBehind = !!hiring?.newest_posting;
  if (hiring && hiring.postings === 0 && !indexBehind && monthsSince !== undefined && monthsSince <= 12) {
    extraQuestions.push(`No new job postings were found in the last 90 days, ${monthsSince} months after raising: what is the hiring plan for the next 12 months?`);
  }

  findings.sort((a, b2) => (a.kind === "red_flag" ? 0 : 1) - (b2.kind === "red_flag" ? 0 : 1) || (a.rank ?? 9) - (b2.rank ?? 9));
  const questions = [...new Set([...findings.filter(x => x.question).map(x => x.question!), ...extraQuestions])].slice(0, 10);

  const sections: Array<[string, boolean]> = [
    ["headcount", total !== undefined], ["team by function", !!functions], ["founders and executives", leaders.length > 0],
    ["departures", !!departures?.searched], ["hiring", !!hiring && (hiring.postings > 0 || !!hiring.newest_posting)], ["web traffic", !!web],
    ["followers", followers.length > 0], ["funding", totalRaised !== undefined || milestones.length > 0],
    ["employee reviews", reviews.length > 0], ["peers", !!peers && peers.rows.length > 1],
  ];

  return {
    schema: 1,
    asked: b.asked,
    generated_at: now.toISOString(),
    data_fetched_at: b.fetched_at,
    credits_used: b.credits,
    list_price_credits: b.list_credits ?? 0,
    company: {
      name,
      domain,
      crustdata_company_id: id,
      description: shortDescription(c.basic_info?.description),
      website: c.basic_info?.website ?? undefined,
      profile_url: c.basic_info?.professional_network_url ?? undefined,
      founded: c.basic_info?.year_founded ?? undefined,
      hq,
      status: c.basic_info?.status ?? undefined,
      categories: (c.taxonomy?.categories ?? []).slice(0, 8),
    },
    snapshot,
    ...(lastType || lastDate ? { last_round: { type: roundName(lastType), ...(lastDate ? { date: lastDate } : {}), ...(lastAmount !== undefined ? { amount_usd: lastAmount } : {}) } } : {}),
    coverage: { available: sections.filter(s => s[1]).length, of: sections.length, missing: sections.filter(s => !s[1]).map(s => s[0]) },
    team: { leaders, other_leaders: otherLeaders, functions, engineering_share, countries: cs, departures: dep, hiring },
    growth: { headcount: headcountFacts, web, followers, search, launches, reviews },
    funding: { facts: fundingFacts, rounds, funds: detailed.filter(d => d.type === "organization").length, angels: detailed.filter(d => d.type === "person").length, repeat_investors: repeatInvestors.slice(0, 8) },
    peers,
    ...(b.peers_skipped ? { peers_skipped: true } : {}),
    news: news.slice(0, 10).map(({ confidence, ...n }) => n),
    findings: findings.map(({ rank, ...x }) => x),
    questions,
    not_available: notAvailable,
    warnings,
  };
}

/** The company's own description, cut to whole sentences within about 280 characters. */
export function shortDescription(d: string | null | undefined): string | undefined {
  const t = (d ?? "").replace(/\s+/g, " ").replace(/([a-z])\.([A-Z])/g, "$1. $2").trim();
  if (!t) return undefined;
  if (t.length <= 280) return t;
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = "";
  for (const x of sentences) { if ((out + x).length > 280) break; out += x; }
  return (out.trim() || `${t.slice(0, 277).replace(/\s+\S*$/, "")}...`);
}

/** Points in a headcount series, for tests and the renderer. */
export const seriesOf = (pts: Point[] | null | undefined) => sortByDate(pts);
export { domainsOf };
