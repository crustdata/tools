// Turns a finished run into files: the enriched CSV (original columns kept, new columns added, plus _match_status,
// _match_confidence and _source_row), the unresolved CSV (rows to fix and re-run) and a JSON view.
// The same row rule serves the run summary, the cost bar and the files: a row is resolved when every entity it
// has an identifier for matched; an entity the row cannot reach (no email for person columns) does not count against it.

import { META_COLUMNS, toCsv } from "./csv";
import type { Cell, Column, InputRow, RowStatus } from "./types";

export const STATUS_WORDS: Record<string, string> = {
  matched: "matched", not_found: "not found", ambiguous: "ambiguous", redacted: "redacted", personal_email: "personal email",
  needs_access: "needs access", no_identifier: "no identifier", invalid: "invalid", error: "error",
};

export type Outcome = "matched" | "partial" | "unresolved" | "not_run";

/** Which entities a row is judged on. */
export function relevant(row: InputRow, hasPerson: boolean, hasCompany: boolean): { person: boolean; company: boolean } {
  const personRow = row.id?.kind === "email" || row.id?.kind === "profile_url";
  return {
    person: hasPerson && personRow,
    company: hasCompany && !!row.id && (row.id.kind === "domain" || row.id.kind === "company_name" || !!row.companyId || personRow),
  };
}

export function outcome(row: InputRow, s: RowStatus | undefined, hasPerson: boolean, hasCompany: boolean): Outcome {
  if (!row.id) return "unresolved";
  if (!s) return "not_run";
  const r = relevant(row, hasPerson, hasCompany);
  const judged: Array<CellOk> = [];
  if (r.person) judged.push(s.person === "matched" ? "ok" : s.person ? "bad" : "pending");
  // A profile URL or personal email row gets its company from the profile; when that person was not found there is nothing more to judge.
  const fromProfile = row.id.kind === "profile_url" || (row.id.kind === "email" && !!row.id.personal);
  if (r.company && !(r.person && fromProfile && s.person && s.person !== "matched" && !row.companyId)) judged.push(s.company === "matched" ? "ok" : s.company ? "bad" : "pending");
  if (!judged.length) return s.person || s.company ? "matched" : "not_run";
  if (judged.includes("pending")) return "not_run";
  if (judged.every(x => x === "ok")) return "matched";
  if (judged.includes("ok")) return "partial";
  return "unresolved";
}
type CellOk = "ok" | "bad" | "pending";

/** "matched", or what went wrong, per entity the row is judged on: "person not found; company matched". */
export function rowStatusText(row: InputRow, s: RowStatus | undefined, hasPerson: boolean, hasCompany: boolean): string {
  if (!row.id) return row.problem ?? "no identifier";
  if (!s) return "not run";
  const r = relevant(row, hasPerson, hasCompany);
  const parts: string[] = [];
  if (r.person && s.person) parts.push(s.person === "matched" ? "person matched" : `person ${STATUS_WORDS[s.person] ?? s.person}`);
  if (r.company && s.company) parts.push(s.company === "matched" ? "company matched" : `company ${STATUS_WORDS[s.company] ?? s.company}`);
  const personal = row.id.kind === "email" && row.id.personal ? " (personal email)" : "";
  if (!parts.length) return (s.note ?? "not run") + personal;
  if (parts.every(x => x.endsWith(" matched"))) return "matched" + personal;
  return parts.join("; ") + personal;
}

export type Output = { enrichedCsv: string; unresolvedCsv: string; unresolved: number; matched: number; partial: number; json: unknown[] };

/** A header for an added column that does not collide with the file's own, compared without case. */
function addedHeader(label: string, originalHeaders: string[]): string {
  const taken = new Set(originalHeaders.map(h => h.toLowerCase()));
  return taken.has(label.toLowerCase()) ? `${label} (Crustdata)` : label;
}

export function buildOutput(rows: InputRow[], columns: Column[], cells: Map<number, Record<string, Cell>>, status: Map<number, RowStatus>, originalHeaders: string[]): Output {
  const hasPerson = columns.some(c => c.group === "Person"), hasCompany = columns.some(c => c.group === "Company");
  const header = [...originalHeaders, ...columns.map(c => addedHeader(c.label, originalHeaders)), ...META_COLUMNS.map(m => addedHeader(m, originalHeaders))];
  const enriched: unknown[][] = [];
  const unresolvedRows: unknown[][] = [];
  const json: unknown[] = [];
  let matched = 0, partial = 0;
  rows.forEach((row, i) => {
    const c = cells.get(i) ?? {};
    const s = status.get(i);
    const text = rowStatusText(row, s, hasPerson, hasCompany);
    const o = outcome(row, s, hasPerson, hasCompany);
    if (o === "matched") matched++; else if (o === "partial") partial++;
    const conf = s?.confidence !== undefined ? Math.round(s.confidence * 100) / 100 : "";
    enriched.push([...originalHeaders.map(h => row.cells[h] ?? ""), ...columns.map(col => c[col.id]?.value ?? ""), text, conf, row.line]);
    json.push({ line: row.line, input: row.cells, status: text, confidence: conf === "" ? null : conf, ...Object.fromEntries(columns.map(col => [col.id, c[col.id]?.value ?? null])) });
    if (o === "unresolved" || o === "partial" || o === "not_run") {
      const notes = [...new Set([s?.note, ...Object.values(c).filter(x => x.status !== "matched" && x.status !== "no_identifier" && x.note).map(x => x.note)].filter(Boolean))].join("; ");
      const reason = row.problem ?? (notes || text);
      unresolvedRows.push([row.line, text, reason, ...originalHeaders.map(h => row.cells[h] ?? "")]);
    }
  });
  return {
    enrichedCsv: toCsv(header, enriched),
    unresolvedCsv: toCsv(["_source_row", "_match_status", "reason", ...originalHeaders], unresolvedRows),
    unresolved: unresolvedRows.length,
    matched, partial,
    json,
  };
}
