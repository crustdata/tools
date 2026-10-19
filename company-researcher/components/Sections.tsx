// The research sections: results grouped under headings, one card per source. Each card is two layers at most: a
// frame that holds the title, and a white panel with the content. API details (field names, endpoints, credits) only
// show when "API details" is switched on (elements marked .dev-only). Nothing here calls an API.

import type { Brief, Company, Hiring, People, Person } from "@/lib/types";
import { compact, int, money, monthShort, pct, shortDate } from "@/lib/format";
import { BarList, LineChart, SERIES } from "./Charts";
import { SectionIcon } from "./Icons";

const ENRICH_DOCS = "https://docs.crustdata.com/company-docs/enrichment/reference";
const JOBS_DOCS = "https://docs.crustdata.com/job-docs/search/introduction";

// ---------- building blocks ----------

// One light colour per group, so the long results page has landmarks as you scroll: the card frames take a pale
// tint, the icons and the chip by the heading take the ink. Numbers and text stay on white. Red-orange is kept out
// because it already means "down".
export const GROUP_TONES: Record<string, { frame: string; ring: string; ink: string; soft: string; icon: string }> = {
  overview: { frame: "#f4f4f8", ring: "rgba(18,17,24,.12)", ink: "#4f46d8", soft: "#e3e0fd", icon: "profile" },
  people: { frame: "#eef8f3", ring: "rgba(18,128,90,.22)", ink: "#12805a", soft: "#d5f0e3", icon: "headcount" },
  hiring: { frame: "#edf5fc", ring: "rgba(3,105,161,.20)", ink: "#0369a1", soft: "#d6e9f8", icon: "postings" },
  money: { frame: "#fcf6e4", ring: "rgba(154,103,0,.22)", ink: "#946200", soft: "#f6e7bd", icon: "funding" },
  socials: { frame: "#fbf0f5", ring: "rgba(184,59,116,.20)", ink: "#b0386f", soft: "#f6dbe7", icon: "news" },
};

export function Group({ id, title, lede, children }: { id: string; title: string; lede?: string; children: React.ReactNode }) {
  const t = GROUP_TONES[id] ?? GROUP_TONES.overview;
  return (
    <section id={id} className="scroll-mt-20 pt-20 first-of-type:pt-0 lg:scroll-mt-6"
      style={{ "--g-frame": t.frame, "--g-ring": t.ring, "--g-ink": t.ink, "--g-soft": t.soft } as React.CSSProperties}>
      <div className="flex items-center gap-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--g-soft)] text-[var(--g-ink)]"><SectionIcon id={t.icon} size={22} /></span>
        <div>
          <h2 className="text-[28px] font-medium leading-tight tracking-[-0.02em]">{title}</h2>
          {lede && <p className="mt-0.5 text-[16px] text-ink-2">{lede}</p>}
        </div>
      </div>
      <div className="mt-8 grid grid-cols-1 items-start gap-6 lg:grid-cols-2">{children}</div>
    </section>
  );
}

export function Card({ id, title, api, note, href = ENRICH_DOCS, wide = false, tone = "white", children }: {
  id?: string; title: string; api?: string; note?: string; href?: string; wide?: boolean; tone?: "white" | "violet"; children: React.ReactNode;
}) {
  const violet = tone === "violet";
  return (
    <article id={id} className={`rise flex min-w-0 scroll-mt-20 flex-col self-stretch rounded-[20px] p-1.5 lg:scroll-mt-6 ${wide ? "lg:col-span-2" : ""} ${violet ? "bg-violet" : "bg-[var(--g-frame,#f4f4f8)] shadow-[inset_0_0_0_1px_var(--g-ring,rgba(18,17,24,.12))]"}`}>
      <header className="flex items-center justify-between gap-4 px-4 pb-2.5 pt-3">
        <h3 className={`flex items-center gap-2 text-[16px] font-medium tracking-[-0.01em] ${violet ? "text-white" : ""}`}>
          {id && <SectionIcon id={id} size={20} className={violet ? "text-white" : "text-[var(--g-ink,#4f46d8)]"} />}{title}
        </h3>
        {api && <a href={href} target="_blank" rel="noreferrer" className={`dev-only shrink-0 rounded-md px-2 py-[3px] font-mono text-[12px] ${violet ? "bg-white/15 text-white" : "bg-white text-ink-2 shadow-[0_0_0_1px_rgba(18,17,24,.12)] hover:text-violet"}`}>{api}</a>}
      </header>
      <div className="panel min-w-0 flex-1 p-6 md:p-7">{children}</div>
      {note && <p className={`px-4 pb-2 pt-3 text-[13px] leading-snug ${violet ? "text-white/90" : "text-ink-2"}`}>{note}</p>}
    </article>
  );
}

