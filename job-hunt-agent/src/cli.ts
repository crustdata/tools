/**
 * Command line.
 *
 *   npm run hunt -- --title "software engineer" --location "San Francisco"     find, score, people, notes
 *   npm run job -- https://jobs.example.com/acme/123                          try it on one job
 *   npm run job -- --company acme.com --title "Backend Engineer"              a job that is not in the index
 *
 * Run `npm run hunt -- --help` for every flag. Your saved search is profile.json (npm run setup writes it).
 */

import "./node-check.js";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { config } from "./config.js";
import { creditBalance, CrustdataError, fmtCredits, spend } from "./crustdata.js";
import { parseCv, readCvText } from "./cv.js";
import { accountPrices, estimate, hunt, oneJob, type Run } from "./hunt.js";
import { cvPath, readProfileFile, resolveProfile, type Profile } from "./profile.js";
import { summary, writeRun } from "./render.js";
import { Store } from "./store.js";

const HELP = `Job hunt agent on Crustdata

  npm run hunt -- [flags]            find jobs that fit your CV, with the people to talk to
  npm run job -- <posting URL>       the same for one job; also --id <crustdata_job_id>,
                                     or --company <website> --title "<job title>" when it is not in the index

Search (each overrides profile.json for this run):
  --title <t>           job title, words in any order; repeat or comma-separate for several
  --location <place>    city or area, e.g. "San Francisco"      --radius <miles>  default 50
  --remote              remote jobs only (in --country)          --also-remote     near the place, or remote
  --country <name>      default "United States"                  --days <n>        posted in the last n days (30)
  --cv <file>           your CV: .md, .txt or .pdf (default cv.md)
  --school <name>       school for the alumni search (default: read from your CV); repeat for several
  --years <n>           years of experience (default: read from your CV dates)
  --skip-company <c>    leave a company out (name or website); repeatable
  --skip-title <word>   leave out titles with this word, e.g. intern; repeatable
  --needs-sponsorship   postings that say they do not sponsor visas lose 25 points
  --include-agencies    keep jobs from staffing agencies (left out by default)

Cost and output:
  --scan <n>            jobs to read and score (default 50, 0.03 credits each)
  --top <n>             best jobs to find people for (default 5, about 3 credits each at list price)
  --all                 find people for weak fits too (under 50 are skipped by default)
  --emails              also look up work emails for recruiters and managers (needs contact data on your key)
  --dry-run             count matching jobs and show the cost, spend nothing (job: the cost only)
  --yes                 run even when the worst case is above MAX_CREDITS_PER_RUN
  --refresh             ignore cached companies and people
  --json                print the run as JSON (progress goes to stderr)
`;

/** Paths given on the command line are relative to where you ran npm, not this folder. */
const fromCwd = (p: string) => (isAbsolute(p) ? p : resolve(process.env.INIT_CWD || process.cwd(), p));
const many = (v: string[] | undefined) => (v ?? []).flatMap(x => x.split(",")).map(s => s.trim()).filter(Boolean);

