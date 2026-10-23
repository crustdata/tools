/**
 * Configuration. Every setting comes from environment variables, read from `.env` in the project folder when that
 * file exists (variables already set in the shell win). See `.env.example` for the full list with comments.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The project folder, so `.env` and `out/` are found whatever directory the tool is started from. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(ROOT, ".env");
// Tests never read a developer's .env, so they behave the same everywhere.
if (existsSync(envFile) && !process.env.NODE_TEST_CONTEXT && !process.env.CSA_NO_DOTENV) process.loadEnvFile(envFile);

const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;
const off = (v: string) => ["false", "0", "no", "off"].includes(v.toLowerCase());

export const config = {
  /** Crustdata API key. Needed by `source`, `contacts` and `setup`; `rescore`, `watch-example` and `replay` run without it. */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and fill it in.");
    return key;
  },

  /** Where each role's files go: out/<role name>/candidates.csv, shortlist.md, role.json, seen.csv. */
  get outDir(): string {
    const dir = env("OUT_DIR", "out");
    return isAbsolute(dir) ? dir : resolve(ROOT, dir);
  },

  /** The one line at the end of every run about keeping the search going with a Crustdata watcher. */
  get watchHint(): boolean { return !off(env("WATCH_HINT", "true")); },

  /** Optional, off unless you pass --ai: one "why this candidate" sentence per shortlisted person. */
  get anthropicApiKey(): string { return env("ANTHROPIC_API_KEY"); },
  get anthropicModel(): string { return env("ANTHROPIC_MODEL", "claude-opus-5-5"); },
  get openaiApiKey(): string { return env("OPENAI_API_KEY"); },
  get openaiModel(): string { return env("OPENAI_MODEL"); },
};
