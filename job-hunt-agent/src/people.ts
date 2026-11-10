/**
 * Who to talk to about a job: the likely recruiter, the likely hiring manager, two or three people on the team,
 * and alumni from your school who work there. This file builds the searches and picks from the answers (pure);
 * hunt.ts sends them. Each search is one Crustdata person search at that company, ranked by a short query.
 */

import type { Filter, RawPerson, RawRole } from "./crustdata.js";
import type { Job } from "./jobs.js";

export type Kind = "recruiter" | "manager" | "team" | "alumni";

export type Person = {
  kind: Kind;
  name: string;
  title: string;
  location: string | null;
  profileUrl: string | null;
  since: string | null;
  school: string | null;
  schoolYear: number | null;
  email: string | null;
  /** The one person to write to first for this job (one per company in a run). */
  first?: boolean;
  /** Also listed under this better-ranked job of the same run (1-based): write to them once, about both. */
  alsoFor?: number;
};

/** Who to write to first: an alum is the warmest, then the recruiter, then the manager, then the team. */
export function chooseFirst(people: Person[], jobTitle?: string): void {
  // An alum in the job's line of work first, then the recruiter, the manager, any alum, the team.
  const fn = jobTitle ? functionOf({ title: jobTitle, category: null }) : null;
  const near = people.find(x => x.kind === "alumni" && (!fn || sameLine(functionOf({ title: x.title, category: null }), fn)));
  const pick = near ?? (["recruiter", "manager", "alumni", "team"] as Kind[]).map(k => people.find(x => x.kind === k)).find(Boolean);
  if (pick) pick.first = true;
}

export type Fn = "engineering" | "data" | "product" | "design" | "sales" | "marketing" | "operations" | "other";

/** The team a job sits in, from its title first and then its category. */
export function functionOf(job: Pick<Job, "title" | "category">): Fn {
  const t = job.title.toLowerCase();
  // The role noun decides first ("Product Manager, AI" is product, "Account Executive, AI Solutions" is sales);
  // AI, ML and data words only decide for engineering and science roles.
  if (/product marketing|marketing|growth|content|brand|\bseo\b|communications/.test(t)) return "marketing";
  if (/account executive|\bsales\b|business development|\bsdr\b|\bbdr\b|account manager|solutions consultant/.test(t)) return "sales";
  if (/product manager|product owner|\bpm\b|product lead|head of product|director of product|vp,? product/.test(t)) return "product";
  if (/design|\bux\b|\bui\b|user research/.test(t)) return "design";
  if (/data scien|machine learning|\bml\b|\bai\b|research scien|analytics|data analyst|data engineer/.test(t)) return "data";
  if (/engineer|developer|\bswe\b|\bsde\b|programmer|devops|\bsre\b|architect|firmware|software/.test(t)) return "engineering";
  if (/operations|\bops\b|finance|legal|people|recruit|support|success/.test(t)) return "operations";
  const c = (job.category ?? "").toLowerCase();
  if (/engineering|information technology/.test(c)) return "engineering";
  if (/data/.test(c)) return "data";
  if (/product/.test(c)) return "product";
  if (/design|art/.test(c)) return "design";
  if (/sales|business development/.test(c)) return "sales";
  if (/marketing/.test(c)) return "marketing";
  return "other";
}

const MANAGER_QUERY: Record<Fn, string> = {
  engineering: "engineering manager",
  data: "data engineering manager, analytics manager or head of data",
  product: "director of product or group product manager",
  design: "design manager or head of design",
  sales: "sales manager or head of sales",
  marketing: "marketing manager or head of marketing",
  operations: "operations manager",
  other: "manager",
};

