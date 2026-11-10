/**
 * Guided setup: `npm run setup`.
 *
 * Asks for the Crustdata API key and checks it with free calls: credit balance, what the key can use (research
 * records in search, Google Scholar and profile URL lookups, GitHub lookups) and its prices. Optionally takes an
 * Anthropic key for --ai. Writes `.env` from `.env.example`. Safe to run again: current values are offered as defaults.
 */

import "./node-check.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { ROOT } from "./config.js";
import { estimate, LIST_PRICE, pricesFrom } from "./cost.js";
import { accountEndpoints, canIdentify, creditBalance, CrustdataError, type Endpoint } from "./crustdata.js";

const ENV_FILE = resolve(ROOT, ".env");
const TEMPLATE_FILE = resolve(ROOT, ".env.example");

let muted = false;
const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
const tty = Boolean(process.stdin.isTTY);
let rl: ReturnType<typeof createInterface>;

/** Without a terminal (input piped in), every answer is read up front, one per line. */
let queued: string[] | undefined;

async function ask(question: string, { hidden = false, current = "" } = {}): Promise<string> {
  const prompt = `${question}${current ? ` [${hidden ? mask(current) : current}]` : ""}: `;
  let answer: string;
  if (queued) {
    if (!queued.length) { console.log(`${prompt}\nSetup cancelled: the input ended before setup was done.`); process.exit(1); }
    answer = queued.shift()!;
    console.log(`${prompt}${hidden ? (answer ? mask(answer) : "") : answer}`);
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
    console.log("\nSetup cancelled.");
    process.exit(1);
  }
  return answer.trim() || current;
}

const yes = async (q: string) => /^y(es)?$/i.test(await ask(`${q} (y/N)`));
const mask = (secret: string) => (secret.length > 8 ? `${secret.slice(0, 4)}...${secret.slice(-4)}` : "set");
const color = Boolean(process.stdout.isTTY);
const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const heading = (text: string) => console.log(`\n${paint("1", text)}`);

type Check = { label: string; ok: boolean; note: string; optional?: boolean };
const checks: Check[] = [];

/** What the key can use, read from /account/endpoints. Pure, so it is tested. */
export function capabilities(endpoints: Endpoint[]) {
  const search = endpoints.find(e => e.path === "/person/search");
  const enabled = new Set(search?.fields?.enabled ?? []);
  return {
    search: search?.status === "enabled",
    research: enabled.has("research_profiles"),
    github: endpoints.find(e => e.path === "/dev_platform/enrich")?.status === "enabled",
  };
}

/** The README example (25 people across the frontier labs), priced for this account. */
export function exampleCost(endpoints: Endpoint[]) {
  const plan = { searches: [{ label: "x", people: 25, filters: ["experience" as const] }], scholar: 0, profiles: 0, github: 0, papers: 0, perPaper: 0 };
  return { yours: estimate(plan, pricesFrom(endpoints)).ceiling, list: estimate(plan, LIST_PRICE).ceiling };
}

async function crustdataKey(current: string): Promise<string> {
  heading("1/2  Crustdata API key");
  console.log("Find it at https://app.crustdata.com under API keys (new accounts get free credits).");
  while (true) {
    const key = await ask("Paste your Crustdata API key", { hidden: true, current });
    if (!key) { console.log("A Crustdata API key is required."); continue; }
    process.env.CRUSTDATA_API_KEY = key;
    try {
      const credits = await creditBalance();
      const balance = credits !== undefined ? `${Math.floor(credits).toLocaleString("en-US")} credits` : "balance unknown";
      console.log(`Key works (${balance}).`);
      checks.push({ label: "Crustdata key", ok: true, note: balance });
      const endpoints = await accountEndpoints();
      const can = capabilities(endpoints);
      const cost = exampleCost(endpoints);
      checks.push({ label: "Your price", ok: true, note: `at most ${cost.yours} credits for 25 people in the README example (${cost.list} at list price)` });
      checks.push({ label: "Person search", ok: can.search, note: can.search ? "enabled" : "not enabled on this key: ask Crustdata" });
      checks.push({ label: "Research", ok: can.research, optional: !can.research, note: can.research ? "enabled: papers, citations, h-index, co-authors" : "not enabled: people are found and scored without papers (ask Crustdata)" });
      const identify = await canIdentify();
      checks.push({ label: "Scholar URLs", ok: identify, optional: !identify, note: identify ? "enabled (--scholar, --profile, --from)" : "not enabled: Google Scholar and profile URL seeds are skipped (ask Crustdata)" });
      checks.push({ label: "GitHub URLs", ok: can.github, optional: !can.github, note: can.github ? "enabled (--github), 1 credit a lookup" : "not enabled: GitHub seeds are skipped (enterprise plans)" });
      return key;
    } catch (err) {
      const status = err instanceof CrustdataError ? err.status : 0;
      console.log(status === 401 ? "Crustdata rejected that key (401). Copy it again from https://app.crustdata.com, or press Ctrl+C to stop."
        : status === 403 ? "Crustdata accepted the key but refused access (403): ask Crustdata to enable person search for your account. (Ctrl+C stops setup.)"
        : `${(err as Error).message} (Ctrl+C stops setup.)`);
      if (await yes("Save it anyway?")) {
        checks.push({ label: "Crustdata key", ok: false, note: status === 401 ? "rejected by Crustdata (401); saved anyway" : status === 403 ? "no access (403); saved anyway" : "could not be checked; saved anyway" });
        return key;
      }
    }
  }
}

