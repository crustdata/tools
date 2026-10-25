/**
 * The brief: raw Crustdata answers in, one structured brief out. Pure: no network, no files, no clock (the time is
 * passed in), so every rule here is tested and easy to change. `render.ts` turns a Brief into markdown.
 *
 * "What changed lately" is computed from role dates, not guessed: see `changes()` for the rules.
 */

import type { PersonData, Post, Role, WebResult } from "./crustdata.js";

export type Change = {
  kind: "new_company" | "new_title" | "added_role" | "left";
  /** The month it happened, "2026-08". */
  month: string;
  text: string;
};

export type RoleLine = {
  title: string;
  dates: string;
  current: boolean;
  details: string[];       // employment type, seniority, place
  description?: string;
};

export type CompanyBlock = { company: string; domain?: string; current: boolean; span: string; roles: RoleLine[] };

export type PostLine = { date: string; text: string; reactions: number; comments: number; shares: number; url?: string };

export type Link = { title: string; url: string; snippet?: string };

export type Brief = {
  input: string;
  matchedBy: string;
  /** Below 1 when an email was matched by the name in the address at the company, not an address on file. */
  matchScore?: number;
  /** Why the reader should check this is the right person (a pick among namesakes, a guessed email match). */
  check?: string;
  /** The news window, in days. */
  newsDays?: number;
  person: {
    id?: number;
    name: string;
    title?: string;
    department?: string;
    company?: string;
    headline?: string;
    about?: string;
    openTo?: string[];
    location?: string;
    experience?: string;
    profileUrl?: string;
    xUrl?: string;
    devUrl?: string;
    followers?: number;
    connections?: number;
    languages?: string[];
    refreshed?: string;      // "2026-10-23"
  };
  changes: Change[];
  /** Said when nothing changed, so the section is never empty. */
  quiet?: string;
  company?: { name: string; domain?: string; headcount?: string; industry?: string; about?: string; status?: string };
  career: CompanyBlock[];
  education: Array<{ school: string; detail: string }>;
  posts?: { shown: PostLine[]; total: number | null; newest?: string; note?: string };
  news?: Link[];
  web?: Link[];
  skills: string[];
  certifications: string[];
  honors: string[];
  contact?: { business: string[]; personal: string[]; phones: string[] };
  notes: string[];
};

// ---------------------------------------------------------------------------
// Dates. Crustdata role dates are ISO timestamps at month precision.
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2024-01-01T00:00:00+00:00" to { y: 2024, m: 1 }; anything else to null. */
export function ym(date: string | null | undefined): { y: number; m: number } | null {
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})/.exec(date) : null;
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  return y > 1900 && mo >= 1 && mo <= 12 ? { y, m: mo } : null;
}

const monthIndex = (d: { y: number; m: number }) => d.y * 12 + (d.m - 1);
export const monthLabel = (date: string | null | undefined): string => {
  const d = ym(date);
  return d ? `${MONTHS[d.m - 1]} ${d.y}` : "";
};
const monthKey = (d: { y: number; m: number }) => `${d.y}-${String(d.m).padStart(2, "0")}`;

/** "Jan 2022 to Feb 2024", "Jan 2024 to now", "to Feb 2024", "" */
export function dateRange(start: string | null | undefined, end: string | null | undefined, current: boolean): string {
  const a = monthLabel(start), b = current ? "now" : monthLabel(end);
  if (a && b) return `${a} to ${b}`;
  if (a) return current ? `${a} to now` : `from ${a}`;
  return b ? `to ${b}` : "";
}

/** Whole months between two dates, both counted (Jan to Mar is 3). */
function months(start: string | null | undefined, end: string | null | undefined, now: Date): number | null {
  const a = ym(start);
  if (!a) return null;
  const b = ym(end) ?? { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 };
  const n = monthIndex(b) - monthIndex(a) + 1;
  return n > 0 ? n : null;
}

