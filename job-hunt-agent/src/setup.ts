/**
 * Guided setup: `npm run setup`.
 *
 *   1. Crustdata API key: checked with free calls (credit balance, and whether work emails are enabled)
 *   2. Your CV: found in this folder or a path you give; shows the skills, school and years it read
 *   3. Your search: titles, place, radius, remote, visa sponsorship
 *
 * Writes `.env` (the key, owner-only) and `profile.json` (the search, plain JSON you can edit). Safe to run again:
 * current values are offered in [brackets]. Then a free count shows how many jobs match.
 */

import "./node-check.js";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { config, ROOT } from "./config.js";
import { accountEndpoints, countJobs, creditBalance, CrustdataError } from "./crustdata.js";
import { parseCv, readCvText, type CvFacts } from "./cv.js";
import { jobFilters, KNOWN_SCHOOLS } from "./hunt.js";
import { DEFAULTS, readProfileFile, resolveProfile, type Profile } from "./profile.js";

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
  if (piped) {
    process.stdout.write(prompt);
    if (!piped.length) {
      console.log("\nSetup needs answers it did not get (the input ended). Nothing was saved. Run npm run setup in a terminal.");
      process.exit(1);
    }
    const a = piped.shift()!;
    process.stdout.write(hidden ? "(hidden)\n" : `${a}\n`);
    return a.trim() || current;
  }
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
    console.log("\nSetup cancelled. Nothing was saved.");
    process.exit(1);
  }
  return answer.trim() || current;
}

const yesNo = async (q: string, current: boolean) => {
  const a = await ask(`${q} (y/n)`, { current: current ? "y" : "n" });
  return /^y(es)?$/i.test(a);
};
const mask = (secret: string) => (secret.length > 8 ? `${secret.slice(0, 4)}...${secret.slice(-4)}` : "set");

type Check = { label: string; ok: boolean; note: string; optional?: boolean };

/**
 * A path as people type or paste it: quotes around it, "\ " from dragging a file into Terminal, "~/" for home.
 * Relative paths are taken from where npm was run.
 */
