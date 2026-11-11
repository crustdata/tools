/**
 * Guided setup: `npm run setup`.
 *
 * Asks for the Crustdata API key and checks it with two free calls (credit balance, and what the key can use: the
 * full check, the quick screen, email lookup). Optionally takes a Slack incoming webhook (sends a test message when
 * you say so) and an Anthropic key for --ai (checked with a free call). Writes `.env` from `.env.example`. Safe to
 * run again: current values are offered as defaults.
 */

import "./node-check.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ROOT } from "./config.js";
import { CrustdataError, accountEndpoints, capabilities, creditBalance } from "./crustdata.js";
import { connectedMessage, looksLikeSlackWebhook, postToSlack } from "./slack.js";

const ENV_FILE = resolve(ROOT, ".env");
const TEMPLATE_FILE = resolve(ROOT, ".env.example");

let muted = false;
const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
const tty = Boolean(process.stdin.isTTY);
let rl: ReturnType<typeof createInterface>;

async function ask(question: string, { hidden = false, current = "" } = {}): Promise<string> {
  const prompt = `${question}${current ? ` [${hidden ? mask(current) : current}]` : ""}: `;
  let answer: string;
  try {
    if (hidden && tty) {
      process.stdout.write(prompt);
      muted = true;
      answer = await rl.question("");
      muted = false;
      process.stdout.write("\n");
    } else answer = await rl.question(prompt);
  } catch {
    console.log("\nSetup stopped. Nothing was saved.");
    process.exit(1);
  }
  return answer.trim() || current;
}

const yes = async (q: string) => /^y(es)?$/i.test(await ask(`${q} (y/N)`));
const mask = (secret: string) => (secret.length > 8 ? `${secret.slice(0, 4)}...${secret.slice(-4)}` : "set");
const heading = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`);

type Check = { label: string; ok: boolean; note: string; optional?: boolean };
const checks: Check[] = [];

async function crustdataKey(current: string): Promise<string> {
  heading("1/3  Crustdata API key");
  console.log("Find it at https://app.crustdata.com under API keys.");
  while (true) {
    const key = await ask("Paste your Crustdata API key", { hidden: true, current });
    if (!key) { console.log("A Crustdata API key is required."); continue; }
    if (/\s/.test(key)) { console.log("That has spaces in it; copy the key again."); continue; }
    process.env.CRUSTDATA_API_KEY = key;
    try {
      const credits = await creditBalance();
      const balance = credits !== undefined ? `${Math.floor(credits).toLocaleString("en-US")} credits` : "balance unknown";
      console.log(`Key works (${balance}).`);
      checks.push({ label: "Crustdata key", ok: true, note: balance });
      const can = capabilities(await accountEndpoints());
      checks.push({ label: "Full check", ok: can.verify, optional: !can.verify, note: can.verify ? `enabled (${can.verifyCredits} credits per verdict, reasons and sources)` : "not enabled: it is an add-on; ask Crustdata. Runs use the quick screen until then" });
      checks.push({ label: "Quick screen", ok: can.assessment, optional: can.verify, note: can.assessment ? "enabled (1 credit per candidate)" : "not enabled (the assessment field): ask Crustdata" });
      checks.push({ label: "Email lookup", ok: can.identify, optional: true, note: can.identify ? "enabled (rows with only an email are looked up, 1 credit per match)" : "not enabled: rows need a profile URL" });
      if (!can.enrich) checks.push({ label: "Person Enrich", ok: false, note: "not enabled on this key: every check needs it. Ask Crustdata" });
      return key;
    } catch (err) {
      const rejected = err instanceof CrustdataError && (err.status === 401 || err.status === 403);
      console.log(rejected ? "Crustdata rejected that key. Copy it again from https://app.crustdata.com, or press Ctrl+C to stop." : `${(err as Error).message} (Ctrl+C stops setup.)`);
      if (await yes("Save it anyway?")) { checks.push({ label: "Crustdata key", ok: false, note: "saved but not verified" }); return key; }
    }
  }
}

async function slack(values: Record<string, string>): Promise<void> {
  heading("2/3  Slack (optional)");
  console.log(`Each run can post a summary with the candidates to review first to a Slack channel.
