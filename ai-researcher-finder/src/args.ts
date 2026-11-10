/** Command line flags for `find` and `map`, read into one spec. Pure, so it is tested. */

import { parseLabList } from "./labs.js";
import { classify, type Seed, type SeedProblem } from "./seeds.js";

export type Spec = {
  mode: "find" | "map";
  name: string;
  role: string;
  labs: string[];
  pastLabs: string[];
  topics: string[];
  country?: string;
  anyTitle: boolean;
  limit: number;
  perLab?: number;
  perPaper: number;
  seedFiles: string[];
  seeds: Seed[];
  seedProblems: SeedProblem[];
  rubricFile?: string;
  ai: boolean;
  fresh: boolean;
  top: number;
  dryRun: boolean;
  maxCredits?: number;
  /** --scholar-email N: also search each lab for N people whose Google Scholar email is at the lab's domain. */
  scholarEmail?: number;
  /** --max-ai N: allow --ai to ask Claude about more than 500 people. */
  maxAi?: number;
  /** The spec fields the user typed on this command line (so a rerun with --name keeps the rest from the saved search). */
  typed: string[];
  /** Whether --name was typed. */
  nameTyped: boolean;
};

/** The query used when no --role is given: every research and ML role. */
export const DEFAULT_ROLE = "Machine learning researcher or engineer: research scientist, research engineer, member of technical staff, ML engineer";

export const FIND_HELP = `npm run find -- [flags]       find AI researchers and ML engineers, score them, map their teams
npm run map -- --lab <lab>    every research and ML person at one lab, grouped by team

Who to look for (at least one of --role, --labs, --past-labs, or a seed):
  --role "<sentence>"        the role in plain English; ranks people by meaning (default: every research and ML role)
  --labs <list>              at one of these labs now: domains or names, comma separated, or "frontier"
  --past-labs <list>         worked at one of these labs before (same format)
  --topic "<words>"          what they work on, e.g. "speculative decoding"; ranks, and feeds the rubric's topic rule
  --country "<country>"      lives in this country
  --any-title                keep every title (default: research, scientist, technical staff and ML titles only)

Start from the work (seeds; repeat a flag; --scholar, --github and --profile also take comma separated URLs):
  --from <file>              a CSV, or a text file with one link or paper title per line (repeat for several files)
  --scholar <url>            a Google Scholar profile URL
  --github <url>             a GitHub profile URL
  --paper "<title>"          a paper title: finds its authors
  --profile <url>            a profile URL

How many and how:
  --limit N                  people from the search (default 25 for find, 100 for map); split across --labs
  --per-lab N                people from each lab instead
  --per-paper N              authors to fetch per paper title (default 20)
  --name <name>              the folder under out/ (default: made from the labs or role)
  --rubric <file>            your scoring rules (default: rubric.json)
  --ai                       Claude also answers the rubric's "ask" lines (needs ANTHROPIC_API_KEY)
  --fresh                    pull everyone again (default: people already in the folder are skipped, unbilled)
  --top N                    people written out in full in report.md (default 25)
  --scholar-email N          also find N people per lab whose Google Scholar email is at the lab (may be a past job)
  --dry-run                  print the plan and the most it can cost; spends nothing
  --max-credits N            allow a run that can cost more than MAX_CREDITS (default 100)
  --max-ai N                 allow --ai to ask Claude about more than 500 people`;

export const slugify = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\.(com|ai|google|inc|org|io)\b/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70).replace(/-+$/, "");

/** A short, stable id for text with no Latin letters (a role written in Chinese, say). */
const shortHash = (s: string): string => { let h = 5381; for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0; return h.toString(36).slice(0, 6); };

/** What makes two searches the same search: the folder refuses a different one unless --name is typed. */
export const searchKey = (s: Pick<Spec, "mode" | "role" | "labs" | "pastLabs" | "topics" | "country" | "anyTitle">): string =>
  JSON.stringify([s.mode, s.role.toLowerCase(), [...s.labs].sort(), [...s.pastLabs].sort(), s.topics.map(t => t.toLowerCase()).sort(), s.country ?? "", s.anyTitle]);

