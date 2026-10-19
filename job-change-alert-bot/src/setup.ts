/**
 * Guided setup: `npm run setup`.
 *
 * Checks the Crustdata API key, walks through creating a Slack incoming webhook and posts a test message to it,
 * asks for the public URL (and checks it reaches this server when it is running), optionally sets up the email
 * digest, then writes `.env` from `.env.example`. Safe to run again: current values are offered as defaults.
 */

import "./node-check.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";
import { CrustdataError, getCreditBalance, identifyEmails } from "./crustdata.js";
import { connectedMessage, looksLikeSlackWebhook, postToSlack } from "./slack.js";

const ENV_FILE = resolve(ROOT, ".env");
const TEMPLATE_FILE = resolve(ROOT, ".env.example");

// ---------------------------------------------------------------------------
// Prompting, with hidden input for secrets
// ---------------------------------------------------------------------------

let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding);
    done();
  },
});
const tty = Boolean(process.stdin.isTTY);
const rl = createInterface({ input: process.stdin, output, terminal: tty });

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
    } else {
      answer = await rl.question(prompt);
    }
  } catch {
    console.log("\nSetup cancelled.");
    process.exit(1);
  }
  return answer.trim() || current;
}

const yes = async (question: string) => /^y(es)?$/i.test(await ask(`${question} (y/N)`));
const mask = (secret: string) => (secret.length > 8 ? `${secret.slice(0, 4)}...${secret.slice(-4)}` : "set");
const heading = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`);

type Check = { label: string; ok: boolean; note: string; optional?: boolean };
const checks: Check[] = [];

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function crustdataKey(current: string): Promise<string> {
  heading("1/4  Crustdata API key");
  console.log("Find it at https://app.crustdata.com (new accounts get free credits).");
  while (true) {
    const key = await ask("Paste your Crustdata API key", { hidden: true, current });
    if (!key) { console.log("A Crustdata API key is required."); continue; }
    process.env.CRUSTDATA_API_KEY = key;
    try {
      const credits = await getCreditBalance();
      const balance = credits !== undefined ? `${Math.floor(credits).toLocaleString("en-US")} credits` : "balance unknown";
      console.log(`Key works (${balance}).`);
      checks.push({ label: "Crustdata key", ok: true, note: balance });
      // Email lookup is enabled per account. One address that will not match is free to look up.
      try {
        await identifyEmails(["setup-check-no-such-person@crustdata.com"], () => {});
        checks.push({ label: "Email lookup", ok: true, note: "enabled" });
      } catch (err) {
        const blocked = err instanceof CrustdataError && err.status === 403;
        if (blocked) console.log("Email lookup (/person/identify) is not enabled on this key. Ask Crustdata to enable it, or put profile URLs in your CSV.");
        checks.push({ label: "Email lookup", ok: !blocked, optional: blocked, note: blocked ? "not enabled: ask Crustdata, or use profile URLs in the CSV" : "could not check" });
      }
      return key;
    } catch (err) {
      const rejected = err instanceof CrustdataError && (err.status === 401 || err.status === 403);
      console.log(rejected ? "Crustdata rejected that key. Copy it again from https://app.crustdata.com" : `Could not check the key: ${(err as Error).message}`);
      if (await yes("Save it anyway?")) {
        checks.push({ label: "Crustdata key", ok: false, note: "saved but not verified; import will fail if it is wrong" });
        return key;
      }
    }
  }
}

async function slackWebhook(current: string): Promise<string> {
  heading("2/4  Slack channel");
  console.log(`Alerts are posted through a Slack incoming webhook. To create one (about 2 minutes):
  1. Create a channel for the alerts, for example #job-change-alerts.
  2. Open https://api.slack.com/apps, click "Create New App", choose "Blank app"
     (older screens say "From scratch"), name it, pick your workspace, create it.
  3. In the left menu open "Incoming Webhooks" and switch it On.
  4. Click "Add New Webhook", pick your channel, click "Allow".
  5. Copy the Webhook URL. It starts with https://hooks.slack.com/services/
  You do not need any bot scopes, the bot token or the app token.
Press Enter to skip for now; alerts will print in the terminal instead.`);
  while (true) {
    const url = await ask("Paste the Slack webhook URL", { hidden: true, current });
    if (!url) { checks.push({ label: "Slack", ok: false, optional: true, note: "skipped; alerts print in the terminal" }); return ""; }
    if (!looksLikeSlackWebhook(url)) { console.log("That is not a Slack incoming webhook URL. It starts with https://hooks.slack.com/services/"); continue; }
    if ((await postToSlack(connectedMessage(), url)).ok) {
      console.log("Sent a test message. Check that it appeared in your channel.");
      checks.push({ label: "Slack", ok: true, note: "test message sent" });
      return url;
    }
    console.log("Slack did not accept the message. The webhook may have been removed; create a new one and try again.");
  }
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$|.*\.local$)/i;

async function publicUrl(current: string, port: string): Promise<string> {
  heading("3/4  Public URL of this server");
  console.log(`Crustdata delivers job changes to <public URL>/webhooks/crustdata, so it must be reachable from the internet over https.
  To try it on a laptop: run "npx cloudflared tunnel --url http://localhost:${port}" in another terminal and paste the https URL it prints.
    A laptop tunnel gets a new URL each time it restarts and stops when the laptop sleeps, so use it for trying the bot, not for real alerts.
    When the URL changes, run setup again and restart npm run serve: the watch is updated automatically.
  For real alerts: deploy the bot (see docs/deploy.md) and paste the server's https address.
