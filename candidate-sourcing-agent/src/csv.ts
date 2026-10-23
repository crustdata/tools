/** A small CSV writer and reader (RFC 4180 quoting). Opens cleanly in Sheets, Excel and ATS importers. */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One cell. Values starting with = + - @ get a leading apostrophe, so a name or headline can never run as a
 * spreadsheet formula. Numbers stay numbers.
 */
export function csvCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  let s = Array.isArray(v) ? v.join("; ") : String(v);
  // A plain phone number ("+1 415 555 0100") cannot run as a formula, so it is written as it is.
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s) && !/^\+?[\d\s().-]+(?:;\s*\+?[\d\s().-]+)*$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The text of a CSV file. It starts with a UTF-8 byte order mark so Excel shows names like 王小明 correctly. */
export const csvText = (header: string[], rows: unknown[][]): string => "\uFEFF" + [header, ...rows].map(r => r.map(csvCell).join(",")).join("\n") + "\n";

/** Written through a temporary file and owner-only: these files are about real people. */
export function writeCsv(path: string, header: string[], rows: unknown[][]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, csvText(header, rows), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Reads a CSV written by writeCsv or saved from a spreadsheet: quoted cells, doubled quotes, commas and newlines
 * inside quotes, CRLF line ends, a byte order mark. A file whose first line has more semicolons than commas is read
 * as semicolon separated (Excel in many European locales).
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(c => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c !== "")) rows.push(row);
  return rows;
}
