// The bar above the table: progress while running, totals when done, credits when the deployment shows them.
import { CircleNotchIcon, CheckCircleIcon } from "@phosphor-icons/react";
import type { CostSummary } from "@/lib/types";
import type { Summary } from "@/lib/events";
import { fmt } from "@/lib/plan";

export function CostBar({ running, progress, cost, remaining, summary, pricing, elapsedMs, cached, rows }: {
  running: boolean; progress: { people: [number, number]; companies: [number, number] }; cost: CostSummary | null; remaining: number | null;
  summary: Summary | null; pricing: "shown" | "hidden"; elapsedMs: number; cached?: boolean; rows: { matched: number; partial: number; unresolved: number; total: number } | null;
}) {
  const stat = (label: string, value: string) => (
    <div className="flex items-baseline gap-1.5"><span className="num text-[15px] font-semibold">{value}</span><span className="text-[13px] text-ink-2">{label}</span></div>
  );
  return (
    <div className="panel flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
      <div className="flex items-center gap-2 text-[14px] font-medium">
        {running ? <CircleNotchIcon size={18} className="spin text-violet" aria-hidden /> : <CheckCircleIcon size={18} weight="fill" className="text-green" aria-hidden />}
        {running ? "Filling in" : "Done"}
      </div>
      {running && progress.people[1] > 0 && stat("people", `${progress.people[0]}/${progress.people[1]}`)}
      {running && progress.companies[1] > 0 && stat("companies", `${progress.companies[0]}/${progress.companies[1]}`)}
      {summary && !running && stat("people matched", `${summary.people.matched}/${summary.people.matched + summary.people.not_found + summary.people.redacted + summary.people.invalid + summary.people.ambiguous}`)}
      {summary && !running && stat("companies matched", `${summary.companies.matched}/${summary.companies.matched + summary.companies.not_found + summary.companies.ambiguous}`)}
      {rows && !running && stat("rows fully matched", `${rows.matched}/${rows.total}`)}
      {rows && !running && rows.partial > 0 && stat("partly", String(rows.partial))}
      {rows && !running && rows.unresolved > 0 && stat("unresolved", String(rows.unresolved))}
      {pricing === "shown" && cost && cost.credits >= 0 && stat("credits used", fmt(cost.credits))}
      {pricing === "shown" && cost && cost.cached > 0 && stat("saved by the cache", fmt(cost.cached))}
      {pricing === "shown" && remaining !== null && !running && stat("credits left", fmt(Math.round(remaining)))}
      {cached && <span className="tag tag-muted">Sample results, stored</span>}
      {!running && elapsedMs > 0 && <span className="ml-auto text-[13px] text-ink-3">{(elapsedMs / 1000).toFixed(1)}s</span>}
    </div>
  );
}
