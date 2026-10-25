/**
 * Guided setup: `npm run setup`.
 *
 * Asks for the Crustdata API key, checks it with free calls (credit balance, which endpoints the key can use, and a
 * free email lookup probe), and writes `.env` from `.env.example`. Safe to run again: current values are offered.
 */

import "./node-check.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";
import { CrustdataError, accountEndpoints, creditBalance, identifyEmails, type Endpoint } from "./crustdata.js";

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
  const listed = (path: string) => endpoints.some(e => e.path === path);
  return [
    { label: "Profiles", ok: on("/person/enrich"), note: on("/person/enrich") ? "enabled (/person/enrich)" : "not enabled: every brief needs /person/enrich, ask Crustdata" },
    { label: "Name lookup", ok: on("/person/search"), optional: true, note: on("/person/search") ? "enabled (--name)" : "not enabled: use profile URLs or emails instead of --name" },
    { label: "Posts", ok: on("/social_post/search"), optional: true, note: on("/social_post/search") ? "enabled (Recent posts)" : listed("/social_post/search") ? "not enabled on this key: briefs go without posts (ask Crustdata)" : "not listed for this key: briefs go without posts" },
    { label: "News and web", ok: on("/web/search/live"), optional: true, note: on("/web/search/live") ? "enabled (In the news and on the web)" : "not enabled: briefs go without news and web results" },
    { label: "Contacts", ok: on("/person/contact/enrich"), optional: true, note: on("/person/contact/enrich") ? "enabled (--contact)" : "not enabled: contact data needs enabling on your Crustdata account; self-serve keys do not have it" },
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
      const balance = credits !== undefined ? `${Math.floor(credits).toLocaleString("en-US")} credits (about ${Math.floor(credits / 6.5).toLocaleString("en-US")} to ${Math.floor(credits / 5.5).toLocaleString("en-US")} briefs at list price)` : "balance unknown";
      checks.push({ label: "Crustdata key", ok: true, note: balance });
      checks.push(...capabilities(await accountEndpoints()));
      // Email lookup is enabled per account and not listed in /account/endpoints: probe it with an address that
      // matches nobody, which is free.
      try {
        await identifyEmails(["setup-probe-no-such-person@crustdata.com"]);
        checks.push({ label: "Any email", ok: true, note: "enabled (personal emails and name at the company domain, /person/identify)" });
      } catch (err) {
        const no = err instanceof CrustdataError && err.status === 403;
        checks.push({ label: "Any email", ok: false, optional: true, note: no ? "work emails only (/person/identify is not enabled on this key)" : `could not check: ${(err as Error).message}` });
      }
      return key;
    } catch (err) {
      const rejected = err instanceof CrustdataError && (err.status === 401 || err.status === 403);
      console.log(rejected ? "Crustdata rejected that key. Copy it again from https://app.crustdata.com, or press Ctrl+C to stop." : `${(err as Error).message} (Ctrl+C stops setup.)`);
      if (await yes("Save it anyway?")) { checks.push({ label: "Crustdata key", ok: false, note: "saved but not verified" }); return key; }
    }
  }
}

/** .env as Node reads it: quoted values kept as written, unquoted values end at " #" (a comment). */
export function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const v = m[2];
    const q = /^(['"`])(.*?)\1(?:\s+#.*)?$/.exec(v);
    values[m[1]] = q ? (q[1] === '"' ? q[2].replace(/\\n/g, "\n") : q[2]) : v.replace(/#.*$/, "").trim();
  }
  return values;
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
  console.log("Person Researcher setup. Press Enter to keep a value shown in [brackets].");
  const values = { ...readEnv(ENV_FILE) };
  const checks: Check[] = [];
  values.CRUSTDATA_API_KEY = await crustdataKey(values.CRUSTDATA_API_KEY ?? "", checks);
  console.log(`\n${color("1", "2/2  Your own company (optional)")}`);
  console.log("Attendees at your company's email domains are skipped and cost nothing. Comma-separated, Enter to skip.");
  values.SKIP_DOMAINS = (await ask("Your company's email domains (e.g. acme.com)", { current: values.SKIP_DOMAINS ?? "" })).replace(/\s+/g, "");
  checks.push({ label: "Skip domains", ok: !!values.SKIP_DOMAINS, optional: true, note: values.SKIP_DOMAINS ? `attendees at ${values.SKIP_DOMAINS} are skipped` : "none (your own colleagues would be researched too)" });
  finished = true;
  writeFileSync(ENV_FILE, envText(readFileSync(TEMPLATE_FILE, "utf8"), values), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  rl.close();

  console.log(`\n${color("1", "Summary (saved to .env)")}`);
  for (const c of checks) console.log(`  ${c.ok ? color("32", "✓") : c.optional ? color("90", "·") : color("33", "✗")} ${c.label.padEnd(14)} ${c.note}`);
  const ready = checks.find(c => c.label === "Crustdata key")?.ok && checks.find(c => c.label === "Profiles")?.ok;
  console.log(ready
    ? `\nReady. Research someone (5.5 to 6.5 credits at list price; --dry-run shows the most and spends nothing):
  npm run research -- jane@acme.com
  npm run research -- --name "Jane Doe" --company acme.com`
    : "\nNot ready yet: fix the items marked ✗ above and run npm run setup again.");
  process.exitCode = ready ? 0 : 1;
}

if (process.argv[1] && /setup\.ts$/.test(process.argv[1])) main();
