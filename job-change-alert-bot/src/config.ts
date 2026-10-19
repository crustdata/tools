/**
 * Configuration. Every setting comes from environment variables, read from `.env` in the project folder when that
 * file exists (variables already set in the shell win). See `.env.example` for the full list with comments.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALERT_KINDS, type ChangeKind } from "./notification.js";

/** The project folder, so `.env` and `data/` are found whatever directory the bot is started from. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(ROOT, ".env");
// Tests never read a developer's .env, so they behave the same everywhere.
if (existsSync(envFile) && !process.env.NODE_TEST_CONTEXT && !process.env.JCB_NO_DOTENV) process.loadEnvFile(envFile);

const problems: string[] = [];
const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}").`);
    return fallback;
  }
  return n;
}

function fraction(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (isNaN(n) || n < 0 || n > 1) { problems.push(`${name} must be a number from 0 to 1, for example 0.8 (got "${raw}").`); return fallback; }
  return n;
}

function json<T>(name: string, fallback: T): T {
  const raw = env(name);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch { problems.push(`${name} must be valid JSON, for example {"sam@yourco.com": "..."}.`); return fallback; }
}

/** Owner keys match whatever the CSV says, ignoring case and surrounding spaces. */
function ownerMap(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map ?? {}).map(([k, v]) => [k.trim().toLowerCase(), String(v).trim()]));
}

function kinds(name: string, fallback: ChangeKind[]): ChangeKind[] {
  const raw = env(name);
  if (!raw) return fallback;
  const list = raw.split(",").map(s => s.trim()).filter(Boolean) as ChangeKind[];
  const bad = list.filter(k => !ALERT_KINDS.includes(k));
  if (bad.length) problems.push(`${name} has unknown values: ${bad.join(", ")}. Use any of: ${ALERT_KINDS.join(", ")}.`);
  return list.filter(k => ALERT_KINDS.includes(k));
}

const alertMode = env("ALERT_MODE", "both");
if (!["realtime", "digest", "both"].includes(alertMode)) problems.push(`ALERT_MODE must be realtime, digest or both (got "${alertMode}").`);

const dbPath = env("DB_PATH", "./data/bot.sqlite");

export const config = {
  /** Crustdata API key. Get one at https://app.crustdata.com */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and fill it in.");
    return key;
  },

  /** Public base URL of this server. Crustdata delivers notifications to `${publicUrl}/webhooks/crustdata`. */
  publicUrl: env("PUBLIC_URL").replace(/\/+$/, ""),
  port: int("PORT", 3000, 1, 65535),
  dbPath: dbPath === ":memory:" || isAbsolute(dbPath) ? dbPath : resolve(ROOT, dbPath),

  /** Slack incoming webhook. Without it, messages are printed to the console instead. */
  slackWebhookUrl: env("SLACK_WEBHOOK_URL"),
  /** Optional: send an owner's alerts to their own channel. JSON: { "owner from CSV": "https://hooks.slack.com/..." } */
  slackRoutes: ownerMap(json<Record<string, string>>("SLACK_ROUTES", {})),
  /** Optional: @mention the owner. JSON: { "owner from CSV": "U012ABCDEF" } (Slack member ID). */
  ownerSlackIds: ownerMap(json<Record<string, string>>("OWNER_SLACK_IDS", {})),

  /** Which kinds of change produce an alert. Title edits (case or punctuation only) never do. */
  alertKinds: kinds("ALERT_KINDS", ["new_company", "title_change", "left_company"]),
  /** realtime: one message per change. digest: one message a day. both: both. */
  alertMode: alertMode as "realtime" | "digest" | "both",

  /** Watch settings, applied when a watch is created. */
  checkEveryHours: int("CHECK_EVERY_HOURS", 24, 1, 720),
  refreshFrequencyDays: int("REFRESH_FREQUENCY_DAYS", 30, 1, 30),
  /** Email matches below this confidence (0 to 1) are not watched. 0 accepts every match Crustdata returns. */
  minMatchConfidence: fraction("MIN_MATCH_CONFIDENCE", 0),

  /** Daily digest. */
  digestHourUtc: int("DIGEST_HOUR_UTC", 8, 0, 23),
  resendApiKey: env("RESEND_API_KEY"),
  digestEmailFrom: env("DIGEST_EMAIL_FROM"),
  digestEmailTo: env("DIGEST_EMAIL_TO").split(",").map(s => s.trim()).filter(Boolean),

  /** Accept webhooks without a valid signature. Local experiments only. */
  allowUnsignedWebhooks: env("ALLOW_UNSIGNED_WEBHOOKS").toLowerCase() === "true",
};

/** Settings that are present but invalid. Entry points print these and stop. */
export function configProblems(): string[] {
  const list = [...problems];
  const resend = [config.resendApiKey, config.digestEmailFrom, config.digestEmailTo.length ? "x" : ""];
  if (resend.some(Boolean) && !resend.every(Boolean)) list.push("Email digest needs all three of RESEND_API_KEY, DIGEST_EMAIL_FROM and DIGEST_EMAIL_TO.");
  for (const [owner, url] of Object.entries(json<Record<string, string>>("SLACK_ROUTES", {}) ?? {})) {
    if (!/^https:\/\/hooks\.slack\.com\/services\/\S+$/.test(String(url))) list.push(`SLACK_ROUTES entry for "${owner}" must be a Slack incoming webhook URL starting with https://hooks.slack.com/services/`);
  }
  if (config.slackWebhookUrl && !/^https?:\/\//.test(config.slackWebhookUrl)) list.push("SLACK_WEBHOOK_URL must be a URL starting with https://hooks.slack.com/services/");
  return list;
}

export const WEBHOOK_PATH = "/webhooks/crustdata";
export const webhookUrl = (): string => `${config.publicUrl}${WEBHOOK_PATH}`;