// A key number: label, optional change pill, the number, one line under it. No box: stats sit side by side.
export function Stat({ value, label, delta, threshold, sub, children }: { value: React.ReactNode; label: string; delta?: number | null; threshold?: number; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex h-6 items-center">
        <span className="truncate text-[13px] text-ink-2" title={label}>{label}</span>
      </div>
      {/* The change sits next to the number, so the label never gets cut and every number starts on the same line. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="num text-[28px] font-semibold leading-none tracking-[-0.02em]">{value}</span>
        {delta !== undefined && <DeltaPill v={delta} threshold={threshold} />}
      </div>
      {sub && <div className="mt-2 text-[13px] leading-snug text-ink-3">{sub}</div>}
      {children}
    </div>
  );
}

function StatRow({ children, cols = 4 }: { children: React.ReactNode; cols?: 2 | 3 | 4 | 6 }) {
  const grid = { 2: "grid-cols-2", 3: "grid-cols-2 sm:grid-cols-3", 4: "grid-cols-2 md:grid-cols-4", 6: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6" }[cols];
  return <div className={`grid ${grid} gap-x-6 gap-y-6`}>{children}</div>;
}

const tone = (v: number, threshold: number) => (v >= threshold ? "up" : v <= -threshold ? "down" : "flat");

// A percentage as a big number: the % sign is set smaller so the figure carries the weight. Small moves stay grey.
export function Pct({ v, threshold = 1 }: { v: number | null | undefined; threshold?: number }) {
  if (v === null || v === undefined) return <span className="text-ink-3">n/a</span>;
  const cls = { up: "text-violet", down: "text-down", flat: "text-ink" }[tone(v, threshold)];
  return <span className={`num ${cls}`}>{pct(v).replace("%", "")}<span className="ml-[1px] text-[0.62em] font-medium">%</span></span>;
}

// Change as a small pill: violet up, rust down, grey when the move is too small to matter.
export function DeltaPill({ v, threshold = 1 }: { v: number | null | undefined; threshold?: number }) {
  if (v === null || v === undefined) return null;
  const cls = { up: "bg-violet-soft text-violet", down: "bg-[#fde3d8] text-down", flat: "bg-wash text-ink-2" }[tone(v, threshold)];
  return <span className={`num inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium ${cls}`}>{pct(v)}</span>;
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-[16px] text-ink-2">{children}</p>;
const SubHead = ({ children }: { children: React.ReactNode }) => <h4 className="mb-2 text-[13px] font-medium text-ink-2">{children}</h4>;

function Table({ head, rows, align, hideOnMobile = [] }: { head: string[]; rows: React.ReactNode[][]; align?: Array<"l" | "r">; hideOnMobile?: number[] }) {
  const cell = (i: number) => `${hideOnMobile.includes(i) ? "hidden sm:table-cell" : ""} ${align?.[i] === "r" ? "num whitespace-nowrap text-right" : ""}`;
  return (
    <table className="rows-table w-full text-[14px]">
      <thead>
        <tr>{head.map((h, i) => <th key={i} className={`px-2 pb-2 text-[13px] font-medium text-ink-2 ${cell(i)} ${align?.[i] === "r" ? "" : "text-left"}`}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri}>{r.map((c, ci) => <td key={ci} className={`px-2 py-2.5 align-middle ${cell(ci)}`}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

// Placeholders shaped like the real card, so nothing jumps when data lands.
export function CardSkeleton({ id, title, wide = false, kind = "chart" }: { id?: string; title: string; wide?: boolean; kind?: "chart" | "profile" | "list" }) {
  return (
    <article id={id} aria-busy="true" className={`rounded-[20px] bg-[var(--g-frame,#f4f4f8)] p-1.5 shadow-[inset_0_0_0_1px_var(--g-ring,rgba(18,17,24,.12))] ${wide ? "lg:col-span-2" : ""}`}>
      {kind !== "profile" && <h3 className="flex items-center gap-2 px-4 pb-2.5 pt-3 text-[16px] font-medium text-ink-2">{id && <SectionIcon id={id} size={20} className="text-ink-3" />}{title}</h3>}
      <div className="panel p-6 md:p-7">
        {kind === "profile" ? (
          <>
            <div className="flex gap-5"><div className="skeleton h-14 w-14 rounded-xl" /><div className="flex-1 space-y-3"><div className="skeleton h-9 w-48" /><div className="skeleton h-4 w-[70%]" /><div className="skeleton h-4 w-[55%]" /></div></div>
            <div className="mt-8 grid grid-cols-2 gap-6 md:grid-cols-4">{[0, 1, 2, 3].map(i => <div key={i} className="space-y-2"><div className="skeleton h-3 w-20" /><div className="skeleton h-7 w-24" /></div>)}</div>
          </>
        ) : kind === "list" ? (
          <div className="space-y-3">{[0, 1, 2, 3].map(i => <div key={i} className="skeleton h-10 w-full" />)}</div>
        ) : (
          <><div className="grid grid-cols-3 gap-6">{[0, 1, 2].map(i => <div key={i} className="space-y-2"><div className="skeleton h-3 w-16" /><div className="skeleton h-7 w-20" /></div>)}</div><div className="skeleton mt-6 h-40 w-full" /></>
        )}
      </div>
    </article>
  );
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join("");

// ---------- overview ----------

function Spark({ points }: { points: number[] }) {
  if (points.length < 3) return null;
  const w = 120, h = 26, min = Math.min(...points), max = Math.max(...points);
  const d = points.map((v, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / Math.max(1, max - min)) * (h - 4)).toFixed(1)}`).join(" ");
  return <svg width={w} height={h} className="mt-2.5 block" aria-hidden><path d={d} fill="none" stroke="var(--color-violet)" strokeWidth={1.75} strokeLinejoin="round" /></svg>;
}

// Funding, said the way a seller would say it: a public company is "Public", not "Series E in 2012".
function lastRoundStat(c: Company) {
  const f = c.funding;
  if (c.ownership === "public") return { value: "Public", sub: c.funding?.lastRound?.date ? `last private round ${monthShort(c.funding.lastRound.date)}` : "listed company" };
  if (c.ownership === "acquired") return { value: "Acquired", sub: f?.acquiredBy[0] ? `by ${f.acquiredBy[0]}` : undefined };
  if (!f?.lastRound?.type) return { value: "n/a", sub: undefined };
  return { value: f.lastRound.type, sub: [f.lastRound.amountUsd ? money(f.lastRound.amountUsd) : null, monthShort(f.lastRound.date)].filter(Boolean).join(", ") };
}

export function ProfileCard({ c }: { c: Company }) {
  const h = c.headcount;
  const lr = lastRoundStat(c);
  const meta = [c.industry, c.headquarters?.split(",").slice(0, 2).join(","), c.founded && `Founded ${c.founded}`].filter(Boolean) as string[];
  return (
    <article id="profile" className="rise scroll-mt-20 rounded-[20px] bg-frame p-1.5 shadow-[inset_0_0_0_1px_rgba(18,17,24,.12)] lg:col-span-2 lg:scroll-mt-6">
      <div className="panel p-6 md:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
          {c.logoUrl ? <img src={c.logoUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl bg-white object-contain shadow-[0_0_0_1px_rgba(18,17,24,.12)]" />
            : <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-xl font-semibold text-violet">{initials(c.name)}</div>}
          <div className="min-w-0 flex-1">
            <h2 className="text-[40px] font-medium leading-none tracking-[-0.025em]">{c.name}</h2>
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[14px] text-ink-2">
              <a href={`https://${c.domain}`} target="_blank" rel="noreferrer" className="whitespace-nowrap font-medium text-violet hover:underline">{c.domain}</a>
              {meta.map(x => <span key={x} className="whitespace-nowrap">{x}</span>)}
            </p>
            {c.description && <p className="mt-4 line-clamp-3 max-w-[760px] text-[16px] leading-relaxed text-ink-2">{c.description}</p>}
            {c.categories.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">{c.categories.slice(0, 5).map(t => <span key={t} className="rounded-full bg-wash px-3 py-1 text-[13px] text-ink-2">{t}</span>)}</div>
            )}
          </div>
        </div>
        <div className="mt-7 border-t border-rule pt-6">
          <StatRow>
            <Stat value={int(h?.total)} label="People" delta={h?.growthPercent.m12 ?? null} sub={h?.growthPercent.m12 !== null && h?.growthPercent.m12 !== undefined ? "12 month change" : undefined}>{h && <Spark points={h.monthly.map(p => p.count)} />}</Stat>
            <Stat value={c.ownership === "public" ? "Public" : money(c.funding?.totalUsd)} label={c.ownership === "public" ? "Ownership" : "Total raised"} sub={c.ownership !== "public" && c.funding?.roundCount ? `${c.funding.roundCount} rounds` : undefined} />
            <Stat value={lr.value} label="Last round" sub={lr.sub} />
            <Stat value={c.webTraffic?.[0] ? compact(c.webTraffic[0].monthlyVisitors) : "n/a"} label="Monthly visits" delta={c.webTraffic?.[0]?.mom ?? null} threshold={3} sub={c.webTraffic?.[0] ? "1 month change" : undefined} />
          </StatRow>
        </div>
      </div>
    </article>
  );
}

export function BriefCard({ brief }: { brief: Brief | null }) {
  if (!brief) return (
    <article id="brief" aria-busy="true" className="scroll-mt-20 rounded-[20px] bg-violet p-1.5 lg:col-span-2 lg:scroll-mt-6">
      <h3 className="flex items-center gap-2 px-4 pb-2.5 pt-3 text-[16px] font-medium text-white"><SectionIcon id="brief" size={20} className="text-white" />The brief</h3>
      <div className="panel space-y-3 p-6"><div className="skeleton h-5 w-[95%]" /><div className="skeleton h-5 w-[85%]" /><div className="skeleton h-5 w-[65%]" /></div>
      <p className="px-4 pb-2 pt-3 text-[13px] text-white/90">Written once headcount, hiring and leadership are in.</p>
    </article>
  );
  return (
    <Card id="brief" wide tone="violet" title="The brief" note={brief.ai ? `Written by ${brief.ai.model} from the data on this page.` : brief.aiError ? `AI brief skipped: ${brief.aiError} Showing the standard brief.` : undefined}>
      {brief.ai ? <AiText text={brief.ai.text} /> : (
        <>
          <p className="max-w-[760px] text-[18px] leading-[1.6] text-ink">{brief.lead ?? brief.summary}</p>
          <div className="mt-8 grid gap-x-10 gap-y-8 border-t border-rule pt-7 lg:grid-cols-2">
            <div>
              <h4 className="text-[14px] font-semibold">What changed lately</h4>
              <ul className="mt-3 space-y-3 text-[14px] leading-6 text-ink-2">
                {brief.changes.map((s, i) => <li key={i} className="flex items-start gap-3"><span className="mt-[9.5px] h-1.5 w-1.5 shrink-0 rounded-full bg-violet" />{s}</li>)}
              </ul>
            </div>
            <div>
              <h4 className="text-[14px] font-semibold">Three questions to ask</h4>
              <ol className="mt-3 space-y-3">
                {brief.questions.map((q, i) => (
                  <li key={i} className="flex items-start gap-3 text-[14px] leading-6">
                    {/* Optical centring: the circle's middle sits between the capital and lowercase middles of the first line
                        (12.5px into a 24px line), and pt-px moves the digit down half a pixel inside the circle. */}
                    <span className="num mt-[1.5px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-violet pt-px text-[12px] font-semibold leading-none text-white">{i + 1}</span>
                    <span className="min-w-0">{q}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

// The AI's brief is short markdown: paragraphs, bold labels, bullet and numbered lists. Rendered without a library.
function inline(t: string) {
  return t.split(/(\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith("**") ? <strong key={i} className="font-semibold text-ink">{part.slice(2, -2)}</strong> : part);
}
export function AiText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i} className="pl-1">{inline(it)}</li>);
    blocks.push(list.ordered
      ? <ol key={blocks.length} className="my-2 list-decimal space-y-1.5 pl-6 marker:font-semibold marker:text-violet">{items}</ol>
      : <ul key={blocks.length} className="my-2 list-disc space-y-1.5 pl-6 marker:text-violet">{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const b = /^[-*]\s+(.*)/.exec(line), n = /^\d+[.)]\s+(.*)/.exec(line);
    if (b || n) {
      const ordered = !!n;
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
      list.items.push((b ?? n)![1]);
      continue;
    }
    flush();
    if (!line) continue;
    const h = /^#{1,4}\s+(.*)/.exec(line);
    blocks.push(h
      ? <h4 key={blocks.length} className="mt-4 text-[14px] font-semibold">{h[1]}</h4>
      : <p key={blocks.length} className="mt-3 first:mt-0">{inline(line)}</p>);
  }
  flush();
  return <div className="max-w-[820px] text-[16px] leading-[1.7] text-ink">{blocks}</div>;
}

