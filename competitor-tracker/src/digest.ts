/**
 * The digest as markdown: one heading per competitor, six sections under it, one line per item with its source link.
 * Launches and money first, then customers, hiring, headcount and posts. Pure functions, no I/O.
 */

import type { CompetitorDigest, Digest, Item, Section, SectionResult } from "./types.js";
import { SECTIONS, SECTION_TITLES, capitalise, sentence, shortDate } from "./types.js";

export const FIRST_RUN_NOTE = "First digest: posts, hiring, funding and news cover the last 7 days; website changes count from the starting point saved by npm run init.";

export const QUIET: Record<Section, string> = {
  launches: "nothing new on the pages we watch",
  money: "nothing new this week",
  customers: "no new logos or case studies",
  hiring: "no new postings",
  headcount: "no meaningful move",
  posts: "no announcements",
};

/** Items in a stable, readable order: dated items newest first, undated ones after, duplicates by text dropped. */
export function orderItems(items: Item[]): Item[] {
  const seen = new Set<string>();
  return [...items]
    .filter(i => (seen.has(i.text) ? false : (seen.add(i.text), true)))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

const mdEscape = (s: string) => s.replace(/([*_`[\]<>])/g, "\\$1");
const pct = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
/** An http(s) URL safe inside a markdown link, or nothing (very long URLs are dropped rather than risk the layout). */
const safeUrl = (u?: string) => (u && /^https?:\/\//i.test(u) && u.length <= 1_000 ? u.replace(/[()\s<>\[\]]/g, pct) : undefined);

/** One line: what changed (with its date), why it matters, source. */
export function itemLine(i: Item): string {
  const url = safeUrl(i.url);
  const date = shortDate(i.date, i.text);
  const what = sentence(`${mdEscape(i.text)}${date ? ` (${date})` : ""}`);
  const why = i.why ? ` ${sentence(capitalise(mdEscape(i.why)))}` : "";
  return `- ${what}${why}${url ? ` [${mdEscape(i.linkLabel ?? "source")}](${url})` : ""}`;
}

export function sectionMarkdown(section: Section, r: SectionResult): string {
  const items = orderItems(r.items);
  if (!items.length) return `**${SECTION_TITLES[section]}:** ${sentence(capitalise(mdEscape(r.note ?? QUIET[section])))}`;
  const lines = [`**${SECTION_TITLES[section]}**`, ...items.map(itemLine)];
  if (r.note) lines.push(`- _${mdEscape(r.note)}_`);
  return lines.join("\n");
}

/** Nothing to report and nothing to explain (an account-wide note, such as Posts being off, does not count). */
export const isQuiet = (c: CompetitorDigest): boolean => SECTIONS.every(s => !c.sections[s].items.length && (!c.sections[s].note || c.sections[s].accountWide));

export function competitorMarkdown(c: CompetitorDigest): string {
  const head = `## ${mdEscape(c.name)} (${c.domain})`;
  // A competitor with nothing anywhere (and nothing to explain) gets one line instead of six.
  if (isQuiet(c)) return `${head}\n\nNothing new in any section this week.`;
  return [head, "", SECTIONS.map(s => sectionMarkdown(s, c.sections[s])).join("\n\n")].join("\n");
}

/** How many items the whole digest carries. */
export const itemCount = (d: Digest): number => d.competitors.reduce((n, c) => n + SECTIONS.reduce((m, s) => m + c.sections[s].items.length, 0), 0);

/** "Competitor digest, Oct 19 to Oct 26, 2026". */
export function digestTitle(d: Digest): string {
  const fmt = (iso: string, year: boolean) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
  return `Competitor digest, ${fmt(d.from, false)} to ${fmt(d.to, true)}`;
}

/** One line on what the run cost: its own calls, plus what the watchers billed for what they caught. */
export function creditsLine(d: Digest): string {
  const round = (n: number) => Math.round(n * 100) / 100;
  if (!d.creditsUsed && !d.watcherCredits) return "No credits used this run.";
  return `Credits: ${round(d.creditsUsed)} for this run's pages and searches${d.watcherCredits ? `, plus ${round(d.watcherCredits)} billed by the watchers for what they caught` : ""}.`;
}

export function digestMarkdown(d: Digest): string {
  const n = itemCount(d);
  const head = [
    `# ${digestTitle(d)}`,
    "",
    `${d.competitors.length} competitor${d.competitors.length === 1 ? "" : "s"}, ${n} item${n === 1 ? "" : "s"}.${d.firstRun ? ` ${FIRST_RUN_NOTE}` : ""}`,
    ...(d.notices ?? []).flatMap(x => ["", `_${mdEscape(x)}_`]),
  ];
  const body = d.competitors.map(competitorMarkdown);
  const foot = [
    "---",
    `${creditsLine(d)} Headcount lines, and funding lines without a link, are Crustdata company data. News lines come from a web search limited to this period. Data from [Crustdata](https://crustdata.com). Built with [competitor-tracker](https://github.com/crustdata/tools/tree/main/competitor-tracker).`,
  ];
  if (d.warnings.length) foot.unshift("", "**Warnings**", ...d.warnings.map(w => `- ${mdEscape(w)}`), "");
  return [...head, "", ...body.flatMap(b => [b, ""]), ...foot].join("\n") + "\n";
}

/** Competitors with any item first, most items first, then the quiet ones alphabetically. */
export function orderCompetitors(list: CompetitorDigest[]): CompetitorDigest[] {
  const count = (c: CompetitorDigest) => SECTIONS.reduce((m, s) => m + c.sections[s].items.length, 0);
  return [...list].sort((a, b) => count(b) - count(a) || a.name.localeCompare(b.name));
}
