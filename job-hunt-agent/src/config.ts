/**
 * Configuration. Every setting comes from environment variables, read from `.env` in the project folder when that
 * file exists (variables already set in the shell win). See `.env.example` for the full list with comments.
 * Your search (titles, place, school) lives in `profile.json`, written by `npm run setup`; flags override it.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The project folder, so `.env`, `profile.json`, `out/` and `data/` are found from any working directory. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(ROOT, ".env");
// Tests and the offline replay never read a developer's .env, so they behave the same everywhere.
if (existsSync(envFile) && !process.env.NODE_TEST_CONTEXT && !process.env.JHA_NO_DOTENV) process.loadEnvFile(envFile);

const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;
const num = (name: string, fallback: number, min = 0): number => {
  const n = Number(env(name, String(fallback)));
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const inRoot = (p: string): string => (p === ":memory:" || isAbsolute(p) ? p : resolve(ROOT, p));

export const config = {
  /** Crustdata API key. Needed by `hunt`, `job` and `setup`; `replay` and `dashboard` run without it. */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and fill it in.");
    return key;
  },

  /** Your search: titles, place, school, CV path. Written by setup; plain JSON you can edit. */
  get profilePath(): string { return inRoot(env("PROFILE_PATH", "profile.json")); },

  /** Where each run is written: out/<date>-<search>/report.md, jobs.json, jobs.csv, jobs/<job>.md. */
  get outDir(): string { return inRoot(env("OUT_DIR", "out")); },

  /** The local database: cached answers, jobs seen before, your status per job. ":memory:" keeps nothing. */
  get dbPath(): string { return inRoot(env("DB_PATH", "data/job-hunt.db")); },

  /** Days a company's trend and people are reused before they are paid for again. 0 turns the cache off. */
  get cacheDays(): number { return num("CACHE_DAYS", 14); },

  /** A run whose worst case is above this needs --yes. 0 turns the check off. */
  get maxCreditsPerRun(): number { return num("MAX_CREDITS_PER_RUN", 30); },

  /** Port of the local dashboard (npm run dashboard). It listens on 127.0.0.1 only. */
  get dashboardPort(): number { return num("DASHBOARD_PORT", 3480, 1); },
};
