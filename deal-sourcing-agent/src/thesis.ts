/**
 * The thesis: one plain-English sentence plus flags. Works without an LLM.
 *
 * The sentence goes to ranked company search as `search.query`. A small rule-based parser lifts the hard filters out
 * of it (stage, founding year, size, place, headcount growth, investors) and removes those words, so ranking runs on
 * what the company does. Flags always win over the parser. Every categorical value is checked with autocomplete
 * (free) before a credit is spent, and the parser says out loud when a sentence asks for something it cannot filter on.
 *
 * Relative dates ("founded in the last 2 years", "raised in the last 12 months") are saved as relative and turned
 * into dates on every run (resolveDates), so a thesis re-run weekly keeps meaning the same thing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./config.js";
import { and, autocomplete, leaf, or, type Filter } from "./crustdata.js";
import type { RawCompany } from "./types.js";
import { dueWindow, windowsText } from "./windows.js";
import { MAX_FOUNDERS } from "./founders.js";

export type TimingMode = "due" | "fresh" | "off";
export type GrowthPeriod = "3m" | "6m" | "12m";
export type Near = { location: string; km: number };

export type ThesisSpec = {
  thesis: string;               // the sentence, as typed
  query: string;                // what goes to search.query: the sentence minus the words the parser turned into filters
  limit: number;                // companies in the pipeline (ranked search stops at 1,000)
  size?: [number, number];      // headcount.total between
  countries?: string[];         // locations.country, ISO-3 code or full name
  states?: string[];            // locations.state, US state names
  near?: Near[];                // locations.headquarters within km of a place (one or more cities)
  stages?: string[];            // funding.last_round_type, stored values like "seed"
  unfunded?: boolean;           // no disclosed round (funding.last_fundraise_date is null); with stages, either one
  raisedSince?: string;         // funding.last_fundraise_date on or after, YYYY-MM-DD
  raisedWithinMonths?: number;  // the same, relative: re-computed on every run
  founded?: [number, number];   // basic_info.year_founded between, inclusive
  foundedWithinYears?: number;  // the same, relative: re-computed on every run
  minGrowth?: number;           // headcount growth at least this percent ...
  growthPeriod?: GrowthPeriod;  // ... over this period (default 3m)
  withInvestors?: string[];     // funding.investors includes one of these exact names
  excludeInvestors?: string[];  // funding.investors includes none of these ("already priced")
  exclude?: string[];           // domains to leave out (your portfolio, companies you passed on)
  foundersFrom?: string[];      // past employers that earn points (domains or company names)
  onlyFoundersFrom?: boolean;   // keep only companies with a founder who worked at one of them
  schools?: string[];           // schools that earn points
  timing: TimingMode;           // how the time since the last round scores
  postsFor: number;             // top companies whose founders' posts are counted (free, 2 requests each)
  quotes: number;               // top companies whose newest traction posts are quoted in the memo (0.5 credits a post)
  jobsFor: number;              // top companies whose newest role titles go in the memo (0.03 credits a listing)
};

/** What a flag can set. null means "clear this filter" (from `--stage none`). */
export type SpecLayer = { [K in keyof ThesisSpec]?: ThesisSpec[K] | null };

/** The fields the sentence decides. A new sentence resets these and keeps the rest (your lists, limits, timing). */
const SENTENCE_FIELDS = ["query", "size", "countries", "states", "near", "stages", "unfunded", "raisedSince", "raisedWithinMonths",
  "founded", "foundedWithinYears", "minGrowth", "growthPeriod", "withInvestors"] as const;
/** Fields that change only the score. Changing just these re-scores the saved data for free. */
export const SCORING_FIELDS = ["foundersFrom", "onlyFoundersFrom", "schools", "timing"] as const;

export const NO_UPPER_BOUND = 1_000_000;
export const NO_UPPER_YEAR = 9999;
/** Without a size, one-person companies are left out: a single profile with a company page ranks well on words. */
export const DEFAULT_MIN_SIZE = 2;
const STAGES = ["angel", "pre_seed", "seed", "series_a", "series_b", "series_c", "series_d", "series_e", "series_f", "series_g", "series_h", "series_i", "series_j"];

export const DEFAULTS: Omit<ThesisSpec, "thesis" | "query"> = {
  limit: 10, size: [DEFAULT_MIN_SIZE, NO_UPPER_BOUND], timing: "due", postsFor: 50, quotes: 5, jobsFor: 20,
};

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const list = (v: string) => v.split(",").map(s => s.trim()).filter(Boolean);
const num = (flag: string, v: string, min = 0, integer = false) => {
  const n = Number(v.trim());
  if (!/^-?\d+(\.\d+)?$/.test(v.trim()) || !Number.isFinite(n) || n < min || (integer && !Number.isInteger(n)))
    throw new Error(`--${flag} takes ${integer ? "a whole number" : "a number"}${min ? ` of ${min} or more` : ""}, got "${v}"`);
  return n;
};

export const FLAGS: { [flag: string]: (v: string) => SpecLayer } = {
  thesis: v => ({ thesis: v }),
  size: v => {
    const t = v.replace(/,/g, "").trim();
    const plus = /^(\d+)\s*\+$/.exec(t);
    if (plus) return { size: [Number(plus[1]), NO_UPPER_BOUND] };
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (!m) throw new Error(`--size takes a range like 3-40, or 10+, got "${v}"`);
    return { size: [Number(m[1]), Number(m[2])] };
  },
  country: v => ({ countries: list(v) }),
  state: v => ({ states: list(v) }),
  stage: v => ({ stages: list(v).map(s => s.toLowerCase().replace(/[\s-]+/g, "_")) }),
  "raised-since": v => ({ raisedSince: normalizeDate(v), raisedWithinMonths: null }),
  "raised-within": v => ({ raisedWithinMonths: num("raised-within", v, 1, true), raisedSince: null }),
  founded: v => {
    const m = /^(\d{4})(?:\s*(-|\+)\s*(\d{4})?)?$/.exec(v.trim());
    if (!m || (m[2] === "-" && !m[3])) throw new Error(`--founded takes a year (2024), a year and later (2024+) or a range (2022-2025), got "${v}"`);
    return { founded: [Number(m[1]), m[2] === "+" ? NO_UPPER_YEAR : m[3] ? Number(m[3]) : Number(m[1])], foundedWithinYears: null };
  },
  "min-growth": v => ({ minGrowth: num("min-growth", v, -100) }),
  "growth-months": v => {
    const p = ({ "3": "3m", "6": "6m", "12": "12m" } as const)[v.trim() as "3" | "6" | "12"];
    if (!p) throw new Error(`--growth-months takes 3, 6 or 12, got "${v}"`);
    return { growthPeriod: p };
  },
  "with-investors": v => ({ withInvestors: list(v) }),
  "exclude-investors": v => ({ excludeInvestors: list(v) }),
  exclude: v => ({ exclude: [v] }), // domains, or a CSV path; split and read in source.ts
  "founders-from": v => ({ foundersFrom: list(v) }),
  "only-founders-from": v => ({ foundersFrom: list(v), onlyFoundersFrom: true }),
  schools: v => ({ schools: list(v) }),
  timing: v => {
    const t = v.toLowerCase().trim();
    if (t !== "due" && t !== "fresh" && t !== "off") throw new Error(`--timing takes due, fresh or off, got "${v}"`);
    return { timing: t };
  },
  limit: v => {
    const n = num("limit", v, 1, true);
    if (n > 1000) throw new Error(`--limit is at most 1000 (ranked search returns up to 1,000 companies), got ${n}`);
    return { limit: n };
  },
  posts: v => ({ postsFor: num("posts", v, 0, true) }),
  quotes: v => ({ quotes: num("quotes", v, 0, true) }),
  jobs: v => ({ jobsFor: num("jobs", v, 0, true) }),
};
/** Flags that take `none` to clear what the sentence or an earlier run set. */
const CLEARABLE: { [flag: string]: Array<keyof ThesisSpec> } = {
  size: ["size"], country: ["countries", "near", "states"], state: ["states"], stage: ["stages"], "raised-since": ["raisedSince", "raisedWithinMonths"],
  "raised-within": ["raisedSince", "raisedWithinMonths"], founded: ["founded", "foundedWithinYears"], "min-growth": ["minGrowth", "growthPeriod"],
  "with-investors": ["withInvestors"], "exclude-investors": ["excludeInvestors"], exclude: ["exclude"],
  "founders-from": ["foundersFrom", "onlyFoundersFrom"], "only-founders-from": ["foundersFrom", "onlyFoundersFrom"], schools: ["schools"],
};
export const SWITCHES = ["yes", "fresh", "explain", "force", "ai", "unfunded", "funded", "no-posts", "no-jobs", "no-watch-hint"] as const;
export type Switches = { yes: boolean; fresh: boolean; explain: boolean; force: boolean; ai: boolean; noWatchHint: boolean };

