// Optional: a visitor brings their own AI key (Anthropic or OpenAI) and the model writes the brief from the
// Crustdata data on the page, and nothing else. Without a key the brief is the template in lib/brief.ts.
// The key arrives per request in the x-ai-key header; it is never stored or logged.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AiBrief, Company, Hiring, People } from "./types";

export type Provider = "anthropic" | "openai";

export class AiKeyError extends Error {}

export function providerFor(key: string): Provider {
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-")) return "openai";
  throw new AiKeyError("That does not look like an Anthropic key (sk-ant-...) or an OpenAI key (sk-...).");
}

// Which model writes the brief: the newest model of the first family the key can use, read from the provider's model
// list (a free call), so new releases are picked up without a code change. Sonnet first for Anthropic and the main
// GPT line first for OpenAI, because a brief is a short job. Override with ANTHROPIC_MODEL or OPENAI_MODEL.
const FAMILIES: Record<Provider, RegExp[]> = {
  anthropic: [/^claude-sonnet-/, /^claude-opus-/, /^claude-/],
  openai: [/^gpt-5(\.\d+)?(-\d{4}-\d{2}-\d{2})?$/, /^gpt-4\.1$/, /^gpt-4o$/, /^gpt-(4|5)/],
};
// Compare model ids by their version numbers ("claude-sonnet-4-10" after "claude-sonnet-4-9", "gpt-5.10" after "gpt-5.9").
const versionOf = (id: string) => (id.match(/\d+/g) ?? []).map(Number);
function newer(a: string, b: string) {
  const va = versionOf(a), vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((va[i] ?? -1) !== (vb[i] ?? -1)) return (vb[i] ?? -1) - (va[i] ?? -1);
  return 0;
}
const SKIP = /(mini|nano|haiku|audio|realtime|search|transcribe|tts|image|codex|instruct)/;
const modelCache = new Map<string, string>();
const hash = (k: string) => createHash("sha256").update(k).digest("hex").slice(0, 16);

export async function pickModel(key: string): Promise<{ provider: Provider; model: string }> {
  const provider = providerFor(key);
  const override = provider === "anthropic" ? process.env.ANTHROPIC_MODEL : process.env.OPENAI_MODEL;
  if (override) return { provider, model: override };
  const cachedModel = modelCache.get(hash(key));
  if (cachedModel) return { provider, model: cachedModel };
  try {
    const ids: string[] = [];
    if (provider === "anthropic") {
      for await (const m of new Anthropic({ apiKey: key }).models.list()) ids.push(m.id);
    } else {
      for await (const m of new OpenAI({ apiKey: key }).models.list()) ids.push(m.id);
    }
    const usable = ids.filter(id => !SKIP.test(id));
    const model = FAMILIES[provider].map(re => usable.filter(id => re.test(id)).sort(newer)[0]).find(Boolean);
    if (!model) throw new AiKeyError("That key works, but it has no model that can write the brief.");
    modelCache.set(hash(key), model);
    return { provider, model };
  } catch (err) {
    if (err instanceof AiKeyError) throw err;
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) throw new AiKeyError(`That ${provider === "anthropic" ? "Anthropic" : "OpenAI"} key was not accepted.`);
    throw err;
  }
}

const SYSTEM = [
  "You write a short research brief about a company for someone about to meet them.",
  "Use only the facts in the JSON you are given. Do not add anything from memory.",
  "Say plainly when something the reader would want is missing.",
  "Write in this structure, in markdown:",
  "A paragraph of 2 to 4 sentences on what the company is and how big it is.",
  "**What changed lately** followed by 3 to 6 bullet points, each with a number and its period.",
  "**Three questions to ask** followed by a numbered list of 3 questions, each tied to one of those changes.",
  "No em dashes or en dashes; use commas, colons or full stops. Never use the words honestly, noise or stale.",
  "Under 220 words.",
].join("\n");

export async function aiBrief(key: string, facts: { company: Company; people: People; hiring: Hiring | null }): Promise<AiBrief> {
  const { provider, model } = await pickModel(key);
  const slim = {
    company: { ...facts.company, logoUrl: undefined, headcount: facts.company.headcount && { ...facts.company.headcount, monthly: undefined, departmentsMonthly: undefined } },
    people: facts.people,
    hiring: facts.hiring,
    today: new Date().toISOString().slice(0, 10),
  };
  const prompt = `Facts as JSON:\n${JSON.stringify(slim)}`;
  let text = "";
  try {
    if (provider === "anthropic") {
      const msg = await new Anthropic({ apiKey: key }).messages.create({
        model, max_tokens: 1500, system: SYSTEM, messages: [{ role: "user", content: prompt }],
      });
      text = msg.content.map(b => (b.type === "text" ? b.text : "")).join("");
    } else {
      const res = await new OpenAI({ apiKey: key }).chat.completions.create({
        model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      });
      text = res.choices[0]?.message?.content ?? "";
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) throw new AiKeyError("Your AI key was not accepted.");
    if (status === 429) throw new AiKeyError("Your AI key hit its rate limit or has no credit left.");
    throw err;
  }
  text = text.trim().replace(/\s*\u2014\s*/g, ", ").replace(/\u2013/g, "-");
  if (!text) throw new Error("The model returned an empty brief.");
  return { provider, model, text };
}
