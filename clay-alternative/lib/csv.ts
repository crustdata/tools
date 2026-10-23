// CSV in and out, with no Node imports so the same code runs in the browser (the drop zone) and in the CLI.
// Reads: BOM, comma / semicolon / tab files, quoted cells with newlines, CRM default column names.
// Writes: RFC 4180 quoting, with a guard against spreadsheet formulas in cells.

import { emailDomain, emailIdentifier, identifierFromText, looksLikeProfileUrl, normalizeDomain, normalizeName, normalizeProfileUrl } from "./normalize";
import type { Identifier, InputRow } from "./types";

/** Column names as HubSpot, Salesforce, Attio, Apollo and Google Sheets export them. Compared without case, spaces or punctuation. */
export const COLUMN_ALIASES: Record<"email" | "profileUrl" | "domain" | "company" | "firstName" | "lastName" | "name", string[]> = {
  email: ["email", "e-mail", "email address", "work email", "business email", "contact email", "primary email", "email 1", "person email", "emails"],
  profileUrl: ["profile url", "profile", "linkedin", "linkedin url", "linkedin profile", "linkedin profile url", "person linkedin url", "linkedin_url", "profile link", "social profile"],
  domain: ["domain", "website", "web site", "company domain", "company domain name", "company website", "website url", "url", "site", "company url", "primary domain", "organization website", "account website"],
  company: ["company", "company name", "organization", "organisation", "organization name", "account", "account name", "employer", "current company", "company_name"],
  firstName: ["first name", "firstname", "given name", "first"],
  lastName: ["last name", "lastname", "surname", "family name", "last"],
  name: ["name", "full name", "contact name", "person", "person name", "contact", "lead name"],
};

/** The columns this tool adds on export; ignored when a file comes back in. */
export const META_COLUMNS = ["_match_status", "_match_confidence", "_source_row"];

export const key = (h: string) => h.toLowerCase().replace(/^\ufeff/, "").replace(/[^a-z0-9]+/g, " ").trim();

/** The delimiter is the one that appears most outside quotes in the first lines. */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const head = text.slice(0, 4000).replace(/"(?:[^"]|"")*"/g, "").split(/\r?\n/).slice(0, 5).join("\n");
  const count = (d: string) => head.split(d).length - 1;
  const scores: Array<[number, "," | ";" | "\t"]> = [[count(","), ","], [count(";"), ";"], [count("\t"), "\t"]];
  scores.sort((a, b) => b[0] - a[0]);
  return scores[0][0] === 0 ? "," : scores[0][1];
}

/** Parses a whole CSV into rows of cells. Keeps every line, including empty ones, so line numbers stay real. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const t = text.replace(/^\ufeff/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === delimiter) { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = ""; i++; continue;
    }
    cell += ch; i++;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

export type Counts = Record<"profile_url" | "email" | "personal_email" | "domain" | "company_name" | "unusable", number>;

export type Detected = {
  headers: string[];
  /** Which header serves which role, when found. */
  roles: Partial<Record<keyof typeof COLUMN_ALIASES, string>>;
  rows: InputRow[];
  /** Rows that share an identifier with an earlier row: kept in the output, looked up once. */
  duplicates: number;
  delimiter: string;
  counts: Counts;
};

