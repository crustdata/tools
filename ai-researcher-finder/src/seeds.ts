/**
 * Seeds: starting from the work instead of the profile. A seeds file (or --scholar, --github, --paper, --profile) can
 * hold Google Scholar profile URLs, GitHub profile URLs, profile URLs and paper titles, in any column of a CSV or one
 * per line in a text file. Each cell is sorted into one of those kinds here; nothing is sent anywhere. Pure, so it is
 * tested.
 */

import { parseCsvRows } from "./csv.js";

export type Seed =
  | { kind: "scholar"; value: string; raw: string }    // https://scholar.google.com/citations?user=<id>
  | { kind: "github"; value: string; raw: string }     // https://github.com/<handle>
  | { kind: "profile"; value: string; raw: string }    // a professional profile URL
  | { kind: "paper"; value: string; raw: string };     // a paper title

export type SeedProblem = { raw: string; line?: number; why: string };

/** Headers that name a column rather than hold a seed. */
/** Headers that name a column rather than hold a seed (also skipped when typed with a flag). */
const HEADER = /^(scholar|google scholar|scholar url|github|github url|profile|profile url|linkedin|linkedin url|paper|papers|title|paper title|url|name|first name|last name|company|seed|seeds|email)$/i;

const GITHUB_RESERVED = new Set(["orgs", "topics", "search", "features", "about", "pricing", "login", "logout", "join", "signup", "settings", "marketplace", "sponsors", "collections", "explore", "trending", "apps", "enterprise", "enterprises", "notifications", "new", "issues", "pulls", "codespaces", "discussions", "events", "security", "site", "contact", "customer-stories", "readme", "team", "teams", "users", "solutions", "resources"]);

/** One cell to a seed, or a reason it is not one. */
export function classify(raw: string): Seed | { problem: string } | undefined {
  const cell = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!cell || HEADER.test(cell)) return undefined;
  const asUrl = /^(https?:\/\/|www\.|scholar\.google\.|github\.com\/|[a-z]{2,3}\.linkedin\.com\/|linkedin\.com\/)/i.test(cell);
  if (!asUrl) {
    if (!/[a-z]/i.test(cell) || cell.split(/\s+/).length < 3) return { problem: "too short to be a paper title (use the full title)" };
    return { kind: "paper", value: cell.replace(/\s+/g, " "), raw };
  }
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(cell) ? cell : `https://${cell}`); } catch { return { problem: "not a valid URL" }; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (/^scholar\.google\./.test(host)) {
    const user = url.searchParams.get("user");
    if (!user || !/^[\w-]{6,20}$/.test(user)) return { problem: "a Google Scholar URL without a profile (it needs ?user=...)" };
    return { kind: "scholar", value: `https://scholar.google.com/citations?user=${user}`, raw };
  }
  if (host === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    const handle = parts[0];
    if (!handle || GITHUB_RESERVED.has(handle.toLowerCase()) || !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(handle)) return { problem: "not a GitHub profile URL (use https://github.com/<username>)" };
    // A repository link names a repository (often an organization's), not a person: each lookup is billed.
    if (parts.length > 1) return { problem: "a GitHub repository link: use the person's profile, https://github.com/<username>" };
    return { kind: "github", value: `https://github.com/${handle.toLowerCase()}`, raw };
  }
  if (/(^|\.)linkedin\.com$/.test(host) && /^\/in\/[^/]+/.test(url.pathname)) {
    let slug: string;
    try { slug = decodeURIComponent(url.pathname.split("/")[2]).toLowerCase(); } catch { return { problem: "not a valid URL" }; }
    return { kind: "profile", value: `https://www.linkedin.com/in/${encodeURIComponent(slug)}`, raw };
  }
  if (/arxiv\.org|openreview\.net|semanticscholar\.org|aclanthology\.org|proceedings\./.test(host)) return { problem: "a paper link: paste the paper's title instead" };
  return { problem: "a link this tool cannot read (use a Google Scholar profile, a GitHub profile, a professional network profile URL, or a paper title; personal homepages are not read)" };
}

/**
 * Header words for a column of paper titles. A plain "Title" column counts only next to "Authors" or "Year" (a
 * Google Scholar export); in recruiting exports it holds job titles, and every paper title is a billed search.
 */
const TITLE_COLUMN = /^(papers?|paper titles?|articles?)$/i;
/** Cells a header row is made of. A row is a header only when every cell in it is one of these. */
const HEADER_WORD = /^(scholar|google scholar|scholar url|scholar link|github|github url|github link|profile|profile url|profile link|linkedin|linkedin url|papers?|paper titles?|articles?|title|url|link|name|full name|first name|last name|company|employer|seeds?|email|notes?|authors?|year|publication|venue|volume|number|pages|publisher|cites|citations|role|team|lab|location)$/i;

