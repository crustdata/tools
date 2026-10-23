/**
 * Reading a person record. Pure functions, no I/O, so the odd cases (two current roles, no dates, a re-hire,
 * forty skills) are tested in test/score.test.ts.
 */

import type { Person, Role } from "./crustdata.js";

const DAY = 24 * 60 * 60 * 1000;

export const profileUrl = (p: Person): string => p.social_handles?.professional_network_identifier?.profile_url ?? "";
export const nameOf = (p: Person): string => p.basic_profile?.name?.trim() || "(no name)";
export const currentRoles = (p: Person): Role[] => p.experience?.employment_details?.current ?? [];
export const pastRoles = (p: Person): Role[] => p.experience?.employment_details?.past ?? [];

/** Internships and student jobs do not count as years of experience, and are never the "current role". */
export const isStudentRole = (title = ""): boolean => /\b(intern|internship|student|trainee|apprentice|working student)\b/i.test(title);
/** Roles held on the side. A person's main job is never one of these when another current role exists. */
export const isSideRole = (title = ""): boolean => /\b(advisor|adviser|board member|investor|angel|mentor|volunteer|ambassador)\b/i.test(title);

/**
 * The role that counts: the one Crustdata marks as the main one, unless that is a side role (advisor, investor)
 * and a real job exists next to it; then the most recently started real job.
 */
export function primaryRole(p: Person): Role | undefined {
  const roles = currentRoles(p);
  if (!roles.length) return undefined;
  const main = roles.find(r => r.is_default) ?? roles[0];
  if (!isSideRole(main.title) && !isStudentRole(main.title)) return main;
  const real = roles.filter(r => !isSideRole(r.title) && !isStudentRole(r.title));
  return real.sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? ""))[0] ?? main;
}

/** Only real dates count: "Present", "Current" or "0" are not a date and must not read as the year 2000 or 2001. */
const time = (date: string | null | undefined): number | undefined => {
  if (!date || !/^\d{4}(?:-\d{2}){0,2}(?:[T ].*)?$/.test(date)) return undefined;
  const t = Date.parse(date.length === 7 ? `${date}-01` : date);
  return Number.isNaN(t) ? undefined : t;
};

/** Whole months in a role, from its start date to its end (or today). Undefined when the role has no start date. */
export function monthsIn(role: Role | undefined, today = new Date()): number | undefined {
  const start = time(role?.start_date);
  if (start === undefined) return undefined;
  const end = time(role?.end_date) ?? today.getTime();
  return Math.max(0, Math.floor((end - start) / (30.44 * DAY)));
}

/**
 * Years worked: every dated role except internships and student jobs, with overlapping roles counted once and
 * gaps left out. Crustdata's own figure (the one the --years filter uses) is computed in a similar way and is not
 * returned by search, so the two can differ by a year.
 */
export function yearsWorked(p: Person, today = new Date()): number | undefined {
  const spans: Array<[number, number]> = [];
  for (const r of [...currentRoles(p), ...pastRoles(p)]) {
    if (isStudentRole(r.title)) continue;
    const start = time(r.start_date);
    if (start === undefined) continue;
    const end = Math.min(time(r.end_date) ?? today.getTime(), today.getTime());
    if (end > start) spans.push([start, end]);
  }
  if (!spans.length) return undefined;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0, [from, to] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= to) to = Math.max(to, e);
    else { total += to - from; [from, to] = [s, e]; }
  }
  total += to - from;
  return Math.floor((total / (365.25 * DAY)) * 10) / 10;
}

/** "acme.example" from "https://www.Acme.example/careers?utm=x". Empty when it is not a URL or a domain. */
export function domainOf(url: string | null | undefined): string {
  if (!url) return "";
  const s = url.trim().toLowerCase();
  try {
    const host = new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname;
    return host.replace(/^www\d?\./, "");
  } catch {
    return "";
  }
}

/** True when the employer's website is this domain or a subdomain of it. */
export const sameDomain = (website: string | null | undefined, domain: string): boolean => {
  const d = domainOf(website), want = domainOf(domain);
  return !!d && !!want && (d === want || d.endsWith(`.${want}`));
};

export const skillsOf = (p: Person): string[] => (p.skills?.professional_network_skills ?? []).filter((s): s is string => typeof s === "string");

/** Text the person wrote about their work: headline and every role's title and description. Used to spot skills they did not list. */
export function workText(p: Person): string {
  const parts = [p.basic_profile?.headline, ...[...currentRoles(p), ...pastRoles(p)].flatMap(r => [r.title, r.description])];
  return parts.filter(Boolean).join("\n");
}

export const schoolsOf = (p: Person): string[] => (p.education?.schools ?? []).map(s => s.school ?? "").filter(Boolean);

export const locationOf = (p: Person): string => {
  const l = p.basic_profile?.location;
  return l?.full_location || l?.raw || [l?.city, l?.state, l?.country].filter(Boolean).join(", ");
};

/** Best h-index and citations across the person's research records (a person can have several author profiles). */
export function research(p: Person): { hIndex: number; citations: number; papers: number } | undefined {
  const list = p.research_profiles ?? [];
  if (!list.length) return undefined;
  const best = (f: (r: (typeof list)[number]) => number | null | undefined) => Math.max(0, ...list.map(r => Number(f(r)) || 0));
  return { hIndex: best(r => r.h_index?.all), citations: best(r => r.citations_count?.all), papers: best(r => r.article_count) };
}