export const USAGE = 'Describe your thesis: npm run source -- --thesis "AI infrastructure, pre-seed or seed, US, founded 2024 or later"';

export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function parseFlags(argv: string[]): { flags: SpecLayer; out?: string; excludeReset?: boolean } & Switches {
  const flags: SpecLayer = {};
  const on: Switches = { yes: false, fresh: false, explain: false, force: false, ai: false, noWatchHint: false };
  let out: string | undefined;
  let excludeReset = false;
  const excludes: string[] = [];
  const known = [...Object.keys(FLAGS), "out", ...SWITCHES];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^--[a-z-]+=(?:false|no|0)$/i.test(arg) && (SWITCHES as readonly string[]).includes(arg.slice(2).split("=")[0])) continue; // --yes=false: the switch is off
    const name = arg.replace(/^--?/, "").replace(/=(?:true|yes|1)$/i, "");
    if (arg === "-y") { on.yes = true; continue; }
    if (arg.startsWith("--") && (SWITCHES as readonly string[]).includes(name)) {
      if (name === "unfunded") flags.unfunded = true;
      else if (name === "funded") flags.unfunded = null;
      else if (name === "no-posts") Object.assign(flags, { postsFor: 0, quotes: 0 });
      else if (name === "no-jobs") flags.jobsFor = 0;
      else if (name === "no-watch-hint") on.noWatchHint = true;
      else on[name as "yes" | "fresh" | "explain" | "force" | "ai"] = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}". Flags look like --size 3-40, with the thesis in quotes after --thesis. With npm, put -- before the flags: npm run source -- --thesis "..."`);
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (!FLAGS[key] && key !== "out") {
      const close = known.filter(k => editDistance(k, key) <= 2 || k.startsWith(key) || key.startsWith(k));
      throw new Error(`Unknown flag --${key}.${close.length ? ` Did you mean ${close.map(c => "--" + c).join(" or ")}?` : ""} All flags are listed in the README (Reference, Flags).`);
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.trim() === "" || (value.startsWith("--") && key !== "thesis")) throw new Error(`--${key} needs a value.`);
    if (key === "out") { out = value; continue; }
    if (value.toLowerCase().trim() === "none" && CLEARABLE[key]) {
      for (const field of CLEARABLE[key]) Object.assign(flags, { [field]: null });
      if (key === "exclude") { excludes.length = 0; excludeReset = true; }
    } else if (key === "exclude") excludes.push(value);
    else Object.assign(flags, FLAGS[key](value));
  }
  if (excludes.length) flags.exclude = excludes;
  // Flags win over the sentence: --country or --state replaces every place the sentence named, cities included.
  if (flags.countries !== undefined || flags.states !== undefined) { flags.countries ??= null; flags.states ??= null; flags.near ??= null; }
  return { flags, out, excludeReset, ...on };
}

export function normalizeDate(s: string): string {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s.trim());
  const iso = m ? `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}` : "";
  // A date that does not survive a round trip (2025-02-31) is not a date.
  if (!m || Number.isNaN(Date.parse(iso)) || new Date(iso + "T00:00:00Z").toISOString().slice(0, 10) !== iso) {
    throw new Error(`Dates look like 2025, 2025-04 or 2025-04-01, got "${s}"`);
  }
  return iso;
}

// ---------------------------------------------------------------------------
// Rule-based sentence parser
// ---------------------------------------------------------------------------