/** 27 months to "2 yrs 3 mos". */
export function duration(n: number | null): string {
  if (!n) return "";
  const y = Math.floor(n / 12), m = n % 12;
  return [y ? `${y} yr${y > 1 ? "s" : ""}` : "", m ? `${m} mo${m > 1 ? "s" : ""}` : ""].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const clean = (s: unknown): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
/** A list from the API, or an empty one when the field is missing or the wrong shape. */
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

/**
 * The name as people search for it: without brackets, credentials after a comma, emoji or suffixes.
 * "Jane Doe, PhD (She/Her) 🚀" is "Jane Doe"; "John Smith Jr." is "John Smith".
 */
export const displayName = (s: unknown): string =>
  clean(s).replace(/[\u2018\u2019\u02BC]/g, "'").replace(/\s*[([{].*?[)\]}]/g, "").replace(/,.*$/, "")
    .replace(/[^\p{L}\p{M}\s'.-]/gu, "")
    .replace(/(\s+(jr|sr|ii|iii|iv|phd|ph\.d\.|mba|md|cpa|cfa|pmp|esq)\.?)+$/i, "").replace(/\s+/g, " ").trim();

/** The last name used to check that a web result is about this person (null when too short to tell). */
export const lastNameOf = (s: unknown): string | undefined => {
  const words = displayName(s).split(" ").filter(w => w.replace(/\./g, "").length > 1);
  return words.length > 1 ? words.at(-1) : undefined;
};

/** The same employer across roles: Crustdata's company id when there is one, otherwise the name. */
export const companyKey = (r: Role): string =>
  r.crustdata_company_id != null && String(r.crustdata_company_id) !== "" ? `id:${r.crustdata_company_id}` : `name:${clean(r.name).toLowerCase()}`;

const roleLocation = (r: Role): string => clean(typeof r.location === "string" ? r.location : r.location?.raw);

/** Current and past roles, without exact repeats (same position id, or same company, title and dates). */
export function roles(p: PersonData): { current: Role[]; past: Role[] } {
  const seen = new Set<string>();
  // Profiles sometimes list one role twice under two position ids, so both the id and the content count as a repeat.
  const keep = (r: Role) => {
    const keys = [`${companyKey(r)}|${clean(r.title).toLowerCase()}|${(r.start_date ?? "").slice(0, 7)}|${(r.end_date ?? "").slice(0, 7)}`];
    if (r.position_id != null && r.position_id !== "") keys.push(`p:${r.position_id}`);
    if (keys.some(k => seen.has(k))) return false;
    keys.forEach(k => seen.add(k));
    return true;
  };
  const details = p.experience?.employment_details;
  const all = [...(Array.isArray(details?.current) ? details!.current! : []), ...(Array.isArray(details?.past) ? details!.past! : [])].filter(r => r && typeof r === "object");
  // A role with no company id borrows it from another role at the same employer name, so a promotion where only one
  // role carries the id is still read as one company.
  const idByName = new Map<string, Role["crustdata_company_id"]>();
  for (const r of all) if (r.crustdata_company_id != null && String(r.crustdata_company_id) !== "" && clean(r.name)) idByName.set(clean(r.name).toLowerCase(), r.crustdata_company_id);
  const fill = (r: Role): Role => (r.crustdata_company_id == null || String(r.crustdata_company_id) === "") && idByName.has(clean(r.name).toLowerCase()) ? { ...r, crustdata_company_id: idByName.get(clean(r.name).toLowerCase()) } : r;
  const list = (x: Role[] | null | undefined) => (Array.isArray(x) ? x : []).filter(r => r && typeof r === "object" && (r.name || r.title)).map(fill).filter(keep);
  const current = list(details?.current);
  const past = list(details?.past);
  return { current, past };
}

/** The main current role: the one marked default, else the most recently started. */
export function mainRole(current: Role[]): Role | undefined {
  return current.find(r => r.is_default === true || String(r.is_default) === "true")
    ?? [...current].sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? ""))[0];
}

/** In the window: from the month `days` before now up to this month (a start date in the future is not a change). */
const within = (date: string | null | undefined, since: number, until: number) => { const d = ym(date); return d ? monthIndex(d) >= since && monthIndex(d) <= until : false; };

/**
 * What changed in the last `days` days, newest first. The rules, at month precision:
 *  - new title:   a current role started in the window at a company where an earlier role (past, or another current
 *                 one) started before it. "New title at Acme: VP Sales (was Director of Sales), since Aug 2026."
 *  - added role:  a current role started in the window at a new company while an older current role continues
 *                 elsewhere (advisor, board seat, side project).
 *  - new company: a current role started in the window at a company they had no earlier role at, with no older
 *                 current role. Names the previous role when there is one.
 *  - left:        a past role that ended in the window, at a company with no current role, when it is not already
 *                 named as the "previous role" of a new company.
 * Roles with no start date are never called new.
 */
export function changes(p: PersonData, now: Date, days: number): Change[] {
  const { current, past } = roles(p);
  const from = new Date(now.getTime() - Math.max(1, days) * 86_400_000);
  const since = monthIndex({ y: from.getUTCFullYear(), m: from.getUTCMonth() + 1 });
  const until = monthIndex({ y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 });
  const out: Change[] = [];
  const mentioned = new Set<Role>();
  const all = [...current, ...past];
  const company = (r: Role) => clean(r.name) || "a company";
  const title = (r: Role) => clean(r.title) || "a role";

  const recent = current.filter(r => within(r.start_date, since, until)).sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? ""));
  for (const r of recent) {
    const month = monthKey(ym(r.start_date)!);
    const startIdx = monthIndex(ym(r.start_date)!);
    const sameCompany = all
      .filter(x => x !== r && companyKey(x) === companyKey(r) && ym(x.start_date) && monthIndex(ym(x.start_date)!) < startIdx)
      .sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? ""));
    // A role at the same company that is still current (dated earlier, or undated): a second role there.
    const stillHere = sameCompany.find(x => current.includes(x))
      ?? current.find(x => x !== r && companyKey(x) === companyKey(r) && !ym(x.start_date));
    if (stillHere) {
      out.push({ kind: "added_role", month, text: `Also ${title(r)} at ${company(r)}, since ${monthLabel(r.start_date)} (still ${title(stillHere)}).` });
      continue;
    }
    // An earlier role there that ran up to the new one (within two months): a new title.
    // A past role with no end date only counts when no job elsewhere started after it (otherwise it is a return).
    const elsewhereAfter = (x: Role) => all.some(y => companyKey(y) !== companyKey(r) && ym(y.start_date) && monthIndex(ym(y.start_date)!) > monthIndex(ym(x.start_date)!) && monthIndex(ym(y.start_date)!) < startIdx);
    const earlierHere = sameCompany.find(x => ym(x.end_date) ? monthIndex(ym(x.end_date)!) >= startIdx - 2 : !elsewhereAfter(x));
    if (earlierHere) {
      mentioned.add(earlierHere);
      const was = clean(earlierHere.title) && clean(earlierHere.title).toLowerCase() !== title(r).toLowerCase() ? ` (was ${clean(earlierHere.title)})` : "";
      out.push({ kind: "new_title", month, text: `New title at ${company(r)}: ${title(r)}${was}, since ${monthLabel(r.start_date)}.` });
      continue;
    }
    const rejoined = sameCompany.length > 0;
    const main = mainRole(current);
    // A new main job right after leaving another (within two months) is a move, even with an older side role kept.
    const justLeft = past.some(x => companyKey(x) !== companyKey(r) && ym(x.end_date) && Math.abs(monthIndex(ym(x.end_date)!) - startIdx) <= 2);
    const olderCurrent = main === r && justLeft ? undefined : current.find(x => x !== r && companyKey(x) !== companyKey(r) && (!ym(x.start_date) || monthIndex(ym(x.start_date)!) < startIdx))
      ?? (main && main !== r && companyKey(main) !== companyKey(r) && ym(main.start_date) && monthIndex(ym(main.start_date)!) === startIdx ? main : undefined);
    if (olderCurrent) {
      out.push({ kind: "added_role", month, text: `Added a role: ${title(r)} at ${company(r)}, since ${monthLabel(r.start_date)} (still ${title(olderCurrent)} at ${company(olderCurrent)}).` });
      continue;
    }
    const previous = past
      .filter(x => companyKey(x) !== companyKey(r) && ym(x.end_date))
      .sort((a, b) => (b.end_date ?? "").localeCompare(a.end_date ?? ""))[0];
    if (previous) mentioned.add(previous);
    const before = previous ? ` Before: ${title(previous)} at ${company(previous)}${monthLabel(previous.end_date) ? ` until ${monthLabel(previous.end_date)}` : ""}.` : "";
    out.push({ kind: "new_company", month, text: `${rejoined ? "Rejoined" : "Joined"} ${company(r)} as ${title(r)} in ${monthLabel(r.start_date)}.${before}` });
  }

  const currentCompanies = new Set(current.map(companyKey));
  const mentionedCompanies = new Set([...mentioned].map(companyKey));
  const leftCompanies = new Set<string>();
  const ended = past.filter(x => within(x.end_date, since, until) && !mentionedCompanies.has(companyKey(x)) && !currentCompanies.has(companyKey(x)))
    .sort((a, b) => (b.end_date ?? "").localeCompare(a.end_date ?? ""));
  for (const r of ended) {
    // One line per company: the latest role there.
    if (leftCompanies.has(companyKey(r))) continue;
    leftCompanies.add(companyKey(r));
    const none = current.length ? "" : " No current role listed.";
    out.push({ kind: "left", month: monthKey(ym(r.end_date)!), text: `Left ${company(r)} (${title(r)}) in ${monthLabel(r.end_date)}.${none}` });
  }
  return out.sort((a, b) => b.month.localeCompare(a.month));
}

