/** Reading a Crustdata person record: the facts the score, the team guess and the report use. Pure. */

import type { Person, ResearchProfile, Role } from "./crustdata.js";

export const nameOf = (p: Person): string => p.basic_profile?.name?.trim() || `Person ${p.crustdata_person_id}`;
export const profileUrlOf = (p: Person): string => p.social_handles?.professional_network_identifier?.profile_url ?? "";
export const currentRoles = (p: Person): Role[] => p.experience?.employment_details?.current ?? [];
export const pastRoles = (p: Person): Role[] => p.experience?.employment_details?.past ?? [];
export const locationOf = (p: Person): string => p.basic_profile?.location?.full_location ?? p.basic_profile?.location?.raw ?? "";
export const skillsOf = (p: Person): string[] => p.skills?.professional_network_skills ?? [];
export const schoolsOf = (p: Person): string[] => (p.education?.schools ?? []).map(s => s.school ?? "").filter(Boolean);

/** The person's main research profile (Crustdata lists the best match first), if they have one. */
export const researchOf = (p: Person): ResearchProfile | undefined => (p.research_profiles ?? [])[0];

/** The current role at one of these labs (by company id), else the main current role. */
export function roleAt(p: Person, labIds: Set<number>): Role | undefined {
  const roles = currentRoles(p);
  return roles.find(r => r.crustdata_company_id && labIds.has(r.crustdata_company_id)) ?? roles.find(r => r.is_default) ?? roles[0];
}

const year = (d?: string | null): number | undefined => {
  const y = Number(String(d ?? "").slice(0, 4));
  return y > 1950 && y < 2100 ? y : undefined;
};

/** "2021 to 2024", "2023 to now". */
export function span(r: Role): string {
  const a = year(r.start_date), b = year(r.end_date);
  if (!a && !b) return "";
  return `${a ?? "?"} to ${b ?? (r.end_date ? "?" : "now")}`;
}

/** Years worked, from the earliest role start to today (gaps included), floored. Undefined with no dates. */
export function yearsWorked(p: Person, now = new Date()): number | undefined {
  const starts = [...currentRoles(p), ...pastRoles(p)].map(r => Date.parse(r.start_date ?? "")).filter(Number.isFinite);
  if (!starts.length) return undefined;
  return Math.max(0, Math.floor((now.getTime() - Math.min(...starts)) / (365.25 * 86_400_000)));
}

export type Paper = { title: string; year?: number; url?: string };

/** Papers on the main research profile, newest first. Titles repeated across versions are kept once. */
export function papersOf(p: Person): Paper[] {
  const seen = new Set<string>();
  const out: Paper[] = [];
  for (const a of researchOf(p)?.articles ?? []) {
    const title = (a.title ?? "").replace(/\s+/g, " ").trim();
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!title || seen.has(key)) continue;
    seen.add(key);
    const y = Number(a.publication_year);
    out.push({ title, year: y > 1950 && y < 2100 ? y : undefined, url: a.url ?? undefined });
  }
  return out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
}

/** Papers from the last `years` years (this year included). */
export const recentPapers = (p: Person, years: number, now = new Date()): Paper[] =>
  papersOf(p).filter(x => x.year !== undefined && x.year > now.getFullYear() - years);

export const hIndex = (p: Person): number | undefined => researchOf(p)?.h_index?.all ?? undefined;
export const citations = (p: Person): number | undefined => researchOf(p)?.citations_count?.all ?? undefined;
export const scholarUrl = (p: Person): string => researchOf(p)?.profile_url ?? "";
export const interestsOf = (p: Person): string[] => researchOf(p)?.research_interests ?? [];

/** Lowercase, accents off, punctuation to spaces: the form every phrase match runs on. */
export const norm = (s: string): string => ` ${s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9+#]+/g, " ").trim()} `;

/** Whether a phrase appears in a text as whole words ("rl" matches "code rl", not "world"). */
export const hasPhrase = (text: string, phrase: string): boolean => {
  const p = norm(phrase).trim();
  return !!p && norm(text).includes(` ${p} `);
};

/** The first phrase found in a text, if any. */
export const findPhrase = (text: string, phrases: string[]): string | undefined => phrases.find(ph => hasPhrase(text, ph));

/** A text clipped to `n` characters on a word boundary, one line. */
export function clip(s: string, n = 140): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n).replace(/\s+\S*$/, "")}...`;
}