Press Enter to skip for now; you need it before "npm run import".`);
  while (true) {
    let url = (await ask("Public URL", { current })).replace(/\/+$/, "");
    if (!url) { checks.push({ label: "Public URL", ok: false, note: "not set; needed before npm run import" }); return ""; }
    if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
    let parsed: URL;
    try { parsed = new URL(url); } catch { console.log("That is not a valid URL."); continue; }
    if (parsed.protocol !== "https:") { console.log("Crustdata needs an https URL. Tunnels and hosts give you one."); continue; }
    if (PRIVATE_HOST.test(parsed.hostname)) { console.log("That address only works on your own machine, so Crustdata cannot reach it. Use the tunnel's https URL or your server's public address."); continue; }
    const answer = await fetch(`${url}/`, { signal: AbortSignal.timeout(5_000) }).then(async r => (r.ok ? r.json().catch(() => "other") : "other")).catch(() => null);
    const reachable = Boolean(answer && typeof answer === "object" && answer.ok === true && "peopleWatched" in answer);
    if (answer && !reachable) {
      console.log("Something else answers at that URL, so it is probably not your tunnel or server (a company website, for example).");
      if (!(await yes("Use it anyway?"))) continue;
      checks.push({ label: "Public URL", ok: false, note: `${url} (something else answers there; changes would not reach the bot)` });
      return url;
    }
    console.log(reachable ? "Reached the bot at that URL." : "Saved. The bot is not answering there yet; that is fine if npm run serve or the tunnel is not running.");
    checks.push({ label: "Public URL", ok: true, note: reachable ? `${url} (reachable)` : `${url} (start npm run serve to check)` });
    return url;
  }
}

async function email(values: Record<string, string>): Promise<void> {
  heading("4/4  Email digest (optional)");
  console.log("The daily digest goes to Slack. It can also go by email through Resend (https://resend.com), which needs an API key and a verified sending domain.");
  if (!values.RESEND_API_KEY && !(await yes("Set up the email digest?"))) { checks.push({ label: "Email digest", ok: false, optional: true, note: "off (optional)" }); return; }
  values.RESEND_API_KEY = await ask("Resend API key", { hidden: true, current: values.RESEND_API_KEY });
  values.DIGEST_EMAIL_FROM = await ask("Send from (an address on your verified domain)", { current: values.DIGEST_EMAIL_FROM });
  values.DIGEST_EMAIL_TO = await ask("Send to (comma separated)", { current: values.DIGEST_EMAIL_TO });
  const ok = Boolean(values.RESEND_API_KEY && values.DIGEST_EMAIL_FROM && values.DIGEST_EMAIL_TO);
  checks.push({ label: "Email digest", ok, note: ok ? `to ${values.DIGEST_EMAIL_TO}` : "incomplete, so it stays off" });
}

// ---------------------------------------------------------------------------
// .env reading and writing
// ---------------------------------------------------------------------------

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values[m[1]] = m[2].replace(/^'(.*)'$/, "$1").replace(/^`(.*)`$/, "$1").replace(/^"(.*)"$/, "$1");
  }
  return values;
}

/** Single quotes are read literally by Node's .env parser, so JSON such as SLACK_ROUTES survives untouched. */
const quote = (v: string) => (!/[\s#"'=`]/.test(v) ? v : !v.includes("'") ? `'${v}'` : !v.includes("`") ? `\`${v}\`` : `"${v}"`);

/** Keeps the comments and order of .env.example, fills in every value, and keeps settings the template does not have. */
function writeEnv(values: Record<string, string>): void {
  const written = new Set<string>();
  const lines = readFileSync(TEMPLATE_FILE, "utf8").split("\n").map(line => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (!m || values[m[1]] === undefined) return line;
    written.add(m[1]);
    return `${m[1]}=${quote(values[m[1]])}`;
  });
  const extra = Object.keys(values).filter(k => !written.has(k)).map(k => `${k}=${quote(values[k])}`);
  writeFileSync(ENV_FILE, [...lines, ...(extra.length ? ["", "# Other settings", ...extra] : [])].join("\n"), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("Job Change Alert Bot setup. Press Enter to keep a value shown in [brackets].");
  const values = { ...readEnv(TEMPLATE_FILE), ...readEnv(ENV_FILE) };

  values.CRUSTDATA_API_KEY = await crustdataKey(values.CRUSTDATA_API_KEY ?? "");
  values.SLACK_WEBHOOK_URL = await slackWebhook(values.SLACK_WEBHOOK_URL ?? "");
  values.PUBLIC_URL = await publicUrl(values.PUBLIC_URL ?? "", values.PORT || "3000");
  await email(values);
  writeEnv(values);
  rl.close();

  heading("Summary (saved to .env)");
  for (const c of checks) console.log(`  ${c.ok ? "\x1b[32m✓\x1b[0m" : c.optional ? "\x1b[90m·\x1b[0m" : "\x1b[33m✗\x1b[0m"} ${c.label.padEnd(14)} ${c.note}`);
  const ready = checks.find(c => c.label === "Crustdata key")?.ok && checks.find(c => c.label === "Public URL")?.ok;
  console.log(`\n${ready ? "Ready." : "Not ready yet: fix the items marked ✗ above (run npm run setup again)."} Next:
  npm run serve                      start the bot and keep it running
  npm run import -- champions.csv    your CSV or CRM export (see people.sample.csv for the columns)
  npm run test-webhook               check that Crustdata can reach the bot`);
}

main();
