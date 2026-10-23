/**
 * Hiring: new postings by function and place, jumps in posting rate, senior roles, and a slowdown in recent listings.
 * Works on job records from the Crustdata Job Postings Search API and the Job Watcher (same shape) plus free
 * `limit: 0` counts. Reports the change, never the total. Pure functions, no I/O.
 *
 * "New" means posted recently: the watcher delivers jobs that are new to Crustdata's index, and a listing can reach
 * the index weeks after it was posted, so jobs posted more than `RECENT_DAYS` before the digest are left out.
 */

import type { WeeklyJobs } from "./store.js";
import type { Item } from "./types.js";
import { clip, shortDate } from "./types.js";

export const RECENT_DAYS = 30;

export type JobRecord = {
  crustdata_job_id?: number | string;
  job_details?: { title?: string | null; category?: string | null; url?: string | null; number_of_openings?: number | null } | null;
  location?: { city?: string | null; state?: string | null; country?: string | null; raw?: string | null } | null;
  metadata?: { date_added?: string | null; date_updated?: string | null } | null;
  company?: { basic_info?: { primary_domain?: string | null; crustdata_company_id?: number | null } | null } | null;
};

/** Crustdata's job categories, as plain words for the digest. */
export function functionLabel(category: string | null | undefined): string {
  const c = (category ?? "").trim();
  if (!c || /^others?$/i.test(c)) return "other";
  const map: Record<string, string> = { Engineering: "engineering", Sales: "sales", Operations: "operations", Marketing: "marketing", "Product Management": "product", Finance: "finance", "Human Resources": "people", Design: "design", "Customer Success": "customer success", Support: "support", Legal: "legal", Research: "research", "Information Technology": "IT", "Business Development": "business development" };
  return map[c] ?? c.toLowerCase();
}

