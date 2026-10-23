/**
 * Founders' posts: the phrases that count as traction or as round news, and how a post becomes a quote. Pure, no I/O.
 *
 * Checked live (Oct 2026): founders' own posts carry real traction ("$4K MRR, doubling monthly", "closed our seed
 * round"). Company page posts match the same words as product marketing ("MRR numbers didn't quite match"), so only
 * founders' posts are searched. Plain words such as "growth" are left out: they matched founders writing about their
 * market, not their company. Matching is an exact phrase, whole words, in any case (2 to 4 capital letters, like MRR,
 * must be in capitals). Add or remove phrases here.
 */

import type { Quote, RawPost } from "./types.js";

/**
 * Traction. Each phrase is about the company's own numbers: "we doubled" alone also matched "we doubled down on AI",
 * "profitable" matched "how to make your SaaS profitable", "new customers" matched "helps sales teams find new customers".
 */
export const TRACTION_PHRASES = [
  "MRR", "ARR", "our revenue", "revenue grew", "revenue doubled", "doubled our revenue", "paying customers",
  "we are profitable", "we're profitable", "became profitable",
];

/**
 * Round news. A post counts when it has one of the exact phrases, or an announcement phrase and a round phrase
 * together ("announcing our $12M Series A", "we just closed a $3M seed round"). Short phrases alone such as
 * "closed our" matched "closed our first enterprise customer", so they only count with a round phrase.
 */
export const RAISE_PHRASES = [
  "closed our seed", "closed our pre-seed", "closed our series", "raised our seed", "raised our pre-seed", "raised our series",
  "seed extension", "round was oversubscribed",
];
/** "We closed our first Series A customer" or "excited to announce I'm joining a Series A startup" are not round news, so the actions say "we" or "our". */
export const RAISE_ACTIONS = ["we raised", "we've raised", "we have raised", "we just raised", "just closed a", "raised our", "closed our", "announce our", "announcing our"];
export const RAISE_ROUNDS = ["our seed round", "our pre-seed round", "seed round", "pre-seed round", "series a", "series b", "series c", "funding round", "in funding"];

/** How far back founders' posts count. */
export const POST_WINDOW_MONTHS = 6;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole words, any case; short all-caps phrases (MRR, ARR) must be in capitals, so "Arr" in a sentence is not ARR. */
const phraseRe = (p: string) => new RegExp(String.raw`(^|[^A-Za-z0-9])${escape(p)}([^A-Za-z0-9]|$)`, /^[A-Z]{2,4}$/.test(p) ? "" : "i");
const first = (text: string, list: string[]) => list.find(p => phraseRe(p).test(text));

/** The phrase a text matches, round news first, and the phrase to quote around. */
export function matchPhrase(text: string): { phrase: string; kind: Quote["kind"] } | undefined {
  const exact = first(text, RAISE_PHRASES);
  if (exact) return { phrase: exact, kind: "raise" };
  const action = first(text, RAISE_ACTIONS), round = first(text, RAISE_ROUNDS);
  if (action && round) return { phrase: action, kind: "raise" };
  const traction = first(text, TRACTION_PHRASES);
  return traction ? { phrase: traction, kind: "traction" } : undefined;
}

/** The sentence around the phrase, at most `max` characters, on one line. */
export function snippet(text: string, phrase: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.search(phraseRe(phrase));
  if (at < 0) return flat.slice(0, max);
  // Sentence bounds: the last . ! ? before the phrase, the first after it.
  const start = Math.max(0, ...[".", "!", "?"].map(p => flat.lastIndexOf(p + " ", at) + 2).filter(i => i > 1));
  const ends = [".", "!", "?"].map(p => flat.indexOf(p, at + phrase.length)).filter(i => i >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : flat.length;
  let s = flat.slice(start, end);
  if (s.length > max) {
    const rel = Math.max(0, at - start - Math.floor(max / 3));
    s = (rel > 0 ? "..." : "") + s.slice(rel, rel + max - 6).trim() + "...";
  }
  return s;
}

export function toQuote(post: RawPost): Quote | undefined {
  const text = post.text ?? "";
  const hit = matchPhrase(text);
  if (!hit || !post.date_posted) return undefined;
  return {
    date: post.date_posted.slice(0, 10),
    author: post.actor?.name ?? "A founder",
    text: snippet(text, hit.phrase),
    url: post.share_url,
    phrase: hit.phrase,
    kind: hit.kind,
  };
}

/** YYYY-MM-DD, `months` before `today`. */
export function monthsAgo(today: Date, months: number): string {
  const d = new Date(today);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

export function daysAgo(today: Date, days: number): string {
  return new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}
