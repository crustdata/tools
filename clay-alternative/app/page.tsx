"use client";

// One page, three states: empty (drop, paste or a sample), configure (what was read, the column picker, the estimate),
// running and done (the table fills in from one streamed POST /api/enrich response, then export).
// The three samples replay stored results from public/samples/results.json, so a demo costs nothing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyIcon, DownloadSimpleIcon, CheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { TopBar } from "@/components/TopBar";
import { KeyBox } from "@/components/KeyBox";
import { DropZone, SAMPLE_LABELS, type SampleKind } from "@/components/DropZone";
import { ColumnPicker } from "@/components/ColumnPicker";
import { ResultsTable } from "@/components/ResultsTable";
import { CostBar } from "@/components/CostBar";
import type { Check, ColumnInfo } from "@/components/types";
import { isExcel, readCsv, readList, type Detected } from "@/lib/csv";
import { ndjsonReader, type RunEvent, type Summary } from "@/lib/events";
import { buildOutput } from "@/lib/export";
import { defaultsFor, resolveColumns } from "@/lib/columns";
import { describeEstimate } from "@/lib/plan";
import type { Cell, CostSummary, Estimate, RowStatus } from "@/lib/types";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const REPO = "https://github.com/crustdata/tools/tree/main/clay-alternative";
const KEY_STORE = "clay-alternative:crustdata-key";

type Stage = "empty" | "configure" | "running" | "done";
type Source = { name: string; detected: Detected; sample?: SampleKind };
type SampleResults = Record<string, { events: RunEvent[]; columns: string[]; fetchedAt: string }>;
class ApiError extends Error { constructor(message: string, public needsKey = false, public status = 0) { super(message); } }

