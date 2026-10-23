/**
 * Website changes, from the HTML that Crustdata Web Fetch returns. Pure functions, no I/O.
 *
 * The unit of comparison is the visible text block (a heading, a paragraph, a list item), never the HTML, so a
 * rebuilt page with the same words is not a change. Navigation, scripts, styles and hidden elements are dropped
 * before the text is read; links are read from the whole page, normalised (no query string, no www, no trailing
 * slash), so a new navigation entry still counts as a new page but a tracking parameter does not.
 *
 * Every scan here is a single pass or bounded by a fixed window: pages are often 1 MB of HTML and may be malformed.
 */

import type { Item } from "./types.js";
import { clip } from "./types.js";

export type Link = { href: string; text: string };

export type Page = {
  url: string;
  domain: string;
  title: string;
  /** Visible text, one block per line. */
  text: string;
  /** Same-site and outside links, normalised. In storage, the union of the links seen over recent weeks. */
  links: Link[];
  /** Image alt texts that look like customer logos. */
  logos: string[];
  fetchedAt: string;
};

export type PageKind = "home" | "pricing" | "changelog" | "blog" | "customers" | "integrations" | "docs" | "other";

/** Pages a competitor site usually has, with the path words that identify each. One of each is tracked. */
export const PAGE_KINDS: { kind: PageKind; pattern: RegExp }[] = [
  { kind: "pricing", pattern: /\/(pricing|plans|plans-and-pricing)\/?$/i },
  { kind: "changelog", pattern: /\/(changelog|releases|release-notes|whats-new|what-s-new|updates|product-updates)\/?$/i },
  { kind: "blog", pattern: /\/(blog|news|articles|journal)\/?$/i },
  { kind: "customers", pattern: /\/(customers|case-studies|customer-stories|stories|success-stories|wall-of-love)\/?$/i },
  { kind: "integrations", pattern: /\/(integrations|marketplace|apps|app-marketplace|connectors)\/?$/i },
  { kind: "docs", pattern: /^\/(docs|documentation|developers|developer|api)\/?$/i },
];

const TRANSLATION_PATH = /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?)(?:\/|$)/i;
const ENGLISH_PATH = /^\/en(?:[-_][a-z]{2})?(?:\/|$)/i;
const LEGAL_PATH = /(terms|privacy|legal|cookie|gdpr|dpa|security|compliance|imprint|impressum|accessibility|sitemap)/i;
/** Text over this size is a directory or a feed, not a page worth comparing line by line. */
export const MAX_TEXT_CHARS = 400_000;
/** Links kept per page in storage (the union over recent weeks). */
export const MAX_STORED_LINKS = 3_000;

export function pageKind(url: string): PageKind {
  const path = pathOf(url).replace(/\/+$/, "") || "/";
  if (path === "/") return "home";
  return PAGE_KINDS.find(k => k.pattern.test(path))?.kind ?? "other";
}

/**
 * Same-site, non-legal pages worth tracking, one per kind, found in a homepage's links. Untranslated paths win;
 * an English-prefixed path (/en/pricing) is used only when there is no plain one. Other languages are never used.
 */
export function discoverPages(home: Page, max = 6): string[] {
  const host = hostOf(home.url);
  const picked = new Map<PageKind, string>();
  for (const pass of [0, 1]) {
    for (const { href } of home.links) {
      if (hostOf(href) !== host) continue;
      const path = pathOf(href);
      const translated = TRANSLATION_PATH.test(path);
      if (pass === 0 ? translated : !ENGLISH_PATH.test(path)) continue;
      if (LEGAL_PATH.test(path)) continue;
      const kind = pageKind(href);
      if (kind === "home" || kind === "other" || picked.has(kind)) continue;
      picked.set(kind, href);
    }
  }
  const order: PageKind[] = ["pricing", "changelog", "customers", "blog", "integrations", "docs"];
  return [home.url, ...order.map(k => picked.get(k)).filter((u): u is string => Boolean(u))].slice(0, max);
}

export const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
export const pathOf = (url: string): string => { try { return new URL(url).pathname; } catch { return ""; } };

/**
 * One form for every link: https, lowercase host without www, no query string or fragment, no trailing slash
 * (except the root). Rotating `?v=` or `utm_` parameters, http/https and www switches are then not "new pages".
 */
