/**
 * The rubric: your own scoring rules, in rubric.json, with the evidence behind every point. Pure, so it is tested.
 *
 * Each rule is { "points": 10, "if": "<kind>", "value": ..., "label": "..." }. A person earns the points when the
 * rule holds, and the evidence says why (a title, a paper, a number). When the data a rule needs is missing (no
 * research profile, say), the rule is listed under "no data" and counts at a share of its points (`no_data_share` in
 * rubric.json, 0.25 by default): unknown is neither a yes nor a no, so a thin profile is not marked down to zero, and
 * a near-empty record does not jump above people whose record shows more. The score is that total out of the points
 * the rubric could give, 0 to 100. `checkedScore` is the points earned out
 * of the points that could be checked, and `coverage` says how much of the rubric that was.
 *
 * Lines under "ask" are free-text questions. They are scored only with --ai (Claude reads the same evidence); without
 * it they are left out of the total. See docs/customize.md for every kind with an example.
 */

import { readFileSync } from "node:fs";
import type { Person, Role } from "./crustdata.js";
import { citations, clip, currentRoles, findPhrase, hIndex, hasPhrase, interestsOf, norm, papersOf, pastRoles, recentPapers, researchOf, schoolsOf, skillsOf, span, yearsWorked } from "./profile.js";
import type { TeamGuess } from "./teams.js";

export const KINDS = ["worked_at", "title", "team", "fit", "papers_about", "recent_papers", "h_index", "citations", "interests", "skill", "school", "text", "years", "found_from_work"] as const;
export type Kind = typeof KINDS[number];
export type Rule = { points: number; if: Kind; value?: unknown; label?: string; when?: "now" | "before" | "ever"; since_years?: number };
export type Ask = { points: number; question: string };
/** noDataShare: the share of its points a rule with no data counts for (0 to 1, default 0.25). */
export type Rubric = { rules: Rule[]; ask: Ask[]; noDataShare?: number };

/**
 * What "frontier" stands for in a worked_at rule: the Crustdata company ids of the labs in FRONTIER_LABS (src/labs.ts,
 * checked live 2026-10-28), plus full names for roles recorded under an older company ("DeepMind" in 2019, "Google
 * Brain"). Short names that other companies share ("Reflection", "SSI") are matched by id only.
 */
export const FRONTIER_IDS = [631466, 635252, 1034291, 6036351, 812301, 4372218, 17046658, 949125];
export const FRONTIER_NAMES: string[] = [
  "OpenAI", "Anthropic", "Google DeepMind", "DeepMind", "Google Brain", "xAI", "X.AI", "Mistral AI",
  "Thinking Machines Lab", "Safe Superintelligence", "Reflection AI",
];

const asList = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(x => String(x).trim()).filter(Boolean);

const ALLOWED: Record<string, string[]> = { worked_at: ["when"], papers_about: ["since_years"], recent_papers: ["since_years"] };
const BASE_KEYS = ["points", "if", "value", "label"];

/** The closest word in a list, for "did you mean". */
function closest(word: string, list: readonly string[]): string | undefined {
  const d = (a: string, b: string) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  const best = [...list].sort((a, b) => d(word.toLowerCase(), a.toLowerCase()) - d(word.toLowerCase(), b.toLowerCase()))[0];
  return best && d(word.toLowerCase(), best.toLowerCase()) <= Math.max(2, Math.floor(best.length / 3)) ? best : undefined;
}

/** Where a JSON parse error is, as a line number. */
function jsonLine(text: string, err: Error): number | undefined {
  const pos = /position (\d+)/.exec(err.message)?.[1];
  if (pos) return text.slice(0, Number(pos)).split("\n").length;
  const line = /line (\d+)/.exec(err.message)?.[1];
  if (line) return Number(line);
  // Newer Node versions give no position: look for the usual mistakes ourselves.
  const at = text.search(/,\s*[\]}]/) !== -1 ? text.search(/,\s*[\]}]/) : text.search(/[\u201c\u201d\u2018\u2019]/);
  return at !== -1 ? text.slice(0, at).split("\n").length : undefined;
}