function profileFlags(v: Record<string, unknown>): Partial<Profile> {
  const out: Partial<Profile> = {};
  const set = <K extends keyof Profile>(k: K, x: Profile[K] | undefined) => { if (x !== undefined && !(Array.isArray(x) && !x.length)) out[k] = x; };
  // An empty value ("--years ''") is an error, not 0.
  const n = (x: unknown) => (x === undefined ? undefined : /^\d+(\.\d+)?$/.test(String(x).trim()) ? Number(x) : NaN);
  set("titles", many(v.title as string[]));
  set("location", v.location as string | undefined);
  set("radiusMiles", n(v.radius));
  if (v.remote) out.remote = "only";
  else if (v["also-remote"]) out.remote = "also";
  else if (v.location) out.remote = "no";
  set("country", v.country as string | undefined);
  set("days", n(v.days));
  if (v.cv) out.cv = fromCwd(String(v.cv));
  // School names have commas in them ("University of California, Berkeley"): repeat --school for several.
  set("schools", ((v.school as string[] | undefined) ?? []).map(x => x.trim()).filter(Boolean));
  set("yearsExperience", n(v.years) as number | undefined);
  set("skipCompanies", many(v["skip-company"] as string[]));
  set("skipTitleWords", many(v["skip-title"] as string[]));
  if (v["needs-sponsorship"]) out.needsSponsorship = true;
  if (v["include-agencies"]) out.includeAgencies = true;
  set("scan", n(v.scan));
  set("top", n(v.top));
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values: v, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      title: { type: "string", multiple: true }, location: { type: "string" }, radius: { type: "string" },
      remote: { type: "boolean" }, "also-remote": { type: "boolean" }, country: { type: "string" }, days: { type: "string" },
      cv: { type: "string" }, school: { type: "string", multiple: true }, years: { type: "string" },
      "skip-company": { type: "string", multiple: true }, "skip-title": { type: "string", multiple: true },
      "needs-sponsorship": { type: "boolean" }, "include-agencies": { type: "boolean" },
      scan: { type: "string" }, top: { type: "string" }, emails: { type: "boolean" }, all: { type: "boolean" }, "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" }, refresh: { type: "boolean" }, json: { type: "boolean" },
      url: { type: "string" }, id: { type: "string" }, company: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (v.help || !command || !["hunt", "job"].includes(command)) { console.log(HELP); return v.help ? 0 : 1; }

  const json = Boolean(v.json);
  const log = (line: string) => (json ? process.stderr : process.stdout).write(`${line}\n`);

  const fileProfile = readProfileFile(config.profilePath);
  const flags = profileFlags(v);
  // For one job, --title names the job (with --company), not a search.
  if (command === "job") delete flags.titles;
  const profile = resolveProfile(fileProfile, flags, command as "hunt" | "job");

  if (command === "job" && v["dry-run"]) {
    // A rejected key would otherwise quietly fall back to list prices.
    await creditBalance().catch(err => { if (err instanceof CrustdataError && err.status === 401) log("Crustdata rejected the API key (401); the cost below is at list price. Run npm run setup."); });
    log(`One job costs up to ${fmtCredits(estimate(3, 1, Boolean(v.emails), await accountPrices()))} credits (your account's prices, or the price list when they cannot be read; the posting, its company, up to 17 people). Dry run: nothing was spent.`);
    return 0;
  }
  const cvFile = cvPath(profile);
  // A dry run only counts jobs: it works before the CV is in place.
  const cv = v["dry-run"]
    ? await readCvText(cvFile).then(parseCv, () => { log(`No CV at ${cvFile} yet: the count works without it, the score needs it.`); return parseCv(""); })
    : parseCv(await readCvText(cvFile));
  const yearsSource = flags.yearsExperience !== undefined ? "--years" : "profile.json";
  const years = profile.yearsExperience !== null ? `${profile.yearsExperience} years (${yearsSource})` : cv.years !== null ? `${cv.years} years (from your CV)` : "years not known";
  const schools = profile.schools.length ? `${profile.schools.join("; ")} (${flags.schools?.length ? "--school" : "profile.json"})` : cv.schools.length ? `${cv.schools.join("; ")} (from your CV)` : "no school, so no alumni search";
  log(`Using: ${years}; ${schools}; ${new Set([...cv.skills, ...profile.skills]).size} skills (CV ${cvFile}).`);

  config.crustdataApiKey; // fail early with the setup hint
  const store = new Store(config.dbPath);
  const deps = { store, log, cacheDays: v.refresh ? 0 : config.cacheDays, now: process.env.JHA_NOW ? new Date(process.env.JHA_NOW) : undefined };
  let run: Run;
  try {
    if (command === "hunt") {
      if (v["dry-run"]) {
        const ok = await creditBalance().then(() => true, err => !(err instanceof CrustdataError && err.status === 401));
        if (!ok) {
          log(`Crustdata rejected the API key (401), so jobs cannot be counted. At list price this search costs up to ${fmtCredits(estimate(profile.scan, profile.top, Boolean(v.emails)))} credits. Run npm run setup.`);
          return 1;
        }
      }
      const r = await hunt(profile, cv, { emails: Boolean(v.emails), dryRun: Boolean(v["dry-run"]), yes: Boolean(v.yes), maxCredits: config.maxCreditsPerRun, all: Boolean(v.all) }, deps);
      if ("stopped" in r) {
        log(r.stopped);
        if (json) console.log(JSON.stringify(r));
        return r.stopped.startsWith("Dry run") ? 0 : 1;
      }
      run = r;
    } else {
      const target = positionals[0] ?? v.url;
      const id = v.id !== undefined ? Number(v.id) : target && /^\d{6,}$/.test(target) ? Number(target) : undefined;
      if (!target && id === undefined && !v.company) { log('Give a posting URL: npm run job -- https://... (or --company acme.com --title "Backend Engineer")'); return 1; }
      run = await oneJob({ url: id === undefined ? target : undefined, id, company: v.company, title: v.title?.[0] }, profile, cv, { emails: Boolean(v.emails) }, deps);
    }
  } finally {
    store.close();
  }
  const dir = writeRun(run, config.outDir);
  if (json) console.log(JSON.stringify({ ...run, dir }, null, 2));
  else log(summary(run, dir));
  return 0;
}

/** A plain sentence for any failure, never a stack trace. */
export function explain(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  if (/^ERR_PARSE_ARGS/.test(code)) return `${(err as Error).message}\nRun npm run hunt -- --help for the flags.`;
  // A TypeError from our own code means an answer came back in a shape this tool does not expect.
  const msg = err instanceof TypeError
    ? `Crustdata sent an answer in a shape this tool does not expect (${err.message}). Run again; if it repeats, open an issue at https://github.com/crustdata/tools/issues`
    : err instanceof Error ? err.message : String(err);
  const extra = spend.credits > 0 ? `\nCredits used before it stopped: ${fmtCredits(spend.credits)}. Companies and people already fetched are cached and cost nothing next time; the job list is read (and paid for) again.` : "";
  return `${msg}${extra}`;
}

if (process.argv[1] && /cli\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
    console.error(`\n${explain(err)}`);
    process.exit(1);
  });
}
