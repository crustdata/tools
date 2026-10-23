/**
 * Posts: keeps the posts in which a competitor announces something (a launch, a customer, a figure, a round) and drops
 * opinions, event promos, personal news and reshares. Works on records from the Crustdata Social Post Search API and
 * the Social Post Watcher, which share one shape. Pure functions, no I/O.
 *
 * The rule that matters most: a staff post counts only when it speaks for the company ("we", "our" or the company's
 * name in the quoted sentence). "Competitor X just raised a Series B" posted by someone at your competitor is about
 * X, not about them, and is dropped.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";
import type { Item } from "./types.js";
import { clip, isoDate } from "./types.js";

export type Keywords = { announce: string[]; customers: string[]; numbers: string[]; money: string[]; skip: string[] };

export function loadKeywords(file = resolve(ROOT, "config/post-keywords.json")): Keywords {
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch (err) { throw new Error(`${file} could not be read: ${(err as Error).message}`); }
  const list = (k: string): string[] => (Array.isArray(raw?.[k]) ? raw[k].filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim()) : []);
  const kw = { announce: list("announce"), customers: list("customers"), numbers: list("numbers"), money: list("money"), skip: list("skip") };
  if (!kw.announce.length && !kw.customers.length && !kw.numbers.length && !kw.money.length) throw new Error(`${file} has no keywords; the post watch would match nothing.`);
  return kw;
}

/** Every word the watch filter should match: the union of the four positive lists. */
export const watchKeywords = (kw: Keywords): string[] => [...new Set([...kw.announce, ...kw.customers, ...kw.numbers, ...kw.money])];

export type PostRecord = {
  text?: string | null;
  share_url?: string | null;
  date_posted?: string | null;
  post_type?: string | null;
  reposter?: unknown;
  parent_post_urn?: string | null;
  backend_urn?: string | null;
  entity_urn?: string | null;
  actor?: { actor_type?: string; name?: string; title?: string; company_name?: string; crustdata_entity_id?: number } | null;
};

export type PostKind = "launch" | "customer" | "number" | "money";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole words or phrases; a digit may come before ("$10M ARR" matches "M ARR"). */
const wordRe = (words: string[]) => (words.length ? new RegExp(`(?<![a-z])(?:${words.map(escapeRe).join("|")})(?:e?s)?(?![a-z0-9])`, "i") : /$^/);