export function normalizeUrl(href: string, base?: string): string | null {
  let u: URL;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  return `https://${host}${path === "/" ? "/" : path}`;
}

// ---------------------------------------------------------------------------
// HTML to Page
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: ", ", ndash: ", ", hellip: "...", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', copy: "(c)", trade: "", reg: "", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×", bull: "•",
  middot: "·", deg: "°", plusmn: "±", frac12: "½", rarr: "→", larr: "←", laquo: "«", raquo: "»", szlig: "ß",
  eacute: "é", egrave: "è", ecirc: "ê", aacute: "á", agrave: "à", acirc: "â", iacute: "í", oacute: "ó", ocirc: "ô", uacute: "ú",
  ntilde: "ñ", ccedil: "ç", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", Eacute: "É",
};
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

const BLOCK = new Set("p div section article aside header footer nav main h1 h2 h3 h4 h5 h6 li ul ol tr td th table br hr blockquote pre figure figcaption dt dd dl form fieldset address summary details".split(" "));
/** Elements whose content is never visible text; nested elements of the same name are counted. */
const SKIP = new Set("head noscript svg template iframe canvas video audio object nav select".split(" "));
/** Inline elements: they join text without a space, as a browser shows them ("<span>$</span><span>29</span>" is "$29"). */
const INLINE = new Set("a abbr b bdi bdo cite code data dfn em i kbd mark q s samp small span strong sub sup time u var wbr font".split(" "));
/** Elements whose end tag may be left out: a new one of the same kind (or, for <p>, any block) ends the previous. */
const OPTIONAL_END: Record<string, Set<string>> = {
  li: new Set(["ul", "ol", "menu"]), p: new Set(["div", "section", "article", "aside", "main", "body"]), td: new Set(["tr", "table"]),
  th: new Set(["tr", "table"]), tr: new Set(["table", "tbody", "thead", "tfoot"]), dd: new Set(["dl"]), dt: new Set(["dl"]), option: new Set(["select"]),
};
/** Raw-text elements: their content is not markup (a "<script>" inside a script string is just text). */
const RAW = new Set(["script", "style", "textarea", "title", "xmp"]);
const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
/** Tags that start the page body, so a <head> left open (valid HTML) ends there. */
const BODY_START = new Set("body main header nav section article div p h1 h2 h3 h4 h5 h6 ul ol table form footer aside".split(" "));
/** The most a single tag may span; longer is not a tag but stray text, which keeps every scan bounded. */
const MAX_TAG = 2_048;

/** Attribute names and values of one tag (values unquoted), enough to tell a real `hidden` attribute from a class. */
export function parseAttrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}
const isHidden = (attrs: string): boolean => {
  if (!/hidden/i.test(attrs)) return false;
  const a = parseAttrs(attrs);
  return (a.has("hidden") && a.get("hidden")?.toLowerCase() !== "until-found") || a.get("aria-hidden")?.toLowerCase() === "true";
};

/** Past `MAX_TAG`, a tag may keep scanning quote-aware up to `LONG_TAG` (a big JSON attribute), within a per-page budget. */
const LONG_TAG = 65_536;
const LONG_TAG_BUDGET = 1_048_576;

/**
 * End of the tag that starts at `lt` (the index of its ">"), honouring quoted attribute values; -1 when it is not a tag.
 * A tag longer than `MAX_TAG` (a big srcset, inline style or JSON attribute) keeps scanning quote-aware up to
 * `LONG_TAG` while the page's budget lasts, then ends at the next ">", found once and remembered, so the scan stays
 * bounded even on a page full of stray "<".
 */
function tagEnd(html: string, lt: number, nextGt: (from: number) => number, budget: { left: number }): number {
  let quote = "";
  let limit = Math.min(html.length, lt + MAX_TAG);
  for (let k = lt + 1; k < limit; k++) {
    const ch = html[k];
    if (quote) { if (ch === quote) quote = ""; }
    else if (ch === '"' || ch === "'") { if (html[k - 1] === "=" || /\s/.test(html[k - 1] ?? "")) quote = ch; }
    else if (ch === ">") return k;
    else if (ch === "<") return -1;
    if (k === limit - 1 && limit < html.length && limit - lt < LONG_TAG && budget.left > 0) {
      const more = Math.min(LONG_TAG - (limit - lt), budget.left, html.length - limit);
      budget.left -= more;
      limit += more;
    }
  }
  return limit < html.length ? nextGt(limit) : -1;
}

