/**
 * The fit score, without AI: 0 to 100, and every point explained in the report.
 *
 *   Skills      50  the skills the posting names that your CV has (required ones count double "nice to have")
 *   Title/level 20  the job title matches a title you search for (12), the level fits your years (8)
 *   Place        10  the work mode fits what you asked for (remote, on site)
 *   Company      10  headcount growing over 6 months (6), raised in the last 12 months (4)
 *   Freshness   10  posted in the last 3 days (10), 7 (8), 14 (6), 30 (4)
 *
 * Then flags that take points off: "no visa sponsorship" when you need it (-25), a security clearance (-15),
 * US citizens only when you need sponsorship (-15), more years than you have (-10). 70+ is a strong fit,
 * 50 to 69 possible, under 50 weak. Change the weights in WEIGHTS below. With Claude Code, the job-hunt skill
 * reads the whole posting and your whole CV instead (see .claude/skills/job-hunt).
 */

import { monthsSinceRound, type Momentum } from "./company.js";
import { daysSince, flagsOf, LEVEL_NAMES, levelFromYears, titleLevel, type Job } from "./jobs.js";
import { findSkills } from "./skills.js";

export const WEIGHTS = { skills: 50, titleMatch: 12, level: 8, place: 10, growth: 6, funding: 4, freshness: 10 };
export const PENALTY = { noSponsorship: 25, clearance: 15, citizensOnly: 15, years: 10 };

export type Seeker = {
  skills: string[];
  titles: string[];
  years: number | null;
  remote: "no" | "also" | "only";
  needsSponsorship: boolean;
};

export type Label = "Strong fit" | "Possible fit" | "Stretch" | "Weak fit";

/**
 * 70+ strong, 50 to 69 possible, under 50 weak. A role above your level is a "Stretch" at most, and a posting
 * that names under 2 skills is at most "Possible" (too little to judge the fit on).
 */
export function labelFor(score: number, why: { stretch: boolean; fewSkills: boolean }): Label {
  if (score < 50) return "Weak fit";
  if (why.stretch) return "Stretch";
  if (score >= 70 && !why.fewSkills) return "Strong fit";
  return "Possible fit";
}

export type Fit = {
  score: number;
  label: Label;
  parts: { skills: number; title: number; place: number; company: number; freshness: number; penalties: number };
  matched: string[];
  missing: string[];
  reasons: string[];
  flags: string[];
};

const STOP = new Set(["and", "or", "the", "of", "a", "an", "for", "to", "in", "at", "with", "on", "&", "-", "/"]);
const SYNONYMS: Record<string, string> = { developer: "engineer", dev: "engineer", swe: "software engineer", programmer: "engineer", sde: "software engineer" };
const words = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").split(" ").filter(w => w && !STOP.has(w)).flatMap(w => (SYNONYMS[w] ?? w).split(" "));

/** Share of the words of the closest searched title found in the job title (1 = all of them). */
export function titleMatch(jobTitle: string, titles: string[]): number {
  const have = new Set(words(jobTitle));
  let best = 0;
  for (const t of titles) {
    const want = words(t);
    if (!want.length) continue;
    best = Math.max(best, want.filter(w => have.has(w)).length / want.length);
  }
  return best;
}

