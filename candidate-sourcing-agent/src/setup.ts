/**
 * Guided setup: `npm run setup`.
 *
 * Asks for the Crustdata API key and checks it with two free calls (credit balance, and what the key can use: skills
 * in search results, research records, contact data). Optionally takes an Anthropic or OpenAI key for the "why this
 * candidate" sentence. Writes `.env` from `.env.example`. Safe to run again: current values are offered as defaults.
 */

import "./node-check.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";
import { CrustdataError, accountEndpoints, creditBalance, type Endpoint } from "./crustdata.js";
import { LIST_PRICE, buildConditions, estimateCost, mergeSpec, pricesFrom } from "./role.js";
import { NO_CONTACT_ACCESS, contactAccess } from "./contacts.js";

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
    console.log("\nSetup cancelled.");
    process.exit(1);
  }
  return answer.trim() || current;
}

const yes = async (q: string) => /^y(es)?$/i.test(await ask(`${q} (y/N)`));
const mask = (secret: string) => (secret.length > 8 ? `${secret.slice(0, 4)}...${secret.slice(-4)}` : "set");
const heading = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`);

type Check = { label: string; ok: boolean; note: string; optional?: boolean };
const checks: Check[] = [];

/** What the key can use, read from /account/endpoints. Pure, so it is tested. */
export function capabilities(endpoints: Endpoint[]) {
  const search = endpoints.find(e => e.path === "/person/search");
  const enabled = new Set(search?.fields?.enabled ?? []);
  return {
    search: search?.status === "enabled",
    skills: enabled.has("skills") || enabled.has("skills.professional_network_skills"),
    research: enabled.has("research_profiles"),
    contacts: contactAccess(endpoints, ["contact.personal_emails"]),
    workEmail: contactAccess(endpoints, ["contact.business_emails"]),
    phone: contactAccess(endpoints, ["contact.phone_numbers"]),
  };
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
      // The README example, priced with this account's own rates.
      const example = mergeSpec({ role: "x", name: "x", must: ["PyTorch"], years: [4, null], sizes: ["51-200"], limit: 20 });
      const cost = estimateCost(example, buildConditions(example), [1, 2], pricesFrom(endpoints));
      const list = estimateCost(example, buildConditions(example), [1, 2], LIST_PRICE);
      checks.push({ label: "Your price", ok: true, note: `about ${Math.round(cost.credits * 10) / 10} credits for 20 candidates in the README example (${Math.round(list.credits)} at list price)` });
      checks.push({ label: "Person search", ok: can.search, note: can.search ? "enabled" : "not enabled on this key: ask Crustdata" });
      checks.push({ label: "Skills", ok: can.skills, optional: !can.skills, note: can.skills ? "returned in results (scored)" : "not returned on this key: skills are still filtered on, and scored from what people wrote" });
      checks.push({ label: "Research", ok: can.research, optional: true, note: can.research ? "enabled (--papers)" : "not enabled (--papers needs it; ask Crustdata)" });
      const kinds = [can.contacts && "personal email", can.workEmail && "work email", can.phone && "phone"].filter(Boolean);
      checks.push({ label: "Contacts", ok: !!kinds.length, optional: true, note: kinds.length ? `enabled: ${kinds.join(", ")} (npm run contacts)` : NO_CONTACT_ACCESS.split(" Ask")[0] });
      return key;
    } catch (err) {
      const rejected = err instanceof CrustdataError && (err.status === 401 || err.status === 403);
      console.log(rejected ? "Crustdata rejected that key. Copy it again from https://app.crustdata.com, or press Ctrl+C to stop." : `${(err as Error).message} (Ctrl+C stops setup.)`);
      if (await yes("Save it anyway?")) { checks.push({ label: "Crustdata key", ok: false, note: "saved but not verified" }); return key; }
    }
  }
}

async function aiKey(values: Record<string, string>): Promise<void> {
  heading("2/2  AI key for the \"why this candidate\" sentence (optional)");
  console.log(`Scoring never uses AI. With a key and --ai, each shortlisted person also gets one sentence written from their record.
Press Enter to skip.`);
  if (!values.ANTHROPIC_API_KEY && !values.OPENAI_API_KEY && !(await yes("Add an Anthropic or OpenAI key?"))) {
    checks.push({ label: "AI sentence", ok: false, optional: true, note: "off (optional)" });
    return;
  }
  values.ANTHROPIC_API_KEY = await ask("Anthropic API key (Enter to skip)", { hidden: true, current: values.ANTHROPIC_API_KEY });
  if (!values.ANTHROPIC_API_KEY) {
    values.OPENAI_API_KEY = await ask("OpenAI API key (Enter to skip)", { hidden: true, current: values.OPENAI_API_KEY });
    if (values.OPENAI_API_KEY) values.OPENAI_MODEL = await ask("OpenAI model to use (the id from your OpenAI account)", { current: values.OPENAI_MODEL });
  }
  const on = values.ANTHROPIC_API_KEY ? "Anthropic" : values.OPENAI_API_KEY && values.OPENAI_MODEL ? "OpenAI" : "";
  checks.push({ label: "AI sentence", ok: !!on, optional: !on, note: on ? `${on}, used only with --ai` : "off (an OpenAI key also needs OPENAI_MODEL)" });
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

const quote = (v: string) => (!/[\s#"'=`]/.test(v) ? v : !v.includes("'") ? `'${v}'` : `"${v}"`);

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
  rl = createInterface({ input: process.stdin, output, terminal: tty });
  console.log("Candidate Sourcing Agent setup. Press Enter to keep a value shown in [brackets].");
  const values = { ...readEnv(ENV_FILE) };
  values.CRUSTDATA_API_KEY = await crustdataKey(values.CRUSTDATA_API_KEY ?? "");
  await aiKey(values);
  writeEnv(values);
  rl.close();

  heading("Summary (saved to .env)");
  for (const c of checks) console.log(`  ${c.ok ? "\x1b[32m✓\x1b[0m" : c.optional ? "\x1b[90m·\x1b[0m" : "\x1b[33m✗\x1b[0m"} ${c.label.padEnd(14)} ${c.note}`);
  const ready = checks.find(c => c.label === "Crustdata key")?.ok && checks.find(c => c.label === "Person search")?.ok;
  console.log(ready
    ? `\nReady. Next, see what a search would do and cost (spends nothing), then run it without --dry-run:
  npm run source -- --role "Machine learning engineer, 4+ years, PyTorch, United States, at a company under 500 people" --dry-run`
    : "\nNot ready yet: fix the items marked ✗ above and run npm run setup again.");
}

if (process.argv[1] && /setup\.ts$/.test(process.argv[1])) main();
