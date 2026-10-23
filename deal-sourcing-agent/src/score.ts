/**
 * The score: 0 to 100 per company from the structured record, no model. Pure, no I/O.
 *
 * Every signal earns points up to its weight. A signal that does not apply (no --schools list, no headcount history,
 * posts not checked) is left out of the total instead of counting as zero, so the score is always "points earned out
 * of points possible". Every signal carries its reason as text, and the memo prints all of them.
 *
 * Timing is not scored alone. A last round 12 to 24 months ago only earns timing points when the company shows growth
 * since (team, roles posted, followers, founders' traction posts). A company that raised two years ago and has been
 * flat since is labelled "Due but quiet" and earns none.
 */

import type { Company, Founder, Jobs, Posts, Score, Signal, Timing } from "./types.js";
import { NO_UPPER_YEAR, type TimingMode } from "./thesis.js";
import { dueWindow } from "./windows.js";
export { DUE_WINDOWS, dueWindow } from "./windows.js";

/** Founders first, then growth, then hiring, then fit and timing. They add up to 100. Change them here. */
export const WEIGHTS = {
  repeatFounder: 13,   // a founder founded a company before (or ran a small one as CEO)
  foundersFrom: 15,    // a founder worked at a company on your --founders-from list
  schools: 7,          // a founder studied at a school on your --schools list
  headcount6m: 12,     // headcount growth over 6 months
  headcount3m: 8,      // headcount growth over 3 months
  followers6m: 5,      // follower growth over 6 months
  hiring: 15,          // roles posted in the last 90 days
  traction: 10,        // founders' posts in the last 6 months that mention traction (MRR, ARR, revenue, paying customers or profitability)
  fit: 5,              // last round and founding year inside the thesis
  timing: 10,          // time since the last round, combined with growth since
};

/** Where a signal earns full points, and what counts as a sign of growth for timing. */
export const LEVELS = {
  headcount6mFull: 50, headcount3mFull: 25, followers6mFull: 30, rolesFull: 6, tractionFull: 2,
  // Percentages lie on tiny bases (1 to 4 people is +300%), so full points also need this many people or followers added.
  headcount6mFullAdded: 4, headcount3mFullAdded: 2, followers6mFullAdded: 300,
  growthSign: { headcount6m: 10, headcount6mAdded: 2, roles90: 2, followers6m: 15, followers6mAdded: 100, traction: 1 },
  shrinking6m: -10,
};

