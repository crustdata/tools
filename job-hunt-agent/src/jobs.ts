/**
 * Jobs as this tool uses them: one clean row per role (the same role listed on three job sites is one row), with
 * the flags that matter before applying. Pure functions, no I/O; tested in test/logic.test.ts.
 */

import type { RawJob } from "./crustdata.js";

export type Job = {
  id: string;
  title: string;
  url: string | null;
  source: string | null;
  category: string | null;
  workplace: string | null;
  employmentType: string | null;
  location: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postedAt: string | null;
  description: string;
  company: {
    id: number | null;
    name: string;
    domain: string | null;
    industries: string[];
    headcount: number | null;
    lastRound: string | null;
    lastRoundDate: string | null;
    totalRaisedUsd: number | null;
  };
  /** Other listings of the same role (other job sites or cities) folded into this one. */
  alsoListed: number;
  /** Ids of every listing folded into this row, so a status set on one of them follows the role. */
  aliases?: string[];
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Job descriptions sometimes arrive as HTML; the score and the report want plain text. Only tag-shaped text is
 * removed ("<p>", "</li>"), before entities are decoded, so "<5 years" or "C++ < Go" stay. The result is only
 * ever shown escaped or inside a text fence.
 */
export function plainText(s: string): string {
  return s
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, "\n")
    .replace(/<li\b[^<>]*>/gi, "\n- ")
    .replace(/<\/?[a-z][a-z0-9-]*\b[^<>]*>/gi, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&")
    // Some boards send the HTML itself entity-encoded: strip the common tags once more, by name only.
    .replace(/<\s*(?:br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|li|ul|ol|br|strong|em|b|i|u|div|span|h[1-6]|a)\b[^<>]*>/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toJob(r: RawJob): Job | null {
  const id = r?.crustdata_job_id;
  const title = str(r?.job_details?.title);
  if ((typeof id !== "number" && typeof id !== "string") || !title) return null;
  const c = r.company ?? {};
  const b = c.basic_info ?? {};
  return {
    id: String(id),
    title,
    url: str(r.job_details?.url),
    source: str(r.job_details?.source),
    // "312 - Engineering" and "Engineering" are the same category.
    category: str(r.job_details?.category)?.replace(/^\d+\s*-\s*/, "") ?? null,
    workplace: str(r.job_details?.workplace_type),
    employmentType: str(r.job_details?.employment_type),
    location: str(r.location?.raw) ?? ([r.location?.city, r.location?.state].filter(Boolean).join(", ") || null),
    city: str(r.location?.city),
    state: str(r.location?.state),
    country: str(r.location?.country),
    postedAt: str(r.metadata?.date_added),
    description: plainText(String(r.content?.description ?? "")),
    company: {
      id: numOrNull(b.crustdata_company_id),
      name: str(b.name) ?? "Unknown company",
      domain: str(b.primary_domain)?.toLowerCase() ?? null,
      industries: Array.isArray(b.industries) ? b.industries.filter((x): x is string => typeof x === "string") : [],
      headcount: numOrNull(c.headcount?.total),
      lastRound: str(c.funding?.last_round_type),
      lastRoundDate: str(c.funding?.last_fundraise_date),
      totalRaisedUsd: numOrNull(c.funding?.total_investment_usd),
    },
    alsoListed: 0,
  };
}

/**
 * "Sr. Software Engineer (Remote) - Payments" and "Senior Software Engineer, Payments" are the same role;
 * "Software Engineer (Backend)" and "(Frontend)" are not: only places and work modes are dropped.
 */
export function roleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[()[\]]/g, " ")
    .replace(/\bsr\b\.?/g, "senior").replace(/\bjr\b\.?/g, "junior").replace(/\beng\b\.?/g, "engineer")
    .replace(/\b(remote|hybrid|on-?site|onsite|in office|us|usa|united states|san francisco|sf|bay area|new york|nyc|seattle|austin|boston|london|chicago|los angeles|la|denver|toronto)\b/g, " ")
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Listings whose openness can be checked for free come first, then company career sites, then job boards. */
const SOURCE_RANK: Record<string, number> = { greenhouse: 0, lever: 0, ashby: 0, smartrecruiters: 0, workday: 1, workable: 1, icims: 1, rippling: 1, professional_network: 2, indeed: 3 };
const rank = (j: Job) => SOURCE_RANK[j.source ?? ""] ?? 2;

/** "NORTHWIND", "Northwind AI" and "Northwind, Inc." are one company. */
export function companyKey(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|ai|labs?|hq|technologies|technology|tech|group|holdings)\b/g, " ")
    .replace(/\s+/g, " ").trim() || name.toLowerCase();
}

