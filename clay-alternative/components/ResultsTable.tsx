// The live table: the input identifier first, then one column per chosen column. A cell is a skeleton until its
// event arrives, a value when matched, and a small tag when not. Hover shows the Crustdata field it came from.
import type { Cell, InputRow } from "@/lib/types";
import { STATUS_WORDS } from "@/lib/export";
import type { ColumnInfo } from "./types";

const fmtNum = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function formatValue(c: ColumnInfo, v: string | number | null): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return c.label.includes("%") ? `${fmtNum(v)}%` : c.id === "company.year_founded" ? String(v) : fmtNum(v);
  return String(v);
}

export function ResultsTable({ rows, columns, cells, running }: {
  rows: InputRow[]; columns: ColumnInfo[]; cells: Map<number, Record<string, Cell>>; running: boolean;
}) {
  return (
    <div className="panel overflow-auto" style={{ maxHeight: "calc(100dvh - 230px)" }}>
      <table className="grid-table w-full text-[13px]">
        <thead>
          <tr>
            <th className="px-3 py-2.5 text-left font-medium text-ink-2">Input</th>
            {columns.map(c => <th key={c.id} className={`px-3 py-2.5 font-medium text-ink-2 ${isNumeric(c) ? "text-right" : "text-left"}`} title={`${c.endpoint} ${c.path}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const c = cells.get(i) ?? {};
            return (
              <tr key={i} className="rise">
                <td className="max-w-[260px] truncate px-3 py-2 font-mono text-[12px] text-ink-2" title={row.id?.value ?? `${row.problem ?? "no identifier"}\n${Object.values(row.cells).filter(Boolean).join(" | ")}`}>
                  {row.id?.value ?? <><span className="tag tag-amber mr-2">{row.problem?.startsWith("Not a") ? "invalid" : "no identifier"}</span>{Object.values(row.cells).filter(Boolean).join(" | ")}</>}
                </td>
                {columns.map(col => {
                  const cell = c[col.id];
                  if (!cell) return <td key={col.id} className="px-3 py-2">{running && row.id ? <span className="skeleton block h-3.5 w-[70%]" /> : null}</td>;
                  if (cell.status === "matched") {
                    const text = formatValue(col, cell.value);
                    return <td key={col.id} className={`max-w-[320px] truncate px-3 py-2 ${isNumeric(col) ? "num text-right" : ""}`} title={`${cell.source ?? ""}${cell.at ? `\nfetched ${cell.at}` : ""}${text ? `\n${text}` : "\nNo value in the record"}`}>{text || <span className="text-ink-3">empty</span>}</td>;
                  }
                  return <td key={col.id} className={`px-3 py-2 ${isNumeric(col) ? "text-right" : ""}`} title={cell.note ?? ""}><span className={`tag ${cell.status === "not_found" || cell.status === "no_identifier" ? "tag-muted" : "tag-amber"}`}>{STATUS_WORDS[cell.status] ?? cell.status}</span></td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const isNumeric = (c: ColumnInfo) => /headcount$|growth|funding_total|last_round_amount|open_roles|web_traffic|year_founded|years_experience/.test(c.id) && !/by_department/.test(c.id);