/** Current companies first (main role first), then past companies by their latest end date. */
export function career(p: PersonData, now: Date): CompanyBlock[] {
  const { current, past } = roles(p);
  const main = mainRole(current);
  const groups = new Map<string, { roles: Role[]; current: boolean }>();
  for (const r of [...current, ...past]) {
    const k = companyKey(r);
    const g = groups.get(k) ?? { roles: [], current: false };
    g.roles.push(r);
    if (current.includes(r)) g.current = true;
    groups.set(k, g);
  }
  const latest = (g: { roles: Role[]; current: boolean }) => (g.current ? "9999" : g.roles.map(r => r.end_date ?? r.start_date ?? "").sort().at(-1) ?? "");
  const order = [...groups.entries()].sort(([ka, a], [kb, b]) => {
    if (main && ka === companyKey(main)) return -1;
    if (main && kb === companyKey(main)) return 1;
    return latest(b).localeCompare(latest(a));
  });
  return order.map(([, g]) => {
    const sorted = [...g.roles].sort((a, b) => {
      const ca = current.includes(a) ? 1 : 0, cb = current.includes(b) ? 1 : 0;
      return cb - ca || (b.start_date ?? "").localeCompare(a.start_date ?? "");
    });
    const first = sorted.map(r => r.start_date).filter(Boolean).sort()[0];
    const last = g.current ? null : sorted.map(r => r.end_date).filter(Boolean).sort().at(-1);
    const span = duration(months(first, last, now));
    const head = sorted[0];
    return {
      company: clean(head.name) || "Company not listed",
      domain: clean(sorted.find(r => r.company_website_domain)?.company_website_domain) || undefined,
      current: g.current,
      span,
      roles: sorted.map(r => {
        const isCurrent = current.includes(r);
        // Seniority stays in the JSON only: Crustdata's level for older roles can be off ("Entry Level" for a founder's
        // earlier job), and it reads as a judgement in a brief.
        const details = [clean(r.employment_type), roleLocation(r)].filter(Boolean);
        const len = duration(months(r.start_date, isCurrent ? null : r.end_date, now));
        return {
          title: clean(r.title) || "Role not named",
          dates: [dateRange(r.start_date, r.end_date, isCurrent), len].filter(Boolean).join(" · "),
          current: isCurrent,
          details,
          // Descriptions only on current roles: the past list is for scanning, the JSON keeps everything.
          ...(isCurrent && clean(r.description) ? { description: clip(clean(r.description), 220) } : {}),
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Cuts at a word boundary and adds "...". Joined sentences ("people.Crustdata") get their space back. */
export function clip(text: string, max: number): string {
  const s = text.replace(/([a-z])\.([A-Z])/g, "$1. $2").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.4 ? cut.slice(0, at) : s.slice(0, max)).replace(/[\s,;:.]+$/, "")}...`;
}

/** The first sentence or two, up to `max` characters. */
export function firstSentences(text: string, max: number): string {
  const s = text.replace(/([a-z])\.([A-Z])/g, "$1. $2").replace(/\s+/g, " ").trim();
  const sentences = s.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [s];
  let out = "";
  for (const x of sentences) {
    if ((out + x).length > max) break;
    out += x;
  }
  return out.trim() || clip(s, max);
}

const host = (url: string): string => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

/**
 * Web results worth showing: not the person's own profile site, not a contact-lookup site from the ignore list, no
 * repeats, at most `max`.
 */
export function pickLinks(results: WebResult[], ignore: string[], profileUrl: string | undefined, max: number, lastName?: string): Link[] {
  const fold = (t: string) => t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['\u2018\u2019\u02BC]/g, "").replace(/[-_.]+/g, " ");
  const surname = lastName ? fold(lastName) : "";
  const profileHost = profileUrl ? host(profileUrl) : "";
  const seen = new Set<string>();
  const out: Link[] = [];
  for (const r of results) {
    const url = clean(r.url);
    if (!/^https?:\/\//i.test(url)) continue;
    const h = host(url);
    const full = `${h}${(() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ""; } })()}`;
    if (profileHost && h === profileHost) continue;
    if (ignore.some(d => h === d || h.endsWith(`.${d}`) || full.startsWith(d))) continue;
    // A result that does not mention their last name is likely about someone else with the same first name.
    if (surname && !fold(`${r.title ?? ""} ${r.snippet ?? ""} ${url}`).includes(surname)) continue;
    const key = url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: clip(clean(r.title) || h, 120), url, ...(clean(r.snippet) ? { snippet: clip(clean(r.snippet), 200) } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

/** Line breaks in a post become sentence breaks, so "Here is ours\n\nWe launched" reads "Here is ours. We launched". */
export const paragraphs = (text: string | null | undefined): string =>
  (text ?? "").replace(/([^\s.!?:;,])[ \t]*\n+\s*/g, "$1. ").replace(/\s*\n+\s*/g, " ");

export function postLines(posts: Post[]): PostLine[] {
  return posts.filter(p => p && (p.text || p.share_url)).map(p => {
    const e = p.engagement ?? {};
    const byType = Object.values(e.reactions_by_type ?? {}).reduce((s, n) => s + (Number(n) || 0), 0);
    return {
      date: monthDay(p.date_posted),
      text: clip(clean(paragraphs(p.text)) || "(no text)", 200),
      reactions: Number(e.total_reactions) || byType,
      comments: Number(e.total_comments) || 0,
      shares: Number(e.num_shares) || 0,
      ...(clean(p.share_url) ? { url: clean(p.share_url) } : {}),
    };
  });
}

/** "2026-08-04T20:26:35Z" to "4 Aug 2026". */
export function monthDay(date: string | null | undefined): string {
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null;
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
}

/** The search phrase for web and news: the quoted name plus the current company, without "(YC F24)"-style tags. */
export function searchPhrase(p: PersonData): string {
  const name = displayName(p.basic_profile?.name);
  const { current, past } = roles(p);
  const role = mainRole(current) ?? [...past].sort((a, b) => (b.end_date ?? "").localeCompare(a.end_date ?? ""))[0];
  const company = clean(role?.name).replace(/\s*[([].*?[)\]]\s*/g, " ").trim();
  return [name ? `"${name}"` : "", company].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

export type BriefInput = {
  input: string;
  matchedBy: string;
  matchScore?: number;
  check?: string;
  newsDays?: number;
  person: PersonData;
  now: Date;
  days: number;
  posts?: { items: Post[]; total: number | null };
  news?: WebResult[];
  web?: WebResult[];
  ignoreSites?: string[];
  maxLinks?: number;
};

export function buildBrief(x: BriefInput): Brief {
  const p = x.person;
  const bp = p.basic_profile ?? {};
  const { current } = roles(p);
  const main = mainRole(current);
  const profileUrl = clean(p.social_handles?.professional_network_identifier?.profile_url) || undefined;
  const xSlug = clean(p.social_handles?.twitter_identifier?.slug).replace(/^@/, "");
  const loc = bp.location;
  const changeList = changes(p, x.now, x.days);
  const refreshed = typeof p.updated_at === "string" ? p.updated_at.slice(0, 10) : undefined;
  const window = x.days % 30 === 0 && x.days >= 60 ? `${x.days / 30} months` : `${x.days} days`;

  const posts = x.posts ? (() => {
    const shown = postLines(x.posts.items);
    const newestIso = x.posts.items.map(p => p.date_posted ?? "").filter(Boolean).sort().at(-1);
    const ageDays = newestIso ? (x.now.getTime() - Date.parse(newestIso)) / 86_400_000 : null;
    const note = !shown.length
      ? (x.posts.total ? undefined : "No posts by them in Crustdata's post index.")
      : ageDays !== null && ageDays > 30 ? `Newest indexed post: ${monthDay(newestIso)}. Posts reach the index with a delay, so newer ones may exist.` : undefined;
    return { shown, total: x.posts.total, ...(newestIso ? { newest: monthDay(newestIso) } : {}), ...(note ? { note } : {}) };
  })() : undefined;

  // Email statuses are deliverable, catch_all, invalid or unknown; only "deliverable" goes unsaid.
  const withStatus = (list: unknown) => arr<{ email?: string; status?: string }>(list)
    .map(e => [e?.email, e?.status && e.status !== "deliverable" ? `(${String(e.status).replace(/_/g, " ")})` : ""].filter(Boolean).join(" ")).filter(Boolean);
  const contact = p.contact ? {
    business: withStatus(p.contact.business_emails),
    personal: withStatus(p.contact.personal_emails),
    phones: arr<unknown>(p.contact.phone_numbers).map(x => (typeof x === "string" ? x : typeof (x as { number?: unknown })?.number === "string" ? (x as { number: string }).number : "")).filter(Boolean),
  } : undefined;
  const titleText = clean(bp.current_title) || clean(main?.title);
  const headline = clean(bp.headline);
  // A headline that only repeats "Title at Company" adds nothing.
  const norm = (t: string) => t.toLowerCase().replace(/\s*(\bat\b|@|,|\||-|·)\s*/g, " ").replace(/\s+/g, " ").trim();
  const repeats = !!headline && !!titleText && norm(headline) === norm(`${titleText} ${clean(main?.name)}`);
  const lastName = lastNameOf(bp.name);
  // open_to_cards holds what the profile says they are open to (new roles, hiring, offering services).
  const OPEN_TO: Record<string, string> = { CAREER_INTEREST: "new roles", HIRING: "hiring", PROVIDER: "offering services", SERVICES: "offering services", FINDING_A_NEW_JOB: "new roles" };
  const openTo = [...new Set(arr<unknown>((p.professional_network as { open_to_cards?: unknown } | null | undefined)?.open_to_cards)
    .map(c => (typeof c === "string" ? c : typeof (c as { type?: unknown })?.type === "string" ? (c as { type: string }).type : ""))
    .filter(Boolean).map(c => OPEN_TO[c.toUpperCase()] ?? c.toLowerCase().replace(/_/g, " ")))];

  return {
    input: x.input,
    matchedBy: x.matchedBy,
    ...(typeof x.matchScore === "number" && x.matchScore < 1 ? { matchScore: x.matchScore } : {}),
    ...(x.check ? { check: x.check } : typeof x.matchScore === "number" && x.matchScore < 1 ? { check: `the email was matched by the name in the address at the company, not an address on file (match score ${x.matchScore})` } : {}),
    ...(x.news ? { newsDays: x.newsDays ?? 90 } : {}),
    person: {
      ...(p.crustdata_person_id ? { id: Number(p.crustdata_person_id) } : {}),
      name: clean(bp.name) || "Name not listed",
      ...(titleText ? { title: titleText } : {}),
      ...(bp.normalized_title?.confident !== false && clean(bp.normalized_title?.department) ? { department: clean(bp.normalized_title?.department) } : {}),
      ...(clean(main?.name) ? { company: clean(main?.name) } : {}),
      ...(headline && !repeats ? { headline: clip(headline, 200) } : {}),
      ...(clean(bp.summary) ? { about: firstSentences(clean(bp.summary), 300) } : {}),
      ...(openTo.length ? { openTo } : {}),
      ...(clean(loc?.raw) || [loc?.city, loc?.state, loc?.country].filter(Boolean).length ? { location: clean(loc?.raw) || [loc?.city, loc?.state, loc?.country].filter(Boolean).join(", ") } : {}),
      ...(clean(p.experience?.years_of_experience) ? { experience: clean(p.experience?.years_of_experience) } : {}),
      ...(profileUrl ? { profileUrl } : {}),
      ...(xSlug ? { xUrl: `https://x.com/${encodeURIComponent(xSlug)}` } : {}),
      ...(clean(p.social_handles?.dev_platform_identifier?.profile_url) ? { devUrl: clean(p.social_handles?.dev_platform_identifier?.profile_url) } : {}),
      ...(Number(p.professional_network?.followers) ? { followers: Number(p.professional_network?.followers) } : {}),
      ...(Number(p.professional_network?.connections) ? { connections: Number(p.professional_network?.connections) } : {}),
      ...(arr<string>(bp.languages).filter(l => typeof l === "string" && l).length ? { languages: arr<string>(bp.languages).filter(l => typeof l === "string" && l) } : {}),
      ...(refreshed ? { refreshed } : {}),
    },
    changes: changeList,
    ...(changeList.length ? {} : {
      quiet: roles(p).current.length + roles(p).past.length === 0
        ? "No roles on this profile (or this key cannot read them), so changes cannot be shown."
        : `No role change in the last ${window}.${refreshed ? ` Profile refreshed on ${refreshed}.` : ""}`,
    }),
    ...(main && clean(main.name) ? {
      company: {
        name: clean(main.name),
        ...(clean(main.company_website_domain) ? { domain: clean(main.company_website_domain) } : {}),
        ...(main.company_headcount_latest || main.company_headcount_range ? { headcount: [main.company_headcount_latest ? `${Number(main.company_headcount_latest).toLocaleString("en-US")} people` : "", main.company_headcount_range ? `(${main.company_headcount_range} band)` : ""].filter(Boolean).join(" ") } : {}),
        ...(clean(main.company_professional_network_industry) || main.company_industries?.[0] ? { industry: clean(main.company_professional_network_industry) || clean(main.company_industries?.[0]) } : {}),
        ...(clean(main.company_description) ? { about: firstSentences(clean(main.company_description), 280) } : {}),
        ...(clean(main.company_status) && clean(main.company_status) !== "active" ? { status: clean(main.company_status) } : {}),
      },
    } : {}),
    career: career(p, x.now),
    // Newest first, like the career; schools with no years keep their order after the dated ones.
    education: arr<NonNullable<NonNullable<PersonData["education"]>["schools"]>[number]>(p.education?.schools).filter(s => clean(s?.school))
      .map((s, i) => ({ s, i, y: Number(s.end_year ?? s.start_year) || 0 })).sort((a, b) => (b.y - a.y) || (a.i - b.i)).map(x => x.s).map(s => ({
      school: clean(s.school),
      detail: [[clean(s.degree), clean(s.field_of_study)].filter(Boolean).join(", "), s.start_year || s.end_year ? [s.start_year, s.end_year].filter(Boolean).join(" to ") : ""].filter(Boolean).join(" · "),
    })),
    ...(posts ? { posts } : {}),
    ...(x.news ? { news: pickLinks(x.news, x.ignoreSites ?? [], profileUrl, x.maxLinks ?? 5, lastName) } : {}),
    ...(x.web ? { web: pickLinks(x.web, x.ignoreSites ?? [], profileUrl, x.maxLinks ?? 5, lastName) } : {}),
    skills: arr<string>(p.skills?.professional_network_skills).filter(s => typeof s === "string" && s.trim()).slice(0, 25),
    certifications: arr<{ name?: string; issuing_organization?: string }>(p.certifications).map(c => [clean(c?.name), clean(c?.issuing_organization)].filter(Boolean).join(", ")).filter(Boolean),
    honors: arr<{ title?: string; issuer?: string }>(p.honors).map(h => [clean(h?.title), clean(h?.issuer)].filter(Boolean).join(", ")).filter(Boolean),
    ...(contact ? { contact } : {}),
    notes: [],
  };
}
