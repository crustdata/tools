/**
 * Guided setup: `npm run setup`.
 *
 * Asks for the Crustdata API key, checks it with free calls (credit balance and which endpoints the key can use),
 * optionally takes your own AI key for --ai, and writes `.env` from `.env.example`. Safe to run again: current
 * values are offered.
 */

import "./node-check.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";
import { CrustdataError, accountEndpoints, creditBalance, type Endpoint } from "./crustdata.js";
import { isEntryPoint } from "./entry.js";
import { parseEnv } from "node:util";

const ENV_FILE = resolve(ROOT, ".env");
const TEMPLATE_FILE = resolve(ROOT, ".env.example");

let muted = false;
let finished = false;
const color = (code: string, text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
const tty = Boolean(process.stdin.isTTY);
let rl: ReturnType<typeof createInterface>;

/** Without a terminal (answers piped in), every line is read up front and answers are taken in order. */
let piped: string[] | undefined;

async function ask(question: string, { hidden = false, current = "" } = {}): Promise<string> {
  const prompt = `${question}${current ? ` [${hidden ? mask(current) : current}]` : ""}: `;
  let answer: string;
  if (piped) {
    process.stdout.write(prompt);
    if (!piped.length) {
      console.log("\nSetup needs answers it did not get (the input ended). Nothing was saved. Run npm run setup in a terminal, or copy .env.example to .env and fill it in.");
      process.exit(1);
    }
    answer = piped.shift()!;
    process.stdout.write(hidden ? "(hidden)\n" : `${answer}\n`);
    return answer.trim() || current;
  }
  try {
    if (hidden && tty) {
      process.stdout.write(prompt);
      muted = true;
      answer = await rl.question("");
      muted = false;
      process.stdout.write("\n");
    } else answer = await rl.question(prompt);
  } catch {
    console.log("\nSetup cancelled. Nothing was saved.");
    process.exit(1);
  }
  return answer.trim() || current;
}

const yes = async (q: string) => /^y(es)?$/i.test(await ask(`${q} (y/N)`));
const mask = (secret: string) => (secret.length > 8 ? `${secret.slice(0, 4)}...${secret.slice(-4)}` : "set");

export type Check = { label: string; ok: boolean; note: string; optional?: boolean };

/** What the key can use, from /account/endpoints. Pure, so it is tested. */
export function capabilities(endpoints: Endpoint[]): Check[] {
  const on = (path: string) => endpoints.find(e => e.path === path)?.status === "enabled";
  return [
    { label: "Company data", ok: on("/company/enrich"), note: on("/company/enrich") ? "enabled (/company/enrich)" : "not enabled: every memo needs /company/enrich, ask Crustdata" },
    { label: "Former staff", ok: on("/person/search"), optional: true, note: on("/person/search") ? "enabled (departures, /person/search)" : "not enabled: memos go without departures" },
    { label: "Job postings", ok: on("/job/search"), optional: true, note: on("/job/search") ? "enabled (hiring, /job/search)" : "not enabled: memos go without hiring" },
    { label: "Peers", ok: on("/company/search"), optional: true, note: on("/company/search") ? "enabled (peer table, /company/search)" : "not enabled: memos go without peers" },
  ];
}

async function crustdataKey(current: string, checks: Check[]): Promise<string> {
  console.log(`\n${color("1", "1/2  Crustdata API key")}`);
  console.log("Find it at https://app.crustdata.com under API keys (new accounts get free credits).");
  while (true) {
    const key = await ask(`Paste your Crustdata API key${tty ? " (it stays hidden as you paste)" : ""}`, { hidden: true, current });
    if (!key) { console.log("A Crustdata API key is required."); continue; }
    process.env.CRUSTDATA_API_KEY = key;
    try {
      const credits = await creditBalance();
      const balance = credits !== undefined ? `${Math.floor(credits).toLocaleString("en-US")} credits (about ${Math.floor(credits / 12).toLocaleString("en-US")} to ${Math.floor(credits / 5).toLocaleString("en-US")} memos at list price)` : "balance unknown";
      checks.push({ label: "Crustdata key", ok: true, note: balance });
      checks.push(...capabilities(await accountEndpoints()));
      return key;
    } catch (err) {
      const rejected = err instanceof CrustdataError && (err.status === 401 || err.status === 403);
      console.log(rejected ? "Crustdata rejected that key. Copy it again from https://app.crustdata.com, or press Ctrl+C and try npm run replay -- fixtures/fast-grower.json, which needs no key." : `${(err as Error).message} (Ctrl+C stops setup.)`);
      if (await yes("Save it anyway?")) { checks.push({ label: "Crustdata key", ok: false, note: "saved but not verified" }); return key; }
    }
  }
}

/** .env exactly as Node reads it (util.parseEnv), so setup keeps every value the tool itself would see. */
export function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return { ...parseEnv(readFileSync(file, "utf8")) } as Record<string, string>;
}

