/**
 * `competitors.json`: who you track, which of their pages to compare and which cities to break hiring down by.
 * Written by `npm run setup` and `npm run init`, safe to edit by hand. Example:
 *
 * {
 *   "competitors": [
 *     { "name": "Acme", "domain": "acme.com", "crustdata_company_id": 123, "pages": ["https://acme.com", "https://acme.com/pricing"] }
 *   ],
 *   "cities": ["London", "New York"]
 * }
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";

export type Competitor = {
  name: string;
  domain: string;
  crustdata_company_id?: number;
  /** Pages compared week to week, in priority order. Filled from the homepage navigation by `init`. */
  pages?: string[];
  /**
   * What they make, in a word or two ("CRM", "payments API"). Added to the news query and required in a result, so a
   * company called "Twenty" or "folk" does not pull in stories about the number or about folk music.
   */
  about?: string;
};

export type Competitors = { competitors: Competitor[]; cities: string[] };

/** Turns a URL, "www.acme.com" or "acme.com/x" into "acme.com". Returns null when it is not a domain at all. */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.endsWith(".local") || host === "localhost") return null;
  return host;
}

export const looksLikeDomain = (input: string): boolean => /\./.test(input.trim()) && !/\s/.test(input.trim()) && normalizeDomain(input) !== null;

export function loadCompetitors(file = config.competitorsFile): Competitors {
  if (!existsSync(file)) throw new Error(`No competitors file at ${file}. Run npm run setup first.`);
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (err) { throw new Error(`${file} is not valid JSON: ${(err as Error).message}`); }
  return validateCompetitors(parsed, file);
}

export function validateCompetitors(parsed: any, file = "competitors.json"): Competitors {
  if (!parsed || !Array.isArray(parsed.competitors)) throw new Error(`${file} must have a "competitors" array.`);
  if (parsed.competitors.length === 0) throw new Error(`${file} lists no competitors. Run npm run setup, or add one by hand (see competitors.example.json).`);
  if (parsed.competitors.length > 50) throw new Error(`${file} lists ${parsed.competitors.length} competitors; the tracker supports up to 50.`);
  const seen = new Set<string>();
  const competitors: Competitor[] = parsed.competitors.map((c: any, i: number) => {
    const domain = typeof c?.domain === "string" ? normalizeDomain(c.domain) : null;
    if (!domain) throw new Error(`${file}: competitor ${i + 1} needs a "domain" such as "acme.com".`);
    if (seen.has(domain)) throw new Error(`${file}: ${domain} is listed twice.`);
    seen.add(domain);
    const pages = Array.isArray(c.pages) ? c.pages.filter((p: unknown) => typeof p === "string" && /^https?:\/\//.test(p)).slice(0, 10) : undefined;
    const id = Number.isInteger(c.crustdata_company_id) ? c.crustdata_company_id : undefined;
    const about = typeof c.about === "string" && c.about.trim() ? c.about.trim().slice(0, 40) : undefined;
    return { name: typeof c.name === "string" && c.name.trim() ? c.name.trim() : domain, domain, crustdata_company_id: id, pages, ...(about ? { about } : {}) };
  });
  const cities = Array.isArray(parsed.cities) ? parsed.cities.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim()).slice(0, 50) : [];
  return { competitors, cities };
}

export function saveCompetitors(data: Competitors, file = config.competitorsFile): void {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Competitors that resolved to a Crustdata company (the others get website and news sections only). */
export const withId = (list: Competitor[]): (Competitor & { crustdata_company_id: number })[] =>
  list.filter((c): c is Competitor & { crustdata_company_id: number } => typeof c.crustdata_company_id === "number");

/** Product words a company description usually contains, most specific first. */
const CATEGORY_WORDS = [
  "CRM", "ATS", "ERP", "HRIS", "CDP", "CMS", "LMS", "POS", "VPN", "IDE", "BI", "ETL",
  "payroll", "payments", "invoicing", "accounting", "spreadsheet", "database", "analytics", "observability", "security",
  "email", "calendar", "chat", "video", "design", "website builder", "e-commerce", "ecommerce", "marketplace", "recruiting", "hiring",
  "scheduling", "helpdesk", "help desk", "customer support", "sales", "marketing", "project management", "note-taking", "notes",
  "API", "SDK", "AI", "app", "platform", "software",
];

/** A guess at what a company makes, from its description: the first product word it uses, or "software". */
export function deriveAbout(description: string | undefined): string {
  const d = description ?? "";
  if (/\b(salesforce|hubspot|pipedrive)\b/i.test(d) && !/\bCRM\b/.test(d)) return "CRM";
  for (const w of CATEGORY_WORDS) {
    const re = new RegExp(`(?<![A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, /^[A-Z]{2,}$/.test(w) ? "" : "i");
    if (re.test(d)) return w;
  }
  return "software";
}
