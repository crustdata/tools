"use client";

// Small SVG charts: recessive grid, mono axis labels, the value written at the end of each line (unless a table next
// to the chart already names the series), a crosshair and tooltip on hover. Series colours were run through a
// colourblind check; labels stay in ink.

import { useEffect, useMemo, useRef, useState } from "react";

export const SERIES = ["#4f46d8", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthLabel = (i: number, yearsOnly = false) => yearsOnly ? String(Math.floor(i / 12)) : `${MONTHS[i % 12]} '${String(Math.floor(i / 12)).slice(2)}`;
const monthLong = (i: number) => `${MONTHS[i % 12]} ${Math.floor(i / 12)}`;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// A tick step from 1, 2, 2.5 or 5 times a power of ten, so the axis reads 0, 250, 500 and never 0, 113, 225.
function niceStep(raw: number) {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return ([1, 2, 2.5, 5, 10].find(x => n <= x) ?? 10) * p;
}

export type Series = { name: string; points: Array<{ date: string; value: number }>; color?: string };

export function LineChart({
  series, height = 300, format = (v: number) => Math.round(v).toLocaleString("en-US"), step = false, label, labels = true,
}: { series: Series[]; height?: number; format?: (v: number) => string; step?: boolean; label: string; labels?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const clean = series.filter(s => s.points.length >= 2);

  const geo = useMemo(() => {
    const all = clean.flatMap(s => s.points.map(p => ({ i: monthIndex(p.date), v: p.value })));
    if (!all.length) return null;
    const x0 = Math.min(...all.map(p => p.i)), x1 = Math.max(...all.map(p => p.i));
    const top = Math.max(...all.map(p => p.v)) * 1.05;
    const tick = niceStep(top / 4);
    const yMax = Math.ceil(top / tick) * tick;
    // On narrow screens the plot gets the full width; the value is in the tooltip instead of at the line end.
    const showLabels = labels && width >= 560;
    const labelW = showLabels ? Math.min(180, width * 0.26) : 0;
    const pad = { l: 48, r: showLabels ? labelW + 12 : 12, t: 12, b: 28 };
    const iw = Math.max(80, width - pad.l - pad.r), ih = height - pad.t - pad.b;
    const x = (i: number) => pad.l + (x1 === x0 ? iw / 2 : ((i - x0) / (x1 - x0)) * iw);
    const y = (v: number) => pad.t + ih - (v / yMax) * ih;
    const ticks = Array.from({ length: Math.round(yMax / tick) + 1 }, (_, k) => k * tick);
    const span = x1 - x0;
    const maxTicks = Math.max(2, Math.floor(iw / 72));
    const every = [1, 2, 3, 6, 12, 24, 36, 60, 120].find(e => span / e <= maxTicks) ?? 120;
    const yearsOnly = every >= 12;
    const xticks: number[] = [];
    // Year steps start on a January so the labels read 2020, 2022, 2024.
    const first = yearsOnly ? Math.ceil(x0 / 12) * 12 : x0;
    for (let i = first; i <= x1; i += every) xticks.push(i);

    const lines = clean.map((s, si) => {
      const pts = s.points.map(p => ({ i: monthIndex(p.date), v: p.value })).sort((a, b) => a.i - b.i);
      // Draw each stretch; a gap of more than two months is drawn dashed so the line never pretends to know.
      const segs: Array<{ d: string; dashed: boolean }> = [];
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k];
        const d = step ? `M${x(a.i)},${y(a.v)} H${x(b.i)} V${y(b.v)}` : `M${x(a.i)},${y(a.v)} L${x(b.i)},${y(b.v)}`;
        segs.push({ d, dashed: !step && b.i - a.i > 2 });
      }
      const last = pts[pts.length - 1];
      return { name: s.name, color: s.color ?? SERIES[si % SERIES.length], pts, segs, last, ly: y(last.v) };
    });
    // End labels: keep them at least 16px apart.
    const order = [...lines].sort((a, b) => a.ly - b.ly);
    for (let k = 1; k < order.length; k++) if (order[k].ly - order[k - 1].ly < 16) order[k].ly = order[k - 1].ly + 16;
    return { x0, x1, x, y, ticks, xticks, yearsOnly, showLabels, lines, pad, iw, ih };
  }, [clean, width, height, step]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!geo) return null;
  const { x, y, ticks, xticks, yearsOnly, showLabels, lines, pad, iw, x0, x1 } = geo;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = (e.clientX - r.left) / r.width;
    setHover(Math.round(x0 + t * (x1 - x0)));
  };
  const at = (pts: Array<{ i: number; v: number }>, i: number) => {
    let best: { i: number; v: number } | null = null;
    for (const p of pts) if (p.i <= i) best = p;
    return best && i - best.i <= 1 ? best : step ? best : null;
  };
  const tip = hover === null ? null : lines.map(l => ({ name: l.name, color: l.color, p: at(l.pts, hover) }));
  const tipLeft = hover === null ? 0 : x(hover);

  return (
    <div ref={ref} className="relative w-full min-w-0 select-none">
      <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} stroke="#e3e2ea" />
            <text x={pad.l - 10} y={y(t) + 4} textAnchor="end" className="fill-ink-3 font-mono text-[12px]">{format(t)}</text>
          </g>
        ))}
        {xticks.map(i => (
          <text key={i} x={x(i)} y={height - 6} textAnchor="middle" className="fill-ink-3 font-mono text-[12px]">{monthLabel(i, yearsOnly)}</text>
        ))}
        {lines.map(l => (
          <g key={l.name}>
            {l.segs.map((s, k) => (
              <path key={k} d={s.d} fill="none" stroke={l.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={s.dashed ? "4 5" : undefined} strokeOpacity={s.dashed ? 0.45 : 1} />
            ))}
            <circle cx={x(l.last.i)} cy={y(l.last.v)} r={3.5} fill={l.color} stroke="#fff" strokeWidth={2} />
            {showLabels && (
              <g transform={`translate(${pad.l + iw + 12}, ${l.ly})`}>
                <rect x={0} y={-4} width={8} height={8} rx={2} fill={l.color} />
                <text x={14} y={4} className="fill-ink font-mono text-[12px]">
                  {l.name.length > 18 && lines.length > 1 ? l.name.slice(0, 17) + "..." : l.name} <tspan className="fill-ink-2">{format(l.last.v)}</tspan>
                </text>
              </g>
            )}
          </g>
        ))}
        {hover !== null && <line x1={tipLeft} x2={tipLeft} y1={pad.t} y2={pad.t + geo.ih} stroke="#16151d" strokeOpacity={0.25} />}
        {tip?.filter(t => t.p).map(t => <circle key={t.name} cx={x(t.p!.i)} cy={y(t.p!.v)} r={4} fill={t.color} stroke="#fff" strokeWidth={2} />)}
        <rect x={pad.l} y={pad.t} width={iw} height={geo.ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover !== null && tip && tip.length > 0 && (
        <div className="panel pointer-events-none absolute top-2 z-10 min-w-[160px] px-3 py-2 text-[13px]"
          style={{ left: Math.max(0, Math.min(tipLeft + 12, width - 200)) }}>
          <div className="mb-1 font-mono text-[12px] text-ink-3">{monthLong(hover)}</div>
          {tip.every(t => !t.p) && <div className="text-ink-2">No data for this month</div>}
          {tip.filter(t => t.p).map(t => (
            <div key={t.name} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px]" style={{ background: t.color }} />{t.name}</span>
              <span className="num font-mono">{format(t.p!.v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Horizontal bars with the value at the end. Hover shows the share of the total.
export function BarList({ rows, total, label }: { rows: Array<{ label: string; value: number; muted?: boolean }>; total?: number; label: string }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  const sum = total ?? rows.reduce((a, r) => a + r.value, 0);
  return (
    <div role="list" aria-label={label} className="space-y-[6px]">
      {rows.map(r => (
        <div key={r.label} role="listitem" title={`${r.label}: ${r.value} (${Math.round((r.value / sum) * 100)}%)`}
          className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-4 text-[14px] sm:grid-cols-[190px_1fr]">
          <span className="text-ink [overflow-wrap:anywhere]">{r.label}</span>
          <span className="flex items-center gap-2">
            <span className="h-[14px] rounded-r-[4px] transition-opacity group-hover:opacity-80"
              style={{ width: `${Math.max(1.5, (r.value / max) * 80)}%`, background: r.muted ? "#a9a8b6" : `var(--g-ink, ${SERIES[0]})` }} />
            <span className="num font-mono text-[12px] text-ink-2">{r.value.toLocaleString("en-US")}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
