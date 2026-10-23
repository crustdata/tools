/**
 * npm run setup: asks for each key, checks it live with free calls, and writes .env (readable by you only).
 * Keys already in .env are kept when you press Enter. Settings you added by hand are kept too.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { projectDir } from "./config.js";

const ENV = join(projectDir, ".env");

/** Lines like KEY=value, export KEY="value", KEY='value' # comment. */
const LINE = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;
function valueOf(raw: string): string {
  const quoted = /^'([^']*)'|^"([^"]*)"/.exec(raw);
  return quoted ? quoted[1] ?? quoted[2] ?? "" : raw.replace(/\s+#.*$/, "");
}

function readEnv(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(ENV)) return out;
  for (const line of readFileSync(ENV, "utf8").split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) out.set(m[1], valueOf(m[2]));
  }
  return out;
}

/**
 * Writes only the keys setup asks about. Every other line of an existing .env (your settings, comments, export
 * prefixes) stays exactly as it was. The file is readable by you only.
 */
function writeEnv(values: Map<string, string>, keys: string[]) {
  const lines = existsSync(ENV) ? readFileSync(ENV, "utf8").replace(/\n$/, "").split(/\r?\n/) : ["# Written by npm run setup. See .env.example for every setting."];
  for (const key of keys) {
    const value = values.get(key);
    if (value && /['\r\n]/.test(value)) throw new Error(`${key} contains a quote or a line break; that is not a valid key.`);
    // Every line for this key goes (Node reads the last one, so a duplicate would hide the new value), then one is added.
    const at = lines.findIndex(l => LINE.exec(l)?.[1] === key);
    const line = value ? `${key}='${value}'` : undefined;
    for (let i = lines.length - 1; i >= 0; i--) if (LINE.exec(lines[i])?.[1] === key && i !== at) lines.splice(i, 1);
    if (at >= 0) { if (line) lines[at] = line; else lines.splice(at, 1); }
    else if (line) lines.push(line);
  }
  writeFileSync(ENV, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(ENV, 0o600);
}

async function crustdata(key: string, path: string, body: unknown): Promise<number> {
  try {
    const res = await fetch(`https://api.crustdata.com${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-api-version": "2025-11-01" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return res.status;
  } catch { return 0; }
}

async function aiKeyWorks(key: string): Promise<{ ok: boolean; provider: "anthropic" | "openai" }> {
  const provider = key.startsWith("sk-ant-") ? "anthropic" : "openai";
  try {
    const res = await fetch(provider === "anthropic" ? "https://api.anthropic.com/v1/models?limit=1" : "https://api.openai.com/v1/models", {
      headers: provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    return { ok: res.ok, provider };
  } catch { return { ok: false, provider }; }
}

export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("npm run setup asks questions, so run it in a terminal. Or copy .env.example to .env and fill it in.");
  const env = readEnv();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string) => (await rl.question(q)).trim();
  const done: string[] = [];

  console.log("Deal Sourcing Agent setup. Press Enter to keep a value that is already saved.\n");

  // 1. Crustdata key (needed).
  console.log("1. Crustdata API key (needed). Get one at https://app.crustdata.com > API keys.");
  for (;;) {
    const current = env.get("CRUSTDATA_API_KEY");
    const typed = await ask(current ? "   Key [keep saved key]: " : "   Key: ");
    const key = typed || current || "";
    if (!key) { console.log("   A Crustdata key is needed to source companies."); continue; }
    const status = await crustdata(key, "/company/search/autocomplete", { field: "funding.last_round_type", query: "seed", limit: 1 });
    if (status === 200) { env.set("CRUSTDATA_API_KEY", key); done.push("✓ Crustdata key works"); break; }
    console.log(status === 401 ? "   That key was not accepted. Copy it again from app.crustdata.com." : `   Could not check the key (${status || "no answer"}). Check your connection and try again.`);
    const again = await ask("   Paste the key again, or press Enter with nothing typed to stop (nothing is saved): ");
    if (!again) { rl.close(); console.log("Stopped. Nothing was saved."); return; }
    const retry = await crustdata(again, "/company/search/autocomplete", { field: "funding.last_round_type", query: "seed", limit: 1 });
    if (retry === 200) { env.set("CRUSTDATA_API_KEY", again); done.push("✓ Crustdata key works"); break; }
    console.log("   That key was not accepted either.");
  }

  // Founders' posts are enabled per account: a free count tells us.
  const posts = await crustdata(env.get("CRUSTDATA_API_KEY")!, "/social_post/search", { filters: { field: "actor.crustdata_entity_id", type: "=", value: 1 }, limit: 0 });
  done.push(posts === 200 ? "✓ Founders' posts can be searched"
    : posts === 403 ? "· Founders' posts are not enabled on this key: that signal is skipped, everything else works. Ask Crustdata to turn on post search."
    : `· Could not check post search (${posts || "no answer"}); the first run will tell you.`);

  // 2. AI key (optional).
  console.log("\n2. Optional: an Anthropic or OpenAI key, for a written analysis in each memo with --ai. Enter to skip.");
  for (;;) {
    const current = env.get("ANTHROPIC_API_KEY") || env.get("OPENAI_API_KEY");
    const typed = await ask(current ? "   AI key [keep saved key, or type none to remove]: " : "   AI key [skip]: ");
    if (typed.toLowerCase() === "none") { env.delete("ANTHROPIC_API_KEY"); env.delete("OPENAI_API_KEY"); done.push("· No AI key: memos are facts only"); break; }
    const key = typed || current || "";
    if (!key) { done.push("· No AI key: memos are facts only (that is the default)"); break; }
    const { ok, provider } = await aiKeyWorks(key);
    if (ok) {
      env.delete("ANTHROPIC_API_KEY"); env.delete("OPENAI_API_KEY");
      env.set(provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY", key);
      done.push(`✓ ${provider === "anthropic" ? "Anthropic" : "OpenAI"} key works: add --ai to a run for the analysis`);
      break;
    }
    console.log("   That key was not accepted. Paste it again, or press Enter with nothing typed to skip.");
    if (!typed) {
      if (current) { env.delete("ANTHROPIC_API_KEY"); env.delete("OPENAI_API_KEY"); done.push("· AI key removed (the saved key was not accepted)"); }
      else done.push("· AI key skipped");
      break;
    }
  }
  rl.close();

  writeEnv(env, ["CRUSTDATA_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  console.log(`\nSaved ${ENV} (readable by you only).\n`);
  for (const line of done) console.log("  " + line);
  console.log('\nNext: npm run source -- --thesis "AI infrastructure, pre-seed or seed, US, founded 2024 or later"');
}