const re = (source: string, flags = "i") => new RegExp(source, flags);
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?k?)`;
const PEOPLE = String.raw`\s*(?:people|employees|staff|persons?|FTEs?|headcount)`;
const toNum = (s: string) => (s.toLowerCase().endsWith("k") ? Number(s.slice(0, -1).replace(/,/g, "")) * 1000 : Number(s.replace(/,/g, "")));
const LEAD = String.raw`(?:(?:with|of|from|teams? of)\s+)?`;
const SIZES: Array<[RegExp, (m: RegExpExecArray) => [number, number]]> = [
  [re(String.raw`${LEAD}(?:between\s+)?${NUM}\s*(?:to|-|and)\s*${NUM}${PEOPLE}`), m => [toNum(m[1]), toNum(m[2])]],
  // "under 50 people" is 2 to 49 (the default floor stays); "up to 50" is 2 to 50.
  [re(String.raw`${LEAD}(?:up to|at most|no more than|not more than)\s*${NUM}${PEOPLE}`), m => [DEFAULT_MIN_SIZE, toNum(m[1])]],
  [re(String.raw`${LEAD}(?:at least|no fewer than|no less than|not less than|not fewer than)\s*${NUM}${PEOPLE}`), m => [toNum(m[1]), NO_UPPER_BOUND]],
  [re(String.raw`${LEAD}(?<!\b(?:no|not)\s)(?:under|fewer than|less than)\s*${NUM}${PEOPLE}`), m => [Math.min(DEFAULT_MIN_SIZE, toNum(m[1]) - 1), toNum(m[1]) - 1]],
  [re(String.raw`${LEAD}(?<!\b(?:no|not)\s)(?:over|more than)\s*${NUM}${PEOPLE}`), m => [toNum(m[1]), NO_UPPER_BOUND]],
  [re(String.raw`${LEAD}${NUM}\s*\+${PEOPLE}`), m => [toNum(m[1]), NO_UPPER_BOUND]],
];

// "seed", "pre-seed", "Series A", "seed-stage", "Series A-funded"; a bare letter only after a series ("Series A or B").
// The lookahead keeps "Series E-commerce" and "C-level" out.
const END = String.raw`(?!\w|-(?!stage\b|funded\b|backed\b)[a-z]{2})(?:[\s-](?:stage|funded|backed)\b)?`;
const STAGE = String.raw`\b(pre[\s-]?seed|seed|angel|series[\s-]+[a-j])${END}`;
const LETTER = String.raw`\b([a-j])${END}`;
const NEXT_LETTER = String.raw`\b[b-j]${END}`;
const stageOf = (word: string): string => {
  const w = word.toLowerCase().replace(/[\s-]+/g, " ");
  return w.startsWith("pre") ? "pre_seed" : w === "seed" || w === "angel" ? w : `series_${w.slice(-1)}`;
};
const STAGE_RANGE = re(String.raw`(?:raised\s+)?(?:an?\s+)?${STAGE}\s*(?:to|through|-)\s*(?:${STAGE}|${LETTER})(?:\s+(?:rounds?|funding))?`);
const STAGE_PLUS = re(String.raw`(?:raised\s+)?(?:an?\s+)?${STAGE}\s*(?:\+|and later|or later|and beyond|and above|or above|onwards)`);
const PRE_SERIES = /\bpre[\s-]series[\s-]+([a-j])\b/i;
const POST_SEED = /\bpost[\s-]seed\b(?:\s+(?:rounds?|stage))?/i;
const STAGE_LIST = re(String.raw`(?:raised\s+)?(?:an?\s+)?${STAGE}((?:\s*(?:,|or|and|\/)\s*${NEXT_LETTER})*)(?:\s+(?:rounds?|funding))?`);
/** "software for angel investors", "tools for seed funds": the stage word describes the customer, not the company. */
const CUSTOMER_AFTER = /^\s*(?:investors?|funds?|vcs?|firms?|growers?|oil|accelerators?|syndicates?|networks?)\b/i;
/** "tools for seed-stage startups": "for" right before the stage, and companies or founders right after it. */
const CUSTOMER_BEFORE = /\b(?:for|to|serving|helping|sells?\s+to|selling\s+to)\s+(?:the\s+)?$/i;
const CUSTOMER_NOUN_AFTER = /^\s*(?:startups|companies|founders|teams|businesses)\b/i;
const UNFUNDED = /\b(?:unfunded|bootstrapped|not yet funded|pre[\s-]funding|no (?:disclosed |outside )?(?:funding|round|rounds|investors)(?: yet)?)\b/i;
const YC_BACKED = /\b(?:YC|Y[\s-]?Combinator)(?:[\s-]backed)?\b(?:\s+companies|\s+startups)?/i;
const BACKED_BY = /\bbacked by\s+((?:[A-Z][\w&.']*)(?:\s+(?:[A-Z][\w&.']*|of|&))*)/;
const PERIOD = String.raw`(?:\s+(?:in|over)\s+(?:the\s+)?(?:last\s+|past\s+)?(?:(\d+|three|six|twelve|a|one)\s+)?(months?|years?|quarter)|\s+(year[\s-]over[\s-]year|YoY|annually|per\s+year|a\s+year|month[\s-]over[\s-]month|MoM))?`;
/** "YoY", "year-over-year", "MoM": a period said as a phrase, before or after the number. */
const RATE = String.raw`(YoY|year[\s-]over[\s-]year|MoM|month[\s-]over[\s-]month)`;
// Groups: 1 rate before, 2 percent, 3-4 period count and unit, 5 period phrase; then 6 percent, 7 rate, 8-9 count and unit, 10 phrase.
const GROWTH = re(String.raw`\b(?:${RATE}\s+)?(?:(?:headcount|team)\s+)?(?:growth|growing|grew|grown)\s+(?:of\s+|by\s+)?(?:at least\s+|over\s+|more than\s+)?(\d+(?:\.\d+)?)%\+?${PERIOD}`
  + String.raw`|\b(\d+(?:\.\d+)?)%\+?\s+(?:${RATE}\s+)?(?:headcount\s+|team\s+)?growth\b${PERIOD}`);
const WORDNUM: { [w: string]: number } = { a: 1, one: 1, three: 3, six: 6, twelve: 12 };
/** Months in a growth period phrase, as one of the periods Crustdata has (3, 6 or 12 months); undefined for others. */
function growthPeriodOf(n?: string, unit?: string): GrowthPeriod | undefined | "unsupported" {
  if (!n && !unit) return undefined;
  const count = n ? WORDNUM[n.toLowerCase()] ?? Number(n) : 1;
  const months = count * (/^year/i.test(unit ?? "") ? 12 : /^quarter/i.test(unit ?? "") ? 3 : 1);
  return months === 3 ? "3m" : months === 6 ? "6m" : months === 12 ? "12m" : "unsupported";
}

// Places. Country words anywhere in the sentence become an HQ filter (clear with --country none).
const EUROPE = ["GBR", "DEU", "FRA", "NLD", "ESP", "ITA", "SWE", "IRL", "CHE", "DNK", "FIN", "NOR", "BEL", "AUT", "POL", "PRT", "EST",
  "CZE", "ROU", "LTU", "LVA", "GRC", "HUN", "UKR", "LUX", "ISL", "HRV", "BGR", "SVK", "SVN"];
const NORDICS = ["SWE", "DNK", "FIN", "NOR", "ISL"];
const DACH = ["DEU", "AUT", "CHE"];
const BENELUX = ["BEL", "NLD", "LUX"];
const LATAM = ["BRA", "MEX", "ARG", "COL", "CHL", "PER", "URY", "ECU"];
const SEA = ["SGP", "IDN", "MYS", "THA", "VNM", "PHL"];
const APAC = [...SEA, "AUS", "NZL", "IND", "JPN", "KOR", "CHN", "HKG", "TWN"];
const MENA = ["ARE", "SAU", "ISR", "EGY", "QAT", "KWT", "BHR", "OMN", "JOR", "MAR"];
const COUNTRY_NAMES: Array<[string, string]> = [
  ["Ireland", "IRL"], ["Canada", "CAN"], ["India", "IND"], ["Germany", "DEU"], ["France", "FRA"], ["Israel", "ISR"], ["Australia", "AUS"],
  ["New Zealand", "NZL"], ["Singapore", "SGP"], ["Brazil", "BRA"], ["Mexico", "MEX"], ["Argentina", "ARG"], ["Colombia", "COL"], ["Chile", "CHL"],
  ["Netherlands", "NLD"], ["Spain", "ESP"], ["Italy", "ITA"], ["Sweden", "SWE"], ["Denmark", "DNK"], ["Finland", "FIN"], ["Norway", "NOR"],
  ["Switzerland", "CHE"], ["Austria", "AUT"], ["Belgium", "BEL"], ["Poland", "POL"], ["Portugal", "PRT"], ["Estonia", "EST"], ["Japan", "JPN"],
  ["South Korea", "KOR"], ["Korea", "KOR"], ["China", "CHN"], ["Hong Kong", "HKG"], ["Taiwan", "TWN"], ["Indonesia", "IDN"], ["Vietnam", "VNM"],
  ["UAE", "ARE"], ["United Arab Emirates", "ARE"], ["Saudi Arabia", "SAU"], ["Egypt", "EGY"], ["South Africa", "ZAF"], ["Nigeria", "NGA"], ["Kenya", "KEN"],
];
/** "US Army", "US government": customers, not a place. Both cases, since the US pattern is case-sensitive. */
const CUSTOMER_NOUNS = ["army", "navy", "military", "government", "gov", "federal", "defense", "customers?", "market", "consumers?", "patients", "hospitals"]
  .flatMap(w => [w, w[0].toUpperCase() + w.slice(1)]).join("|");
const COUNTRIES: Array<[RegExp, string[]]> = [
  [/\bNorth America\b/i, ["USA", "CAN"]],
  [new RegExp(String.raw`\b(?:US|USA|United States)\b(?!\s+(?:${CUSTOMER_NOUNS}))|\bU\.S\.(?:A\.?)?(?!\w)|(?<!(?:Latin|South|Central|North) )(?<!Bank of )\bAmerica\b`), ["USA"]],
  [/\bNew South Wales\b/i, ["AUS"]],
  [/(?<!New\s)(?<!South\s)\b(?:UK|United Kingdom|Britain|England|Scotland|Wales)\b/, ["GBR"]],
  [/\b(?:LATAM|Latin America|South America)\b/i, LATAM],
  [/\bNordics?\b|\bScandinavia\b/i, NORDICS],
  [/\bDACH\b/, DACH],
  [/\bBenelux\b/i, BENELUX],
  [/\bSoutheast Asia\b|\bSEA\b/, SEA],
  [/\bAPAC\b|\bAsia[\s-]Pacific\b/i, APAC],
  [/\bMENA\b|\bMiddle East\b/i, MENA],
  [/\bEurop(?:e|ean)\b|\bEMEA\b/i, EUROPE],
  ...COUNTRY_NAMES.map(([name, code]): [RegExp, string[]] => [new RegExp(String.raw`\b${name}\b`, "i"), [code]]),
];
const KNOWN_ISO3 = new Set(COUNTRIES.flatMap(([, codes]) => codes));
const ISO3_NAMES: { [code: string]: string } = {
  USA: "United States", GBR: "United Kingdom", CZE: "Czechia", ROU: "Romania", LTU: "Lithuania", LVA: "Latvia", GRC: "Greece", HUN: "Hungary",
  UKR: "Ukraine", LUX: "Luxembourg", ISL: "Iceland", HRV: "Croatia", BGR: "Bulgaria", SVK: "Slovakia", SVN: "Slovenia", MYS: "Malaysia",
  THA: "Thailand", PHL: "Philippines", QAT: "Qatar", KWT: "Kuwait", BHR: "Bahrain", OMN: "Oman", JOR: "Jordan", MAR: "Morocco", PER: "Peru",
  URY: "Uruguay", ECU: "Ecuador", ...Object.fromEntries(COUNTRY_NAMES.map(([n, c]) => [c, n])),
};
const US_STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri",
  "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia",
  "Wisconsin", "Wyoming"];
/** Cities become "HQ within N km" (geo_distance on locations.headquarters). The country is dropped when the sentence also names it ("Bay Area, US"). */
const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const METROS: Array<[RegExp, string, number, string]> = [
  [/\b(?:SF )?Bay Area\b|\bSilicon Valley\b|\bSan Francisco\b|\bSF\b/, "San Francisco, CA", 80, "USA"],
  [/\bNYC\b|\bNew York City\b|\bManhattan\b|\bNew York(?=\s+metro)/i, "New York, NY", 50, "USA"],
  // "DC" alone is often power (DC fast chargers): only "Washington DC", "D.C.", "in DC" or "DC-based" are the city.
  [/\bWashington,?\s+D\.?C\.?(?!\w)|\bD\.C\.(?!\w)|(?<=\b(?:in|near|around|from)\s)DC\b(?![\s-]+(?:power|fast|charg\w*|microgrids?|motors?|converters?|current))|\bDC(?=[\s-](?:area|metro|based)\b)/, "Washington, DC", 50, "USA"],
  [/\bKansas City\b/i, "Kansas City, MO", 50, "USA"],
  [/\bLos Angeles\b|\bL\.A\.(?!\w)|(?<=\b(?:in|near|around|from)\s)LA\b(?![\s-]?\w)|\bLA(?=[\s-](?:area|metro|based)\b)/, "Los Angeles, CA", 80, "USA"],
  [/\bBoston\b/i, "Boston, MA", 60, "USA"], [/\bAustin\b/i, "Austin, TX", 60, "USA"], [/\bSeattle\b/i, "Seattle, WA", 60, "USA"],
  [/\bChicago\b/i, "Chicago, IL", 60, "USA"], [/\bDenver\b/i, "Denver, CO", 60, "USA"], [/\bMiami\b/i, "Miami, FL", 60, "USA"],
  [/\bToronto\b/i, "Toronto, ON", 60, "CAN"], [/\bLondon\b/i, "London, UK", 50, "GBR"], [/\bBerlin\b/i, "Berlin, Germany", 50, "DEU"],
  [/\bParis\b/i, "Paris, France", 50, "FRA"], [/\bAmsterdam\b/i, "Amsterdam, Netherlands", 50, "NLD"],
  [/\bBangalore\b|\bBengaluru\b/i, "Bengaluru, India", 50, "IND"], [/\bTel Aviv\b/i, "Tel Aviv, Israel", 50, "ISR"],
];
const PLACE_LEAD = String.raw`(?:based\s+|headquartered\s+|located\s+)?(?:(?:in|from|around|near)\s+(?:the\s+)?)?`;
const PLACE_TAIL = String.raw`(?:-based|-headquartered|'s)?(?:\s+(?:(?:metro(?:politan)?\s+)?area|metro|region|state))?`;
/** "for the UK market", "US customers": the place describes the customer, not where the company is. */
const MARKET_AFTER = /^\s*(?:market|markets|customers?|consumers?|users|buyers|patients|clients)\b/i;

const FUNDING_WORD = /\b(raised?|raising|funded|funding|round|series\s+[a-j]|seed)\b/gi;
const OTHER_TIMELINE = /\b(founded|started|launched|incorporated|grew|grown|growing|hired|hiring)\b/gi;
/** True when the words just before a date phrase, in the same clause, are about funding ("raised in the last 18 months"). */
function aboutFunding(text: string, at: number): boolean {
  const before = text.slice(0, at).split(/[,;](?!\d)/).pop() ?? "";
  const lastIndex = (pattern: RegExp) => Math.max(-1, ...[...before.matchAll(pattern)].map(m => m.index ?? -1));
  const funding = lastIndex(FUNDING_WORD);
  return funding >= 0 && funding > lastIndex(OTHER_TIMELINE);
}

/** What the parser understood, plus the notes it has about the sentence (shown before any credit is spent). */
export type Parsed = Partial<ThesisSpec> & { notes?: string[] };

export function parseSentence(sentence: string, today = new Date()): Parsed {
  const found: Parsed = {};
  const notes: string[] = [];
  const year = today.getUTCFullYear();
  let rest = sentence.slice(0, 2000);
  const cut = (text: string) => { rest = rest.replace(text, " "); };
  /** A negation earlier in the same clause: "not based in Boston", "Series A, not seed", "non-US". Such a word is never a positive filter. */
  // Not "no-code", "nonprofit" or "no more than 20 people" (a number between the word and the place ends the negation).
  const negatedIn = (text: string, index: number) => /\b(?:not|never|without|excluding|except|outside|anywhere\s+but|other\s+than|no(?![\s-]+code\b)(?![\s-]+(?:more|fewer|less)\s+than\b)|non(?![\s-]*(?:profits?|technical|dilutive)\b))\b[^,;.:\d]*$/i.test(text.slice(0, index));
  const negated = (index: number) => negatedIn(rest, index);
  const skip = (what: string, flag: string) => notes.push(`"${what.trim()}" comes after "not" (or "outside", "except"), so it is not used as a filter. ${flag} sets what you want.`);
  let m: RegExpExecArray | null;

  // Founding year first, so "founded in the last 2 years" is not read as a raise date.
  const FOUNDED = String.raw`(?:founded|started|incorporated|launched)`;
  if ((m = re(String.raw`\b${FOUNDED}\s+(?:between\s+|from\s+|in\s+)?(\d{4})\s*(?:to|-|and|or|through)\s*(\d{4})`).exec(rest))) {
    found.founded = [Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2])]; cut(m[0]);
  } else if ((m = re(String.raw`\b${FOUNDED}\s+(?:in\s+|within\s+)?(?:the\s+)?(?:last|past)\s+(\d+)\s+years?`).exec(rest))) {
    found.foundedWithinYears = Number(m[1]); cut(m[0]);
  } else if ((m = re(String.raw`\b(?:less than|under|younger than)\s+(\d+)\s+years?\s+old\b`).exec(rest))) {
    found.foundedWithinYears = Number(m[1]); cut(m[0]);
  } else if ((m = re(String.raw`\b${FOUNDED}\s+(?:in\s+)?(\d{4})\s*(?:\+|or\s+later|or\s+after|and\s+later|onwards|or\s+newer)`).exec(rest))
    || (m = re(String.raw`\b${FOUNDED}\s+(?:since|from)\s+(\d{4})`).exec(rest))) {
    found.founded = [Number(m[1]), NO_UPPER_YEAR]; cut(m[0]);
  } else if ((m = re(String.raw`\b${FOUNDED}\s+(?:before|until|by)\s+(\d{4})`).exec(rest))) {
    found.founded = [1900, Number(m[1]) - 1]; cut(m[0]);
  } else if ((m = re(String.raw`\b${FOUNDED}\s+after\s+(\d{4})`).exec(rest))) {
    found.founded = [Number(m[1]) + 1, NO_UPPER_YEAR]; cut(m[0]);
  } else if ((m = re(String.raw`\b${FOUNDED}\s+(?:in\s+)?(\d{4})\b`).exec(rest))) {
    found.founded = [Number(m[1]), Number(m[1])]; cut(m[0]);
  }
  if (found.founded && (found.founded[0] < 1900 || found.founded[0] > year + 1)) { notes.push(`Founding year ${found.founded[0]} looks wrong, so it is not used.`); delete found.founded; }

  for (const [pattern, range] of SIZES) {
    if (!(m = pattern.exec(rest))) continue;
    found.size = range(m);
    cut(m[0]);
    break;
  }

  if ((m = GROWTH.exec(rest))) {
    // Groups: 1 percent, 2 count, 3 unit, 4 a phrase ("year over year"); then the same four for the "20% growth" form.
    const phrase = m[1] ?? m[5] ?? m[7] ?? m[10];
    const period = phrase ? (/month|MoM/i.test(phrase) ? "unsupported" : "12m") : growthPeriodOf(m[3] ?? m[8], m[4] ?? m[9]);
    if (period === "unsupported") notes.push(`"${m[0].trim()}": headcount growth exists over 3, 6 or 12 months only, so this is read as 3 months. --growth-months sets it.`);
    found.minGrowth = Number(m[2] ?? m[6]);
    if (period && period !== "unsupported" && period !== "3m") found.growthPeriod = period;
    cut(m[0]);
  }

  const YOY = /\b(?:(?:headcount|team)\s+(?:up|grew|grown|growing)\s+(?:by\s+)?)?(\d+(?:\.\d+)?)%\+?\s+(?:YoY|year[\s-]over[\s-]year)\b|\b(?:grew|grown|growing|doubled|tripled)\s+(?:headcount\s+|the\s+team\s+)?(?:by\s+)?(\d+(?:\.\d+)?)x\s+(?:YoY|year[\s-]over[\s-]year|in\s+(?:the\s+)?(?:last|past)\s+(?:year|12\s+months))\b/i;
  if (found.minGrowth === undefined && (m = YOY.exec(rest))) {
    found.minGrowth = m[1] !== undefined ? Number(m[1]) : (Number(m[2]) - 1) * 100;
    found.growthPeriod = "12m";
    cut(m[0]);
  }

  for (const hit of rest.matchAll(/(?:in\s+the\s+|within\s+the\s+)?(?:last|past)\s+(\d+)\s+(months?|years?)/gi)) {
    if (!aboutFunding(rest, hit.index ?? 0)) continue;
    found.raisedWithinMonths = Number(hit[1]) * (/^year/i.test(hit[2]) ? 12 : 1);
    rest = rest.slice(0, hit.index) + " " + rest.slice((hit.index ?? 0) + hit[0].length);
    break;
  }

  if ((m = UNFUNDED.exec(rest))) { found.unfunded = true; cut(m[0]); }
  const isCustomer = (index: number, matched: string) => {
    const after = rest.slice(index + matched.length);
    return CUSTOMER_AFTER.test(after) || (CUSTOMER_BEFORE.test(rest.slice(0, index)) && CUSTOMER_NOUN_AFTER.test(after));
  };
  const NEG_STAGE = re(String.raw`\b(?:not|no|non|never|without|excluding|except)[\s-]+(?:yet\s+)?(?:raised\s+)?(?:an?\s+)?${STAGE}(?:\s*(?:,|or|and|\/|nor)\s*(?:${STAGE}|${NEXT_LETTER}))*(?:\s+(?:rounds?|funding|companies|startups))?`);
  for (let n; (n = NEG_STAGE.exec(rest)); ) { skip(n[0], "--stage"); cut(n[0]); }
  if ((m = PRE_SERIES.exec(rest))) {
    found.stages = STAGES.slice(1, STAGES.indexOf(`series_${m[1].toLowerCase()}`)); cut(m[0]);
  } else if ((m = POST_SEED.exec(rest))) {
    found.stages = ["seed"]; cut(m[0]);
  } else if ((m = STAGE_RANGE.exec(rest)) && !isCustomer(m.index, m[0])) {
    const from = STAGES.indexOf(stageOf(m[1]));
    const to = STAGES.indexOf(m[2] ? stageOf(m[2]) : `series_${m[3].toLowerCase()}`);
    found.stages = STAGES.slice(Math.min(from, to), Math.max(from, to) + 1);
    cut(m[0]);
  } else if ((m = STAGE_PLUS.exec(rest)) && !isCustomer(m.index, m[0])) {
    found.stages = STAGES.slice(STAGES.indexOf(stageOf(m[1])));
    cut(m[0]);
  } else {
    const stages = new Set<string>();
    let customerEnd = -1;
    const text = rest, cuts: Array<[number, number]> = [];
    for (const hit of [...text.matchAll(new RegExp(STAGE_LIST.source, "gi"))]) {
      const at = hit.index ?? 0;
      // "for seed-stage startups and Series A companies": a stage right after a customer stage, joined by and/or, is a customer too.
      const listedAfterCustomer = customerEnd >= 0 && /^[\s\w]*?\s(?:and|or)\s*$/i.test(text.slice(customerEnd, at)) && CUSTOMER_NOUN_AFTER.test(text.slice(at + hit[0].length));
      const after = text.slice(at + hit[0].length);
      const customer = CUSTOMER_AFTER.test(after) || (CUSTOMER_BEFORE.test(text.slice(0, at)) && CUSTOMER_NOUN_AFTER.test(after));
      if (customer || listedAfterCustomer) { customerEnd = at + hit[0].length; continue; }
      stages.add(stageOf(hit[1]));
      if (stageOf(hit[1]).startsWith("series_")) for (const letter of hit[2].match(/\b[b-j]\b/gi) ?? []) stages.add(`series_${letter.toLowerCase()}`);
      cuts.push([at, hit[0].length]);
    }
    for (const [at, len] of cuts.reverse()) rest = rest.slice(0, at) + " " + rest.slice(at + len);
    if (stages.size) found.stages = STAGES.filter(s => stages.has(s));
  }
  // "non-YC", "not backed by Y Combinator", "without YC": leave those investors out, never require them.
  // Negated first and cut, so "excluding companies backed by YC" never reaches the positive patterns below.
  const notYc = /\b(?:non|not|no|never|without|excluding|except)[\s-]+(?:(?:companies|startups|those|ones)\s+)?(?:backed\s+by\s+)?(?:YC|Y[\s-]?Combinator)(?:[\s-]backed)?(?:\s+(?:companies|startups))?\b/i.exec(rest);
  if (notYc) { found.excludeInvestors = ["Y Combinator"]; cut(notYc[0]); }
  const NAME = String.raw`(?:YC|Y[\s-]?Combinator|[A-Z][\w&.']*(?:\s+(?:[A-Z][\w&.']*|of|&))*)`;
  const notBacked = new RegExp(String.raw`\b(?:[Nn]ot|[Nn]ever|[Ww]ithout|[Ee]xcluding|[Ee]xcept)\s+(?:(?:companies|startups|those|ones)\s+)?(?:backed|funded)\s+by\s+(${NAME}(?:\s*(?:,|\bor\b|\band\b|\bnor\b)\s*${NAME})*)`).exec(rest);
  if (notBacked) {
    const names = notBacked[1].split(/\s*(?:,|\bor\b|\band\b|\bnor\b)\s*/).filter(Boolean).map(n => (/^(?:YC|Y[\s-]?Combinator)$/i.test(n) ? "Y Combinator" : n.trim()));
    found.excludeInvestors = [...new Set([...(found.excludeInvestors ?? []), ...names])]; cut(notBacked[0]);
  }
  // Then the investors to require, separately, so one of each can be in the same sentence.
  if ((m = YC_BACKED.exec(rest)) && negated(m.index)) { skip(m[0], "--exclude-investors"); cut(m[0]); m = null; }
  else if (m) { found.withInvestors = ["Y Combinator"]; cut(m[0]); }
  if (!found.withInvestors && (m = BACKED_BY.exec(rest))) { if (negated(m.index)) skip(m[0], "--exclude-investors"); else found.withInvestors = [m[1].trim()]; cut(m[0]); }
  // "not in the US", "outside Europe": places to leave out are not read; the words are removed so they do not become a place.
  const P = String.raw`(?:the\s+)?[A-Z][\w.]*(?:\s+[A-Z][\w.]*)*`;
  // A list of places after the negation ("not in the US or Canada") is cut whole.
  const notPlace = new RegExp(String.raw`\b(?:[Nn]ot\s+in|[Oo]utside(?:\s+of)?|[Ee]xcluding|[Ee]xcept(?:\s+in)?)\s+${P}(?:\s*(?:,|\bor\b|\band\b|\bnor\b)\s*${P})*`).exec(rest);
  if (notPlace) { notes.push(`"${notPlace[0].trim()}": places to leave out are not read from the sentence. Pass the places you want with --country or --state.`); cut(notPlace[0]); }

  // Places. Every city, state and country found is kept, and the search matches any of them ("Bay Area or London").
  const near: Near[] = [], homeCountries = new Set<string>();
  for (const [pattern, location, km, country] of METROS) {
    const hit = new RegExp(String.raw`${PLACE_LEAD}(?:${pattern.source})${PLACE_TAIL}`, pattern.flags).exec(rest);
    if (!hit) continue;
    if (negated(hit.index)) { skip(hit[0], "--country or --state"); cut(hit[0]); continue; }
    near.push({ location, km });
    homeCountries.add(country);
    // "Austin, Texas" is the city: its own state right after it is part of the name, not a second place.
    const code = /, ([A-Z]{2})$/.exec(location)?.[1];
    const home = code && STATE_NAMES[code];
    const at = hit.index + hit[0].length;
    const own = home ? new RegExp(String.raw`^\s*,?\s*(?:${home}|${code})\b`).exec(rest.slice(at)) : null;
    rest = rest.slice(0, hit.index) + " " + rest.slice(at + (own ? own[0].length : 0));
  }
  if (near.length) found.near = near;
  const states = new Set<string>();
  // Longest names first, so "West Virginia" is not read as Virginia.
  for (const state of [...US_STATES].sort((a, b) => b.length - a.length)) {
    const hit = new RegExp(String.raw`${PLACE_LEAD}\b${state}\b${PLACE_TAIL}`, "i").exec(rest);
    if (!hit || MARKET_AFTER.test(rest.slice((hit.index ?? 0) + hit[0].length))) continue;
    if (negated(hit.index)) { skip(hit[0], "--state"); cut(hit[0]); continue; }
    states.add(state);
    homeCountries.add("USA");
    cut(hit[0]);
  }
  if (/\bNew England\b/i.test(rest)) { ["Maine", "New Hampshire", "Vermont", "Massachusetts", "Rhode Island", "Connecticut"].forEach(x => states.add(x)); homeCountries.add("USA"); rest = rest.replace(/(?:(?:in|from)\s+)?\bNew England\b/i, " "); }
  if (states.size) found.states = [...states];
  const countries = new Set<string>();
  for (const [pattern, codes] of COUNTRIES) {
    const hit = new RegExp(String.raw`${PLACE_LEAD}(?:${pattern.source})${PLACE_TAIL}`, pattern.flags).exec(rest);
    if (!hit || MARKET_AFTER.test(rest.slice((hit.index ?? 0) + hit[0].length))) continue;
    if (negated(hit.index)) { skip(hit[0], "--country"); cut(hit[0]); continue; }
    codes.forEach(c => countries.add(c));
    cut(hit[0]);
  }
  // "Bay Area, US" means the Bay Area: a country that only repeats where a named city or state is goes.
  for (const c of [...countries]) if (homeCountries.has(c) && countries.size === 1) countries.delete(c);
  if (countries.size) found.countries = [...countries];

  // Founder backgrounds are scored, not searched (see sentenceWarnings): keep them out of the description query.
  rest = rest
    .replace(/\b(?:(?:founded|started|built|run|led)\s+by|with|from)?\s*(?:repeat|serial|second[\s-]time)\s+founders?\b/gi, " ")
    .replace(/\b(?:(?:founded|started|built|run|led)\s+by\s+|with\s+)?(?:[Ee]x-|[Ff]ormer\s+|[Aa]lumni of\s+)[A-Z][\w.&-]*(?:\s+(?:engineers?|founders?|employees|people|alumni|operators?|PMs?|leaders?))?/g, " ");
  // What is left describes the business. Tidy the commas and connectors the cuts left behind.
  const CONNECTOR = String.raw`(?:and|or|the|with|that|who|which|in|of|based|for|between|from|to|around|near|startups?|companies)`;
  const query = rest
    // A negation whose words were cut ("not based in Boston" -> "not") means nothing on its own.
    .replace(/\bnon-(?=\s|,|$)/gi, " ")
    // Two spaces mark where a cut was, so "not  AI" lost its object too.
    .replace(/\b(?:(?:that\s+)?(?:have|has|are|is)\s+)?(?:not|never|without|excluding|except|outside|anywhere\s+but|other\s+than)(?:\s+(?:yet|based|headquartered|located|in|from|the))*(?=\s{2,}|\s*(?:,|$))/gi, " ")
    .replace(/\b(?:that\s+)?(?:have|has)(?=\s{2,}|\s*(?:,|$))/gi, " ")
    .replace(/\b(?:any|every|all)\s+stages?\b/gi, " ")
    .replace(/\braised(?:\s+(?:money|funding|capital))?\b/gi, " ")
    .replace(/(?<![\w-])stage(?![\w-])/gi, " ")
    .replace(/(?<=\s|^)(?:pre|post|seed|series|multi)-(?=\s|,|$)/gi, " ")
    .replace(/\b(?:that|which|who)\s*,/gi, ",")
    .replace(new RegExp(String.raw`(,\s*|^\s*)(?:${CONNECTOR}\s+)+(?=,|$)`, "gi"), "$1")
    .replace(/\s+/g, " ")
    .replace(/(\s*,\s*)+/g, ", ")
    .replace(/^[\s,;.]+|[\s,;.]+$/g, "")
    .replace(new RegExp(String.raw`(?:[,\s]+${CONNECTOR})+$`, "i"), "")
    .replace(new RegExp(String.raw`^(?:${CONNECTOR}\s+)+`, "i"), "")
    .replace(new RegExp(String.raw`^${CONNECTOR}$`, "i"), "")
    .replace(/,\s*(?:or|and)\s*,/gi, ",")
    .trim();
  found.query = query || "startups";
  if (notes.length) found.notes = notes;
  return found;
}