// ---------- people ----------

export function HeadcountCards({ c }: { c: Company }) {
  const h = c.headcount;
  if (!h) return <Card id="headcount" wide title="Headcount"><Empty>Not available on this plan.</Empty></Card>;
  const periods: Array<[string, keyof typeof h.growthPercent]> = [["1 month", "m1"], ["3 months", "m3"], ["6 months", "m6"], ["12 months", "m12"], ["24 months", "m24"]];
  return (
    <>
      <Card id="headcount" wide title="Headcount over time" api="headcount.timeseries"
        note={h.monthlyJumpWarning ? "The one month change is unusually large and may be a data correction rather than real hiring or cuts." : undefined}>
        <StatRow cols={6}>
          <Stat value={int(h.total)} label="People" sub={h.asOf ? `as of ${monthShort(h.asOf)}` : undefined} />
          {periods.map(([label, k]) => (
            <Stat key={k} label={label} value={<Pct v={h.growthPercent[k]} />}
              sub={h.growthAbsolute[k] !== null ? `${h.growthAbsolute[k]! > 0 ? "+" : ""}${int(h.growthAbsolute[k])} people` : undefined} />
          ))}
        </StatRow>
        <div className="mt-8"><LineChart label={`${c.name} headcount by month`} series={[{ name: c.name, points: h.monthly.map(p => ({ date: p.date, value: p.count })) }]} height={240} /></div>
      </Card>

      <Card id="departments" wide title="Headcount by department" api="headcount.by_role"
        note={h.departmentsMonthly.length ? "Dashed lines cross months with no data." : undefined}>
        {h.departmentsMonthly.length > 0
          ? <LineChart labels={false} label={`${c.name} headcount by department`} series={h.departmentsMonthly.map(d => ({ name: d.name, points: d.points.map(p => ({ date: p.date, value: p.count })) }))} height={220} />
          : null}
        <div className={h.departmentsMonthly.length ? "mt-6" : ""}>
          <Table head={["Department", "People", "Share", "12 months"]} align={["l", "r", "r", "r"]} hideOnMobile={[2]}
            rows={h.byDepartment.slice(0, 8).map(d => {
              const idx = h.departmentsMonthly.findIndex(x => x.name === d.name);
              return [
                <span key="n" className="flex items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: idx >= 0 ? SERIES[idx] : "#a9a8b6" }} />{d.name}</span>,
                int(d.count), d.share === null ? "n/a" : `${Math.round(d.share)}%`, <DeltaPill key="g" v={d.growth12m} />,
              ];
            })} />
        </div>
      </Card>

      <Card id="locations" title="Where they work" api="headcount.by_region">
        <div className="space-y-7">
          <PlaceBars title="Countries" rows={h.byCountry.slice(0, 5)} />
          <PlaceBars title="Cities and metro areas" rows={h.byMetro.slice(0, 5)} />
          {!h.byCountry.length && !h.byMetro.length && <Empty>No location split for this company.</Empty>}
        </div>
      </Card>
    </>
  );
}

