/**
 * Optional, off by default: with --ai and ANTHROPIC_API_KEY set, Claude answers the rubric's "ask" lines for each
 * person, from the same evidence the rules read. The answer is yes (full points), partly (half), no, or unclear
 * (no data), with the fact it rests on.
 *
 * What is sent to Anthropic: the person's titles, employers, role descriptions, headline, paper titles, research
 * interests, citation numbers and skills. Not sent: their name, profile URL, Scholar URL, location or anything about
 * your search other than the questions. Without --ai nothing goes to Anthropic.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Person } from "./crustdata.js";
import { citations, clip, currentRoles, hIndex, interestsOf, papersOf, pastRoles, skillsOf, span, yearsWorked } from "./profile.js";
import type { Ask, Outcome } from "./rubric.js";

/** The facts Claude may use, as plain lines. No name, no URLs. */
export function factsFor(p: Person): string {
  const role = (r: { title?: string | null; name?: string | null; description?: string | null } & Parameters<typeof span>[0]) =>
    [r.title, r.name && `at ${r.name}`, span(r) && `(${span(r)})`, r.description && `: ${clip(r.description, 300)}`].filter(Boolean).join(" ");
  const papers = papersOf(p).slice(0, 15).map(x => `${x.title}${x.year ? ` (${x.year})` : ""}`);
  return [
    p.basic_profile?.headline && `Headline: ${clip(p.basic_profile.headline, 200)}`,
    ...currentRoles(p).slice(0, 3).map(r => `Current role: ${role(r)}`),
    ...pastRoles(p).slice(0, 6).map(r => `Past role: ${role(r)}`),
    yearsWorked(p) !== undefined && `Years worked: ${yearsWorked(p)}`,
    papers.length && `Papers (newest first): ${papers.join("; ")}`,
    interestsOf(p).length && `Research interests: ${interestsOf(p).join(", ")}`,
    hIndex(p) !== undefined && `h-index: ${hIndex(p)}`,
    citations(p) !== undefined && `Citations: ${citations(p)}`,
    skillsOf(p).length && `Skills: ${skillsOf(p).slice(0, 25).join(", ")}`,
  ].filter(Boolean).join("\n");
}

const SYSTEM = `You help a recruiter at an AI lab read a researcher's public record. For each question, answer only from the facts given.
"yes" when the facts clearly show it, "partly" when they show some of it, "no" when they show the opposite, "unclear" when the facts do not say.
For "evidence", quote or closely paraphrase the one fact your answer rests on (under 25 words), or leave it empty for "unclear". Never guess.`;

const SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: { answer: { type: "string", enum: ["yes", "partly", "no", "unclear"] }, evidence: { type: "string" } },
        required: ["answer", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["answers"],
  additionalProperties: false,
} as const;

export const aiAvailable = (): boolean => !!config.anthropicApiKey;

type Answer = { answer: string; evidence: string };
export type AiCache = Record<string, Answer[]>;

/** The cache key: the person, the exact facts sent, and the questions. Change any of them and Claude is asked again. */
export function cacheKey(p: Person, asks: Ask[]): string {
  const text = `${p.crustdata_person_id}\n${factsFor(p)}\n${asks.map(a => a.question).join("\n")}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${p.crustdata_person_id}:${h.toString(36)}`;
}

/**
 * One Claude call per person (four at a time), every question at once. Answers are kept in `cache` (saved in the
 * search folder as ai.json), so a rescore asks only about people or questions that changed. A rejected key (401, 403)
 * stops every call at once; refusals and failures are counted and reported once, and score those lines as unclear.
 */
export async function askAll(people: Person[], asks: Ask[], warn: (msg: string) => void, cache: AiCache = {}): Promise<Map<number, Outcome[]>> {
  const out = new Map<number, Outcome[]>();
  if (!asks.length || !aiAvailable()) return out;
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const questions = asks.map((a, i) => `${i + 1}. ${a.question}`).join("\n");
  let stopped = "", refused = 0, failed = 0, firstError = "";
  const ask = async (p: Person): Promise<Answer[] | undefined> => {
    const key = cacheKey(p, asks);
    if (cache[key]) return cache[key];
    if (stopped) return undefined;
    try {
      const response = await client.beta.messages.create({
        model: config.anthropicModel,
        max_tokens: 4000,
        system: SYSTEM,
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        // If the model declines, Anthropic reruns the request on a recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: `Facts:\n${factsFor(p)}\n\nQuestions (answer in this order):\n${questions}` }],
      });
      if (response.stop_reason === "refusal") { refused++; return undefined; }
      const text = response.content.map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : "")).join("");
      const answers = (JSON.parse(text).answers ?? []) as Answer[];
      cache[key] = answers;
      return answers;
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) stopped = (err as Error).message.slice(0, 160);
      else { failed++; firstError ||= (err as Error).message.slice(0, 160); }
      return undefined;
    }
  };
  for (let i = 0; i < people.length; i += 4) {
    const batch = people.slice(i, i + 4);
    const answers = await Promise.all(batch.map(ask));
    // Someone Claude did not answer for (a failure, a refusal, a rejected key) is scored as without --ai: the
    // questions are left out of their total, and the report says why.
    batch.forEach((p, j) => answers[j] && out.set(p.crustdata_person_id, asks.map((a, k) => {
      const ans = answers[j]?.[k];
      const share = ans?.answer === "yes" ? 1 : ans?.answer === "partly" ? 0.5 : 0;
      const evidence = ans?.evidence ? `Claude: ${ans.answer}, ${clip(ans.evidence.replace(/\s*[\u2013\u2014]\s*/g, ", "), 160)}` : undefined;
      return { rule: a.question, points: a.points, earned: a.points * share, evidence, noData: !ans || ans.answer === "unclear" };
    })));
  }
  if (stopped) warn(`Anthropic rejected the key (${stopped}); no more questions were sent, and the rubric questions are left out of the score for those not answered. Check ANTHROPIC_API_KEY in .env.`);
  if (refused) warn(`Claude declined to answer for ${refused} ${refused === 1 ? "person" : "people"}; the rubric questions are left out of their score.`);
  if (failed) warn(`Claude could not answer for ${failed} ${failed === 1 ? "person" : "people"} (${firstError}); the rubric questions are left out of their score.`);
  return out;
}