const int = (flag: string, v: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} takes a whole number from ${min} to ${max}.`);
  return n;
};

export function parseArgs(argv: string[], mode: "find" | "map"): Spec {
  const spec: Spec = { mode, name: "", role: "", labs: [], pastLabs: [], topics: [], anyTitle: false, limit: mode === "map" ? 100 : 25, perPaper: 20, seedFiles: [], seeds: [], seedProblems: [], ai: false, fresh: false, top: 25, dryRun: false, typed: [], nameTyped: false };
  let name: string | undefined, limitSet = false;
  // The labs as typed, for the folder name: "frontier" stays one word.
  const typed: string[] = [], typedPast: string[] = [];
  const words = (v: string) => v.split(/[,;\n]/).map(x => x.trim()).filter(Boolean).map(x => (/^frontier$/i.test(x) ? "frontier labs" : x));
  const addSeeds = (values: string, expect: Seed["kind"]) => {
    for (const v of expect === "paper" ? [values] : values.split(",")) {
      const r = classify(v);
      if (!r) continue;
      if ("problem" in r) spec.seedProblems.push({ raw: v.trim(), why: r.problem });
      else if (r.kind !== expect) spec.seedProblems.push({ raw: v.trim(), why: `given with --${expect} but reads as a ${r.kind === "paper" ? "paper title" : `${r.kind} URL`}` });
      else if (!spec.seeds.some(s => s.kind === r.kind && s.value === r.value)) spec.seeds.push(r);
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^-[a-z]/i.test(arg)) throw new Error(`Flags start with two dashes: -${arg}. Run npm run find -- --help for every flag.`);
    if (!arg.startsWith("--")) throw new Error(`Unexpected "${arg}". Put quotes around sentences, e.g. --role "Research engineer, inference". Run npm run find -- --help for every flag.`);
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    const bool = ["--any-title", "--ai", "--fresh", "--dry-run", "--help"];
    const key = ({ "--lab": "labs", "--past-lab": "pastLabs", "--per-lab": "perLab", "--per-paper": "perPaper", "--past-labs": "pastLabs", "--any-title": "anyTitle", "--max-credits": "maxCredits", "--from": "seedFiles", "--rubric": "rubricFile", "--scholar-email": "scholarEmail", "--max-ai": "maxAi", "--dry-run": "dryRun", "--topic": "topics", "--scholar": "seeds", "--github": "seeds", "--paper": "seeds", "--profile": "seeds" } as Record<string, string>)[flag] ?? flag.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (!spec.typed.includes(key)) spec.typed.push(key);
    if (bool.includes(flag)) {
      if (flag === "--help") throw Object.assign(new Error(FIND_HELP), { help: true });
      if (flag === "--any-title") spec.anyTitle = true;
      if (flag === "--ai") spec.ai = true;
      if (flag === "--fresh") spec.fresh = true;
      if (flag === "--dry-run") spec.dryRun = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    switch (flag) {
      case "--role": spec.role = value.trim(); break;
      case "--labs": case "--lab": spec.labs.push(...parseLabList(value)); typed.push(...words(value)); break;
      case "--past-labs": case "--past-lab": spec.pastLabs.push(...parseLabList(value)); typedPast.push(...words(value)); break;
      case "--topic": spec.topics.push(...value.split(",").map(s => s.trim()).filter(Boolean)); break;
      case "--country": spec.country = value.trim(); break;
      case "--from": spec.seedFiles.push(value); break;
      case "--scholar": addSeeds(value, "scholar"); break;
      case "--github": addSeeds(value, "github"); break;
      case "--paper": addSeeds(value, "paper"); break;
      case "--profile": addSeeds(value, "profile"); break;
      case "--limit": spec.limit = int(flag, value, 1, 1000); limitSet = true; break;
      case "--per-lab": spec.perLab = int(flag, value, 1, 1000); break;
      case "--per-paper": spec.perPaper = int(flag, value, 1, 100); break;
      case "--name": name = slugify(value); if (!name) throw new Error("--name needs letters or numbers."); break;
      case "--rubric": spec.rubricFile = value; break;
      case "--top": spec.top = int(flag, value, 1, 1000); break;
      case "--scholar-email": spec.scholarEmail = int(flag, value, 1, 1000); break;
      case "--max-ai": spec.maxAi = int(flag, value, 1, 100_000); break;
      case "--max-credits": spec.maxCredits = Number(value); if (!(spec.maxCredits > 0)) throw new Error("--max-credits takes a number above 0."); break;
      default: throw new Error(`Unknown flag ${flag}. Run npm run find -- --help for every flag.`);
    }
  }
  spec.labs = [...new Set(spec.labs)];
  spec.pastLabs = [...new Set(spec.pastLabs)];
  if (mode === "map") {
    // A rerun by --name takes its lab from the saved search.
    if (spec.labs.length !== 1 && !(name !== undefined && !spec.labs.length)) throw new Error(`map takes exactly one lab: npm run map -- --lab anthropic.com${spec.labs.length > 1 ? ` (got ${spec.labs.length}; use npm run find -- --labs ... for several)` : ""}`);
    if (spec.perLab) { spec.limit = spec.perLab; spec.perLab = undefined; if (!spec.typed.includes("limit")) spec.typed.push("limit"); }
  }
  if (!limitSet && spec.perLab && spec.labs.length) spec.limit = spec.perLab * spec.labs.length;
  const hasSearch = !!spec.role || spec.labs.length > 0 || spec.pastLabs.length > 0 || spec.topics.length > 0;
  if (!hasSearch && !spec.seeds.length && !spec.seedFiles.length && !name)
    throw new Error(`Say who to look for: --role "...", --labs frontier, --past-labs ..., or seeds (--from, --scholar, --github, --paper).\n\n${FIND_HELP}`);
  // The folder name says what was searched: role, topic, labs. Different searches get different folders.
  spec.nameTyped = name !== undefined;
  const labsPart = spec.labs.length ? (typed.length > 2 ? `${spec.labs.length} labs` : typed.join(" ")) : "";
  const pastPart = spec.pastLabs.length ? `ex ${typedPast.length > 2 ? `${spec.pastLabs.length} labs` : typedPast.join(" ")}` : "";
  const auto = slugify([mode === "map" ? "map" : "", spec.role, spec.topics.join(" "), labsPart, pastPart, spec.country ?? ""].filter(Boolean).join(" "));
  const nonLatin = !auto && (spec.role || spec.topics.length) ? `search-${shortHash(`${spec.role}|${spec.topics.join(",")}`)}` : "";
  spec.name = name ?? (auto || nonLatin || "seeds");
  return spec;
}

/** Whether the run includes a search (as opposed to seeds only). */
export const searches = (spec: Spec): boolean => !!spec.role || spec.labs.length > 0 || spec.pastLabs.length > 0 || spec.topics.length > 0;
