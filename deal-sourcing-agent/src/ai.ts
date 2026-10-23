/**
 * Optional: with ANTHROPIC_API_KEY or OPENAI_API_KEY set and --ai, a model writes an "Analysis" section for each memo
 * from that memo's saved facts only. The instructions live in prompts/memo-analysis.md: edit that file to change what
 * the analysis says, no code change needed. Without a key nothing here runs and the memo is facts only.
 *
 * Plain HTTP, no SDK. The model is the newest general model the key can use, read from the provider's model list
 * (a free call), so new releases are picked up without a code change. Pin one with ANTHROPIC_MODEL or OPENAI_MODEL.
 */

import { readFileSync } from "node:fs";
import { config, promptPath } from "./config.js";
import type { Deal } from "./types.js";

export type Provider = "anthropic" | "openai";
export class AiError extends Error {}

export function aiProvider(): { provider: Provider; key: string } | undefined {
  if (config.anthropicApiKey) return { provider: "anthropic", key: config.anthropicApiKey };
  if (config.openaiApiKey) return { provider: "openai", key: config.openaiApiKey };
  return undefined;
}

const FAMILIES: { [P in Provider]: RegExp[] } = {
  anthropic: [/^claude-sonnet-/, /^claude-opus-/, /^claude-/],
  openai: [/^gpt-5(\.\d+)?(-\d{4}-\d{2}-\d{2})?$/, /^gpt-4\.1$/, /^gpt-4o$/, /^gpt-/],
};
/** Small, special-purpose and premium models are not used for a memo analysis. */
const SKIP = /(mini|nano|haiku|audio|realtime|search|transcribe|tts|image|codex|instruct|-pro\b|chat-latest|preview)/;
/** A date suffix ("-20250514", "-2025-08-07") is a snapshot of the same version, not a newer version. */
const DATE = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
const versionOf = (id: string) => (id.replace(DATE, "").match(/\d+/g) ?? []).map(Number);
/** Newest first: compares the version numbers in the ids ("claude-sonnet-4-10" after "claude-sonnet-4-9"); dates break ties. */
export function newestFirst(a: string, b: string): number {
  const va = versionOf(a), vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((va[i] ?? -1) !== (vb[i] ?? -1)) return (vb[i] ?? -1) - (va[i] ?? -1);
  return (b.match(DATE)?.[0] ?? "").localeCompare(a.match(DATE)?.[0] ?? "");
}
export function chooseModel(provider: Provider, ids: string[]): string | undefined {
  const usable = ids.filter(id => !SKIP.test(id));
  return FAMILIES[provider].map(re => usable.filter(id => re.test(id)).sort(newestFirst)[0]).find(Boolean);
}

async function call(url: string, init: RequestInit, provider: Provider): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const name = provider === "anthropic" ? "Anthropic" : "OpenAI";
  if (res.status === 401 || res.status === 403) throw new AiError(`Your ${name} key was not accepted (${res.status}). Check it in .env.`);
  if (res.status === 429) throw new AiError(`Your ${name} key hit its rate limit or has no credit left.`);
  if (!res.ok) throw new AiError(`${name} returned ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
  return json;
}

const headers = (provider: Provider, key: string): Record<string, string> => provider === "anthropic"
  ? { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }
  : { authorization: `Bearer ${key}`, "content-type": "application/json" };

let picked: string | undefined;
export async function pickModel(provider: Provider, key: string): Promise<string> {
  const pinned = provider === "anthropic" ? config.anthropicModel : config.openaiModel;
  if (pinned) return pinned;
  if (picked) return picked;
  const ids: string[] = [];
  if (provider === "anthropic") {
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await call(`https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${after}` : ""}`, { headers: headers(provider, key) }, provider);
      ids.push(...(r?.data ?? []).map((m: { id: string }) => m.id));
      if (!r?.has_more) break;
      after = r.last_id;
    }
  } else {
    const r = await call("https://api.openai.com/v1/models", { headers: headers(provider, key) }, provider);
    ids.push(...(r?.data ?? []).map((m: { id: string }) => m.id));
  }
  const model = chooseModel(provider, ids);
  if (!model) throw new AiError(`That key works, but it lists no general model to write with. Set ${provider === "anthropic" ? "ANTHROPIC_MODEL" : "OPENAI_MODEL"}.`);
  return (picked = model);
}

/** The facts the model sees: the saved deal, without any earlier analysis. */
export function factsFor(d: Deal, today: string): string {
  const { analysis, ...facts } = d;
  return JSON.stringify({ today, ...facts });
}

/** Removes dashes the copy rules do not allow, whatever the model writes. */
export const tidy = (s: string) => s.trim().replace(/\s*\u2014\s*/g, ", ").replace(/\s*\u2013\s*/g, " to ");

export async function analyse(d: Deal, today: string): Promise<{ model: string; text: string }> {
  const ai = aiProvider();
  if (!ai) throw new AiError("--ai needs ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.");
  const system = readFileSync(promptPath, "utf8");
  const model = await pickModel(ai.provider, ai.key);
  const user = `Facts as JSON:\n${factsFor(d, today)}`;
  let text = "";
  if (ai.provider === "anthropic") {
    const r = await call("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: headers(ai.provider, ai.key),
      body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
    }, ai.provider);
    text = (r?.content ?? []).map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : "")).join("");
  } else {
    const r = await call("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: headers(ai.provider, ai.key),
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    }, ai.provider);
    text = r?.choices?.[0]?.message?.content ?? "";
  }
  if (!text.trim()) throw new AiError("The model returned an empty analysis.");
  return { model, text: tidy(text) };
}