/** What a sentence asked for that is not a filter, printed before any credit is spent. */
/** `flags` are the stage flags passed on the command line, so the stage note is not printed when --stage is set. */
export function sentenceWarnings(sentence: string, parsed: Parsed, flags: { stages?: unknown; unfunded?: unknown } = {}): string[] {
  const out: string[] = [...(parsed.notes ?? [])];
  const q = parsed.query ?? sentence;
  if (!parsed.stages?.length && !parsed.unfunded && !flags.stages && !flags.unfunded)
    out.push('No stage in the thesis, so every stage is included. Say "pre-seed or seed" or pass --stage pre_seed,seed (--unfunded for no disclosed round).');
  for (const typo of sentence.matchAll(/\b([A-Za-z]{4,7})\s+([A-Ja-j])\b(?![\w-])/g)) {
    const word = typo[1].toLowerCase();
    if (word !== "series" && /s.*r.*i|s.*i.*r/.test(word) && editDistance(word, "series") <= 2) out.push(`"${typo[0]}": did you mean Series ${typo[2].toUpperCase()}? As written it is not used as a filter.`);
  }
  const exEmployer = /\b(?:[Ee]x-|[Ff]ormer\s+|[Aa]lumni of\s+|who left\s+|[Ff]ounders? from\s+)([A-Z][\w.&-]*)/.exec(sentence);
  if (exEmployer)
    out.push(`Past employers are not read from the sentence. Pass them as --founders-from "${exEmployer[1]}" (adds points) or --only-founders-from "${exEmployer[1]}" (keeps only those).`);
  if (/\brepeat founders?\b|\bserial founders?\b|\bsecond[\s-]time founders?\b/i.test(sentence))
    out.push("Repeat founders score higher by default; it is a score, not a filter.");
  if (/\bhiring\b/i.test(q))
    out.push('"hiring" is scored (roles posted in the last 90 days), not filtered.');
  if (/\b(?:revenue|ARR|MRR|traction|profitable)\b/i.test(sentence))
    out.push("Revenue is not a filter. Founders' posts that mention traction (MRR, ARR, revenue, paying customers or profitability) count in the score.");
  if (/\d+(?:\.\d+)?\s*%|\b(?:growing|growth|grew|grown|doubled|tripled|\d+(?:\.\d+)?x)\b/i.test(q))
    out.push("Growth words that did not read as a number stay in the query. --min-growth 20 sets a headcount growth floor (--growth-months 3, 6 or 12).");
  if (/\bcompetitors? of\b|\bsimilar to\b|\blike\s+[A-Z]/.test(sentence))
    out.push('"competitors of" and "like X" are not filters; those words rank companies by description only.');
  if (/\b(?:not|never|without|excluding|except)\s+(?:\w+\s+)?backed by\b/i.test(q))
    out.push('"not backed by" was not read as an investor filter (investor names start with a capital letter). Pass --exclude-investors "Fund Name" to leave those companies out.');
  else if (/\bbacked by\b/i.test(q))
    out.push('"backed by" was not read as an investor filter (investor names start with a capital letter). Pass --with-investors "Fund Name" to filter on it.');
  if (parsed.withInvestors?.length && parsed.withInvestors[0] !== "Y Combinator")
    out.push(`Investor names must match exactly how Crustdata stores them ("${parsed.withInvestors[0]}"). If the run finds nothing, try --with-investors with the fund's full name, or --with-investors none.`);
  if (!parsed.countries?.length && !parsed.states?.length && !parsed.near?.length) {
    const place = /\b(?:in|from|based in|headquartered in)\s+(?:the\s+)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/.exec(q);
    if (place && !/^(?:Series|Q[1-4]|AI|SaaS|B2B)/.test(place[1])) out.push(`"${place[1]}" is not a place I know (countries, US states and some cities are). It stays a ranking hint; --country or --state sets a filter.`);
  }
  return out;
}