function PlaceBars({ title, rows }: { title: string; rows: Array<{ name: string; count: number }> }) {
  if (!rows.length) return null;
  return (
    <div>
      <SubHead>{title}</SubHead>
      <BarList label={title} rows={rows.map(r => ({ label: r.name, value: r.count }))} />
    </div>
  );
}

export function RatingsCard({ c }: { c: Company }) {
  const r = c.employeeRatings;
  const rows = r ? ([["Culture", r.culture], ["Work life balance", r.workLife], ["Career growth", r.careerGrowth], ["Senior management", r.management], ["Pay and benefits", r.compensation]] as Array<[string, number | null]>).filter(([, v]) => v !== null) : [];
  const basis = r?.ratingsCount ? `${int(r.ratingsCount)} ${r.ratingsCount === 1 ? "rating" : "ratings"}` : undefined;
  return (
    <Card id="ratings" title="Employee ratings" api="employee_reviews"
      note={r?.lowSample ? "Too few ratings to read much into." : undefined}>
      {r?.lowSample ? (
        // Two ratings say nothing, so the card says so instead of showing a big score.
        <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-wash text-ink-3"><SectionIcon id="ratings" size={26} /></span>
          <p className="text-[15px] font-medium">Only {basis ?? "a few ratings"}</p>
          <p className="num text-[13px] text-ink-2">{r.overall?.toFixed(1)} / 5 so far</p>
        </div>
      ) : r ? (
        <div>
          <Stat value={<>{r.overall?.toFixed(1)}<span className="text-[18px] font-medium text-ink-3"> / 5</span></>} label="Overall"
            sub={[basis, r.recommendPercent !== null ? `${r.recommendPercent}% would recommend` : null].filter(Boolean).join(", ")} />
          {rows.length > 0 && (
            <dl className="rows mt-6">
              {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between py-2.5 text-[14px]"><dt className="text-ink-2">{k}</dt><dd className="num font-semibold">{v!.toFixed(1)}</dd></div>
              ))}
            </dl>
          )}
        </div>
      ) : <Empty>No employee ratings on record.</Empty>}
    </Card>
  );
}

