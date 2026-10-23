/**
 * Scoring: a 0 to 100 score for every candidate, from the record alone. Rules, not a model, so the same record
 * always gets the same score and every point has a reason a recruiter can read and argue with.
 *
 * How it adds up: each row of WEIGHTS that applies to the role gives points up to its maximum. Rows that do not
 * apply (no school asked, so no school row) are left out of the maximum, so a score is "how much of what you asked
 * for this person has". Bonus rows (open to new roles, research) add on top, capped at 100.
 *
 * To change how candidates rank, change a number here. docs/customize.md walks through it.
 */

import type { Person } from "./crustdata.js";
import { ABBREVIATIONS, LEVEL_WORDS, type RoleSpec } from "./role.js";
import { domainOf, monthsIn, nameOf, primaryRole, research, sameDomain, schoolsOf, skillsOf, workText, yearsWorked, pastRoles, currentRoles } from "./profile.js";

export const WEIGHTS = {
  /**
   * Crustdata's relevance tier for the role sentence, from its semantic search (the one model signal in the score).
   * Only the top of the ranked list (up to 200 people) gets one; the rest count as "weak", below every rated person.
   */
  fit: { max: 25, strong: 25, possible: 15, weak: 5 },
  /** Skills from the sentence and --must: the share present. Listed as a skill counts in full, only written about counts half. */
  skills: { max: 20 },
  /** --nice skills, the same way, at a lower weight. */
  nice: { max: 10 },
  /** Current title against the role title: the exact phrase, every word, or the main word (the last one, like "engineer"). */
  title: { max: 15, exact: 15, allWords: 10, mainWord: 4 },
  /** Years worked against the band asked: inside it, a year short of it, or more than its upper end (never zero for more). */
  years: { max: 10, inBand: 10, nearBand: 5, aboveBand: 8 },
  /** Months in the current role. Just started: unlikely to move. Two years or more: no penalty for staying long. */
  tenure: { max: 10, under6: 2, under24: 7, over24: 10, unknown: 4 },
  /** Current employer size inside the band asked. */
  size: { max: 5 },
  /** Worked at one of the --past companies before. */
  past: { max: 10 },
  /** Studied at one of the --school schools. */
  school: { max: 5 },
  /** Bonus: says they are open to new roles. */
  open: { bonus: 8 },
  /** Bonus with --papers: h-index of 10 or more, 3 or more, or any research record. */
  research: { bonus: 8, h10: 8, h3: 5, any: 2 },
} as const;

export type Scored = {
  score: number;
  reasons: string[];
  matched: string[];
  missing: string[];
  niceMissing: string[];
  years?: number;
  monthsInRole?: number;
  open: boolean;
};

export type Extras = { open?: boolean; today?: Date };

const lower = (s: string) => s.toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Whole-word match that also works for skills like "C++", "C#", ".NET" and "Node.js". Short names ("Go", "R", "C")
 * must match their case exactly, so "go to market", "R&D" and "C-level" do not count.
 */