/** Notes about the whole spec (flags included), printed with the filters. */
export function specWarnings(spec: ThesisSpec): string[] {
  const out: string[] = [];
  // Only when even the earliest window for these stages starts after the newest allowed round.
  const earliest = Math.min(...(spec.stages?.length ? spec.stages : ["pre_seed", "seed", "series_a"]).flatMap(s => { const w = dueWindow(s); return w ? [w.half[0] as number] : []; }));
  if (spec.timing === "due" && spec.raisedWithinMonths !== undefined && Number.isFinite(earliest) && spec.raisedWithinMonths < earliest)
    out.push(`Every company raised in the last ${spec.raisedWithinMonths} months, so --timing due scores none of them as due. --timing fresh scores recent rounds.`);
  if (spec.onlyFoundersFrom && spec.limit < 100)
    out.push(`--only-founders-from filters the ${spec.limit} companies the search returns, so few may be left. --limit 100 or more looks wider.`);
  return out;
}

// ---------------------------------------------------------------------------
// Merging layers: defaults < saved file < sentence parser < flags. null from a flag clears the field.
// ---------------------------------------------------------------------------

export function mergeSpec(...layers: Array<SpecLayer | Parsed | undefined>): ThesisSpec {
  const out: { [k: string]: unknown } = { ...DEFAULTS };
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (k === "notes") continue;
      if (v === null) delete out[k];
      else if (v !== undefined) out[k] = v;
    }
  }
  if (!out.thesis || !String(out.thesis).trim()) throw new Error(USAGE);
  out.query ??= out.thesis;
  if (!out.foundersFrom) delete out.onlyFoundersFrom;
  if (out.minGrowth === undefined) delete out.growthPeriod;
  // One spelling per value, so "usa" and "USA" (or "texas" and "Texas") are the same search and the same pipeline.
  const ALIASES: { [k: string]: string } = { US: "USA", UK: "GBR", UAE: "ARE", "UNITED STATES": "USA", "UNITED KINGDOM": "GBR" };
  if (Array.isArray(out.countries)) out.countries = (out.countries as string[]).map(c => ALIASES[c.trim().toUpperCase()] ?? c).map(c => (KNOWN_ISO3.has(c.toUpperCase()) ? c.toUpperCase() : c.trim().toLowerCase().replace(/\b\w/g, x => x.toUpperCase())));
  if (Array.isArray(out.states)) out.states = (out.states as string[]).map(s => US_STATES.find(x => same(x, s)) ?? s);
  if (Array.isArray(out.stages)) out.stages = (out.stages as string[]).map(s => s.toLowerCase().replace(/[\s-]+/g, "_"));
  return out as ThesisSpec;
}