async function aiKey(values: Record<string, string>): Promise<void> {
  heading("2/2  Anthropic key for --ai (optional)");
  console.log(`Scoring works without AI. With a key and --ai, Claude also answers the free-text questions in rubric.json
from each person's record (never their name or links). Press Enter to skip.`);
  if (!values.ANTHROPIC_API_KEY && !(await yes("Add an Anthropic key?"))) {
    checks.push({ label: "Claude (--ai)", ok: false, optional: true, note: "off (optional)" });
    return;
  }
  values.ANTHROPIC_API_KEY = await ask("Anthropic API key (Enter to skip)", { hidden: true, current: values.ANTHROPIC_API_KEY });
  const on = !!values.ANTHROPIC_API_KEY;
  checks.push({ label: "Claude (--ai)", ok: on, optional: !on, note: on ? "saved, not checked; used only with --ai" : "off (optional)" });
}

/** Reads .env the way Node's own loader does (quotes, comments, `export`), so a saved value round-trips. */
function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return { ...parseEnv(readFileSync(file, "utf8")) } as Record<string, string>;
}

/** A value Node's .env loader reads back unchanged; a value with both quote kinds cannot be written safely. */
const quote = (v: string) => {
  if (v.includes("'") && v.includes('"')) throw new Error("A value with both ' and \" cannot be saved to .env; set it in your shell instead.");
  return !/[\s#"'=`]/.test(v) ? v : !v.includes("'") ? `'${v}'` : `"${v}"`;
};

/** Keeps the comments and order of .env.example, fills in every value, and keeps settings the template does not have. */
function writeEnv(values: Record<string, string>): void {
  const written = new Set<string>();
  const lines = readFileSync(TEMPLATE_FILE, "utf8").split("\n").map(line => {
    const m = /^#?\s*([A-Z0-9_]+)=/.exec(line);
    if (!m || values[m[1]] === undefined || values[m[1]] === "") return line;
    written.add(m[1]);
    return `${m[1]}=${quote(values[m[1]])}`;
  });
  const extra = Object.keys(values).filter(k => !written.has(k) && values[k] !== "" && !new RegExp(`^#?\\s*${k}=`, "m").test(lines.join("\n"))).map(k => `${k}=${quote(values[k])}`);
  writeFileSync(ENV_FILE, [...lines, ...(extra.length ? ["", "# Other settings", ...extra] : [])].join("\n"), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

async function main() {
  let finished = false;
  if (tty) {
    rl = createInterface({ input: process.stdin, output, terminal: tty });
    // Ctrl+D before setup is done cancels it with a non-zero exit.
    rl.on("close", () => { if (!finished) { console.log("\nSetup cancelled."); process.exit(1); } });
  } else {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    queued = text.split(/\r?\n/);
  }
  console.log("AI Researcher Finder setup. Press Enter to keep a value shown in [brackets].");
  const values = { ...readEnv(ENV_FILE) };
  values.CRUSTDATA_API_KEY = await crustdataKey(values.CRUSTDATA_API_KEY ?? "");
  await aiKey(values);
  writeEnv(values);
  finished = true;
  rl?.close();

  heading("Summary (saved to .env)");
  for (const c of checks) console.log(`  ${c.ok ? paint("32", "✓") : c.optional ? paint("90", "·") : paint("33", "✗")} ${c.label.padEnd(14)} ${c.note}`);
  const ready = checks.find(c => c.label === "Crustdata key")?.ok && checks.find(c => c.label === "Person search")?.ok;
  console.log(ready
    ? `\nReady. Next, see the plan and the most it can cost (spends nothing), then run it without --dry-run:
  npm run find -- --labs frontier --dry-run`
    : "\nNot ready yet: fix the items marked ✗ above and run npm run setup again.");
  if (!ready) process.exitCode = 1;
}

if (process.argv[1] && /setup\.ts$/.test(process.argv[1])) main();
