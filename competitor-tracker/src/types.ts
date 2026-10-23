/** The digest model: what every signal module produces and what every output (markdown, Slack, email) renders. */

export type Item = {
  /** What changed, one line, quoting the source where a number is involved. */
  text: string;
  /** Why it matters, optional, one short clause. */
  why?: string;
  /** Source link. Every item that comes from a page, post, job or article has one. */
  url?: string;
  /** ISO date of the source when known (post date, article date). */
  date?: string;
  /** Text of the link, "source" by default ("one of them" when the line covers many postings). */
  linkLabel?: string;
};

export const SECTIONS = ["launches", "money", "customers", "hiring", "headcount", "posts"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_TITLES: Record<Section, string> = {
  launches: "Launches",
  money: "Money and news",
  customers: "Customers",
  hiring: "Hiring",
  headcount: "Headcount",
  posts: "Posts",
};

export type SectionResult = {
  items: Item[];
  /** Shown instead of items when there are none, or under them as a caveat. */
  note?: string;
  /** The note is about the whole account (posts off), said once at the top: a competitor with only this is quiet. */
  accountWide?: boolean;
};

export type CompetitorDigest = {
  name: string;
  domain: string;
  sections: Record<Section, SectionResult>;
};

export type Digest = {
  week: string;
  /** Period covered, ISO dates. */
  from: string;
  to: string;
  firstRun: boolean;
  competitors: CompetitorDigest[];
  /** Credits this run spent on its own calls (pages, news, searches), from the API's x-credits-used header. */
  creditsUsed: number;
  /** Credits the watchers billed for the runs this digest read (what they caught since the last digest). */
  watcherCredits: number;
  warnings: string[];
  /** Account-wide notes shown once at the top (for example Posts being off). */
  notices?: string[];
};

export const emptySections = (): Record<Section, SectionResult> =>
  Object.fromEntries(SECTIONS.map(s => [s, { items: [] as Item[] }])) as unknown as Record<Section, SectionResult>;

/** Shortens text to `max` characters on a word boundary, with a single ellipsis character. */
export function clip(s: string, max = 140): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 30))}…`;
}

export const isoDate = (d: Date | string | number | undefined | null): string | undefined => {
  if (d === undefined || d === null || d === "") return undefined;
  const t = new Date(d);
  return isNaN(t.getTime()) ? undefined : t.toISOString().slice(0, 10);
};

/** Ends a sentence with a full stop unless it already ends in one (also inside a closing quote or bracket). */
export const sentence = (s: string): string => (/[.!?…]["'”)]?$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
export const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "Oct 21, 2026" from an ISO date (or the input unchanged when it is not a date). */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "Oct 22" style date for a line, unless the text already states that date. */
export function shortDate(date: string | undefined, text: string): string | undefined {
  if (!date || text.includes(date) || text.includes(longDate(date))) return undefined;
  const d = new Date(`${date}T00:00:00Z`);
  return isNaN(d.getTime()) ? undefined : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