/** Reads and checks rubric.json; every mistake is named with its rule number. `teams` are the known team names. */
export function parseRubric(text: string, file = "rubric.json", teams?: string[]): Rubric {
  let raw: any;
  try { raw = JSON.parse(text); } catch (err) {
    const line = jsonLine(text, err as Error);
    throw new Error(`${file} is not valid JSON${line ? ` near line ${line}` : ""}. The usual causes: a comma after the last item in a list, a missing comma between rules, or curly quotes instead of straight ones.`);
  }
  const rules = raw?.rules;
  if (!Array.isArray(rules) || !rules.length) throw new Error(`${file} needs a "rules" list. See docs/customize.md.`);
  const problems: string[] = [];
  rules.forEach((r: any, i: number) => {
    const at = `rule ${i + 1}${typeof r?.label === "string" ? ` ("${r.label}")` : ""}`;
    if (!r || typeof r !== "object") { problems.push(`${at} is not an object`); return; }
    if (r.label !== undefined && typeof r.label !== "string") problems.push(`${at}: "label" must be text in quotes`);
    for (const k of Object.keys(r)) if (!BASE_KEYS.includes(k) && !(ALLOWED[r.if] ?? []).includes(k)) {
      const known = [...BASE_KEYS, ...(ALLOWED[r.if] ?? [])];
      const guess = closest(k, [...BASE_KEYS, "when", "since_years"]);
      problems.push(`${at}: unknown key "${k}"${guess && known.includes(guess) ? ` (did you mean "${guess}"?)` : guess ? ` ("${guess}" only goes with ${Object.entries(ALLOWED).filter(([, v]) => v.includes(guess)).map(([kk]) => kk).join(" or ")})` : ""}`);
    }
    if (!(typeof r.points === "number" && r.points > 0 && r.points <= 1000)) problems.push(`${at}: "points" must be a number above 0`);
    if (!KINDS.includes(r.if)) { const g = typeof r.if === "string" ? closest(r.if, KINDS) : undefined; problems.push(`${at}: "if" must be one of ${KINDS.join(", ")} (got ${JSON.stringify(r.if)}${g ? `; did you mean "${g}"?` : ""})`); }
    if (r.if === "team" && teams) for (const t of asList(r.value)) if (!/^any$/i.test(t) && !teams.some(x => x.toLowerCase() === t.toLowerCase())) { const g = closest(t, teams); problems.push(`${at}: "${t}" is not a team in config/teams.json${g ? ` (did you mean "${g}"?)` : ""}`); }
    const numeric = ["recent_papers", "h_index", "citations", "years"].includes(r.if);
    if (numeric && !(typeof r.value === "number" && r.value >= 0)) problems.push(`${at}: "value" must be a number (the minimum)`);
    if (!numeric && !["found_from_work", "fit", "team"].includes(r.if) && !asList(r.value).length) problems.push(`${at}: "value" needs one or more words or names`);
    if (r.when !== undefined && !["now", "before", "ever"].includes(r.when)) problems.push(`${at}: "when" must be "now", "before" or "ever"`);
    if (r.since_years !== undefined && !(Number.isInteger(r.since_years) && r.since_years > 0)) problems.push(`${at}: "since_years" must be a whole number of years`);
  });
  const ask = raw.ask ?? [];
  if (!Array.isArray(ask)) problems.push(`"ask" must be a list of { "points": 10, "question": "..." }`);
  else ask.forEach((a: any, i: number) => {
    if (!a || typeof a.question !== "string" || !a.question.trim() || !(typeof a.points === "number" && a.points > 0 && a.points <= 1000)) problems.push(`ask ${i + 1} needs "points" (above 0) and "question"`);
  });
  if (problems.length) throw new Error(`${file} has ${problems.length === 1 ? "a problem" : "problems"}:\n  ${problems.join("\n  ")}`);
  const share = raw.no_data_share;
  if (share !== undefined && !(typeof share === "number" && share >= 0 && share <= 1)) throw new Error(`${file}: "no_data_share" must be a number from 0 to 1 (0.25 counts a rule with no data at a quarter of its points).`);
  return { rules, ask: Array.isArray(ask) ? ask : [], noDataShare: share };
}

export const loadRubric = (file: string, teams?: string[]): Rubric => {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { throw new Error(`Cannot read the rubric ${file}. Copy rubric.json from the repo or pass --rubric <file>.`); }
  return parseRubric(text, file, teams);
};

/** What the rubric needs to know about the run. */
export type RunContext = { topics: string[]; labIds: Set<number>; labNames: string[]; now?: Date };

/** How a person was found, kept with them: "search", "Google Scholar profile", "GitHub profile", "paper: <title>". */
export type Found = { person: Person; via: string[]; found_at?: string };

/** "search" and "Google Scholar email at ..." come from a ranked search; the rest from the person's work. */
export const isSearchVia = (v: string) => v === "search" || v.startsWith("Google Scholar email at");