export type ScoreSpec = {
  foundersFrom?: string[]; schools?: string[]; timing: TimingMode;
  stages?: string[]; unfunded?: boolean; founded?: [number, number];
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
/** "+56%", "-27%", and "+0.3%" for small changes, so a tiny change never prints as "+0%". */
const pct = (n: number) => `${n > 0 ? "+" : ""}${Math.abs(n) < 1 && n !== 0 ? Math.round(n * 10) / 10 : Math.round(n)}%`;
const plural = (n: number, word: string, many = word + "s") => `${n} ${n === 1 ? word : many}`;

/** Whole months from a YYYY-MM-DD date to today (negative for a date in the future). */
export function monthsSince(dateStr: string, today: Date): number {
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00Z");
  return (today.getUTCFullYear() - d.getUTCFullYear()) * 12 + (today.getUTCMonth() - d.getUTCMonth()) - (today.getUTCDate() < d.getUTCDate() ? 1 : 0);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthYear = (d?: string) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1] ?? ""} ${d.slice(0, 4)}`.trim() : "");
export const stageName = (s?: string) => {
  if (!s) return "";
  if (s === "pre_seed") return "Pre-seed";
  if (s.startsWith("series_")) return `Series ${s.slice(7).toUpperCase()}`;
  const w = s.replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** Followers gained, from the count now and the 6-month growth percent. */
export const followersAdded = (c: Company): number | undefined =>
  c.followers !== undefined && typeof c.followers6m === "number" && c.followers6m > -100 ? Math.round(c.followers - c.followers / (1 + c.followers6m / 100)) : undefined;
/** Share of full points: the percent and the absolute gain must both be there (an unknown gain does not hold it back). */
const share = (pctNow: number, pctFull: number, added: number | undefined, addedFull: number) =>
  pctNow <= 0 ? 0 : Math.min(pctNow / pctFull, added === undefined ? 1 : added / addedFull);

const span = (r: { start?: string; end?: string }) => r.start ? ` (${r.start.slice(0, 4)} to ${r.end ? r.end.slice(0, 4) : "now"})` : "";

/** Team change in words: "from 9 to 14 in 6 months (+56%)". */
function teamChange(c: Company, months: 3 | 6, growth: number): string {
  const added = months === 6 ? c.added6m : undefined;
  if (c.headcount !== undefined && added !== undefined && c.headcount - added > 0)
    return `from ${c.headcount - added} to ${c.headcount} people in 6 months (${pct(growth)})`;
  return `${pct(growth)} in ${months} months${c.headcount !== undefined ? ` (${c.headcount} people now)` : ""}`;
}

export function momentum(c: Company, jobs: Jobs, posts: Posts): { signs: string[]; shrinking: boolean; level: number } {
  const g = LEVELS.growthSign;
  const signs: string[] = [];
  if (typeof c.growth6m === "number" && c.growth6m >= g.headcount6m && (c.added6m ?? g.headcount6mAdded) >= g.headcount6mAdded) signs.push(`team ${pct(c.growth6m)} in 6 months`);
  if (jobs.last90 !== null && jobs.last90 >= g.roles90) signs.push(`${plural(jobs.last90, "role")} posted in 90 days`);
  if (typeof c.followers6m === "number" && c.followers6m >= g.followers6m && (followersAdded(c) ?? g.followers6mAdded) >= g.followers6mAdded) signs.push(`followers ${pct(c.followers6m)} in 6 months`);
  if (posts.traction !== null && posts.traction >= g.traction) signs.push(`${plural(posts.traction, "founder post")} on traction`);
  const shrinking = typeof c.growth6m === "number" && c.growth6m <= LEVELS.shrinking6m;
  return { signs, shrinking, level: Math.max(0, signs.length - (shrinking ? 1 : 0)) };
}

/** What is missing, said plainly, for the timing explanation. */
function quietParts(c: Company, jobs: Jobs, posts: Posts): string[] {
  const parts: string[] = [];
  if (typeof c.growth6m === "number") parts.push(`team ${pct(c.growth6m)} in 6 months`);
  if (jobs.last90 === 0) parts.push("no roles posted in 90 days");
  if (posts.traction === 0) parts.push("no founder posts on traction");
  return parts;
}

export function timingOf(c: Company, jobs: Jobs, posts: Posts, mode: TimingMode, today: Date): { timing: Timing; points?: number } {
  const max = WEIGHTS.timing;
  if (mode === "off") return { timing: { label: "Timing not scored", explain: "--timing off." } };
  const m = c.lastRoundDate ? monthsSince(c.lastRoundDate, today) : undefined;
  const last = c.lastRoundDate ? `Last round: ${stageName(c.lastRound) || "round"} in ${monthYear(c.lastRoundDate)} (${plural(Math.max(0, m!), "month")} ago).` : "No round on record.";
  const raisePosts = posts.raise ?? 0;
  if (raisePosts > 0 && (m === undefined || m >= 6)) {
    return {
      timing: { label: "May have just raised", explain: `${last} But ${plural(raisePosts, "founder post")} in the last 6 months ${raisePosts === 1 ? "mentions" : "mention"} a round, which may not be in the funding data yet. Check before you reach out.` },
      points: mode === "fresh" ? max : 0,
    };
  }
  if (m === undefined) return { timing: { label: "No disclosed round", explain: "No round on record, so timing is not scored." } };

  if (mode === "fresh") {
    const window = m <= 6 ? 1 : m <= 9 ? 0.5 : 0;
    const label = m < 0 ? "Round date in the future" : m <= 6 ? "Just raised" : m <= 9 ? "Raised 6 to 9 months ago" : "Not a recent round";
    return { timing: { label, explain: `${last} --timing fresh: a round in the last 6 months earns full points.` }, points: round1(window * max) };
  }

  // due: the window depends on the stage of the last round (DUE_WINDOWS), and points come only with recent growth.
  const w = dueWindow(c.lastRound);
  if (!w) return { timing: { label: "Timing not scored", explain: `${last} ${c.lastRound ? `A ${stageName(c.lastRound)} round` : "A round of unknown type"} has no usual time to the next round, so timing is not scored.` } };
  const window = m >= w.full[0] && m <= w.full[1] ? 1 : (m >= w.half[0] && m < w.full[0]) || (m > w.full[1] && m <= w.half[1]) ? 0.5 : 0;
  if (window === 0) {
    const label = m < w.half[0] ? "Raised recently" : `Raised ${plural(m, "month")} ago`;
    return { timing: { label, explain: `${last} After ${w.name}, the next round usually comes ${w.full[0]} to ${w.full[1]} months later (half points ${w.half[0]} to ${w.half[1]}), so no timing points.` }, points: 0 };
  }
  const base = window === 1 ? "Due" : m < w.full[0] ? "Nearly due" : "Past due";
  const mo = momentum(c, jobs, posts);
  const factor = mo.level >= 2 ? 1 : mo.level === 1 ? 0.5 : 0;
  const label = base + (factor === 1 ? " and growing" : factor === 0.5 ? ", some growth" : " but quiet");
  // Growth is measured over recent windows (team and followers over 6 months, roles over 90 days, posts over 6 months).
  const since = mo.signs.length ? `Recent growth: ${mo.signs.join(", ")}.` : "";
  const quiet = !mo.signs.length ? `No recent growth${quietParts(c, jobs, posts).length ? `: ${quietParts(c, jobs, posts).join(", ")}` : ""}.` : "";
  const shrink = mo.shrinking && mo.signs.length ? " The team is shrinking, which cancels one sign of growth." : "";
  const edge = window < 1 ? ` (${m < w.full[0] ? `${w.half[0]} to ${w.full[0]}` : `${w.full[1]} to ${w.half[1]}`} months after ${w.name} is the edge of the window, so half)` : "";
  const noData = typeof c.growth6m !== "number" && typeof c.followers6m !== "number";
  const verdict = factor === 0 ? (noData ? "No timing points: in the window for a next round, but no sign of growth on record (no headcount or follower history)." : "No timing points: in the window for a next round, but no growth in the last 6 months.")
    : factor === 0.5 ? `Only one sign of growth, so half the points${window < 1 ? ", and half again at the edge of the window" : ""}.`
    : `${window < 1 ? "Half" : "Full"} timing points${edge}.`;
  return { timing: { label, explain: [last, since || quiet, shrink.trim(), verdict].filter(Boolean).join(" ") }, points: round1(window * factor * max) };
}

/** Share of the applicable points that must have data before the score is out of what was scored alone. */
export const MIN_COVERAGE = 0.8;

/** Points that apply to every company under this thesis and these settings (before any company's data is known). */
export function applicablePoints(spec: ScoreSpec, posts: Posts): number {
  const W = WEIGHTS;
  return W.repeatFounder + (spec.foundersFrom?.length ? W.foundersFrom : 0) + (spec.schools?.length ? W.schools : 0)
    + W.headcount6m + W.headcount3m + W.followers6m + W.hiring + (posts.unchecked === "off" ? 0 : W.traction)
    + (spec.stages?.length || spec.unfunded || spec.founded ? W.fit : 0)
    // A thesis of companies with no disclosed round has no round to time.
    + (spec.timing === "off" || (spec.unfunded && !spec.stages?.length) ? 0 : W.timing);
}

export function scoreDeal(c: Company, founders: Founder[], jobs: Jobs, posts: Posts, spec: ScoreSpec, today: Date): Score {
  const W = WEIGHTS, L = LEVELS;
  const signals: Signal[] = [];
  const notScored: string[] = [];
  const add = (key: keyof typeof WEIGHTS, label: string, share: number, reason: string) =>
    signals.push({ key, label, points: round1(clamp01(share) * W[key]), max: W[key], reason });

  // Founders
  const prior = founders.flatMap(f => f.priorFounder.map(r => ({ f, r })));
  add("repeatFounder", "Repeat founder", prior.length ? 1 : 0,
    !founders.length ? "No founder, CEO or CTO profile found at this company."
    : prior.length ? prior.slice(0, 2).map(({ f, r }) => `${f.name} was ${r.title} at ${r.company || "another company"}${span(r)}`).join("; ") + "."
    : "No founder has a past founder role, or a past CEO role at a company of 500 people or fewer.");
  if (spec.foundersFrom?.length) {
    const hits = founders.flatMap(f => f.fromList.map(h => ({ f, h })));
    add("foundersFrom", "Founder from your list", hits.length ? 1 : 0,
      hits.length ? hits.slice(0, 2).map(({ f, h }) => `${f.name} worked at ${h.role.company || h.entry} (${h.role.title}${h.role.start ? `, ${h.role.start.slice(0, 4)} to ${h.role.end ? h.role.end.slice(0, 4) : "now"}` : ""})`).join("; ") + "."
      : `No founder worked at ${spec.foundersFrom.join(", ")}.`);
  } else notScored.push("Past employers: pass --founders-from to score them.");
  if (spec.schools?.length) {
    const hits = founders.flatMap(f => f.schoolHits.map(s => ({ f, s })));
    add("schools", "School on your list", hits.length ? 1 : 0,
      hits.length ? hits.slice(0, 2).map(({ f, s }) => `${f.name} studied at ${f.schools.find(x => x.school.toLowerCase().includes(s.toLowerCase()))?.school ?? s}`).join("; ") + "."
      : `No founder studied at ${spec.schools.join(", ")}.`);
  } else notScored.push("Schools: pass --schools to score them (they are listed in the memo either way).");

  // Growth
  if (typeof c.growth6m === "number") add("headcount6m", "Team growth, 6 months", share(c.growth6m, L.headcount6mFull, c.added6m, L.headcount6mFullAdded), `Team ${teamChange(c, 6, c.growth6m)}.${c.growth6m > 0 && c.added6m !== undefined && c.added6m >= 0 && c.added6m / L.headcount6mFullAdded < Math.min(1, c.growth6m / L.headcount6mFull) ? ` Only ${plural(c.added6m, "person", "people")} added, so not full points.` : ""}`);
  else notScored.push("Headcount growth: no headcount history for this company.");
  if (typeof c.growth3m === "number") add("headcount3m", "Team growth, 3 months", share(c.growth3m, L.headcount3mFull, c.added3m, L.headcount3mFullAdded), `Team ${teamChange(c, 3, c.growth3m)}.`);
  if (typeof c.followers6m === "number") add("followers6m", "Follower growth, 6 months", share(c.followers6m, L.followers6mFull, followersAdded(c), L.followers6mFullAdded), `Followers ${pct(c.followers6m)} in 6 months${c.followers !== undefined ? ` (${c.followers.toLocaleString("en-US")} now)` : ""}.`);
  else notScored.push("Follower growth: no follower history for this company.");

  // Hiring
  if (jobs.last90 !== null) add("hiring", "Roles posted", jobs.last90 / L.rolesFull,
    jobs.last90 ? `${plural(jobs.last90, "role")} posted in the last 90 days${jobs.last30 !== null ? ` (${jobs.last30} in the last 30)` : ""}${jobs.listings90 && jobs.listings90 > jobs.last90 ? `, counted once each (${jobs.listings90} listings across job sites)` : ""}.` : "No roles posted in the last 90 days.");
  else notScored.push("Hiring: roles were not counted.");

  // Founders' posts
  if (posts.traction !== null) add("traction", "Founders' traction posts", posts.traction / L.tractionFull,
    posts.traction ? `${plural(posts.traction, "founder post")} in the last 6 months ${posts.traction === 1 ? "mentions" : "mention"} revenue, paying customers or profitability.` : "No founder post in the last 6 months mentions revenue, paying customers or profitability.");
  // Not checked because of its rank: scored as zero, so a company that was not checked never outranks one that was.
  else if (posts.unchecked === "rank") add("traction", "Founders' traction posts", 0, `Not checked: ${posts.skipped ?? "outside the companies checked"}. Counted as none.`);
  else notScored.push(`Founders' posts: ${posts.skipped ?? "not checked"}.`);

  // Fit with the thesis (the search already filters on these; this shows it, and catches dates that disagree)
  const checks: Array<[boolean, string]> = [];
  if (spec.stages?.length || spec.unfunded) {
    const ok = (!!c.lastRound && !!spec.stages?.includes(c.lastRound)) || (!!spec.unfunded && !c.lastRoundDate);
    checks.push([ok, c.lastRound ? `Last round ${stageName(c.lastRound)}` : "No round on record"]);
  }
  if (spec.founded) {
    const ok = c.founded !== undefined && c.founded >= spec.founded[0] && (spec.founded[1] >= NO_UPPER_YEAR || c.founded <= spec.founded[1]);
    checks.push([ok, c.founded ? `founded ${c.founded}` : "founding year unknown"]);
  }
  if (checks.length) {
    const ok = checks.filter(([y]) => y).length;
    add("fit", "Stage and age fit", ok / checks.length, `${checks.map(([, t]) => t).join(", ")}: ${ok === checks.length ? "inside the thesis" : "partly outside the thesis"}.`);
  }

  // Timing, combined with growth
  const t = timingOf(c, jobs, posts, spec.timing, today);
  if (t.points !== undefined) signals.push({ key: "timing", label: "Timing", points: t.points, max: W.timing, reason: `${t.timing.label}. ${t.timing.explain}` });
  else notScored.push(`Timing: ${t.timing.explain}`);

  const earned = signals.reduce((s, x) => s + x.points, 0);
  const possible = signals.reduce((s, x) => s + x.max, 0);
  // Missing data must not lift a company: when more than a fifth of the points that apply to this thesis have no
  // data, the missing part counts as zero.
  const applies = applicablePoints(spec, posts);
  const outOf = Math.max(possible, Math.round(applies * MIN_COVERAGE));
  const mo = momentum(c, jobs, posts);
  return { total: outOf ? Math.round((100 * earned) / outOf) : 0, signals, notScored, timing: t.timing, momentum: { signs: mo.signs, shrinking: mo.shrinking }, scoredOn: possible, applies };
}