function PersonRow({ p, isNew }: { p: Person; isNew: boolean }) {
  const body = (
    <div className="flex items-start gap-3.5 rounded-xl p-2.5 transition-colors hover:bg-row-hover">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${isNew ? "bg-violet text-white" : "bg-violet-soft text-violet"}`}>{initials(p.name)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 text-[14px] font-medium">{p.name}{isNew && <span className="rounded-full bg-violet-soft px-2 py-0.5 text-[12px] font-medium text-violet">New</span>}</span>
        <span className="block text-[13px] leading-snug text-ink-2">{p.title}</span>
        {p.startDate && <span className="block text-[13px] text-ink-3">since {monthShort(p.startDate)}</span>}
      </span>
    </div>
  );
  return p.profileUrl ? <a href={p.profileUrl} target="_blank" rel="noreferrer" className="block min-w-0">{body}</a> : body;
}

export function LeadershipCard({ p }: { p: People }) {
  const isNew = (x: Person) => p.recentJoins.some(r => r.name === x.name);
  const newFirst = (l: Person[]) => [...l.filter(isNew), ...l.filter(x => !isNew(x))];
  const groups: Array<[string, Person[]]> = [
    ["Founders", p.founders.slice(0, 4)],
    ["Executives", newFirst(p.executives).slice(0, 8)],
    ["Other decision makers", newFirst(p.decisionMakers.filter(d => !p.executives.includes(d))).slice(0, 8)],
  ];
  const turnover = p.executiveStarts12m >= 3 ? ` ${p.executiveStarts12m} executives started in the last 12 months.` : "";
  return (
    <Card id="leadership" wide title="Leadership" api="people">
      {p.startDatesKnown && (
        <p className="mb-5 text-[14px] text-ink-2">{p.recentJoins.length ? <><span className="font-medium text-violet">{p.recentJoins.length} started in the last 90 days</span>, marked New.</> : "No one here started in the last 90 days."}{turnover}</p>
      )}
      {groups.every(([, l]) => !l.length) && <Empty>No leadership records for this company.</Empty>}
      <div className="space-y-6">
        {groups.filter(([, l]) => l.length).map(([label, list]) => (
          <div key={label}>
            <SubHead>{label}</SubHead>
            <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">{list.map(x => <PersonRow key={x.name} p={x} isNew={isNew(x)} />)}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------- hiring ----------

// "San Francisco, California, United States" -> "San Francisco"; "New York City Metropolitan Area" -> "New York City"
const cityOf = (loc: string | null) => loc?.split(",")[0].replace(/\s+Metropolitan Area$/i, "").replace(/\s+Area$/i, "").trim() ?? "";

export function HiringCard({ j, name, salesOnly, setSalesOnly }: { j: Hiring | null; name: string; salesOnly: boolean; setSalesOnly: (v: boolean) => void }) {
  if (!j) return <Card id="postings" wide title="Hiring" href={JOBS_DOCS}><Empty>Job search did not respond for this company. Try again in a minute.</Empty></Card>;
  const rows = j.byRoleType.map(b => ({ label: b.type, value: b.count, muted: b.type === "Other" }));
  const list = j.newest.filter(x => !salesOnly || x.roleType === "Sales");
  return (
    <Card id="postings" wide title="Hiring" api="/job/search" href={JOBS_DOCS}
      note="Role types are read from posting titles. Counts are by the date a posting was added, not whether it is still open.">
      <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div>
          <StatRow cols={3}>
            <Stat value={int(j.postingsLast90d)} label="Postings" sub="last 90 days" />
            {j.postingsPrev90d !== null && <Stat value={<Pct v={j.changePercent} threshold={5} />} label="Change" sub={`vs ${int(j.postingsPrev90d)} before`} />}
            <Stat value={int(j.salesRoles)} label="Sales roles" sub="last 90 days" />
          </StatRow>
          {rows.length > 0 && <div className="mt-8"><BarList label={`${name} job postings by role type`} rows={rows} total={j.postingsLast90d ?? undefined} /></div>}
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <SubHead>Newest postings</SubHead>
            <div className="mb-2 flex rounded-full bg-wash p-0.5 text-[13px]" role="group" aria-label="Filter postings">
              {([["All", false], ["Sales", true]] as Array<[string, boolean]>).map(([l, v]) => (
                <button key={l} type="button" aria-pressed={salesOnly === v} onClick={() => setSalesOnly(v)}
                  className={`rounded-full px-3 py-1 ${salesOnly === v ? "bg-white text-ink shadow-[0_0_0_1px_rgba(18,17,24,.12)]" : "text-ink-2 hover:text-ink"}`}>{l}</button>
              ))}
            </div>
          </div>
          {list.length ? (
            <ul className="rows">
              {list.slice(0, 8).map((x, i) => (
                <li key={i} className="py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    {x.url ? <a href={x.url} target="_blank" rel="noreferrer" className="min-w-0 text-[14px] font-medium leading-snug hover:text-violet">{x.title}</a> : <span className="min-w-0 text-[14px] font-medium leading-snug">{x.title}</span>}
                    <span className="num shrink-0 text-[13px] text-ink-3">{shortDate(x.date)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                    {cityOf(x.location) && <span>{cityOf(x.location)}</span>}
                    {x.workplace && <span className="rounded-full bg-wash px-2 py-0.5 text-[12px]">{x.workplace}</span>}
                    <span className="rounded-full bg-violet-soft px-2 py-0.5 text-[12px] text-violet">{x.roleType}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty>{salesOnly ? "No sales roles among the newest postings." : "No postings found."}</Empty>}
        </div>
      </div>
    </Card>
  );
}

// ---------- money ----------

export function FundingCard({ c }: { c: Company }) {
  const f = c.funding;
  if (!f) return <Card id="funding" wide title="Funding"><Empty>No funding on record.</Empty></Card>;
  const priced = f.rounds.filter(r => r.date && r.amountUsd && !r.secondary).sort((a, b) => a.date!.localeCompare(b.date!));
  let sum = 0;
  const cumulative = priced.map(r => ({ date: r.date!.slice(0, 7), value: (sum += r.amountUsd!) }));
  const lr = lastRoundStat(c);
  return (
    <Card id="funding" wide title="Funding" api="funding"
      note={f.secondaryUsd ? `Secondary sales (${money(f.secondaryUsd)}) move existing shares, so they are listed but not counted as money raised.` : undefined}>
      <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div>
          <StatRow cols={2}>
            <Stat value={money(f.totalUsd)} label="Total raised" sub={f.roundCount ? `${f.roundCount} rounds` : undefined} />
            <Stat value={lr.value} label="Last round" sub={lr.sub} />
          </StatRow>
          {cumulative.length >= 2 && <div className="mt-8"><LineChart step label="Money raised over time" format={v => money(v)} series={[{ name: "Raised", points: cumulative }]} height={200} /></div>}
        </div>
        <div>
          <SubHead>Rounds</SubHead>
          <ul className="rows">
            {f.rounds.map((r, i) => (
              <li key={i} className="grid grid-cols-[1fr_auto] gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[14px] font-medium">{r.type}{r.secondary && <span className="rounded-full bg-wash px-2 py-0.5 text-[12px] font-normal text-ink-2">not counted</span>}</div>
                  <div className="text-[13px] leading-snug text-ink-3">{monthShort(r.date)}{r.leadInvestors.length ? `, led by ${r.leadInvestors.slice(0, 3).join(", ")}` : ""}</div>
                </div>
                <div className="num text-[14px] font-semibold">{r.amountUsd ? money(r.amountUsd) : <span className="font-normal text-ink-3">undisclosed</span>}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {(f.investors.length > 0 || f.acquisitions.length > 0) && (
        <div className="mt-8 grid gap-8 border-t border-rule pt-6 md:grid-cols-2">
          {f.investors.length > 0 && <div><SubHead>Investors</SubHead><div className="flex flex-wrap gap-1.5">{f.investors.slice(0, 14).map(i => <span key={i} className="rounded-full bg-wash px-3 py-1 text-[13px]">{i}</span>)}{f.investors.length > 14 && <span className="px-1 py-1 text-[13px] text-ink-2">and {f.investors.length - 14} more</span>}</div></div>}
          {f.acquisitions.length > 0 && <div><SubHead>Acquisitions</SubHead><div className="flex flex-wrap gap-1.5">{f.acquisitions.map(a => <span key={a.name} className="rounded-full bg-wash px-3 py-1 text-[13px]">{a.name}{a.date ? `, ${monthShort(a.date)}` : ""}</span>)}</div></div>}
        </div>
      )}
    </Card>
  );
}

// ---------- market ----------

export function TrafficCard({ c }: { c: Company }) {
  return (
    <Card id="traffic" title="Traffic and audience" api="web_traffic">
      {c.webTraffic?.length ? (
        <ul className="rows">
          {c.webTraffic.slice(0, 4).map(t => (
            <li key={t.domain} className="grid grid-cols-[1fr_auto_4.5rem] items-center gap-4 py-2.5 text-[14px]">
              <span className="truncate">{t.domain}</span>
              <span className="num font-semibold">{compact(t.monthlyVisitors)}</span>
              <span className="text-right"><DeltaPill v={t.mom} threshold={3} /></span>
            </li>
          ))}
        </ul>
      ) : <Empty>No web traffic on record.</Empty>}
      {c.followers && (
        <div className="mt-6 border-t border-rule pt-5">
          <StatRow cols={3}>
            <Stat value={compact(c.followers.count)} label="Followers" />
            <Stat value={<Pct v={c.followers.m3} threshold={2} />} label="3 months" />
            <Stat value={<Pct v={c.followers.m12} threshold={2} />} label="12 months" />
          </StatRow>
        </div>
      )}
    </Card>
  );
}

export function CompetitorsCard({ c }: { c: Company }) {
  const k = c.competitors;
  const chips = (l: string[]) => <div className="flex flex-wrap gap-1.5">{l.map(d => <a key={d} href={`https://${d}`} target="_blank" rel="noreferrer" className="rounded-full bg-wash px-3 py-1 text-[13px] transition hover:bg-violet-soft hover:text-violet">{d}</a>)}</div>;
  return (
    <Card id="competitors" title="Search competitors" api="competitors" note="Sites competing for the same searches. Check them before you quote them.">
      {k ? (
        <div className="space-y-6">
          {k.paidSearch.length > 0 && <div><SubHead>Bid on the same search ads</SubHead>{chips(k.paidSearch)}</div>}
          {k.organicSearch.length > 0 && <div><SubHead>Rank for the same searches</SubHead>{chips(k.organicSearch)}</div>}
        </div>
      ) : <Empty>No search competitors on record.</Empty>}
    </Card>
  );
}

function Skipped({ text, onRunFull }: { text: string; onRunFull?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Empty>{text}</Empty>
      {onRunFull && text.includes("lite") && <button type="button" onClick={onRunFull} className="rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white hover:bg-violet">Run full research</button>}
    </div>
  );
}

export function TechCard({ c, skipped, onRunFull }: { c: Company; skipped: string | null; onRunFull?: () => void }) {
  return (
    <Card id="tech" wide title="Tech stack" api="technographics">
      {c.techStack?.byCategory.length ? (
        <>
          <p className="mb-6 text-[14px] text-ink-2"><span className="num font-semibold text-ink">{int(c.techStack.total)}</span> technologies seen on the website and in job postings. The main ones:</p>
          <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
            {c.techStack.byCategory.map(g => (
              <div key={g.category}>
                <SubHead>{g.category}</SubHead>
                <div className="flex flex-wrap gap-1.5">{g.names.map(n => <span key={n} className="rounded-full bg-wash px-3 py-1 text-[13px]">{n}</span>)}</div>
              </div>
            ))}
          </div>
        </>
      ) : <Skipped text={skipped ?? "No technologies detected."} onRunFull={onRunFull} />}
    </Card>
  );
}

export function NewsCard({ c }: { c: Company }) {
  return (
    <Card id="news" wide title="Latest news" api="news" note={c.news.length ? `Articles from the last 90 days that name ${c.name}.` : undefined}>
      {c.news.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {c.news.slice(0, 6).map((n, i) => (
            <a key={i} href={n.url} target="_blank" rel="noreferrer" className="flex flex-col justify-between rounded-[14px] bg-row p-4 transition hover:bg-row-hover">
              <span className="line-clamp-3 text-[14px] font-medium leading-snug">{n.title}</span>
              <span className="mt-4 text-[13px] text-ink-2">{[n.publisher, shortDate(n.date)].filter(Boolean).join(", ")}</span>
            </a>
          ))}
        </div>
      ) : <Empty>No articles naming {c.name} in the last 90 days.</Empty>}
    </Card>
  );
}