/** Turns relative dates into dates for this run. The spec that is saved keeps them relative. */
export function resolveDates(spec: ThesisSpec, today = new Date()): ThesisSpec {
  const out = { ...spec };
  if (spec.foundedWithinYears !== undefined) out.founded = [today.getUTCFullYear() - spec.foundedWithinYears, NO_UPPER_YEAR];
  if (spec.raisedWithinMonths !== undefined) {
    const d = new Date(today);
    d.setUTCMonth(d.getUTCMonth() - spec.raisedWithinMonths);
    out.raisedSince = d.toISOString().slice(0, 10);
  }
  return out;
}

/** The saved spec minus what the sentence decides, for when a new sentence replaces the old one. */
export function keepAcrossSentences(saved: ThesisSpec): SpecLayer {
  const kept: SpecLayer = { ...saved };
  for (const k of SENTENCE_FIELDS) delete kept[k];
  delete kept.thesis;
  return kept;
}

const sortKeys = (o: object): unknown => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)));
/** True when two specs are the same in every setting. */
export const sameSpec = (a: ThesisSpec, b: ThesisSpec): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
/** Two specs with the same key run the same search and fetch the same extras. */
export function searchKey(s: ThesisSpec): string {
  const copy: { [k: string]: unknown } = { ...s };
  for (const k of SCORING_FIELDS) delete copy[k];
  return JSON.stringify(sortKeys(copy));
}
/**
 * The key that decides whether two runs belong to the same pipeline (new / still here / gone). The size of the run,
 * the scoring settings and the exclusion lists do not count: passing on a company must not start a new pipeline.
 */
