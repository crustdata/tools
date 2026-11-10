/**
 * Is the company growing or shrinking, and when did it last raise? Pure functions over the company search answer
 * (headcount growth over 1, 3, 6 and 12 months; last round, its date and amount; total raised).
 */

import type { RawCompany } from "./crustdata.js";

export type Momentum = {
  headcount: number | null;
  growth3m: number | null;
  growth6m: number | null;
  growth12m: number | null;
  trend: "growing" | "flat" | "shrinking" | "unknown";
  lastRound: string | null;
  lastRoundDate: string | null;
  lastRoundUsd: number | null;
  totalRaisedUsd: number | null;
};

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function momentumOf(c: RawCompany | undefined, fallback?: { headcount: number | null; lastRound: string | null; lastRoundDate: string | null; totalRaisedUsd: number | null }): Momentum {
  const g = c?.headcount?.growth_percent ?? {};
  const growth6m = n(g["6m"]);
  const growth3m = n(g["3m"]);
  const growth12m = n(g["12m"]);
  const basis = growth6m ?? growth3m ?? growth12m;
  const trend = basis === null ? "unknown" : basis >= 5 ? "growing" : basis <= -5 ? "shrinking" : "flat";
  return {
    headcount: n(c?.headcount?.total) ?? fallback?.headcount ?? null,
    growth3m, growth6m, growth12m, trend,
    lastRound: s(c?.funding?.last_round_type) ?? fallback?.lastRound ?? null,
    lastRoundDate: s(c?.funding?.last_fundraise_date) ?? fallback?.lastRoundDate ?? null,
    lastRoundUsd: n(c?.funding?.last_round_amount_usd),
    totalRaisedUsd: n(c?.funding?.total_investment_usd) ?? fallback?.totalRaisedUsd ?? null,
  };
}

const ROUNDS: Record<string, string> = {
  pre_seed: "Pre-seed", seed: "Seed", angel: "Angel", series_a: "Series A", series_b: "Series B", series_c: "Series C",
  series_d: "Series D", series_e: "Series E", series_f: "Series F", series_g: "Series G", series_h: "Series H",
  series_unknown: "Venture round", venture_round: "Venture round", private_equity: "Private equity",
  debt_financing: "Debt financing", convertible_note: "Convertible note", grant: "Grant", corporate_round: "Corporate round",
  secondary_market: "Secondary sale", post_ipo_equity: "Post-IPO equity", post_ipo_debt: "Post-IPO debt", ipo: "IPO",
  equity_crowdfunding: "Crowdfunding", product_crowdfunding: "Crowdfunding", non_equity_assistance: "Non-equity assistance",
  initial_coin_offering: "Token sale", undisclosed: "Undisclosed round",
};

export const roundName = (r: string | null): string | null =>
  r ? ROUNDS[r] ?? r.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase()) : null;

export function money(usd: number | null): string | null {
  if (usd === null || usd <= 0) return null;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(usd >= 1e10 ? 0 : 1).replace(/\.0$/, "")}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(usd >= 1e8 ? 0 : 1).replace(/\.0$/, "")}M`;
  return `$${Math.round(usd / 1e3)}K`;
}

const pct = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(Math.round(v))}%`;

export function monthYear(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(/T/.test(iso) ? (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`) : `${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : null;
}

/** "Growing: 1,409 people, +19% in 6 months, +68% in 12 months" */
export function trendLine(m: Momentum): string {
  const people = m.headcount !== null ? `${m.headcount.toLocaleString("en-US")} people` : null;
  const bits = [
    people,
    m.growth6m !== null ? `${pct(m.growth6m)} in 6 months` : m.growth3m !== null ? `${pct(m.growth3m)} in 3 months` : null,
    m.growth12m !== null ? `${pct(m.growth12m)} in 12 months` : null,
  ].filter(Boolean);
  const head = { growing: "Growing", flat: "Flat", shrinking: "Shrinking", unknown: "Team size trend not known" }[m.trend];
  return bits.length ? `${head}: ${bits.join(", ")}` : head;
}

/** "Series E, $350M, Sep 2026 ($585M raised in total)", or null when nothing is on record. */
export function fundingLine(m: Momentum): string | null {
  const round = roundName(m.lastRound);
  const parts = [round, money(m.lastRoundUsd), monthYear(m.lastRoundDate)].filter(Boolean);
  const total = money(m.totalRaisedUsd);
  if (!parts.length && !total) return null;
  return `${parts.join(", ")}${total ? `${parts.length ? " " : ""}(${total} raised in total)` : ""}`.trim();
}

/** Months since the last round, or null. */
export function monthsSinceRound(m: Momentum, now = new Date()): number | null {
  if (!m.lastRoundDate) return null;
  const t = Date.parse(/T/.test(m.lastRoundDate) ? m.lastRoundDate : `${m.lastRoundDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / (30.44 * 86_400_000));
}
