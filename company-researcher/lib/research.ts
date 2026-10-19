// The core. The web UI, the JSON endpoint and the CLI all call these functions.
//
//   domain or name ─> /company/identify (free) ─> crustdata_company_id
//                 ├─> /company/enrich  one call, every field group  (2 credits, +2 tech stack, +5 recent posts)
//                 └─> /job/search      x3 in parallel               (about 0.45 credits)
//             └─> brief: written from the data by a template (lib/brief.ts), or with a visitor's AI key by the model
//                 from the same data (lib/ai.ts)
//
// Results are cached in memory per key and company for 24 hours (CACHE_TTL_HOURS), so a page reload costs nothing.

import { createHash } from "node:crypto";
import { ADDON_GROUPS, CrustdataError, ENRICH_GROUPS, enrichCompany, identifyCompany, searchJobs, withApiKey } from "./crustdata";
import { shapeCompany, shapeHiring, shapePeople } from "./shape";
import { buildBrief } from "./brief";
import { aiBrief } from "./ai";
import { SCHEMA_VERSION } from "./types";
import type { Brief, Company, CompanySection, Credits, Hiring, HiringSection, People, Research, SectionError } from "./types";

export class NotFoundError extends Error {}
export class InputError extends Error {}
// The demo key has spent today's budget (DAILY_CREDIT_CAP). The visitor can carry on with their own key.
export class BudgetError extends Error {}

// apiKey: a visitor's own Crustdata key. Without it the server's CRUSTDATA_API_KEY is used.
// aiKey: a visitor's own Anthropic or OpenAI key; with it the model writes the brief from the data.
export type Options = { lite?: boolean; apiKey?: string; aiKey?: string };

// Results are cached per key, so one person's key never serves another person's research.
const keyId = (opts?: Options) => (opts?.apiKey ? createHash("sha256").update(opts.apiKey).digest("hex").slice(0, 16) : "server");

export function isLite(opts?: Options) {
  return opts?.lite ?? process.env.RESEARCH_LITE === "true";
}

// "https://www.Stripe.com/pricing" -> "stripe.com"
export function normalizeDomain(input: string): string {
  const d = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].split(":")[0];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new InputError(`"${input.trim()}" is not a domain. Try something like stripe.com, or type the company's name.`);
  return d;
}