const mentions = (text: string, word: string) => {
  const short = word.replace(/[^a-z]/gi, "").length <= 2;
  return new RegExp(`(^|[^a-zA-Z0-9+#.])${escape(short ? word : lower(word))}($|[^a-zA-Z0-9+#&-])`, short ? "" : "i").test(text);
};
const plainWords = (s: string) => lower(s).replace(/[^a-z0-9+# ]+/g, " ").split(/\s+/).filter(Boolean);
const SENIORITY = new Set([...LEVEL_WORDS, "head", "chief"]);
/** Words that mean the same job: a "backend developer" is a "backend engineer". */
const SAME_JOB: Record<string, string> = { developer: "engineer", programmer: "engineer", dev: "engineer", swe: "software engineer" };
const expand = (s: string) => plainWords(s).map(w => ABBREVIATIONS[w] ?? w).join(" ").split(" ").map(w => SAME_JOB[w] ?? w).join(" ");

/** How well a current title matches the role title. */
export function titleMatch(current: string, wanted: string): "exact" | "allWords" | "mainWord" | "none" {
  if (!current || !wanted) return "none";
  const have = expand(current), want = expand(wanted);
  if (` ${have} `.includes(` ${want} `)) return "exact";
  const core = want.split(" ").filter(w => !SENIORITY.has(w));
  const haveWords = new Set(have.split(" "));
  if (core.length && core.every(w => haveWords.has(w))) return "allWords";
  const main = core[core.length - 1];
  return main && haveWords.has(main) ? "mainWord" : "none";
}

/**
 * Share of these skills present: listed counts 1, written about in a title, headline or role description counts 0.5.
 * A skill stored under other spellings ("Go" as "Golang") counts when any spelling is listed.
 */
function skillShare(wanted: string[], listed: string[], text: string, variants: Record<string, string[]> = {}): { share: number; listed: string[]; written: string[]; missing: string[] } {
  const have = new Set(listed.map(lower));
  const out = { listed: [] as string[], written: [] as string[], missing: [] as string[] };
  for (const s of wanted) {
    if (have.has(lower(s)) || (variants[s] ?? []).some(v => have.has(lower(v)))) out.listed.push(s);
    else if (mentions(text, s)) out.written.push(s);
    else out.missing.push(s);
  }
  const share = wanted.length ? (out.listed.length + out.written.length / 2) / wanted.length : 0;
  return { share, ...out };
}

const fmtYears = (y: number) => `${Math.floor(y)} yr${Math.floor(y) === 1 ? "" : "s"}`;
const fmtMonths = (m: number) => (m < 12 ? `${m} month${m === 1 ? "" : "s"}` : ((v: string) => `${v} yr${v === "1" ? "" : "s"}`)((m / 12).toFixed(1).replace(/\.0$/, "")));

export function scoreCandidate(spec: RoleSpec, p: Person, extras: Extras = {}): Scored {
  const today = extras.today ?? new Date();
  let points = 0, max = 0, bonus = 0;
  const reasons: string[] = [];
  const role = primaryRole(p);
  const text = workText(p);
  const listed = skillsOf(p);

  // Crustdata fit tier. Only the top of the ranked list has one; people below it count as "weak", so they never
  // outrank someone Crustdata rated.
  max += WEIGHTS.fit.max;
  points += WEIGHTS.fit[p.fit ?? "weak"] ?? 0;
  reasons.push(p.fit ? `${p.fit} fit for the role` : "below Crustdata's top-ranked group for the role (no fit tier)");

  // Skills
  const asked = [...spec.must, ...spec.skills];
  let matched: string[] = [], missing: string[] = [], niceMissing: string[] = [];
  if (asked.length) {
    const s = skillShare(asked, listed, text, spec.skillVariants);
    max += WEIGHTS.skills.max;
    points += WEIGHTS.skills.max * s.share;
    matched = [...s.listed, ...s.written];
    missing = s.missing;
    if (s.listed.length) reasons.push(`has ${s.listed.join(", ")}`);
    if (s.written.length) reasons.push(`writes about ${s.written.join(", ")} but does not list ${s.written.length === 1 ? "it" : "them"}`);
    if (s.missing.length) reasons.push(`missing ${s.missing.join(", ")}`);
  }
  if (spec.nice.length) {
    const s = skillShare(spec.nice, listed, text, spec.skillVariants);
    max += WEIGHTS.nice.max;
    points += WEIGHTS.nice.max * s.share;
    matched.push(...s.listed, ...s.written);
    niceMissing = s.missing;
    if (s.listed.length) reasons.push(`nice to have: ${s.listed.join(", ")}`);
    if (s.written.length) reasons.push(`writes about ${s.written.join(", ")} (nice to have) but does not list ${s.written.length === 1 ? "it" : "them"}`);
  }

  // Title
  if (spec.title) {
    const current = role?.title ?? p.basic_profile?.current_title ?? "";
    const others = currentRoles(p).filter(r => r !== role).map(r => r.title ?? "");
    let m = titleMatch(current, spec.title);
    if (m === "none" || m === "mainWord") {
      const better = others.map(t => titleMatch(t, spec.title!)).find(x => x === "exact" || x === "allWords");
      if (better) m = better === "exact" ? "allWords" : "mainWord";
    }
    max += WEIGHTS.title.max;
    points += m === "none" ? 0 : WEIGHTS.title[m];
    reasons.push(m === "exact" ? `current title ${current}` : m === "allWords" ? `current title ${current} (close to ${spec.title})` : m === "mainWord" ? `current title ${current || "unknown"} (related)` : `current title ${current || "unknown"} (not ${spec.title})`);
  }

  // Years worked
  const years = yearsWorked(p, today);
  if (spec.years) {
    const [min, hi] = spec.years;
    max += WEIGHTS.years.max;
    if (years !== undefined) {
      const above = hi !== null && years >= hi + 1;
      const inBand = years >= min && !above;
      const near = years < min && years >= min - 1;
      points += inBand ? WEIGHTS.years.inBand : above ? WEIGHTS.years.aboveBand : near ? WEIGHTS.years.nearBand : 0;
      reasons.push(`${fmtYears(years)} worked (asked ${hi === null ? `${min}+` : `${min} to ${hi}`}${above ? ", more than asked" : ""})`);
    } else reasons.push("no dated roles, so years worked unknown");
  } else if (years !== undefined) reasons.push(`${fmtYears(years)} worked`);

  // Tenure in the current role
  const months = monthsIn(role, today);
  max += WEIGHTS.tenure.max;
  if (months === undefined) { points += WEIGHTS.tenure.unknown; if (role) reasons.push("current role has no start date"); else reasons.push("no current role"); }
  else {
    points += months < 6 ? WEIGHTS.tenure.under6 : months < 24 ? WEIGHTS.tenure.under24 : WEIGHTS.tenure.over24;
    reasons.push(`${fmtMonths(months)} in current role${months < 6 ? " (just started)" : ""}`);
  }

  // Employer size
  if (spec.sizes?.length) {
    max += WEIGHTS.size.max;
    const band = role?.company_headcount_range ?? "";
    const n = role?.company_headcount_latest;
    // The latest headcount against the number asked wins over the stored band, which can lag behind a company that grew.
    const range = spec.sizeRange;
    const fits = n && range ? n >= range[0] && (range[1] === null || n <= range[1]) : !!band && spec.sizes.includes(band);
    const known = !!n || !!band;
    if (fits) points += WEIGHTS.size.max;
    reasons.push((n ? `company of ${n.toLocaleString("en-US")} people` : band ? `company of ${band} people` : "employer size unknown") + (known && !fits ? " (outside the size asked)" : ""));
  }

  // Past employers
  if (spec.past?.length) {
    max += WEIGHTS.past.max;
    const roles = pastRoles(p);
    const hit = spec.past.find(want => want.includes(".")
      ? roles.some(r => sameDomain(r.company_website, want))
      : roles.some(r => (r.name ?? "") && new RegExp(`\\b${escape(lower(want))}\\b`, "i").test(r.name ?? "")));
    if (hit) { points += WEIGHTS.past.max; reasons.push(`worked at ${hit.includes(".") ? domainOf(hit) : hit}`); }
  }

  // School
  if (spec.schools?.length) {
    max += WEIGHTS.school.max;
    const hit = schoolsOf(p).find(s => spec.schools!.some(w => lower(s).includes(lower(w))));
    if (hit) { points += WEIGHTS.school.max; reasons.push(`studied at ${hit}`); }
  }

  // Bonuses
  const open = !!extras.open || !!spec.openOnly;
  if (open) { bonus += WEIGHTS.open.bonus; reasons.push("open to new roles"); }
  if (spec.papers) {
    const r = research(p);
    if (r) {
      bonus += r.hIndex >= 10 ? WEIGHTS.research.h10 : r.hIndex >= 3 ? WEIGHTS.research.h3 : WEIGHTS.research.any;
      reasons.push(`research: h-index ${r.hIndex}, ${r.citations.toLocaleString("en-US")} citations`);
    }
  }

  const score = Math.min(100, Math.round((max ? (100 * points) / max : 0) + bonus));
  return { score, reasons, matched: [...new Set(matched)], missing: [...new Set(missing)], niceMissing, years, monthsInRole: months, open };
}

/** Best first; ties keep Crustdata's order (its rank for the query). */
export function rank<T extends { scored: Scored; apiRank: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.scored.score - a.scored.score || a.apiRank - b.apiRank);
}

export const summary = (p: Person, s: Scored): string => `${nameOf(p)}: ${s.score}, ${s.reasons.join("; ")}`;
