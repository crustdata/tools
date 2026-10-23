/**
 * Founders: who counts as a founder of a company, and what in their background earns points. Pure, no I/O.
 *
 * The person search matches a title on ANY current role, so a person who is "Head of Infrastructure" at a big company
 * and "Co-Founder" of a startup comes back for both. Everything here looks at the role held at the company in question.
 */

import type { Founder, RawPosition, RawProfile, Role } from "./types.js";

/** Titles searched for. [.] is an exact-phrase match, so "Founder" also finds "Co-Founder & CEO". */
export const FOUNDER_TITLES = ["Founder", "Co-Founder", "Cofounder", "CEO", "CTO", "Chief Executive Officer", "Chief Technology Officer"];

/** Founder roles kept per company. */
export const MAX_FOUNDERS = 3;

const FOUNDER_WORD = /\b(?:co[\s-]?founder|cofounder|founder|founding\s+(?:ceo|cto))\b/i;
const CEO = /\b(?:ceo|chief executive officer)\b/i;
const CTO = /\b(?:cto|chief technology officer|chief technical officer)\b/i;
/** Titles that contain "founder" but are not founders. */
const NOT_A_FOUNDER = new RegExp([
  String.raw`\bfounders?['’]?s?\s+(?:associate|office|program|programme|fellow|in residence|relations|success|programs|community|experience|mode|podcast)\b`,
  String.raw`\b(?:associate|assistant|chief of staff|advisor|adviser|ea|pa|coach)\s+to\s+(?:the\s+)?(?:co[\s-]?)?(?:founders?|ceo|cto)\b`,
  String.raw`\boffice of the\s+(?:ceo|cto|founders?)\b`,
  String.raw`\b(?:ceo|cto)\s+(?:office|coach|coaching|forum|council)\b`,
  String.raw`\bhead of founder`,
  String.raw`\b(?:founder|entrepreneur)\s+in\s+residence\b`,
  String.raw`\bintern(?:ship)?\b`,
  String.raw`\bassistant\b`,
  String.raw`\b(?:deputy|vice|associate|field)\s+(?:ceo|cto)\b`,
  String.raw`\bfounder\s+coach\b`,
].join("|"), "i");

/** True for a title that makes someone a founder or the CEO or CTO of the company. */
export function isFounderTitle(title: string): boolean {
  if (!title || NOT_A_FOUNDER.test(title)) return false;
  return FOUNDER_WORD.test(title) || CEO.test(title) || CTO.test(title);
}

/** Lower is kept first: founder and CEO, CEO, founder and CTO, founder, CTO. The CEO is never pushed out by co-founders. */
export function founderRank(title: string): number {
  const f = FOUNDER_WORD.test(title), c = CEO.test(title), t = CTO.test(title);
  return f && c ? 0 : c ? 1 : f && t ? 2 : f ? 3 : 4;
}

const isPlaceholderName = (name?: string) => !name || /^[a-z]+ member$/i.test(name);
const date = (s?: string | null) => (s ? s.slice(0, 10) : undefined);

/** "https://www.ledgerpine.example/?utm=x" -> "ledgerpine.example". */
export function domainOf(url?: string | null): string | undefined {
  if (!url) return undefined;
  const host = url.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "").replace(/:\d+$/, "");
  return host.includes(".") ? host : undefined;
}

/** Long titles ("Senior Director - Chief Product Owner, Software Defined Vehicle, ...") are cut at 90 characters. */
const clipTitle = (t: string) => (t.length > 90 ? t.slice(0, 87).replace(/[\s,;/|-]+\S*$/, "") + "..." : t);

const toRole = (p: RawPosition): Role => ({
  title: clipTitle((p.title ?? "").trim()),
  company: (p.name ?? "").trim(),
  companyId: p.crustdata_company_id,
  domain: domainOf(p.company_website),
  start: date(p.start_date),
  end: date(p.end_date),
  headcount: p.company_headcount_latest ?? undefined,
});