// A domain ("stripe.com", "https://www.stripe.com/pricing") or a company name ("Stripe", "Clay Labs").
export function parseQuery(input: string): { domain: string } | { name: string } {
  const t = input.trim();
  if (!t) throw new InputError("Type a company domain or name, for example stripe.com");
  if (t.length > 200) throw new InputError("That is too long for a company domain or name.");
  if (/[./]/.test(t) && !/\s/.test(t)) return { domain: normalizeDomain(t) };
  if (/^[\p{L}\p{N}&'., -]+$/u.test(t)) return { name: t.replace(/\s+/g, " ") };
  throw new InputError(`"${t}" is not a domain or a company name.`);
}

// ---------- cache ----------
// A Map with a time to live and a size cap; expired entries are swept on every write, so memory stays bounded.

const ttlMs = () => Number(process.env.CACHE_TTL_HOURS || 24) * 3600_000;
const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 500);
const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

function sweep(now: number) {
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

function peek<T>(key: string): Promise<T> | null {
  const hit = cache.get(key);
  return hit && hit.expires > Date.now() ? (hit.value as Promise<T>) : null;
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const existing = peek<T>(key);
  if (existing) return { value: await existing, hit: true };
  const now = Date.now();
  sweep(now);
  const value = load();
  cache.set(key, { expires: now + ttlMs(), value });
  value.catch(() => cache.delete(key)); // never cache a failure
  return { value: await value, hit: false };
}

const credits = (identify: number, enrich: number, jobs: number, cachedHit: boolean): Credits =>
  ({ identify, enrich, jobs, total: Math.round((identify + enrich + jobs) * 100) / 100, cached: cachedHit });

// ---------- the demo key's daily budget ----------
// When the server's own key pays (no visitor key), spending is capped per UTC day (DAILY_CREDIT_CAP, default 300).

const spend = { day: "", credits: 0 };
function checkBudget(opts?: Options) {
  if (opts?.apiKey) return;
  const today = new Date().toISOString().slice(0, 10);
  if (spend.day !== today) { spend.day = today; spend.credits = 0; }
  const cap = Number(process.env.DAILY_CREDIT_CAP || 300);
  if (spend.credits >= cap) throw new BudgetError("The free demo has used today's credits. Add your own Crustdata API key to keep going.");
}
function record(opts: Options | undefined, used: number) {
  if (!opts?.apiKey) spend.credits += used;
}

// ---------- steps ----------

export async function resolve(input: string, opts?: Options) {
  const query = parseQuery(input);
  const label = "domain" in query ? query.domain : query.name.toLowerCase();
  const { value } = await cached(`${keyId(opts)}:identify:${label}`, async () => {
    const r = await withApiKey(opts?.apiKey, () => identifyCompany(query));
    const domain = r.match?.company_data.basic_info?.primary_domain;
    if (!r.match || (!("domain" in query) && !domain)) throw new NotFoundError("domain" in query
      ? `No company found for ${query.domain}. Check the spelling, or type the company's name instead.`
      : `No company found named "${query.name}". Try its website domain, for example stripe.com.`);
    return { id: r.match.company_data.crustdata_company_id, name: r.match.company_data.basic_info?.name ?? label, domain: "domain" in query ? query.domain : domain!, credits: r.credits };
  });
  return value;
}

type EnrichValue = { companyData: any; credits: number; unavailable: string[]; fetchedAt: string };

export async function companySection(input: string, opts?: Options): Promise<CompanySection> {
  checkBudget(opts);
  const { domain, id, credits: idCredits } = await resolve(input, opts);
  const lite = isLite(opts);
  const fullKey = `${keyId(opts)}:enrich:${id}:full`;
  // Lite is a subset of full, so a cached full research also answers a lite request at no cost.
  const fromFull = lite ? peek<EnrichValue>(fullKey) : null;
  const groups = lite ? [...ENRICH_GROUPS] : [...ENRICH_GROUPS, ...ADDON_GROUPS];
  const { value, hit } = fromFull
    ? { value: await fromFull, hit: true }
    : await cached<EnrichValue>(lite ? `${keyId(opts)}:enrich:${id}:lite` : fullKey, async () => {
        const r = await withApiKey(opts?.apiKey, () => enrichCompany(id, groups));
        if (!r.companyData) throw new NotFoundError(`Crustdata returned no profile for ${domain}`);
        record(opts, r.credits + idCredits);
        return { ...r, fetchedAt: new Date().toISOString() };
      });
  const now = new Date();
  const company = shapeCompany(value.companyData, now);
  if (lite) { company.techStack = null; company.posts = []; }
  const people = shapePeople(value.companyData.people, id, company.founded, now, company.name);
  return {
    domain,
    fetchedAt: value.fetchedAt,
    company,
    people,
    unavailable: [...value.unavailable, ...(lite ? ADDON_GROUPS.map(g => `${g} (lite mode)`) : [])],
    credits: credits(hit ? 0 : idCredits, hit ? 0 : value.credits, 0, hit),
  };
}

export async function hiringSection(input: string, opts?: Options): Promise<HiringSection> {
  checkBudget(opts);
  const { domain, id } = await resolve(input, opts);
  const { value, hit } = await cached(`${keyId(opts)}:jobs:${id}`, async () => {
    const r = await withApiKey(opts?.apiKey, () => searchJobs(id));
    record(opts, r.credits);
    return { ...r, fetchedAt: new Date().toISOString() };
  });
  return { domain, fetchedAt: value.fetchedAt, hiring: shapeHiring(value), credits: credits(0, 0, hit ? 0 : value.credits, hit) };
}

// Everything at once: what GET /api/research and the CLI return. A section that fails is reported in `errors`
// instead of silently coming back empty, so an agent can tell "no jobs" from "the job search failed".
export async function research(input: string, opts?: Options): Promise<Research> {
  const errors: SectionError[] = [];
  const [c, h] = await Promise.all([
    companySection(input, opts),
    hiringSection(input, opts).catch(err => {
      errors.push({ section: "hiring", status: err instanceof CrustdataError ? err.status : null, message: (err as Error).message });
      return null;
    }),
  ]);
  const brief = await writeBrief({ company: c.company, people: c.people, hiring: h?.hiring ?? null }, opts?.aiKey);
  if (brief.aiError) errors.push({ section: "brief", status: null, message: brief.aiError });
  return {
    schemaVersion: SCHEMA_VERSION,
    domain: c.domain,
    generatedAt: new Date().toISOString(),
    fetchedAt: c.fetchedAt,
    company: c.company,
    people: c.people,
    hiring: h?.hiring ?? null,
    brief,
    unavailable: c.unavailable,
    errors,
    credits: credits(c.credits.identify, c.credits.enrich, h?.credits.jobs ?? 0, c.credits.cached && (h?.credits.cached ?? true)),
  };
}

// The template brief always; the AI brief on top when an AI key came with the request.
export async function writeBrief(facts: { company: Company; people: People; hiring: Hiring | null }, aiKey?: string): Promise<Brief> {
  const brief = buildBrief(facts);
  if (!aiKey) return brief;
  try {
    return { ...brief, ai: await aiBrief(aiKey, facts) };
  } catch (err) {
    return { ...brief, aiError: (err as Error).message };
  }
}