export function pipelineKey(s: ThesisSpec): string {
  const copy: { [k: string]: unknown } = { ...s, keyVersion: 2 };
  for (const k of [...SCORING_FIELDS, "limit", "postsFor", "quotes", "jobsFor", "exclude", "excludeInvestors"]) delete copy[k];
  return JSON.stringify(sortKeys(copy));
}

// ---------------------------------------------------------------------------
// Validation against autocomplete (free)
// ---------------------------------------------------------------------------

const same = (a: string, b: string) => a.toLowerCase().trim() === b.toLowerCase().trim();

export async function validateSpec(spec: ThesisSpec): Promise<{ spec: ThesisSpec; problems: string[] }> {
  const problems: string[] = [];
  const out: ThesisSpec = { ...spec };
  if (spec.stages?.length) {
    const stored = new Set<string>();
    for (const s of spec.stages) {
      const suggestions = await autocomplete("company", "funding.last_round_type", s.replace(/_/g, " "));
      const hit = suggestions.find(v => same(v, s));
      if (hit) stored.add(hit);
      else problems.push(`Stage "${s}" (--stage) is not a stored value. Stored values look like: ${suggestions.slice(0, 8).join(", ") || "pre_seed, seed, series_a, series_b"}`);
    }
    out.stages = [...stored];
  }
  if (spec.countries?.length) {
    const resolved: string[] = [];
    for (const c of spec.countries) {
      if (KNOWN_ISO3.has(c.toUpperCase())) { resolved.push(c.toUpperCase()); continue; }
      const suggestions = await autocomplete("company", "locations.country", c);
      const hit = suggestions.find(v => same(v, c));
      if (hit) resolved.push(hit);
      else problems.push(`Country "${c}" (--country) did not match. Use a full country name${suggestions.length ? ` (${suggestions.slice(0, 5).join(", ")})` : ""} or an ISO-3 code like USA, GBR, DEU, IND.`);
    }
    out.countries = resolved;
  }
  if (spec.states?.length) {
    out.states = [];
    for (const s of spec.states) {
      const hit = US_STATES.find(state => same(state, s));
      if (hit) out.states.push(hit); else problems.push(`State "${s}" (--state) is not a US state name. Use the full name, for example Texas or New York.`);
    }
  }
  if (spec.size && (spec.size[0] < 0 || spec.size[0] > spec.size[1])) problems.push(`--size ${spec.size.join("-")} is not a valid range.`);
  if (spec.founded && (spec.founded[0] > spec.founded[1] || spec.founded[0] < 1800)) problems.push(`Founded ${spec.founded.join(" to ")} is not a valid range.`);
  if (spec.onlyFoundersFrom && !spec.foundersFrom?.length) problems.push("--only-founders-from needs at least one company.");
  return { spec: out, problems };
}

// ---------------------------------------------------------------------------
// Company search rounds. Each round adds one group of hard filters, so --explain can show what each group dropped.
// ---------------------------------------------------------------------------

export type Round = { name: string; filters: Filter | undefined; describe: string[] };

export function fundingFilter(spec: ThesisSpec): { filter?: Filter; describe: string[] } {
  const describe: string[] = [];
  const funded: Filter[] = [];
  if (spec.stages?.length) { funded.push(leaf("funding.last_round_type", "in", spec.stages)); describe.push(`last round ${spec.stages.map(stageLabel).join(" or ")}`); }
  if (spec.raisedSince) { funded.push(leaf("funding.last_fundraise_date", "=>", spec.raisedSince)); describe.push(`raised since ${spec.raisedSince}`); }
  const unfunded = spec.unfunded ? leaf("funding.last_fundraise_date", "is_null", null) : undefined;
  if (spec.unfunded) describe.push(funded.length ? "or no disclosed round" : "no disclosed round");
  let filter: Filter | undefined =
    funded.length && unfunded ? or(funded.length === 1 ? funded[0] : and(...funded), unfunded)
    : funded.length ? (funded.length === 1 ? funded[0] : and(...funded))
    : unfunded;
  const extra: Filter[] = [];
  if (spec.withInvestors?.length) { extra.push(leaf("funding.investors", "in", spec.withInvestors)); describe.push(`backed by ${spec.withInvestors.join(" or ")}`); }
  if (spec.excludeInvestors?.length) { extra.push(leaf("funding.investors", "not_in", spec.excludeInvestors)); describe.push(`not backed by ${spec.excludeInvestors.join(" or ")}`); }
  if (extra.length) filter = and(filter, ...extra);
  return { filter, describe };
}

/** One place filter for every place in the thesis: any city, state or country matches. */
export function placeFilter(spec: ThesisSpec): { filter?: Filter; describe: string[] } {
  const leaves: Filter[] = [], describe: string[] = [];
  for (const n of spec.near ?? []) { leaves.push(leaf("locations.headquarters", "geo_distance", { location: n.location, distance: n.km, unit: "km" })); describe.push(`within ${n.km} km of ${n.location}`); }
  if (spec.states?.length) { leaves.push(leaf("locations.state", "in", spec.states)); describe.push(spec.states.join(", ")); }
  if (spec.countries?.length) { leaves.push(leaf("locations.country", "in", spec.countries)); describe.push(spec.countries.map(countryLabel).join(", ")); }
  return { filter: leaves.length > 1 ? or(...leaves) : leaves[0], describe: describe.length ? [`HQ ${describe.join(" or ")}`] : [] };
}

