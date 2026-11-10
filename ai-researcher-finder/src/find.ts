/**
 * `npm run find` and `npm run map`: the whole run.
 *
 *   1. Read the flags, the rubric and the team words (a mistake stops the run before anything is billed).
 *   2. Free checks: account prices and access, labs to company ids, the country's stored spelling.
 *   3. Print the plan and the most it can cost. --dry-run stops here.
 *   4. Search: the role at each lab (or past labs), ranked by Crustdata's semantic search, skipping everyone already
 *      in the folder (unbilled). Seeds: Scholar and profile URLs through identify, GitHub URLs through the dev platform
 *      lookup, paper titles through a search on research profiles. Everything is saved as soon as it is billed.
 *   5. Teams (stated, inferred, not stated), the rubric score with evidence, optional Claude answers.
 *   6. Write researchers.csv, report.md, people.json, run.json under out/<name>/.
 *
 * `npm run rescore` runs steps 5 and 6 again on the saved people, free and offline.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { askAll, cacheKey, type AiCache } from "./ai.js";
import { DEFAULT_ROLE, parseArgs, searches, searchKey, slugify, type Spec } from "./args.js";
import { config, ROOT } from "./config.js";
import { estimate, LIST_PRICE, pricesFrom, type Plan, type Prices } from "./cost.js";
import { writeCsv } from "./csv.js";
import {
  accountEndpoints, and, autocomplete, canIdentify, CrustdataError, fmtCredits, githubToPerson, identifyPeople, leaf, or,
  PERSON_FIELDS, peopleById, searchPeople, spend, type Endpoint, type Filter, type Person,
} from "./crustdata.js";
import { FRONTIER_LABS, LAB_EMAIL_DOMAINS, resolveLabs, type Lab } from "./labs.js";
import { CSV_HEADER, csvRows, labOf, NOT_AT_LAB, report, sortRows, type Row } from "./output.js";
import { nameOf, papersOf, profileUrlOf, roleAt, scholarUrl } from "./profile.js";
import { loadRubric, scorePerson, type Found, type Outcome, type Rubric } from "./rubric.js";
import { parseSeeds, samePaper, type Seed } from "./seeds.js";
import { guessTeams, loadTaxonomy } from "./teams.js";

const log = (s = "") => console.log(s);

/**
 * Title phrases kept by default (exact phrase, whole words). A bare "research" is left out on purpose: it also matches
 * "Research Program Manager" and "Technical Recruiter, Research". --any-title drops the filter.
 */
export const RESEARCH_TITLES = [
  "research scientist", "research engineer", "researcher", "research lead", "research manager", "research director",
  "director of research", "head of research", "research fellow", "research resident", "member of technical staff",
  "technical staff", "mts", "machine learning", "ml", "ai engineer", "deep learning", "applied scientist", "staff scientist",
  "principal scientist", "chief scientist", "ai scientist",
];
/** `map` also keeps engineers and tech leads: the engineers on an inference or pretraining team often say only "Software Engineer". */
export const MAP_TITLES = [...RESEARCH_TITLES, "engineer", "tech lead", "technical lead"];
/**
 * Titles dropped after a search even when a phrase above matched ("UX Researcher", "Technical Recruiter, Research").
 * A title that names a research role first ("Research Scientist, User Modeling") is kept. Billed once, and said so.
 */
const RESEARCH_ROLE = /\b(research scientist|research engineer|member of technical staff|machine learning (engineer|researcher)|ml (engineer|researcher)|ai researcher|applied scientist|research lead)\b/i;
const NON_RESEARCH = /^((senior|sr\.?|staff|lead|principal)\s+)*(ux|user experience|user|design|product design)\s+research|\b(recruit\w*|talent (acquisition|partner|sourcer|sourcing|lead|manager)|sourc(er|ing)|program manager|people partner|account executive|sales)\b/i;
export const notResearch = (title: string): boolean => !RESEARCH_ROLE.test(title) && NON_RESEARCH.test(title.trim());

export function titleFilter(titles = RESEARCH_TITLES): Filter {
  return or(...titles.map(t => leaf("experience.employment_details.current.title", "[.]", t)));
}

/** The filters for one role search. Pure, so it is tested. */
export function searchFilters(opts: { labIds?: number[]; pastLabIds?: number[]; anyTitle: boolean; country?: string; titles?: string[] }): Filter {
  // With --past-labs and no --labs, the title filter is off: people who left often found companies or teach now.
  const titles = opts.anyTitle || (!opts.labIds?.length && opts.pastLabIds?.length) ? undefined : titleFilter(opts.titles);
  return and(
    opts.labIds?.length ? leaf("experience.employment_details.current.company_id", "in", opts.labIds) : undefined,
    opts.pastLabIds?.length ? leaf("experience.employment_details.past.company_id", "in", opts.pastLabIds) : undefined,
    titles,
    opts.country ? leaf("basic_profile.location.country", "in", [opts.country]) : undefined,
  );
}

/** The ranking query: the role, plus the topic words. */
export const queryFor = (spec: Pick<Spec, "role" | "topics">): string =>
  [spec.role || DEFAULT_ROLE, spec.topics.length ? `working on ${spec.topics.join(", ")}` : ""].filter(Boolean).join(", ");

// ---------------------------------------------------------------------------
// Files under out/<name>/
// ---------------------------------------------------------------------------

type SeedCache = Record<string, { id?: number; status: string }>;
/** `pending`: the searches of the last run that had not finished (a rerun of the same search resumes them). */
type RunFile = { spec: Omit<Spec, "seeds" | "seedProblems" | "dryRun" | "maxCredits" | "typed" | "nameTyped">; labs: Lab[]; pastLabs: Lab[]; seeds: Seed[]; updated: string; pending?: string[] };

