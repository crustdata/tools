/**
 * Configuration. Every setting comes from environment variables, read from `.env` in the project folder when that
 * file exists (variables already set in the shell win). See `.env.example` for the full list with comments.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The project folder, so `.env`, `competitors.json`, `data/` and `digests/` are found from any working directory. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(ROOT, ".env");
// Tests never read a developer's .env, so they behave the same everywhere. CT_NO_DOTENV=1 skips it on purpose.
if (existsSync(envFile) && !process.env.NODE_TEST_CONTEXT && !process.env.CT_NO_DOTENV) process.loadEnvFile(envFile);

const problems: string[] = [];
const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}").`);
    return fallback;
  }
  return n;
}

const path = (name: string, fallback: string): string => {
  const p = env(name, fallback);
  return p === ":memory:" || isAbsolute(p) ? p : resolve(ROOT, p);
};

export const config = {
  /** Crustdata API key. Get one at https://app.crustdata.com */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and fill it in.");
    return key;
  },

  competitorsFile: path("COMPETITORS_FILE", "./competitors.json"),
  dbPath: path("DB_PATH", "./data/tracker.sqlite"),
  digestDir: path("DIGEST_DIR", "./digests"),

  /** Slack incoming webhook. Without it, the digest is printed and written to a file only. */
  slackWebhookUrl: env("SLACK_WEBHOOK_URL"),
  resendApiKey: env("RESEND_API_KEY"),
  digestEmailFrom: env("DIGEST_EMAIL_FROM"),
  digestEmailTo: env("DIGEST_EMAIL_TO").split(",").map(s => s.trim()).filter(Boolean),

  /** Pages fetched per competitor per week, 1 credit each. */
  pagesPerCompetitor: int("PAGES_PER_COMPETITOR", 6, 1, 10),
  /** Weekly caps on what the job and post watchers deliver, spread over their daily runs (overflow arrives later). */
  maxPostsPerWeek: int("MAX_POSTS_PER_WEEK", 200, 1, 1000),
  maxJobsPerWeek: int("MAX_JOBS_PER_WEEK", 500, 1, 1000),
  /** Show the names of competitors' staff next to their posts (titles only by default). */
  showPosterNames: /^(1|true|yes)$/i.test(env("SHOW_POSTER_NAMES")),
};

/** True when a Crustdata key is set (commands that call Crustdata check this first). */
export const hasKey = (): boolean => Boolean(env("CRUSTDATA_API_KEY"));

/** Settings that are missing or invalid. Entry points print these and stop. */
export function configProblems({ needKey = true } = {}): string[] {
  const list = [...problems];
  if (needKey && !hasKey()) list.push("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and paste your key from https://app.crustdata.com (on GitHub Actions, add it as a repository secret).");
  const resend = [config.resendApiKey, config.digestEmailFrom, config.digestEmailTo.length ? "x" : ""];
  if (resend.some(Boolean) && !resend.every(Boolean)) list.push("Email needs all three of RESEND_API_KEY, DIGEST_EMAIL_FROM and DIGEST_EMAIL_TO.");
  if (config.slackWebhookUrl && !/^https:\/\/hooks\.slack\.com\/services\/\S+$/.test(config.slackWebhookUrl)) {
    list.push("SLACK_WEBHOOK_URL must be a Slack incoming webhook URL starting with https://hooks.slack.com/services/");
  }
  return list;
}

export const hasSlack = (): boolean => Boolean(config.slackWebhookUrl);
export const hasEmail = (): boolean => Boolean(config.resendApiKey && config.digestEmailFrom && config.digestEmailTo.length);