/**
 * Every seed in a file's text. A text file (`lines`) is read one line at a time: a link is a link, any other line a
 * paper title, commas and all. A CSV is read by column: links from any column; plain text as a paper title only in a
 * column named paper (or papers, paper title, article), or "Title" in a Google Scholar export, so a name, job title or
 * company column is never searched as a paper. A CSV with no header row is read as titles only when it has one
 * column. Text left unread is counted in `ignored`. Duplicates are kept once. Line numbers are the file's.
 */
export function parseSeeds(text: string, opts: { lines?: boolean } = {}): { seeds: Seed[]; problems: SeedProblem[]; ignored: number } {
  const seeds: Seed[] = [], problems: SeedProblem[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  const take = (r: Seed) => {
    // Scholar ids are case-sensitive; GitHub handles and titles are not.
    const key = `${r.kind}:${r.kind === "scholar" ? r.value : r.value.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); seeds.push(r); }
  };
  if (opts.lines) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
    // A "text" file that is really a table (tabs, or a header row of column names) is read as one.
    const first = lines.find(l => l.trim()) ?? "";
    const tabular = lines.some(l => l.includes("\t")) || first.split(/[,;]/).map(c => c.trim()).filter(Boolean).every(c => HEADER_WORD.test(c)) && /[,;]/.test(first);
    if (!tabular) {
      lines.forEach((raw, i) => {
        // A line with links in it ("Jane Doe - https://scholar...") gives its links; a line without, a paper title.
        const links = raw.match(/https?:\/\/\S+/g);
        for (const cell of links ?? [raw]) {
          const r = classify(cell);
          if (!r) continue;
          if ("problem" in r) problems.push({ raw: cell.trim(), line: i + 1, why: r.problem });
          else take(r);
        }
      });
      return { seeds, problems, ignored };
    }
  }
  const rows = parseCsvRows(text);
  // A header row: no cell is a link, at least one cell is a known column name, and no cell is long like a title.
  const firstCells = rows[0]?.cells.map(c => c.trim()).filter(Boolean) ?? [];
  const header = firstCells.length && firstCells.some(c => HEADER_WORD.test(c)) && !firstCells.some(c => /:\/\/|^www\./i.test(c) || c.split(/\s+/).length > 4) ? rows[0].cells.map(c => c.trim()) : undefined;
  const scholarExport = !!header && header.some(h => /^(authors?|year)$/i.test(h));
  const oneColumn = rows.every(r => r.cells.filter(c => c.trim()).length <= 1);
  rows.forEach((row, i) => {
    if (header && i === 0) return;
    for (const [col, cell] of row.cells.entries()) {
      const r = classify(cell);
      if (!r) continue;
      const isLink = "problem" in r ? /^(https?:|www\.)/i.test(cell.trim()) : r.kind !== "paper";
      const titleCell = header ? TITLE_COLUMN.test(header[col] ?? "") || (scholarExport && /^title$/i.test(header[col] ?? "")) : oneColumn;
      if (!isLink && !titleCell) { ignored++; continue; }
      if ("problem" in r) { problems.push({ raw: cell.trim(), line: row.line, why: r.problem }); continue; }
      take(r);
    }
  });
  return { seeds, problems, ignored };
}

/** Paper titles compared loosely: case, punctuation and spacing ignored. */
export const normTitle = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Whether an article on someone's research profile is the paper asked for. Crustdata's phrase filter also returns
 * people with a different paper that contains the same words ("Channel attention is all you need"), so the title
 * must start with the one asked for and add only a year, a one-letter tag or a venue ("..., 2023", "(2017)", "[J]",
 * "arXiv preprint"). "Attention is all you need for speech" is a different paper.
 */
const TAIL_WORD = /^(\d{4}|[a-z]|arxiv|preprint|abs|nips|neurips|icml|iclr|cvpr|iccv|eccv|acl|emnlp|naacl|aaai|ijcai|proceedings|in|of|the|conference|workshop|journal)$/;
export function samePaper(asked: string, article: string): boolean {
  const a = normTitle(asked), b = normTitle(article);
  if (!a || !b) return false;
  if (a === b) return true;
  if (!b.startsWith(`${a} `)) return false;
  return b.slice(a.length).trim().split(" ").every(w => TAIL_WORD.test(w));
}
