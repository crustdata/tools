/**
 * `npm run setup`: a guided setup that asks for each setting, checks it live where it can (free calls only), explains
 * how to get anything missing, and writes `.env` and `competitors.json`. Safe to re-run: existing values are kept as
 * defaults and unknown keys in `.env` are preserved.
 */

import "./node-check.js";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv as utilParseEnv } from "node:util";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { ROOT } from "./config.js";
import { deriveAbout, looksLikeDomain, normalizeDomain, validateCompetitors, type Competitors } from "./competitors.js";
import { estimateInit, estimateWeek, FIRST_DIGEST_MAX_PER_COMPETITOR } from "./run.js";

const ENV_FILE = resolve(ROOT, ".env");
const COMPETITORS_FILE = resolve(ROOT, process.env.COMPETITORS_FILE?.trim() || "competitors.json");
/**
 * Answers are read line by line into a queue, so piped or pasted answers are never lost while setup is busy checking
 * something (readline's question() drops lines that arrive between questions).
 */
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

/** Asks one question. A saved secret (key, webhook) is shown masked as the default, never in full. */
async function ask(q: string, fallback = "", { secret = false } = {}): Promise<string> {
  process.stdout.write(fallback ? `${q} [${secret ? mask(fallback) : shorten(fallback)}] ` : `${q} `);
  return (await nextLine()).trim() || fallback;
}
export const mask = (v: string) => (v.length <= 8 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`);
const shorten = (v: string) => (v.length > 60 ? `${v.slice(0, 56)}…` : v);
const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const info = (s: string) => console.log(`  · ${s}`);

/** Parses a .env file with Node's own reader, so setup sees exactly the values the tracker will run with. */
export function parseEnv(text: string): Record<string, string> {
  return { ...utilParseEnv(text.replace(/^\uFEFF/, "")) } as Record<string, string>;
}

/** Quotes a value so Node's .env reader gives it back unchanged (it has no escapes, so pick a quote it does not contain). */
export function quoteEnv(value: string): string {
  const v = value.replace(/[\r\n]+/g, " ");
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes("`")) return `\`${v}\``; // Node expands \n only inside double quotes
  return `"${v.replace(/"/g, "'")}"`;
}

/** Writes .env, keeping keys this setup does not know about. */
export function renderEnv(values: Record<string, string>, existing: Record<string, string>): string {
  const merged = { ...existing, ...values };
  const order = ["CRUSTDATA_API_KEY", "COMPETITORS_FILE", "SLACK_WEBHOOK_URL", "RESEND_API_KEY", "DIGEST_EMAIL_FROM", "DIGEST_EMAIL_TO", "PAGES_PER_COMPETITOR", "MAX_POSTS_PER_WEEK", "MAX_JOBS_PER_WEEK", "SHOW_POSTER_NAMES", "DB_PATH", "DIGEST_DIR"];
  const keys = [...order.filter(k => k in merged), ...Object.keys(merged).filter(k => !order.includes(k))];
  return keys.map(k => `${k}=${quoteEnv(String(merged[k] ?? ""))}`).join("\n") + "\n";
}