export function cleanPath(answer: string, cwd = process.env.INIT_CWD || ROOT): string {
  let p = answer.trim();
  if (/^(['"]).*\1$/.test(p)) p = p.slice(1, -1);
  if (/^file:\/\//i.test(p)) { try { p = fileURLToPath(p); } catch { /* keep as typed */ } }
  // Drag-and-drop escapes ("My\\ CV.pdf"); a Windows path ("C:\\Users\\me") is left alone.
  if (process.platform !== "win32") p = p.replace(/\\([ ()&'"!\[\]$#;{}*?<>|`~])/g, "$1");
  if (p === "~" || p.startsWith("~/")) p = resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

async function crustdataKey(current: string, checks: Check[]): Promise<string> {
  console.log(`\n${color("1", "1/3  Crustdata API key")}`);
  console.log("Find it at https://app.crustdata.com under API keys (new accounts get free credits).");
  while (true) {
    const key = await ask(`Paste your Crustdata API key${tty ? " (it stays hidden as you paste)" : ""}`, { hidden: true, current });
    if (!key) { console.log("A Crustdata API key is required."); continue; }
    process.env.CRUSTDATA_API_KEY = key;
    try {
      const credits = await creditBalance();
      checks.push({ label: "Crustdata key", ok: true, note: credits !== undefined ? `${Math.floor(credits).toLocaleString("en-US")} credits (a default run is about 18 at list price; --dry-run shows yours)` : "works" });
      const endpoints = await accountEndpoints().catch(() => []);
      const on = (p: string) => endpoints.find(e => e.path === p)?.status === "enabled";
      for (const [label, path] of [["Job search", "/job/search"], ["People search", "/person/search"], ["Company search", "/company/search"]] as const) {
        if (endpoints.length && !on(path)) checks.push({ label, ok: false, note: `not enabled on this key (${path}); ask Crustdata to enable it` });
      }
      checks.push({ label: "Work emails", ok: on("/person/contact/enrich"), optional: true, note: on("/person/contact/enrich") ? "enabled (--emails)" : "not enabled: contact data needs enabling on your Crustdata account; self-serve keys do not have it. Profile URLs work without it." });
      return key;
    } catch (err) {
      const rejected = err instanceof CrustdataError && (err.status === 401 || err.status === 403);
      console.log(rejected ? "Crustdata rejected that key. Copy it again from https://app.crustdata.com, or press Ctrl+C to stop." : `${(err as Error).message} (Ctrl+C stops setup.)`);
      if (await yesNo("Save it anyway?", false)) { checks.push({ label: "Crustdata key", ok: false, note: "saved but not verified" }); return key; }
    }
  }
}

async function cvStep(current: string, checks: Check[]): Promise<{ path: string; facts: CvFacts | null }> {
  console.log(`\n${color("1", "2/3  Your CV")}`);
  console.log("Markdown, plain text or PDF. It is read on this computer and never sent anywhere; only your search goes to Crustdata.");
  const found = ["cv.md", "cv.pdf", "cv.txt", "resume.pdf", "resume.md"].find(f => existsSync(resolve(ROOT, f)));
  let suggestion = current && existsSync(isAbsolute(current) ? current : resolve(ROOT, current)) ? current : found ?? "";
  while (true) {
    const answer = await ask(`Path to your CV (you can drag the file into this window)${suggestion ? "" : "; or try examples/cv-example.md"}`, { current: suggestion });
    if (!answer) { console.log("A CV is needed for the fit score. Use examples/cv-example.md to try the tool first."); continue; }
    const abs = cleanPath(answer);
    try {
      const facts = parseCv(await readCvText(abs));
      console.log(`Read: ${facts.years !== null ? `${facts.years} years of experience` : "no dates found"}; ${facts.skills.length} skills (${facts.skills.slice(0, 10).join(", ")}${facts.skills.length > 10 ? ", ..." : ""}); ${facts.schools.length ? `school: ${facts.schools.join("; ")}` : "no school found"}.`);
      checks.push({ label: "CV", ok: true, note: `${facts.skills.length} skills, ${facts.years ?? "?"} years, ${facts.schools.length ? facts.schools.join("; ") : "no school"}` });
      const rel = relative(ROOT, abs);
      return { path: rel.startsWith("..") ? abs : rel, facts };
    } catch (err) {
      // The reader's own advice talks about flags; here, setup simply asks again.
      const msg = (err as Error).message.replace(/ Put your CV in this folder.*$/, " Type the path again, or drag the file into this window.");
      console.log(msg);
      suggestion = "";
    }
  }
}

async function searchStep(p: Partial<Profile>, facts: CvFacts | null): Promise<Partial<Profile>> {
  console.log(`\n${color("1", "3/3  Your search")}`);
  const list = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);
  let titles: string[] = [];
  while (!titles.length) {
    titles = list(await ask("Job titles, comma-separated (e.g. software engineer, backend engineer)", { current: (p.titles ?? []).join(", ") }));
    if (!titles.length) console.log("At least one job title is needed, for example: software engineer, backend engineer");
  }
  const remoteOnly = await yesNo("Remote jobs only?", p.remote === "only");
  let location = p.location ?? "";
  let remote: Profile["remote"] = remoteOnly ? "only" : "no";
  let radiusMiles = p.radiusMiles ?? DEFAULTS.radiusMiles;
  if (!remoteOnly) {
    location = "";
    while (!location) {
      location = await ask("City or area (e.g. San Francisco, Austin, London)", { current: p.location ?? "" });
      if (!location) console.log("A city or area is needed (or answer y to remote only).");
    }
    for (;;) {
      const m = /\d+/.exec(await ask("Within how many miles", { current: String(radiusMiles) }));
      const n = m ? Number(m[0]) : NaN;
      if (n >= 1 && n <= 300) { radiusMiles = n; break; }
      console.log("Type a number of miles from 1 to 300, e.g. 25");
    }
    remote = (await yesNo("Also include remote jobs?", p.remote === "also")) ? "also" : "no";
  }
  const country = await ask("Country (for remote jobs and people)", { current: p.country ?? DEFAULTS.country });
  const fromCv = facts?.schools ?? [];
  // School names have commas in them ("University of California, Berkeley"), so several are split by ";".
  let schools = (await ask(`School(s) for the alumni search, several split by ;${fromCv.length ? " (Enter keeps the one from your CV)" : ""}`, { current: (p.schools?.length ? p.schools : fromCv).join("; ") })).split(";").map(x => x.trim()).filter(Boolean);
  // "UW" is Washington and Wisconsin; "Indian Institute of Technology" alone is every IIT campus.
  const short = schools.filter(x => (x.replace(/[^A-Za-z]/g, "").length <= 4 && !KNOWN_SCHOOLS[x.toLowerCase()]) || /^(indian institute of technology|iit|nit|university of california|state university of new york)$/i.test(x.trim()));
  if (short.length) {
    const full = await ask(`"${short[0]}" can match other schools or campuses. Type the full name as it appears on profiles (e.g. University of Washington, IIT Bombay), or press Enter to keep it`);
    if (full) schools = schools.map(x => (x === short[0] ? full : x));
  }
  // Years in the work being applied for: a career changer's earlier years would make notes claim too much.
  let yearsText = "";
  for (;;) {
    yearsText = await ask("Years of experience in the kind of work you are applying for, not other careers or a bootcamp. Draft notes mention years only if you type a number here (Enter keeps the number read from your CV)", { current: p.yearsExperience != null ? String(p.yearsExperience) : facts?.years != null ? String(facts.years) : "" });
    if (!yearsText || (/^\d+(\.\d+)?$/.test(yearsText.trim()) && Number(yearsText) <= 60)) break;
    console.log("Type a number of years, e.g. 0.5 or 3");
  }
  const needsSponsorship = await yesNo("Do you need visa sponsorship?", p.needsSponsorship ?? false);
  return {
    skills: [], skipCompanies: [], skipTitleWords: [],
    ...p, titles, location, radiusMiles, remote, country,
    schools: schools.join(",") === fromCv.join(",") ? [] : schools,
    // A typed number is saved (and notes may mention it); Enter keeps what the CV says, never claimed in notes.
    yearsExperience: !yearsText ? p.yearsExperience ?? null : yearsText === String(facts?.years ?? "") ? null : Number(yearsText),
    needsSponsorship,
  };
}

/** .env as Node reads it: quoted values kept as written, unquoted values end at " #" (a comment). */
export function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const q = /^(['"`])(.*?)\1(?:\s+#.*)?$/.exec(m[2]);
    values[m[1]] = q ? q[2] : m[2].replace(/#.*$/, "").trim();
  }
  return values;
}

/** A value Node's .env reader reads back unchanged. */
export const quote = (v: string): string => {
  if (!/[\s#"'=`$\\]/.test(v)) return v;
  if (!v.includes("'") && !v.includes("\n")) return `'${v}'`;
  if (!v.includes("`") && !v.includes("\n")) return `\`${v}\``;
  throw new Error("This value mixes quote marks in a way .env cannot hold. Set it in your shell instead.");
};

/** Keeps the comments and order of .env.example, fills in values, and keeps settings the template does not have. */
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
    console.log("\nSetup needs answers it did not get. Nothing was saved. Run npm run setup in a terminal.");
    process.exit(1);
  });
  console.log("Job hunt agent setup. Press Enter to keep a value shown in [brackets].");
  const values = { ...readEnv(ENV_FILE) };
  const checks: Check[] = [];
  values.CRUSTDATA_API_KEY = await crustdataKey(values.CRUSTDATA_API_KEY ?? "", checks);
  let saved: Partial<Profile> = {};
  try { saved = readProfileFile(config.profilePath); } catch (err) { console.log(`${(err as Error).message} Starting a new one.`); }
  const cv = await cvStep(saved.cv ?? "", checks);
  const profile = await searchStep({ ...saved, cv: cv.path }, cv.facts);
  finished = true;
  rl.close();

  writeFileSync(ENV_FILE, envText(readFileSync(TEMPLATE_FILE, "utf8"), values), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  writeFileSync(config.profilePath, `${JSON.stringify(profile, null, 2)}\n`);

  try {
    const full = resolveProfile(profile, {});
    const n = await countJobs(jobFilters(full));
    checks.push({ label: "Search", ok: n > 0, note: `${n.toLocaleString("en-US")} jobs posted in the last ${full.days} days match (free count)` });
  } catch (err) {
    checks.push({ label: "Search", ok: false, note: (err as Error).message });
  }

  console.log(`\n${color("1", "Summary (key saved to .env, search to profile.json)")}`);
  for (const c of checks) console.log(`  ${c.ok ? color("32", "✓") : c.optional ? color("90", "·") : color("33", "✗")} ${c.label.padEnd(14)} ${c.note}`);
  const ready = checks.filter(c => !c.optional).every(c => c.ok);
  console.log(ready
    ? `\nReady. Find jobs with the people to talk to (about 18 credits at list price; --dry-run shows the cost at your prices and spends nothing):
  npm run hunt
  npm run dashboard        then open http://localhost:${config.dashboardPort}
Or try it on one job:      npm run job -- <posting URL>`
    : "\nNot ready yet: fix the items marked ✗ above and run npm run setup again.");
  process.exitCode = ready ? 0 : 1;
}

if (process.argv[1] && /setup\.ts$/.test(process.argv[1])) main();