/**
 * A repeat founder: a past role titled founder, or CEO of a company of 500 people or fewer, at another company.
 * A founder role at a company named "Stealth" that ended within 6 months of the current role starting is usually this
 * same company before it launched, so it does not count.
 */
export function priorFounderRoles(past: Role[], companyId: number, since?: string): Role[] {
  // With no start date for the current role, a Stealth founder role cannot be told apart from this company: left out.
  const sameCompanyInStealth = (r: Role) => /\bstealth\b/i.test(r.company) && (!since || !r.end || monthsApart(r.end, since) <= 6);
  // Clubs, student groups, newsletters and freelancing are not companies a partner would count.
  // A company with 10 or more people on record is a company, whatever its name.
  const notACompany = (r: Role) => !(r.headcount !== undefined && r.headcount >= 10) && NOT_A_COMPANY.test(`${r.company} ${r.title}`);
  // A role of under a year (when both dates are known) is a side project, not a company founded.
  const tooShort = (r: Role) => !!r.start && !!r.end && monthsApart(r.start, r.end) < 12;
  // Starting a venture fund is not founding a startup.
  const fundPartner = (r: Role) => /\b(?:general|managing)\s+partner\b/i.test(r.title);
  return past.filter(r => r.companyId !== companyId && r.title && !NOT_A_FOUNDER.test(r.title) && !sameCompanyInStealth(r) && !notACompany(r) && !tooShort(r) && !fundPartner(r)
    && (FOUNDER_WORD.test(r.title) || (CEO.test(r.title) && (r.headcount === undefined || (r.headcount >= 2 && r.headcount <= 500)))));
}

const SIDE_ROLE = /\b(?:advisor|adviser|advisory|mentor|board|angel|investor|member|volunteer|ambassador|fellow|judge|speaker|limited partner|scout|stealth)\b/i;

/** Phrases, not single words, so "Dollar Shave Club" or "Lambda School" (real companies) still count. */
const NOT_A_COMPANY = /\b(?:student\s+\w+|\w+\s+club|club\s+at|society|association|chapter|university|college|tedx\w*|newsletter|podcast|self[\s-]?employed|freelanc\w*|independent\s+consult\w*|consultant|hackathon|meetup)\b/i;

/** Months between two YYYY-MM-DD dates, either order. */
function monthsApart(a: string, b: string): number {
  const m = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
  return Math.abs(m(a) - m(b));
}

/** Whole-word match that treats letters in any alphabet as part of a word ("rich" does not match "Zürich"). */
const wholeWord = (needle: string, hay: string) =>
  new RegExp(String.raw`(^|[^\p{L}\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\p{L}\p{N}]|$)`, "iu").test(hay);

/** Domain entries that are only a public suffix ("co.uk") would match thousands of companies. */
const BARE_SUFFIX = /^(?:com|org|net|io|ai|co|dev|app|xyz|(?:co|com|org|ac|gov|net)\.[a-z]{2})$/;

/**
 * An entry is a domain ("ledgerpine.example") or a company name ("Ledgerpine"). Names match whole words, any case. Internships do
 * not count as having worked somewhere.
 */
export function employerMatches(entry: string, role: Role): boolean {
  const e = entry.trim().toLowerCase();
  if (!e || BARE_SUFFIX.test(e) || /\bintern(?:ship)?\b/i.test(role.title)) return false;
  const asDomain = domainOf(e.includes("://") ? e : `https://${e}`);
  if (e.includes(".") && asDomain) return !!role.domain && (role.domain === asDomain || role.domain.endsWith("." + asDomain));
  return wholeWord(e, role.company.toLowerCase());
}

