/**
 * Reads the candidate list: a CSV (comma, semicolon or tab separated, any BOM) or an Excel .xlsx file, as exported
 * from Greenhouse, Lever, Ashby, Workable, a spreadsheet or a sourcing tool.
 *
 * The profile URL is taken from a column named for it when there is one ("LinkedIn URL", "Profile URL",
 * "Social Profiles", Lever's "Links"), and otherwise from any cell in the row that holds one, so an export with
 * its own column names still works. A row with no profile URL but an email can be looked up by email.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { findProfileUrls } from "./profile-url.js";
import { plausibleEmail } from "./crustdata.js";
import { namesDiffer } from "./verdict.js";
import { readXlsxSheets } from "./xlsx.js";

export type Table = {
  headers: string[];
  rows: Array<{ cells: string[]; line: number }>;
  /** The CSV separator, so the results are written the same way (";" for Excel in many European locales). */
  delimiter?: string;
  /** For .xlsx: the sheet that was read, and every sheet's name. */
  sheet?: { name: string; index: number; names: string[] };
  /** The line the column names were found on, when it is not line 1. */
  headerLine?: number;
  /** Set when no known column name was found anywhere near the top. */
  noKnownHeaders?: boolean;
};

/** Header names, lowercased with spaces and punctuation squeezed, that each ATS and spreadsheet uses. */
export const COLUMN_ALIASES = {
  profileUrl: [
    "linkedin", "linkedin url", "linkedin profile", "linkedin profile url", "linkedin link", "linkedin_url",
    "profile url", "profile_url", "profile", "public profile url", "person profile url", "professional network profile url",
    "social profiles", "social profile", "social media", "social links", "links", "link", "url", "website", "websites",
    "website addresses", "candidate linkedin", "candidate profile url", "lead linkedin url", "lead linkedin", "lead profile url",
  ],
  email: [
    "email", "email address", "e-mail", "emails", "email addresses", "personal email", "work email", "primary email",
    "candidate email", "candidate email address", "contact email", "lead email",
  ],
  name: ["name", "full name", "lead name", "lead full name", "prospect name", "candidate", "candidate name", "contact name", "applicant", "applicant name", "nom", "nombre", "nome", "naam", "nom complet", "nombre completo", "vollständiger name"],
  firstName: ["first name", "firstname", "first_name", "given name", "candidate first name", "lead first name", "prénom", "prenom", "vorname", "nombre de pila"],
  lastName: ["last name", "lastname", "last_name", "surname", "family name", "candidate last name", "lead last name", "nom de famille", "nachname", "apellido", "apellidos", "cognome"],
  job: ["job", "job title applied", "job name", "job applied", "requisition", "position applied", "posting", "posting title", "job title applied for", "applied for", "opening", "role applied for"],
};

const squeeze = (h: string) => h.replace(/^\uFEFF/, "").toLowerCase().replace(/[_\s]+/g, " ").replace(/[^\p{L}\p{N} @-]/gu, "").trim();

const KNOWN_HEADERS = new Set(Object.values(COLUMN_ALIASES).flat());

/**
 * The header row: the first of the top 10 rows with a known column name (exports often put a title and a date above
 * the column names). With none, line 1, and `noKnownHeaders` is set so the run can say so.
 */
export function withHeader(rows: Array<{ cells: string[]; line: number }>): Pick<Table, "headers" | "rows" | "headerLine" | "noKnownHeaders"> {
  // Only rows above the first row of data: a cell such as "LinkedIn" in a Source column is data, not a header.
  // (An "Exported by, someone@..." line has an email but only two cells: not a data row.)
  const headerLike = (r: { cells: string[] }) => r.cells.some(c => KNOWN_HEADERS.has(squeeze(c.replace(/\(.*\)/, ""))));
  const firstData = rows.findIndex(r => !headerLike(r) && (r.cells.some(c => findProfileUrls(c).length > 0) || (r.cells.filter(c => c.trim()).length > 2 && r.cells.some(c => plausibleEmail(c.trim())))));
  const top = rows.slice(0, firstData === -1 ? 10 : Math.min(firstData, 10));
  const known = (r: { cells: string[] }) => r.cells.filter(c => KNOWN_HEADERS.has(squeeze(c))).length;
  // Line 1 with one known name is the header; a later line needs two (so "Jane Doe, LinkedIn" is a candidate).
  let at = top.findIndex((r, k) => known(r) >= (k === 0 ? 1 : 2));
  // Below line 1 only when every line above it is a title or a date (two filled cells at most): otherwise line 1 is
  // the header and the row found is a candidate.
  if (at > 0 && top.slice(0, at).some(r => r.cells.filter(c => c.trim()).length > 2)) at = 0;
  // No known column names and the first line is already a candidate (a profile URL in it): the file has no header.
  // (An example URL inside a column name, "LinkedIn (e.g. .../in/your-name)", does not make line 1 a candidate.)
  if (at === -1 && rows[0]?.cells.some(c => findProfileUrls(c).length > 0) && !rows[0].cells.some(c => KNOWN_HEADERS.has(squeeze(c.replace(/\(.*\)/, ""))))) {
    const width = Math.max(...rows.slice(0, 50).map(r => r.cells.length));
    return { headers: Array.from({ length: width }, (_, k) => `column_${k + 1}`), rows, noKnownHeaders: true };
  }
  const i = at === -1 ? 0 : at;
  const head = rows[i];
  return {
    headers: head?.cells.map(h => h.trim()) ?? [],
    rows: rows.slice(i + 1),
    headerLine: head && head.line !== 1 && at !== -1 ? head.line : undefined,
    noKnownHeaders: at === -1 ? true : undefined,
  };
}