/**
 * A value Node's .env reader reads back unchanged: bare when plain, else in single quotes, else backticks, else
 * double quotes (where Node turns \n into a line break, so only when the value has none). Anything else is refused.
 */
export const quote = (v: string): string => {
  if (!/[\s#"'=`$\\]/.test(v)) return v;
  if (!v.includes("'") && !v.includes("\n")) return `'${v}'`;
  if (!v.includes("`") && !v.includes("\n")) return `\`${v}\``;
  if (!v.includes('"') && !v.includes("\\n") && !v.includes("\n")) return `"${v}"`;
  throw new Error("This value mixes quote marks in a way .env cannot hold. Set it in your shell instead.");
};

/** Keeps the comments and order of .env.example, fills in every value, and keeps settings the template does not have. */
export function envText(template: string, values: Record<string, string>): string {
  const written = new Set<string>();
  const lines = template.split("\n").map(line => {
    const m = /^#?\s*([A-Z0-9_]+)=/.exec(line);
    if (!m || values[m[1]] === undefined || values[m[1]] === "") return line;
    written.add(m[1]);
    return `${m[1]}=${quote(values[m[1]])}`;
  });
  const extra = Object.keys(values).filter(k => !written.has(k) && values[k] !== "" && !new RegExp(`^#?\\s*${k}=`, "m").test(lines.join("\n"))).map(k => `${k}=${quote(values[k])}`);
  return [...lines, ...(extra.length ? ["", "# Other settings", ...extra] : [])].join("\n");
}

async function main() {
  if (!tty) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    piped = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  }
  rl = createInterface({ input: tty ? process.stdin : new (await import("node:stream")).PassThrough(), output, terminal: tty });
  rl.on("close", () => {
    if (finished) return;
    console.log("\nSetup needs answers it did not get (no terminal, or the input ended). Nothing was saved. Run npm run setup in a terminal, or copy .env.example to .env and fill it in.");
    process.exit(1);
  });
  console.log("Private company research agent setup. Press Enter to keep a value shown in [brackets].");
  const values = { ...readEnv(ENV_FILE) };
  const checks: Check[] = [];
  values.CRUSTDATA_API_KEY = await crustdataKey(values.CRUSTDATA_API_KEY ?? "", checks);
  console.log(`\n${color("1", "2/2  Your own AI key (optional, off by default)")}`);
  console.log("Only for --ai, which adds a short analyst note to each memo. Everything else works without it. Enter to skip.");
  const ai = await ask(`Anthropic or OpenAI API key${tty ? " (hidden)" : ""}`, { hidden: true, current: values.ANTHROPIC_API_KEY || values.OPENAI_API_KEY || "" });
  if (ai && !/^sk-/.test(ai)) console.log("That does not look like an Anthropic (sk-ant-...) or OpenAI (sk-...) key; saved anyway.");
  if (ai.startsWith("sk-ant-")) { values.ANTHROPIC_API_KEY = ai; delete values.OPENAI_API_KEY; }
  else if (ai) { values.OPENAI_API_KEY = ai; delete values.ANTHROPIC_API_KEY; }
  checks.push({ label: "AI note", ok: !!ai, optional: true, note: ai ? `key saved (${ai.startsWith("sk-ant-") ? "Anthropic" : "OpenAI"}); add --ai to a run to use it` : "no key: memos are rule-based only (the default)" });
  finished = true;
  writeFileSync(ENV_FILE, envText(readFileSync(TEMPLATE_FILE, "utf8"), values), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  rl.close();

  console.log(`\n${color("1", "Summary (saved to .env)")}`);
  for (const c of checks) console.log(`  ${c.ok ? color("32", "✓") : c.optional ? color("90", "·") : color("33", "✗")} ${c.label.padEnd(14)} ${c.note}`);
  const ready = checks.find(c => c.label === "Crustdata key")?.ok && checks.find(c => c.label === "Company data")?.ok;
  console.log(ready
    ? `\nReady. Research a company (about 5 to 13 credits at list price, at most 13.23; --dry-run spends nothing):
  npm run research -- acme.com
  npm run research -- inbound-deals.csv`
    : "\nNot ready yet: fix the items marked ✗ above and run npm run setup again.");
  process.exitCode = ready ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) main();
