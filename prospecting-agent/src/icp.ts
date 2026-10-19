/**
 * The ICP: one plain-English sentence plus hard filters. Works without an LLM.
 *
 * The sentence goes to ranked company search as `search.query`. A small rule-based parser lifts the obvious hard
 * filters out of it (size, funding stage, raise recency, place, investor) and removes those phrases, so ranking runs
 * on what the company does. Flags always win over the parser. Every categorical value is checked with autocomplete
 * before a credit is spent, and the parser says out loud when a sentence contains something it cannot filter on.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { icpPath } from "./config.js";
import { and, autocomplete, leaf, or, type Company, type Filter } from "./crustdata.js";

export type IcpSpec = {
  icp: string;                 // the sentence, as typed
  query: string;               // what goes to search.query: the sentence minus the phrases the parser turned into filters
  limit: number;               // accounts in the shortlist (ranked search stops at 1,000)
  perCompany: number;          // people kept per account
  size?: [number, number];     // headcount.total between (default 10 and up; --size none removes the floor)
  countries?: string[];        // locations.country, ISO-3 code or full name
  states?: string[];           // locations.state, US state names
  near?: { location: string; km: number }; // locations.headquarters within km of a place ("Bay Area")
  raised?: string[];           // funding.last_round_type, stored values like "series_a"
  since?: string;              // funding.last_fundraise_date on or after, YYYY-MM-DD
  investors?: string[];        // funding.investors, exact investor names ("Y Combinator")
  tech?: string[];             // technographics.technologies.name, tools in use ("HubSpot"); 1 credit per company result at list price
  industries?: string[];       // basic_info.industries, stored values
  growth?: number;             // headcount.growth_percent.12m above this percent
  exclude?: string[];          // domains to leave out (your own, your customers)
  titles?: string[];           // buyer titles, most important first
  seniority?: string[];        // person seniority levels, stored values (combined with titles: both must hold)
  fallback?: boolean;          // false: no "most senior people" search for accounts where no title matched
  minConnections?: number;     // optional floor on profile connections, to skip placeholder profiles (costs more per person)
};

/** What a flag can set. null means "clear this filter" (from `--since none`). */
export type SpecLayer = { [K in keyof IcpSpec]?: IcpSpec[K] | null };

/** The fields the sentence decides. A new sentence resets these and keeps the rest (titles, keywords, ...). */
const SENTENCE_FIELDS = ["query", "size", "countries", "states", "near", "raised", "since", "investors", "tech", "industries", "growth"] as const;

export const NO_UPPER_BOUND = 1_000_000;
/** Without a size in the sentence or --size, companies under this many people are left out: one-person shells rank well on words. */
export const DEFAULT_MIN_SIZE = 10;
/** No "most senior people" guessing above this size: at a 5,000-person company "Vice President" is hundreds of people. */
export const FALLBACK_MAX_SIZE = 1000;
const STAGES = ["pre_seed", "seed", "series_a", "series_b", "series_c", "series_d", "series_e", "series_f", "series_g", "series_h", "series_i", "series_j"];

/** Person seniority levels, most senior first. The fallback people search uses the first three. */
const SENIORITY = ["CXO", "Owner / Partner", "Vice President", "Director", "Experienced Manager", "Senior", "Entry Level Manager", "Strategic", "Entry Level", "In Training"];
export const FALLBACK_SENIORITY = SENIORITY.slice(0, 3);

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const FLAGS: Record<string, (v: string) => SpecLayer> = {
  icp: v => ({ icp: v }),
  size: v => {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(v.replace(/,/g, ""));
    if (!m) throw new Error(`--size takes a range like 50-500, got "${v}"`);
    return { size: [Number(m[1]), Number(m[2])] };
  },
  country: v => ({ countries: list(v) }),
  state: v => ({ states: list(v) }),
  raised: v => ({ raised: list(v) }),
  since: v => ({ since: normalizeDate(v) }),
  investor: v => ({ investors: list(v) }),
  tech: v => ({ tech: list(v) }),
  industry: v => ({ industries: list(v) }),
  growth: v => ({ growth: Number(v) }),
  exclude: v => ({ exclude: list(v).map(d => d.toLowerCase()) }),
  titles: v => ({ titles: list(v) }),
  seniority: v => ({ seniority: list(v) }),
  fallback: v => ({ fallback: !["none", "off", "false", "no"].includes(v.toLowerCase()) }),
  limit: v => ({ limit: Math.min(1000, Number(v)) }),
  "per-company": v => ({ perCompany: Number(v) }),
  "min-connections": v => ({ minConnections: Number(v) }),
};
const CLEARABLE: Record<string, keyof IcpSpec> = {
  size: "size", country: "countries", state: "states", raised: "raised", since: "since", investor: "investors", tech: "tech", industry: "industries", growth: "growth",
  exclude: "exclude", titles: "titles", seniority: "seniority",
  "min-connections": "minConnections",
};
const SWITCHES = ["yes", "y", "fresh", "explain", "force"] as const;
export type Switches = { yes: boolean; fresh: boolean; explain: boolean; force: boolean };

const list = (v: string) => v.split(",").map(s => s.trim()).filter(Boolean);