async function api<T>(path: string, init: RequestInit = {}, apiKey?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (apiKey) headers.set("x-crustdata-key", apiKey);
  let res: Response;
  try { res = await fetch(`${BASE}${path}`, { ...init, headers }); }
  catch (err) { if ((err as Error).name === "AbortError") throw err; throw new ApiError("Could not reach the server. Check your connection and try again."); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, !!body?.needsKey, res.status);
  return body as T;
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

const countsText = (d: Detected) => {
  const c = d.counts;
  const parts = [
    c.email && `${c.email} work ${c.email === 1 ? "email" : "emails"}`,
    c.personal_email && `${c.personal_email} personal ${c.personal_email === 1 ? "email" : "emails"}`,
    c.domain && `${c.domain} ${c.domain === 1 ? "domain" : "domains"}`,
    c.profile_url && `${c.profile_url} profile ${c.profile_url === 1 ? "URL" : "URLs"}`,
    c.company_name && `${c.company_name} company ${c.company_name === 1 ? "name" : "names"}`,
    c.unusable && `${c.unusable} without an identifier`,
  ].filter(Boolean);
  return parts.join(", ");
};

export default function Page() {
  const [stage, setStage] = useState<Stage>("empty");
  const [source, setSource] = useState<Source | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [check, setCheck] = useState<Check | null>(null);
  const [estimate, setEstimate] = useState<{ text: string; note: string; warnings: string[]; problems: number; pricing: "shown" | "hidden"; remaining: number | null } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [error, setError] = useState("");
  const [apiKey, setApiKeyState] = useState("");
  const [remember, setRememberState] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [cells, setCells] = useState<Map<number, Record<string, Cell>>>(new Map());
  const [status, setStatus] = useState<Map<number, RowStatus>>(new Map());
  const [progress, setProgress] = useState<{ people: [number, number]; companies: [number, number] }>({ people: [0, 0], companies: [0, 0] });
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [samples, setSamples] = useState<SampleResults | null>(null);
  const keyRef = useRef("");
  const abort = useRef<AbortController | null>(null);
  const runId = useRef(0);

  const persist = (k: string, on = remember) => { if (on && k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); };
  const setApiKey = (k: string) => { keyRef.current = k; setApiKeyState(k); persist(k); loadConfig(k); };
  const setRemember = (r: boolean) => { setRememberState(r); persist(keyRef.current, r); };

  const loadConfig = useCallback(async (k?: string) => {
    try {
      const [c, cols] = await Promise.all([api<Check>("/api/check", {}, k), api<{ columns: ColumnInfo[]; defaults: string[] }>("/api/columns", {}, k)]);
      setCheck(c);
      setColumns(cols.columns);
      setDefaults(cols.defaults);
      if (!c.serverKey && !k) setKeyOpen(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(KEY_STORE);
    if (saved) { keyRef.current = saved; setApiKeyState(saved); setRememberState(true); }
    loadConfig(saved ?? undefined);
    fetch(`${BASE}/samples/results.json`).then(r => (r.ok ? r.json() : null)).then(setSamples).catch(() => {});
  }, [loadConfig]);

  const hasPeople = !!source && (source.detected.counts.email + source.detected.counts.personal_email + source.detected.counts.profile_url) > 0;
  const hasCompanies = !!source && (source.detected.counts.email + source.detected.counts.personal_email + source.detected.counts.profile_url + source.detected.counts.domain + source.detected.counts.company_name) > 0;

  const pickDefaults = useCallback((d: Detected, ids: string[]) => {
    const people = d.counts.email + d.counts.personal_email + d.counts.profile_url > 0;
    const companies = people || d.counts.domain + d.counts.company_name > 0;
    const available = columns.length ? new Set(columns.filter(c => c.available).map(c => c.id)) : undefined;
    const base = ids === defaults ? defaultsFor(d.counts, available) : ids.filter(id => (!available || available.has(id)) && (id.startsWith("person.") ? people : companies));
    return new Set(base);
  }, [columns, defaults]);

  const configure = (src: Source, ids = defaults) => {
    abort.current?.abort();
    runId.current++;
    setSource(src);
    setSelected(pickDefaults(src.detected, ids));
    setCells(new Map()); setStatus(new Map()); setCost(null); setSummary(null); setRemaining(null); setNotes([]); setElapsed(0);
    setProgress({ people: [0, 0], companies: [0, 0] });
    setError("");
    setStage("configure");
  };

  const onFile = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (isExcel(bytes)) { setError(`${f.name} is an Excel file. Save it as CSV (File, Save As, CSV UTF-8) and drop that.`); return; }
    const d = readCsv(new TextDecoder().decode(bytes));
    if (!d.rows.length) { setError(`${f.name} has no rows with an email, a domain or a profile URL. Columns found: ${d.headers.join(", ") || "none"}.`); return; }
    configure({ name: f.name, detected: d });
  };
  const onPaste = (text: string) => {
    const d = readList(text);
    if (!d.rows.length) { setError("Nothing in that list looks like an email, a domain or a profile URL."); return; }
    configure({ name: "pasted list", detected: d });
  };
  const onSample = async (kind: SampleKind) => {
    const text = await fetch(`${BASE}/samples/${kind}.csv`).then(r => r.text());
    const d = readCsv(text);
    configure({ name: `${SAMPLE_LABELS[kind]} (sample)`, detected: d, sample: kind }, samples?.[kind]?.columns ?? defaults);
  };

  // The estimate: for a sample from its stored start event; otherwise a dry run on the server (free).
  useEffect(() => {
    if (stage !== "configure" || !source) return;
    if (!selected.size) { setEstimate(null); return; }
    if (source.sample) {
      const start = samples?.[source.sample]?.events.find(e => e.type === "start") as Extract<RunEvent, { type: "start" }> | undefined;
      const e: Estimate | undefined = start?.estimate;
      setEstimate({ text: e ? describeEstimate(e, "hidden") : `${source.detected.rows.length} rows`, note: "", warnings: [], problems: 0, pricing: "hidden", remaining: null });
      return;
    }
    const ctrl = new AbortController();
    setEstimating(true);
    const t = setTimeout(async () => {
      try {
        const r = await api<{ estimate: Estimate; warnings: string[]; problems: Array<{ line: number }>; pricing: "shown" | "hidden"; remaining: number | null }>("/api/enrich", {
          method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({ dryRun: true, headers: source.detected.headers, rows: source.detected.rows.slice(0, check?.maxRows ?? 500).map(r => ({ line: r.line, cells: r.cells })), columns: [...selected] }),
        }, keyRef.current || undefined);
        setEstimate({ text: describeEstimate(r.estimate, r.pricing), note: r.estimate.note ?? "", warnings: r.warnings, problems: r.problems.length, pricing: r.pricing, remaining: r.remaining });
        setRemaining(r.remaining);
        setError("");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setEstimate(null);
        setError((err as Error).message);
        if (err instanceof ApiError && err.needsKey) setKeyOpen(true);
      } finally { setEstimating(false); }
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [stage, source, selected, samples, apiKey]);

  const apply = useCallback((e: RunEvent) => {
    if (e.type === "cells") {
      setCells(m => { const n = new Map(m); n.set(e.row, { ...(n.get(e.row) ?? {}), ...e.cells }); return n; });
      if (e.status) setStatus(m => { const n = new Map(m); n.set(e.row, e.status!); return n; });
    } else if (e.type === "progress") setProgress(p => ({ ...p, [e.phase]: [e.done, e.total] }));
    else if (e.type === "cost") setCost(e.cost);
    else if (e.type === "note") setNotes(n => [...n, e.message]);
    else if (e.type === "error") setError(e.message);
    else if (e.type === "start") { setNotes(e.warnings); }
    else if (e.type === "done") { setCost(e.cost); setSummary(e.summary); setRemaining(e.remaining); setElapsed(e.elapsedMs); setStage("done"); }
  }, []);

  const run = async () => {
    if (!source || !selected.size) return;
    const id = ++runId.current;
    setStage("running");
    setError("");
    setCells(new Map()); setStatus(new Map()); setSummary(null); setCost(null);
    if (source.sample) {
      const stored = samples?.[source.sample];
      if (!stored) { setError("The stored sample results are missing from this deployment. Drop your own file instead."); setStage("configure"); return; }
      // Replay at a watchable pace: about 20 rows a second.
      for (const e of stored.events) {
        if (runId.current !== id) return;
        apply(e);
        if (e.type === "cells") await new Promise(r => setTimeout(r, 70));
      }
      return;
    }
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const headers = new Headers({ "content-type": "application/json" });
      if (keyRef.current) headers.set("x-crustdata-key", keyRef.current);
      const res = await fetch(`${BASE}/api/enrich`, { method: "POST", signal: ctrl.signal, headers,
        body: JSON.stringify({ headers: source.detected.headers, rows: source.detected.rows.slice(0, check?.maxRows ?? 500).map(r => ({ line: r.line, cells: r.cells })), columns: [...selected] }) });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(body?.error ?? `Request failed (${res.status})`, !!body?.needsKey, res.status);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const nd = ndjsonReader(e => { if (runId.current === id) apply(e); });
      for (;;) { const { value, done } = await reader.read(); if (done) break; nd.push(dec.decode(value, { stream: true })); }
      nd.end();
      if (runId.current === id) setStage(s => (s === "running" ? "done" : s));
    } catch (err) {
      if ((err as Error).name === "AbortError" || runId.current !== id) return;
      setError((err as Error).message);
      setStage("configure");
      if (err instanceof ApiError && err.needsKey) setKeyOpen(true);
    }
  };

  const chosen = useMemo(() => columns.filter(c => selected.has(c.id)), [columns, selected]);
  const output = useMemo(() => {
    if (!source || stage === "empty" || stage === "configure") return null;
    const { columns: cols } = resolveColumns(chosen.map(c => c.id));
    return buildOutput(source.detected.rows, cols, cells, status, source.detected.headers);
  }, [source, stage, chosen, cells, status]);

  const stem = source ? source.name.replace(/\.csv$/i, "").replace(/[^a-z0-9-]+/gi, "-").toLowerCase() : "enriched";
  const home = () => { abort.current?.abort(); runId.current++; setSource(null); setStage("empty"); setError(""); };
  const tooMany = !!source && !!check && !source.sample && source.detected.rows.length > check.maxRows;

  return (
    <div className="min-h-dvh">
      <TopBar repo={REPO} onHome={home} keyTail={apiKey ? apiKey.slice(-4) : ""} onKey={() => setKeyOpen(o => !o)} />
      <main className={`mx-auto max-w-[1280px] px-5 pb-20 sm:px-6 ${stage === "empty" ? "pt-14" : "pt-7"}`}>
        {keyOpen && (
          <div className="mb-6">
            <KeyBox value={apiKey} serverKey={!!check?.serverKey} onUse={setApiKey} onRemove={() => setApiKey("")} onClose={() => setKeyOpen(false)} remember={remember} setRemember={setRemember}
              verify={async k => {
                const r = await api<Check>("/api/check?probe=email", {}, k);
                const bits = [r.credits !== null && r.credits !== undefined ? `${Math.round(r.credits).toLocaleString("en-US")} credits` : null, r.emailLookup === false ? "no email lookup" : null, r.emailColumn ? "contact data on" : "no contact data"].filter(Boolean);
                return `Key works: ${bits.join(", ")}.`;
              }} />
          </div>
        )}

        {stage === "empty" && (
          <section className="relative">
            <div className="grid-bg pointer-events-none absolute inset-x-0 -top-14 h-[420px]" aria-hidden />
            <div className="relative mx-auto max-w-[720px] text-center">
              <h1 className="text-[34px] font-medium leading-[1.15] tracking-[-0.01em] sm:text-[42px]">Enrich a CSV with person and company data</h1>
              <p className="mx-auto mt-4 max-w-[560px] text-[16px] leading-relaxed text-ink-2">
                An open-source alternative to Clay and fire-enrich. Drop a list of work emails, company domains or profile URLs, pick the columns, watch the table fill in from Crustdata, then export. One API key, no AI key.
              </p>
            </div>
            <div className="relative mx-auto mt-9 max-w-[760px]">
              <DropZone onFile={onFile} onPaste={onPaste} onSample={onSample} error={error} />
            </div>
            <div className="mx-auto mt-10 grid max-w-[760px] gap-3 text-[13px] text-ink-2 sm:grid-cols-3">
              {[["1B+ profiles, 60M+ companies", "Every cell is a field read from a Crustdata record, never a guess."],
                ["Cost before and after", "An estimate before the first paid call, the real total after. Company lookup and misses are free."],
                ["Yours to run", "Open source. Deploy it with your own key, or run the CLI on big files, where a cache means a re-run pays nothing."]].map(([h, t]) => (
                <div key={h} className="panel px-4 py-3"><div className="text-[14px] font-medium text-ink">{h}</div><div className="mt-1 leading-relaxed">{t}</div></div>
              ))}
            </div>
          </section>
        )}

        {stage === "configure" && source && (
          <section className="rise">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-[22px] font-medium">{source.name}</h2>
                <p className="mt-1 text-[14px] text-ink-2">
                  {source.detected.rows.length} {source.detected.rows.length === 1 ? "row" : "rows"}: {countsText(source.detected)}
                  {source.detected.duplicates ? `, ${source.detected.duplicates} ${source.detected.duplicates === 1 ? "row shares" : "rows share"} an identifier with another row (looked up once)` : ""}.
                  {Object.keys(source.detected.roles).length > 0 && <span className="text-ink-3"> Columns read: {Object.entries(source.detected.roles).map(([r, h]) => `${h} (${r.replace("profileUrl", "profile URL").replace("firstName", "first name").replace("lastName", "last name")})`).join(", ")}.</span>}
                </p>
              </div>
              <button type="button" onClick={home} className="btn btn-ghost">Change file</button>
            </div>
            {tooMany && (
              <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-soft px-4 py-3 text-[13px] text-amber"><WarningCircleIcon size={18} className="mt-0.5 shrink-0" aria-hidden />
                <span>Only the first {check!.maxRows} rows run on this page. For the whole file use the command line: <code className="font-mono">npm run enrich -- your-file.csv</code> (see Get the code).</span></p>
            )}
            {source.sample && samples?.[source.sample] && (
              <p className="mt-4 text-[13px] text-ink-2">Sample results were fetched on {samples[source.sample].fetchedAt}, so this run is free and instant. Drop your own file for live data.</p>
            )}
            {!source.sample && check?.emailLookup === false && source.detected.counts.email + source.detected.counts.personal_email > 0 && (
              <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-soft px-4 py-3 text-[13px] text-amber"><WarningCircleIcon size={18} className="mt-0.5 shrink-0" aria-hidden />
                <span>This key cannot look people up by email address, so the email rows will get no person columns. Add a profile URL column, or ask Crustdata to enable email lookup.</span></p>
            )}
            <div className="mt-5 frame">
              <div className="px-4 pb-2.5 pt-3 text-[15px] font-medium">Columns to fill in</div>
              <ColumnPicker columns={columns} selected={selected} hasPeople={hasPeople} hasCompanies={hasCompanies} needsProfile={source.detected.counts.profile_url + source.detected.counts.personal_email > 0}
                onToggle={id => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
                onSet={ids => setSelected(s => { const n = new Set(s); const group = ids[0]?.split(".")[0]; for (const id of [...n]) if (!group || id.startsWith(group + ".")) n.delete(id); for (const id of ids) n.add(id); return n; })} />
              <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-b-[20px] bg-frame px-4 pb-3 pt-3">
                <div className="min-w-0 text-[14px]">
                  {selected.size === 0 ? <span className="text-ink-2">Pick at least one column.</span>
                    : estimating && !estimate ? <span className="text-ink-3">Working out the estimate...</span>
                    : estimate ? <>
                        <span className="font-medium">{estimate.text}{estimate.pricing === "shown" && estimate.remaining !== null && !source.sample ? ` (you have ${Math.round(estimate.remaining).toLocaleString("en-US")})` : ""}.</span>
                        {estimate.pricing === "shown" && !source.sample && <span className="text-ink-2"> Misses and the free columns cost nothing.</span>}
                        {estimate.pricing === "hidden" && !source.sample && <span className="text-ink-2"> Paste your own key to see credits.</span>}
                        {estimate.problems > 0 && <span className="text-ink-2"> {estimate.problems} {estimate.problems === 1 ? "row has" : "rows have"} no identifier and will be listed as unresolved.</span>}
                        {estimate.note && <p className="mt-1 text-[13px] text-ink-3">{estimate.note}</p>}
                      </>
                    : <span className="text-ink-3">{error ? "" : "..."}</span>}
                  {estimate?.warnings.map(w => <p key={w} className="mt-1 text-[13px] text-amber">{w}</p>)}
                </div>
                <button type="button" onClick={run} disabled={!selected.size || (!source.sample && !estimate)} className="btn btn-dark">
                  Enrich {Math.min(source.detected.rows.length, source.sample ? 999 : check?.maxRows ?? 999)} rows
                </button>
              </div>
            </div>
            {error && <p className="mt-3 flex items-center gap-2 text-[13px] text-down"><WarningCircleIcon size={16} aria-hidden />{error}</p>}
          </section>
        )}

        {(stage === "running" || stage === "done") && source && (
          <section className="rise">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-[22px] font-medium">{source.name}</h2>
                <p className="mt-1 text-[14px] text-ink-2">{source.detected.rows.length} rows, {chosen.length} columns. Hover a cell for the Crustdata field it came from.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={stage !== "done"} onClick={() => output && download(`${stem}.enriched.csv`, output.enrichedCsv, "text/csv")} className="btn btn-dark"><DownloadSimpleIcon size={17} weight="bold" aria-hidden />Export CSV</button>
                <button type="button" disabled={stage !== "done" || !output?.unresolved} onClick={() => output && download(`${stem}.unresolved.csv`, output.unresolvedCsv, "text/csv")} className="btn btn-ghost">Unresolved{output?.unresolved ? ` (${output.unresolved})` : ""}</button>
                <button type="button" disabled={stage !== "done"} onClick={async () => { if (!output) return; await navigator.clipboard.writeText(JSON.stringify(output.json, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="btn btn-ghost">{copied ? <CheckIcon size={16} weight="bold" aria-hidden /> : <CopyIcon size={16} aria-hidden />}{copied ? "Copied" : "Copy JSON"}</button>
                <button type="button" onClick={() => { abort.current?.abort(); runId.current++; setStage("configure"); }} className="btn btn-ghost">{stage === "running" ? "Stop" : "Change columns"}</button>
                <button type="button" onClick={home} className="btn btn-ghost">New file</button>
              </div>
            </div>
            <div className="mt-5">
              <CostBar running={stage === "running"} progress={progress} cost={cost} remaining={remaining} summary={summary} pricing={source.sample ? "hidden" : (estimate?.pricing ?? check?.pricing ?? "shown")} elapsedMs={elapsed} cached={!!source.sample}
                rows={output && stage === "done" ? { matched: output.matched, partial: output.partial, unresolved: output.unresolved, total: source.detected.rows.length } : null} />
            </div>
            {notes.map(n => <p key={n} className="mt-3 text-[13px] text-amber">{n}</p>)}
            {error && <p className="mt-3 flex items-center gap-2 text-[13px] text-down"><WarningCircleIcon size={16} aria-hidden />{error}</p>}
            <div className="mt-3 frame">
              <ResultsTable rows={source.detected.rows} columns={chosen} cells={cells} running={stage === "running"} />
            </div>
          </section>
        )}
      </main>
      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 px-5 py-5 text-[13px] text-ink-2 sm:px-6">
          <span>Built on <a href="https://crustdata.com" className="text-ink hover:text-violet">Crustdata</a>: 1B+ profiles, 60M+ companies, one API.</span>
          <span className="flex gap-4"><a href="https://docs.crustdata.com" className="hover:text-ink">API docs</a><a href={REPO} className="hover:text-ink">Source</a><a href="https://app.crustdata.com" className="hover:text-ink">Get an API key</a></span>
        </div>
      </footer>
    </div>
  );
}
