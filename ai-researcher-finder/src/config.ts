/**
 * Configuration. Every setting comes from environment variables, read from `.env` in the project folder when that
 * file exists (variables already set in the shell win). See `.env.example` for the full list with comments.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The project folder, so `.env`, `rubric.json` and `out/` are found whatever directory the tool is started from. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(ROOT, ".env");
// Tests and the offline replay never read a developer's .env, so they behave the same everywhere.
if (existsSync(envFile) && !process.env.NODE_TEST_CONTEXT && !process.env.ARF_NO_DOTENV) process.loadEnvFile(envFile);

const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

export const config = {
  /** Crustdata API key. Needed by `find`, `map` and `setup`; `rescore`, `watch-example` and `replay` run without it. */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and fill it in.");
    return key;
  },

  /** Where each search's files go: out/<name>/researchers.csv, report.md, people.json, run.json. */
  get outDir(): string {
    const dir = env("OUT_DIR", "out");
    return isAbsolute(dir) ? dir : resolve(ROOT, dir);
  },

  /** A run whose worst case is above this many credits stops and asks for --max-credits. */
  get maxCredits(): number {
    const n = Number(env("MAX_CREDITS", "100"));
    return Number.isFinite(n) && n > 0 ? n : 100;
  },

  /** Optional, used only with --ai: Claude answers the rubric's "ask" lines from each person's evidence. */
  get anthropicApiKey(): string { return env("ANTHROPIC_API_KEY"); },
  get anthropicModel(): string { return env("ANTHROPIC_MODEL", "claude-opus-5-5"); },
};