/** Whether a role is at a frontier lab: by company id, or by full name (older names included). */
export const isFrontierRole = (r: Role): boolean => (!!r.crustdata_company_id && FRONTIER_IDS.includes(r.crustdata_company_id)) || (!!r.name && sameName(r.name, FRONTIER_NAMES));

export type Outcome = { rule: string; points: number; earned: number; evidence?: string; noData?: boolean };
/**
 * score: (earned + half of the no-data points) out of all points; checkedScore: earned out of the checked points;
 * coverage: checked points out of all, 0 to 100.
 */
export type Scored = { score: number; checkedScore: number; earned: number; possible: number; checked: number; coverage: number; outcomes: Outcome[] };

const roleLine = (r: Role) => [r.title, r.name && `at ${r.name}`, span(r) && `(${span(r)})`].filter(Boolean).join(" ");

function labNamesFor(value: unknown, ctx: RunContext): string[] {
  const out: string[] = [];
  for (const v of asList(value)) {
    if (/^frontier$/i.test(v)) out.push(...FRONTIER_NAMES);
    else if (/^(this run|run labs|searched labs)$/i.test(v)) out.push(...ctx.labNames);
    else out.push(v);
  }
  return out;
}

/** "OpenAI, Inc." and "Anthropic PBC" are OpenAI and Anthropic. */
const SUFFIX = / (inc|llc|ltd|limited|pbc|lp|plc|gmbh|corp|corporation|co|technologies|sas|sa)\s*$/;
const bare = (name: string) => { let s = norm(name).trim(); while (SUFFIX.test(s)) s = s.replace(SUFFIX, "").trim(); return s; };
const sameName = (employer: string, names: string[]) => names.some(n => bare(employer) === bare(n));

