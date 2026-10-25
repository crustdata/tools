/**
 * Configuration. Every setting comes from environment variables, read from `.env` in the project folder when that
 * file exists (variables already set in the shell win). See `.env.example` for the full list with comments.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The project folder, so `.env`, `config/` and `out/` are found whatever directory the tool is started from. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(ROOT, ".env");
// Tests and the offline replay never read a developer's .env, so they behave the same everywhere.
if (existsSync(envFile) && !process.env.NODE_TEST_CONTEXT && !process.env.PR_NO_DOTENV) process.loadEnvFile(envFile);

const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

export const config = {
  /** Crustdata API key. Needed by `research` and `setup`; `replay` runs without it. */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and fill it in.");
    return key;
  },

  /** Where briefs go: out/<name>.md, out/<name>.json, out/index.md. */
  get outDir(): string {
    const dir = env("OUT_DIR", "out");
    return isAbsolute(dir) ? dir : resolve(ROOT, dir);
  },

  /** Your own company's domains: attendees there are skipped (comma-separated, e.g. "acme.com,acme.io"). */
  get skipDomains(): string[] { return env("SKIP_DOMAINS").split(/[,\s]+/).filter(Boolean); },

  /** A run whose estimate is above this needs --yes (protects scheduled runs from a huge file). 0 turns it off. */
  get maxCreditsPerRun(): number {
    const n = Number(env("MAX_CREDITS_PER_RUN", "150"));
    return Number.isFinite(n) && n >= 0 ? n : 150;
  },

  /** Hours a saved API answer is reused before it is paid for again. 0 turns the cache off. */
  get cacheHours(): number {
    const n = Number(env("CACHE_HOURS", "24"));
    return Number.isFinite(n) && n >= 0 ? n : 24;
  },
};
