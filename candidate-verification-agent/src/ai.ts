/**
 * Optional, off by default: with --ai and ANTHROPIC_API_KEY set, Claude writes a one-line summary per candidate and
 * a short overview of the whole list, only from the facts the check returned. The verdict and the review order
 * never depend on it; without a key nothing changes and the rule-based summary is used.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { labelCounts } from "./output.js";
import { VERDICTS, flagTexts, reviewOrder, verdictLabel, type Result } from "./verdict.js";

const LINE_SYSTEM = "You write one sentence, at most 35 words, for a recruiter about whether a candidate's current role checked out. Use only the facts given. Do not add facts, guesses about the person, or advice to reject anyone. Say what the evidence shows and what is still unknown. Plain words, no dashes, no greeting.";
const REPORT_SYSTEM = "You write a short overview, at most 120 words, of a verified candidate list for a recruiter. Use only the counts and lines given. Say how many to review first and the common reasons, and remind the reader that a verdict is evidence to review with the candidate, not a hiring decision. Plain words, no dashes, no names, no headings.";

/**
 * Everything the model sees about one person: the check's own output. No name, no profile URL, no employer
 * contact details (a name adds nothing to the summary and could lead a model to guess at gender or origin).
 */
/** The check's text can name the person (by the profile's name or the name in your file): those words become "the candidate". */
export function anonymize(t: string, ...args: Array<string | undefined | { keep?: string }>): string {
  const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keep = new Set(args.flatMap(a => (typeof a === "object" && a?.keep ? a.keep.toLowerCase().split(/[^\p{L}\p{N}]+/u) : [])));
  const names = args.filter((a): a is string => typeof a === "string");
  const whole = [...new Set(names.map(n => (n ?? "").trim()).filter(n => n.length > 1))].sort((a, b) => b.length - a.length);
  // Whole names first, any case, with spaces, hyphens or nothing between the parts ("Priya Example",
  // "priya-example" in a URL slug). A name in a script without spaces (王小明) also loses its given name (小明).
  for (const n of whole) {
    const parts = n.split(/[\s,]+/).filter(Boolean).map(esc);
    t = t.replace(new RegExp(parts.join("[\\s_.-]*"), "giu"), "the candidate");
    if (!/\s/.test(n) && !latin(n) && n.length >= 3) t = t.split(n.slice(1)).join("the candidate");
  }
  // Then single name words of three or more letters, with letter-aware edges, including longer forms that start
  // with them ("Jon" catches "Jonathan"). Words of four or more letters match in any case; three-letter words only
  // as written (so "may" or "will" in a sentence stay). A word of the employer's name is never removed.
  const words = [...new Set(whole.flatMap(n => n.split(/[\s,-]+/)).filter(p => p.length >= 3 && !keep.has(p.toLowerCase())))];
  for (const w of words) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}\\p{L}*(?![\\p{L}\\p{N}])`, w.length >= 4 ? "giu" : "gu"), "the candidate");
  return t.replace(/the candidate(?:\s+the candidate)+/g, "the candidate");
}
const latin = (s: string) => /^[\p{Script=Latin}\s\p{P}\p{M}]+$/u.test(s.normalize("NFKD"));

export function factsFor(r: Result, fileName?: string, otherNames: Array<string | undefined> = []): string {
  const anon = (t: string) => anonymize(t, r.person?.name, fileName, ...otherNames, { keep: r.person?.company });
  return anon([
    `Verdict: ${verdictLabel(r)} (${r.check === "full" ? "full check" : r.check === "quick" ? "quick screen" : "no verdict"})`,
    r.confidence !== undefined && `Confidence: ${Math.round(r.confidence * 100)}%`,
    r.tier !== undefined && `Trust tier: ${r.tier} of 9 (0 most trusted)`,
    r.person?.title && `Current role on the profile: ${r.person.title}${r.person.company ? ` at ${r.person.company}` : ""}`,
    r.reasoning && `Reasoning from the check: ${r.reasoning.slice(0, 2000)}`,
    r.coverage?.social_ran !== undefined && `Coworker engagement: ${r.coverage.coworker_hits ?? 0} people at the claimed employer engaged with ${r.coverage.posts_checked ?? 0} recent posts`,
    ...r.dateConflicts.map(c => `Dates: ${c}`),
    ...flagTexts(r).map(f => `Note: ${f}`),
    // Source titles only (a URL can hold a name); notes are left out (they can name another applicant).
    r.citations.length > 0 && `Sources cited: ${r.citations.slice(0, 5).map(c => c.title || hostOf(c.url)).join("; ")}`,
  ].filter(Boolean).join("\n"));
}

/** A sentence that names a dash or runs long is cut back to plain text. */
const clean = (s: string, max: number) => s.replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, max);

async function ask(system: string, text: string): Promise<string> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2 });
  const response = await client.beta.messages.create({
    model: config.anthropicModel,
    max_tokens: 2000,
    output_config: { effort: "low" },
    // Server-side fallback: if the model declines, Anthropic reruns the request on a recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: text }],
  });
  if (response.stop_reason === "refusal") return "";
  return response.content.map(b => (b.type === "text" ? b.text : "")).join(" ");
}

export const aiAvailable = (): boolean => Boolean(config.anthropicApiKey);
const hostOf = (u?: string) => { try { return new URL(u ?? "").hostname; } catch { return "a web page"; } };

/** One summary per result, in order. The first failure stops the AI step; the run continues without it. */
export async function aiSummaries(results: Result[], warn: (msg: string) => void, fileNames: Array<string | undefined> = []): Promise<string[]> {
  const out: string[] = [];
  // Every name in the list is removed from every request (the reasoning can mention another applicant).
  const allNames = [...fileNames, ...results.map(r => r.person?.name)];
  for (const [i, r] of results.entries()) {
    // Rows with no verdict are not sent at all.
    if (r.check === "none") { out.push(""); continue; }
    try {
      out.push(clean(await ask(LINE_SYSTEM, factsFor(r, fileNames[i], allNames)), 400));
    } catch (err) {
      warn(`The AI summary failed (${(err as Error).message.slice(0, 160)}); the rule-based summaries are used instead.`);
      return results.map(() => "");
    }
  }
  return out;
}

/** The overview paragraph for report.md, or "" when it fails. */
export async function aiReport(results: Result[], warn: (msg: string) => void, fileNames: Array<string | undefined> = []): Promise<string> {
  // Each count in its own words: a quick-screen score is never described as evidence.
  const counts = labelCounts(results.map(result => ({ candidate: { line: 0, cells: [] }, result }))).map(c => `${c.label}: ${c.count}`);
  const allNames = [...fileNames, ...results.map(r => r.person?.name)];
  const review = results.filter(r => r.check !== "none" && reviewOrder(r) <= 4).slice(0, 30).map(r => `- ${verdictLabel(r).replace(/; name differs from your file/, "")}${r.reasoning ? `: ${anonymize(r.reasoning.slice(0, 300), ...allNames, { keep: r.person?.company })}` : ""}`);
  try {
    return clean(await ask(REPORT_SYSTEM, [`${results.length} candidates checked.`, ...counts, "Candidates to review first:", ...review].join("\n")), 1200);
  } catch (err) {
    warn(`The AI overview failed (${(err as Error).message.slice(0, 160)}); report.md is written without it.`);
    return "";
  }
}
