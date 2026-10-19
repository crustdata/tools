/** A small CSV writer (RFC 4180 quoting). Opens cleanly in Sheets, Excel and CRM importers. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One cell. Values starting with = + - @ get a leading apostrophe, so a company name or post text can never run as
 * a spreadsheet formula. Negative numbers stay numbers.
 */
export function csvCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  let s = Array.isArray(v) ? v.join("; ") : String(v);
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeCsv(path: string, header: string[], rows: unknown[][]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [header, ...rows].map(r => r.map(csvCell).join(",")).join("\n") + "\n");
}

/** Reads a CSV written by writeCsv (or edited in a spreadsheet): quoted cells, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
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