export function PostsCard({ c, skipped, onRunFull }: { c: Company; skipped: string | null; onRunFull?: () => void }) {
  return (
    <Card id="posts" wide title="Recent posts" api="social_posts">
      {c.posts.length ? (
        <div className="grid gap-3 md:grid-cols-3">
          {c.posts.slice(0, 3).map((p, i) => {
            const inner = (
              <>
                <p className="line-clamp-5 text-[14px] leading-relaxed">{p.text}</p>
                <div className="mt-4 flex justify-between text-[13px] text-ink-2">
                  <span>{shortDate(p.date)}</span>
                  {p.reactions ? <span className="num">{int(p.reactions)} reactions</span> : null}
                </div>
              </>
            );
            return p.url
              ? <a key={i} href={p.url} target="_blank" rel="noreferrer" className="flex flex-col justify-between rounded-[14px] bg-row p-4 transition hover:bg-row-hover">{inner}</a>
              : <div key={i} className="flex flex-col justify-between rounded-[14px] bg-row p-4">{inner}</div>;
          })}
        </div>
      ) : <Skipped text={skipped ?? "No recent posts."} onRunFull={onRunFull} />}
    </Card>
  );
}

// ---------- sources and definitions ----------

const DEFINITIONS: Array<[string, string]> = [
  ["Headcount", "People whose current role is at this company, counted weekly from 1B+ profiles. Growth compares today with 1, 3, 6, 12 and 24 months ago."],
  ["Department", "The function people work in, read from their current title and role. Shares are of total headcount."],
  ["Job postings", "Listings first posted in the window, counted by the date they were added at the source. Role types are read from the titles."],
  ["Leadership", "Founders, C-level executives and other decision makers whose current role here has a start date. New means it started in the last 90 days."],
  ["Funding", "Disclosed rounds, investors and acquisitions. Secondary sales move existing shares and are not counted as money raised."],
  ["Credits", "About 9.45 Crustdata credits per company (2.45 in Lite). Repeats within 24 hours are free."],
];

export function SourcesSection() {
  return (
    <section id="sources" className="scroll-mt-20 pt-20 lg:scroll-mt-6">
      <details className="group rounded-[20px] bg-frame p-1.5 shadow-[inset_0_0_0_1px_rgba(18,17,24,.12)]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-[14px] px-4 py-3.5 text-[16px] font-medium marker:hidden hover:text-violet">
          How these numbers are counted
          <span className="text-[13px] font-normal text-ink-2 group-open:hidden">Show</span>
          <span className="hidden text-[13px] font-normal text-ink-2 group-open:inline">Hide</span>
        </summary>
        <dl className="mt-1 grid gap-1.5 md:grid-cols-2">
          {DEFINITIONS.map(([k, v]) => <div key={k} className="panel p-5"><dt className="text-[14px] font-medium">{k}</dt><dd className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{v}</dd></div>)}
        </dl>
        <p className="px-4 pb-2 pt-3 text-[13px] text-ink-2">Every number comes from the <a className="text-violet hover:underline" href="https://docs.crustdata.com">Crustdata API</a>: 1B+ profiles and 60M+ companies.</p>
      </details>
    </section>
  );
}
