/**
 * Money and news: funding rounds, acquisitions, new investors and press, from the company watch's `changes` plus the
 * record it delivers, and from Crustdata Web Search news results. Pure functions, no I/O.
 */

import type { CompanyRecord } from "./headcount.js";
import type { NewsResult } from "./crustdata.js";
import type { Item } from "./types.js";
import { clip, isoDate, longDate } from "./types.js";

/** An ISO date moved by a number of days. */
const shiftDays = (iso: string, days: number): string => new Date(new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

export type Change =
  | { field: string; type: "changed"; from?: unknown; to?: unknown }
  | { field: string; type: "added"; new_elements?: unknown[] }
  | { field: string; type: string; [k: string]: unknown };

type Funding = {
  last_round_type?: string | null;
  last_round_amount_usd?: number | null;
  last_fundraise_date?: string | null;
  total_investment_usd?: number | null;
  investors?: string[] | null;
  acquisitions?: { acquiree_company_name?: string; announced_on_date?: string; transaction_text?: string }[] | null;
  acquired_by?: { acquirer_company_name?: string; announced_on_date?: string; transaction_text?: string }[] | null;
};

type NewsItem = { article_title?: string; article_url?: string; article_publish_date?: string; article_publisher_name?: string; publisher_domain?: string };

export const roundLabel = (t: string | null | undefined): string => (t ?? "a round").replace(/_/g, " ").replace(/\bseries ([a-z])\b/i, (_, l: string) => `Series ${l.toUpperCase()}`);

export function money(n: number | null | undefined): string | undefined {
  if (typeof n !== "number" || n <= 0) return undefined;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${n}`;
}

/**
 * A link for a funding event: a news article in the company record about raising or buying, dated within two weeks of
 * the event. Without one the line carries no link (the figure is Crustdata's company data, labelled as such).
 */
export function articleFor(record: CompanyRecord | undefined, date: string | null | undefined, words: RegExp): string | undefined {
  const news = ((record?.news ?? []) as NewsItem[]).filter(n => n?.article_url && n?.article_title && words.test(n.article_title));
  if (!date) return news[0]?.article_url;
  const t = new Date(date).getTime();
  return news.find(n => n.article_publish_date && Math.abs(new Date(n.article_publish_date).getTime() - t) <= 14 * 86_400_000)?.article_url;
}
const RAISE_WORDS = /\b(raises?|raised|funding|series [a-e]|seed|round|invest)/i;
const BUY_WORDS = /\b(acquires?|acquired|acquisition|buys|bought)/i;

/** Items from what the company watch said changed. Only funding and news changes; headcount is handled elsewhere. */
export function fundingItems(changes: Change[], record: CompanyRecord | undefined, since?: string): Item[] {
  const items: Item[] = [];
  const f = (record?.funding ?? {}) as Funding;
  for (const c of changes) {
    if (c.field === "funding.last_round_type" && c.type === "changed") {
      const amount = money(f.last_round_amount_usd);
      const url = articleFor(record, f.last_fundraise_date, RAISE_WORDS);
      const round = roundLabel(String((c as any).to ?? f.last_round_type));
      // A round dated well before this period is an older round newly added to the record, not this week's news.
      const old = since && f.last_fundraise_date && f.last_fundraise_date < shiftDays(since, -30);
      if (old) items.push({ text: `Crustdata now lists a ${round}${amount ? ` (${amount})` : ""} dated ${longDate(f.last_fundraise_date)}${url ? "" : ", from Crustdata funding data"}`, why: "an older round newly added to the record", url });
      else items.push({ text: `Raised ${round}${amount ? ` (${amount})` : ""}${f.last_fundraise_date ? ` on ${longDate(f.last_fundraise_date)}` : ""}${url ? "" : ", from Crustdata funding data"}`, why: "fresh money usually means a hiring and marketing push", url, date: isoDate(f.last_fundraise_date) });
    } else if (c.field === "funding.acquisitions" && c.type === "added") {
      for (const a of ((c as any).new_elements ?? []) as Funding["acquisitions"] & object) {
        const url = articleFor(record, a?.announced_on_date, BUY_WORDS);
        items.push({ text: `Acquired ${a?.acquiree_company_name ?? "a company"}${a?.announced_on_date ? `, announced ${longDate(a.announced_on_date)}` : ""}${url ? "" : ", from Crustdata funding data"}`, why: "a capability or a team they bought instead of built", url, date: isoDate(a?.announced_on_date) });
      }
    } else if (c.field === "funding.acquired_by" && c.type === "added") {
      for (const a of ((c as any).new_elements ?? []) as Funding["acquired_by"] & object) { const url = articleFor(record, a?.announced_on_date, BUY_WORDS); items.push({ text: `Acquired by ${a?.acquirer_company_name ?? "another company"}${a?.announced_on_date ? `, announced ${longDate(a.announced_on_date)}` : ""}${url ? "" : ", from Crustdata funding data"}`, url, date: isoDate(a?.announced_on_date) }); }
    } else if (c.field === "funding.investors" && c.type === "added") {
      const names = (((c as any).new_elements ?? []) as unknown[]).map(x => (typeof x === "string" ? x : (x as any)?.name)).filter(Boolean).slice(0, 4);
      if (names.length && !items.some(i => i.text.startsWith("Raised"))) items.push({ text: `New investor${names.length > 1 ? "s" : ""}: ${names.join(", ")}`, url: articleFor(record, undefined, RAISE_WORDS) });
    }
  }
  // News the watch delivered as new elements, limited to the period.
  const newsChange = changes.find(c => c.field === "news" && c.type === "added") as { new_elements?: NewsItem[] } | undefined;
  for (const n of (newsChange?.new_elements ?? []).filter(n => n?.article_url && n?.article_title && (!since || !n.article_publish_date || n.article_publish_date >= since)).slice(0, 4)) {
    items.push({ text: `In the news: "${clip(n.article_title!, 100)}" (${n.article_publisher_name ?? n.publisher_domain ?? "press"})`, url: n.article_url, date: isoDate(n.article_publish_date) });
  }
  return items;
}

/** Week-one items from the record alone: a round or acquisition dated inside the period. */
export function fundingBaselineItems(record: CompanyRecord | undefined, since: string): Item[] {
  const items: Item[] = [];
  const f = (record?.funding ?? {}) as Funding;
  if (f.last_fundraise_date && f.last_fundraise_date >= since) {
    const amount = money(f.last_round_amount_usd);
    const url = articleFor(record, f.last_fundraise_date, RAISE_WORDS);
    items.push({ text: `Raised ${roundLabel(f.last_round_type)}${amount ? ` (${amount})` : ""} on ${longDate(f.last_fundraise_date)}${url ? "" : ", from Crustdata funding data"}`, why: "fresh money usually means a hiring and marketing push", url, date: f.last_fundraise_date });
  }
  for (const a of (f.acquisitions ?? []).filter(a => a?.announced_on_date && a.announced_on_date >= since)) {
    const url = articleFor(record, a.announced_on_date, BUY_WORDS);
    items.push({ text: `Acquired ${a.acquiree_company_name ?? "a company"}, announced ${longDate(a.announced_on_date)}${url ? "" : ", from Crustdata funding data"}`, why: "a capability or a team they bought instead of built", url, date: a.announced_on_date });
  }
  for (const n of ((record?.news ?? []) as NewsItem[]).filter(n => n?.article_url && n?.article_title && n.article_publish_date && n.article_publish_date >= since).slice(0, 4)) {
    items.push({ text: `In the news: "${clip(n.article_title!, 100)}" (${n.article_publisher_name ?? n.publisher_domain ?? "press"})`, url: n.article_url, date: isoDate(n.article_publish_date) });
  }
  return items;
}

const LISTING_HOSTS = /(tracxn|crunchbase|pitchbook|cbinsights|zoominfo|glassdoor|indeed|g2\.com|capterra|trustradius|getapp|producthunt|rocketreach|apollo\.io|craft\.co|owler)/i;
/** Company-profile pages on data sites read like news in a search but are listings. */
const LISTING_TITLE = /(funding rounds|list of investors|company profile|competitors and alternatives|revenue, funding|employees, funding|org chart|overview, news & competitors)/i;
/** Roundups, comparisons, reviews and share-price stories name a competitor without being news about what it did. */
const NOT_NEWS_TITLE = /(?<![a-z])(top|best)\s+\d+|(?<![a-z])alternatives?(?![a-z])|(?<![a-z])vs\.?(?![a-z])|(?<![a-z])versus(?![a-z])|(?<![a-z])reviews?(?![a-z])|(?<![a-z])(stock|shares|share price)(?![a-z])/i;

/** The search query for one competitor's news: the name in quotes plus what they make. */
export const newsQuery = (c: { name: string; domain: string; about?: string }): string => `"${c.name}" ${c.about ?? c.domain}`;

/** Words that put a company name in a business story rather than a story about the word itself. */
const BUSINESS_WORDS = /(?<![A-Za-z])(founders?|co-?founders?|ceo|cto|cfo|startups?|raises|raised|funding|series [a-e]|seed round|acquires|acquired|acquisition|api|saas|revenue|arr|valuation|investors?|customers|open[- ]source|software|platform)(?![A-Za-z])/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Items from Web Search news results. A result counts when it mentions the competitor's website, or names the
 * competitor together with what they make. A capitalised name ("Attio") also counts next to a business word (founder,
 * raises, API...); a lowercase name ("folk") is usually an everyday word, so it needs the website or the product word.
 * Listing sites, duplicates and pages on the competitor's own site are dropped.
 */
export function newsItems(results: NewsResult[], c: { name: string; domain: string; about?: string }, max = 4): Item[] {
  const items: Item[] = [];
  const seen = new Set<string>();
  const nameRe = new RegExp(`(?<![A-Za-z0-9])${escapeRe(c.name)}(?![A-Za-z0-9-])`, /[A-Z]/.test(c.name) ? "" : "i");
  const aboutRe = c.about ? new RegExp(`(?<![A-Za-z])${escapeRe(c.about)}(?![A-Za-z])`, "i") : null;
  const domainRe = new RegExp(`(?<![A-Za-z0-9-])${escapeRe(c.domain)}(?![A-Za-z0-9-])`, "i");
  for (const r of results) {
    let host = "";
    try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch { continue; }
    if (LISTING_HOSTS.test(host) || LISTING_TITLE.test(r.title) || NOT_NEWS_TITLE.test(r.title) || host === c.domain || host.endsWith(`.${c.domain}`) || seen.has(r.url)) continue;
    const text = `${r.title} ${r.snippet ?? ""}`;
    const named = nameRe.test(text);
    const capitalised = /^[A-Z]/.test(c.name);
    // A name of one or two characters ("X") matches too much: only the website counts for those.
    const shortName = c.name.replace(/[^A-Za-z0-9]/g, "").length <= 2;
    const relevant = domainRe.test(text) || (!shortName && named && ((aboutRe?.test(text) ?? !aboutRe) || (capitalised && BUSINESS_WORDS.test(text))));
    if (!relevant) continue;
    seen.add(r.url);
    items.push({ text: `In the news: "${clip(r.title, 100)}" (${host})`, url: r.url });
    if (items.length >= max) break;
  }
  return items;
}
