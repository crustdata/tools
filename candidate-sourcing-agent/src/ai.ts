/**
 * Optional, off by default: with --ai and ANTHROPIC_API_KEY (or OPENAI_API_KEY and OPENAI_MODEL) set, each
 * shortlisted candidate gets one "why this candidate" sentence, written only from the facts in their record and the
 * role. The score never depends on it; without a key the column stays empty and nothing else changes.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Person } from "./crustdata.js";
import { locationOf, pastRoles, primaryRole, schoolsOf, skillsOf } from "./profile.js";
import type { RoleSpec } from "./role.js";
import type { Scored } from "./score.js";

const SYSTEM = "You write one sentence, at most 30 words, saying why a candidate fits a role, for a recruiter. Use only the facts given. Name nothing that is not in them: no company, school, skill, number or claim that is not written there. Plain words, no dashes, no hype, no greeting. If the facts show a gap, you may name it.";

/**
 * The facts the sentence may use, as plain lines. Nothing else about the person is sent: no name and no profile URL
 * (a name adds nothing to why someone fits, and could lead a model to guess at gender or origin).
 */
export function factsFor(spec: RoleSpec, p: Person, s: Scored): string {
  const role = primaryRole(p);
  const past = pastRoles(p).slice(0, 4).map(r => [r.title, r.name && `at ${r.name}`].filter(Boolean).join(" ")).filter(Boolean);
  return [
    `Role: ${spec.query ?? spec.role}`,
    role && `Current: ${[role.title, role.name && `at ${role.name}`].filter(Boolean).join(" ")}`,
    locationOf(p) && `Location: ${locationOf(p)}`,
    s.years !== undefined && `Years worked: ${Math.floor(s.years)}`,
    past.length && `Before: ${past.join("; ")}`,
    skillsOf(p).length && `Listed skills: ${skillsOf(p).slice(0, 25).join(", ")}`,
    schoolsOf(p).length && `Schools: ${schoolsOf(p).slice(0, 3).join("; ")}`,
    `Scoring notes: ${s.reasons.join("; ")}`,
  ].filter(Boolean).join("\n");
}

export const aiAvailable = (): "anthropic" | "openai" | undefined =>
  config.anthropicApiKey ? "anthropic" : config.openaiApiKey && config.openaiModel ? "openai" : undefined;

/** A sentence that names a dash or runs long is cut back to plain text; an empty answer is dropped. */
const clean = (s: string) => s.replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, 300);

async function anthropicSentence(facts: string): Promise<string> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.beta.messages.create({
    model: config.anthropicModel,
    max_tokens: 2000,
    output_config: { effort: "low" },
    // Server-side fallback: if the model declines, Anthropic reruns the request on a recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: facts }],
  });
  if (response.stop_reason === "refusal") return "";
  return response.content.map(b => (b.type === "text" ? b.text : "")).join(" ");
}

async function openaiSentence(facts: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${config.openaiApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: config.openaiModel, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: facts }] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OpenAI returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

/** One sentence per candidate, in order. A failure leaves that sentence empty and is reported once. */
export async function whySentences(items: Array<{ facts: string }>, warn: (msg: string) => void): Promise<string[]> {
  const provider = aiAvailable();
  if (!provider) return items.map(() => "");
  const out: string[] = [];
  let warned = false;
  for (const item of items) {
    try {
      out.push(clean(provider === "anthropic" ? await anthropicSentence(item.facts) : await openaiSentence(item.facts)));
    } catch (err) {
      if (!warned) warn(`The AI sentence failed (${(err as Error).message.slice(0, 160)}); the shortlist is written without it.`);
      warned = true;
      out.push("");
    }
  }
  return out;
}