/**
 * One row per company and role. Listings group by Crustdata company id; a listing with no company record joins
 * the group of the same role at a company with the same name ("NORTHWIND" and "Northwind AI"). The kept listing has a
 * company record, then is the most checkable, then the newest; `aliases` keeps every folded id.
 */
export function dedupe(jobs: Job[]): Job[] {
  const groups = new Map<string, Job[]>();
  const byName = new Map<string, string>();
  const withId = jobs.filter(j => j.company.id !== null);
  const without = jobs.filter(j => j.company.id === null);
  for (const j of [...withId, ...without]) {
    const role = roleKey(j.title);
    const nameKey = `${companyKey(j.company.name)}|${role}`;
    const key = j.company.id !== null ? `${j.company.id}|${role}` : byName.get(nameKey) ?? `name:${nameKey}`;
    if (!byName.has(nameKey)) byName.set(nameKey, key);
    const g = groups.get(key);
    if (g) g.push(j); else groups.set(key, [j]);
  }
  const out: Job[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => Number(a.company.id === null) - Number(b.company.id === null) || rank(a) - rank(b) || String(b.postedAt ?? "").localeCompare(String(a.postedAt ?? "")));
    const newest = g.reduce((m, j) => (String(j.postedAt ?? "") > m ? String(j.postedAt) : m), "");
    out.push({ ...g[0], postedAt: newest || g[0].postedAt, alsoListed: g.length - 1, aliases: [...new Set(g.flatMap(j => j.aliases ?? [j.id]))] });
  }
  return out;
}

export const STAFFING = /staffing|recruiting|employment agenc|human resources services|executive search/i;
/** Agencies by name, for listings whose industry does not say so ("Acme Recruitment", "Bright Staffing"). */
export const AGENCY_NAME = /\b(recruit(?:ment|ing|ers)|staffing|headhunt\w*|talent (?:solutions|partners|acquisition group)|search (?:group|partners)|placements?|manpower|consultancy services)\b/i;

export type SkipRules = { agencies: boolean; companies: string[]; titleWords: string[] };

