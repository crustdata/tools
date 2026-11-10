/**
 * `npm run setup`: asks for each setting, checks it live where it can (free calls only), explains how to get anything
 * missing, and writes `.env`. Safe to re-run: existing values are the defaults and unknown keys in `.env` are kept.
 */

import "./node-check.js";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv as utilParseEnv } from "node:util";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { ROOT, REFRESH_TIERS, ownerKey } from "./config.js";
import { readPortfolioCsv, readSource, sheetCsvUrl, SHEET_SHARING_STEPS, splitOwners } from "./portfolio.js";

const ENV_FILE = resolve(ROOT, ".env");

/** Answers are queued line by line, so pasted or piped answers are never lost while setup is busy checking. */
let rl: Interface | undefined;
const queue: string[] = [];
const waiting: ((line: string | null) => void)[] = [];
let inputEnded = false;
function startInput(): void {
  rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  rl.on("line", line => { const w = waiting.shift(); if (w) w(line); else queue.push(line); });
  rl.on("close", () => { inputEnded = true; while (waiting.length) waiting.shift()!(null); });
}
async function nextLine(): Promise<string> {
  const line = queue.length ? queue.shift()! : inputEnded ? null : await new Promise<string | null>(r => waiting.push(r));
  if (line === null) throw new Error("input ended before setup finished. Run npm run setup again.");
  if (!process.stdin.isTTY) process.stdout.write("\n");
  return line;
}
async function ask(q: string, fallback = "", { secret = false } = {}): Promise<string> {
  process.stdout.write(fallback ? `${q} [${secret ? mask(fallback) : shorten(fallback)}] ` : `${q} `);
  return (await nextLine()).trim() || fallback;
}
export const mask = (v: string) => (v.length <= 8 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`);
const shorten = (v: string) => (v.length > 60 ? `${v.slice(0, 56)}…` : v);
const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const info = (s: string) => console.log(`  · ${s}`);

/** Parses a .env file with Node's own reader, so setup sees exactly the values the monitor will run with. */
export function parseEnv(text: string): Record<string, string> {
  return { ...utilParseEnv(text.replace(/^﻿/, "")) } as Record<string, string>;
}
/** Quotes a value so Node's .env reader gives it back unchanged (no escapes, so pick a quote it does not contain). */
export function quoteEnv(value: string): string {
  const v = value.replace(/[\r\n]+/g, " ");
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes("`")) return `\`${v}\``;
  return `"${v.replace(/"/g, "'")}"`;
}
const ORDER = ["CRUSTDATA_API_KEY", "FUND_NAME", "PORTFOLIO", "SLACK_WEBHOOK_URL", "SLACK_ROUTES", "RESEND_API_KEY", "DIGEST_EMAIL_FROM", "DIGEST_EMAIL_TO", "LEADER_REFRESH_DAYS", "MAX_LEADERS_PER_COMPANY", "HIRING_CHECK_DAYS", "MAX_IMPORT_CREDITS", "DB_PATH", "DIGEST_DIR", "THRESHOLDS_FILE"];
/** Writes .env, keeping keys this setup does not know about. Empty values are dropped from the file. */
export function renderEnv(values: Record<string, string>, existing: Record<string, string>): string {
  const merged = { ...existing, ...values };
  const keys = [...ORDER.filter(k => k in merged), ...Object.keys(merged).filter(k => !ORDER.includes(k))].filter(k => String(merged[k] ?? "") !== "");
  return keys.map(k => `${k}=${quoteEnv(String(merged[k]))}`).join("\n") + "\n";
}

async function crustdataCheck(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("https://api.crustdata.com/account/credits", { headers: { authorization: `Bearer ${key}`, "x-api-version": "2025-11-01" }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Crustdata rejected this key. Copy it again from https://app.crustdata.com (Settings > API keys)." };
    if (!res.ok) return { ok: false, message: `Crustdata answered ${res.status}; try again in a minute.` };
    const credits = ((await res.json()) as any)?.account?.credits;
    return { ok: true, message: `key works${typeof credits === "number" ? `, ${Math.round(credits)} credits available` : ""}` };
  } catch (err) { return { ok: false, message: `could not reach Crustdata (${(err as Error).message})` }; }
}

export const SLACK_STEPS = [
  "Create a channel for the alerts, for example #portfolio-alerts.",
  "Open https://api.slack.com/apps > Create New App > Blank app (older screens: From scratch). Name it, pick your workspace.",
  "In the app's menu: Incoming Webhooks > switch Activate Incoming Webhooks to On.",
  "Add New Webhook > pick the channel > Allow.",
  "Copy the Webhook URL (it starts with https://hooks.slack.com/services/) and paste it here.",
];

export function slackProblem(url: string): string | null {
  if (!/^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+$/.test(url)) return "that is not a Slack incoming webhook URL (it looks like https://hooks.slack.com/services/T.../B.../...).";
  return null;
}

async function testSlack(url: string, text: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(15_000) });
    return res.ok ? null : `Slack answered ${res.status} ${(await res.text()).slice(0, 100)}. Check the URL (a deleted webhook answers 404).`;
  } catch (err) { return `could not reach Slack (${(err as Error).message})`; }
}

