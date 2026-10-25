/**
 * npm run research -- <profile URL | email | "Name, Company"> [more people] [flags]
 *
 * One person: the brief is printed (markdown, or JSON with --json) and saved in out/. Several people: one brief each
 * plus out/index.md. Briefs are saved as they finish, so a run that stops early keeps what it paid for. Progress
 * goes to stderr, so stdout can be piped (use `npm run -s` so npm does not print its own header line on stdout).
 *
 * Exit codes: 0 every person researched (or nobody to research: an empty file, only rooms and colleagues), 2 the
 * run finished but some people were not found, need a pick or failed, 3 the run stopped (bad key, no credits),
 * 1 nothing was run (bad flags, a missing key, over MAX_CREDITS_PER_RUN without --yes).
 */

import "./node-check.js";
import { readFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { config } from "./config.js";
import { fmtCredits, type ContactKind } from "./crustdata.js";
import { MAX_PEOPLE, classify, dedupe, parseList, skipDomains, type Input, type Skipped } from "./input.js";
import { renderBrief } from "./render.js";
import { BriefWriter, DEFAULTS, RunStopped, candidateLine, estimate, lastRun, research, type Options, type Outcome } from "./research.js";

export const HELP = `Research a person before a call, from Crustdata data. One Crustdata key, no AI.

  npm run research -- jane@acme.com
  npm run research -- "<profile URL>"
  npm run research -- --name "Jane Doe" --company acme.com
  npm run research -- jane@acme.com sam@globex.com "Ana Silva, Initech"
  npm run research -- --file attendees.csv --skip-domain mycompany.com

Flags:
  --name "..." --company "..."  a name, with the company name or website domain (domain is exact)
  --pick <n>                    which of several people with that name to research
  --file <path>                 a list: one person per line, or a CSV with Email / Profile URL / Name + Company
  --skip-domain <domain>        leave out people at this email domain (your own company); repeatable
  --days <n>                    window for "What changed lately" (default 180)
  --posts <n>                   recent posts to show, 0 to 10 (default 5; 0 shows the free post count only)
  --no-posts                    skip posts
  --no-web                      skip web and news searches
  --contact [kinds]             add contact details: business (default), personal, phone, or all
                                (needs contact data on your Crustdata account)
  --json                        print JSON instead of markdown (use npm run -s so stdout is only the JSON)
  --out <dir>                   where files go (default out/)
  --refresh                     ignore saved answers and fetch again (paid)
  --dry-run                     show who would be researched and the most it can cost; spends nothing
  --yes                         run even when the estimate is above MAX_CREDITS_PER_RUN (default 150)

Cost at list price: 5.5 credits a person (profile 1, 5 posts 2.5, web 1, news 1); an email that needs a lookup
first adds 1, a name search up to 0.65, and --dry-run budgets for both. Misses are free, and the same person
again within 24 hours costs nothing.`;

export type Parsed = {
  inputs: Input[]; skipped: Skipped[]; warnings: string[]; opts: Options; json: boolean; dryRun: boolean; yes: boolean;
  out?: string; help: boolean; fromFile: boolean; skipDomain: string[];
};

const KINDS = /^(business|personal|phone|all)(,(business|personal|phone|all))*$/i;

/** Paths on the command line are relative to where the command was run (npm sets INIT_CWD to it). */
export const userPath = (p: string): string => (isAbsolute(p) ? p : resolve(process.env.INIT_CWD || process.cwd(), p));

/** Pure apart from reading --file: arguments to inputs and options. Throws a plain message on bad flags. */
export function parseArgs(argv: string[], readFile: (path: string) => string = p => readFileSync(userPath(p), "utf8")): Parsed {
  const opts: Options = { ...DEFAULTS, contact: [], now: DEFAULTS.now };
  const positional: string[] = [];
  let name: string | undefined, company: string | undefined, json = false, dryRun = false, yes = false, out: string | undefined, help = false, fromFile = false;
  const skipped: Skipped[] = [];
  const warnings: string[] = [];
  const fileInputs: Input[] = [];
  const skipDomain: string[] = [];
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value. See npm run research -- --help`);
    return v;
  };
  const int = (v: string, flag: string, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be a whole number from ${min} to ${max} (got "${v}").`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const take = () => (inline !== undefined ? inline : value(i++, flag));
    switch (flag) {
      case "--help": case "-h": help = true; break;
      case "--name": if (name !== undefined) throw new Error("--name is given twice. Research one name per run, or put several in a file as \"Name, Company\" lines."); name = take(); break;
      case "--company": if (company !== undefined) throw new Error("--company is given twice."); company = take(); break;
      case "--pick": opts.pick = int(take(), "--pick", 1, 5); break;
      case "--days": opts.days = int(take(), "--days", 1, 3650); break;
      case "--posts": opts.posts = int(take(), "--posts", 0, 10); break;
      case "--no-posts": opts.noPosts = true; break;
      case "--no-web": opts.web = false; break;
      case "--json": json = true; break;
      case "--refresh": opts.refresh = true; break;
      case "--dry-run": dryRun = true; break;
      case "--yes": case "-y": yes = true; break;
      case "--out": out = take(); break;
      case "--skip-domain": skipDomain.push(...take().split(",")); break;
      case "--contact": {
        const v = inline ?? (argv[i + 1] && KINDS.test(argv[i + 1]) ? argv[++i] : "business");
        if (!KINDS.test(v)) throw new Error(`--contact takes business, personal, phone or all (got "${v}").`);
        const kinds = v.toLowerCase().split(",").flatMap(k => (k === "all" ? ["business", "personal", "phone"] : [k])) as ContactKind[];
        opts.contact = [...new Set(kinds)];
        break;
      }
      case "--file": {
        const path = take();
        fromFile = true;
        if (/^\.(xlsx|xls|numbers|ods)$/i.test(extname(path))) throw new Error(`${path} is a spreadsheet file. Save it as CSV (File > Save As > CSV) and pass that.`);
        if (/^\.(vcf|vcard)$/i.test(extname(path))) throw new Error(`${path} is a contacts card file. Export a CSV from Google Contacts or your CRM instead, or list the emails one per line.`);
        let text: string;
        try { text = readFile(path); } catch { throw new Error(`Cannot read ${path} (looked in ${userPath(path)}). Check the path; it is relative to the folder you ran the command in.`); }
        const parsed = parseList(text);
        fileInputs.push(...parsed.inputs);
        skipped.push(...parsed.skipped.map(s => ({ ...s, raw: argv.filter(x => x === "--file").length > 1 ? `${path}: ${s.raw}` : s.raw })));
        warnings.push(...parsed.warnings.map(w => `${path}: ${w}`));
        break;
      }
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag ${a}. See npm run research -- --help`);
        positional.push(a);
    }
  }

  const inputs: Input[] = [];
  if (company && !name) throw new Error("--company goes with --name: npm run research -- --name \"Jane Doe\" --company acme.com");
  if (name) {
    if (!/\p{L}/u.test(name)) throw new Error(`"${name}" does not look like a name.`);
    const clean = name.trim().replace(/\s+/g, " ");
    inputs.push({ kind: "name", raw: company ? `${clean}, ${company.trim()}` : clean, name: clean, ...(company ? { company: company.trim() } : {}) });
  }
  for (const p of positional) {
    const r = classify(p);
    if (r.inputs.length) inputs.push(...r.inputs);
    else skipped.push({ raw: p, reason: r.reason ?? "not understood" });
  }
  inputs.push(...fileInputs);
  if (opts.pick && !name && !inputs.some(x => x.kind === "name")) warnings.push("--pick only applies to a name lookup, so it is ignored.");
  return { inputs: dedupe(inputs), skipped, warnings, opts, json, dryRun, yes, out, help, fromFile, skipDomain };
}

const err = (s: string) => process.stderr.write(`${s}\n`);
const credits = (n: number) => `${fmtCredits(n)} credit${n === 1 ? "" : "s"}`;

/** The JSON for every run: one entry per person, always an array. */
export const jsonOutcomes = (outcomes: Outcome[]) => outcomes.map(o => ({
  input: o.input.raw,
  status: o.status,
  ...(o.note && o.status !== "done" ? { note: o.note } : {}),
  ...(o.candidates ? { candidates: o.candidates.map(c => ({ name: c.basic_profile?.name, headline: c.basic_profile?.headline, location: c.basic_profile?.location?.raw, profileUrl: c.social_handles?.professional_network_identifier?.profile_url })) } : {}),
  ...(o.brief ? { brief: o.brief } : {}),
}));

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  if (a.help) { (a.json ? err : (t: string) => console.log(t))(HELP); return 0; }
  for (const w of a.warnings) err(`Note: ${w}`);
  for (const s of a.skipped) err(`Skipped${s.line ? ` line ${s.line}` : ""}: ${s.raw} (${s.reason})`);
  const own = skipDomains(a.inputs, [...config.skipDomains, ...a.skipDomain]);
  for (const s of own.skipped) err(`Skipped: ${s.raw} (${s.reason})`);
  const inputs = own.kept;
  if (!inputs.length) {
    if (a.json) console.log("[]");
    if (a.fromFile || a.skipped.length || own.skipped.length) {
      err("Nobody to research.");
      // Only rooms, summary lines and colleagues (a day of internal meetings) is a normal day, not a failure.
      return [...a.skipped, ...own.skipped].every(s => s.benign) ? 0 : 2;
    }
    err(HELP);
    return 1;
  }
  if (inputs.length > MAX_PEOPLE) { err(`${inputs.length} people is more than the ${MAX_PEOPLE} one run takes. Split the list and run it in parts.`); return 1; }
  if (a.opts.pick && inputs.length > 1) { err("--pick works with one name at a time."); return 1; }

  if (!a.dryRun) config.crustdataApiKey; // a missing key stops here with the setup hint, before anything else
  const dir = a.out ? userPath(a.out) : config.outDir;
  const most = estimate(inputs, a.opts);
  const who = inputs.length === 1 ? "1 person" : `${inputs.length} people`;
  const cached = config.cacheHours > 0 && !a.opts.refresh ? `; anyone researched in the last ${config.cacheHours} hours costs nothing` : "";
  err(`${a.dryRun ? "Would research" : "Researching"} ${who}: at most ${credits(most)} at list price (misses are free${cached}).`);
  if (a.dryRun) {
    for (const x of inputs) err(`  ${x.kind === "url" ? "profile URL" : x.kind === "email" ? "email" : "name"}: ${x.kind === "name" ? `${x.name}${x.company ? ` at ${x.company}` : ""}` : x.kind === "email" ? x.email : x.url}`);
    err("Dry run: nothing was sent, nothing was charged.");
    if (a.json) console.log(JSON.stringify(inputs.map(x => ({ input: x.raw, status: "would_research", kind: x.kind, ...(x.kind === "email" ? { email: x.email } : x.kind === "url" ? { url: x.url } : { name: x.name, ...(x.company ? { company: x.company } : {}) }) })), null, 2));
    return 0;
  }
  const cap = config.maxCreditsPerRun;
  if (cap > 0 && most > cap && !a.yes) {
    err(`That is more than MAX_CREDITS_PER_RUN (${cap}). Run it again with --yes to go ahead, or raise MAX_CREDITS_PER_RUN in .env.`);
    return 1;
  }

  const writer = new BriefWriter(dir);
  let outcomes: Outcome[];
  let stopped: string | undefined;
  let used: number;
  try {
    outcomes = await research(inputs, a.opts, err, o => writer.write(o));
    used = lastRun.credits;
  } catch (e) {
    if (!(e instanceof RunStopped)) throw e;
    outcomes = e.outcomes;
    stopped = e.message;
    used = e.credits;
  }
  const rows = writer.finish(outcomes, used, a.opts.now, stopped);
  const done = outcomes.filter(o => o.status === "done");

  for (const o of outcomes.filter(o => o.status !== "done" && !(stopped && o.note?.startsWith("Not reached")))) {
    err(`\n${o.input.raw}: ${o.note ?? o.status}`);
    if (o.candidates?.length) o.candidates.forEach((c, i) => err(candidateLine(c, i)));
  }
  if (a.json) console.log(JSON.stringify(jsonOutcomes(outcomes), null, 2));
  else if (inputs.length === 1 && done[0]?.brief) console.log(renderBrief(done[0].brief));
  else if (done.length) console.log(rows.filter(r => r.status === "done").map(r => `- ${r.name}${r.title ? `, ${r.title}` : ""}${r.changed ? `. ${r.changed}` : ""}`).join("\n"));

  const shown = (f: string) => { const r = relative(process.env.INIT_CWD || process.cwd(), f); return r.startsWith("..") ? f : r; };
  if (writer.files.length && !process.env.PR_REPLAY_QUIET) err(`\nSaved: ${done.length > 1 ? `${done.length} briefs in ${shown(dir)}/, start with index.md` : writer.files.map(shown).join(", ")} (each brief also as .json)`);
  if (stopped) {
    const fix = /401|rejected the API key/.test(stopped) ? "Fix the key (npm run setup), then run the same command again" : "Run the same command again when that is fixed";
    err(`\nStopped: ${stopped}\n${done.length ? `${done.length} brief${done.length === 1 ? "" : "s"} finished before it ${done.length === 1 ? "is" : "are"} saved. ` : ""}${fix}; people already researched cost nothing again.`);
  }
  err(`Credits used: ${fmtCredits(used)}${process.env.PR_REPLAY ? " (simulated at list price; nothing was charged)" : ""}.`);
  if (stopped) return 3;
  return done.length + outcomes.filter(o => o.status === "skipped").length === outcomes.length ? 0 : 2;
}

if (process.argv[1] && /cli\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(e => {
    err(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
