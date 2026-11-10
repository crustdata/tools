/**
 * Which team someone works on at their lab, with the evidence. Pure, so it is tested.
 *
 *   stated      the person says it: their current title, the description of their current role, or their headline
 *               (only the part before "previously", "ex-", "past:")
 *   inferred    the profile does not say, but other signals point one way: recent paper titles, research interests,
 *               past roles, skills, and co-authors at the same lab whose team is stated
 *   not stated  nothing points anywhere
 *
 * The words for each team are in config/teams.json. A guess is a lead to check, not a fact: the label and the
 * evidence line say how it was made.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";
import type { Person } from "./crustdata.js";
import { clip, interestsOf, nameOf, norm, pastRoles, papersOf, researchOf, roleAt, skillsOf } from "./profile.js";

export type Taxonomy = Array<{ team: string; words: string[]; not?: string[] }>;
export type TeamGuess = { team?: string; label: "stated" | "inferred" | "not stated"; evidence: string[]; also: string[] };

export function loadTaxonomy(file = resolve(ROOT, "config/teams.json")): Taxonomy {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`Cannot read ${file}: ${(err as Error).message}`); }
  const teams = (raw as { teams?: unknown })?.teams;
  if (!Array.isArray(teams) || !teams.every(t => t && typeof t.team === "string" && Array.isArray(t.words) && t.words.every((w: unknown) => typeof w === "string") && (t.not === undefined || (Array.isArray(t.not) && t.not.every((w: unknown) => typeof w === "string")))))
    throw new Error(`${file} must look like { "teams": [ { "team": "Inference", "words": ["inference", "serving"] } ] }.`);
  return teams as Taxonomy;
}

const PAST = /\b(?:past|previously|previous|prior|prev|formerly|ex|former|before|alum(?:ni|nus)?)\b/i;

/**
 * The parts of a headline about now. A headline is split into pieces (on | · ; , and sentence ends) and each piece is
 * cut at a past marker: "Code RL @Lab, Past: Post-Training at X" keeps "Code RL @Lab"; "Ex-Google Brain | Post-training
 * at Lab" keeps "Post-training at Lab"; "Former Googler. Now inference at Lab" keeps "Now inference at Lab".
 */