/**
 * The visible text of an HTML document, one block per line, in one bounded scan. Skipped elements (navigation, svg,
 * hidden elements) are tracked by name and depth; raw-text elements (script, style) jump straight to their closing tag;
 * comments, doctypes and CDATA are dropped. An element that is never closed hides the rest of the page.
 */
export function visibleText(html: string): string {
  const out: string[] = [];
  let pos = 0;
  let textFrom = 0;
  let skip: { name: string; depth: number; inner: number } | null = null;
  const budget = { left: LONG_TAG_BUDGET };
  const flush = (to: number) => { if (!skip && to > textFrom) out.push(html.slice(textFrom, to)); };
  let gtCache = -2;
  const nextGt = (from: number): number => {
    if (gtCache === -1 || gtCache >= from) return gtCache;
    gtCache = html.indexOf(">", from);
    return gtCache;
  };
  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) break;
    const next = html[lt + 1] ?? "";
    // Comments, doctype, CDATA, processing instructions.
    if (next === "!" || next === "?") {
      const close = html.startsWith("<!--", lt) ? html.indexOf("-->", lt + 4) : html.startsWith("<![CDATA[", lt) ? html.indexOf("]]>", lt) : html.indexOf(">", lt);
      flush(lt);
      if (close < 0) { textFrom = pos = html.length; break; }
      pos = textFrom = close + (html.startsWith("<!--", lt) ? 3 : html.startsWith("<![CDATA[", lt) ? 3 : 1);
      continue;
    }
    if (!/[a-zA-Z/]/.test(next)) { pos = lt + 1; continue; } // a "<" in text, such as "a<b"
    const end = tagEnd(html, lt, nextGt, budget);
    if (end < 0) { pos = lt + 1; continue; }
    const body = html.slice(lt + 1, end);
    const closing = body[0] === "/";
    const nameMatch = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(body);
    if (!nameMatch) { pos = lt + 1; continue; }
    const name = nameMatch[1].toLowerCase();
    const attrs = body.slice(nameMatch[0].length);
    const selfClosing = /\/\s*$/.test(attrs);
    flush(lt);
    pos = textFrom = end + 1;

    // Raw text is never markup, inside a skipped element or not: jump to its closing tag.
    if (!closing && RAW.has(name)) {
      const closeRe = new RegExp(`</${name}\\s*>`, "ig");
      closeRe.lastIndex = pos;
      const m = closeRe.exec(html);
      pos = textFrom = m ? m.index + m[0].length : html.length;
      continue;
    }
    // A hidden <li> or <p> whose end tag was left out ends at the next one of its kind, or when its parent closes.
    // A list or table nested inside it is tracked, so its own <li> or </ul> does not end the hidden one.
    const optional: Set<string> | undefined = skip && skip.depth === 1 ? OPTIONAL_END[skip.name] : undefined;
    if (skip && optional && skip.inner > 0) {
      if (optional.has(name) && !selfClosing) skip.inner += closing ? -1 : 1;
      continue;
    }
    if (skip && optional && ((!closing && (name === skip.name || (skip.name === "p" && BLOCK.has(name)))) || (closing && optional.has(name)))) skip = null;
    else if (skip && optional && !closing && optional.has(name) && !selfClosing) { skip.inner++; continue; }
    if (skip) {
      if (skip.name === "head" && !closing && BODY_START.has(name)) { skip = null; } // <head> left open
      else {
        if (name === skip.name) {
          if (closing) skip.depth--;
          else if (!selfClosing) skip.depth++;
          if (skip.depth === 0) skip = null;
        }
        continue;
      }
    }
    if (!closing && !VOID.has(name) && !selfClosing && (SKIP.has(name) || isHidden(attrs))) {
      skip = { name, depth: 1, inner: 0 };
      continue;
    }
    out.push(BLOCK.has(name) ? "\n" : INLINE.has(name) ? "" : " ");
  }
  flush(html.length);
  const blocks = decodeEntities(out.join(""))
    .split("\n")
    .map(b => b.replace(/\s+/g, " ").trim())
    .filter(b => b.length >= 3);
  const seen = new Set<string>();
  return blocks.filter(b => (seen.has(b) ? false : (seen.add(b), true))).join("\n");
}

