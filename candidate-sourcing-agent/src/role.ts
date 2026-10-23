/**
 * The role: one plain-English sentence plus flags. Works without an AI model.
 *
 * The sentence goes to Crustdata's person search as `search.query`, which ranks the people inside the filters by
 * meaning. A small rule-based parser also lifts out what can be a hard filter (place, years, company size, past
 * employers, schools) and the skills to score on, and says out loud what it did with every phrase. Flags always win
 * over the parser. Every stored value (skills, countries, states, schools) is checked with the free autocomplete
 * endpoint before a credit is spent.
 *
 * Words about age, gender, origin, family, religion, race or disability are taken out of the query, never filtered
 * or scored on, and the run says so (see PROTECTED).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.js";
import { and, autocomplete, leaf, or, type Endpoint, type Filter } from "./crustdata.js";
import { domainOf } from "./profile.js";

export type RoleSpec = {
  role: string;                         // the sentence, as typed
  query?: string;                       // what goes to search.query when it differs from the sentence (protected words taken out)
  name: string;                         // folder under out/ for this role's files
  title?: string;                       // the job title read from the sentence (or --title)
  titleStrict?: boolean;                // --title-strict: also require the title as a filter
  keywords?: string;                    // --keywords: a boolean keyword query instead of the sentence
  must: string[];                       // --must: hard filter, every one required (stored skill names)
  skills: string[];                     // skills read from the sentence: scored, never a filter
  nice: string[];                       // --nice: scored, lower weight
  years?: [number, number | null];      // years of experience, min (a filter) and max (scored only; null: no max)
  countries?: string[];                 // where the person lives, full country names ("United States")
  states?: string[];                    // state or region names ("California")
  near?: Array<{ location: string; km: number }>; // within km of a place ("Berlin")
  sizes?: string[];                     // current employer size bands, from the closed set below
  sizeLabel?: string;                   // what the sentence or flag said ("under 500 people")
  sizeRange?: [number, number | null];  // the number of people asked, for the score (the bands are only the filter)
  past?: string[];                      // worked at one of these before (domains or company names)
  skillVariants?: Record<string, string[]>; // a skill stored under other spellings: "Go" -> ["Golang", "Go (Programming Language)"]
  schools?: string[];                   // studied at one of these
  exclude?: string[];                   // never people currently at these domains (your own company)
  openOnly?: boolean;                   // only people who say they are open to new roles
  papers?: boolean;                     // read research records (citations, h-index) and score them
  hasCode?: boolean;                    // only people with a public code profile
  limit: number;                        // new candidates per run
};

/** What a flag can set. null means "clear this" (from `--years none`). */
export type SpecLayer = { [K in keyof RoleSpec]?: RoleSpec[K] | null };

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 1000;

/** The closed set Crustdata stores for employer size. "1-10" or "501-1,000" match nobody. */
export const HEADCOUNT_BANDS: Array<[string, number, number]> = [
  ["myself only", 1, 1], ["2-10", 2, 10], ["11-50", 11, 50], ["51-200", 51, 200], ["201-500", 201, 500],
  ["501-1000", 501, 1000], ["1001-5000", 1001, 5000], ["5001-10000", 5001, 10000], ["10001+", 10001, Infinity],
];

/**
 * Bands for a range of people: a band counts when it lies inside the range or its middle does, so "1000+" does not
 * pull in 501-1000 and "under 500" keeps 201-500. "myself only" is left out unless the range is exactly one person.
 */
export function bandsFor(min: number, max: number): string[] {
  const inside = HEADCOUNT_BANDS.filter(([name, lo, hi]) => {
    if (lo > max || hi < min || (name === "myself only" && max > 1)) return false;
    const mid = hi === Infinity ? lo * 2 : (lo + hi) / 2;
    return (lo >= min && hi <= max) || (mid >= min && mid <= max);
  });
  return (inside.length ? inside : HEADCOUNT_BANDS.filter(([name, lo, hi]) => lo <= max && hi >= min && (name !== "myself only" || max <= 1))).map(([name]) => name);
}

/** Abbreviations read as their long forms, in titles and folder names. */
export const ABBREVIATIONS: Record<string, string> = {
  ml: "machine learning", ai: "artificial intelligence", swe: "software engineer", sre: "site reliability engineer", ae: "account executive",
  sdr: "sales development representative", bdr: "business development representative", pm: "product manager", qa: "quality assurance",
  ux: "user experience", ui: "user interface", devops: "dev ops", nlp: "natural language processing", cv: "computer vision",
};
/** Level words. They do not decide whether a title matches, and do not change a role's folder. */
export const LEVEL_WORDS = new Set(["senior", "sr", "junior", "jr", "staff", "principal", "lead", "mid", "level", "i", "ii", "iii", "iv", "entry", "associate"]);

// ---------------------------------------------------------------------------
// Words this tool never searches, filters or scores on.
// ---------------------------------------------------------------------------

/**
 * Protected characteristics and their common proxies. A phrase that matches is taken out of the query and the run
 * says so. Work words are left alone: "cloud native", "single sign-on", "race conditions", "women's health
 * products", "Black Duck", "Christian Dior" (a capitalised word followed by another name word is a name). The list
 * cannot catch every wording, and the README says so.
 */