/** Why a job is left out before scoring, or null to keep it. */
export function skipReason(j: Job, rules: SkipRules): string | null {
  if (rules.agencies && (j.company.industries.some(i => STAFFING.test(i)) || AGENCY_NAME.test(j.company.name))) return "staffing agency";
  const name = j.company.name.toLowerCase();
  const domain = j.company.domain ?? "";
  for (const c of rules.companies) {
    const t = c.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (t && (name === t || domain === t || (t.includes(".") && domain.endsWith(`.${t}`)))) return `skipped company (${c})`;
  }
  const title = j.title.toLowerCase();
  for (const w of rules.titleWords) {
    const t = w.trim().toLowerCase();
    if (t && new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(title)) return `title has "${w}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Level and flags
// ---------------------------------------------------------------------------

/** -1 intern, 0 new grad or junior, 1 mid, 2 senior, 3 staff or lead, 4 principal and above. */
export function titleLevel(title: string): number {
  const t = ` ${title.toLowerCase()} `;
  const found: number[] = [];
  if (/\bintern(ship)?\b|\bco-?op\b/.test(t)) found.push(-1);
  if (/new grad|graduate|entry[- ]level|\bjunior\b|\bjr\b|early career|\bassociate\b(?!\s+(?:director|vp|vice president|principal|partner|general counsel))|\b(engineer|developer) i\b|\b(engineer|developer) 1\b|apprentice/.test(t)) found.push(0);
  if (/\b(engineer|developer) (ii|2)\b|\bmid[- ]level\b/.test(t)) found.push(1);
  if (/\bsenior\b|\bsr\b|\b(engineer|developer) (iii|3)\b/.test(t)) found.push(2);
  if (/\bstaff\b|\blead\b|\b(engineer|developer) (iv|4)\b|\btech lead\b/.test(t)) found.push(3);
  if (/\bprincipal\b|\bdistinguished\b|\bfellow\b|\bdirector\b|\bhead of\b|\bvp\b|vice president|\bchief\b/.test(t)) found.push(4);
  // "Senior Staff" and "Senior Principal" are the higher one; "Senior / Staff" postings take either, read as the
  // higher too, so a mid-level CV is not told it fits a staff role.
  if (found.includes(-1)) return -1;
  const high = found.filter(x => x >= 2);
  return high.length ? Math.max(...high) : found.length ? Math.min(...found) : 1;
}

export const LEVEL_NAMES: Record<number, string> = { [-1]: "intern", 0: "entry level", 1: "mid level", 2: "senior", 3: "staff or lead", 4: "principal or above" };

/** Your level from years of experience. */
export function levelFromYears(years: number | null): number | null {
  if (years === null) return null;
  if (years < 1.5) return 0;
  if (years < 4) return 1;
  if (years < 8) return 2;
  if (years < 12) return 3;
  return 4;
}

/** The smallest "N+ years of experience" a posting asks for, ignoring numbers that are not about experience. */
export function yearsRequired(description: string): number | null {
  const re = /(\d{1,2})\s*\+?\s*(?:(?:-|\u2013|to)\s*\d{1,2}\s*)?\+?\s*(?:years?|yrs?)\b(?:\s+of)?(?:\s+[\p{L}/+#.-]+){0,4}?\s+(?:experience|expertise|industry)/giu;
  let min: number | null = null;
  for (const m of description.matchAll(re)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 20 && (min === null || n < min)) min = n;
  }
  return min;
}

const NO_SPONSOR = /(?:not|unable to|cannot|can't|can not|won't|will not|do not|does not|don't|doesn't)\s+(?:currently\s+|be\s+able\s+to\s+)?(?:offer|provide|support|consider)?\s*(?:any\s+)?(?:employment\s+)?(?:visa\s+|h-?1b\s+)?sponsor(?:ship|ed|ing)?|no\s+(?:visa\s+|h-?1b\s+)?sponsorship|without\s+(?:the\s+need\s+for\s+|requiring\s+)?(?:current\s+or\s+future\s+)?(?:visa\s+|employment\s+)?sponsorship|sponsorship\s+(?:is\s+)?(?:not\s+available|unavailable)|not\s+eligible\s+for\s+(?:visa\s+|employment\s+)?sponsorship|sponsorship\s*[:\u2013\u2014-]\s*(?:not available|none|no)\b/i;
const CLEARANCE = /\b(?:security clearance|TS\/SCI|top secret|secret clearance|active clearance|clearance (?:is )?required|DoD clearance|public trust clearance)\b/i;
const CITIZEN = /\bU\.?S\.? citizen(?:ship)?\s+(?:is\s+)?required|\bmust be (?:a )?U\.?S\.? citizen|\bU\.?S\.? citizens only\b/i;

export type Flags = { noSponsorship: boolean; clearance: boolean; citizensOnly: boolean; yearsRequired: number | null };

export function flagsOf(j: Job): Flags {
  const d = j.description;
  return { noSponsorship: NO_SPONSOR.test(d), clearance: CLEARANCE.test(d), citizensOnly: CITIZEN.test(d), yearsRequired: yearsRequired(d) };
}

/** Whole days between a posting date and now; null when the date is missing or unreadable. */
export function daysSince(iso: string | null, now = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}