const NICE_HEADING = /^\s*(?:#+\s*)?(?:[-*•]\s*)?(?:nice[- ]to[- ]haves?|bonus(?: points)?|preferred(?: qualifications| skills| experience)?|pluses|it'?s a plus|good to have|great to have|desired(?: qualifications| skills)?|extra credit|ideally you (?:also )?have|you might be a great fit|you(?:'ll| will) stand out)\b/i;
const MAIN_HEADING = /^\s*(?:#+\s*)?(?:requirements|qualifications|minimum qualifications|basic qualifications|what you(?:'ll|’ll| will) (?:do|bring|need)|what we(?:'re|’re| are) looking for|responsibilities|you might be a good fit|about (?:the role|us|you)|who you are|the role|benefits|compensation)\b/i;
const NICE_INLINE = /\b(?:is a plus|a plus|nice to have|bonus|preferred|ideally|familiarity with)\b/i;
const BREAK_BEFORE = /\s+(?=(?:nice[- ]to[- ]haves?|bonus points|preferred qualifications|you might be a (?:great|good) fit|you(?:'ll| will) stand out|requirements|minimum qualifications|basic qualifications|qualifications|responsibilities|what you(?:'ll|’ll| will) (?:do|bring|need)|what we(?:'re|’re| are) looking for|who you are|about (?:the role|us|you))\b)/gi;

/**
 * The skills a posting names, split into required and "nice to have". A skill counts as nice to have when every
 * line naming it sits under a "Nice to have" / "Preferred" / "Bonus" heading or says "a plus". Postings that come
 * as one long line are split before their usual headings first.
 */
export function postingSkills(job: Job): { required: string[]; nice: string[] } {
  const text = /\n/.test(job.description) ? job.description : job.description.replace(BREAK_BEFORE, "\n");
  const lines = `${job.title}\n${text}`.split("\n");
  const req = new Set<string>();
  const nice = new Set<string>();
  let underNice = false;
  for (const line of lines) {
    if (NICE_HEADING.test(line)) underNice = true;
    else if (MAIN_HEADING.test(line) || (/^\s*(?:#+\s*)?[A-Z][A-Za-z ,'&/]{2,60}:?\s*$/.test(line) && !/^\s*[-*•]/.test(line))) underNice = false;
    for (const s of findSkills(line)) (underNice || NICE_INLINE.test(line) ? nice : req).add(s);
  }
  for (const s of req) nice.delete(s);
  return { required: [...req], nice: [...nice] };
}

export function scoreJob(job: Job, me: Seeker, momentum: Momentum | null, now = new Date()): Fit {
  const reasons: string[] = [];
  const flags: string[] = [];
  const mine = new Set(me.skills.map(s => s.toLowerCase()));

  // Skills
  const { required, nice } = postingSkills(job);
  const hasR = required.filter(s => mine.has(s.toLowerCase()));
  const hasN = nice.filter(s => mine.has(s.toLowerCase()));
  const total = required.length + nice.length * 0.5;
  let skills: number;
  if (!total) {
    skills = WEIGHTS.skills / 2;
    reasons.push("The posting names no skills from the list, so skills count as half.");
  } else {
    skills = (WEIGHTS.skills * (hasR.length + hasN.length * 0.5)) / total;
    reasons.push(`Your CV has ${hasR.length} of ${required.length} skills the posting asks for${nice.length ? ` and ${hasN.length} of ${nice.length} nice to have` : ""}.`);
  }
  const missing = required.filter(s => !mine.has(s.toLowerCase()));

  // Title and level
  const tm = me.titles.length ? titleMatch(job.title, me.titles) : 1;
  const titlePts = tm >= 0.99 ? WEIGHTS.titleMatch : tm >= 0.5 ? WEIGHTS.titleMatch / 2 : 0;
  if (me.titles.length && tm < 0.99) reasons.push(tm >= 0.5 ? "The title is close to what you search for." : "The title is not one you search for.");
  const jobLevel = titleLevel(job.title);
  const myLevel = levelFromYears(me.years);
  let levelPts = WEIGHTS.level / 2;
  if (myLevel !== null) {
    const gap = jobLevel - myLevel;
    levelPts = gap === 0 ? WEIGHTS.level : Math.abs(gap) === 1 ? WEIGHTS.level / 2 : 0;
    if (gap >= 2) flags.push(`Pitched at ${LEVEL_NAMES[jobLevel]}; with ${me.years} years you read as ${LEVEL_NAMES[myLevel]}.`);
    else if (gap <= -2) reasons.push(`Pitched at ${LEVEL_NAMES[jobLevel]}, below your ${me.years} years.`);
  }

  // Place
  const remoteJob = /remote/i.test(job.workplace ?? "") || /\bremote\b/i.test(job.location ?? "");
  let place = WEIGHTS.place;
  if (me.remote === "only" && !remoteJob) { place = 3; reasons.push("You asked for remote; this one is not listed as remote."); }
  if (me.remote === "no" && remoteJob) place = 8;

  // Company
  let company = (WEIGHTS.growth + WEIGHTS.funding) / 2 - 1;
  if (momentum) {
    const g = momentum.growth6m ?? momentum.growth3m ?? momentum.growth12m;
    const months = momentum.growth6m !== null ? 6 : momentum.growth3m !== null ? 3 : 12;
    const growth = g === null ? WEIGHTS.growth / 2 : g >= 10 ? WEIGHTS.growth : g >= 2 ? WEIGHTS.growth * 0.75 : g > -2 ? WEIGHTS.growth / 2 : g > -8 ? WEIGHTS.growth / 4 : 0;
    const sinceRound = monthsSinceRound(momentum, now);
    const funding = sinceRound !== null && sinceRound <= 12 ? WEIGHTS.funding : sinceRound !== null && sinceRound <= 24 ? WEIGHTS.funding / 2 : 0;
    company = growth + funding;
    if (momentum.trend === "shrinking" && g !== null) flags.push(`The team shrank ${Math.abs(Math.round(g))}% in ${months} months.`);
  }

  // Freshness
  const days = daysSince(job.postedAt, now);
  const freshness = days === null ? 4 : days <= 3 ? 10 : days <= 7 ? 8 : days <= 14 ? 6 : days <= 30 ? 4 : 2;

  // Flags
  const f = flagsOf(job);
  let penalties = 0;
  if (f.noSponsorship) {
    flags.push("Says it does not sponsor visas.");
    if (me.needsSponsorship) penalties += PENALTY.noSponsorship;
  }
  if (f.clearance) { flags.push("Needs a security clearance."); penalties += PENALTY.clearance; }
  if (f.citizensOnly) {
    flags.push("US citizens only.");
    if (me.needsSponsorship) penalties += PENALTY.citizensOnly;
  }
  if (f.yearsRequired !== null && me.years !== null && f.yearsRequired > me.years + 1) {
    flags.push(`Asks for ${f.yearsRequired}+ years; your CV shows ${me.years}.`);
    penalties += PENALTY.years;
  }

  // Two levels above your years, or more years than you have: never called a strong fit, whatever the points say.
  const stretch = (myLevel !== null && jobLevel - myLevel >= 2) || (f.yearsRequired !== null && me.years !== null && f.yearsRequired > me.years + 1);
  const title = titlePts + levelPts;
  const raw = skills + title + place + company + freshness - penalties;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return {
    score,
    label: labelFor(score, { stretch, fewSkills: required.length + nice.length < 2 }),
    parts: { skills: Math.round(skills), title: Math.round(title), place: Math.round(place), company: Math.round(company), freshness, penalties },
    matched: [...hasR, ...hasN],
    missing: missing.slice(0, 6),
    reasons,
    flags,
  };
}