/** Turns one fetched page into the comparable shape. */
export function parsePage(url: string, domain: string, html: string, title: string | null | undefined, fetchedAt = new Date().toISOString()): Page {
  return {
    url,
    domain,
    title: decodeEntities(title ?? titleFromHtml(html) ?? "").replace(/\s+/g, " ").trim(),
    text: visibleText(html),
    links: extractLinks(html, url),
    logos: extractLogos(html),
    fetchedAt,
  };
}

const titleFromHtml = (html: string): string | undefined => {
  const start = html.search(/<title\b[^>]*>/i);
  if (start < 0) return undefined;
  const open = html.indexOf(">", start) + 1;
  const end = html.slice(open, open + 2_000).search(/<\/title\s*>/i);
  return end < 0 ? undefined : html.slice(open, open + end);
};

/** Links in the page, normalised and deduplicated, with their visible text (read from at most 3,000 characters). */
export function extractLinks(html: string, base: string): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  const re = /<a\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(html)) && guard++ < 20_000) {
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const raw = decodeEntities(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim();
    if (!raw || /^(javascript:|mailto:|tel:|#)/i.test(raw)) continue;
    const href = normalizeUrl(raw, base);
    if (!href || seen.has(href)) continue;
    const window = html.slice(re.lastIndex, re.lastIndex + 3_000);
    const close = window.search(/<\/a\s*>/i);
    const inner = close < 0 ? "" : window.slice(0, close);
    const text = decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    seen.add(href);
    out.push({ href, text: clip(text, 120) });
  }
  return out;
}

const LOGO_CONTEXT = /logo|customer|client|trusted|loved|teams at|used by|brands|companies/i;
/** True when the last logo-ish word before an image comes after the last closed section or list. File names in
 * src attributes do not count ("logo-slack.svg" on an integration icon says nothing about the next image). */
function inLogoSection(rawBefore: string): boolean {
  const before = rawBefore.replace(/\b(?:src|srcset|href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  let lastContext = -1;
  const re = new RegExp(LOGO_CONTEXT.source, "gi");
  for (let m = re.exec(before); m; m = re.exec(before)) lastContext = m.index;
  if (lastContext < 0) return false;
  const lastClose = Math.max(before.lastIndexOf("</section"), before.lastIndexOf("</ul"), before.lastIndexOf("</main"));
  return lastContext > lastClose;
}

/** A company name: short, at most 4 words, no sentence punctuation ("Monday.com" is fine, "Our team." is not). */
const looksLikeName = (s: string): boolean => Boolean(s) && s.length <= 40 && s.split(" ").length <= 4 && !/[!?:]|\.\s|\.$/.test(s);

/**
 * Alt texts of images that sit in a logo wall. The image's own class or id, or the section around it, must say
 * logos or customers; the file name is ignored (integration icons are often called "logo.svg" too).
 */
export function extractLogos(html: string): string[] {
  const out = new Set<string>();
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(html)) && guard++ < 5_000) {
    const tag = m[0];
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const text = decodeEntities(alt?.[1] ?? alt?.[2] ?? "").replace(/\s+logo$/i, "").replace(/\s+/g, " ").trim();
    if (!looksLikeName(text)) continue;
    const ownWords = tag.replace(/\b(?:src|srcset|alt)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "");
    if (!LOGO_CONTEXT.test(ownWords) && !inLogoSection(html.slice(Math.max(0, m.index - 600), m.index))) continue;
    out.add(text);
  }
  return [...out];
}

/** The currencies a page's price lines use ("$", "€", "£"), most used first. */
export function currencies(text: string): string[] {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!isPriceLine(line)) continue;
    for (const c of line.match(/[$€£]/g) ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/**
 * A page not to compare or save this week: a bot check, a page that came back nearly empty, or prices shown in a
 * different currency than last week (many pricing pages switch currency by visitor location, and the fetch does not
 * always come from the same place). Keeping last week's copy means the next normal fetch compares cleanly.
 */
export function looksBlocked(next: Page, prev?: Page): string | null {
  const probe = `${next.title}\n${next.text.slice(0, 3_000)}`;
  if (next.text.length < 3_000 && /just a moment|attention required|verify you are (a )?human|enable javascript and cookies|checking your browser|access denied|are you a robot|captcha/i.test(probe)) {
    return "the site showed a bot check instead of the page";
  }
  if (prev && prev.text.length > 1_000 && next.text.length < prev.text.length * 0.3) return "the page came back mostly empty";
  // A switch is when the main currency changed and most of last week's prices in it are gone. A new euro tier on a
  // dollar page is a change; a page that turned euro except for one fixed "$0.01 per request" line is a switch.
  const before = prev ? currencies(prev.text) : [];
  const after = currencies(next.text);
  if (before.length && after.length && before[0] !== after[0]) {
    const count = (text: string, c: string) => text.split("\n").filter(l => isPriceLine(l) && l.includes(c)).length;
    if (count(next.text, before[0]) < count(prev!.text, before[0]) / 2) return `prices came back in ${after[0]} instead of ${before[0]}, so this page was fetched as if from another country`;
  }
  return null;
}

/** Links to store: this week's plus last weeks', newest first, capped. A link that flickers in and out is not new. */
export function mergeLinks(next: Link[], prev: Link[] = []): Link[] {
  const seen = new Set<string>();
  const out: Link[] = [];
  for (const l of [...next, ...prev]) {
    if (seen.has(l.href)) continue;
    seen.add(l.href);
    out.push(l);
    if (out.length >= MAX_STORED_LINKS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparing two snapshots
// ---------------------------------------------------------------------------

export type PriceChange = { plan: string; from: string; to: string };

export type PageDiff = {
  kind: PageKind;
  addedBlocks: string[];
  removedBlocks: string[];
  newLinks: Link[];
  newLogos: string[];
  priceChanges: PriceChange[];
  newPriceLines: { plan: string; line: string }[];
  removedPriceLines: { plan: string; line: string }[];
  tooBig: boolean;
};

export function diffPages(prev: Page, next: Page): PageDiff {
  const kind = pageKind(next.url);
  const tooBig = next.text.length > MAX_TEXT_CHARS || prev.text.length > MAX_TEXT_CHARS;
  if (tooBig) return { kind, addedBlocks: [], removedBlocks: [], newLinks: [], newLogos: [], priceChanges: [], newPriceLines: [], removedPriceLines: [], tooBig };
  const before = new Set(prev.text.split("\n"));
  const after = new Set(next.text.split("\n"));
  const addedBlocks = [...after].filter(b => !before.has(b));
  const removedBlocks = [...before].filter(b => !after.has(b));
  const host = hostOf(next.url);
  const prevHrefs = new Set(prev.links.map(l => normalizeUrl(l.href) ?? l.href));
  const newLinks = next.links.filter(l => !prevHrefs.has(normalizeUrl(l.href) ?? l.href) && hostOf(l.href) === host);
  const prevLogos = new Set(prev.logos.map(l => l.toLowerCase()));
  const newLogos = next.logos.filter(l => !prevLogos.has(l.toLowerCase()));
  const { priceChanges, newPriceLines, removedPriceLines } = comparePrices(prev.text, next.text);
  return { kind, addedBlocks, removedBlocks, newLinks, newLogos, priceChanges, newPriceLines, removedPriceLines, tooBig };
}

const PRICE_LINE = /(?:[$€£]\s?\d|\d[\d,.]*\s?[km]?\s?(?:credits?|seats?|users?|contacts?|records?|rows?|emails?|requests?|calls?|lookups?|enrichments?)\b|\/\s?(?:mo|month|year|yr|user|seat)\b|per\s+(?:month|year|user|seat))/i;
/** Money or a per-period price: what makes a line a price outside the pricing page (not "Join 12,431 users"). */
const MONEY_LINE = /[$€£]\s?\d|\/\s?(?:mo|month|year|yr|user|seat)\b|per\s+(?:month|year|user|seat)/i;
const isPriceLine = (line: string): boolean => PRICE_LINE.test(line) && line.length <= 160;
/** A price line with its numbers blanked, so "10k credits" and "20k credits" are the same line with a changed figure. */
const priceKey = (line: string): string => line.replace(/[\d.,]+\s?[km]?\b/gi, "#").toLowerCase();

/** A plan name is a short heading ("Pro", "Business Plus"), not a sentence. */
const looksLikePlan = (line: string): boolean => line.length <= 30 && line.split(" ").length <= 4 && !/[,.!?:;]/.test(line);

/**
 * Price lines with the plan they sit under ("Pro" / "10k credits included"), so two tiers with the same line shape
 * are told apart. The plan is the nearest short, non-price block above the line.
 */
export function priceLines(text: string): { plan: string; line: string; key: string }[] {
  const out: { plan: string; line: string; key: string }[] = [];
  let plan = "";
  for (const line of text.split("\n")) {
    if (isPriceLine(line)) out.push({ plan, line, key: `${plan.toLowerCase()}|${priceKey(line)}` });
    else if (looksLikePlan(line)) plan = line;
  }
  return out;
}

/**
 * Price lines that changed, were added or were removed. Lines of the same shape under the same plan are paired by
 * position (a comparison table with "1,000 / 10,000 / 50,000 contacts" changes one cell, not all three). Under one
 * plan, a single line gone and a single line added are the same price reworded ("$29 per user per month" to
 * "$39/seat/mo"). Whatever is left is new or removed (a dropped free tier is a removal).
 */
export function comparePrices(prevText: string, nextText: string): { priceChanges: PriceChange[]; newPriceLines: { plan: string; line: string }[]; removedPriceLines: { plan: string; line: string }[] } {
  const prevAll = priceLines(prevText);
  const nextAll = priceLines(nextText);
  const prevSet = new Set(prevAll.map(l => `${l.plan}|${l.line}`));
  const nextSet = new Set(nextAll.map(l => `${l.plan}|${l.line}`));
  const gone = prevAll.filter(l => !nextSet.has(`${l.plan}|${l.line}`));
  const added = nextAll.filter(l => !prevSet.has(`${l.plan}|${l.line}`));
  const planOf = (plan: string) => (/^\d/.test(plan) ? "" : plan);
  const priceChanges: PriceChange[] = [];
  const usedGone = new Set<number>();
  const usedAdded = new Set<number>();
  // 1. Same shape under the same plan, by position.
  added.forEach((a, ai) => {
    const gi = gone.findIndex((g, k) => !usedGone.has(k) && g.key === a.key);
    if (gi >= 0) { usedGone.add(gi); usedAdded.add(ai); priceChanges.push({ plan: planOf(a.plan), from: gone[gi].line, to: a.line }); }
  });
  // 2. One line gone and one added under the same named plan: a reworded price.
  const plans = new Set(added.filter((_, ai) => !usedAdded.has(ai)).map(a => a.plan).filter(Boolean));
  for (const plan of plans) {
    const g = gone.map((x, k) => ({ x, k })).filter(({ x, k }) => !usedGone.has(k) && x.plan === plan);
    const a = added.map((x, k) => ({ x, k })).filter(({ x, k }) => !usedAdded.has(k) && x.plan === plan);
    if (g.length === 1 && a.length === 1) { usedGone.add(g[0].k); usedAdded.add(a[0].k); priceChanges.push({ plan: planOf(plan), from: g[0].x.line, to: a[0].x.line }); }
  }
  const newPriceLines = added.filter((_, ai) => !usedAdded.has(ai)).map(a => ({ plan: planOf(a.plan), line: a.line }));
  const removedPriceLines = gone.filter((_, gi) => !usedGone.has(gi)).map(g => ({ plan: planOf(g.plan), line: g.line }));
  return { priceChanges: priceChanges.slice(0, 8), newPriceLines: newPriceLines.slice(0, 5), removedPriceLines: removedPriceLines.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Turning diffs into digest items
// ---------------------------------------------------------------------------

const LAUNCH_WORDS = /\b(introducing|now available|new feature|launch(?:ed|ing)?|announcing|generally available|\bGA\b|beta|coming soon|new integration|now supports?)\b/i;
const CASE_STUDY = /(case stud|customer stor|success stor|how .{3,60} uses|story)/i;
const ENTRY_PATH = /\/(changelog|releases|release-notes|updates|blog|news|articles|journal|customers|case-studies|customer-stories|stories|integrations|marketplace|apps|docs|documentation)\/[^/]+/i;

const priceText = (c: PriceChange, max = 70) => `Pricing changed${c.plan ? ` (${clip(c.plan, 40)})` : ""}: "${clip(c.from, max)}" is now "${clip(c.to, max)}"`;

/** Launch items from one page's diff: new pages, launch wording, pricing changes, new changelog or blog entries. */
export function launchItems(diff: PageDiff, page: Page): Item[] {
  const items: Item[] = [];
  if (diff.tooBig) return items;
  const entries = diff.newLinks.filter(l => l.text && ENTRY_PATH.test(pathOf(l.href)) && !isTranslation(l.href));
  switch (diff.kind) {
    case "pricing":
      for (const c of diff.priceChanges) {
        const same = (c.from.match(/\d[\d,.]*/g) ?? []).join("|") === (c.to.match(/\d[\d,.]*/g) ?? []).join("|");
        items.push({ text: priceText(c), why: same ? "the wording changed; the figure is the same" : "a price or plan limit moved", url: page.url });
      }
      for (const l of diff.newPriceLines) items.push({ text: `New line on the pricing page${l.plan ? ` (${clip(l.plan, 40)})` : ""}: "${clip(l.line, 90)}"`, url: page.url });
      for (const l of diff.removedPriceLines) items.push({ text: `Removed from the pricing page${l.plan ? ` (${clip(l.plan, 40)})` : ""}: "${clip(l.line, 90)}"`, why: "a plan or price was taken away", url: page.url });
      break;
    case "changelog":
      for (const e of entries.slice(0, 5)) items.push({ text: `New changelog entry: ${clip(e.text, 90)}`, url: e.href });
      if (!entries.length) for (const b of diff.addedBlocks.filter(b => b.length > 20).slice(0, 3)) items.push({ text: `Changelog says: "${clip(b, 110)}"`, url: page.url });
      break;
    case "blog":
      for (const e of entries.filter(e => LAUNCH_WORDS.test(e.text)).slice(0, 5)) items.push({ text: `New blog post: ${clip(e.text, 90)}`, why: "announces something", url: e.href });
      break;
    case "integrations":
    case "docs":
      for (const e of entries.slice(0, 5)) items.push({ text: `New ${diff.kind === "docs" ? "docs" : "integration"} page: ${clip(e.text, 80)}`, url: e.href });
      break;
    case "customers":
      break;
    default: {
      // Home and other pages: new same-site pages linked from them, launch wording that appeared, and price lines
      // with money in them (a visitor counter is not a price).
      const newPages = diff.newLinks.filter(l => l.text && !ENTRY_PATH.test(pathOf(l.href)) && !isTranslation(l.href) && !LEGAL_PATH.test(pathOf(l.href)) && pathOf(l.href) !== "/").slice(0, 5);
      for (const l of newPages) items.push({ text: `New page linked from ${diff.kind === "home" ? "the homepage" : page.title || "a page"}: ${clip(l.text, 70)} (${pathOf(l.href)})`, url: l.href });
      for (const b of diff.addedBlocks.filter(b => LAUNCH_WORDS.test(b) && b.length >= 15).slice(0, 3)) items.push({ text: `${diff.kind === "home" ? "The homepage" : page.title ? clip(page.title, 40) : "A page"} now says: "${clip(b, 110)}"`, why: "new wording about a product or feature on their own site", url: page.url });
      for (const c of diff.priceChanges.filter(c => MONEY_LINE.test(c.from) && MONEY_LINE.test(c.to)).slice(0, 3)) items.push({ text: `${priceText({ ...c, plan: "" }, 60)} on ${page.title ? clip(page.title, 40) : "a page"}`, url: page.url });
    }
  }
  return items;
}

/** Customer items: new logos anywhere, new case studies on the customers page or the blog. */
export function customerItems(diff: PageDiff, page: Page): Item[] {
  const items: Item[] = [];
  if (diff.tooBig) return items;
  if (diff.newLogos.length) {
    const shown = diff.newLogos.slice(0, 6).join(", ");
    items.push({ text: `${diff.newLogos.length} new logo${diff.newLogos.length === 1 ? "" : "s"} on ${diff.kind === "home" ? "the homepage" : diff.kind === "customers" ? "the customers page" : page.title || "a page"}: ${shown}${diff.newLogos.length > 6 ? ", ..." : ""}`, url: page.url });
  }
  const studies = diff.newLinks.filter(l => l.text && !isTranslation(l.href) && (diff.kind === "customers" ? ENTRY_PATH.test(pathOf(l.href)) : CASE_STUDY.test(l.text) || /\/(case-stud|customer-stor|customers)\//i.test(pathOf(l.href))));
  for (const s of studies.slice(0, 5)) items.push({ text: `New case study: ${clip(s.text, 90)}`, url: s.href });
  return items;
}

const isTranslation = (url: string): boolean => TRANSLATION_PATH.test(pathOf(url)) && !ENGLISH_PATH.test(pathOf(url));