/** One rule against one person. */
export function applyRule(rule: Rule, f: Found, team: TeamGuess | undefined, ctx: RunContext): Outcome {
  const p = f.person;
  const label = rule.label ?? `${rule.if} ${asList(rule.value).join(", ")}`.trim();
  const base = { rule: label, points: rule.points };
  const hit = (evidence: string, share = 1): Outcome => ({ ...base, earned: Math.round(rule.points * share * 10) / 10, evidence });
  const miss = (noData = false, evidence?: string): Outcome => ({ ...base, earned: 0, noData, evidence });
  const research = researchOf(p);
  const now = ctx.now ?? new Date();

  switch (rule.if) {
    case "worked_at": {
      const names = labNamesFor(rule.value, ctx);
      const values = asList(rule.value).join(" ");
      const vals = asList(rule.value);
      const ids = new Set<number>([...(vals.some(v => /^(this run|run labs|searched labs)$/i.test(v)) ? ctx.labIds : []), ...(vals.some(v => /^frontier$/i.test(v)) ? FRONTIER_IDS : [])]);
      const when = rule.when ?? "ever";
      const roles = [...(when !== "before" ? currentRoles(p) : []), ...(when !== "now" ? pastRoles(p) : [])];
      const r = roles.find(x => (x.crustdata_company_id && ids.has(x.crustdata_company_id)) || (x.name && sameName(x.name, names)));
      if (r) return hit(roleLine(r));
      return miss(!roles.length);
    }
    case "title": {
      const titles = currentRoles(p).map(r => r.title ?? "").concat(p.basic_profile?.current_title ?? "").filter(Boolean);
      const t = titles.find(x => findPhrase(x, asList(rule.value)));
      return t ? hit(`title: ${t}`) : miss(!titles.length);
    }
    case "team": {
      if (!team?.team) return miss(true);
      const wanted = asList(rule.value);
      if (wanted.length && !wanted.some(w => /^any$/i.test(w)) && !wanted.some(w => norm(w) === norm(team.team!))) return miss(false, `${team.team} (${team.label})`);
      // An inferred team earns half: it is a guess, and the evidence says from what.
      return hit(`${team.team} (${team.label}${team.evidence[0] ? `: ${team.evidence[0]}` : ""})`, team.label === "stated" ? 1 : 0.5);
    }
    case "fit": {
      // Crustdata gives a tier only to the top of the ranked list (up to 200 people); a search result with no tier
      // did not clear its relevance bar, so it scores like "weak".
      const fit = p.fit;
      if (!fit) return miss(false, "below Crustdata's top matches for the search");
      if (fit === "strong") return hit("Crustdata rates them a strong match for the search");
      if (fit === "possible") return hit("Crustdata rates them a possible match for the search", 0.5);
      return miss();
    }
    case "papers_about": {
      const phrases = asList(rule.value).flatMap(v => (v === "$topic" ? ctx.topics : [v]));
      if (!research) return miss(true);
      const papers = rule.since_years ? recentPapers(p, rule.since_years, now) : papersOf(p);
      const on = papers.filter(x => findPhrase(x.title, phrases));
      if (!on.length) return miss(false, `no paper on ${phrases.map(x => `"${x}"`).join(" or ")}${rule.since_years ? ` since ${now.getFullYear() - rule.since_years + 1}` : ""}`);
      return hit(`${on.length} paper${on.length === 1 ? "" : "s"}: ${on.slice(0, 2).map(x => `"${clip(x.title, 80)}"${x.year ? ` (${x.year})` : ""}`).join(", ")}`);
    }
    case "recent_papers": {
      if (!research) return miss(true);
      const years = rule.since_years ?? 3;
      const recent = recentPapers(p, years, now);
      const count = `${recent.length} paper${recent.length === 1 ? "" : "s"} since ${now.getFullYear() - years + 1}`;
      return recent.length >= Number(rule.value) ? hit(count) : miss(false, count);
    }
    case "h_index": {
      const h = hIndex(p);
      if (h === undefined) return miss(true);
      return h >= Number(rule.value) ? hit(`h-index ${h}`) : miss(false, `h-index ${h}`);
    }
    case "citations": {
      const c = citations(p);
      if (c === undefined) return miss(true);
      return c >= Number(rule.value) ? hit(`${c.toLocaleString("en-US")} citations`) : miss(false, `${c.toLocaleString("en-US")} citations`);
    }
    case "interests": {
      if (!research) return miss(true);
      const i = interestsOf(p).find(x => findPhrase(x, asList(rule.value)));
      return i ? hit(`research interest: ${i}`) : miss(!interestsOf(p).length);
    }
    case "skill": {
      const skills = skillsOf(p);
      const s = skills.find(x => findPhrase(x, asList(rule.value)));
      return s ? hit(`skill: ${s}`) : miss(!skills.length);
    }
    case "school": {
      const schools = schoolsOf(p);
      const s = schools.find(x => findPhrase(x, asList(rule.value)));
      return s ? hit(`studied at ${s}`) : miss(!schools.length);
    }
    case "text": {
      const texts = [p.basic_profile?.headline ?? "", ...currentRoles(p).concat(pastRoles(p)).flatMap(r => [r.title ?? "", r.description ?? ""]), ...skillsOf(p)].filter(Boolean);
      for (const t of texts) {
        const w = findPhrase(t, asList(rule.value));
        if (w) return hit(`"${clip(t, 100)}"`);
      }
      return miss(!texts.length);
    }
    case "years": {
      const y = yearsWorked(p, now);
      if (y === undefined) return miss(true);
      return y >= Number(rule.value) ? hit(`${y} years worked`) : miss(false, `${y} years worked`);
    }
    case "found_from_work": {
      const work = f.via.filter(v => !isSearchVia(v));
      return work.length ? hit(`found from ${work.join("; ")}`) : miss();
    }
  }
}

/**
 * The whole rubric for one person. A papers_about rule whose words come only from --topic is left out when the run
 * has no topic. AI answers (with --ai) are added by the caller as extra outcomes.
 */
export function scorePerson(rubric: Rubric, f: Found, team: TeamGuess | undefined, ctx: RunContext, extra: Outcome[] = []): Scored {
  const outcomes: Outcome[] = [];
  for (const rule of rubric.rules) {
    if (rule.if === "papers_about" && !asList(rule.value).some(v => v !== "$topic") && !ctx.topics.length) continue;
    // The match tier comes from the search only; people found from their work alone are not marked down for it.
    if (rule.if === "fit" && !f.via.some(isSearchVia)) continue;
    outcomes.push(applyRule(rule, f, team, ctx));
  }
  outcomes.push(...extra);
  const possible = outcomes.reduce((s, o) => s + o.points, 0);
  const checked = outcomes.filter(o => !o.noData).reduce((s, o) => s + o.points, 0);
  const earned = outcomes.reduce((s, o) => s + o.earned, 0);
  const unknown = possible - checked;
  const share = rubric.noDataShare ?? 0.25;
  return {
    score: possible ? Math.round((100 * (earned + unknown * share)) / possible) : 0,
    checkedScore: checked ? Math.round((100 * earned) / checked) : 0,
    earned: Math.round(earned * 10) / 10, possible, checked,
    coverage: possible ? Math.round((100 * checked) / possible) : 0,
    outcomes,
  };
}