/** Reads the file into a table. Plain errors for the common wrong files. */
export function readTable(path: string, sheetName?: string): Table {
  // "~/Downloads/x.csv" in quotes reaches us with the ~ unexpanded.
  if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
  let size: number;
  try { size = statSync(path).size; } catch { throw new Error(`Cannot find ${path}. Check the path (put it in quotes if it has spaces, or drag the file into the terminal to paste its full path).`); }
  if (size > 200 * 1024 * 1024) throw new Error(`${path} is larger than 200 MB. Split it into smaller files.`);
  const ext = extname(path).toLowerCase();
  const buf = readFileSync(path);
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  if (ext === ".xls" || (buf[0] === 0xd0 && buf[1] === 0xcf)) throw new Error(`${path} is an old Excel .xls file. Open it in Excel or Google Sheets and save it as .xlsx or CSV, then run again.`);
  if (ext === ".numbers") throw new Error(`${path} is a Numbers file. In Numbers use File > Export To > CSV, then run again.`);
  if (ext === ".xlsx" || isZip) {
    let sheets;
    try { sheets = readXlsxSheets(buf); } catch (err) { throw new Error(`Cannot read ${path} as an Excel file (${(err as Error).message}). Save it as CSV and run again.`); }
    // The sheet with the most rows holding a profile URL or an email (a small "Hiring team" sheet never wins);
    // else the first with known column names; else the first sheet.
    // Rows with a profile URL count far more than rows with only an email (a "Hiring team" sheet of emails never wins).
    const score = (sh: { rows: Array<{ cells: string[] }> }) =>
      sh.rows.filter(r => r.cells.some(c => findProfileUrls(c).length > 0)).length * 1000 +
      sh.rows.filter(r => r.cells.some(c => plausibleEmail(c.trim()))).length;
    const scores = sheets.map(score);
    let index = scores.some(n => n > 0) ? scores.indexOf(Math.max(...scores)) : -1;
    if (sheetName !== undefined) {
      index = sheets.findIndex(sh => sh.name.trim().toLowerCase() === sheetName.trim().toLowerCase());
      if (index === -1) throw new Error(`${path} has no sheet named "${sheetName}". Its sheets: ${sheets.map(sh => `"${sh.name}"`).join(", ")}.`);
    }
    if (index === -1) index = sheets.findIndex(sh => sh.rows.slice(0, 10).some(r => r.cells.some(c => KNOWN_HEADERS.has(squeeze(c)))));
    if (index === -1) index = 0;
    return { ...withHeader(sheets[index].rows), sheet: { name: sheets[index].name, index, names: sheets.map(sh => sh.name) } };
  }
  const text = decodeText(buf);
  if (text === undefined) throw new Error(`${path} does not look like a CSV file. Export your candidates as CSV or .xlsx and run again.`);
  // An opening quote that is never closed swallows the rest of the file into one cell.
  const open = unclosedQuoteLine(text);
  if (open) throw new Error(`${path} has a quote mark that is never closed (from line ${open}), so the rest of the file would be read as one cell. Fix that line (or save the file again from your spreadsheet) and run again.`);
  return { ...withHeader(parseCsv(text)), delimiter: csvDelimiter(text) };
}

/**
 * A CSV file's text: UTF-8 (with or without a byte order mark), UTF-16 (Excel's "Unicode text"), or, when it is
 * not valid UTF-8, Windows-1252 (older Excel "CSV"), so names like José keep their accents. Undefined for binary.
 */
export function decodeText(buf: Buffer): string | undefined {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  if (buf.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("windows-1252").decode(buf); }
}

