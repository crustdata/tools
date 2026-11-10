/**
 * Configuration. Every setting comes from environment variables, read from `.env` in the project folder when that
 * file exists (variables already set in the shell win). See `.env.example` for the full list with comments.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The project folder, so `.env`, the portfolio file, `data/` and `digests/` are found from any working directory. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(ROOT, ".env");
// Tests never read a developer's .env, so they behave the same everywhere. VPM_NO_DOTENV=1 skips it on purpose.
if (existsSync(envFile) && !process.env.NODE_TEST_CONTEXT && !process.env.VPM_NO_DOTENV) process.loadEnvFile(envFile);

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

function json<T>(name: string, fallback: T): T {
  const raw = env(name);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch {
    problems.push(`${name} must be JSON, for example {"Sam Lee": "https://hooks.slack.com/services/..."} (got "${raw.slice(0, 40)}").`);
    return fallback;
  }
}

const path = (name: string, fallback: string): string => {
  const p = env(name, fallback);
  return p === ":memory:" || isAbsolute(p) ? p : resolve(ROOT, p);
};

/** The person watch's freshness tiers (days), each with its price per changed person. */
export const REFRESH_TIERS: Record<number, number> = { 30: 5, 14: 10, 7: 20, 3: 50, 1: 150 };

/** Owners match however the portfolio spells them: case, extra spaces. */
export const ownerKey = (owner: string): string => owner.trim().replace(/\s+/g, " ").toLowerCase();

export const SLACK_URL = /^https:\/\/hooks\.slack\.com\/services\/\S+$/;

export const config = {
  /** Crustdata API key. Get one at https://app.crustdata.com */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and fill it in.");
    return key;
  },

  /** Where the portfolio comes from: a CSV file path, or a Google Sheet link shared as "Anyone with the link". */
  portfolio: env("PORTFOLIO", "./portfolio.csv"),
  /** The fund's name, used in message titles. */
  fundName: env("FUND_NAME", "Portfolio"),
  dbPath: path("DB_PATH", "./data/monitor.sqlite"),
  digestDir: path("DIGEST_DIR", "./digests"),
  thresholdsFile: path("THRESHOLDS_FILE", "./config/thresholds.json"),

  /** Main Slack channel: every alert without an owner route, and the weekly digest. */
  slackWebhookUrl: env("SLACK_WEBHOOK_URL"),
  /** Optional: send a company's alerts to its owner's channel. JSON: { "owner from the portfolio": "https://hooks.slack.com/..." } */
  slackRoutes: ownerMap(json<Record<string, string>>("SLACK_ROUTES", {})),
  /** Owner names as SLACK_ROUTES spells them, for messages. */
  slackRouteNames: Object.fromEntries(Object.keys(json<Record<string, string>>("SLACK_ROUTES", {}) ?? {}).map(o => [ownerKey(o), o.trim()])),
  resendApiKey: env("RESEND_API_KEY"),
  digestEmailFrom: env("DIGEST_EMAIL_FROM"),
  digestEmailTo: env("DIGEST_EMAIL_TO").split(",").map(s => s.trim()).filter(Boolean),

  /** Leaders watched per company (founders first, then the CEO and other C-level). */
  maxLeadersPerCompany: int("MAX_LEADERS_PER_COMPANY", 8, 1, 25),
  /** How fresh leader profiles are kept: 30, 14, 7, 3 or 1 days (5, 10, 20, 50 or 150 credits per changed person). */
  leaderRefreshDays: int("LEADER_REFRESH_DAYS", 30, 1, 30),
  /** Days between careers page readings (1 credit per company per reading). 3 to 28 keeps the 4-week comparison working. */
  hiringCheckDays: int("HIRING_CHECK_DAYS", 7, 3, 28),
  /** Most credits an import may spend without a person confirming (`import -- --yes` on a schedule). */
  maxImportCredits: int("MAX_IMPORT_CREDITS", 500, 0, 1_000_000),
};

function ownerMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) { problems.push("SLACK_ROUTES must be a JSON object of owner to webhook URL."); return out; }
  for (const [owner, url] of Object.entries(map)) {
    if (typeof url !== "string" || !SLACK_URL.test(url)) { problems.push(`SLACK_ROUTES entry for "${owner}" must be a Slack incoming webhook URL starting with https://hooks.slack.com/services/`); continue; }
    out[ownerKey(owner)] = url;
  }
  return out;
}


/** Price per changed person at a freshness setting (a value between tiers bills at the fresher tier). */
export function leaderPrice(days = config.leaderRefreshDays): number {
  const tier = Object.keys(REFRESH_TIERS).map(Number).sort((a, b) => b - a).find(t => days >= t) ?? 1;
  return REFRESH_TIERS[tier];
}

/** True when a Crustdata key is set (commands that call Crustdata check this first). */
export const hasKey = (): boolean => Boolean(env("CRUSTDATA_API_KEY"));

/** Settings that are missing or invalid. Entry points print these and stop. */
export function configProblems({ needKey = true } = {}): string[] {
  const list = [...problems];
  if (needKey && !hasKey()) list.push("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and paste your key from https://app.crustdata.com (on GitHub Actions, add it as a repository secret).");
  const resend = [config.resendApiKey, config.digestEmailFrom, config.digestEmailTo.length ? "x" : ""];
  if (resend.some(Boolean) && !resend.every(Boolean)) list.push("Email needs all three of RESEND_API_KEY, DIGEST_EMAIL_FROM and DIGEST_EMAIL_TO.");
  if (config.slackWebhookUrl && !SLACK_URL.test(config.slackWebhookUrl)) list.push("SLACK_WEBHOOK_URL must be a Slack incoming webhook URL starting with https://hooks.slack.com/services/");
  if (Object.keys(config.slackRoutes).length && !config.slackWebhookUrl) list.push("SLACK_ROUTES needs SLACK_WEBHOOK_URL too: companies without an owner route, and the weekly digest, go there.");
  return list;
}

export const hasSlack = (): boolean => Boolean(config.slackWebhookUrl);
export const hasEmail = (): boolean => Boolean(config.resendApiKey && config.digestEmailFrom && config.digestEmailTo.length);
