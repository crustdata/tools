/**
 * Headcount: growth or shrinkage overall and by function, from two Crustdata company records: a reference record and
 * the one the company watch delivered. The reference is kept until a move is reported or it is about a month old, so
 * slow, steady growth adds up and is reported instead of being compared week by week. Flags only meaningful moves:
 * total 5% or more, a function 20% or more. Pure functions, no I/O.
 */

import type { Item } from "./types.js";

export type CompanyRecord = {
  crustdata_company_id?: number;
  basic_info?: { name?: string; primary_domain?: string; professional_network_url?: string } | null;
  headcount?: {
    total?: number | null;
    growth_percent?: { mom?: number | null; qoq?: number | null; six_months?: number | null; yoy?: number | null } | null;
    by_function_timeseries?: { CURRENT_FUNCTION?: Record<string, { date: string; employee_count: number }[]> } | null;
    by_role_absolute?: Record<string, number | null> | null;
  } | null;
  hiring?: { openings_count?: number | null } | null;
  funding?: unknown;
  news?: unknown;
};

export const TOTAL_THRESHOLD = 0.05;
export const FUNCTION_THRESHOLD = 0.2;
/** Functions smaller than this are too small for a percentage to mean anything. */
export const MIN_FUNCTION_SIZE = 5;

/** The latest count per function, from the by-function time series (falls back to by_role_absolute). */
export function functionCounts(r: CompanyRecord | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  const series = r?.headcount?.by_function_timeseries?.CURRENT_FUNCTION;
  if (series) {
    for (const [fn, points] of Object.entries(series)) {
      const valid = (Array.isArray(points) ? points : []).filter(p => p && typeof p.date === "string" && typeof p.employee_count === "number");
      const last = valid.sort((a, b) => a.date.localeCompare(b.date)).at(-1);
      if (last && typeof last.employee_count === "number") out[fn] = last.employee_count;
    }
    return out;
  }
  for (const [fn, n] of Object.entries(r?.headcount?.by_role_absolute ?? {})) if (typeof n === "number") out[fn] = n;
  return out;
}

const pct = (from: number, to: number) => (from === 0 ? 1 : (to - from) / from);
const fmtPct = (p: number) => `${Math.round(Math.abs(p) * 100)}%`;
const fnLabel = (fn: string) => fn.replace(/_/g, " ").toLowerCase().replace(/\bit\b/, "IT");

/**
 * "since Sep 28": the date of the reference record the move is measured from. Said that way because company records
 * refresh every 1 to 30 days, so the move happened somewhere in that span, not necessarily in the last few weeks.
 */
export function spanLabel(a: string | undefined, _b?: string): string {
  if (!a) return "since the last record";
  const d = new Date(a);
  return isNaN(d.getTime()) ? "since the last record" : `since ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

/** Keep comparing against the stored record until it is this old, so a slow climb adds up to a reportable move. */
export const REFERENCE_DAYS = 28;

/** Digest items for one competitor's headcount, comparing the stored record with the new one. */
export function headcountItems(prev: CompanyRecord | undefined, next: CompanyRecord | undefined, prevAt?: string, nextAt?: string): Item[] {
  const items: Item[] = [];
  if (!next?.headcount) return items;
  const span = spanLabel(prevAt, nextAt);
  const total = next.headcount.total;
  const prevTotal = prev?.headcount?.total;
  if (typeof total === "number" && typeof prevTotal === "number" && prevTotal > 0) {
    const p = pct(prevTotal, total);
    if (Math.abs(p) >= TOTAL_THRESHOLD) items.push({ text: `Headcount ${p > 0 ? "up" : "down"} ${fmtPct(p)} ${span} (${prevTotal} to ${total})` });
  }
  const before = functionCounts(prev);
  const after = functionCounts(next);
  const moves: { fn: string; p: number; from: number; to: number }[] = [];
  for (const [fn, to] of Object.entries(after)) {
    const from = before[fn];
    if (typeof from !== "number" || Math.max(from, to) < MIN_FUNCTION_SIZE) continue;
    const p = pct(from, to);
    if (Math.abs(p) >= FUNCTION_THRESHOLD && Math.abs(to - from) >= 2) moves.push({ fn, p, from, to });
  }
  moves.sort((a, b) => Math.abs(b.p) - Math.abs(a.p));
  for (const m of moves.slice(0, 3)) items.push({ text: `${capital(fnLabel(m.fn))} ${m.p > 0 ? "up" : "down"} ${fmtPct(m.p)} ${span} (${m.from} to ${m.to})`, why: m.p > 0 ? `investing in ${fnLabel(m.fn)}` : `pulling back on ${fnLabel(m.fn)}` });
  return items;
}

/** Week-one view, when there is no earlier record: the API's own growth figures, only when they clear the bar. */
export function headcountBaselineItems(r: CompanyRecord | undefined): Item[] {
  const items: Item[] = [];
  const g = r?.headcount?.growth_percent;
  const total = r?.headcount?.total;
  if (!g || typeof total !== "number") return items;
  const windows: [string, number | null | undefined][] = [["in the last month", g.mom], ["in the last 3 months", g.qoq], ["in the last 6 months", g.six_months]];
  for (const [label, v] of windows) {
    if (typeof v !== "number") continue;
    const threshold = label.includes("month") && !label.includes("3") && !label.includes("6") ? 5 : label.includes("3") ? 10 : 20;
    if (Math.abs(v) >= threshold) { items.push({ text: `Headcount ${v > 0 ? "up" : "down"} ${Math.round(Math.abs(v))}% ${label} (now ${total})` }); break; }
  }
  return items;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