/** The line where a quoted cell opens and never closes, by the same rules as parseCsv; undefined when all close. */
export function unclosedQuoteLine(input: string): number | undefined {
  const text = input.replace(/^\uFEFF/, "");
  const sep = csvDelimiter(text);
  let quoted = false, atCellStart = true, line = 1, openedAt = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') i++;
      else if (ch === '"') { quoted = false; atCellStart = false; }
      else if (ch === "\n") line++;
    } else if (ch === '"' && atCellStart) { quoted = true; openedAt = line; }
    else if (ch === sep) atCellStart = true;
    else if (ch === "\n") { line++; atCellStart = true; }
    else if (ch !== "\r") atCellStart = false;
  }
  return quoted ? openedAt : undefined;
}

/** Comma, semicolon or tab, whichever the first line uses most. */
export function csvDelimiter(input: string): string {
  // The line with the most separators among the first 10 (a title line above the column names has none).
  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, 10);
  let best = ",", most = 0;
  for (const line of lines) for (const d of [",", ";", "\t"]) {
    const n = line.split(d).length - 1;
    if (n > most) { most = n; best = d; }
  }
  return best;
}

/**
 * RFC 4180 reader: quoted fields, doubled quotes, newlines inside quotes, CRLF, a byte order mark. Comma, semicolon
 * (Excel in many European locales) or tab, picked from the header line. Each row keeps the line it starts on.
 */
export function parseCsv(input: string): Array<{ cells: string[]; line: number }> {
  const text = input.replace(/^\uFEFF/, "");
  const sep = csvDelimiter(text);
  const rows: Array<{ cells: string[]; line: number }> = [];
  let row: string[] = [], cell = "", quoted = false, line = 1, rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else { if (ch === "\n") line++; cell += ch; }
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(c => c.trim() !== "")) rows.push({ cells: row, line: rowLine });
      row = [];
      line++;
      rowLine = line;
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim() !== "")) rows.push({ cells: row, line: rowLine });
  return rows;
}

export type Candidate = {
  /** The row's line in the file (the header is line 1), for messages. */
  line: number;
  /** The row's own cells, written back unchanged in verified.csv. */
  cells: string[];
  name?: string;
  email?: string;
  job?: string;
  /** Normalised profile URL, from the file or (later) from the email lookup. */
  profileUrl?: string;
  /** Where the profile URL came from. */
  source?: "file" | "email";
  /** Set when the row cannot be checked: why, in plain words. */
  problem?: string;
  /** Other rows that gave this profile URL under another name (a borrowed-profile question). */
  sharedWith?: string[];
};

export type CandidateList = {
  headers: string[];
  candidates: Candidate[];
  /** Which column each thing was read from, for the run log. */
  columns: { profileUrl?: string; email?: string; name?: string; job?: string; scanned: boolean };
  /** Rows that repeat a person already in the list (same profile URL, or same email with no URL). */
  duplicates: Array<{ line: number; of: number; candidate: Candidate }>;
};

function findColumn(headers: string[], aliases: string[]): number {
  const squeezed = headers.map(squeeze);
  for (const alias of aliases) {
    const i = squeezed.indexOf(alias);
    if (i !== -1) return i;
  }
  return -1;
}

/** Someone other than the candidate: an email or profile URL in one of these columns is never used. */
const NOT_CANDIDATE = /owner|recruiter|referr|coordinator|interviewer|hiring manager|hiring lead|lead recruiter|team lead|hiring team|account manager|sourcer|sourced by|creator|created by|assigned|added by|credited|reviewer|evaluator|approver|panel|point of contact|contact person|agency|posted by|moved by|rejected by|hired by|company/;

/**
 * A link that points at a profile but is not a public profile URL: a recruiting or sales tool link, an empty /in/,
 * or a misspelt host. Pure.
 */