export const folderFor = (name: string) => join(config.outDir, name);
/** A path to show: relative when it is below the current folder, absolute otherwise. */
export const shown = (path: string) => { const r = relative(process.cwd(), path); return r && !r.startsWith("..") ? r : path; };
export const writeJson = (file: string, data: unknown) => {
  mkdirSync(resolve(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
};
export const readJson = <T>(file: string, fallback: T): T => {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch (err) { throw new Error(`${file} is damaged (${(err as Error).message}). Move it away to start that folder again.`); }
};

/** People removed at their request (npm run forget): never stored again, and skipped (unbilled) by every search. */
/** Removed at their request: Crustdata ids, profile URLs and Google Scholar user ids. */
export type Suppressed = { ids: number[]; urls: string[]; scholar?: string[] };
export const suppressedFile = () => join(config.outDir, "suppressed.json");
export const readSuppressed = (): Suppressed => readJson<Suppressed>(suppressedFile(), { ids: [], urls: [] });
/** One form for a profile URL, used everywhere a URL is compared: no scheme, no www, no query, no trailing slash. */
/** The `user` id of a Google Scholar profile URL. */
export const scholarId = (u: string): string | undefined => { try { return new URL(u).searchParams.get("user") ?? undefined; } catch { return undefined; } };
export const urlKey = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");

export class Store {
  people = new Map<number, Found>();
  private blocked: Suppressed;
  constructor(public dir: string) {
    this.blocked = readSuppressed();
    this.dropped = readJson<string[]>(join(dir, "dropped.json"), []);
    for (const f of readJson<Found[]>(join(dir, "people.json"), [])) if (f?.person?.crustdata_person_id && !this.isBlocked(f.person)) this.people.set(f.person.crustdata_person_id, f);
  }
  isBlocked(p: Person): boolean {
    const url = profileUrlOf(p);
    const sid = scholarId(scholarUrl(p));
    return this.blocked.ids.includes(p.crustdata_person_id) || (!!url && this.blocked.urls.map(urlKey).includes(urlKey(url))) || (!!sid && (this.blocked.scholar ?? []).includes(sid));
  }
  /** Whether a seed points at someone removed at their request (checked before any lookup is billed). */
  blocksSeed(x: Seed): boolean {
    if (x.kind === "scholar") return (this.blocked.scholar ?? []).includes(scholarId(x.value) ?? "");
    if (x.kind === "profile") return this.blocked.urls.map(urlKey).includes(urlKey(x.value));
    return false;
  }
  /** A seed that points at someone already in the folder: found locally, nothing billed. */
  localMatch(x: Seed): Person | undefined {
    for (const f of this.people.values()) {
      if (x.kind === "scholar" && scholarId(scholarUrl(f.person)) && scholarId(scholarUrl(f.person)) === scholarId(x.value)) return f.person;
      if (x.kind === "profile" && profileUrlOf(f.person) && urlKey(profileUrlOf(f.person)) === urlKey(x.value)) return f.person;
    }
    return undefined;
  }
  /** Adds or refreshes people and how they were found, then saves once: they are billed. */
  addMany(items: Array<{ person: Person; via: string }>): void {
    const now = new Date().toISOString();
    for (const { person: p, via } of items) {
      if (!p?.crustdata_person_id || this.isBlocked(p)) continue;
      const old = this.people.get(p.crustdata_person_id);
      // A fuller record replaces a thinner one; how they were found is kept from both.
      const fresh = old && !p.experience && old.person.experience ? old.person : p;
      // The match tier only comes with the search; a later lookup by id must not drop it.
      const person = { ...fresh, fit: "fit" in p ? p.fit ?? null : old?.person.fit ?? null };
      this.people.set(p.crustdata_person_id, { person, via: [...new Set([...(old?.via ?? []), via])], found_at: fresh === p ? now : old?.found_at ?? now });
    }
    writeJson(join(this.dir, "people.json"), [...this.people.values()]);
  }
  add(people: Person[], via: string): void { this.addMany(people.map(person => ({ person, via }))); }
  /** Profile URLs to skip in a search: everyone in the folder, plus everyone removed at their request. */
  /** People dropped after a search (not a research title): skipped later so they are billed once. */
  dropped: string[] = [];
  drop(urls: string[]): void {
    if (!urls.length) return;
    this.dropped = [...new Set([...this.dropped, ...urls])];
    writeJson(join(this.dir, "dropped.json"), this.dropped);
  }
  skipUrls(): string[] { return [...new Set([...[...this.people.values()].map(f => profileUrlOf(f.person)).filter(Boolean), ...this.blocked.urls, ...this.dropped])]; }
  isBlockedId(id: number): boolean { return this.blocked.ids.includes(id); }
  withoutUrl(): number { return [...this.people.values()].filter(f => !profileUrlOf(f.person)).length; }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runFind(argv: string[], mode: "find" | "map"): Promise<void> {
  spend.credits = 0;
  let spec: Spec;
  try { spec = parseArgs(argv, mode); } catch (err) { if ((err as { help?: boolean }).help) { log((err as Error).message); return; } throw err; }
  const dir = folderFor(spec.name);
  const saved = readJson<RunFile | undefined>(join(dir, "run.json"), undefined);
  if (saved && spec.nameTyped) {
    // A rerun with --name: the saved search, with whatever was typed this time on top (--limit, --top, --ai...).
    const base: Record<string, unknown> = { ...saved.spec };
    if (saved.spec.mode !== mode) throw new Error(`${shown(dir)} holds a ${saved.spec.mode} search; run it again with npm run ${saved.spec.mode} -- --name ${spec.name}.`);
    for (const key of spec.typed) if (key !== "seeds" && key !== "name") base[key] = (spec as unknown as Record<string, unknown>)[key];
    // A typed --limit wins over a saved --per-lab.
    if (spec.typed.includes("limit") && !spec.typed.includes("perLab")) base.perLab = undefined;
    spec = { ...(base as unknown as Spec), mode, name: spec.name, seeds: spec.seeds, seedProblems: spec.seedProblems, dryRun: spec.dryRun, maxCredits: spec.maxCredits, typed: spec.typed, nameTyped: true, seedFiles: spec.seedFiles, fresh: spec.fresh, ai: spec.ai, maxAi: spec.maxAi };
  } else if (saved && searches(spec) && searchKey(saved.spec) !== searchKey(spec)) {
    throw new Error(`${shown(dir)} already holds a different search. Pass --name <new name> to keep both, or delete that folder to start again.`);
  } else if (!saved && spec.nameTyped && !searches(spec) && !spec.seeds.length && !spec.seedFiles.length) {
    throw new Error(`There is no saved search called "${spec.name}" in ${shown(config.outDir)}. Start one with ${mode === "map" ? "--lab" : "--role, --labs or seeds"}.`);
  }
  if (mode === "map" && spec.labs.length !== 1) throw new Error(`map takes exactly one lab: npm run map -- --lab anthropic.com${spec.nameTyped && !saved ? ` (there is no saved map called "${spec.name}")` : ""}`);
  let ignoredCells = 0;
  for (const seedFile of spec.seedFiles) {
    const file = isAbsolute(seedFile) ? seedFile : resolve(process.cwd(), seedFile);
    if (/\.(xlsx?|numbers|ods)$/i.test(file)) throw new Error(`${seedFile} is a spreadsheet file. Save it as CSV (File, Download or Save as, CSV) and pass that.`);
    if (!existsSync(file)) throw new Error(`Cannot find the seeds file ${seedFile}.`);
    // A .csv is read by column; anything else (a .txt) one line at a time, so a title with a comma stays whole.
    const parsed = parseSeeds(readFileSync(file, "utf8"), { lines: !/\.csv$/i.test(file) });
    for (const x of parsed.seeds) if (!spec.seeds.some(y => y.kind === x.kind && y.value === x.value)) spec.seeds.push(x);
    spec.seedProblems.push(...parsed.problems.map(p => ({ ...p, raw: p.raw, why: `${p.why}, in ${seedFile}` })));
    ignoredCells += parsed.ignored;
    if (!parsed.seeds.length && !parsed.problems.length) throw new Error(`No seeds found in ${seedFile}. For paper titles, put one title per line in a .txt file, or name the CSV column "paper".`);
  }
  const rubricFile = spec.rubricFile ? resolve(process.cwd(), spec.rubricFile) : resolve(ROOT, "rubric.json");
  // Saved as an absolute path, so rescore and forget find the same rubric from any folder.
  if (spec.rubricFile) spec.rubricFile = rubricFile;
  const tax = loadTaxonomy();
  const rubric = loadRubric(rubricFile, tax.map(t => t.team));
  if (spec.ai && !config.anthropicApiKey) throw new Error("--ai needs ANTHROPIC_API_KEY in .env (npm run setup asks for it). Run without --ai to score with the rules only.");

  log(`AI Researcher Finder: ${spec.name}`);
  for (const pr of spec.seedProblems) log(`  skipped seed${pr.line ? ` on line ${pr.line}` : ""}: "${pr.raw.slice(0, 80)}" (${pr.why})`);
  if (ignoredCells) log(`  note: ${ignoredCells} text cell${ignoredCells === 1 ? "" : "s"} in other columns (names, job titles, venues, notes) ${ignoredCells === 1 ? "was" : "were"} not searched as paper titles; titles are read from a column named "paper" (or "Title" in a Google Scholar export).`);

  // Free checks.
  let endpoints: Endpoint[] = [];
  try { endpoints = await accountEndpoints(); } catch (err) { if (err instanceof CrustdataError && err.status === 401) throw err; }
  const prices: Prices = endpoints.length ? pricesFrom(endpoints) : LIST_PRICE;
  const dev = endpoints.find(e => e.path === "/dev_platform/enrich");
  const searchEp = endpoints.find(e => e.path === "/person/search");
  const research = !searchEp || (searchEp.fields?.enabled ?? []).includes("research_profiles");
  const notes: string[] = [];
  const note = (m: string) => { if (!notes.includes(m)) { notes.push(m); log(`  note: ${m}`); } };
  const kinds = (k: Seed["kind"]) => spec.seeds.filter(x => x.kind === k);
  const seedCache = readJson<SeedCache>(join(dir, "seeds.json"), {});
  const cached = (x: Seed) => !spec.fresh && seedCache[`${x.kind}:${x.value}`];
  if ((kinds("scholar").some(x => !cached(x)) || kinds("profile").some(x => !cached(x))) && !(await canIdentify())) {
    note("Google Scholar and profile URL seeds were skipped: Person Identify is not enabled for this key (ask Crustdata).");
    spec.seeds = spec.seeds.filter(x => x.kind !== "scholar" && x.kind !== "profile");
  }
  if (kinds("github").length && endpoints.length && dev?.status !== "enabled") {
    note("GitHub seeds were skipped: the GitHub lookup (/dev_platform/enrich) is not enabled for this key; it is on enterprise plans.");
    spec.seeds = spec.seeds.filter(x => x.kind !== "github");
  }
  if (!research && (kinds("paper").length || spec.scholarEmail)) {
    note("Paper titles and --scholar-email were skipped: this key cannot read research profiles (ask Crustdata to enable them).");
    spec.seeds = spec.seeds.filter(x => x.kind !== "paper");
    spec.scholarEmail = undefined;
  }

  const resolved = async (list: string[], what: string): Promise<Lab[]> => {
    if (!list.length) return [];
    const { labs, missing } = await resolveLabs(list);
    if (missing.length) {
      const builtIn = missing.filter(m => FRONTIER_LABS.includes(m));
      throw new Error(`Crustdata does not know ${missing.map(m => `"${m}"`).join(", ")} as a company. Check the spelling, or try the lab's main website (for example anthropic.com) in ${what}.${builtIn.length ? " That lab comes from the frontier list in src/labs.ts; remove it there." : ""}`);
    }
    return labs;
  };
  const labs = await resolved(spec.labs, "--labs");
  const pastLabs = await resolved(spec.pastLabs, "--past-labs");
  if (spec.country) {
    const found = await autocomplete("basic_profile.location.country", spec.country, 5);
    const exact = found.find(v => v.toLowerCase() === spec.country!.toLowerCase());
    if (!exact) throw new Error(`"${spec.country}" is not a country name Crustdata stores${found.length ? `. Did you mean: ${found.join(", ")}?` : "."}`);
    spec.country = exact;
  }

  // The plan.
  const store = new Store(dir);
  const query = queryFor(spec);
  const titles = mode === "map" ? MAP_TITLES : RESEARCH_TITLES;
  type Planned = { label: string; people: number; filters: Filter; groups: Array<"experience" | "research_profiles">; via: string };
  const searchList: Planned[] = [];
  // `--name x --paper "..."` (seeds, no search flags typed) adds the seeds to the folder without searching again.
  const seedsOnly = spec.nameTyped && (spec.seeds.length > 0 || spec.seedFiles.length > 0) && !spec.typed.some(k => ["role", "labs", "pastLabs", "topics", "limit", "perLab", "scholarEmail", "country", "anyTitle"].includes(k));
  if (searches(spec) && !seedsOnly) {
    const past = pastLabs.map(l => l.id);
    const pastText = past.length ? `, ${pastLabs.map(x => x.name).join(" or ")} before` : "";
    if (labs.length) {
      // --limit is shared out across the labs (25 over 8 labs: 4 for the first one, 3 for the rest); --per-lab sets each.
      if (!spec.perLab && spec.limit < labs.length) note(`--limit ${spec.limit} is less than the ${labs.length} labs, so only the first ${spec.limit} are searched; raise --limit or pass --per-lab 1.`);
      labs.forEach((l, i) => {
        const each = spec.perLab ?? Math.floor(spec.limit / labs.length) + (i < spec.limit % labs.length ? 1 : 0);
        if (each > 0) searchList.push({ label: `${l.name} now${pastText}`, people: each, groups: ["experience"], via: "search",
          filters: searchFilters({ labIds: [l.id], pastLabIds: past, anyTitle: spec.anyTitle, country: spec.country, titles }) });
      });
    } else searchList.push({ label: past.length ? `worked at ${pastLabs.map(x => x.name).join(" or ")}` : "anywhere", people: spec.limit, groups: ["experience"], via: "search",
      filters: searchFilters({ pastLabIds: past, anyTitle: spec.anyTitle, country: spec.country, titles }) });
    // --scholar-email: people whose Google Scholar profile has an email at the lab, whatever their work history says.
    if (spec.scholarEmail && !labs.length) note("--scholar-email searches the labs given with --labs; with --past-labs only it does nothing.");
    if (spec.scholarEmail) for (const l of labs) {
      const domains = [...new Set([l.domain, ...(l.domain ? LAB_EMAIL_DOMAINS[l.domain] ?? [] : [])].filter(Boolean) as string[])];
      if (!domains.length) continue;
      searchList.push({ label: `Google Scholar email at ${domains.join(" or ")}`, people: spec.scholarEmail, groups: ["research_profiles"], via: `Google Scholar email at ${domains.join(" or ")}`,
        filters: and(leaf("research_profiles.verified_email_domain", "in", domains), spec.country ? leaf("basic_profile.location.country", "in", [spec.country]) : undefined) });
    }
  }
  // Seeds for people removed at their request are dropped before any lookup; seeds for people already in the folder
  // are matched locally, free.
  const blockedSeeds = spec.seeds.filter(x => store.blocksSeed(x));
  if (blockedSeeds.length) note(`${blockedSeeds.length} seed${blockedSeeds.length === 1 ? "" : "s"} skipped: removed at the person's request (out/suppressed.json).`);
  spec.seeds = spec.seeds.filter(x => !store.blocksSeed(x));
  const local = new Map<string, Person>();
  for (const x of spec.seeds) { const p = store.localMatch(x); if (p) local.set(`${x.kind}:${x.value}`, p); }
  const todo = spec.seeds.filter(x => !cached(x) && !local.has(`${x.kind}:${x.value}`));
  // People known from earlier seed lookups whose full record is not stored yet still cost a record fetch.
  const recordsNeeded = new Set<number>();
  for (const x of spec.seeds) {
    const c = cached(x);
    const ids = !c ? [] : c.id ? [c.id] : c.status.startsWith("authors:") ? c.status.slice(8).split(",").map(Number).filter(Boolean) : [];
    for (const id of ids) if (!store.people.get(id)?.person.experience && !store.isBlockedId(id)) recordsNeeded.add(id);
  }
  // A rerun of the same search after a failure resumes it: only the searches that had not finished run again.
  const resuming = !!saved?.pending?.length && searchKey(saved.spec) === searchKey(spec) && !spec.fresh && spec.limit === saved.spec.limit && spec.perLab === saved.spec.perLab && spec.scholarEmail === saved.spec.scholarEmail;
  const keyOf = (x: Planned) => x.label;
  if (resuming) {
    const left = searchList.filter(x => saved!.pending!.includes(keyOf(x)));
    note(`Resuming: the last run stopped before ${left.length} of its searches finished; only ${left.length === 1 ? "that one runs" : "those run"} now.`);
    searchList.splice(0, searchList.length, ...left);
  }
  const plan: Plan = {
    records: recordsNeeded.size,
    searches: searchList.map(x => ({ label: `Search, ${x.label}`, people: x.people, filters: x.groups })),
    scholar: todo.filter(x => x.kind === "scholar").length,
    profiles: todo.filter(x => x.kind === "profile").length,
    github: todo.filter(x => x.kind === "github").length,
    papers: todo.filter(x => x.kind === "paper").length,
    perPaper: spec.perPaper,
  };
  const est = estimate(plan, prices);
  const skip0 = store.skipUrls();
  log("");
  if (searchList.length) {
    log(`  query:     ${query}`);
    log(`  titles:    ${spec.anyTitle ? "any" : !labs.length && pastLabs.length ? "any (people who left a lab often found companies or teach; the rubric scores the title)" : mode === "map" ? "research, scientist, technical staff, ML, engineer and tech lead titles (--any-title for all)" : "research scientist, research engineer, researcher, technical staff, ML and scientist titles (--any-title for all)"}`);
    if (spec.country) log(`  country:   ${spec.country}`);
  }
  log(`  skipping:  ${store.people.size && !spec.fresh ? `${store.people.size} people already in ${shown(dir)} (not billed again; --fresh to fetch them again)` : "nobody yet"}`);
  const noUrl = store.withoutUrl();
  if (noUrl && !spec.fresh) note(`${noUrl} ${noUrl === 1 ? "person" : "people"} in the folder ${noUrl === 1 ? "has" : "have"} no profile URL, so a search cannot skip them; they can be returned and billed again.`);
  if (skip0.length > 20_000) note(`The folder has ${skip0.length} people to skip; this tool sends only the newest 20,000, so older ones can be returned and billed again.`);
  const reused = spec.seeds.length - todo.length;
  if (reused) log(`  seeds:     ${reused} already looked up or already in the folder (no new lookup)${recordsNeeded.size ? `; ${recordsNeeded.size} still need their full record` : ""}`);
  const papers = todo.filter(x => x.kind === "paper");
  if (papers.length) log(`  papers:    ${papers.slice(0, 5).map(x => `"${x.value.slice(0, 60)}"`).join(", ")}${papers.length > 5 ? ` and ${papers.length - 5} more` : ""}`);
  log(`  cost:      at most ${fmtCredits(est.ceiling)} credits at ${prices.source === "account" ? "your account's prices" : "list price"} (research records are billed only for people who have one)`);
  for (const l of est.lines) log(`             ${l}`);
  const cap = spec.maxCredits ?? config.maxCredits;
  if (spec.dryRun) {
    log("\nDry run: nothing was searched and nothing was billed. Run the same command without --dry-run.");
    if (est.ceiling > cap) log(`This is above the limit of ${cap} credits (MAX_CREDITS): the real run will stop. Add --max-credits ${Math.ceil(est.ceiling)} to allow it, or lower --limit or --per-paper.`);
    return;
  }
  if (est.ceiling > cap) throw new Error(`This run can cost up to ${fmtCredits(est.ceiling)} credits, above the limit of ${cap}. Lower --limit, or pass --max-credits ${Math.ceil(est.ceiling)} to allow it.`);
  // The --ai cap is checked now, before anything is billed, on the most people the folder can hold after this run.
  if (spec.ai && rubric.ask.length) {
    const cache = readJson<AiCache>(join(dir, "ai.json"), {});
    const unanswered = [...store.people.values()].filter(f => !cache[cacheKey(f.person, rubric.ask)]).length;
    const most = unanswered + searchList.reduce((n, x) => n + x.people, 0) + plan.scholar + plan.profiles + plan.github + plan.papers * spec.perPaper;
    if (most > (spec.maxAi ?? 500)) throw new Error(`--ai could ask Claude about up to ${most} people (one request each). Pass --max-ai ${most} to allow it, or run without --ai and use npm run rescore -- --ai later.`);
  }

  // The search is saved before anything is billed, so a run that stops part way can be run again with --name.
  const keep = (!searches(spec) || seedsOnly) && saved ? saved : undefined;
  const allSeeds = [...(saved?.seeds ?? [])];
  for (const x of spec.seeds) if (!allSeeds.some(y => y.kind === x.kind && y.value === x.value)) allSeeds.push(x);
  const { seeds: _s, seedProblems: _p, dryRun: _d, maxCredits: _m, typed: _t, nameTyped: _n, ...specToSave } = spec;
  // Settings typed with a seeds-only rerun (--rubric, --top) are kept with the saved search.
  const keptSpec = keep ? { ...keep.spec, ...(spec.typed.includes("rubricFile") ? { rubricFile: spec.rubricFile } : {}), ...(spec.typed.includes("top") ? { top: spec.top } : {}) } : undefined;
  const runFile: RunFile = {
    spec: keptSpec ?? { ...specToSave, seedFiles: [], fresh: false, ai: false, maxAi: undefined },
    labs: keep ? keep.labs : labs, pastLabs: keep ? keep.pastLabs : pastLabs, seeds: allSeeds, updated: new Date().toISOString(),
    pending: [...new Set([...(resuming ? [] : []), ...searchList.map(keyOf)])],
  };
  const saveRun = () => writeJson(join(dir, "run.json"), runFile);
  saveRun();

  const credits = (n: number) => `${fmtCredits(n)} credit${n === 1 ? "" : "s"}`;
  const creditsLine = () => process.env.ARF_REPLAY ? `A live run would have used ${credits(spend.credits)}.` : `This run used ${credits(spend.credits)}.`;
  try {
    log("");
    let dropped = 0;
    const before = store.people.size;
    const addedNow = new Set<string>();
    // The skip list is read again before each search, so a person at two searched labs is billed once (with
    // --fresh, people already found are fetched again, but each only once in this run).
    const skipNow = () => (spec.fresh ? [...readSuppressed().urls, ...addedNow] : store.skipUrls());
    for (const x of searchList) {
      const skip = skipNow();
      const sizeBefore = store.people.size;
      const { people, total } = await searchPeople({
        search: { query, mode: "hybrid" }, mode: "exact", filters: x.filters, fields: PERSON_FIELDS,
        ...(skip.length ? { post_processing: { exclude_profiles: skip.slice(-20_000) } } : {}),
      }, x.people, note, got => {
        const labIdSet = new Set(labs.map(l => l.id));
        const keepers = spec.anyTitle || x.via !== "search" ? got : got.filter(p => !notResearch(roleAt(p, labIdSet)?.title ?? p.basic_profile?.current_title ?? ""));
        const gone = got.filter(p => !keepers.includes(p));
        dropped += gone.length;
        store.drop(gone.map(profileUrlOf).filter(Boolean));
        for (const p of got) if (profileUrlOf(p)) addedNow.add(profileUrlOf(p));
        store.add(keepers, x.via);
      });
      // This search is done: a rerun after a later failure will not buy more people here.
      runFile.pending = (runFile.pending ?? []).filter(k => k !== keyOf(x));
      saveRun();
      const added = store.people.size - sizeBefore;
      log(`Search, ${x.label}: ${added} new${people.length > added ? ` (${people.length} returned)` : ""} of ${total?.toLocaleString("en-US") ?? "?"} who match`);
    }
    void before;
    if (dropped) note(`${dropped} ${dropped === 1 ? "person was" : "people were"} left out because the title is not a research role (UX research, recruiting, program management...); billed once, and skipped in later runs.`);

    // Seeds.
    const remember = (x: Seed, id: number | undefined, status: string) => { seedCache[`${x.kind}:${x.value}`] = { id, status }; };
    const saveSeeds = () => writeJson(join(dir, "seeds.json"), seedCache);
    const viaOf = (x: Seed) => x.kind === "scholar" ? `Google Scholar profile ${x.value}` : x.kind === "github" ? `GitHub profile ${x.value}` : x.kind === "profile" ? `profile URL ${x.value}` : `paper: ${x.value}`;
    const wanted = new Map<number, string[]>();
    const want = (id: number, via: string) => wanted.set(id, [...new Set([...(wanted.get(id) ?? []), via])]);
    for (const [k, p] of local) { const x = spec.seeds.find(y => `${y.kind}:${y.value}` === k)!; want(p.crustdata_person_id, viaOf(x)); }
    for (const x of spec.seeds) {
      const c = cached(x);
      if (c && c.id) want(c.id, viaOf(x));
      // Paper authors found on an earlier run come back from the cache, free.
      if (c && c.status.startsWith("authors:")) for (const id of c.status.slice(8).split(",").map(Number).filter(Boolean)) want(id, viaOf(x));
    }

    for (const kind of ["scholar", "profile"] as const) {
      const list = todo.filter(x => x.kind === kind);
      if (!list.length) continue;
      const rows = await identifyPeople(kind === "scholar" ? "research_profile_urls" : "professional_network_profile_urls", list.map(x => x.value));
      let matched = 0;
      for (const x of list) {
        const row = rows.get(x.value);
        const id = row?.matches?.[0]?.person_data?.crustdata_person_id;
        const label = kind === "scholar" ? "Scholar" : "Profile";
        if (!row) { log(`  ${label} URL got no answer from Crustdata: ${x.value} (not saved; it is asked again next run)`); continue; }
        remember(x, id, row.match_status);
        if (id) { matched++; want(id, viaOf(x)); }
        else if (row.match_status === "redacted") log(`  ${label} URL ${x.value}: this person asked Crustdata to remove their data; nothing is stored (not billed)`);
        else log(`  ${label} URL not found in Crustdata: ${x.value} (not billed)`);
      }
      saveSeeds();
      log(`${kind === "scholar" ? "Google Scholar profiles" : "Profile URLs"}: ${matched} of ${list.length} matched`);
    }
    const github = todo.filter(x => x.kind === "github");
    for (const x of github) {
      const r = await githubToPerson(x.value);
      const id = r.crustdata_person_id ?? undefined;
      const acct = r.dev_platform_profiles?.[0];
      remember(x, id, id ? "matched" : acct ? "not_linked" : "not_found");
      saveSeeds();
      if (id) want(id, viaOf(x));
      else log(`  GitHub ${x.value}: ${acct ? `found${acct.name ? ` (${acct.name}${acct.company_text ? `, ${acct.company_text}` : ""})` : ""}, but not linked to a person in Crustdata` : "not found"} (1 credit)`);
    }
    if (github.length) log(`GitHub profiles: ${github.filter(x => seedCache[`github:${x.value}`]?.id).length} of ${github.length} linked to a person`);

    for (const x of papers) {
      // Authors already in the folder are matched here for free, and left out of the search so they are not billed again.
      const known = [...store.people.values()].filter(f => papersOf(f.person).some(a => samePaper(x.value, a.title)));
      if (known.length) store.addMany(known.map(f => ({ person: f.person, via: viaOf(x) })));
      // Skipped: the authors just credited, people removed at their request, and people dropped earlier. Others in
      // the folder whose stored record does not list the paper can still come back as its authors.
      const skip = [...new Set([...known.map(f => profileUrlOf(f.person)).filter(Boolean), ...readSuppressed().urls, ...store.dropped])];
      const { people } = await searchPeople({ filters: and(leaf("research_profiles.articles.title", "[.]", x.value)), fields: PERSON_FIELDS, ...(skip.length ? { post_processing: { exclude_profiles: skip.slice(-20_000) } } : {}) }, spec.perPaper, note);
      const authors = people.filter(p => papersOf(p).some(a => samePaper(x.value, a.title)));
      store.add(authors, viaOf(x));
      for (const p of people) if (profileUrlOf(p)) addedNow.add(profileUrlOf(p));
      remember(x, undefined, `authors:${[...known.map(f => f.person), ...authors].map(a => a.crustdata_person_id).join(",")}`);
      saveSeeds();
      const other = people.length - authors.length;
      const n = authors.length + known.length;
      log(`Paper "${x.value.slice(0, 70)}": ${n} author${n === 1 ? "" : "s"} found${known.length ? ` (${known.length} already in the folder, free)` : ""}${other ? `; ${other} other ${other === 1 ? "person" : "people"} with a different paper using the same words ${other === 1 ? "was" : "were"} left out (billed)` : ""}`);
    }

    // People removed at their request are never fetched again, even from a seed looked up before.
    for (const id of [...wanted.keys()]) if (store.isBlockedId(id)) wanted.delete(id);
    const need = [...wanted.keys()].filter(id => !store.people.get(id)?.person.experience);
    const items: Array<{ person: Person; via: string }> = [];
    if (need.length) for (const p of await peopleById(need, note)) for (const via of wanted.get(p.crustdata_person_id) ?? []) items.push({ person: p, via });
    for (const [id, vias] of wanted) { const f = store.people.get(id); if (f && !need.includes(id)) for (const via of vias) items.push({ person: f.person, via }); }
    if (items.length) store.addMany(items);
  } catch (err) {
    // What was billed before the failure is saved; write the report from it, then say what stopped.
    await scoreAndWrite(spec.name, rubric, { ai: false, top: spec.top, quiet: true, notes: [...notes, `This run stopped early: ${(err as Error).message}`], creditsLine: creditsLine() }).catch(() => {});
    throw err;
  }

  try {
    await scoreAndWrite(spec.name, rubric, { ai: spec.ai, maxAi: spec.maxAi, top: spec.top, notes, creditsLine: creditsLine() });
  } catch (err) {
    // Scoring failed after billing (a Claude problem, say): still write the report without the Claude answers.
    await scoreAndWrite(spec.name, rubric, { ai: false, top: spec.top, notes: [...notes, `Scoring with --ai failed: ${(err as Error).message}`], creditsLine: creditsLine() });
    throw err;
  }
}

/** Steps 5 and 6, shared by find, map and rescore. */
export async function scoreAndWrite(name: string, rubric: Rubric, opts: { ai: boolean; maxAi?: number; top: number; notes?: string[]; creditsLine?: string; now?: Date; quiet?: boolean; silent?: boolean; rubricName?: string }): Promise<Row[]> {
  const dir = folderFor(name);
  const run = readJson<RunFile | undefined>(join(dir, "run.json"), undefined);
  const store = new Store(dir);
  const found = [...store.people.values()];
  if (!found.length) {
    // Nobody (left) in the folder: the report and the CSV say so, so no old file names anyone.
    if (existsSync(join(dir, "report.md")) || existsSync(join(dir, "researchers.csv"))) {
      writeCsv(join(dir, "researchers.csv"), CSV_HEADER, []);
      writeFileSync(join(dir, "report.md"), "# Nobody in this search\n\nEveryone found was removed, or nobody was found yet.\n", { mode: 0o600 });
    }
    if (!opts.quiet && !opts.silent) log(`\nNobody found yet for "${name}". Try fewer filters: drop --country, add --any-title, or widen --labs.`);
    if (opts.creditsLine) log(opts.creditsLine);
    return [];
  }
  const labs = [...(run?.labs ?? []), ...(run?.pastLabs ?? [])];
  const labNames = new Map((run?.labs ?? []).map(l => [l.id, l.name] as const));
  const labIds = new Set(labNames.keys());
  const tax = loadTaxonomy();
  const now = opts.now ?? new Date();
  const teams = guessTeams(found.map(f => f.person), labIds, tax, now);
  const ctx = { topics: run?.spec.topics ?? [], labIds: new Set(labs.map(l => l.id)), labNames: labs.map(l => l.name), now };
  let answers = new Map<number, Outcome[]>();
  if (opts.ai && rubric.ask.length) {
    const limit = opts.maxAi ?? 500;
    const cacheFile = join(dir, "ai.json");
    const cache = readJson<AiCache>(cacheFile, {});
    const toAsk = found.filter(f => !cache[cacheKey(f.person, rubric.ask)]).length;
    if (toAsk > limit) throw new Error(`--ai would ask Claude about ${toAsk} people (one request each). Pass --max-ai ${toAsk} to allow it, or score a smaller folder.`);
    log(`\nAsking Claude the ${rubric.ask.length} rubric question${rubric.ask.length === 1 ? "" : "s"} for ${toAsk} ${toAsk === 1 ? "person" : "people"} (${found.length - toAsk} answered before, reused).`);
    answers = await askAll(found.map(f => f.person), rubric.ask, m => { log(`  note: ${m}`); (opts.notes ??= []).push(m); }, cache);
    writeJson(cacheFile, cache);
  }
  const rows: Row[] = found.map(f => {
    const team = teams.get(f.person.crustdata_person_id)!;
    const scored = scorePerson(rubric, f, team, ctx, answers.get(f.person.crustdata_person_id) ?? []);
    return { found: f, team, scored, ...labOf(f.person, labNames) };
  });

  const searched: string[] = [];
  if (run?.spec) {
    const s = run.spec;
    if (s.labs.length || s.pastLabs.length || s.role || s.topics.length) searched.push(`Search: ${queryFor(s)}${run.labs.length ? `, at ${run.labs.map(l => l.name).join(", ")}` : ""}${run.pastLabs.length ? `, before at ${run.pastLabs.map(l => l.name).join(", ")}` : ""}${s.country ? `, in ${s.country}` : ""}`);
    if (run.seeds.length) searched.push(`Seeds: ${["scholar", "github", "profile", "paper"].map(k => [k, run.seeds.filter(x => x.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => `${n} ${k === "scholar" ? "Google Scholar profile" : k === "github" ? "GitHub profile" : k === "profile" ? "profile URL" : "paper title"}${n === 1 ? "" : "s"}`).join(", ")}`);
  }
  if (!opts.ai && rubric.ask.length) searched.push(`Rubric questions left out (they need --ai): ${rubric.ask.length}`);
  const sp = run?.spec;
  const title = sp?.mode === "map" && run?.labs.length ? `Team map: ${run.labs[0].name}`
    : run?.labs.length ? `AI researchers and ML engineers at ${run.labs.map(l => l.name).join(", ")}`
    : run?.pastLabs.length ? `AI researchers and ML engineers who worked at ${run.pastLabs.map(l => l.name).join(", ")}`
    : `AI researchers: ${name}`;
  const dates = found.map(f => (f.found_at ?? "").slice(0, 10)).filter(Boolean).sort();
  const fetched = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`) : undefined;
  writeCsv(join(dir, "researchers.csv"), CSV_HEADER, csvRows(rows, labIds, now));
  const reportFile = join(dir, "report.md");
  const rubricName = opts.rubricName ?? (run?.spec.rubricFile ? run.spec.rubricFile.split(/[\\/]/).pop()! : "rubric.json");
  writeFileSync(`${reportFile}.${process.pid}.tmp`, report(rows, { title, searched, date: now.toISOString().slice(0, 10), fetched, credits: opts.creditsLine, notes: opts.notes ?? [], rubricName }, opts.top, labIds, now), { mode: 0o600 });
  renameSync(`${reportFile}.${process.pid}.tmp`, reportFile);

  if (opts.silent) return rows;
  // The screen: the top 10 and the team counts.
  const sorted = sortRows(rows);
  log(`\n  #   score  checked  name                        team                                    lab`);
  // East Asian wide characters take two columns in a terminal.
  const width = (t: string) => [...t].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
  const pad = (t: string, n: number) => { let x = t; while (width(x) > n) x = x.slice(0, -1); return x + " ".repeat(n - width(x)); };
  sorted.slice(0, 10).forEach((r, i) => {
    const team = r.team.team ? `${r.team.team} (${r.team.label})` : "not stated";
    log(`  ${String(i + 1).padEnd(3)} ${String(r.scored.score).padEnd(6)} ${`${r.scored.coverage}%`.padEnd(8)} ${pad(nameOf(r.found.person), 27)} ${team.slice(0, 39).padEnd(39)} ${(r.lab === NOT_AT_LAB ? r.employer : r.lab).slice(0, 30)}`);
  });
  const stated = rows.filter(r => r.team.label === "stated").length, inferred = rows.filter(r => r.team.label === "inferred").length;
  log(`\n${rows.length} people in ${shown(dir)}: team stated for ${stated}, inferred for ${inferred}, not stated for ${rows.length - stated - inferred}.`);
  log(`  report.md        the team map, then the top ${Math.min(opts.top, rows.length)} with the evidence behind each point`);
  log(`  researchers.csv  everyone, every column`);
  if (opts.creditsLine) log(opts.creditsLine);
  return rows;
}

/** `npm run rescore`: after changing rubric.json or config/teams.json. Free and offline (unless --ai). */
export async function runRescore(argv: string[]): Promise<void> {
  let name: string | undefined, rubricFile: string | undefined, ai = false, top: number | undefined, maxAi: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    if (flag === "--ai") { ai = true; continue; }
    const value = inline ?? argv[++i];
    if (!value) throw new Error(`${flag} needs a value.`);
    if (flag === "--name") name = slugify(value) || undefined;
    else if (flag === "--rubric") rubricFile = value;
    else if (flag === "--top") top = Number(value);
    else if (flag === "--max-ai") maxAi = Number(value);
    else throw new Error(`Unknown flag ${flag}. Flags: --name <folder>, --rubric <file>, --top N, --ai, --max-ai N`);
  }
  name = name ?? latestRun();
  if (!name) throw new Error("No saved search yet. Run npm run find first.");
  if (ai && !config.anthropicApiKey) throw new Error("--ai needs ANTHROPIC_API_KEY in .env.");
  if (top !== undefined && !(Number.isInteger(top) && top >= 1)) throw new Error("--top takes a whole number, 1 or more.");
  if (maxAi !== undefined && !(Number.isInteger(maxAi) && maxAi >= 1)) throw new Error("--max-ai takes a whole number, 1 or more.");
  if (!existsSync(join(folderFor(name), "people.json"))) throw new Error(`There is no saved search called "${name}" in ${shown(config.outDir)}.`);
  // By default the folder's own rubric and report length, as saved with the search.
  const saved = readJson<RunFile | undefined>(join(folderFor(name), "run.json"), undefined);
  const file = rubricFile ? resolve(process.cwd(), rubricFile) : saved?.spec.rubricFile ? resolve(process.cwd(), saved.spec.rubricFile) : resolve(ROOT, "rubric.json");
  const rubric = loadRubric(file, loadTaxonomy().map(t => t.team));
  log(`Scoring ${shown(folderFor(name))} again with ${shown(file)} (no Crustdata credits).`);
  await scoreAndWrite(name, rubric, { ai, maxAi, top: top ?? saved?.spec.top ?? 25 });
}

/** The folder written most recently, for commands run without --name. */
export function latestRun(): string | undefined {
  if (!existsSync(config.outDir)) return undefined;
  let best: { name: string; t: string } | undefined;
  for (const name of readdirSafe(config.outDir)) {
    const run = readJson<RunFile | undefined>(join(config.outDir, name, "run.json"), undefined);
    if (run?.updated && (!best || run.updated > best.t)) best = { name, t: run.updated };
  }
  return best?.name;
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
}
