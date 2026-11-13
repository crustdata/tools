/**
 * Configuration. Every setting comes from environment variables, read from `.env` in the project folder when that
 * file exists (variables already set in the shell win). See `.env.example` for the full list with comments.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The project folder, so `.env`, `prompts/` and `out/` are found whatever directory the tool is started from. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(ROOT, ".env");
// Tests and the offline replay never read a developer's .env, so they behave the same everywhere.
if (existsSync(envFile) && !process.env.NODE_TEST_CONTEXT && !process.env.PCRA_NO_DOTENV) process.loadEnvFile(envFile);

const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

/** A whole number setting, with a fallback when it is missing. "2.5", "0x10" and "1e2" are refused, not guessed. */
function int(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name}=${raw} is not a whole number from ${min} to ${max}. Fix it in .env or your shell.`);
  }
  return n;
}

export const config = {
  /** Crustdata API key. Needed by `research` and `setup`; `replay` runs without it. */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and fill it in.");
    return key;
  },

  /** Where memos go: out/<domain>/memo.md and memo.json; a list adds out/<list name>/comparison.md and .csv. */
  get outDir(): string {
    const dir = env("OUT_DIR", "out");
    return isAbsolute(dir) ? dir : resolve(ROOT, dir);
  },

  /** Former staff read per company (0.23 credits each at list price). 0 skips the departures section. */
  get leaversLimit(): number { return int("LEAVERS_LIMIT", 25, 0, 200); },

  /** Peers compared per company (0.63 credits each at list price). 0 skips peers. */
  get peersLimit(): number { return int("PEERS_LIMIT", 5, 0, 20); },

  /** A run whose estimate (at list price) is above this needs --yes. 0 turns the check off. */
  get maxCreditsPerRun(): number { return int("MAX_CREDITS_PER_RUN", 150); },

  /** Days a saved API answer is reused before it is paid for again. 0 turns the cache off. */
  get cacheDays(): number { return int("CACHE_DAYS", 7, 0, 365); },

  /**
   * "all" (default): memos name every former employee found. "leaders": memos name founders, executives and leaders
   * only, and show everyone else as a role and a month without a name or profile link.
   */
  get peopleDetail(): "all" | "leaders" {
    const v = env("PEOPLE_DETAIL", "all").toLowerCase();
    if (v !== "all" && v !== "leaders") throw new Error(`PEOPLE_DETAIL=${v} must be "all" or "leaders". Fix it in .env or your shell.`);
    return v;
  },

  /** Optional, for --ai only: a short analyst note written by a model from the memo's facts. */
  get anthropicApiKey(): string { return env("ANTHROPIC_API_KEY"); },
  get openaiApiKey(): string { return env("OPENAI_API_KEY"); },
  get anthropicModel(): string { return env("ANTHROPIC_MODEL"); },
  get openaiModel(): string { return env("OPENAI_MODEL"); },
};

/** The instructions the optional AI note follows. Edit the file to change what it writes. */
export const promptPath = resolve(ROOT, "prompts", "analyst-note.md");