/** The job title without level words and places, for ranking people by it: "Senior Backend Engineer (Remote)" to "Backend Engineer". */
export function plainTitle(title: string): string {
  return title
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\s[-\u2013\u2014|,]\s.*$/, "")
    .replace(/\b(senior|sr\.?|junior|jr\.?|staff|principal|lead|intern|new grad|entry[- ]level|i{1,3}|iv|[1-4])\b/gi, " ")
    .replace(/[^\p{L}\p{N}+#/& ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim() || title;
}

export type PeopleSearch = { kind: Kind; query: string; limit: number; extra?: Filter; local?: boolean };

/** Country names as profiles store them: the US appears both ways. */
export function countryFilter(country: string): Filter {
  const us = /^(us|usa|u\.s\.a?\.?|united states(?: of america)?)$/i.test(country.trim());
  return us
    ? { field: "basic_profile.location.country", type: "in", value: ["United States", "United States of America"] }
    : { field: "basic_profile.location.country", type: "=", value: country.trim() };
}

/**
 * The searches for one job, in order. Recruiter, manager and team are looked for in the job's country first
 * (`local`), so a San Francisco job does not get a recruiter in London; hunt.ts searches again without the country
 * when that finds nobody. Alumni are looked for anywhere. Alumni only when you named a school.
 */
export function searchesFor(job: Job, schools: string[], counts = { recruiter: 2, manager: 1, team: 3, alumni: 3 }, country?: string | null): PeopleSearch[] {
  const fn = functionOf(job);
  const role = plainTitle(job.title);
  const recruiter = fn === "engineering" || fn === "data" ? `technical recruiter hiring ${fn === "data" ? "data and machine learning" : "software"} engineers` : `recruiter hiring for ${role}`;
  const where = country ? countryFilter(country) : undefined;
  const out: PeopleSearch[] = [
    // Managers ask for one more than shown, so a recruiting manager can be dropped without a second call.
    { kind: "recruiter", query: recruiter, limit: counts.recruiter, extra: where, local: Boolean(where) },
    // The role in the query ranks managers of that kind of work first ("engineering manager Backend Engineer").
    { kind: "manager", query: `${fn === "data" && /\b(ml|machine learning|ai|scientist)\b/i.test(job.title) ? "machine learning or data science manager" : MANAGER_QUERY[fn]} ${role}`, limit: counts.manager + 1, extra: where, local: Boolean(where) },
  ];
  if (schools.length && counts.alumni > 0) {
    out.push({
      kind: "alumni", query: role, limit: counts.alumni,
      extra: schools.length === 1
        ? { field: "education.schools.school", type: "[.]", value: schools[0] }
        : { op: "or", conditions: schools.map(s => ({ field: "education.schools.school", type: "[.]", value: s })) },
    });
  }
  // Team last: someone who is both an alum and on the team shows as an alum, the warmer way in.
  out.push({ kind: "team", query: role, limit: counts.team, extra: where, local: Boolean(where) });
  return out;
}

const RECRUITING = /recruit|talent|sourc(er|ing)|people partner|hiring|\bta\b|people operations/i;
const MANAGING = /manager|\bhead\b|director|\blead\b|\bleader\b|supervisor|\b[se]?vp\b|vice president|chief|founder|\bcto\b|\bceo\b/i;
/** Whole words, so "Onboarding", "Dashboard" and "Los Angeles" never read as board members or angels. */
const NOT_STAFF = /\b(advisor|adviser|advisory|investor|board member|board of directors|member of the board|contractor|freelancer?|freelance|consultant|contributor|volunteer|ambassador|expert|mentor|angel investor|venture partner|annotator|tutor)\b/i;
/** A recruiting title, unless it is an engineering role on a recruiting product ("Engineering Manager, Talent Platform"). */
const isRecruiting = (title: string) => RECRUITING.test(title) && !/engineer|developer|software|platform|product/i.test(title);

/** Lowercase, accents removed, punctuation to spaces: "St. John’s" and "St Johns" compare equal. */
export const fold = (s: string): string =>
  s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/['\u2019]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A list from the API that may be missing, a single object, or hold nulls. */
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []).filter((x): x is T => Boolean(x) && typeof x === "object");

/** The title the person holds at this company (people can hold several current roles). */
export function roleAt(p: RawPerson, companyId: number): { title: string; since: string | null } | null {
  if (!p || typeof p !== "object") return null;
  const roles = list<RawRole>(p.experience?.employment_details?.current)
    .filter(r => Number(r.crustdata_company_id) === companyId && typeof r.title === "string" && r.title.trim());
  if (!roles.length) return null;
  const staff = roles.find(r => !NOT_STAFF.test(String(r.title))) ?? roles[0];
  return { title: String(staff.title).trim(), since: typeof staff.start_date === "string" ? staff.start_date : null };
}

/** Lowercased profile URL without query, fragment or trailing slash, for spotting the same person twice. */
export function profileKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${decodeURIComponent(u.pathname).replace(/\/+$/, "").toLowerCase()}`;
  } catch { return url.trim().toLowerCase(); }
}

const BAY_AREA = /san francisco|bay area|oakland|san jose|palo alto|mountain view|menlo park|sunnyvale|san mateo|redwood city|berkeley|santa clara|cupertino|foster city|burlingame|emeryville|fremont/;
const STATES: Record<string, string> = { ca: "california", ny: "new york", wa: "washington", tx: "texas", ma: "massachusetts", il: "illinois", co: "colorado", ga: "georgia", nc: "north carolina", va: "virginia", or: "oregon", fl: "florida", pa: "pennsylvania", nj: "new jersey", az: "arizona", ut: "utah", mn: "minnesota", oh: "ohio", mi: "michigan", md: "maryland", dc: "district of columbia" };

/** 2 when the person is in the job's city (or both are in the Bay Area), 1 in its state, 0 otherwise. */
export function nearness(personPlace: string | null | undefined, job: { city?: string | null; state?: string | null; location?: string | null }): number {
  const me = String(personPlace ?? "").toLowerCase();
  if (!me) return 0;
  const raw = String(job.location ?? "").toLowerCase();
  const city = String(job.city ?? raw.split(",")[0] ?? "").toLowerCase().replace(/\b(office|hq|headquarters|campus)\b/g, "").trim();
  if (city && city.length > 2 && me.includes(city)) return 2;
  if (BAY_AREA.test(city || raw) && BAY_AREA.test(me)) return 2;
  let state = String(job.state ?? "").toLowerCase().trim();
  if (!state) { const m = /,\s*([a-z]{2})\b/.exec(raw); state = m ? m[1] : ""; }
  state = STATES[state] ?? state;
  return state && state.length > 2 && me.includes(state) ? 1 : 0;
}

/**
 * People from one search, kept only when they really fit the kind (a recruiter's title says recruiting, and so on),
 * nearest to the job first.
 */
/** Two lines of work close enough to be one team; "other" (a CTO, a founder) fits any. */
const sameLine = (a: Fn, b: Fn): boolean =>
  a === b || a === "other" || b === "other" || (["engineering", "data"].includes(a) && ["engineering", "data"].includes(b)) || (["product", "design"].includes(a) && ["product", "design"].includes(b));

export function pick(kind: Kind, raw: RawPerson[], companyId: number, want: number, schools: string[], taken: Set<string>, job: { city?: string | null; state?: string | null; location?: string | null; title?: string; category?: string | null } = {}): Person[] {
  const jobFn = job.title ? functionOf({ title: job.title, category: job.category ?? null }) : null;
  const out: Person[] = [];
  const ranked = raw
    .filter(p => p && typeof p === "object")
    .map((p, i) => ({ p, i, near: nearness(typeof p.basic_profile?.location?.full_location === "string" ? p.basic_profile.location.full_location : null, job) }))
    .sort((a, b) => b.near - a.near || a.i - b.i)
    .map(x => x.p);
  for (const p of ranked) {
    if (out.length >= want) break;
    const name = typeof p?.basic_profile?.name === "string" ? p.basic_profile.name.trim() : "";
    const role = roleAt(p, companyId);
    if (!name || !role) continue;
    // Recruiters from a recruiting agency the company uses ("Technical Recruiter / Consultant via ...") still recruit for it.
    if (NOT_STAFF.test(role.title) && !(kind === "recruiter" && isRecruiting(role.title))) continue;
    if (kind === "recruiter" && !isRecruiting(role.title)) continue;
    // "Technical Recruiting Manager" manages recruiters, not the team that is hiring.
    if (kind === "manager" && (!MANAGING.test(role.title) || isRecruiting(role.title))) continue;
    // An "Account Manager" is not the hiring manager for an engineering job, nor an SDR on its team.
    if ((kind === "manager" || kind === "team") && jobFn && !sameLine(functionOf({ title: role.title, category: null }), jobFn)) continue;
    if (kind === "team" && (isRecruiting(role.title) || /\bintern\b/i.test(role.title))) continue;
    const rawUrl = p.social_handles?.professional_network_identifier?.profile_url;
    const url = typeof rawUrl === "string" && /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
    const key = profileKey(url) ?? `id:${p.crustdata_person_id ?? name}`;
    if (taken.has(key)) continue;
    let school: string | null = null;
    let schoolYear: number | null = null;
    if (kind === "alumni") {
      // Whole words, accents and punctuation folded: "MIT" never matches "Smith College"; "Ecole" matches "École".
      const folded = schools.map(fold);
      const hit = list<{ school?: string | null; end_year?: number | null }>(p.education?.schools).find(s => typeof s.school === "string" && folded.some(f => f && ` ${fold(s.school!)} `.includes(` ${f} `)));
      if (!hit) continue;
      school = String(hit.school);
      schoolYear = typeof hit.end_year === "number" ? hit.end_year : null;
    }
    taken.add(key);
    out.push({
      kind, name, title: role.title,
      location: typeof p.basic_profile?.location?.full_location === "string" ? p.basic_profile.location.full_location : null,
      profileUrl: url, since: role.since, school, schoolYear, email: null,
    });
  }
  return out;
}

export const KIND_LABEL: Record<Kind, string> = { recruiter: "Recruiter", manager: "Hiring manager (likely)", team: "On the team", alumni: "Alumni from your school" };