export function parseFlags(argv: string[]): { flags: SpecLayer } & Switches {
  const flags: SpecLayer = {};
  const on: Switches = { yes: false, fresh: false, explain: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.replace(/^--?/, "");
    if ((arg.startsWith("--") || arg === "-y") && (SWITCHES as readonly string[]).includes(name)) {
      on[name === "y" ? "yes" : (name as keyof Switches)] = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}". Flags look like --size 50-500.`);
    const [key, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[++i];
    if (!FLAGS[key]) throw new Error(`Unknown flag --${key}. Flags: ${Object.keys(FLAGS).map(f => "--" + f).join(", ")}, --fresh, --explain, --force, --yes`);
    if (value === undefined || value === "") throw new Error(`--${key} needs a value.`);
    if (value.toLowerCase() === "none" && CLEARABLE[key]) Object.assign(flags, { [CLEARABLE[key]]: null });
    else Object.assign(flags, FLAGS[key](value));
  }
  return { flags, ...on };
}

export function normalizeDate(s: string): string {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (!m || Number(m[2] ?? 1) < 1 || Number(m[2] ?? 1) > 12 || Number(m[3] ?? 1) < 1 || Number(m[3] ?? 1) > 31) {
    throw new Error(`Dates look like 2025, 2025-04 or 2025-04-01, got "${s}"`);
  }
  return `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}`;
}

// ---------------------------------------------------------------------------
// Rule-based sentence parser
// ---------------------------------------------------------------------------

const re = (source: string) => new RegExp(source, "i");
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?k?)`;
const PEOPLE = String.raw`\s*(?:people|employees|staff|persons?|FTEs?|headcount)`;
const toNum = (s: string) => (s.toLowerCase().endsWith("k") ? Number(s.slice(0, -1).replace(/,/g, "")) * 1000 : Number(s.replace(/,/g, "")));

// "teams of 10 to 50 people", "with 20 to 500 employees": the lead-in words go with the number.
const LEAD = String.raw`(?:(?:with|of|from)\s+)?`;
// "SMB", "mid-market", "enterprise" count as the company's own size, but not when the sentence says who they sell
// to ("sells to mid-market", "for America's small businesses"): then the words stay in the query.
const SELLS_TO = /\b(?:to|for|serving|targeting|sell|sells|selling)\b(?:\s+\S+){0,3}\s*$/i;
type SizeRule = [RegExp, (m: RegExpExecArray) => [number, number], boolean?];
const SIZES: SizeRule[] = [
  [re(String.raw`${LEAD}(?:between\s+)?${NUM}\s*(?:to|-|and)\s*${NUM}${PEOPLE}`), m => [toNum(m[1]), toNum(m[2])]],
  [re(String.raw`${LEAD}(?:under|fewer than|less than|up to)\s*${NUM}${PEOPLE}`), m => [1, toNum(m[1])]],
  [re(String.raw`${LEAD}(?:over|more than|at least)\s*${NUM}${PEOPLE}`), m => [toNum(m[1]), NO_UPPER_BOUND]],
  [re(String.raw`${LEAD}${NUM}\s*\+${PEOPLE}`), m => [toNum(m[1]), NO_UPPER_BOUND]],
  [re(String.raw`\b(?:SMBs?|small businesses|small and medium(?:[\s-]sized)? businesses)\b`), () => [1, 100], true],
  [re(String.raw`\bmid[\s-]?market\b(?:\s+companies)?`), () => [100, 1000], true],
  [re(String.raw`\benterprise\s+(?:companies|accounts|businesses|orgs|organizations)\b`), () => [1000, NO_UPPER_BOUND], true],
];

// "seed", "pre-seed", "Series B", "seed-stage", "Series A-funded"; a bare letter only after a series ("Series A or B",
// "Series A-C"). The lookahead keeps "Series E-commerce" and "C-level" out. Continuations start at b, so the article
// in "Series B, a fintech" is not read as Series A.
const END = String.raw`(?!\w|-(?!stage\b|funded\b|backed\b)[a-z]{2})(?:[\s-](?:stage|funded|backed)\b)?`;
const STAGE = String.raw`\b(pre[\s-]?seed|seed|series[\s-]+[a-j])${END}`;
const LETTER = String.raw`\b([a-j])${END}`;
const NEXT_LETTER = String.raw`\b[b-j]${END}`;
const stageOf = (word: string): string => {
  const w = word.toLowerCase().replace(/[\s-]+/g, " ");
  return w.startsWith("pre") ? "pre_seed" : w === "seed" ? "seed" : `series_${w.slice(-1)}`;
};
const STAGE_RANGE = re(String.raw`(?:raised\s+)?(?:an?\s+)?${STAGE}\s*(?:to|through|-)\s*(?:${STAGE}|${LETTER})(?:\s+(?:rounds?|funding))?`);
const STAGE_PLUS = re(String.raw`(?:raised\s+)?(?:an?\s+)?${STAGE}\s*\+`);
const STAGE_LIST = re(String.raw`(?:raised\s+)?(?:an?\s+)?${STAGE}((?:\s*(?:,|or|and|\/)\s*${NEXT_LETTER})*)(?:\s+(?:rounds?|funding))?`);
const PE_BACKED = /\b(?:PE|private[\s-]equity)[\s-](?:backed|owned)\b(?:\s+companies)?/i;
// "that use HubSpot", "running on Shopify", "built on AWS": tools in use, a technographics filter.
const USES_TECH = /\b(?:(?:that|who|which|and)\s+)?(?:uses?|using|run(?:s|ning)?\s+on|built\s+on|powered\s+by)\s+([A-Z][\w.+-]*(?:\s+(?:or|and)\s+[A-Z][\w.+-]*)*)/;
/** "using AI", "built on data": words that describe the company, not a product it runs; they stay in the query. */
const GENERIC_TECH = new Set(["ai", "ml", "llm", "llms", "genai", "generative", "machine", "data", "cloud", "api", "apis", "automation", "software", "technology", "tech", "saas", "analytics", "agents", "models"]);
const YC_BACKED = /\b(?:YC|Y[\s-]?Combinator)(?:[\s-]backed)?\b(?:\s+companies|\s+startups)?/i;

// Places. Country words anywhere in the sentence become an HQ filter (clear with --country none).
const EUROPE = ["GBR", "DEU", "FRA", "NLD", "ESP", "ITA", "SWE", "IRL", "CHE", "DNK", "FIN", "NOR", "BEL", "AUT", "POL", "PRT"];
const NORDICS = ["SWE", "DNK", "FIN", "NOR", "ISL"];
const DACH = ["DEU", "AUT", "CHE"];
const BENELUX = ["BEL", "NLD", "LUX"];
const LATAM = ["BRA", "MEX", "ARG", "COL", "CHL", "PER", "URY", "ECU"];
const SEA = ["SGP", "IDN", "MYS", "THA", "VNM", "PHL"];
const APAC = [...SEA, "AUS", "NZL", "IND", "JPN", "KOR", "CHN", "HKG", "TWN"];
const MENA = ["ARE", "SAU", "ISR", "EGY", "QAT", "KWT", "BHR", "OMN", "JOR", "MAR"];
const GCC = ["ARE", "SAU", "QAT", "KWT", "BHR", "OMN"];
const COUNTRY_NAMES: Array<[string, string]> = [
  ["Ireland", "IRL"], ["Canada", "CAN"], ["India", "IND"], ["Germany", "DEU"], ["France", "FRA"], ["Israel", "ISR"], ["Australia", "AUS"],
  ["New Zealand", "NZL"], ["Singapore", "SGP"], ["Brazil", "BRA"], ["Mexico", "MEX"], ["Argentina", "ARG"], ["Colombia", "COL"], ["Chile", "CHL"],
  ["Peru", "PER"], ["Netherlands", "NLD"], ["Holland", "NLD"], ["Spain", "ESP"], ["Italy", "ITA"], ["Sweden", "SWE"], ["Denmark", "DNK"],
  ["Finland", "FIN"], ["Norway", "NOR"], ["Switzerland", "CHE"], ["Austria", "AUT"], ["Belgium", "BEL"], ["Poland", "POL"], ["Portugal", "PRT"],
  ["Czech Republic", "CZE"], ["Czechia", "CZE"], ["Estonia", "EST"], ["Romania", "ROU"], ["Hungary", "HUN"], ["Greece", "GRC"], ["Turkey", "TUR"],
  ["Japan", "JPN"], ["South Korea", "KOR"], ["Korea", "KOR"], ["China", "CHN"], ["Hong Kong", "HKG"], ["Taiwan", "TWN"], ["Indonesia", "IDN"],
  ["Malaysia", "MYS"], ["Thailand", "THA"], ["Vietnam", "VNM"], ["Philippines", "PHL"], ["Pakistan", "PAK"], ["Bangladesh", "BGD"],
  ["UAE", "ARE"], ["United Arab Emirates", "ARE"], ["Dubai", "ARE"], ["Saudi Arabia", "SAU"], ["Qatar", "QAT"], ["Egypt", "EGY"],
  ["South Africa", "ZAF"], ["Nigeria", "NGA"], ["Kenya", "KEN"],
];
const COUNTRIES: Array<[RegExp, string[]]> = [
  [/\bNorth America\b/i, ["USA", "CAN"]],
  [/\b(?:US|USA|United States)\b|\bU\.S\.(?:A\.?)?(?!\w)|(?<!(?:Latin|South|Central|North) )\bAmerica\b/, ["USA"]],
  [/\b(?:UK|United Kingdom|Britain|England|Scotland|Wales)\b/, ["GBR"]],
  [/\b(?:LATAM|Latin America|South America)\b/i, LATAM],
  [/\bNordics?\b|\bScandinavia\b/i, NORDICS],
  [/\bDACH\b/, DACH],
  [/\bBenelux\b/i, BENELUX],
  [/\bSoutheast Asia\b|\bSEA\b/, SEA],
  [/\bAPAC\b|\bAsia[\s-]Pacific\b/i, APAC],
  [/\bGCC\b|\bGulf\b/, GCC],
  [/\bMENA\b|\bMiddle East\b/i, MENA],
  [/\bEurop(?:e|ean)\b|\bEMEA\b/i, EUROPE],
  ...COUNTRY_NAMES.map(([name, code]): [RegExp, string[]] => [new RegExp(String.raw`\b${name}\b`, "i"), [code]]),
];
/** ISO-3 codes accepted without an autocomplete check. Anything else goes through autocomplete as a country name. */
const KNOWN_ISO3 = new Set(COUNTRIES.flatMap(([, codes]) => codes));

const US_STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri",
  "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia",
  "Wisconsin", "Wyoming"];
/** Metro areas become "HQ within N km of a place" (geo_distance on locations.headquarters). */
const METROS: Array<[RegExp, string, number]> = [
  [/\b(?:SF )?Bay Area\b|\bSilicon Valley\b|\bSan Francisco\b|\bSF\b/, "San Francisco, CA", 80],
  [/\bNYC\b|\bNew York City\b|\bManhattan\b/i, "New York, NY", 50],
  [/\bLos Angeles\b|\bLA\b(?!\w)/, "Los Angeles, CA", 80],
  [/\bBoston\b/i, "Boston, MA", 60], [/\bAustin\b/i, "Austin, TX", 60], [/\bSeattle\b/i, "Seattle, WA", 60], [/\bChicago\b/i, "Chicago, IL", 60],
  [/\bDenver\b/i, "Denver, CO", 60], [/\bMiami\b/i, "Miami, FL", 60], [/\bAtlanta\b/i, "Atlanta, GA", 60], [/\bToronto\b/i, "Toronto, ON", 60],
  [/\bLondon\b/i, "London, UK", 50], [/\bBerlin\b/i, "Berlin, Germany", 50], [/\bParis\b/i, "Paris, France", 50], [/\bAmsterdam\b/i, "Amsterdam, Netherlands", 50],
  [/\bBangalore\b|\bBengaluru\b/i, "Bengaluru, India", 50], [/\bMumbai\b/i, "Mumbai, India", 60], [/\bTel Aviv\b/i, "Tel Aviv, Israel", 50],
];

const FUNDING_WORD = /\b(raised?|raising|funded|funding|round|series\s+[a-j]|seed)\b/gi;
const OTHER_TIMELINE = /\b(founded|started|launched|incorporated|grew|grown|growing|hired|hiring)\b/gi;

/**
 * True when the words just before a date phrase, in the same clause, are about funding: "raised Series A in the last
 * 18 months" is a raise date, "founded in the last 2 years" and "grew 30% in the past year" are not.
 */
function aboutFunding(text: string, at: number): boolean {
  const before = text.slice(0, at).split(/[,;](?!\d)/).pop() ?? "";
  const lastIndex = (pattern: RegExp) => Math.max(-1, ...[...before.matchAll(pattern)].map(m => m.index ?? -1));
  const funding = lastIndex(FUNDING_WORD);
  return funding >= 0 && funding > lastIndex(OTHER_TIMELINE);
}

const PLACE_LEAD = String.raw`(?:based\s+|headquartered\s+|located\s+)?(?:(?:in|from|around|near)\s+(?:the\s+)?)?`;
const PLACE_TAIL = String.raw`(?:-based|-headquartered|'s)?`;

export function parseSentence(sentence: string, today = new Date()): Partial<IcpSpec> {
  const found: Partial<IcpSpec> = {};
  let rest = sentence;
  const cut = (text: string) => { rest = rest.replace(text, " "); };
  let m: RegExpExecArray | null;

  for (const [pattern, range, ownSizeOnly] of SIZES) {
    if (!(m = pattern.exec(rest))) continue;
    if (ownSizeOnly && SELLS_TO.test(rest.slice(0, m.index))) continue; // "sells to mid-market": their customers, not them
    found.size = range(m);
    cut(m[0]);
    break;
  }

  // The first date phrase about funding wins; "founded in the last 5 years" before it is left in the query.
  for (const hit of rest.matchAll(/(?:in\s+the\s+|within\s+the\s+)?(?:last|past)\s+(\d+)\s+(months?|years?)/gi)) {
    if (!aboutFunding(rest, hit.index ?? 0)) continue;
    const d = new Date(today);
    if (/^month/i.test(hit[2])) d.setUTCMonth(d.getUTCMonth() - Number(hit[1])); else d.setUTCFullYear(d.getUTCFullYear() - Number(hit[1]));
    found.since = d.toISOString().slice(0, 10);
    rest = rest.slice(0, hit.index) + " " + rest.slice((hit.index ?? 0) + hit[0].length);
    break;
  }
  if (!found.since) {
    for (const hit of rest.matchAll(/\bsince\s+(\d{4}(?:-\d{2})?)\b/gi)) {
      if (!aboutFunding(rest, hit.index ?? 0)) continue;
      try { found.since = normalizeDate(hit[1]); } catch { continue; } // not a usable date; leave it in the query
      rest = rest.slice(0, hit.index) + " " + rest.slice((hit.index ?? 0) + hit[0].length);
      break;
    }
  }

  if ((m = PE_BACKED.exec(rest))) { found.raised = ["private_equity"]; cut(m[0]); }
  else if ((m = STAGE_RANGE.exec(rest))) {
    const from = STAGES.indexOf(stageOf(m[1]));
    const to = STAGES.indexOf(m[2] ? stageOf(m[2]) : `series_${m[3].toLowerCase()}`);
    found.raised = STAGES.slice(Math.min(from, to), Math.max(from, to) + 1);
    cut(m[0]);
  } else if ((m = STAGE_PLUS.exec(rest))) {
    found.raised = STAGES.slice(STAGES.indexOf(stageOf(m[1])));
    cut(m[0]);
  } else {
    const stages = new Set<string>();
    for (const hit of rest.matchAll(new RegExp(STAGE_LIST.source, "gi"))) {
      stages.add(stageOf(hit[1]));
      if (stageOf(hit[1]).startsWith("series_")) for (const letter of hit[2].match(/\b[b-j]\b/gi) ?? []) stages.add(`series_${letter.toLowerCase()}`);
      cut(hit[0]);
    }
    if (stages.size) found.raised = STAGES.filter(s => stages.has(s));
  }
  if ((m = YC_BACKED.exec(rest))) { found.investors = ["Y Combinator"]; cut(m[0]); }
  if ((m = USES_TECH.exec(rest))) {
    const names = m[1].split(/\s+(?:or|and)\s+/).filter(n => !GENERIC_TECH.has(n.toLowerCase()));
    if (names.length) { found.tech = names; cut(m[0]); }
  }

  // Places: metros first (so "New York City" is not read as the state), then states, then countries.
  for (const [pattern, location, km] of METROS) {
    const hit = new RegExp(String.raw`${PLACE_LEAD}(?:${pattern.source})${PLACE_TAIL}`, pattern.flags).exec(rest);
    if (!hit) continue;
    found.near = { location, km };
    cut(hit[0]);
    break;
  }
  const states = new Set<string>();
  for (const state of US_STATES) {
    const hit = new RegExp(String.raw`${PLACE_LEAD}\b${state}\b${PLACE_TAIL}`, "i").exec(rest);
    if (!hit) continue;
    states.add(state);
    cut(hit[0]);
  }
  if (states.size) found.states = [...states];
  const countries = new Set<string>();
  for (const [pattern, codes] of COUNTRIES) {
    // "US-based" and "America's" go as one piece, so the query does not keep "-based" or "'s".
    const hit = new RegExp(String.raw`${PLACE_LEAD}(?:${pattern.source})${PLACE_TAIL}`, pattern.flags).exec(rest);
    if (!hit) continue;
    codes.forEach(c => countries.add(c));
    cut(hit[0]);
  }
  if (countries.size) found.countries = [...countries];
  if (found.states?.length && !found.countries) found.countries = ["USA"];

  // What is left describes the business. Tidy the commas and connectors the cuts left behind.
  const CONNECTOR = String.raw`(?:and|or|with|that|who|which|in|of|based|for|between|from|to|around|near)`;
  const query = rest
    .replace(/\braised(?:\s+(?:money|funding|capital))?\b/gi, " ")
    .replace(/\b(?:that|which|who)\s*,/gi, ",")
    .replace(/\s+/g, " ")
    .replace(/(\s*,\s*)+/g, ", ")
    .replace(/^[\s,;.]+|[\s,;.]+$/g, "")
    .replace(new RegExp(String.raw`(?:[,\s]+${CONNECTOR})+$`, "i"), "")
    .replace(new RegExp(String.raw`^(?:${CONNECTOR}\s+)+`, "i"), "")
    .replace(new RegExp(String.raw`^${CONNECTOR}$`, "i"), "")
    .trim();
  // A sentence made only of filters ("Series A, 10 to 50 people, US") still needs a query for ranked search.
  found.query = query || "companies";
  return found;
}

/** Levenshtein distance, for catching "Seris A" style typos in filter words. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * What a sentence asked for that is not a filter here, and what will cost extra. Printed before any credit is spent, so nobody pays for a
 * search that quietly ignored "uses HubSpot" or "in the Bay Area".
 */
export function sentenceWarnings(sentence: string, parsed: Partial<IcpSpec>): string[] {
  const out: string[] = [];
  const q = parsed.query ?? sentence;
  if (parsed.tech?.length)
    out.push(`Tools in use (${parsed.tech.join(", ")}) filter on technographics: 1 extra credit per company result at list price, free on plans that include it. --tech none drops it.`);
  if (/\b(?:with|have|has|having)\s+(?:an?\s+|\d+\s+)?[\w\s-]{0,30}\bteams?\b|\bwould\s+buy\b|\bneeds?\b|\blooking\s+for\b|\bthat\s+buy\b/i.test(sentence))
    out.push('Describe what the company does, not what it has or needs: "companies with a sales team" finds companies that sell sales services. Try "B2B SaaS selling to HR teams, 100 to 1000 people".');
  for (const typo of sentence.matchAll(/\b([A-Za-z]{4,7})\s+([A-Ja-j])\b(?![\w-])/g)) {
    const word = typo[1].toLowerCase();
    if (word !== "series" && /s.*r.*i|s.*i.*r/.test(word) && editDistance(word, "series") <= 2) out.push(`"${typo[0]}": did you mean Series ${typo[2].toUpperCase()}? As written it is not used as a filter.`);
  }
  if (/\bhiring\b/i.test(q) || /\bthat are hiring\b/i.test(sentence))
    out.push('"hiring" is not a company filter. To hear when an account posts a role, set up a Crustdata job watcher on the shortlist (npm run watch-example).');
  if (/\b(?:revenue|ARR|turnover|doing)\b.*\d|\$\s?\d|\b\d+\s*(?:M|million)\b\s+(?:in\s+)?(?:revenue|ARR)/i.test(sentence))
    out.push("Revenue is not a filter in company search; the size filter (--size) is the closest proxy.");
  if (/\bcustomers? of\b|\bcompetitors? of\b|\bsimilar to\b|\blike\s+[A-Z]/.test(sentence))
    out.push('"customers of", "competitors of" and "like X" are not filters; the words rank companies by description only.');
  if (!parsed.size)
    out.push(`No size in the sentence: companies under ${DEFAULT_MIN_SIZE} people are left out by default. Say "50 to 500 people" or pass --size.`);
  if (parsed.countries?.length || parsed.states?.length || parsed.near) {
    const stray = /\b(?:and|or)\s+(?:the\s+)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/.exec(q);
    if (stray && !/^(?:Series|Head|Chief|VP|Director|AI|SaaS)/.test(stray[1]))
      out.push(`"${stray[1]}" was not recognised as a place, so it stays a ranking hint. If it is a country, add --country "${stray[1]}".`);
  } else if (/\b(?:in|from|based in|headquartered in)\s+(?:the\s+)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/.exec(q)) {
    const place = /\b(?:in|from|based in|headquartered in)\s+(?:the\s+)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/.exec(q)![1];
    if (!/^(?:Series|Q[1-4]|AI|SaaS|B2B)/.test(place)) out.push(`"${place}" is not a place I know (countries, US states and a few metro areas are). It stays a ranking hint; --country or --state sets a filter.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merging layers: saved file < sentence parser < flags. null from a flag clears the field.
// ---------------------------------------------------------------------------

const DEFAULTS: Partial<IcpSpec> = { limit: 100, perCompany: 3, size: [DEFAULT_MIN_SIZE, NO_UPPER_BOUND] };
export const USAGE = 'Describe your ideal customer: npm run find -- --icp "B2B SaaS selling to finance teams, 50 to 500 people, US"';

export function mergeSpec(...layers: Array<SpecLayer | undefined>): IcpSpec {
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (v === null) delete out[k];
      else if (v !== undefined) out[k] = v;
    }
  }
  if (!out.icp) throw new Error(USAGE);
  out.query ??= out.icp;
  return out as IcpSpec;
}

/** The saved spec minus what the sentence decides, for when a new sentence replaces the old one. */
export function keepAcrossSentences(saved: IcpSpec): SpecLayer {
  const kept: SpecLayer = { ...saved };
  for (const k of SENTENCE_FIELDS) delete kept[k];
  delete kept.icp;
  return kept;
}

/** True when two specs would run the same search (same filters, same people settings). */
export const sameSpec = (a: IcpSpec, b: IcpSpec): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (o: object): unknown => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)));

// ---------------------------------------------------------------------------
// Validation against autocomplete (free)
// ---------------------------------------------------------------------------

const same = (a: string, b: string) => a.toLowerCase().trim() === b.toLowerCase().trim();

export async function validateSpec(spec: IcpSpec): Promise<{ spec: IcpSpec; problems: string[] }> {
  const problems: string[] = [];
  const out: IcpSpec = { ...spec };
  const check = async (dataset: "company" | "person", field: string, values: string[] | undefined, query: (v: string) => string, problem: (v: string, suggestions: string[]) => string) => {
    if (!values?.length) return values;
    const resolved: string[] = [];
    for (const v of values) {
      const suggestions = await autocomplete(dataset, field, query(v));
      const hit = suggestions.find(s => same(s, v) || same(s, query(v)));
      if (hit) resolved.push(hit); else problems.push(problem(v, suggestions.slice(0, 8)));
    }
    return resolved;
  };

  out.raised = await check("company", "funding.last_round_type", spec.raised?.map(v => v.toLowerCase().replace(/[\s-]+/g, "_")), v => v.replace(/_/g, " "),
    (v, s) => `Funding round "${v}" (--raised) is not a stored value. Stored values look like: ${s.join(", ") || "seed, series_a, series_b, private_equity"}`);
  out.industries = await check("company", "basic_info.industries", spec.industries, v => v,
    (v, s) => `Industry "${v}" (--industry) is not a stored value. ${s.length ? `Close values: ${s.join(", ")}` : 'No close values; try a broader word, for example "Financial" rather than "Fintech".'}`);
  const names = spec.countries?.filter(c => !KNOWN_ISO3.has(c.toUpperCase()));
  const resolvedNames = await check("company", "locations.country", names, v => v,
    (v, s) => `Country "${v}" (--country) did not match. Use a full country name${s.length ? ` (${s.join(", ")})` : ""} or a common ISO-3 code like USA, GBR, DEU, IND.`);
  if (spec.countries) out.countries = [...spec.countries.filter(c => KNOWN_ISO3.has(c.toUpperCase())).map(c => c.toUpperCase()), ...(resolvedNames ?? [])];
  out.tech = await check("company", "technology", spec.tech, v => v,
    (v, s) => `Tool "${v}" (--tech) is not a stored technology name. ${s.length ? `Close values: ${s.join(", ")}` : "No close values."}`);
  if (spec.states?.length) {
    out.states = [];
    for (const s of spec.states) {
      const hit = US_STATES.find(state => same(state, s));
      if (hit) out.states.push(hit); else problems.push(`State "${s}" (--state) is not a US state name I know. Use the full name, for example Texas or New York.`);
    }
  }
  if (spec.seniority?.length) {
    out.seniority = [];
    for (const s of spec.seniority) {
      const hit = SENIORITY.find(level => same(level, s));
      if (hit) out.seniority.push(hit); else problems.push(`Seniority "${s}" (--seniority) is not a stored level. The levels are: ${SENIORITY.join(", ")}`);
    }
  }
  if (spec.size && (spec.size[0] < 0 || spec.size[0] > spec.size[1])) problems.push(`--size ${spec.size.join("-")} is not a valid range.`);
  if (spec.growth !== undefined && !Number.isFinite(spec.growth)) problems.push("--growth takes a number, for example 20 for 20% in 12 months.");
  if (!Number.isFinite(spec.limit) || spec.limit < 1) problems.push("--limit takes a number from 1 to 1000.");
  if (!Number.isFinite(spec.perCompany) || spec.perCompany < 1) problems.push("--per-company takes a number, 1 or more.");
  if (spec.minConnections !== undefined && (!Number.isFinite(spec.minConnections) || spec.minConnections < 0)) problems.push("--min-connections takes a number, for example 100, or none.");
  return { spec: out, problems };
}

// ---------------------------------------------------------------------------
// Company search rounds. Each round adds one group of hard filters, so the log can show what each group caught and
// dropped. Hard filters apply before ranking, so a tighter round can also catch companies the round before missed.
// ---------------------------------------------------------------------------

export type Round = { name: string; filters: Filter | undefined; describe: string[] };

export function buildRounds(spec: IcpSpec): Round[] {
  const base: Filter[] = [], baseText: string[] = [];
  if (spec.size) {
    base.push(leaf("headcount.total", "=>", spec.size[0]));
    if (spec.size[1] < NO_UPPER_BOUND) base.push(leaf("headcount.total", "=<", spec.size[1]));
    baseText.push(spec.size[1] < NO_UPPER_BOUND ? `${spec.size[0]} to ${spec.size[1]} people` : `${spec.size[0]}+ people`);
  }
  if (spec.near) { base.push(leaf("locations.headquarters", "geo_distance", { location: spec.near.location, distance: spec.near.km, unit: "km" })); baseText.push(`HQ within ${spec.near.km} km of ${spec.near.location}`); }
  else if (spec.states?.length) { base.push(leaf("locations.state", "in", spec.states)); baseText.push(`HQ in ${spec.states.join("/")}`); }
  else if (spec.countries?.length) { base.push(leaf("locations.country", "in", spec.countries)); baseText.push(`HQ in ${spec.countries.join("/")}`); }
  if (spec.exclude?.length) { base.push(leaf("basic_info.primary_domain", "not_in", spec.exclude)); baseText.push(`not ${spec.exclude.join(", ")}`); }
  if (spec.tech?.length) { base.push(leaf("technographics.technologies.name", "in", spec.tech)); baseText.push(`uses ${spec.tech.join("/")}`); }

  const funding: Filter[] = [], fundingText: string[] = [];
  if (spec.raised?.length) { funding.push(leaf("funding.last_round_type", "in", spec.raised)); fundingText.push(`last round ${spec.raised.join("/")}`); }
  if (spec.since) { funding.push(leaf("funding.last_fundraise_date", "=>", spec.since)); fundingText.push(`raised since ${spec.since}`); }
  if (spec.investors?.length) { funding.push(leaf("funding.investors", "in", spec.investors)); fundingText.push(`backed by ${spec.investors.join("/")}`); }

  const fit: Filter[] = [], fitText: string[] = [], fitNames: string[] = [];
  if (spec.industries?.length) { fit.push(leaf("basic_info.industries", "in", spec.industries)); fitText.push(`industry ${spec.industries.join("/")}`); fitNames.push("industry"); }
  if (spec.growth !== undefined) { fit.push(leaf("headcount.growth_percent.12m", ">", spec.growth)); fitText.push(`grew more than ${spec.growth}% in 12 months`); fitNames.push("growth"); }

  const rounds: Round[] = [{ name: "Round 1: the sentence plus size and place", filters: base.length ? and(...base) : undefined, describe: baseText }];
  if (funding.length) rounds.push({ name: "Round 2: plus funding", filters: and(...base, ...funding), describe: [...baseText, ...fundingText] });
  if (fit.length) rounds.push({ name: `Round ${rounds.length + 1}: plus ${fitNames.join(" and ")}`, filters: and(...base, ...funding, ...fit), describe: [...baseText, ...fundingText, ...fitText] });
  return rounds;
}

/** Why a company from an earlier round is not in a later one. Size, place and exclusions are in every round, so they never drop anyone. */
export function whyDropped(c: Company, spec: IcpSpec): string {
  const reasons: string[] = [];
  if (spec.raised?.length && !spec.raised.includes(c.funding?.last_round_type ?? "")) reasons.push(`last round ${c.funding?.last_round_type || "unknown"}`);
  if (spec.since && !((c.funding?.last_fundraise_date ?? "") >= spec.since)) reasons.push(`last raise ${c.funding?.last_fundraise_date || "unknown"}`);
  if (spec.investors?.length && !c.funding?.investors?.some(i => spec.investors!.includes(i))) reasons.push(`not backed by ${spec.investors.join("/")}`);
  if (spec.industries?.length && !c.taxonomy?.professional_network_industries?.some(i => spec.industries!.includes(i))) reasons.push("industry");
  const g = c.headcount?.growth_percent?.["12m"];
  if (spec.growth !== undefined && !(typeof g === "number" && g > spec.growth)) reasons.push(`12m growth ${typeof g === "number" ? Math.round(g) + "%" : "unknown"}`);
  return reasons.join(", ") || "ranked lower once the filters changed the candidate pool";
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Titles that mean the same thing. A search for one finds the others, and the rank treats them alike. */
const TITLE_SYNONYMS: string[][] = [
  ["CEO", "Chief Executive Officer"], ["CTO", "Chief Technology Officer", "Chief Technical Officer"], ["CFO", "Chief Financial Officer"],
  ["COO", "Chief Operating Officer"], ["CMO", "Chief Marketing Officer"], ["CRO", "Chief Revenue Officer"], ["CPO", "Chief Product Officer"],
  ["CIO", "Chief Information Officer"], ["CISO", "Chief Information Security Officer"], ["CHRO", "Chief Human Resources Officer", "Chief People Officer"],
];
export function titleVariants(title: string): string[] {
  const t = title.trim();
  const group = TITLE_SYNONYMS.find(g => g.some(x => x.toLowerCase() === t.toLowerCase()));
  if (group) return group;
  const vp = /^(?:([SE])?VP|(Senior|Executive)?\s*Vice President)(?:\s+of)?\s+(.+)$/i.exec(t);
  if (vp) {
    const level = (vp[1] ?? vp[2] ?? "").toLowerCase()[0];
    const short = level === "s" ? "SVP" : level === "e" ? "EVP" : "VP";
    const long = level === "s" ? "Senior Vice President" : level === "e" ? "Executive Vice President" : "Vice President";
    return [`${short} ${vp[3]}`, `${short} of ${vp[3]}`, `${long} ${vp[3]}`, `${long} of ${vp[3]}`];
  }
  return [t];
}

/**
 * Short all-caps titles (CEO, CTO, VP) use the exact-word operator [.]: the fuzzy (.) tolerates typos and would let
 * "CTO" match "CFO". Longer titles use (.) so "Head of Engineering" also catches "Head of Platform Engineering".
 * Each title becomes an "or" of its synonyms.
 */
export const titleLeaf = (title: string): Filter => {
  const leaves = titleVariants(title).map(t => leaf("experience.employment_details.current.title", /^[A-Z&]{2,5}$/.test(t) ? "[.]" : "(.)", t));
  return leaves.length === 1 ? leaves[0] : or(...leaves);
};

/**
 * Buyers at the given companies. "titles" mode uses your titles and seniority (both must hold); "fallback" takes the
 * most senior people, whatever their title. --min-connections, when set, drops placeholder and abandoned profiles; it
 * is a premium filter, so it adds to the price of every person returned.
 */
export function peopleFilters(companyIds: number[], spec: IcpSpec, mode: "titles" | "fallback"): Filter {
  const seniority = mode === "fallback" ? FALLBACK_SENIORITY : spec.seniority;
  return and(
    leaf("experience.employment_details.current.company_id", "in", companyIds),
    mode === "titles" && spec.titles?.length ? or(...spec.titles.map(titleLeaf)) : undefined,
    seniority?.length ? leaf("experience.employment_details.current.seniority_level", "in", seniority) : undefined,
    spec.minConnections ? leaf("professional_network.connections", "=>", spec.minConnections) : undefined,
  );
}

/**
 * Advisors, investors and interns are dropped by looking at the role held at the account. A search-side negation
 * would drop founders who are also angel investors somewhere else, because it tests every current role.
 */
export const isSideRole = (title: string): boolean => /\b(advisor|adviser|investor|intern|board member|assistant to)\b/i.test(title);

/** "VP Sales" must not match inside "Senior Vice President Sales" or "Associate VP Sales": those are other levels. */
const NOT_A_PLAIN_VP = String.raw`(?<!\b(?:senior|executive|associate|assistant|deputy)\s)`;
/** A whole-word match in which any run of spaces or punctuation between the words counts as one space. */
const wordRe = (k: string) => new RegExp(`(^|[^a-z])${/^(?:VP|Vice President)\b/i.test(k) ? NOT_A_PLAIN_VP : ""}${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}([^a-z]|$)`, "i");
/** "VP, Engineering", "VP - Engineering" and "Vice President (Engineering)" all read as "VP Engineering". Applied to both sides. */
const plainTitle = (title: string) => title.replace(/[,\/|()\-]+/g, " ").replace(/\s+/g, " ").trim();

/** Which of your titles (or their synonyms) a title at the account matches; -1 when none. The search matches any current role, so this re-checks the one that counts. */
export const titleIndex = (title: string, titles: string[] = []): number => {
  const plain = plainTitle(title);
  return titles.findIndex(k => titleVariants(k).some(v => wordRe(plainTitle(v)).test(plain)));
};

/** Lower is better: the position of the first of your titles the person's title contains, then seniority. */
export function personRank(title: string, seniority: string, titles: string[] = []): number {
  const t = titleIndex(title, titles);
  const s = SENIORITY.indexOf(seniority);
  return (t < 0 ? titles.length : t) * 100 + (s < 0 ? SENIORITY.length : s);
}

/**
 * What a run can bill, before it runs. Search is billed per result: 0.03 base, plus the extra data fields, which are
 * free on some plans and about 0.8 per company and 0.2 per person at list price.
 */
export function estimateCost(spec: IcpSpec, rounds: number): string {
  const companies = spec.limit * rounds;
  const people = Math.round(spec.limit * spec.perCompany * 3);
  const companyListPrice = 0.83 + (spec.tech?.length ? 1 : 0);
  const personListPrice = 0.23 + (spec.minConnections ? 0.2 : 0);
  const low = 0.03 * (companies + people);
  const high = companyListPrice * companies + personListPrice * people;
  const round = (n: number) => (n < 10 ? Math.round(n * 10) / 10 : Math.round(n));
  return `up to ${companies} company results and about ${people} person results: about ${round(low)} credits on plans that include the extra data fields, up to ${round(high)} at list price`;
}

// ---------------------------------------------------------------------------
// icp.json (next to the CSVs): the spec plus the exact filters of the final round, so later runs and readers see the
// same query.
// ---------------------------------------------------------------------------

type SavedIcp = { spec: IcpSpec; filters: Filter | undefined; savedAt: string };

export const loadIcp = (): SavedIcp | undefined => (existsSync(icpPath()) ? (JSON.parse(readFileSync(icpPath(), "utf8")) as SavedIcp) : undefined);

export function saveIcp(spec: IcpSpec, filters: Filter | undefined) {
  writeFileSync(icpPath(), JSON.stringify({ spec, filters, savedAt: new Date().toISOString() }, null, 2) + "\n");
}

export function describeSpec(spec: IcpSpec): string {
  const lines = [
    `  query:       ${spec.query}`,
    spec.size && `  size:        ${spec.size[1] < NO_UPPER_BOUND ? `${spec.size[0]} to ${spec.size[1]}` : `${spec.size[0]}+`} people${spec.size[0] === DEFAULT_MIN_SIZE && spec.size[1] === NO_UPPER_BOUND ? " (default floor; --size none to remove)" : ""}`,
    spec.near && `  near:        within ${spec.near.km} km of ${spec.near.location}`,
    spec.states?.length && `  state:       ${spec.states.join(", ")}`,
    spec.countries?.length && !spec.states?.length && !spec.near && `  country:     ${spec.countries.join(", ")}`,
    spec.raised?.length && `  raised:      ${spec.raised.join(", ")}`,
    spec.since && `  since:       ${spec.since}`,
    spec.investors?.length && `  investors:   ${spec.investors.join(", ")}`,
    spec.tech?.length && `  uses:        ${spec.tech.join(", ")} (technographics filter, 1 extra credit per company result at list price)`,
    spec.industries?.length && `  industry:    ${spec.industries.join(", ")}`,
    spec.growth !== undefined && `  growth:      more than ${spec.growth}% in 12 months`,
    spec.exclude?.length && `  exclude:     ${spec.exclude.join(", ")}`,
    spec.titles?.length && `  titles:      ${spec.titles.join(", ")}`,
    spec.seniority?.length && `  seniority:   ${spec.seniority.join(", ")}${spec.titles?.length ? " (and one of the titles)" : ""}`,
    `  accounts:    up to ${spec.limit}, ${spec.perCompany} ${spec.perCompany === 1 ? "person" : "people"} each${spec.fallback === false ? ", no fallback to senior people" : ""}`,
    spec.minConnections && `  people:      at least ${spec.minConnections} connections`,
  ];
  return lines.filter(Boolean).join("\n");
}