export function buildRounds(spec: ThesisSpec): Round[] {
  const base: Filter[] = [], baseText: string[] = [];
  if (spec.size) {
    base.push(leaf("headcount.total", "=>", spec.size[0]));
    if (spec.size[1] < NO_UPPER_BOUND) base.push(leaf("headcount.total", "=<", spec.size[1]));
    baseText.push(spec.size[1] < NO_UPPER_BOUND ? `${spec.size[0]} to ${spec.size[1]} people` : `${spec.size[0]}+ people`);
  }
  if (spec.founded) {
    base.push(leaf("basic_info.year_founded", "=>", spec.founded[0]));
    if (spec.founded[1] < NO_UPPER_YEAR) base.push(leaf("basic_info.year_founded", "=<", spec.founded[1]));
    baseText.push(spec.founded[1] < NO_UPPER_YEAR ? `founded ${spec.founded[0] === spec.founded[1] ? spec.founded[0] : `${spec.founded[0]} to ${spec.founded[1]}`}` : `founded ${spec.founded[0]} or later`);
  }
  const place = placeFilter(spec);
  if (place.filter) { base.push(place.filter); baseText.push(...place.describe); }
  if (spec.exclude?.length) { base.push(leaf("basic_info.primary_domain", "not_in", spec.exclude)); baseText.push(`not ${plural(spec.exclude.length, "excluded domain")}`); }

  const funding = fundingFilter(spec);
  const period = spec.growthPeriod ?? "3m";
  const growth = spec.minGrowth !== undefined ? leaf(`headcount.growth_percent.${period}`, "=>", spec.minGrowth) : undefined;
  const growthText = spec.minGrowth !== undefined ? [`headcount up ${spec.minGrowth}%+ in ${period.replace("m", " months")}`] : [];

  const rounds: Round[] = [{ name: "Round 1: the thesis plus size, age and place", filters: base.length ? and(...base) : undefined, describe: baseText }];
  if (funding.filter) rounds.push({ name: "Round 2: plus funding", filters: and(...base, funding.filter), describe: [...baseText, ...funding.describe] });
  if (growth) rounds.push({ name: `Round ${rounds.length + 1}: plus growth`, filters: and(...base, funding.filter, growth), describe: [...baseText, ...funding.describe, ...growthText] });
  return rounds;
}

/** Why a company from an earlier round is not in a later one. */
export function whyDropped(c: RawCompany, spec: ThesisSpec): string {
  const reasons: string[] = [];
  const f = c.funding ?? {};
  if (spec.stages?.length && !spec.stages.includes(f.last_round_type ?? "") && !(spec.unfunded && !f.last_fundraise_date)) reasons.push(`last round ${f.last_round_type || "none disclosed"}`);
  if (spec.unfunded && !spec.stages?.length && f.last_fundraise_date) reasons.push(`raised ${f.last_fundraise_date}`);
  if (spec.raisedSince && f.last_fundraise_date && f.last_fundraise_date < spec.raisedSince) reasons.push(`last raise ${f.last_fundraise_date}`);
  if (spec.withInvestors?.length && !f.investors?.some(i => spec.withInvestors!.includes(i))) reasons.push(`not backed by ${spec.withInvestors.join("/")}`);
  if (spec.excludeInvestors?.length && f.investors?.some(i => spec.excludeInvestors!.includes(i))) reasons.push("backed by an excluded investor");
  const period = spec.growthPeriod ?? "3m";
  const g = c.headcount?.growth_percent?.[period];
  if (spec.minGrowth !== undefined && !(typeof g === "number" && g >= spec.minGrowth)) reasons.push(`${period} growth ${typeof g === "number" ? Math.round(g) + "%" : "unknown"}`);
  return reasons.join(", ") || "ranked lower once the filters changed the candidates";
}

// ---------------------------------------------------------------------------
// Cost, printed before any credit is spent. List prices from docs.crustdata.com/general/pricing.
// ---------------------------------------------------------------------------

/** Founders searched per company: the request asks for up to 6; most seed companies have 2 or 3 matching people. */
export const PEOPLE_TYPICAL = 2, PEOPLE_MAX = 6;
export const LISTINGS_PER_COMPANY = 10;

export function costOf(spec: ThesisSpec, rounds: number) {
  const hasFunding = !!fundingFilter(spec).filter;
  // 0.03 per company, 0.2 for each premium group filtered on (headcount, funding) and each returned (headcount, funding, followers).
  const perCompany = 0.03 + (spec.size || spec.minGrowth !== undefined ? 0.2 : 0) + (hasFunding ? 0.2 : 0) + 0.6;
  const companies = perCompany * spec.limit * rounds;
  const person = 0.33; // 0.03, plus 0.1 to filter on experience, 0.1 to receive it, 0.1 for education
  const jobsMax = Math.min(spec.jobsFor, spec.limit) * LISTINGS_PER_COMPANY * 0.03;
  const postsMax = Math.min(spec.quotes, spec.limit) * 2 * 0.5;
  return {
    typical: companies + spec.limit * PEOPLE_TYPICAL * person + jobsMax / 2 + postsMax / 2,
    // Ceiling: every founder batch comes back full and each of its companies is searched again on its own (src/source.ts).
    max: companies + spec.limit * PEOPLE_MAX * 2 * person + jobsMax + postsMax,
  };
}

export function estimateCost(spec: ThesisSpec, rounds: number): string {
  const { typical, max } = costOf(spec, rounds);
  const r = (n: number) => (n < 10 ? Math.round(n * 10) / 10 : Math.round(n));
  const parts = [`${spec.limit * rounds} company results`, `about ${spec.limit * PEOPLE_TYPICAL} founder profiles`,
    spec.jobsFor && `role titles for up to ${Math.min(spec.jobsFor, spec.limit)} companies`, spec.quotes && `up to ${Math.min(spec.quotes, spec.limit) * 2} quoted posts`].filter(Boolean);
  return `about ${r(typical)} credits at list price, at most ${r(max)} (${parts.join(", ")}). Counting roles${spec.postsFor ? " and posts" : ""} is free.`;
}

// ---------------------------------------------------------------------------
// thesis.json: the spec plus the exact filters of the final round, so later runs (and readers) see the same query.
// ---------------------------------------------------------------------------

type SavedThesis = { spec: ThesisSpec; filters: Filter | undefined; savedAt: string };

export function loadThesis(): SavedThesis | undefined {
  if (!existsSync(paths.thesis())) return undefined;
  try { return JSON.parse(readFileSync(paths.thesis(), "utf8")) as SavedThesis; }
  catch (err) { throw new Error(`${paths.thesis()} is damaged (${(err as Error).message}). Delete it, or run with --fresh.`); }
}

export function saveThesis(spec: ThesisSpec, filters: Filter | undefined, now = new Date()) {
  mkdirSync(dirname(paths.thesis()), { recursive: true });
  const tmp = `${paths.thesis()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ spec, filters, savedAt: now.toISOString() }, null, 2) + "\n");
  renameSync(tmp, paths.thesis());
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const stageLabel = (s: string) => (s === "pre_seed" ? "Pre-seed" : s.startsWith("series_") ? `Series ${s.slice(7).toUpperCase()}` : s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " "));
const countryLabel = (c: string) => (ISO3_NAMES[c] ? `${ISO3_NAMES[c]} (${c})` : c);
const years = (f: [number, number]) => (f[1] >= NO_UPPER_YEAR ? `${f[0]} or later` : f[0] === f[1] ? `${f[0]}` : `${f[0]} to ${f[1]}`);

export function describeSpec(spec: ThesisSpec): string {
  const funding = fundingFilter(spec).describe;
  const place = placeFilter(spec).describe;
  const onlyUnfunded = spec.unfunded && !spec.stages?.length && !spec.raisedSince;
  const lines = [
    `  query:         ${spec.query}`,
    spec.size && `  size:          ${spec.size[1] < NO_UPPER_BOUND ? `${spec.size[0]} to ${spec.size[1]}` : `${spec.size[0]}+`} people${spec.size[0] === DEFAULT_MIN_SIZE && spec.size[1] === NO_UPPER_BOUND ? " (default floor; --size none to remove)" : ""}`,
    spec.founded && `  founded:       ${years(spec.founded)}${spec.foundedWithinYears !== undefined ? ` (the last ${spec.foundedWithinYears} years, recomputed each run)` : ""}`,
    place.length && `  place:         ${place[0].replace(/^HQ /, "")}`,
    funding.length && `  funding:       ${funding.join(", ")}${spec.raisedWithinMonths !== undefined ? ` (the last ${spec.raisedWithinMonths} months, recomputed each run)` : ""}`,
    spec.minGrowth !== undefined && `  growth:        headcount up ${spec.minGrowth}% or more in ${(spec.growthPeriod ?? "3m").replace("m", " months")}`,
    spec.exclude?.length && `  exclude:       ${plural(spec.exclude.length, "domain")}`,
    spec.foundersFrom?.length && `  founders from: ${spec.foundersFrom.join(", ")}${spec.onlyFoundersFrom ? " (only these)" : " (adds points)"}`,
    spec.schools?.length && `  schools:       ${spec.schools.join(", ")} (adds points)`,
    `  timing:        ${spec.timing === "off" ? "not scored" : onlyUnfunded ? "not scored (no disclosed round)" : spec.timing === "due" ? `due to raise (${windowsText(spec.stages)}; only with recent growth)` : "just raised (last 6 months)"}`,
    `  pipeline:      up to ${spec.limit} companies, up to ${MAX_FOUNDERS} founders each`,
  ];
  return lines.filter(Boolean).join("\n");
}