To get a webhook URL: open https://api.slack.com/apps > Create New App > From scratch, pick your workspace,
then Incoming Webhooks > turn it on > Add New Webhook to Workspace > pick the channel > copy the URL.
Use a private channel: the summary names candidates. Press Enter to skip; type "none" to remove a saved one.`);
  while (true) {
    const url = await ask("Slack webhook URL", { current: values.SLACK_WEBHOOK_URL });
    if (!url || url === "none") {
      values.SLACK_WEBHOOK_URL = "";
      checks.push({ label: "Slack", ok: false, optional: true, note: "off (optional)" });
      return;
    }
    if (!looksLikeSlackWebhook(url)) { console.log("That is not a Slack incoming webhook URL (they start with https://hooks.slack.com/services/). Try again, or press Enter to skip."); continue; }
    values.SLACK_WEBHOOK_URL = url.trim();
    if (await yes("Send a test message to that channel now?")) {
      const res = await postToSlack(values.SLACK_WEBHOOK_URL, connectedMessage());
      if (!res.ok) { console.log(`Slack did not take it: ${res.error}`); if (!(await yes("Save it anyway?"))) continue; }
      checks.push({ label: "Slack", ok: res.ok, optional: !res.ok, note: res.ok ? "test message sent" : "saved, but the test message failed" });
    } else checks.push({ label: "Slack", ok: true, note: "saved (npm run test-slack sends a test message)" });
    return;
  }
}

async function ai(values: Record<string, string>): Promise<void> {
  heading("3/3  Anthropic key for --ai (optional)");
  console.log(`Verdicts never use it. With a key and --ai, Claude writes a one-line summary per candidate and a short
overview of the list, only from what the check found. Get a key at https://console.anthropic.com. Press Enter to skip.`);
  const key = await ask("Anthropic API key", { hidden: true, current: values.ANTHROPIC_API_KEY });
  values.ANTHROPIC_API_KEY = key === "none" ? "" : key;
  if (!values.ANTHROPIC_API_KEY) { checks.push({ label: "AI summaries", ok: false, optional: true, note: "off (optional)" }); return; }
  try {
    await new Anthropic({ apiKey: values.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20_000 }).models.list({ limit: 1 });
    checks.push({ label: "AI summaries", ok: true, note: "key works; used only with --ai" });
  } catch (err) {
    console.log(`Anthropic did not accept that key (${(err as Error).message.slice(0, 120)}).`);
    checks.push({ label: "AI summaries", ok: false, optional: true, note: "saved, but the key did not work" });
  }
}

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values[m[1]] = m[2].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  }
  return values;
}

/** Single quotes keep any value intact; a value with a single quote gets double quotes. */
export const quote = (v: string) => {
  if (/[\r\n]/.test(v) || (v.includes("'") && v.includes('"'))) throw new Error("That value has a line break, or both kinds of quote, which .env cannot hold. Check it and paste it again.");
  return !/[\s#"'=`$\\]/.test(v) ? v : !v.includes("'") ? `'${v}'` : `"${v}"`;
};

/** Keeps the comments and order of .env.example, fills in every value, and keeps settings the template does not have. */
export function envText(template: string, values: Record<string, string>): string {
  const written = new Set<string>();
  const lines = template.split("\n").map(line => {
    const m = /^#?\s*([A-Z0-9_]+)=/.exec(line);
    if (!m || values[m[1]] === undefined) return line;
    written.add(m[1]);
    return values[m[1]] === "" ? (line.startsWith("#") ? line : `${m[1]}=`) : `${m[1]}=${quote(values[m[1]])}`;
  });
  const extra = Object.keys(values).filter(k => !written.has(k) && values[k] !== "").map(k => `${k}=${quote(values[k])}`);
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return [...lines, ...(extra.length ? ["", "# Other settings", ...extra] : [])].join("\n") + "\n";
}

async function main() {
  rl = createInterface({ input: process.stdin, output, terminal: tty });
  // Input ended (Ctrl+D, or a pipe that ran out) before setup finished.
  let finished = false;
  rl.on("close", () => { if (!finished) { console.log("\nSetup stopped. Nothing was saved."); process.exit(1); } });
  console.log("Candidate Verification Agent setup. Press Enter to keep a value shown in [brackets].");
  const values = { ...readEnv(ENV_FILE) };
  values.CRUSTDATA_API_KEY = await crustdataKey(values.CRUSTDATA_API_KEY ?? "");
  await slack(values);
  await ai(values);
  finished = true;
  writeFileSync(ENV_FILE, envText(readFileSync(TEMPLATE_FILE, "utf8"), values), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  rl.close();

  heading("Summary (saved to .env)");
  for (const c of checks) console.log(`  ${c.ok ? "\x1b[32m✓\x1b[0m" : c.optional ? "\x1b[90m·\x1b[0m" : "\x1b[33m✗\x1b[0m"} ${c.label.padEnd(14)} ${c.note}`);
  const ready = checks.find(c => c.label === "Crustdata key")?.ok && !checks.some(c => c.label === "Person Enrich");
  console.log(ready
    ? `\nReady. See what a check would cost (spends nothing), then run it without --dry-run:
  npm run verify -- examples/ashby-export.csv --dry-run
  npm run verify -- your-candidates.csv --dry-run`
    : "\nNot ready yet: fix the items marked ✗ above and run npm run setup again.");
}

if (process.argv[1] && /setup\.ts$/.test(process.argv[1])) main();