async function askWebhook(q: string, fallback: string, testText: string, checklist: string[], label: string): Promise<string> {
  let question = q;
  for (;;) {
    const url = await ask(question, fallback, { secret: true });
    if (!url) return "";
    const problem = slackProblem(url);
    if (problem) { bad(problem); continue; }
    const sent = await testSlack(url, testText);
    if (!sent) { ok("test message sent"); checklist.push(`✓ Slack (${label}): test message sent`); return url; }
    bad(sent);
    const next = await ask("   Slack did not accept it. Paste another URL, or type keep to save this one anyway:", "");
    if (next.toLowerCase() === "keep") { checklist.push(`✗ Slack (${label}): saved, but the webhook did not accept the test`); return url; }
    if (!next) { checklist.push(`· Slack (${label}): skipped`); return ""; }
    fallback = "";
    queue.unshift(next);
    question = "   Webhook URL:";
  }
}

async function main(): Promise<void> {
  console.log("\nvc-portfolio-monitor setup. Enter keeps a value shown in brackets.\n");
  const existing = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
  const values: Record<string, string> = {};
  const checklist: string[] = [];

  // 1. Crustdata key
  console.log("1. Crustdata API key (https://app.crustdata.com > Settings > API keys; new accounts get free credits).");
  let keyWorks = false;
  for (;;) {
    const key = await ask("   Key:", existing.CRUSTDATA_API_KEY ?? "", { secret: true });
    if (!key) { bad("the monitor cannot run without a Crustdata key"); continue; }
    values.CRUSTDATA_API_KEY = key;
    const check = await crustdataCheck(key);
    if (check.ok) { ok(check.message); checklist.push(`✓ Crustdata: ${check.message}`); keyWorks = true; break; }
    bad(check.message);
    if ((await ask("   Try another key? (y/n)", "y")).toLowerCase().startsWith("n")) { checklist.push("✗ Crustdata key not accepted"); break; }
  }

  // 2. Fund name
  console.log("\n2. Your fund's name, for message titles.");
  values.FUND_NAME = await ask("   Fund name:", existing.FUND_NAME ?? "Portfolio");

  // 3. Portfolio
  console.log("\n3. Your portfolio: a CSV file in this folder, or a Google Sheet link.");
  console.log("   Columns: company and website (the website is best; a name alone can match several companies), and optionally");
  console.log("   owner (the partner who gets that company's alerts), status (exited or passed rows are skipped), careers (their");
  console.log("   jobs page) and leaders (profile URLs).");
  console.log(`   ${SHEET_SHARING_STEPS}`);
  let owners: string[] = [];
  for (;;) {
    const fallbackSource = existing.PORTFOLIO ?? (existsSync(resolve(ROOT, "portfolio.csv")) ? "./portfolio.csv" : "");
    const source = await ask(fallbackSource ? "   CSV path or Sheet link:" : "   CSV path or Sheet link (type ./portfolio.example.csv to try the ten sample startups):", fallbackSource);
    if (!source) { bad("enter a CSV path or a Google Sheet link"); continue; }
    if (/^https?:\/\//i.test(source) && !sheetCsvUrl(source) && !/\.csv(\?|$)/i.test(source)) { bad("use a Google Sheet link (docs.google.com/spreadsheets/...) or a link to a .csv file"); continue; }
    try {
      const p = readPortfolioCsv(await readSource(source));
      if (!p.rows.length) { bad(`no companies found.${p.skipped.length ? ` ${p.skipped.slice(0, 3).map(s => `Line ${s.line}: ${s.reason}.`).join(" ")}` : ""}`); continue; }
      const named = p.rows.filter(r => !r.domain).length;
      ok(`${p.rows.length} compan${p.rows.length === 1 ? "y" : "ies"} found${named ? ` (${named} by name only: add websites if npm run import cannot match them)` : ""}${p.skipped.length ? `, ${p.skipped.length} row${p.skipped.length === 1 ? "" : "s"} skipped:` : ""}`);
      for (const s of p.skipped.slice(0, 10)) info(`line ${s.line}: ${s.reason}`);
      for (const n of p.notes.slice(0, 5)) info(n);
      // One entry per owner, in the spelling first seen; a cell naming two partners counts for both.
      const seen = new Map<string, string>();
      for (const r of p.rows) for (const o of splitOwners(r.owner)) if (!seen.has(ownerKey(o))) seen.set(ownerKey(o), o);
      owners = [...seen.values()];
      // Saved without the quotes or "\ " a pasted path may carry.
      values.PORTFOLIO = /^https?:\/\//i.test(source) ? source : source.replace(/^(['"])(.*)\1$/, "$2").replace(/\\ /g, " ");
      checklist.push(`✓ Portfolio: ${p.rows.length} companies from ${shorten(source)}`);
      if (/portfolio\.example\.csv$/.test(source)) info("that is the example portfolio. Fine for a first try; point PORTFOLIO at your own list afterwards.");
      break;
    } catch (err) { bad((err as Error).message); }
  }

  // 4. Slack
  console.log("\n4. Slack (optional, recommended): alerts post here the day they are found, and the weekly digest every Monday.");
  SLACK_STEPS.forEach((s, i) => console.log(`   ${String.fromCharCode(97 + i)}. ${s}`));
  const main = await askWebhook("   Webhook URL (Enter to skip):", existing.SLACK_WEBHOOK_URL ?? "", "vc-portfolio-monitor is connected. Portfolio alerts and the weekly digest will arrive here.", checklist, "main channel");
  values.SLACK_WEBHOOK_URL = main;
  if (!main) { info("no Slack: alerts print in the terminal and the digest goes to a file (and email if you set it up next)"); checklist.push("· Slack: skipped"); }
  if (main && owners.length) {
    let routes: Record<string, string> = {};
    try { routes = JSON.parse(existing.SLACK_ROUTES || "{}"); } catch { routes = {}; }
    const answer = await ask(`   Your portfolio has ${owners.length} owner${owners.length === 1 ? "" : "s"}: ${owners.slice(0, 6).join(", ")}${owners.length > 6 ? ", ..." : ""}. Send each one's alerts to their own channel? (y/n)`, Object.keys(routes).length ? "y" : "n");
    if (answer.toLowerCase().startsWith("y")) {
      const next: Record<string, string> = {};
      for (const owner of owners) {
        const old = Object.entries(routes).find(([k]) => ownerKey(k) === ownerKey(owner))?.[1] ?? "";
        const url = await askWebhook(`   Webhook for ${owner} (Enter: main channel):`, old, `vc-portfolio-monitor: ${owner}'s portfolio alerts will arrive here.`, checklist, owner);
        if (url) next[owner] = url;
      }
      values.SLACK_ROUTES = Object.keys(next).length ? JSON.stringify(next) : "";
    } else values.SLACK_ROUTES = "";
  }

  // 5. Email
  console.log("\n5. Weekly digest by email (optional), through Resend (https://resend.com, free tier): an API key, a verified sender, recipients.");
  const resendKey = await ask("   Resend API key (Enter to skip):", existing.RESEND_API_KEY ?? "", { secret: true });
  if (resendKey) {
    if (!/^re_[A-Za-z0-9_-]{10,}$/.test(resendKey)) bad("Resend keys start with re_; saving it anyway, check it if sending fails");
    values.RESEND_API_KEY = resendKey;
    values.DIGEST_EMAIL_FROM = await ask("   From address (on a domain verified in Resend, or onboarding@resend.dev to test):", existing.DIGEST_EMAIL_FROM ?? "");
    values.DIGEST_EMAIL_TO = await ask("   To address(es), comma separated:", existing.DIGEST_EMAIL_TO ?? "");
    if (values.DIGEST_EMAIL_FROM && values.DIGEST_EMAIL_TO) checklist.push(`✓ Email: to ${values.DIGEST_EMAIL_TO}`);
    else { bad("email needs a from and a to address; skipping email"); values.RESEND_API_KEY = values.DIGEST_EMAIL_FROM = values.DIGEST_EMAIL_TO = ""; checklist.push("✗ Email: incomplete, skipped"); }
  } else { values.RESEND_API_KEY = values.DIGEST_EMAIL_FROM = values.DIGEST_EMAIL_TO = ""; checklist.push("· Email: skipped"); }

  // 6. Leader freshness
  console.log(`\n6. How fresh leader profiles are kept. Fresher means a departure shows sooner, and costs more per change:`);
  console.log(`   ${Object.entries(REFRESH_TIERS).sort((a, b) => Number(b[0]) - Number(a[0])).map(([d, c]) => `${d} day${d === "1" ? "" : "s"}: ${c} credits`).join(", ")} (per leader whose profile changed).`);
  for (;;) {
    const days = await ask("   Days (30, 14, 7, 3 or 1):", existing.LEADER_REFRESH_DAYS ?? "30");
    if (["30", "14", "7", "3", "1"].includes(days)) { values.LEADER_REFRESH_DAYS = days; break; }
    bad("enter 30, 14, 7, 3 or 1");
  }

  writeFileSync(ENV_FILE, renderEnv(values, existing), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  console.log(`\n${checklist.join("\n")}\n✓ .env written (${ENV_FILE})`);
  if (!keyWorks) console.log("\nNext: fix the Crustdata key and run npm run setup again. Nothing else works until the key is accepted.");
  else console.log("\nNext:\n  npm run import   matches your companies, finds founders and C-level, shows the cost and asks before spending\n  npm run check    the daily run (schedule it: docs/deploy.md)\n  npm run digest   the weekly summary");
  rl?.close();
}

// Only when run as `npm run setup`; tests import the helpers above without starting the prompts.
if (process.argv[1] && /setup\.(ts|js)$/.test(process.argv[1])) {
  startInput();
  main().catch(err => { console.error(`\nSetup stopped: ${(err as Error).message}`); process.exit(1); });
}