/** Short forms people type, matched to how job posts write places. */
const PLACE_ALIASES: Record<string, string[]> = {
  "uk": ["united kingdom", "england", "scotland", "wales"],
  "united kingdom": ["uk", "england", "scotland", "wales"],
  "us": ["united states", "usa"],
  "usa": ["united states", "us"],
  "united states": ["usa", "us"],
  "nyc": ["new york"],
  "new york city": ["new york"],
  "sf": ["san francisco"],
  "bay area": ["san francisco", "oakland", "san jose", "palo alto", "mountain view"],
  "la": ["los angeles"],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a job sits in one of the user's places. Matches whole words of the city, state, country or raw text. */
export function matchPlace(job: JobRecord, places: string[]): string | undefined {
  const loc = job.location ?? {};
  const fields = [loc.city, loc.state, loc.country, loc.raw].filter((x): x is string => Boolean(x)).map(norm);
  return places.find(p => {
    const n = norm(p);
    return [n, ...(PLACE_ALIASES[n] ?? [])].some(term => {
      const re = new RegExp(`(?<![a-z])${escapeRe(term)}(?![a-z])`, "i");
      return fields.some(f => re.test(f));
    });
  });
}

const dedupeJobs = (jobs: JobRecord[]): JobRecord[] => {
  const seen = new Set<string>();
  return jobs.filter(j => {
    const key = String(j.crustdata_job_id ?? `${j.job_details?.title}|${j.location?.raw}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Jobs posted within `RECENT_DAYS` of `now` (jobs with no date are kept). */
export function recentJobs(jobs: JobRecord[], now: Date): JobRecord[] {
  const cutoff = now.getTime() - RECENT_DAYS * 86_400_000;
  return jobs.filter(j => {
    const d = j.metadata?.date_added ? new Date(j.metadata.date_added).getTime() : NaN;
    return isNaN(d) || d >= cutoff;
  });
}

/** Average new jobs per week over the stored weeks before this one, or null with fewer than 2 weeks of history. */
export function weeklyAverage(history: WeeklyJobs[], currentWeek: string): number | null {
  const past = history.filter(h => h.week !== currentWeek);
  if (past.length < 2) return null;
  return past.reduce((s, h) => s + h.newJobs, 0) / past.length;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const about = (n: number) => (n < 1 ? "under 1" : `about ${Math.round(n)}`);

/** "posted Oct 14 to Oct 21" from the jobs' posting dates. */
function postedRange(jobs: JobRecord[]): string {
  const dates = jobs.map(j => (j.metadata?.date_added ?? "").slice(0, 10)).filter(Boolean).sort();
  if (!dates.length) return "";
  const first = shortDate(dates[0], "");
  const last = shortDate(dates.at(-1), "");
  return first === last ? `posted ${first}` : `posted ${first} to ${last}`;
}

export type HiringInput = {
  /** Jobs the watcher (or the week-one search) delivered, already limited to recent ones. */
  newJobs: JobRecord[];
  places: string[];
  history: WeeklyJobs[];
  currentWeek: string;
  /** Weeks this digest covers (2 after a skipped week), so the rate compares like with like. */
  weeks: number;
  /** Listings posted in the last 30 days, now and at the previous digest (free counts). */
  recentNow: number | null;
  recentBefore: number | null;
};

/** Digest items for one competitor's hiring this period. */
export function hiringItems(h: HiringInput): Item[] {
  const jobs = dedupeJobs(h.newJobs);
  const items: Item[] = [];
  if (jobs.length) {
    const byFunction = new Map<string, JobRecord[]>();
    for (const j of jobs) {
      const f = functionLabel(j.job_details?.category);
      byFunction.set(f, [...(byFunction.get(f) ?? []), j]);
    }
    const parts = [...byFunction.entries()].sort((a, b) => b[1].length - a[1].length).map(([f, list]) => {
      const counts = new Map<string, number>();
      for (const j of list) { const p = matchPlace(j, h.places); if (p) counts.set(p, (counts.get(p) ?? 0) + 1); }
      const where = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${n} in ${p}`).join(", ");
      return `${plural(list.length, `${f} role`)}${where ? ` (${where})` : ""}`;
    });
    const avg = weeklyAverage(h.history, h.currentWeek);
    const perWeek = jobs.length / Math.max(1, h.weeks);
    const rate = avg === null ? "" : perWeek >= Math.max(3, avg * 2) ? `, up from ${about(avg)} a week` : perWeek <= avg / 2 && avg >= 4 ? `, down from ${about(avg)} a week` : "";
    const shown = parts.slice(0, 4);
    const list = shown.length > 1 ? `${shown.slice(0, -1).join("; ")} and ${shown.at(-1)}` : shown[0];
    const range = postedRange(jobs);
    items.push({
      text: `${plural(jobs.length, "new posting")}${h.weeks > 1 ? ` over ${h.weeks} weeks` : ""}${rate}: ${list}${parts.length > 4 ? " and more" : ""}${range ? `, ${range}` : ""}`,
      why: rate.startsWith(", up") ? "a hiring push" : rate.startsWith(", down") ? "hiring slowed" : undefined,
      url: jobs.find(j => j.job_details?.url)?.job_details?.url ?? undefined,
      linkLabel: "one of them",
    });
    const titles = [...new Set(jobs.map(j => (j.job_details?.title ?? "").trim()).filter(Boolean))];
    const senior = titles.filter(t => /\b(head|vp|vice president|director|chief|cxo|c[a-z]o)\b/i.test(t)).slice(0, 3);
    if (senior.length) items.push({ text: `Senior roles opened: ${senior.map(t => clip(t, 50)).join("; ")}`, why: "a new leader usually means a new push", url: jobs.find(j => senior.includes((j.job_details?.title ?? "").trim()))?.job_details?.url ?? undefined });
  }
  if (h.recentNow !== null && h.recentBefore !== null && h.recentNow < h.recentBefore) {
    const drop = h.recentBefore - h.recentNow;
    if (drop >= 5 && drop >= h.recentBefore * 0.4) items.push({ text: `Fewer new listings: ${h.recentNow} posted in the last 30 days, down from ${h.recentBefore} at the last digest`, why: "hiring slowed" });
  }
  return items;
}