/** Repeated headers get a suffix so no column overwrites another: "Email", "Email (2)". */
export function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map(h => {
    const base = h.trim() || "column";
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

function findRole(headers: string[], aliases: string[]): string | undefined {
  const keys = headers.map(key);
  for (const a of aliases) {
    const i = keys.indexOf(key(a));
    if (i >= 0) return headers[i];
  }
  // A header that contains the alias as a whole word (for example "Primary Work Email").
  for (const a of aliases) {
    const i = keys.findIndex(k => new RegExp(`(^| )${key(a)}( |$)`).test(k));
    if (i >= 0) return headers[i];
  }
  return undefined;
}

/** Which header plays which role. Columns this tool wrote on a previous export are skipped. */
export function detectRoles(headers: string[]): Detected["roles"] {
  const roles: Detected["roles"] = {};
  const candidates = headers.filter(h => !h.startsWith("_") && !/\(Crustdata\)$/.test(h));
  const taken = new Set<string>();
  // Roles are claimed in this order, and a header serves one role only, so "Profile URL" is never also the website column.
  for (const role of ["email", "profileUrl", "domain", "company", "firstName", "lastName", "name"] as Array<keyof typeof COLUMN_ALIASES>) {
    const h = findRole(candidates.filter(x => !taken.has(x)), COLUMN_ALIASES[role]);
    if (h) { roles[role] = h; taken.add(h); }
  }
  return roles;
}

/** Gives one row its identifier from its cells and the roles. */
export function identifyRow(row: InputRow, roles: Detected["roles"], headers: string[]) {
  const cells = row.cells;
  const get = (role: keyof typeof COLUMN_ALIASES) => (roles[role] ? cells[roles[role]!] : "") ?? "";
  const url = get("profileUrl"), email = get("email"), domain = get("domain"), company = get("company");
  if (url) {
    const v = normalizeProfileUrl(url);
    if (v) row.id = { kind: "profile_url", value: v }; else row.problem = `Not a profile URL: ${url}`;
  }
  if (!row.id && email) {
    const id = emailIdentifier(email);
    if (id) row.id = id; else if (!row.problem) row.problem = `Not a valid email address: ${email}`;
  }
  if (domain && !looksLikeProfileUrl(domain)) {
    const v = normalizeDomain(domain);
    if (v) {
      if (!row.id) row.id = { kind: "domain", value: v }; else row.companyId = { kind: "domain", value: v };
    } else if (!row.id && !row.problem) row.problem = `Not a domain: ${domain}`;
  }
  if (!row.id && !row.problem && company) row.id = { kind: "company_name", value: normalizeName(company) };
  if (!row.id && !row.problem) {
    // A single unrecognised column (a pasted list) may hold anything, company names included.
    const single = headers.length === 1 && Object.keys(roles).length === 0;
    const fallback = Object.values(cells).map(v => identifierFromText(v)).find(x => x && (single || x.kind !== "company_name"));
    if (fallback) row.id = fallback;
  }
  if (!row.id && !row.problem) row.problem = "No email, domain or profile URL in this row";
  const named = !!(get("firstName") || get("lastName") || get("name"));
  if (named && row.id && row.id.kind !== "email" && row.id.kind !== "profile_url") row.personNameOnly = true;
}

/** Builds rows from a header list and records (any source: a parsed file, pasted lines, a JSON body). */
export function readRecords(rawHeaders: string[], records: Array<{ line: number; values: string[] }>): Detected {
  const headers = uniqueHeaders(rawHeaders);
  const roles = detectRoles(headers);
  const rows: InputRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const counts: Counts = { profile_url: 0, email: 0, personal_email: 0, domain: 0, company_name: 0, unusable: 0 };
  for (const rec of records) {
    if (rec.values.every(v => v.trim() === "")) continue;
    const cells: Record<string, string> = Object.create(null);
    headers.forEach((h, i) => { cells[h] = (rec.values[i] ?? "").trim(); });
    const row: InputRow = { line: rec.line, cells };
    identifyRow(row, roles, headers);
    if (row.id) {
      const k = `${row.id.kind}:${row.id.value}`;
      if (seen.has(k)) duplicates++; else seen.add(k);
      if (row.id.kind === "email" && row.id.personal) counts.personal_email++; else counts[row.id.kind]++;
    } else counts.unusable++;
    rows.push(row);
  }
  return { headers, roles, rows, duplicates, delimiter: ",", counts };
}

const isHeaderWord = (v: string) => key(v) === "input" || Object.values(COLUMN_ALIASES).flat().includes(key(v));

/** Reads a CSV text into rows with identifiers. A file with no header row that looks like a list is read as one column. */
export function readCsv(text: string): Detected {
  const delimiter = detectDelimiter(text);
  const table = parseCsv(text, delimiter);
  const first = table[0] ?? [];
  const firstKind = first.length === 1 ? identifierFromText(first[0])?.kind : undefined;
  const headerless = first.length === 1 && !!firstKind && firstKind !== "company_name" && !isHeaderWord(first[0]);
  const headers = headerless ? ["input"] : first;
  const records = table.slice(headerless ? 0 : 1).map((values, i) => ({ line: i + (headerless ? 1 : 2), values }));
  return { ...readRecords(headers, records), delimiter };
}

/** A pasted list: one identifier per line. A line is split on commas only when every part is an email, domain or URL. */
export function readList(text: string): Detected {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const allIds = parts.length > 1 && parts.every(p => { const id = identifierFromText(p); return id && id.kind !== "company_name"; });
    if (allIds) lines.push(...parts); else lines.push(t);
  }
  return readRecords(["input"], lines.map((v, i) => ({ line: i + 1, values: [v] })));
}

/** Is the file an Excel workbook rather than a CSV? Checked on the first bytes. */
export function isExcel(bytes: Uint8Array): boolean {
  const hex = Array.from(bytes.subarray(0, 4)).map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === "504b0304" || hex === "d0cf11e0";
}

/** One cell for output. Values starting with = + - @ get a leading apostrophe so nothing runs as a formula. */
export function csvCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  let s = Array.isArray(v) ? v.join("; ") : String(v);
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map(r => r.map(csvCell).join(",")).join("\n") + "\n";
}

export const describeIdentifier = (id: Identifier | undefined): string =>
  !id ? "none" : id.kind === "email" ? (id.personal ? "personal email" : "work email") : id.kind === "profile_url" ? "profile URL" : id.kind === "domain" ? "domain" : "company name";

export { emailDomain };