const NATIONALITIES = "american|british|indian|chinese|german|french|japanese|korean|mexican|brazilian|canadian|russian|irish|italian|spanish|polish|nigerian|pakistani|filipino|vietnamese|israeli|turkish|ukrainian|dutch|swedish|australian|european|african|arab|latin american";
const PERSON = String.raw`(?:engineers?|developers?|candidates?|people|persons?|applicants?|professionals?|talent|hires?|staff|workers?|designers?|managers?|men|women)`;
const PROTECTED: Array<[RegExp, string]> = [
  [/\b(?:under|over|below|above|younger than|older than|no older than|no younger than|aged?)?\s*\d+\s*(?:to|-|\u2013)?\s*\d*\s*(?:years?|yrs?)[\s-]*old\b|\baged?\s+\d+(?:\s*(?:to|-)\s*\d+)?\b|\b\d+\s*-\s*\d+\s*year[\s-]olds?\b/gi, "age"],
  [/\b(?:under|over|below|above|younger than|older than|no older than|no younger than)\s+\d{2}\b(?![\d,.]*\s*(?:\+|%|k\b|years?|yrs?|people|employees|staff|persons?|FTEs?|headcount|engineers|countries|cities))/gi, "age"],
  [/\bin (?:their|his|her) (?:late |early |mid[\s-])?(?:20|30|40|50|60)s\b|\b\d0[\s-]?somethings?\b|\bborn (?:in|after|before|since) \d{4}\b|\bclass of \d{4}\b|\bgraduated (?:in |after |before |since )?\d{4}(?:\s+or\s+(?:later|after|earlier|before))?\b|\b\d{2}\s+or\s+(?:younger|older|under|less)\b/gi, "age"],
  [/\b(?:young|youthful|digital natives?|recent (?:college )?grad(?:uate)?s?|new grads?|fresh grads?|millennials?|gen[\s-]?z|boomers?|retirees?)\b/gi, "age"],
  [/\b(?:male|female|wom[ae]n|men|guys?|girls?|lad(?:y|ies)|gentlem[ae]n|she|her|gender)\b(?!['\u2019]s|\s+(?:health|apparel|fashion|wear|clothing|products?|sports?|football|soccer|basketball|care)\b)/gi, "gender"],
  [/\bnative (?:\w+ )?speakers?\b|\b(?:english|german|french|spanish|italian|portuguese|mandarin|chinese|japanese|korean|arabic|hindi|russian|dutch|polish|turkish) natives?(?:\s+speakers?)?\b|\bmother tongue(?:\s+[a-z]+)?\b|\bnationality\b|\b(?:born|raised) in\s+(?:the\s+)?[\w.-]+(?:\s+[A-Z][\w.-]*)*|\bnative of\s+(?:the\s+)?[\w.-]+(?:\s+[A-Z][\w.-]*)*|\b(?:of|with)\s+[\w-]+\s+(?:origin|descent|heritage|ancestry)\b/gi, "national origin"],
  [/\b(?:mothers?|fathers?|moms?|dads?|wife|husband|married|marital status|single (?:mothers?|fathers?|parents?)|pregnan\w*|maternity|paternity|childless|no kids|(?:has|have|with|without) (?:kids|children))\b/gi, "family status"],
  [/\b(?:sexual orientation|gay|lesbian|bisexual|lgbtq\+?|transgender|non[\s-]?binary|straight (?:men|women|people|candidates?))\b/gi, "sexual orientation or gender identity"],
  [/\b(?:christian|muslim|jewish|hindu|buddhist|sikh|religio\w*|caucasian|hispanic|latin[oax]s?|african[\s-]american|racial|ethnicity|ethnic|disabled|disabilit\w*|able[\s-]bodied|veterans? only)\b/gi, "religion, race, ethnicity or disability"],
  [new RegExp(String.raw`\b(?:asian|white|black|brown)\s+(?=${PERSON}\b)|\bpeople of colou?r\b|\bB?IPOC\b`, "gi"), "race"],
  [new RegExp(String.raw`\b(?:${NATIONALITIES})(?:[\s-]born)?\s+(?=${PERSON}\b)|\b(?:${NATIONALITIES})[\s-]born\b|\b(?:${NATIONALITIES}) (?:nationals?|citizens?)(?: only)?\b|\b(?:citizens?|nationals?) only\b|\b(?:US|U\.S\.|UK|EU)\s+(?:citizens?|nationals?)(?: only)?\b`, "gi"), "national origin"],
  [new RegExp(String.raw`\bunder the age of \d+\b|\baged? between \d+ and \d+\b|\b(?:younger|older)\s+(?=${PERSON}\b)|\bover[\s-]\d0s\b|\b\d{2}\s?(?:yo|y\.o\.)(?!\w)`, "gi"), "age"],
];

/** Takes protected phrases out of a sentence. Pure, so it is tested. */
/** Names that contain a protected word but are about a company or product, never a person. */
const NAMES_KEPT = /\b(?:Christian Dior|Christian Louboutin|Young (?:&|and) Rubicam|Ernst (?:&|and) Young|Black Duck|BlackRock|Black Knight|Her Campus|White Castle|Asian Development Bank|Women's World Banking)\b/gi;
/** A protected word right before one of these is about a market or a product ("Hispanic marketing", "her team"), not a person. */
const WORK_AFTER = /^\s*(?:['\u2019]s\s+)?(?:market(?:ing|s)?|agency|agencies|brand|brands|products?|insurance|grooming|consumers?|audiences?|customers?|segments?|media|health|healthcare|apparel|fashion|team|teams|benefits|wear|clothing|sports?|football|soccer|care|hours?|reports?|clients?|projects?|accounts?|members?|users?|stores?|countries|cities)\b/i;

/** Takes protected phrases out of a sentence. Pure, so it is tested. */
export function stripProtected(sentence: string): { text: string; found: Array<{ phrase: string; kind: string }> } {
  const kept: string[] = [];
  let text = sentence.replace(NAMES_KEPT, m => { kept.push(m); return `\u0001${kept.length - 1}\u0001`; });
  const found: Array<{ phrase: string; kind: string }> = [];
  for (const [re, kind] of PROTECTED) {
    text = text.replace(re, (m: string, ...args: unknown[]) => {
      const offset = args.find(a => typeof a === "number") as number;
      const whole = args.find(a => typeof a === "string") as string;
      if (WORK_AFTER.test(whole.slice(offset + m.length))) return m;
      if (m.trim()) found.push({ phrase: m.trim(), kind });
      return " ";
    });
  }
  if (found.length) text = text.replace(/"\s*"/g, " ").replace(/(^|\s)\/(?=\s|,|$)/g, " ").replace(/\s+([,;.])/g, "$1").replace(/(?:,\s*){2,}/g, ", ").replace(/^\s*,\s*|\s*,\s*$/g, "").replace(/\s+/g, " ").trim();
  text = text.replace(/\u0001(\d+)\u0001/g, (_, i) => kept[Number(i)]);
  return { text, found };
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const list = (v: string) => v.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);

function parseYears(v: string): [number, number | null] {
  const m = /^(\d+)\s*(?:(\+)|(?:-|to)\s*(\d+))?\s*(?:years?|yrs?)?$/i.exec(v.trim());
  if (!m) throw new Error(`--years takes a number or a range like 4, 4+ or 3-7, got "${v}"`);
  const min = Number(m[1]), max = m[3] ? Number(m[3]) : null;
  if (max !== null && max < min) throw new Error(`--years ${v}: the second number must be the larger one.`);
  return [min, max];
}

function parseSize(v: string): Pick<RoleSpec, "sizes" | "sizeLabel" | "sizeRange"> {
  const word = SIZE_WORDS.find(([re]) => re.test(v.trim()));
  if (word) return { sizes: word[1], sizeLabel: word[2], sizeRange: word[3] };
  const m = /^(\d[\d,]*)\s*-\s*(\d[\d,]*)$/.exec(v.trim()) ?? /^(\d[\d,]*)(\+)$/.exec(v.trim());
  if (!m) throw new Error(`--size takes a range of people like 1-500 or 1000+, or startup, scale-up, enterprise; got "${v}"`);
  const min = Number(m[1].replace(/,/g, "")), max = m[2] === "+" ? Infinity : Number(m[2].replace(/,/g, ""));
  const sizes = bandsFor(Math.max(1, min), max);
  if (max < min || !sizes.length) throw new Error(`--size ${v} covers no company size. Use a range like 1-500, 1000+ or a word: startup, scale-up, enterprise.`);
  return { sizes, sizeLabel: max === Infinity ? `${min}+ people` : `${min} to ${max} people`, sizeRange: [min, max === Infinity ? null : max] };
}

/** "Berlin:30; Munich" -> two places. A known city name ("Bay Area") gets its usual place and radius. */
function parseNear(v: string): Array<{ location: string; km: number }> {
  const places = v.split(/\s*;\s*/).map(s => s.trim()).filter(Boolean).map(part => {
    const m = /^(.+?)(?::\s*(.*))?$/i.exec(part)!;
    if (m[2] !== undefined && !/^\d+\s*(?:km)?$/i.test(m[2].trim())) throw new Error(`--near ${part}: the distance after ":" is a number of km, for example "Berlin:30".`);
    const km = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
    if (km !== undefined && (km < 1 || km > 500)) throw new Error(`--near ${part}: the distance must be 1 to 500 km.`);
    const city = CITIES.find(([re]) => new RegExp(`^(?:${re.source})$`, "i").test(m[1].trim()));
    return { location: city ? city[1] : m[1].trim(), km: km ?? (city ? city[2] : 50) };
  });
  if (!places.length) throw new Error(`--near takes a place, like "Berlin" or "Berlin:30; Munich:30"; got "${v}"`);
  return places;
}

/** --exclude takes domains, or a .txt or .csv file with one domain (or website) per line. */
function parseExclude(v: string): string[] {
  const isFile = /\.(txt|csv)$/i.test(v.trim());
  if (isFile && !existsSync(v.trim())) throw new Error(`--exclude: there is no file called ${v} here. Give the path to a file with one company domain per line, or domains like acme.example.`);
  const values = (isFile ? readFileSync(v.trim(), "utf8").split(/[\n,;]/) : list(v)).map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  // A company name cannot be excluded reliably (names are stored in many spellings), and a do-not-poach list must
  // never drop a line silently, so anything that is not a website domain stops the run.
  const notDomains = values.filter(s => !/^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(s));
  if (notDomains.length) throw new Error(`--exclude: ${notDomains.slice(0, 5).map(x => `"${x}"`).join(", ")}${notDomains.length > 5 ? ` and ${notDomains.length - 5} more` : ""} ${notDomains.length === 1 ? "is not a website domain" : "are not website domains"}, so ${notDomains.length === 1 ? "it" : "they"} cannot be excluded. Use each company's domain, like acme.example, one per line.`);
  const domains = values.map(s => domainOf(s)).filter(d => d.includes("."));
  if (!domains.length) throw new Error(`--exclude takes company domains like acme.example, or a .txt file of them; got "${v}"`);
  return [...new Set(domains)];
}

function positive(name: string, v: string, max: number): number {
  if (!/^\d+$/.test(v.trim())) throw new Error(`--${name} takes a whole number from 1 to ${max}, got "${v}"`);
  const n = Number(v);
  if (n < 1 || n > max) throw new Error(`--${name} takes a whole number from 1 to ${max}, got "${v}"`);
  return n;
}

/** "USA", "us", "U.K." given as --country become the stored full names. */
const canonicalCountries = (values: string[]): string[] =>
  [...new Set(values.flatMap(v => {
    const t = v.trim().length <= 4 ? v.trim().toUpperCase() : v.trim();
    return COUNTRY_WORDS.find(([re]) => new RegExp(`^(?:${re.source})$`, re.flags.replace("g", "")).test(t))?.[1] ?? [v.trim()];
  }))];

const FLAGS: Record<string, (v: string) => SpecLayer> = {
  role: v => ({ role: v }),
  name: v => ({ name: slugify(v) || (() => { throw new Error(`--name needs letters or numbers, got "${v}"`); })() }),
  title: v => ({ title: v }),
  keywords: v => ({ keywords: v }),
  must: v => ({ must: list(v) }),
  skills: v => ({ skills: list(v) }),
  nice: v => ({ nice: list(v) }),
  years: v => ({ years: parseYears(v) }),
  country: v => ({ countries: canonicalCountries(list(v)), states: null, near: null }),
  state: v => ({ states: list(v), near: null, countries: null }),
  near: v => ({ near: parseNear(v), countries: null, states: null }),
  size: v => parseSize(v),
  past: v => ({ past: list(v) }),
  school: v => ({ schools: list(v) }),
  exclude: v => ({ exclude: parseExclude(v) }),
  limit: v => ({ limit: positive("limit", v, MAX_LIMIT) }),
};
/** List flags: given twice, the values add up instead of the second replacing the first. */
const LIST_FIELDS = new Set<keyof RoleSpec>(["must", "skills", "nice", "countries", "states", "near", "past", "schools", "exclude"]);
/** `--x none` clears these. */
const CLEARABLE: Record<string, Array<keyof RoleSpec>> = {
  title: ["title", "titleStrict"], keywords: ["keywords"], must: ["must"], skills: ["skills"], nice: ["nice"], years: ["years"],
  country: ["countries", "states", "near"], state: ["states"], near: ["near"], size: ["sizes", "sizeLabel"], past: ["past"], school: ["schools"], exclude: ["exclude"],
};
/** Flags that turn something on, and the spec field each sets. `--no-<x>` turns it off again. */
const SPEC_SWITCHES: Record<string, keyof RoleSpec> = { "title-strict": "titleStrict", "open-only": "openOnly", papers: "papers", "has-code": "hasCode" };
const RUN_SWITCHES = { fresh: "fresh", yes: "yes", ai: "ai", "no-watch-hint": "noWatchHint", "dry-run": "dryRun", help: "help" } as const;

export type RunOptions = {
  fresh: boolean; yes: boolean; ai: boolean; noWatchHint: boolean; dryRun: boolean; help: boolean;
  seen?: string; skipFrom: string[]; top: number;
  /** Notes from reading the flags (protected words taken out of a flag value). */
  notes: string[];
};
/** Flag values that can carry words about people; they go through the same protected-words check as the sentence. */
const CHECKED_FLAGS = new Set(["keywords", "title", "must", "nice", "skills"]);

export const FLAG_HELP = `Flags (run "npm run source -- --help" to see this):
  --role "..."             the role sentence (ranks the search; its filters are read)
  --name ml-engineer-us    the role's folder in out/; use it to come back to a role
  --must "PyTorch, Go"     skills every candidate must list
  --nice "Kubernetes"      skills that raise the score
  --skills "Go, Rust"      replace the skills read from the sentence (scored)
  --title "Data engineer"  set the title; --title-strict also makes it a filter
  --years 4 | 4+ | 3-7     years of experience (the lower number is a filter, the upper one only scores)
  --country "United States"   --state California   --near "Berlin:30; Munich:30"
  --size 1-500 | startup | scale-up | enterprise   current employer size
  --past "examplelabs.example, Example Robotics"   worked at one of these (domains or names)
  --school "Example State University"        studied at one of these
  --exclude yourcompany.example | do-not-poach.txt   never people currently there
  --open-only  --has-code  --papers           open to new roles; public code profile; research records
  --keywords '"site reliability" +kubernetes' a boolean keyword query instead of the sentence
  --limit 20               new candidates per run (up to 1,000)
  --top 10                 people in shortlist.md
  --seen out/team-seen.csv a seen list shared by several roles (made by this tool)
  --skip-from ats.csv      also skip every profile URL in this file (read only, never changed)
  --fresh                  ignore the seen list for this run (people are billed again)
  --dry-run                show what it understood and the cost, spend nothing
  --yes                    run without asking (needed in scripts for runs over 30 credits)
  --ai                     add a "why this candidate" sentence (needs an AI key)
  --no-watch-hint          no watcher line at the end
  --x none                 clears a filter the sentence or a flag set, for example --years none`;

export function parseFlags(argv: string[]): { flags: SpecLayer; options: RunOptions } {
  const flags: SpecLayer = {};
  const options: RunOptions = { fresh: false, yes: false, ai: false, noWatchHint: false, dryRun: false, help: false, skipFrom: [], top: 10, notes: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-y") { options.yes = true; continue; }
    if (arg === "-h") { options.help = true; continue; }
    if (!arg.startsWith("--")) throw new Error(`Unexpected "${arg}". Put the role in quotes after --role, for example --role "Data engineer, 3+ years, Germany".`);
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const switchName = (RUN_SWITCHES as Record<string, keyof RunOptions>)[key] ?? (SPEC_SWITCHES[key] || (key.startsWith("no-") && SPEC_SWITCHES[key.slice(3)]) ? key : undefined);
    if (switchName && inline !== undefined) throw new Error(`--${key} is a switch and takes no value. Leave out "=${inline}"${SPEC_SWITCHES[key] ? `, or use --no-${key} to turn it off` : ""}.`);
    if ((RUN_SWITCHES as Record<string, keyof RunOptions>)[key]) { Object.assign(options, { [(RUN_SWITCHES as Record<string, string>)[key]]: true }); continue; }
    if (SPEC_SWITCHES[key]) { Object.assign(flags, { [SPEC_SWITCHES[key]]: true }); continue; }
    if (key.startsWith("no-") && SPEC_SWITCHES[key.slice(3)]) { Object.assign(flags, { [SPEC_SWITCHES[key.slice(3)]]: false }); continue; }
    if (!FLAGS[key] && !["seen", "skip-from", "top"].includes(key)) throw new Error(`Unknown flag --${key}.\n${FLAG_HELP}`);
    let value = inline ?? argv[++i];
    if (value === undefined || value.trim() === "" || (value.startsWith("--") && inline === undefined)) throw new Error(`--${key} needs a value.`);
    if (CHECKED_FLAGS.has(key)) {
      const { text, found } = stripProtected(value);
      if (found.length) {
        options.notes.push(`--${key}: ${found.map(f => `"${f.phrase}"`).join(", ")} taken out (about ${[...new Set(found.map(f => f.kind))].join("; ")}); this tool never searches, filters or scores on it.`);
        value = text;
        if (!value.trim()) continue;
      }
    }
    if (key === "seen") { options.seen = resolve(value); continue; }
    if (key === "skip-from") { if (!existsSync(value)) throw new Error(`--skip-from: there is no file called ${value} here.`); options.skipFrom.push(resolve(value)); continue; }
    if (key === "top") { options.top = positive("top", value, 100); continue; }
    if (value.toLowerCase() === "none" && CLEARABLE[key]) { for (const f of CLEARABLE[key]) Object.assign(flags, { [f]: null }); continue; }
    for (const [k, v] of Object.entries(FLAGS[key](value)) as Array<[keyof RoleSpec, unknown]>) {
      const prev = flags[k];
      (flags as Record<string, unknown>)[k] = LIST_FIELDS.has(k) && Array.isArray(prev) && Array.isArray(v) ? [...new Set([...prev, ...v])] : v;
    }
  }
  return { flags, options };
}

// ---------------------------------------------------------------------------
// Rule-based sentence parser
// ---------------------------------------------------------------------------

/** Where people live. Values are the full names Crustdata stores; every one is checked with autocomplete anyway. */
const EUROPE = ["United Kingdom", "Germany", "France", "Netherlands", "Spain", "Italy", "Sweden", "Ireland", "Switzerland", "Denmark", "Finland", "Norway", "Belgium", "Austria", "Poland", "Portugal"];
const COUNTRY_WORDS: Array<[RegExp, string[]]> = [
  [/\bNorth America\b/i, ["United States", "Canada"]],
  [/\b(?:US|USA)\b/, ["United States"]],
  [/\bU\.S\.(?:A\.?)?(?!\w)|\bunited states(?: of america)?\b|(?<!(?:latin|south|central|north) )\bamerica\b/i, ["United States"]],
  [/\bUK\b/, ["United Kingdom"]],
  [/\bU\.K\.(?!\w)|\bunited kingdom\b|\bbritain\b|\bengland\b|\bscotland\b|\bwales\b/i, ["United Kingdom"]],
  [/\b(?:LATAM|Latin America|South America)\b/i, ["Brazil", "Mexico", "Argentina", "Colombia", "Chile", "Peru", "Uruguay"]],
  [/\bNordics?\b|\bScandinavia\b/i, ["Sweden", "Denmark", "Finland", "Norway"]],
  [/\bDACH\b/, ["Germany", "Austria", "Switzerland"]],
  [/\bEurop(?:e|ean)\b|\bEMEA\b|\bEU\b/i, EUROPE],
  ...["Canada", "India", "Germany", "France", "Netherlands", "Spain", "Italy", "Sweden", "Ireland", "Switzerland", "Denmark", "Finland", "Norway",
    "Belgium", "Austria", "Poland", "Portugal", "Israel", "Australia", "New Zealand", "Singapore", "Brazil", "Mexico", "Argentina", "Colombia",
    "Japan", "South Korea", "Indonesia", "Philippines", "Vietnam", "Nigeria", "Kenya", "South Africa", "Egypt", "Turkey", "Romania", "Ukraine",
    "Pakistan", "United Arab Emirates", "Saudi Arabia", "Estonia", "Greece", "Czechia"].map((name): [RegExp, string[]] => [new RegExp(String.raw`\b${name}\b`, "i"), [name]]),
  [/\bUAE\b|\bDubai\b/i, ["United Arab Emirates"]],
  [/\bHolland\b/i, ["Netherlands"]],
];
/** US states, by full name, longest first so "West Virginia" is not also read as Virginia. Georgia and Washington are ambiguous and handled apart. */
const US_STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri",
  "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "West Virginia", "Wisconsin", "Wyoming"]
  .sort((a, b) => b.length - a.length);
/** Two-letter US state codes, read only right after a city ("Raleigh, NC"), never on their own. */
const US_STATE_CODES: Record<string, string> = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia" };
/** Cities become "lives within N km of" (geo_distance). They win over a country or state in the same sentence. */
const CITIES: Array<[RegExp, string, number]> = [
  [/\b(?:SF )?Bay Area\b|\bSilicon Valley\b|\bSan Francisco\b|\bSF\b/, "San Francisco", 80],
  [/\bNYC\b|\bNew York City\b|\bManhattan\b|\bBrooklyn\b|\bNew York\b(?!\s+state)/, "New York", 50],
  [/\bWashington,?\s*D\.?C\.?(?!\w)|\bD\.C\.(?!\w)/, "Washington, DC", 40],
  [/\bKansas City\b/, "Kansas City", 50],
  [/\bLos Angeles\b|\bLA\b(?!\w)/, "Los Angeles", 60],
  [/\bBoston\b/, "Boston", 50], [/\bSeattle\b/, "Seattle", 50], [/\bAustin\b/, "Austin", 50], [/\bChicago\b/, "Chicago", 50],
  [/\bDenver\b/, "Denver", 50], [/\bMiami\b/, "Miami", 50], [/\bAtlanta\b/, "Atlanta", 50], [/\bToronto\b/, "Toronto", 50], [/\bVancouver\b/, "Vancouver", 50],
  [/\bLondon\b/, "London", 50], [/\bBerlin\b/, "Berlin", 50], [/\bMunich\b/, "Munich", 50], [/\bParis\b/, "Paris", 50], [/\bAmsterdam\b/, "Amsterdam", 50],
  [/\bDublin\b/, "Dublin", 40], [/\bStockholm\b/, "Stockholm", 40], [/\bZurich\b|\bZürich\b/, "Zurich", 40], [/\bBarcelona\b/, "Barcelona", 40],
  [/\bBangalore\b|\bBengaluru\b/, "Bengaluru", 50], [/\bMumbai\b/, "Mumbai", 50], [/\bTel Aviv\b/, "Tel Aviv", 40], [/\bSydney\b/, "Sydney", 50],
  [/\bDallas\b/, "Dallas", 60], [/\bHouston\b/, "Houston", 60], [/\bPhoenix\b/, "Phoenix", 60], [/\bPhiladelphia\b/, "Philadelphia", 50],
  [/\bSan Diego\b/, "San Diego", 50], [/\bPortland\b/, "Portland", 50], [/\bRaleigh\b/, "Raleigh", 50], [/\bPittsburgh\b/, "Pittsburgh", 50],
  [/\bCincinnati\b/, "Cincinnati", 50], [/\bMinneapolis\b/, "Minneapolis", 50], [/\bSalt Lake City\b/, "Salt Lake City", 50], [/\bNashville\b/, "Nashville", 50],
  [/\bDetroit\b/, "Detroit", 50], [/\bMontreal\b/, "Montreal", 50], [/\bMadrid\b/, "Madrid", 40], [/\bLisbon\b/, "Lisbon", 40], [/\bWarsaw\b/, "Warsaw", 40],
  [/\bMilan\b/, "Milan", 40], [/\bHamburg\b/, "Hamburg", 40], [/\bCopenhagen\b/, "Copenhagen", 40], [/\bManchester\b/, "Manchester", 40],
  [/\bHyderabad\b/, "Hyderabad", 50], [/\bPune\b/, "Pune", 50], [/\bDelhi\b|\bGurgaon\b|\bGurugram\b|\bNoida\b/, "New Delhi", 60], [/\bChennai\b/, "Chennai", 50],
  [/\bMelbourne\b/, "Melbourne", 50], [/\bTokyo\b/, "Tokyo", 50], [/\bS[aã]o Paulo\b/, "Sao Paulo", 60],
].map(([re, place, km]) => [new RegExp((re as RegExp).source, /\b(?:SF|NYC|LA|D\.)/.test((re as RegExp).source) ? "" : "i"), place, km] as [RegExp, string, number]);

/** The state and country each city is in, so "Austin, Texas" stays the city and does not widen to all of Texas. */
const CITY_REGION: Record<string, string[]> = {
  "San Francisco": ["California", "United States"], "New York": ["New York", "United States"], "Washington, DC": ["United States"],
  "Kansas City": ["Missouri", "Kansas", "United States"], "Los Angeles": ["California", "United States"], Boston: ["Massachusetts", "United States"],
  Seattle: ["Washington", "United States"], Austin: ["Texas", "United States"], Chicago: ["Illinois", "United States"], Denver: ["Colorado", "United States"],
  Miami: ["Florida", "United States"], Atlanta: ["Georgia", "United States"], Toronto: ["Canada"], Vancouver: ["Canada"], London: ["United Kingdom"],
  Berlin: ["Germany"], Munich: ["Germany"], Paris: ["France"], Amsterdam: ["Netherlands"], Dublin: ["Ireland"], Stockholm: ["Sweden"], Zurich: ["Switzerland"],
  Barcelona: ["Spain"], Bengaluru: ["India"], Mumbai: ["India"], "Tel Aviv": ["Israel"], Sydney: ["Australia"],
  Dallas: ["Texas", "United States"], Houston: ["Texas", "United States"], Phoenix: ["Arizona", "United States"], Philadelphia: ["Pennsylvania", "United States"],
  "San Diego": ["California", "United States"], Portland: ["Oregon", "United States"], Raleigh: ["North Carolina", "United States"], Pittsburgh: ["Pennsylvania", "United States"],
  Cincinnati: ["Ohio", "United States"], Minneapolis: ["Minnesota", "United States"], "Salt Lake City": ["Utah", "United States"], Nashville: ["Tennessee", "United States"],
  Detroit: ["Michigan", "United States"], Montreal: ["Canada"], Madrid: ["Spain"], Lisbon: ["Portugal"], Warsaw: ["Poland"], Milan: ["Italy"], Hamburg: ["Germany"],
  Copenhagen: ["Denmark"], Manchester: ["United Kingdom"], Hyderabad: ["India"], Pune: ["India"], "New Delhi": ["India"], Chennai: ["India"], Melbourne: ["Australia"],
  Tokyo: ["Japan"], "Sao Paulo": ["Brazil"],
};

/**
 * Company size words count as the CURRENT employer's size only when the sentence puts the person there ("at a
 * startup", "at an enterprise company"). "Enterprise account executive" and "startup experience" stay in the query.
 */
const AT = String.raw`(?:\b(?:at|for|in|from|joining)\s+(?:an?\s+)?(?:(?:early|seed|growth|late)[\s-]stage\s+|small\s+|fast[\s-]growing\s+|venture[\s-]backed\s+|vc[\s-]backed\s+)*)`;
const AT_OR = String.raw`(?:${AT}|\bor\s+(?:an?\s+)?)`;
const SIZE_WORDS: Array<[RegExp, string[], string, [number, number | null]]> = [
  [new RegExp(String.raw`^start[\s-]?ups?$|${AT_OR}start[\s-]?ups?\b`, "i"), bandsFor(2, 200), "startup (under 200 people)", [2, 200]],
  [new RegExp(String.raw`^scale[\s-]?ups?$|${AT_OR}scale[\s-]?ups?\b`, "i"), bandsFor(201, 1000), "scale-up (201 to 1,000 people)", [201, 1000]],
  [new RegExp(String.raw`^enterprises?$|${AT_OR}(?:large\s+)?enterprises?(?:\s+compan(?:y|ies))?\b|\blarge compan(?:y|ies)\b|\bbig tech\b`, "i"), bandsFor(1001, Infinity), "enterprise (over 1,000 people)", [1001, null]],
];
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?k?)`;
const PEOPLE = String.raw`\s*(?:people|employees|staff|persons?|FTEs?|headcount)\b`;
const toNum = (s: string) => (s.toLowerCase().endsWith("k") ? Number(s.slice(0, -1).replace(/,/g, "")) * 1000 : Number(s.replace(/,/g, "")));
const SIZE_NUMBERS: Array<[RegExp, (m: RegExpExecArray) => [number, number]]> = [
  [new RegExp(String.raw`(?:between\s+)?${NUM}\s*(?:to|-|\u2013|and)\s*${NUM}${PEOPLE}`, "i"), m => [toNum(m[1]), toNum(m[2])]],
  [new RegExp(String.raw`(?:under|fewer than|less than|below|up to|smaller than|<)\s*${NUM}${PEOPLE}`, "i"), m => [1, toNum(m[1]) - 1]],
  [new RegExp(String.raw`(?:over|more than|above|at least|>)\s*${NUM}${PEOPLE}|${NUM}\s*\+${PEOPLE}`, "i"), m => [toNum(m[1] ?? m[2]), Infinity]],
];
/** A number of people is the employer's size only next to a company word, never "managing 20+ people" or "a team of 30". */
const COMPANY_CONTEXT = /\b(?:compan(?:y|ies)|employers?|startups?|scale[\s-]?ups?|firms?|org(?:anisation|anization)?s?|business(?:es)?|at an?)\b/i;
const TEAM_CONTEXT = /\b(?:team|teams|managing|manages?|managed|lead(?:s|ing)?|led|reports?|direct reports|org of)\b[^,;]*$/i;

const YEARS = String.raw`\s*(?:years?|yrs?)\b(?![\s-]*old)`;
const N = String.raw`(?<![\d.])(\d+(?:\.\d+)?)`;
const YEAR_RULES: Array<[RegExp, (m: RegExpExecArray) => [number, number | null]]> = [
  [new RegExp(String.raw`${N}\s*(?:to|-|\u2013)\s*(\d+(?:\.\d+)?)\s*\+?${YEARS}`, "i"), m => [Math.floor(Number(m[1])), Math.ceil(Number(m[2]))]],
  [new RegExp(String.raw`${N}\s*\+${YEARS}|${N}${YEARS}\s*(?:or more|\+|plus)|(?:at least|minimum(?: of)?|min\.?|over|more than)\s*(\d+(?:\.\d+)?)${YEARS}`, "i"), m => [Math.floor(Number(m[1] ?? m[2] ?? m[3])), null]],
  [new RegExp(String.raw`(?:under|less than|fewer than|up to|at most)\s*(\d+(?:\.\d+)?)${YEARS}`, "i"), m => [0, Math.ceil(Number(m[1]))]],
  [new RegExp(String.raw`${N}${YEARS}`, "i"), m => [Math.floor(Number(m[1])), null]],
];

/** A company or school name: capitalised words, joined only by "or", "and" or "/" (never across a comma). */
const NAME = String.raw`[A-Z][\w.&'-]*(?:\s+(?:of\s+|de\s+|&\s+)?[A-Z0-9][\w.&'-]*)*`;
const NAMES = String.raw`${NAME}(?:\s+or\s+(?:ex[-\s])?${NAME}|\s+and\s+${NAME}|\s*\/\s*${NAME})*`;
const PAST_LEAD = String.raw`\b[eE]x[-\s](?=[A-Z])|\b(?:[fF]ormerly|[pP]reviously)\s+(?:at|of|with)\s+|\b(?:[wW]ho\s+)?(?:has\s+|have\s+)?(?:[wW]orked|[uU]sed to work)\s+(?:at|for)\s+|\b[eE]xperience\s+at\s+`;
const SCHOOL_WORD = /\b(?:University|College|Institute|School|Polytechnic|Academy|Universit[äéy]|IIT|MIT|ETH|EPFL)\b/;
const SCHOOL_LEAD = String.raw`\b(?:studied at|graduated from|graduates? of|degree from|alumni of|alums? of|went to)\s+`;
const OPEN_WORDS = /\bopen to (?:work|new roles|new opportunities|a new role|offers)\b|\bactively (?:looking|searching)\b|\blooking for (?:a )?new (?:role|job)s?\b/i;
const REMOTE = /\b(?:fully\s+)?remote\b/i;

/** Skill lists start after these words: "with PyTorch and Kubernetes", "knows Go", "experience in Rust". */
const SKILL_LEAD = /\b(?:with|knows?|knowing|using|uses|skilled in|proficient in|expert in|expertise in|background in|experience (?:in|with)|experienced (?:in|with)|familiar with|strong in|fluent in|hands[\s-]on (?:with|in))\s+/gi;
/** Words that carry no meaning on their own once the parts that mean something are taken out of a phrase. */
const FILLER = new Set(["a", "an", "the", "at", "in", "on", "of", "for", "from", "to", "based", "located", "living", "who", "has", "have", "with", "and",
  "or", "plus", "people", "person", "company", "companies", "someone", "somebody", "candidate", "candidates", "experience", "experienced", "background",
  "strong", "solid", "good", "deep", "preferably", "ideally", "must", "should", "be", "is", "are", "years", "year", "yrs", "total", "currently", "working",
  "skills", "skill", "knowledge", "around", "near", "area", "metro", "state", "remote", "fully", "hybrid", "onsite", "on-site", "any", "some", "lots",
  "prior", "previous", "relevant", "professional", "industry", "proven", "hands-on", "and/or", "etc", "managing", "leading", "manages", "leads"]);

/** skillCandidates: words that may be skills; sources: the phrase each came from, for the notes. */
export type Parsed = { spec: Partial<RoleSpec>; skillCandidates: string[]; sources: Record<string, string>; notes: string[] };

const whole = (re: RegExp) => new RegExp(`^(?:${re.source})$`, re.flags.replace("g", ""));
const placeWord = (s: string) => CITIES.some(([re]) => whole(re).test(s.trim())) || COUNTRY_WORDS.some(([re]) => whole(re).test(s.trim())) || US_STATES.some(st => st.toLowerCase() === s.trim().toLowerCase()) || /^(?:Georgia|Washington)$/i.test(s.trim());

/**
 * Reads a role sentence. Pure: the skill candidates it returns are checked against stored skill names later
 * (validateSpec), because only Crustdata knows which words are skills.
 */
export function parseSentence(sentence: string): Parsed {
  const spec: Partial<RoleSpec> = {};
  const notes: string[] = [];
  const skillCandidates: string[] = [];
  const sources: Record<string, string> = {};

  // "w/" is "with"; "Washington, DC" must not be split at its comma.
  const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12", fifteen: "15", twenty: "20" };
  const original = sentence.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)(\+?\s*(?:years?|yrs?)\b)/gi, (_, w: string, y: string) => NUMBER_WORDS[w.toLowerCase()] + y)
    .replace(/(\d),(\d{3})\b/g, "$1$2").replace(/\bw\/\s*/gi, "with ").replace(/\bWashington,\s*(D\.?C\.?)(?!\w)/gi, "Washington $1").replace(/\s+/g, " ").trim();
  const { text, found } = stripProtected(original);
  if (found.length) {
    spec.query = text;
    const kinds = [...new Set(found.map(f => f.kind))].join("; ");
    notes.push(`${found.map(f => `"${f.phrase}"`).join(", ")}: about ${kinds}. This tool never searches, filters or scores on age, gender, family status, origin, religion, race or disability, so ${found.length === 1 ? "it was" : "they were"} taken out of the query.`);
  }

  // Everything that becomes a filter is blanked out of `rest`, clause by clause, so it is not read twice.
  const clauses = text.split(/\s*[,;|()]\s*/).filter(Boolean);
  const rest = [...clauses];
  const blank = (i: number, re: RegExp) => { rest[i] = rest[i].replace(re, " "); };

  // Years of experience: the first number followed by "years" (not "years old", already taken out).
  outer: for (const [re, toRange] of YEAR_RULES) {
    for (let i = 0; i < clauses.length; i++) {
      const m = re.exec(clauses[i]);
      if (m) { spec.years = toRange(m); blank(i, new RegExp(re.source, "gi")); break outer; }
    }
  }
  for (let i = 0; i < rest.length; i++) for (const [re] of YEAR_RULES) blank(i, new RegExp(re.source, "gi"));

  // Current employer size: numbers of people next to a company word, then words like "at a startup".
  for (let i = 0; i < clauses.length && !spec.sizes; i++) {
    for (const [re, toRange] of SIZE_NUMBERS) {
      const m = re.exec(clauses[i]);
      if (!m) continue;
      const before = clauses[i].slice(0, m.index);
      if (TEAM_CONTEXT.test(before) || !COMPANY_CONTEXT.test(clauses[i])) {
        const [lo, hi] = toRange(m);
        notes.push(`"${m[0].trim()}" reads as a team size, not the employer's size, so it only ranks. For the employer's size: --size ${hi === Infinity ? `${lo}+` : `${lo}-${hi}`}`);
        blank(i, new RegExp(re.source, "gi"));
        break;
      }
      const [min, max] = toRange(m);
      spec.sizes = bandsFor(min, max);
      spec.sizeLabel = m[0].trim();
      spec.sizeRange = [min, max === Infinity ? null : max];
      blank(i, new RegExp(re.source, "gi"));
      break;
    }
  }
  if (!spec.sizes) {
    // "at a startup or scale-up": every size word that applies, together.
    const words = SIZE_WORDS.filter(([re]) => re.test(text));
    if (words.length) {
      spec.sizes = [...new Set(words.flatMap(w => w[1]))];
      spec.sizeLabel = words.map(w => w[2]).join(" or ");
      spec.sizeRange = [Math.min(...words.map(w => w[3][0])), words.some(w => w[3][1] === null) ? null : Math.max(...words.map(w => w[3][1] as number))];
    }
  }
  for (let i = 0; i < rest.length; i++) for (const [re] of SIZE_WORDS) blank(i, new RegExp(re.source, "gi"));
  if (!spec.sizes && /\bstart[\s-]?ups?\b/i.test(text)) notes.push(`"startup" reads as experience, not the current employer's size, so it only ranks. For the size: --size startup`);

  // Past employers and schools first, clause by clause, so a name never runs on into the next phrase and the place
  // words inside names ("Bank of America", "University of Texas") are not read as where the person lives.
  const past: string[] = [], schools: string[] = [];
  const splitNames = (s: string) => s.split(/\s+or\s+(?:ex[-\s])?|\s+and\s+|\s*\/\s*/).map(x => x.trim()).filter(Boolean);
  const usable = (n: string) => !/^\d/.test(n) && !placeWord(n);
  // placeWord is true only for a name that is exactly a place ("ex-Seattle" is not an employer); "Bank of America" is kept.
  for (let i = 0; i < clauses.length; i++) {
    for (const m of clauses[i].matchAll(new RegExp(String.raw`(?:${PAST_LEAD})(${NAMES})`, "g"))) {
      for (const n of splitNames(m[1]).filter(usable)) (SCHOOL_WORD.test(n) ? schools : past).push(n);
      blank(i, new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
    }
    for (const m of clauses[i].matchAll(new RegExp(String.raw`(?:${SCHOOL_LEAD})(${NAMES})|\bfrom\s+(${NAMES})|^(${NAMES})\s+(?:grads|graduates|alumni|alums)\b`, "g"))) {
      const viaFrom = m[2] !== undefined;
      const names = splitNames(m[1] ?? m[2] ?? m[3]).filter(n => usable(n) && (!viaFrom || SCHOOL_WORD.test(n)));
      if (!names.length) continue;
      schools.push(...names);
      blank(i, new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
    }
  }
  if (past.length) spec.past = [...new Set(past)];
  if (schools.length) spec.schools = [...new Set(schools)];

  // Place. Cities win over states and countries; a state wins over its country.
  const cities: Array<{ location: string; km: number }> = [];
  for (let i = 0; i < rest.length; i++) for (const [re, location, km] of CITIES) if (re.test(rest[i])) { if (!cities.some(c => c.location === location)) cities.push({ location, km }); blank(i, new RegExp(re.source, re.flags + "g")); }
  // "New York or anywhere in the US": a state or country after "or", "anywhere in" or "across" widens the place.
  const widened = new Set<string>();
  const widens = (i: number, re: RegExp) => {
    const m = new RegExp(re.source, re.flags.replace("g", "")).exec(rest[i]);
    return !!m && /\b(?:or|anywhere in|elsewhere in|across|throughout)\s+(?:anywhere\s+in\s+)?(?:the\s+)?$/i.test(rest[i].slice(0, m.index));
  };
  const states: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (/\bwashington state\b/i.test(rest[i])) { states.push("Washington"); blank(i, /\bwashington state\b/gi); }
    if (/\bnew york state\b/i.test(rest[i])) { states.push("New York"); blank(i, /\bnew york state\b/gi); }
    for (const s of US_STATES) {
      const re = new RegExp(String.raw`\b${s}\b`, "i");
      if (re.test(rest[i])) { if (widens(i, re)) widened.add(s); states.push(s); blank(i, new RegExp(re.source, "gi")); }
    }
  }
  const ambiguous: string[] = [];
  for (let i = 0; i < rest.length; i++) for (const word of ["Georgia", "Washington"]) {
    const re = new RegExp(String.raw`\b${word}\b`, "i");
    if (re.test(rest[i])) { ambiguous.push(word); blank(i, new RegExp(re.source, "gi")); }
  }
  const countries: string[] = [];
  for (let i = 0; i < rest.length; i++) for (const [re, names] of COUNTRY_WORDS) if (re.test(rest[i])) { if (widens(i, re)) names.forEach(n => widened.add(n)); countries.push(...names); blank(i, new RegExp(re.source, re.flags.includes("i") ? "gi" : "g")); }
  // "San Francisco, California" is the city; "London or Germany" is both. A state or country that only qualifies a
  // city in the sentence is dropped; any other is kept next to the city, and people in any of them match.
  const cityRegions = new Set(cities.flatMap(c => CITY_REGION[c.location] ?? []));
  const regionsOfCities = new Set([...cityRegions].filter(r => !widened.has(r)));
  const otherStates = [...new Set(states)].filter(s => !regionsOfCities.has(s));
  const otherCountries = [...new Set(countries)].filter(c => !regionsOfCities.has(c) && !(otherStates.length && c === "United States" && !widened.has(c)));
  if (cities.length) spec.near = cities;
  if (otherStates.length) spec.states = otherStates;
  if (otherCountries.length) spec.countries = otherCountries;
  for (const word of ambiguous) if (!cityRegions.has(word)) notes.push(`"${word}" can be a US state or a ${word === "Georgia" ? "country" : "city (Washington, DC)"}, so it is not a filter. Add --state ${word}${word === "Georgia" ? " or --country Georgia" : ' or --near "Washington, DC"'}.`);
  // "Raleigh, NC" or "in Boise, ID": a city with a US state code becomes "lives within 50 km of" that place. A known
  // city keeps its own place unless the code names another state ("Portland, ME" is not Portland, Oregon). Any other
  // name counts only after a place word, so "Data engineer, Python, CA" never searches near "Python, CA".
  for (let i = 0; i < clauses.length - 1; i++) {
    const code = clauses[i + 1].trim();
    const state = US_STATE_CODES[code];
    if (!state) continue;
    const atEnd = (re: RegExp) => new RegExp(String.raw`(?:${re.source})\s*$`, re.flags.replace("g", ""));
    const known = CITIES.find(([re]) => atEnd(re).test(clauses[i]));
    if (known) {
      if (!(CITY_REGION[known[1]] ?? []).includes(state)) {
        const name = atEnd(known[0]).exec(clauses[i])![0].trim();
        spec.near = (spec.near ?? []).map(n => n.location === known[1] ? { location: `${name}, ${code}`, km: 50 } : n);
      }
      rest[i + 1] = rest[i + 1].replace(code, " ");
      continue;
    }
    const city = /\b(?:in|based in|located in|living in|lives in|near|around)\s+([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)?)\s*$/.exec(rest[i]);
    if (!city) {
      const word = /([A-Z][\w.+#-]*)\s*$/.exec(rest[i])?.[1];
      if (word && !placeWord(word)) {
        notes.push(`"${code}" after "${word}" is not read as a place. For a city: --near "City, ${code}:50"; for the state: --state "${state}".`);
        rest[i + 1] = rest[i + 1].replace(code, " ");
      }
      continue;
    }
    if (!placeWord(city[1])) {
      (spec.near ??= []).push({ location: `${city[1]}, ${code}`, km: 50 });
      blank(i, new RegExp(String.raw`\b${city[1]}\s*$`));
      rest[i + 1] = rest[i + 1].replace(code, " ");
      if (spec.states) spec.states = spec.states.filter(st => st !== US_STATE_CODES[code]);
      if (spec.countries) spec.countries = spec.countries.filter(c => c !== "United States");
      if (!spec.states?.length) delete spec.states;
      if (!spec.countries?.length) delete spec.countries;
    }
  }
  // A bare US state code after a city ("Raleigh, NC") is part of the place, never a skill.
  for (let i = 1; i < clauses.length; i++) if (US_STATE_CODES[clauses[i].trim()] && !rest[i - 1].trim().replace(/\s+/g, "")) rest[i] = " ";
  for (let i = 1; i < clauses.length; i++) if (US_STATE_CODES[clauses[i].trim()] && spec.near?.length) rest[i] = " ";
  // "based in Phoenix": a place this tool does not know is said out loud, never silently ignored.
  for (let i = 0; i < rest.length; i++) {
    const m = /\b(?:based in|located in|living in|lives in|near|around|in the)\s+([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)?)(?:\s+area)?\b/.exec(rest[i]);
    if (m && !placeWord(m[1])) notes.push(`"${m[1]}" may be a place this tool does not know (it knows about 55 large cities), so there is no place filter for it. For a place: --near "${m[1]}:50".`);
  }
  if ([spec.near?.length ?? 0, spec.states?.length ?? 0, spec.countries?.length ?? 0].reduce((a, b) => a + b, 0) > 1) notes.push("Several places: people living in any of them match.");
  if (REMOTE.test(text)) {
    const clear = spec.near ? "--near none" : spec.states ? "--state none" : "--country none";
    // (each clears its own kind of place)
    notes.push(`"remote": the place filter is where people live${spec.near || spec.states || spec.countries ? `. Widen it with ${clear}` : ", and none was set, so anyone anywhere can match"}.`);
  }

  if (OPEN_WORDS.test(text)) { spec.openOnly = true; for (let i = 0; i < rest.length; i++) blank(i, new RegExp(OPEN_WORDS.source, "gi")); }

  // The title: the start of the sentence, up to a word that starts something else.
  const title = (clauses[0] ?? "")
    .replace(/^(?:(?:we are |we're |i am |i'm )?(?:looking for|hiring|searching for|find(?: me)?|source|need)\s+)?(?:an?\s+|the\s+)?/i, "")
    .split(/\s+(?:with|who|that|in|at|based|from|for|located|living|knows?|using|ex-|formerly|previously|open|experienced|skilled|familiar|proficient|expert|fluent|strong)\b|\s+\d/i)[0]
    .replace(/[.!?]+$/, "")
    .trim();
  if (title && title.split(/\s+/).length <= 6 && !placeWord(title) && !/^(?:worked|ex|formerly|previously|studied|graduated)\b/i.test(title)) spec.title = title;
  else notes.push("No job title found at the start of the sentence; the query still ranks by the whole sentence. Set one with --title.");

  // Skills: the list after the last "with", "knows", "experience in" of a clause, plus short leftover phrases.
  rest.forEach((clause, i) => {
    let body = clause;
    const leads = [...body.matchAll(SKILL_LEAD)];
    if (leads.length) {
      // The last lead word whose list has something in it ("with Rust experience in Seattle": "with", not "experience in").
      for (const lead of [...leads].reverse()) {
        const listText = body.slice(lead.index! + lead[0].length).split(/\s+(?:in|at|based|from|for|who|located|living|near|around)\b|\s+experience\b/i)[0];
        const parts = splitSkillList(listText).map(meaningful).filter(Boolean);
        if (!parts.length) continue;
        for (const part of parts) addSkill(part, clauses[i]);
        break;
      }
      body = body.slice(0, leads[0].index);
    }
    if (i === 0) return;
    const parts = splitSkillList(body).map(meaningful).filter(Boolean);
    if (!parts.length) return;
    if (parts.every(p => p.split(/\s+/).filter(w => !FILLER.has(w.toLowerCase())).length <= 3)) for (const p of parts) addSkill(p, clauses[i]);
    else notes.push(`"${clauses[i]}" is not a filter; the query ranks on it.`);
  });
  function addSkill(raw: string, clause: string) {
    const s = cleanSkill(meaningful(raw));
    if (!s || /^\d+$/.test(s)) return;
    skillCandidates.push(s);
    sources[s] ??= clause;
  }

  return { spec, skillCandidates: [...new Set(skillCandidates)], sources, notes };
}

/** Splits "Go, Rust and Python" into skills; names written with a slash on purpose ("CI/CD", "A/B testing", "TCP/IP") stay whole. */
const KEEP_SLASH = /\b(?:CI\/CD|A\/B|TCP\/IP|I\/O|UI\/UX|UX\/UI|PL\/SQL)\b/gi;
const splitSkillList = (s: string) => s.replace(KEEP_SLASH, m => m.replace("/", "\u0000"))
  .split(/\s*(?:,|\/|&|\band\b|\bor\b|\bplus\b)\s*/i).map(x => x.replace(/\u0000/g, "/").trim()).filter(Boolean);
const meaningful = (s: string) => {
  const w = s.split(/\s+/).map(x => x.replace(/^[^\w+#.]+|[^\w+#]+$/g, "")).filter(Boolean);
  let a = 0, b = w.length;
  while (a < b && FILLER.has(w[a].toLowerCase())) a++;
  while (b > a && FILLER.has(w[b - 1].toLowerCase())) b--;
  return w.slice(a, b).join(" ");
};
const cleanSkill = (s: string) => s.replace(/^(?:strong|solid|deep|good|hands[\s-]on|some|production|proven)\s+/i, "").replace(/\s+(?:experience|skills?|knowledge|background|expertise)$/i, "").replace(/[.!?]+$/, "").trim();

// ---------------------------------------------------------------------------
// Spec layers: saved role.json, then what the sentence says, then flags.
// ---------------------------------------------------------------------------

/** The fields a sentence decides. A new sentence for the same role name resets these and keeps the rest. */
const SENTENCE_FIELDS: Array<keyof RoleSpec> = ["query", "title", "skills", "years", "countries", "states", "near", "sizes", "sizeLabel", "past", "schools", "openOnly", "keywords"];

export function slugify(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

/**
 * "Senior ML engineer" and "Machine learning engineer" are the same role folder: "senior" is left out and
 * abbreviations are spelled out. Other levels (junior, staff, principal, lead) are different openings and keep their own folder.
 */
export const titleKey = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").split(" ").filter(w => w && w !== "senior" && w !== "sr").map(w => ABBREVIATIONS[w] ?? w).join(" ");

/** Folder name for a role: its title and place, for example machine-learning-engineer-united-states. */
export function roleName(spec: Partial<RoleSpec>, sentence: string): string {
  const places = spec.near?.length ? spec.near.map(n => n.location) : spec.states?.length ? spec.states : spec.countries ?? [];
  const place = places.length === 1 ? places[0] : places.length ? "several-places" : "";
  return slugify(spec.title ? `${titleKey(spec.title)} ${place}` : sentence.split(/\s+/).slice(0, 6).join(" ")) || "role";
}

export function mergeSpec(...layers: Array<SpecLayer | undefined>): RoleSpec {
  const out: Record<string, unknown> = { must: [], skills: [], nice: [], limit: DEFAULT_LIMIT };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      if (v === null) { out[k] = ["must", "skills", "nice"].includes(k) ? [] : undefined; continue; }
      out[k] = v;
    }
  }
  const spec = out as RoleSpec;
  // Must-haves are already required; listing them again as scored skills would count them twice.
  const must = new Set(spec.must.map(s => s.toLowerCase()));
  spec.skills = spec.skills.filter(s => !must.has(s.toLowerCase()));
  spec.nice = spec.nice.filter(s => !must.has(s.toLowerCase()) && !spec.skills.some(x => x.toLowerCase() === s.toLowerCase()));
  return spec;
}

/** A new sentence resets what the old sentence decided, and keeps everything set by a flag (`fromFlags`, saved in role.json). */
export const keepAcrossSentences = (saved: RoleSpec, fromFlags: string[] = []): SpecLayer =>
  Object.fromEntries(Object.entries(saved).filter(([k]) => !SENTENCE_FIELDS.includes(k as keyof RoleSpec) || fromFlags.includes(k))) as SpecLayer;

/** What a new sentence keeps from the saved role, said out loud so nothing carries over silently. */
export function describeKept(kept: SpecLayer): string {
  const parts: string[] = [];
  if (kept.must?.length) parts.push(`--must "${kept.must.join(", ")}"`);
  if (kept.title) parts.push(`--title "${kept.title}"`);
  if (kept.years) parts.push(`--years ${kept.years[0]}${kept.years[1] === null ? "+" : `-${kept.years[1]}`}`);
  if (kept.countries?.length) parts.push(`--country "${kept.countries.join(", ")}"`);
  if (kept.states?.length) parts.push(`--state "${kept.states.join(", ")}"`);
  if (kept.near?.length) parts.push(`--near "${kept.near.map(n => `${n.location}:${n.km}`).join("; ")}"`);
  if (kept.sizeLabel) parts.push(`--size (${kept.sizeLabel})`);
  if (kept.past?.length) parts.push(`--past "${kept.past.join(", ")}"`);
  if (kept.schools?.length) parts.push(`--school "${kept.schools.join(", ")}"`);
  if (kept.keywords) parts.push(`--keywords ${JSON.stringify(kept.keywords)}`);
  if (kept.nice?.length) parts.push(`--nice "${kept.nice.join(", ")}"`);
  if (kept.exclude?.length) parts.push(`--exclude ${kept.exclude.join(",")}`);
  if (kept.titleStrict) parts.push("--title-strict");
  if (kept.openOnly) parts.push("--open-only");
  if (kept.hasCode) parts.push("--has-code");
  if (kept.papers) parts.push("--papers");
  if (kept.limit && kept.limit !== DEFAULT_LIMIT) parts.push(`--limit ${kept.limit}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Validation against stored values (free), before any credit is spent.
// ---------------------------------------------------------------------------

const same = (a: string, b: string) => a.toLowerCase().trim() === b.toLowerCase().trim();
const exact = (values: string[], want: string) => values.find(v => same(v, want));

export type Validated = { spec: RoleSpec; problems: string[]; notes: string[] };

/**
 * Checks every stored value with autocomplete and replaces it with the stored spelling. A must-have skill, a country
 * or a state with no exact match stops the run with the closest suggestions. Sentence skills that are not stored
 * skill names stay in the query only; --nice skills that are not stored are still scored from what people wrote.
 */
export async function validateSpec(input: RoleSpec, skillCandidates: string[] = [], sources: Record<string, string> = {}): Promise<Validated> {
  const spec: RoleSpec = { ...input, must: [...input.must], skills: [...input.skills], nice: [...input.nice] };
  const problems: string[] = [], notes: string[] = [];
  const SKILL = "skills.professional_network_skills";
  const suggest = (values: string[]) => (values.length ? ` Closest stored values: ${values.slice(0, 5).map(v => `"${v}"`).join(", ")}.` : " Nothing similar is stored.");

  // Some skills are stored only under longer spellings ("Go" as "Golang" and "Go (Programming Language)"). When the
  // name typed is not stored, those spellings are looked up (free) and any of them counts.
  const variantsOf = async (s: string): Promise<string[]> => {
    const want = s.toLowerCase();
    const found = (await Promise.all([`${s} (`, `${s}lang`, `${s} programming`].map(q => autocomplete(SKILL, q)))).flat();
    return [...new Set(found.filter(v => { const l = v.toLowerCase(); return l === `${want}lang` || l === `${want} programming language` || l === `${want} (programming language)` || l === `${want} (${want}lang)`; }))]
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
  };
  spec.skillVariants = { ...(spec.skillVariants ?? {}) };
  spec.must = await Promise.all(spec.must.map(async s => {
    const values = await autocomplete(SKILL, s);
    const hit = exact(values, s);
    if (hit) return hit;
    const variants = await variantsOf(s);
    if (variants.length) {
      spec.skillVariants![s] = variants;
      notes.push(`--must "${s}" is stored as ${variants.map(v => `"${v}"`).join(" or ")}; any of them counts.`);
      return s;
    }
    problems.push(`--must "${s}" is not a stored skill name, so it would match nobody.${suggest(values)}`);
    return s;
  }));

  const fromSentence: string[] = [];
  const notSkills: string[] = [];
  for (const s of [...new Set([...spec.skills, ...skillCandidates])]) {
    if (spec.must.some(m => same(m, s))) continue;
    const hit = exact(await autocomplete(SKILL, s), s);
    if (hit) { fromSentence.push(hit); continue; }
    const variants = await variantsOf(s);
    if (variants.length) { spec.skillVariants![s] = variants; fromSentence.push(s); }
    else if (skillCandidates.includes(s)) notSkills.push(sources[s] ?? s);
    else fromSentence.push(s);
  }
  for (const phrase of [...new Set(notSkills)]) notes.push(`"${phrase}" is not a skill name, so it is not scored; the query ranks on it.`);
  spec.skills = [...new Set(fromSentence)];

  spec.nice = await Promise.all(spec.nice.map(async s => {
    const hit = exact(await autocomplete(SKILL, s), s);
    if (hit) return hit;
    const variants = await variantsOf(s);
    if (variants.length) spec.skillVariants![s] = variants;
    return s;
  }));
  if (!Object.keys(spec.skillVariants).length) delete spec.skillVariants;

  if (spec.countries?.length) {
    spec.countries = await Promise.all(spec.countries.map(async c => {
      const values = await autocomplete("basic_profile.location.country", c);
      const hit = exact(values, c);
      if (!hit) problems.push(`Country "${c}" is not a stored country name.${suggest(values)} Use the full name, for example --country "United States".`);
      return hit ?? c;
    }));
  }
  if (spec.states?.length) {
    spec.states = await Promise.all(spec.states.map(async s => {
      const values = await autocomplete("basic_profile.location.state", s);
      const hit = exact(values, s);
      if (!hit) problems.push(`State or region "${s}" is not stored under that name.${suggest(values)}`);
      return hit ?? s;
    }));
  }
  for (const school of spec.schools ?? []) {
    const values = await autocomplete("education.schools.school", school);
    if (!values.some(v => v.toLowerCase().includes(school.toLowerCase()))) problems.push(`No stored school name contains "${school}".${suggest(values)}`);
    else notes.push(`School "${school}" matches stored names such as ${values.filter(v => v.toLowerCase().includes(school.toLowerCase())).slice(0, 3).map(v => `"${v}"`).join(", ")}.`);
  }
  for (const company of (spec.past ?? []).filter(p => !p.includes("."))) {
    const values = await autocomplete("experience.employment_details.past.name", company);
    if (!values.some(v => v.toLowerCase().includes(company.toLowerCase()))) problems.push(`No past employer is stored with a name containing "${company}".${suggest(values)} A domain works too: --past acme.example`);
  }
  return { spec, problems, notes };
}

// ---------------------------------------------------------------------------
// Filters, grouped in rounds for the log of who each round kept.
// ---------------------------------------------------------------------------

/** Premium data groups a filter touches. Each one filtered on adds to the price of every result (see estimateCost). */
export type Group = "experience" | "skills" | "education" | "professional_network" | "dev_platform";

export type Condition = { round: 1 | 2 | 3; label: string; clear: string; filter: Filter; groups: Group[] };

/** "Round 2: lists the skill PyTorch, 4+ years of experience": what a round adds, in the words of the filters themselves. */
export const roundTitle = (round: number, conditions: Condition[]): string =>
  `Round ${round}: ${conditions.filter(c => c.round === round && c.clear).map(c => c.label).join(", ") || "no filters"}`;

/**
 * A role title as a filter on the current title, for --title-strict and the watcher example: an "or" of the title
 * without its level words, spelled out ("machine learning engineer") and abbreviated ("ML engineer").
 */
export function titleFilter(title: string): Filter {
  const core = title.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").split(" ").filter(w => w && !LEVEL_WORDS.has(w));
  const long = core.map(w => ABBREVIATIONS[w] ?? w).join(" ");
  const reverse = Object.entries(ABBREVIATIONS).sort((a, b) => b[1].length - a[1].length);
  let short = long;
  for (const [abbr, full] of reverse) short = short.replace(new RegExp(`\\b${full}\\b`, "g"), abbr.toUpperCase());
  const sameJob = (s: string) => s.replace(/\b(?:developer|programmer)\b/g, "engineer");
  const asDeveloper = (s: string) => s.replace(/\bengineer\b/g, "developer");
  const base = [core.join(" "), long, short].filter(Boolean);
  const variants = [...new Set([...base, ...base.map(sameJob), ...(/\bsoftware\b|\bbackend\b|\bfrontend\b|\bfull[\s-]?stack\b|\bweb\b|\bmobile\b/.test(long) ? base.map(sameJob).map(asDeveloper) : [])])];
  const leaves = variants.map(v => leaf("experience.employment_details.current.title", "(.)", v));
  return leaves.length === 1 ? leaves[0] : or(...leaves);
}

/**
 * Every hard filter in the spec. The sentence itself is not a filter: it ranks inside these. Profiles Crustdata
 * rates least trusted (authenticity tier 9) are always left out; profiles it has not rated stay in. The upper end of
 * a years range is never a filter (a maximum on experience works as an age filter); it only scores.
 */
export function buildConditions(spec: RoleSpec): Condition[] {
  const c: Condition[] = [];
  c.push({ round: 1, label: "leave out profiles rated least trusted", clear: "", groups: [],
    filter: or(leaf("assessment.authenticity.tier", "=<", 8), leaf("assessment.authenticity.tier", "is_null", null)) });
  // Every kind of place given (cities, states, countries) is one "or": people living in any of them match.
  const places: Filter[] = [], labels: string[] = [], clears: string[] = [];
  if (spec.near?.length) {
    places.push(...spec.near.map(n => leaf("professional_network.location.raw", "geo_distance", { location: n.location, distance: n.km, unit: "km" })));
    labels.push(...spec.near.map(n => `within ${n.km} km of ${n.location}`)); clears.push("--near none");
  }
  if (spec.states?.length) { places.push(leaf("basic_profile.location.state", "in", spec.states)); labels.push(`in ${spec.states.join(" or ")}`); clears.push("--state none"); }
  if (spec.countries?.length) { places.push(leaf("basic_profile.location.country", "in", spec.countries)); labels.push(`in ${spec.countries.join(" or ")}`); clears.push("--country none"); }
  if (places.length) c.push({ round: 1, label: `lives ${labels.join(" or ")}`, clear: clears.length === 1 ? clears[0] : "--country none", groups: [], filter: places.length === 1 ? places[0] : or(...places) });
  if (spec.titleStrict && spec.title) c.push({ round: 1, label: `current title has the words "${titleKey(spec.title).split(" ").filter(w => !LEVEL_WORDS.has(w)).join(" ")}"`, clear: "--no-title-strict", groups: ["experience"], filter: titleFilter(spec.title) });

  for (const s of spec.must) {
    const others = spec.must.filter(x => x !== s);
    const spellings = spec.skillVariants?.[s];
    const filter = spellings?.length ? or(...spellings.map(v => leaf("skills.professional_network_skills", "=", v))) : leaf("skills.professional_network_skills", "=", s);
    c.push({ round: 2, label: `lists the skill ${s}${spellings?.length ? `, stored as ${spellings.join(" or ")}` : ""}`, clear: others.length ? `--must "${others.join(", ")}"` : "--must none", groups: ["skills"], filter });
  }
  if (spec.years && spec.years[0] > 0) c.push({ round: 2, label: `${spec.years[0]}+ years of experience`, clear: "--years none", groups: [], filter: leaf("years_of_experience_raw", "=>", spec.years[0]) });

  if (spec.sizes?.length) c.push({ round: 3, label: `current employer ${spec.sizeLabel ?? spec.sizes.join(", ")}`, clear: "--size none", groups: ["experience"], filter: leaf("experience.employment_details.current.company_headcount_range", "in", spec.sizes) });
  if (spec.past?.length) {
    const domains = spec.past.filter(p => p.includes(".")).map(domainOf).filter(Boolean);
    const names = spec.past.filter(p => !p.includes("."));
    const leaves = [domains.length ? leaf("experience.employment_details.past.company_website_domain", "in", domains) : undefined,
      ...names.map(n => leaf("experience.employment_details.past.company_name", "[.]", n))].filter((x): x is Filter => !!x);
    c.push({ round: 3, label: `worked at ${spec.past.join(" or ")}`, clear: "--past none", groups: ["experience"], filter: leaves.length === 1 ? leaves[0] : or(...leaves) });
  }
  if (spec.exclude?.length) c.push({ round: 3, label: `not currently at ${spec.exclude.join(", ")}`, clear: "--exclude none", groups: ["experience"], filter: leaf("experience.employment_details.current.company_website_domain", "not_in", spec.exclude) });
  if (spec.schools?.length) {
    const leaves = spec.schools.map(s => leaf("education.schools.school", "[.]", s));
    c.push({ round: 3, label: `studied at ${spec.schools.join(" or ")}`, clear: "--school none", groups: ["education"], filter: leaves.length === 1 ? leaves[0] : or(...leaves) });
  }
  if (spec.openOnly) c.push({ round: 3, label: "says they are open to new roles", clear: "--no-open-only", groups: ["professional_network"], filter: leaf("professional_network.open_to_cards", "in", ["CAREER_INTEREST"]) });
  if (spec.hasCode) c.push({ round: 3, label: "has a public code profile", clear: "--no-has-code", groups: ["dev_platform"], filter: leaf("dev_platform_profiles.public_repo_count", "=>", 1) });
  return c;
}

export const filtersOf = (conditions: Condition[]): Filter | undefined => (conditions.length ? and(...conditions.map(c => c.filter)) : undefined);

/** The data groups each candidate comes back with. Each one returned adds to the price of every result. */
export const resultFields = (spec: RoleSpec): string[] =>
  ["fit", "basic_profile", "experience", "education", "skills", "social_handles", ...(spec.papers ? ["research_profiles"] : [])];

// ---------------------------------------------------------------------------
// Cost, said before anything is billed: your account's prices when /account/endpoints has them, list prices otherwise.
// ---------------------------------------------------------------------------

export type Prices = { base: number; filter: Record<Group, number>; field: { experience: number; education: number; skills: number; research_profiles: number }; source: "account" | "list" };

/** Person search list prices per result (docs.crustdata.com/general/pricing). */
export const LIST_PRICE: Prices = {
  base: 0.03,
  filter: { experience: 0.1, skills: 0.1, education: 0.1, professional_network: 0.2, dev_platform: 0.8 },
  field: { experience: 0.1, education: 0.1, skills: 0.1, research_profiles: 0.4 },
  source: "list",
};

/** This account's person search prices, from the free GET /account/endpoints (base_credits, premium_filters, premium_fields). */
export function pricesFrom(endpoints: Endpoint[]): Prices {
  const e = endpoints.find(x => x.path === "/person/search");
  if (!e || typeof e.base_credits !== "number") return LIST_PRICE;
  // The price of the exact path used: the longest listed field that is the path or a prefix of it. A path with no
  // listed field costs nothing extra (an endpoint with no extras lists base_credits alone).
  const get = (list: Array<{ field: string; credits: number }> | undefined, path: string) => {
    const hits = (list ?? []).filter(p => path === p.field || path.startsWith(`${p.field}.`)).sort((a, b) => b.field.length - a.field.length);
    return hits.length ? Number(hits[0].credits) || 0 : 0;
  };
  const f = e.premium_filters, r = e.premium_fields;
  return {
    base: e.base_credits,
    filter: {
      experience: get(f, "experience.employment_details.current.company_headcount_range"), skills: get(f, "skills.professional_network_skills"),
      education: get(f, "education.schools.school"), professional_network: get(f, "professional_network.open_to_cards"), dev_platform: get(f, "dev_platform_profiles.public_repo_count"),
    },
    field: { experience: get(r, "experience"), education: get(r, "education"), skills: get(r, "skills"), research_profiles: get(r, "research_profiles") },
    source: "account",
  };
}

/** Share of candidates assumed open to new roles, for the estimate only (live runs found 1 to 4 in 20). */
export const OPEN_SHARE = 0.1;

const perResult = (prices: Prices, groups: Iterable<Group>) => prices.base + [...new Set(groups)].reduce((s, g) => s + prices.filter[g], 0);

/** The run's cost: the candidates, one counted result per round (only that round's filters), and the open check. */
export function estimateCost(spec: RoleSpec, conditions: Condition[], probeRounds: number[], prices: Prices = LIST_PRICE): { credits: number; perCandidate: number; text: string } {
  const fieldCost = prices.field.experience + prices.field.education + prices.field.skills + (spec.papers ? prices.field.research_profiles : 0);
  const perCandidate = perResult(prices, conditions.flatMap(c => c.groups)) + fieldCost;
  const rounds = probeRounds.reduce((s, r) => s + perResult(prices, conditions.filter(c => c.round <= r).flatMap(c => c.groups)), 0);
  const openCheck = spec.openOnly ? 0 : Math.ceil(spec.limit * OPEN_SHARE) * (prices.base + prices.filter.professional_network);
  const credits = spec.limit * perCandidate + rounds + openCheck;
  const r = (n: number) => (n < 10 ? Math.round(n * 10) / 10 : Math.round(n));
  const where = prices.source === "account" ? "on your account" : "at list price";
  const list = prices.source === "account" ? estimateCost(spec, conditions, probeRounds, LIST_PRICE) : undefined;
  return {
    credits, perCandidate,
    text: `about ${r(credits)} credits ${where} (${Math.round(perCandidate * 100) / 100} per candidate, ${spec.limit} candidates)${list && Math.abs(list.credits - credits) > 0.05 ? `; about ${r(list.credits)} at list price` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// role.json (next to the role's CSVs): the exact spec of the last run, so a later run starts from it.
// ---------------------------------------------------------------------------

export const roleDir = (name: string): string => join(config.outDir, slugify(name) || "role");
const lastRoleFile = () => join(config.outDir, ".last-role");

export type SavedRole = { spec: RoleSpec; filters?: Filter; seenFile?: string; skipFrom?: string[]; fromFlags?: string[]; savedAt?: string };

export function loadRole(name: string): SavedRole | undefined {
  const file = join(roleDir(name), "role.json");
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`${file} is not valid JSON. Fix it or delete it (it only holds the saved role).`); }
}

/** Written through a temporary file, so a crash never leaves half a file. Owner-only: it is about real people. */
export function writeFileSafe(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

export function saveRole(spec: RoleSpec, filters: Filter | undefined, extra: Omit<SavedRole, "spec" | "filters" | "savedAt"> = {}): void {
  mkdirSync(roleDir(spec.name), { recursive: true, mode: 0o700 });
  writeFileSafe(join(roleDir(spec.name), "role.json"), JSON.stringify({ spec, filters, ...extra, savedAt: new Date().toISOString() }, null, 2) + "\n");
  writeFileSafe(lastRoleFile(), spec.name + "\n");
}

export const lastRole = (): string | undefined => (existsSync(lastRoleFile()) ? readFileSync(lastRoleFile(), "utf8").trim() || undefined : undefined);

export function describeSpec(spec: RoleSpec, conditions: Condition[]): string {
  const lines = [
    `  role:        ${spec.keywords ? `keywords ${spec.keywords} (exact words, no meaning match)` : spec.role}`,
    spec.query && !spec.keywords && `  query:       ${spec.query} (what is searched)`,
    spec.title && `  title:       ${spec.title}${spec.titleStrict ? " (required)" : " (scored; --title-strict to require it)"}`,
    spec.skills.length && `  skills:      ${spec.skills.join(", ")} (scored)`,
    spec.nice.length && `  nice to have: ${spec.nice.join(", ")} (scored, lower weight)`,
    ...conditions.filter(c => c.clear).map(c => `  filter:      ${c.label}   (${c.clear} to drop)`),
    spec.years?.[1] != null && `  years:       up to ${spec.years[1]} scores higher; it is not a filter`,
    spec.papers && "  research:    citations and h-index are read and scored (--papers)",
    `  new people:  up to ${spec.limit} per run`,
  ];
  return lines.filter(Boolean).join("\n");
}