/** Short names people type for schools, expanded. Add your own here. */
export const SCHOOL_ALIASES: { [short: string]: string[] } = {
  mit: ["massachusetts institute of technology"],
  cmu: ["carnegie mellon"],
  caltech: ["california institute of technology"],
  berkeley: ["uc berkeley", "university of california, berkeley", "university of california berkeley"],
  ucla: ["university of california, los angeles", "university of california los angeles"],
  nyu: ["new york university"],
  usc: ["university of southern california"],
  upenn: ["university of pennsylvania"],
  wharton: ["wharton"],
  iit: ["indian institute of technology"],
  lse: ["london school of economics"],
  eth: ["eth zurich", "eth zürich", "swiss federal institute of technology"],
  epfl: ["école polytechnique fédérale de lausanne", "ecole polytechnique federale de lausanne"],
};

export function schoolMatches(entry: string, school: string): boolean {
  const s = school.toLowerCase();
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  return wholeWord(e, s) || (SCHOOL_ALIASES[e] ?? []).some(a => wholeWord(a, s));
}

/**
 * The founders of one company from a batch of person search results: people whose role AT THIS COMPANY has a founder,
 * CEO or CTO title. Up to MAX_FOUNDERS, founders first.
 */
export function pickFounders(profiles: RawProfile[], companyId: number, foundersFrom: string[] = [], schools: string[] = []): Founder[] {
  const out: Array<Founder & { rank: number }> = [];
  for (const p of profiles) {
    const name = p.basic_profile?.name;
    const url = p.social_handles?.professional_network_identifier?.profile_url?.toLowerCase().replace(/\/+$/, "");
    // The same person can come back under two ids: same profile URL, or same name at the same company.
    if (isPlaceholderName(name) || out.some(f => f.personId === p.crustdata_person_id || (url && f.profileUrl?.toLowerCase().replace(/\/+$/, "") === url) || f.name.toLowerCase() === name!.toLowerCase())) continue;
    const current = p.experience?.employment_details?.current ?? [];
    const here = current.filter(j => j.crustdata_company_id === companyId && isFounderTitle(j.title ?? ""))
      .sort((a, b) => founderRank(a.title ?? "") - founderRank(b.title ?? ""))[0];
    if (!here) continue;
    const past = (p.experience?.employment_details?.past ?? []).map(toRole);
    out.push({
      personId: p.crustdata_person_id,
      name: name!,
      title: (here.title ?? "").trim(),
      since: date(here.start_date),
      profileUrl: p.social_handles?.professional_network_identifier?.profile_url ?? undefined,
      headline: p.basic_profile?.headline,
      location: p.basic_profile?.location?.full_location,
      // Other current jobs. Advisory, board, angel and community roles are normal for founders and not shown as a second job.
      alsoNow: current.filter(j => j !== here && j.crustdata_company_id !== companyId && !SIDE_ROLE.test(`${j.title ?? ""} ${j.name ?? ""}`)).map(toRole),
      past,
      schools: (p.education?.schools ?? []).filter(s => s.school).map(s => ({ school: s.school!, degree: s.degree || undefined, field: s.field_of_study || undefined, endYear: s.end_year ?? undefined })),
      priorFounder: [],
      fromList: [],
      schoolHits: [],
      rank: founderRank(here.title ?? ""),
    });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, MAX_FOUNDERS).map(({ rank, ...f }) => annotate(f, companyId, foundersFrom, schools));
}

/** Fills in the background checks. Called again when only --founders-from or --schools changed (no new search). */
export function annotate(f: Founder, companyId: number, foundersFrom: string[] = [], schools: string[] = []): Founder {
  const fromList: Founder["fromList"] = [];
  for (const entry of foundersFrom) {
    const role = f.past.find(r => r.companyId !== companyId && employerMatches(entry, r));
    if (role) fromList.push({ entry, role });
  }
  return {
    ...f,
    priorFounder: priorFounderRoles(f.past, companyId, f.since),
    fromList,
    schoolHits: schools.filter(entry => f.schools.some(s => schoolMatches(entry, s.school))),
  };
}
