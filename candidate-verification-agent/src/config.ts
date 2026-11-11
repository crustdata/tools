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
// Read on first use, not at import, so tests and the offline replay can turn it off before anything is read:
// they never read a developer's .env, so they behave the same everywhere.
let loaded = false;
function loadDotenv(): void {
  if (loaded) return;
  loaded = true;
  if (existsSync(envFile) && !process.env.NODE_TEST_CONTEXT && !process.env.CVA_NO_DOTENV) process.loadEnvFile(envFile);
}

const env = (name: string, fallback = ""): string => { loadDotenv(); return process.env[name]?.trim() || fallback; };

function positive(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of 0 or more (it is "${raw}"). Fix it in .env.`);
  return n;
}

export const config = {
  /** Crustdata API key. Needed by `verify` and `setup`; `replay` runs without it. */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and fill it in.");
    return key;
  },

  /** Where each list's files go: out/<list name>/verified.csv, report.md, unresolved.csv, results.json. */
  get outDir(): string {
    const dir = env("OUT_DIR", "out");
    return isAbsolute(dir) ? dir : resolve(ROOT, dir);
  },

  /** A verdict younger than this many days is reused for free when the same person is on another list. 0 = never. */
  get reuseDays(): number { return positive("REUSE_VERDICTS_DAYS", 30); },

  /** A run that would spend more than this many credits asks first (and needs --yes without a terminal). */
  get confirmAbove(): number { return positive("CONFIRM_ABOVE_CREDITS", 50); },

  /** A run that may spend more than this stops, even with --yes (for scheduled runs). Empty or 0 = no limit. */
  get maxCredits(): number { return positive("MAX_CREDITS_PER_RUN", 0); },

  /** What the Slack summary shows: "names" (candidates to review, with names and reasons) or "counts" (numbers only). */
  get slackDetail(): "names" | "counts" { return env("SLACK_DETAIL", "names").toLowerCase() === "counts" ? "counts" : "names"; },

  /** Optional: a Slack incoming webhook. When set, every run posts a summary with the candidates to review first or clarify in the screen. */
  get slackWebhookUrl(): string { return env("SLACK_WEBHOOK_URL"); },

  /** Optional, used only with --ai: a one-line summary per candidate and a short report for the list. */
  get anthropicApiKey(): string { return env("ANTHROPIC_API_KEY"); },
  get anthropicModel(): string { return env("ANTHROPIC_MODEL", "claude-opus-5-5"); },
};