/** A figure a reader would want quoted: money, a percentage, or a count (1,200 / 10k / 3 million). */
const FIGURE = /(?:[$€£]\s?\d[\d,.]*\s?(?:k|m|b|million|billion)?|\d[\d,.]*\s?%|\d{1,3}(?:,\d{3})+|\d[\d,.]*\s?(?:k|m|million|billion|thousand)\b)/i;
const FIRST_PERSON = /(?<![a-z'])(we|we're|we've|we'll|our|ours|us)(?![a-z'])/i;
const PERSONAL = /(?<![a-z'])(i|i'm|i've|my)(?![a-z'])/i;

/** Splits a post into sentences (line breaks count as sentence ends). "Inc.", "e.g." and "U.S." do not end one; "Series A." does. */
export const sentences = (text: string): string[] => text.replace(/\r/g, "").split(/(?<=[.!?])(?<!\b(?:Inc|Ltd|Corp|Co|vs|Mr|Ms|Dr|St|e\.g|i\.e)\.)(?<!\b[A-Z]\.[A-Z]\.)\s+|\n+/).map(s => s.replace(/\s+/g, " ").trim()).filter(s => s.length > 10);

/** The sentence of the post that carries the announcement: one with a keyword and a figure, else one with a keyword. */
export function keySentence(text: string, kw: Keywords): string {
  const any = wordRe(watchKeywords(kw));
  const list = sentences(text);
  return list.find(s => FIGURE.test(s) && any.test(s)) ?? list.find(s => any.test(s)) ?? list[0] ?? text.replace(/\s+/g, " ").trim();
}

/** Does the sentence speak for the competitor: "we", "our", or its name? */
function speaksForCompany(sentence: string, companyName?: string): boolean {
  if (FIRST_PERSON.test(sentence)) return true;
  return Boolean(companyName && new RegExp(`(?<![A-Za-z0-9])${escapeRe(companyName)}(?![A-Za-z0-9])`, "i").test(sentence));
}

const RAISE = /(?<![a-z])(raised|raises|raise|closed|closes|secured|secures|series [a-e]|seed round|funding round|acquired|acquires|acquisition of|been acquired|is joining)(?![a-z])/i;
/** A word that makes a "raised" or "closed" sentence about money ("we have raised the bar" is not a round). */
const FUNDING_WORD = /(series [a-e]|seed|round|funding|investors?|valuation|[$€£]\s?\d|\d\s?(?:m|million|bn|billion)\b|acquisition|acquired|acquires|bought|joining)/i;
const AMOUNT = String.raw`(?:[$€£]?\d[\d.,]*\s?(?:k|m|mn|b|bn|million|billion)?\s+)?`;
const ROUND = String.raw`(?:pre-seed|seed|series [a-e])`;

/**
 * The competitor's own round or deal: "we raised", "Northwind raises $40M", "Northwind, the AI CRM, has raised",
 * "our $40M Series B", "we acquired Tailspin", "our acquisition of Tailspin", "we've been acquired by Contoso".
 * Not: "we acquired 500 new customers".
 */
function ownMoney(s: string, name?: string): boolean {
  if (!FUNDING_WORD.test(s)) return false;
  const nameRe = name ? `${escapeRe(name)}(?:\\s*,[^,]{1,40},|\\s+inc\\.?|\\s+ai)?` : "(?!)";
  const subject = `(?:we|we've|we have|we just|we've just|${nameRe}(?:\\s+(?:has|have|just|has just))?)`;
  const verb = `(?:just\\s+)?(?:raised|raises|secured|secures)`;
  if (new RegExp(`(?<![a-z])${subject}\\s+${verb}\\b`, "i").test(s)) return true;
  // "closed" and "completed" need the deal right after them: "we closed our Series B", not "we closed 2025 with $10M ARR".
  const done = `(?:just\\s+)?(?:closed|closes|completed|completes)\\s+(?:\\S+\\s+){0,3}(?:round|series [a-e]|seed|pre-seed|funding|financing|acquisition)`;
  if (new RegExp(`(?<![a-z])${subject}\\s+${done}`, "i").test(s)) return true;
  if (new RegExp(`(?<![a-z])our\\s+(?:new\\s+)?${AMOUNT}${ROUND}(?![a-z])`, "i").test(s)) return true;
  if (/(?<![a-z])our\s+acquisition\s+of\b/i.test(s)) return true;
  if (new RegExp(`(?<![a-z])(?:we|${nameRe})(?:'ve|'re|\\s+(?:have|has|is|are|was|were))?\\s+(?:been\\s+|being\\s+)?(?:acquired\\s+by|joining)\\b`, "i").test(s)) return true;
  return new RegExp(`(?<![a-z])${subject}\\s+(?:just\\s+)?(?:acquired|acquires|bought)\\s+(?!\\d|\\w+\\s+(?:new\\s+)?(?:customers|users|clients|signups|leads))`, "i").test(s);
}

/** Someone else's round told by the competitor: "our customer Fabrikam just raised", "congrats to Acme on their Series A". */
function aboutSomeoneElsesMoney(s: string): boolean {
  if (/(?<![a-z])(?:our|their)\s+(?:customers?|partners?|clients?|friends?|portfolio\s+compan(?:y|ies))\b[^.]{0,60}\b(?:raised|raises|closed|closes|secured|acquired|acquires)\b/i.test(s)) return true;
  return /congrat/i.test(s) && !/(?<![a-z])(?:we|we've|our)\b[^.]{0,30}\b(?:raised|closed|secured|series|seed)/i.test(s);
}

/** Which kind of announcement a post is, or null when it is not one. `companyName` is the competitor's name. */
export function classifyPost(p: PostRecord, kw: Keywords, companyName?: string): PostKind | null {
  const text = (p.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 20) return null;
  if (p.reposter || (p.post_type && /repost|reshare/i.test(p.post_type))) return null;
  const key = keySentence(p.text ?? "", kw);
  if (wordRe(kw.skip).test(key)) return null;
  if (/\?\s*$/.test(key)) return null; // the quoted sentence is a question, not an announcement
  const company = p.actor?.actor_type === "company";
  const name = companyName ?? p.actor?.company_name ?? undefined;
  const ours = speaksForCompany(key, name);
  if (!company && !ours) return null; // staff writing about someone else, or about themselves
  if (!company && PERSONAL.test(key) && !FIRST_PERSON.test(key) && !(name && key.toLowerCase().includes(name.toLowerCase()))) return null;
  if (RAISE.test(key) && (wordRe(kw.money).test(key) || FUNDING_WORD.test(key))) {
    if (ownMoney(key, name)) return "money";
    if (aboutSomeoneElsesMoney(key)) return null;
    // A money word that is not the competitor's own round: judge the post on its other words.
  }
  if (wordRe(kw.numbers).test(key) && FIGURE.test(key)) return "number";
  // "we added 500 new customers", "Northwind now has 12,000 users": a growth figure in their own words.
  if (/\d[\d,.]*\s?(?:k|m|million|thousand)?\+?\s+(?:new\s+|paying\s+|active\s+)?(?:customers|users|clients|signups|sign-ups|teams|companies|developers)(?![a-z])/i.test(key) && (company || ours)) return "number";
  if (wordRe(kw.announce).test(key)) return "launch";
  if (wordRe(kw.customers).test(key)) return "customer";
  return null;
}

const WHY: Record<PostKind, string> = {
  launch: "they are telling customers about something new",
  customer: "a customer or partner they chose to name",
  number: "a growth or revenue figure in their own words",
  money: "funding or M&A they announced themselves; check the source before sharing",
};

/** Who posted, as the digest shows it: the title, plus the name only when `showNames` is on. */
export function posterLabel(p: PostRecord, showNames = false): string {
  if (p.actor?.actor_type === "company") return "Company page";
  const title = p.actor?.title ? clip(p.actor.title, 40) : "An employee";
  return showNames && p.actor?.name ? `${title} (${clip(p.actor.name, 40)})` : title;
}

/** Digest items for one competitor's posts, announcements only, newest first, at most `max`. */
export function postItems(posts: PostRecord[], kw: Keywords, { max = 6, companyName, showNames = false }: { max?: number; companyName?: string; showNames?: boolean } = {}): Item[] {
  const scored = posts
    .map(p => ({ p, kind: classifyPost(p, kw, companyName) }))
    .filter((x): x is { p: PostRecord; kind: PostKind } => x.kind !== null)
    .sort((a, b) => (b.p.date_posted ?? "").localeCompare(a.p.date_posted ?? ""));
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const { p, kind } of scored) {
    const key = p.share_url ?? p.backend_urn ?? p.entity_urn ?? (p.text ?? "").slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ text: `${posterLabel(p, showNames)} posted: "${clip(keySentence(p.text ?? "", kw), 140)}"`, why: WHY[kind], url: p.share_url ?? undefined, date: isoDate(p.date_posted) });
    if (items.length >= max) break;
  }
  return items;
}