export function nonPublicProfileLink(text: string): string | undefined {
  const m = /(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?(?:linkedin\.com\/(?:talent|recruiter|sales)\/[^\s,;]+|linkedin\.com\/in\/?(?=[\s,;"]|$)|link(?:d|edn|din)?in\.com\/in\/[^\s,;]+|lnkd\.in\/[^\s,;]+)/i.exec(text);
  return m && !findProfileUrls(text).length ? m[0] : undefined;
}

/** The candidate's email column: a known name, or any header with "email" in it that is not someone else's. */
function emailColumn(headers: string[]): number {
  const known = findColumn(headers, COLUMN_ALIASES.email);
  if (known !== -1) return known;
  return headers.map(squeeze).findIndex(h => /\be-?mails?\b/.test(h) && !NOT_CANDIDATE.test(h));
}

/** Pure: a table to candidates. */
export function readCandidates(table: Table): CandidateList {
  const { headers, rows } = table;
  const col = {
    profileUrl: findColumn(headers, COLUMN_ALIASES.profileUrl),
    email: emailColumn(headers),
    name: findColumn(headers, COLUMN_ALIASES.name),
    first: findColumn(headers, COLUMN_ALIASES.firstName),
    last: findColumn(headers, COLUMN_ALIASES.lastName),
    job: findColumn(headers, COLUMN_ALIASES.job),
  };
  let scanned = false;
  const candidates: Candidate[] = [];
  const duplicates: CandidateList["duplicates"] = [];
  const seen = new Map<string, number>();

  // Columns about someone else (a referrer, an owner, a recruiter) are never searched for the candidate's profile.
  const someoneElse = new Set(headers.map((h, i) => (NOT_CANDIDATE.test(squeeze(h)) ? i : -1)).filter(i => i >= 0));
  // A profile URL found outside the profile column on rows with different names is someone else's (a hiring lead).
  const nameOf = (cells: string[]) => (col.name >= 0 ? cells[col.name] : [cells[col.first], cells[col.last]].filter(Boolean).join(" ")) ?? "";
  const scannedNames = new Map<string, Set<string>>();
  for (const { cells } of rows) {
    if (findProfileUrls(col.profileUrl >= 0 ? cells[col.profileUrl] : "").length) continue;
    for (const [i, c] of cells.entries()) if (!someoneElse.has(i)) for (const u of findProfileUrls(c)) {
      const set = scannedNames.get(u) ?? new Set<string>();
      set.add(nameOf(cells).trim().toLowerCase());
      scannedNames.set(u, set);
    }
  }
  // Shared by rows whose names look like different people (not "Jane Doe" and "Jane A. Doe").
  const sharedUrl = (u: string) => { const n = [...(scannedNames.get(u) ?? [])].filter(Boolean); return n.some(a => n.some(b => namesDiffer(a, b))); };
  for (const { cells, line } of rows) {
    const at = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
    let urls = findProfileUrls(at(col.profileUrl));
    if (!urls.length) {
      // No profile URL where expected: look in the other cells (exports name and place this column differently).
      urls = cells.filter((_, i) => !someoneElse.has(i)).flatMap(c => findProfileUrls(c)).filter((u, i, a) => a.indexOf(u) === i && !sharedUrl(u));
      if (urls.length) scanned = true;
    }
    // Only the candidate's email column: a scan could pick up a recruiter's or owner's email and check the wrong person.
    const email = at(col.email).split(/[,;\s|]+/).map(e => e.trim().toLowerCase()).find(plausibleEmail);
    const name = at(col.name) || [at(col.first), at(col.last)].filter(Boolean).join(" ") || undefined;
    const c: Candidate = { line, cells, name, email, job: at(col.job) || undefined };
    if (urls.length === 1) { c.profileUrl = urls[0]; c.source = "file"; }
    else if (urls.length > 1) c.problem = `The row has ${urls.length} different profile URLs (${urls.slice(0, 2).join(", ")}). Keep the right one and run again.`;
    else if (!email) {
      const odd = cells.filter((_, i) => !someoneElse.has(i)).map(nonPublicProfileLink).find(Boolean);
      c.problem = odd
        ? `This row has a link that is not a public profile URL (${odd.slice(0, 60)}): a recruiting or sales tool link, or an incomplete one. Open it, copy the person's public profile URL (it contains /in/), paste it into the row and run again.`
        : "No profile URL or email in this row.";
    }

    const key = c.profileUrl ?? (c.problem ? undefined : `email:${email}`);
    if (key) {
      const first = seen.get(key);
      if (first !== undefined) {
        // The same profile under another name is not a repeat: it is the borrowed-profile case, for a person to check.
        const firstName = candidates.find(x => x.line === first)?.name;
        if (namesDiffer(firstName, c.name)) {
          c.problem = `Line ${first} has the same profile URL under another name ("${firstName}"). Check which applicant this profile belongs to, fix the row and run again.`;
          const owner = candidates.find(x => x.line === first);
          if (owner) owner.sharedWith = [...(owner.sharedWith ?? []), `line ${line} ("${c.name}")`];
          c.profileUrl = undefined;
          candidates.push(c);
          continue;
        }
        duplicates.push({ line, of: first, candidate: c });
        continue;
      }
      seen.set(key, line);
    }
    candidates.push(c);
  }

  return {
    headers,
    candidates,
    duplicates,
    columns: {
      profileUrl: col.profileUrl >= 0 ? headers[col.profileUrl] : undefined,
      email: col.email >= 0 ? headers[col.email] : undefined,
      name: col.name >= 0 ? headers[col.name] : col.first >= 0 ? [headers[col.first], headers[col.last]].filter(Boolean).join(" + ") : undefined,
      job: col.job >= 0 ? headers[col.job] : undefined,
      scanned,
    },
  };
}