async function crustdataCheck(key: string): Promise<{ ok: boolean; message: string; credits?: number }> {
  try {
    const res = await fetch("https://api.crustdata.com/account/credits", { headers: { authorization: `Bearer ${key}`, "x-api-version": "2025-11-01" }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Crustdata rejected this key. Copy it again from https://app.crustdata.com (Settings > API keys)." };
    if (!res.ok) return { ok: false, message: `Crustdata answered ${res.status}; try again in a minute.` };
    const json: any = await res.json();
    const credits = json?.account?.credits;
    return { ok: true, message: `key works${typeof credits === "number" ? `, ${Math.round(credits)} credits available` : ""}`, credits };
  } catch (err) { return { ok: false, message: `could not reach Crustdata (${(err as Error).message})` }; }
}

async function identify(key: string, domains: string[]): Promise<Record<string, { id: number; name: string; range?: string; description?: string }>> {
  const out: Record<string, { id: number; name: string; range?: string; description?: string }> = {};
  if (!domains.length) return out;
  try {
    const res = await fetch("https://api.crustdata.com/company/identify", { method: "POST", headers: { authorization: `Bearer ${key}`, "x-api-version": "2025-11-01", "content-type": "application/json" }, body: JSON.stringify({ domains }), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return out;
    for (const row of ((await res.json()) as any[]) ?? []) {
      const c = row?.matches?.[0]?.company_data;
      if (c?.crustdata_company_id) out[String(row.matched_on).toLowerCase()] = { id: c.crustdata_company_id, name: c.basic_info?.name ?? row.matched_on, range: c.basic_info?.employee_count_range, description: c.basic_info?.description };
    }
  } catch { /* identify is a convenience here; init resolves again */ }
  return out;
}

export const SLACK_STEPS = "In Slack: api.slack.com/apps > Create New App > From scratch > name it and pick your workspace > Incoming Webhooks > turn on Activate > Add New Webhook to Workspace > pick a channel > Copy.";

function slackProblem(url: string): string | null {
  if (!/^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+$/.test(url)) return `that is not a Slack incoming webhook URL (it looks like https://hooks.slack.com/services/T.../B.../...). ${SLACK_STEPS}`;
  return null;
}

async function main(): Promise<void> {
  console.log("\ncompetitor-tracker setup. Enter to keep a value shown in brackets.\n");
  const existing = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
  const values: Record<string, string> = {};
  const checklist: string[] = [];

  // 1. Crustdata key
  console.log("1. Crustdata API key (https://app.crustdata.com > Settings > API keys; new accounts get free credits).");
  let key = "";
  let keyWorks = false;
  for (;;) {
    key = await ask("   Key:", existing.CRUSTDATA_API_KEY ?? "", { secret: true });
    if (!key) { bad("the tracker cannot run without a Crustdata key"); continue; }
    const check = await crustdataCheck(key);
    if (check.ok) { ok(check.message); checklist.push(`✓ Crustdata: ${check.message}`); keyWorks = true; break; }
    bad(check.message);
    if ((await ask("   Try another key? (y/n)", "y")).toLowerCase().startsWith("n")) { checklist.push("✗ Crustdata key not accepted"); break; }
  }
  values.CRUSTDATA_API_KEY = key;

  // 2. Competitors
  console.log("\n2. Competitors to track: websites, comma separated (for example attio.com, folk.app, twenty.com). 1 to 20 works best.");
  let current: Competitors | undefined;
  if (existsSync(COMPETITORS_FILE)) { try { current = validateCompetitors(JSON.parse(readFileSync(COMPETITORS_FILE, "utf8").replace(/^\uFEFF/, ""))); } catch { current = undefined; } }
  let competitors: Competitors;
  for (;;) {
    const raw = await ask("   Websites:", current?.competitors.map(c => c.domain).join(", ") ?? "");
    const parts = raw.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
    const domains = parts.map(p => (looksLikeDomain(p) ? normalizeDomain(p) : null));
    const badOnes = parts.filter((_, i) => !domains[i]);
    if (!parts.length) { bad("list at least one website"); continue; }
    if (badOnes.length) { bad(`not websites: ${badOnes.join(", ")}. Use the domain, such as acme.com.`); continue; }
    const unique = [...new Set(domains as string[])];
    if (unique.length > 50) { bad("the tracker supports up to 50 competitors"); continue; }
    const found: Awaited<ReturnType<typeof identify>> = keyWorks ? await identify(key, unique) : {};
    const list = unique.map(d => {
      const old = current?.competitors.find(c => c.domain === d);
      const hit = found[d];
      return { name: hit?.name ?? old?.name ?? d, domain: d, crustdata_company_id: hit?.id ?? old?.crustdata_company_id, pages: old?.pages, about: old?.about ?? (hit ? deriveAbout(hit.description) : undefined) };
    });
    for (const c of list) {
      if (!keyWorks) info(`${c.domain}: not looked up (the Crustdata key did not work)`);
      else (c.crustdata_company_id ? ok : info)(`${c.domain}: ${c.crustdata_company_id ? `${c.name}${found[c.domain]?.range ? `, ${found[c.domain].range} employees` : ""}` : "not in Crustdata's company index yet (website and news sections only)"}`);
    }
    competitors = { competitors: list, cities: current?.cities ?? [] };
    break;
  }
  console.log("   What each one makes, in a word or two. Used to tell their news apart from other uses of the name (a company called Twenty is not the number).");
  for (const c of competitors!.competitors) {
    // With no description to guess from, ask with no default (npm run init guesses later if this is left empty).
    const answer = (await ask(c.about ? `   ${c.name}:` : `   ${c.name} (what they make, e.g. CRM):`, c.about ?? "")).slice(0, 40);
    if (answer) c.about = answer; else delete c.about;
  }
  const citiesRaw = await ask("   Cities, states or countries to break hiring down by, as job posts write them (optional, comma separated, for example New York, London, Germany):", competitors!.cities.join(", "));
  competitors!.cities = citiesRaw.split(/[,;]+/).map(s => s.trim()).filter(Boolean).slice(0, 50);
  writeFileSync(COMPETITORS_FILE, JSON.stringify(competitors!, null, 2) + "\n");
  values.COMPETITORS_FILE = existing.COMPETITORS_FILE ?? "./competitors.json";
  checklist.push(`✓ ${competitors!.competitors.length} competitor${competitors!.competitors.length === 1 ? "" : "s"} saved to competitors.json`);

  // 3. Slack
  console.log("\n3. Slack (optional). An incoming webhook URL for the channel that should get the digest.");
  console.log(`   ${SLACK_STEPS}`);
  for (;;) {
    const url = await ask("   Webhook URL (Enter to skip):", existing.SLACK_WEBHOOK_URL ?? "", { secret: true });
    if (!url) { info("no Slack; the digest is written to a file (and emailed if you set that up next)"); checklist.push("· Slack: skipped"); break; }
    const problem = slackProblem(url);
    if (problem) { bad(problem); continue; }
    values.SLACK_WEBHOOK_URL = url;
    if ((await ask("   Send a test message now? (y/n)", "y")).toLowerCase().startsWith("y")) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "competitor-tracker: setup test. Your weekly digest will arrive here." }), signal: AbortSignal.timeout(15_000) });
        if (res.ok) { ok("test message sent"); checklist.push("✓ Slack: test message sent"); }
        else { bad(`Slack answered ${res.status} ${(await res.text()).slice(0, 100)}. Check the URL (a deleted webhook answers 404).`); checklist.push("✗ Slack: webhook did not accept the test"); }
      } catch (err) { bad(`could not reach Slack (${(err as Error).message})`); checklist.push("✗ Slack: unreachable"); }
    } else checklist.push("✓ Slack: URL saved, not tested");
    break;
  }

  // 4. Email
  console.log("\n4. Email (optional), through Resend (https://resend.com, free tier). Needs an API key, a verified sender and recipients.");
  const resendKey = await ask("   Resend API key (Enter to skip):", existing.RESEND_API_KEY ?? "", { secret: true });
  if (resendKey) {
    if (!/^re_[A-Za-z0-9_-]{10,}$/.test(resendKey)) bad("Resend keys start with re_; saving it anyway, check it if sending fails");
    values.RESEND_API_KEY = resendKey;
    values.DIGEST_EMAIL_FROM = await ask("   From address (on a domain verified in Resend, or onboarding@resend.dev to test):", existing.DIGEST_EMAIL_FROM ?? "");
    values.DIGEST_EMAIL_TO = await ask("   To address(es), comma separated:", existing.DIGEST_EMAIL_TO ?? "");
    if (values.DIGEST_EMAIL_FROM && values.DIGEST_EMAIL_TO) checklist.push(`✓ Email: to ${values.DIGEST_EMAIL_TO}`);
    else { bad("email needs both a from and a to address; skipping email"); delete values.RESEND_API_KEY; delete values.DIGEST_EMAIL_FROM; delete values.DIGEST_EMAIL_TO; checklist.push("✗ Email: incomplete, skipped"); }
  } else checklist.push("· Email: skipped");

  // 5. Pages per competitor
  console.log("\n5. Pages compared per competitor each week (1 credit per page). 6 covers home, pricing, changelog, customers, blog and integrations.");
  for (;;) {
    const pages = await ask("   Pages per competitor (1 to 10):", existing.PAGES_PER_COMPETITOR ?? "6");
    if (/^([1-9]|10)$/.test(pages)) { values.PAGES_PER_COMPETITOR = pages; break; }
    bad("enter a whole number from 1 to 10");
  }

  writeFileSync(ENV_FILE, renderEnv(values, existing), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  const n = competitors!.competitors.length;
  const pagesN = Number(values.PAGES_PER_COMPETITOR);
  console.log(`\n${checklist.join("\n")}\n✓ .env written (${ENV_FILE})`);
  const week = estimateWeek(n, pagesN, 500, 200);
  console.log(`\nEstimated cost at list prices: about ${estimateInit(n, pagesN)} credits once for the starting point, up to ${Math.round(n * FIRST_DIGEST_MAX_PER_COMPETITOR)} more for the first digest's 7-day searches, then about ${week.quiet} credits on a quiet week and ${week.busy} on a busy one.`);
  if (!keyWorks) console.log("\nNext: fix the Crustdata key and run npm run setup again. Nothing else works until the key is accepted.");
  else console.log("\nNext:\n  npm run init     records the starting point and sets up the watchers (asks before spending)\n  npm run digest   builds and sends the first digest\n  then schedule npm run digest weekly: see docs/deploy.md");
  rl?.close();
}

// Only when run as `npm run setup`; tests import the helpers above without starting the prompts.
if (process.argv[1] && /setup\.(ts|js)$/.test(process.argv[1])) {
  startInput();
  main().catch(err => { console.error(`\nSetup stopped: ${(err as Error).message}`); process.exit(1); });
}