export function headlineNow(headline: string): string {
  // "prev." and "ex." are words here, not sentence ends; brackets are pieces of their own ("MTS at Lab (prev. Google)").
  const text = headline.replace(/\b(prev|ex|fmr|formerly)\.\s*/gi, "$1 ").replace(/\bx-(?=[A-Z])/g, "ex ").replace(/[()[\]]/g, ", ");
  // A piece that reads like a current role (says "at", "@", or a role word) ends a past stretch.
  const current = /(\bat\b|@|\b(research|researcher|scientist|engineer|engineering|staff|lead|head|working|building|now|team)\b)/i;
  const out: string[] = [];
  let past = false;
  for (const raw of text.split(/(\|)|[·•;\n]|,\s*|(?<=[a-z0-9])\.\s/i)) {
    if (raw === undefined) continue;
    if (raw === "|") { past = false; continue; }
    const piece = raw.trim();
    if (!piece) continue;
    const [now, ...rest] = piece.split(PAST);
    // After a past marker, bare names that follow ("Ex-Google, Brain, RL") are past too.
    if (past && !rest.length && !current.test(piece)) continue;
    past = rest.length > 0;
    const kept = now.replace(/^[\s,:;.-]+|[\s,:;.(-]+$/g, "");
    if (kept) out.push(kept);
  }
  return out.join(" | ");
}

/**
 * Every team named in a text, with the word that named it, in the order the text names them ("Pretraining and
 * inference performance" gives Pretraining first). Ties keep the taxonomy order.
 */
export function teamsIn(text: string, tax: Taxonomy): Array<{ team: string; word: string }> {
  if (!text.trim()) return [];
  const out: Array<{ team: string; word: string; at: number }> = [];
  tax.forEach(t => {
    // Phrases that never count for this team ("causal inference") are blanked out first.
    let hay = norm(text);
    for (const n of t.not ?? []) {
      const phrase = norm(n).trim();
      if (!phrase) continue;
      // Every occurrence, even back to back ("causal inference causal inference"), is blanked.
      hay = hay.replace(new RegExp(`(?<= )${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?= )`, "g"), m => "_".repeat(m.length));
    }
    let at = Infinity, word = "";
    for (const w of t.words) {
      const i = hay.indexOf(` ${norm(w).trim()} `);
      if (i !== -1 && (i < at || (i === at && w.length > word.length))) { at = i; word = w; }
    }
    if (word) out.push({ team: t.team, word, at });
  });
  // Earliest mention first; at the same place the longer word wins ("pretraining data" is Data, not Pretraining).
  return out.sort((a, b) => a.at - b.at || b.word.length - a.word.length).map(({ team, word }) => ({ team, word }));
}

/** Pass 1: what the person says about their current team. */
export function statedTeam(p: Person, labIds: Set<number>, tax: Taxonomy): TeamGuess | undefined {
  const role = roleAt(p, labIds);
  const sources: Array<[string, string]> = [
    ["title", role?.title ?? p.basic_profile?.current_title ?? ""],
    ["role description", role?.description ?? ""],
    ["headline", headlineNow(p.basic_profile?.headline ?? "")],
  ];
  for (const [where, text] of sources) {
    const hits = teamsIn(text, tax);
    if (!hits.length) continue;
    // The evidence quotes what the person wrote (the whole headline), not the part kept.
    const quoted = where === "headline" ? p.basic_profile?.headline ?? text : text;
    return { team: hits[0].team, label: "stated", evidence: [`${where}: "${clip(quoted, 110)}"`], also: hits.slice(1, 3).map(h => h.team) };
  }
  return undefined;
}

type Signal = { team: string; weight: number; line: string };

/**
 * Whole-lab papers: a model's technical report or launch paper ("<Model> 1.5: ...", "... technical report", "a family
 * of ... models") lists hundreds of authors from every team, so its title says nothing about the person's own team.
 */
const MODEL_NAMES = "gemini|gemma|llama|gpt|claude|qwen|deepseek|mistral|mixtral|phi|grok|palm|olmo|falcon|kimi|glm|yi|nemotron|command|jamba|granite|chinchilla|gopher|lamda|bloom|pythia|starcoder|codex";
export const labWidePaper = (title: string): boolean =>
  /\b(technical report|system card|model card|a family of|herd of models|open foundation (and fine-tuned )?(chat )?models)\b/i.test(title)
  || new RegExp(`^(the )?(${MODEL_NAMES})[\\s-]?v?\\d[\\w.]*\\s*(:|technical report|report\\b|$)`, "i").test(title.trim())
  || new RegExp(`\\b(${MODEL_NAMES})-v\\d`, "i").test(title)
  || new RegExp(`^(${MODEL_NAMES})\\b.*\\bof experts\\b`, "i").test(title.trim());
const CAPS: Record<string, number> = { paper: 6, older: 1.5, interest: 2, past: 2, coauthor: 4, skill: 1 };

/**
 * Pass 2, for people whose team is not stated. `colleagues` are the other people found at the same lab with a stated
 * team; a co-author among them is a strong hint (people publish with their own team).
 */
export function inferTeam(p: Person, tax: Taxonomy, colleagues: Array<{ person: Person; team: string }>, now = new Date()): TeamGuess {
  const signals: Array<Signal & { kind: string }> = [];
  const add = (kind: string, text: string, weight: number, line: (word: string) => string) => {
    for (const h of teamsIn(text, tax)) signals.push({ kind, team: h.team, weight, line: line(h.word) });
  };
  const cutoff = now.getFullYear() - 3;
  for (const paper of papersOf(p)) {
    if (labWidePaper(paper.title)) continue;
    const recent = (paper.year ?? 0) > cutoff;
    add(recent ? "paper" : "older", paper.title, recent ? 2 : 0.5, () => `${recent ? "paper" : "older paper"}${paper.year ? ` (${paper.year})` : ""}: "${clip(paper.title, 90)}"`);
  }
  for (const i of interestsOf(p)) add("interest", i, 1, () => `research interest: ${i}`);
  for (const r of pastRoles(p).slice(0, 4)) add("past", `${r.title ?? ""} . ${r.description ?? ""}`, 1, w => `past role: ${clip(r.title ?? "", 60)}${r.name ? ` at ${r.name}` : ""} (${w})`);
  for (const s of skillsOf(p)) add("skill", s, 0.5, () => `skill: ${s}`);
  // Co-authors: the same Scholar id, or the same name, as a colleague whose team is stated.
  const rp = researchOf(p);
  // A Scholar id match counts 2; a name match counts 1 (two people can share a name), and never when both have ids that differ.
  for (const c of rp?.co_authors ?? []) {
    for (const { person, team } of colleagues) {
      if (person.crustdata_person_id === p.crustdata_person_id) continue;
      const theirId = researchOf(person)?.id;
      const byId = !!c.id && !!theirId && c.id === theirId;
      const byName = !byId && !!c.name && norm(c.name) === norm(nameOf(person)) && !(c.id && theirId);
      if (byId || byName) { signals.push({ kind: "coauthor", team, weight: byId ? 2 : 1, line: `co-author of ${nameOf(person)} (${team}, stated)` }); break; }
    }
  }

  // Sum per team, each kind capped so one long paper list cannot decide alone.
  const totals = new Map<string, number>();
  const perKind = new Map<string, number>();
  for (const s of signals) {
    const k = `${s.team}|${s.kind}`;
    const used = perKind.get(k) ?? 0;
    const w = Math.max(0, Math.min(s.weight, (CAPS[s.kind] ?? 1) - used));
    perKind.set(k, used + w);
    totals.set(s.team, (totals.get(s.team) ?? 0) + w);
  }
  const order = tax.map(t => t.team);
  const ranked = [...totals.entries()].filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]));
  if (!ranked.length) return { label: "not stated", evidence: [], also: [] };
  const [team, top] = ranked[0];
  const evidence = [...new Set(signals.filter(s => s.team === team).sort((a, b) => b.weight - a.weight).map(s => s.line))].slice(0, 3);
  // A close second is shown too, so a reader sees the guess was a near call.
  const also = ranked.slice(1).filter(([, v]) => v >= top * 0.75).slice(0, 2).map(([t]) => t);
  return { team, label: "inferred", evidence, also };
}

/**
 * Teams for everyone at once: stated first, then inferred with the stated ones as colleagues. Colleagues are the
 * people at the same lab (by company id of the role at one of `labIds`, or of the main current role).
 */
export function guessTeams(people: Person[], labIds: Set<number>, tax: Taxonomy, now = new Date()): Map<number, TeamGuess> {
  const out = new Map<number, TeamGuess>();
  const labOf = (p: Person) => roleAt(p, labIds)?.crustdata_company_id ?? -1;
  for (const p of people) {
    const s = statedTeam(p, labIds, tax);
    if (s) out.set(p.crustdata_person_id, s);
  }
  for (const p of people) {
    if (out.has(p.crustdata_person_id)) continue;
    const lab = labOf(p);
    const colleagues = people.filter(q => q !== p && lab !== -1 && labOf(q) === lab && out.get(q.crustdata_person_id)?.label === "stated")
      .map(q => ({ person: q, team: out.get(q.crustdata_person_id)!.team! }));
    out.set(p.crustdata_person_id, inferTeam(p, tax, colleagues, now));
  }
  return out;
}

