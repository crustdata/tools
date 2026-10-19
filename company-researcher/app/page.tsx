"use client";

// One input (a domain or a company name). On submit the page fires /api/company and /api/hiring in parallel and
// renders each card as it lands. The brief is written on the page from the same data; only when the visitor added an
// AI key does it go to /api/brief, where the model writes it. One research = one /company/enrich call.
// Layout: results grouped under headings, one card per source, with a list of sections on the left that follows the
// reader down the page.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Brief, CompanySection, HiringSection, Research } from "@/lib/types";
import { SCHEMA_VERSION } from "@/lib/types";
import { buildBrief } from "@/lib/brief";
import { toMarkdown } from "@/lib/markdown";
import { SectionIcon } from "@/components/Icons";
import { TopBar } from "@/components/TopBar";
import { credits as fmtCredits } from "@/lib/format";
import {
  GROUP_TONES, BriefCard, CardSkeleton, CompetitorsCard, FundingCard, Group, HeadcountCards, HiringCard, LeadershipCard, NewsCard,
  PostsCard, ProfileCard, RatingsCard, SourcesSection, TechCard, TrafficCard,
} from "@/components/Sections";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const EXAMPLES = ["vercel.com", "clay.com", "retool.com"];
const REPO = "https://github.com/crustdata/tools/tree/main/company-researcher";
const COST = { full: "9.45", lite: "2.45" };

type NavItem = { id: string; label: string; sub?: Array<{ id: string; label: string }> };
const RESULT_NAV: Array<[string, NavItem[]]> = [
  ["Overview", [{ id: "profile", label: "Profile" }, { id: "brief", label: "The brief" }]],
  ["People", [
    { id: "headcount", label: "Headcount", sub: [{ id: "departments", label: "By department" }, { id: "locations", label: "Where they work" }] },
    { id: "ratings", label: "Employee ratings" },
    { id: "leadership", label: "Leadership" },
  ]],
  ["Hiring", [{ id: "postings", label: "Job postings" }]],
  ["Money and market", [{ id: "funding", label: "Funding" }, { id: "traffic", label: "Traffic and audience" }, { id: "competitors", label: "Search competitors" }, { id: "tech", label: "Tech stack" }]],
  ["News and posts", [{ id: "news", label: "Latest news" }, { id: "posts", label: "Recent posts" }]],
  ["Reference", [{ id: "sources", label: "How we count" }]],
];
// Which group each section belongs to, for the phone pills.
const GROUP_OF: Record<string, string> = {
  profile: "overview", brief: "overview", headcount: "people", departments: "people", locations: "people", ratings: "people", leadership: "people",
  postings: "hiring", funding: "money", traffic: "money", competitors: "money", tech: "money", news: "socials", posts: "socials", sources: "socials",
};

// Which section is in view: the last section whose top has passed a line near the top of the viewport. Read on
// every scroll (about 20 rects, cheap) and when cards load, since a card that loads late moves everything under it.
function useScrollSpy(ids: string[], version = "") {
  const [active, setActive] = useState(ids[0]);
  const key = ids.join("|") + "#" + version;
  useEffect(() => {
    const list = key.split("#")[0].split("|");
    const read = () => {
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      const present = list.filter(id => document.getElementById(id));
      const passed = present.filter(id => document.getElementById(id)!.getBoundingClientRect().top < 180);
      setActive(atEnd ? present.at(-1) ?? list[0] : passed.at(-1) ?? list[0]);
    };
    read();
    window.addEventListener("scroll", read, { passive: true });
    window.addEventListener("resize", read);
    return () => { window.removeEventListener("scroll", read); window.removeEventListener("resize", read); };
  }, [key]);
  return active;
}

function SideNav({ groups, active }: { groups: Array<[string, NavItem[]]>; active: string }) {
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const isIn = (it: NavItem) => it.id === active || !!it.sub?.some(x => x.id === active);
  return (
    <nav className="sticky top-6 hidden max-h-[calc(100dvh-150px)] overflow-y-auto pb-6 pr-3 lg:block" aria-label="Sections">
      {groups.map(([group, items]) => (
        <div key={group} className="mb-6">
          <div className="mb-1.5 px-3 font-mono text-[12px] uppercase tracking-[0.06em] text-ink-3">{group}</div>
          {items.map(it => (
            <div key={it.id}>
              <button onClick={() => go(it.id)} aria-current={isIn(it) ? "true" : undefined}
                className={`block w-full rounded-xl px-3 py-2 text-left text-[14px] transition ${isIn(it) ? "bg-white font-medium text-ink shadow-[0_1px_2px_rgba(18,17,24,.06),0_0_0_1px_rgba(18,17,24,.10)]" : "text-ink-2 hover:bg-white/70 hover:text-ink"}`}>
                <span className="flex items-center gap-2.5"><SectionIcon id={it.id} size={17} className={isIn(it) ? "" : "text-ink-3"} style={isIn(it) ? { color: GROUP_TONES[GROUP_OF[it.id]]?.ink } : undefined} />{it.label}</span>
              </button>
              {it.sub && isIn(it) && (
                <div className="my-1 ml-5 border-l border-rule pl-3">
                  {it.sub.map(x => (
                    <button key={x.id} onClick={() => go(x.id)} className={`block py-1.5 text-left text-[13px] ${x.id === active ? "font-medium text-violet" : "text-ink-2 hover:text-ink"}`}>{x.label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}

type State = {
  input: string; lite: boolean;
  company?: CompanySection; hiring?: HiringSection | null; hiringError?: string;
  brief?: Brief; generatedAt?: string; error?: string; needsKey?: boolean;
};

class ApiError extends Error { constructor(message: string, public needsKey = false, public status = 0) { super(message); } }

const KEY_STORE = "company-researcher:crustdata-key";
const AI_STORE = "company-researcher:ai-key";
const DEV_STORE = "company-researcher:api-details";

// Every call carries the visitor's own key in a header when they added one. The server uses it for that request only.
async function getJson<T>(path: string, init: RequestInit = {}, apiKey?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (apiKey) headers.set("x-crustdata-key", apiKey);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Could not reach the server. Check your connection and try again.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, !!body?.needsKey, res.status);
  return body as T;
}

// A key goes in an HTTP header, which only carries plain printable characters.
function keyProblem(k: string): string | null {
  if (k.length > 512) return "That is longer than any API key. Check what you pasted.";
  if (!/^[\x21-\x7e]+$/.test(k)) return "That key has characters an API key can't contain (spaces, accents or symbols). Check what you pasted.";
  return null;
}

// "https://www.Stripe.com/pricing" -> "stripe.com"; a company name stays as typed.
function tidyInput(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ");
  if (/[./]/.test(t) && !/\s/.test(t)) return t.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return t;
}
const truthy = (v: string | null) => v !== null && ["1", "true", "yes"].includes(v.toLowerCase());

type KeyConfig = { serverKey: boolean; demoDomains: string[] | null };
type Check = { status: "idle" | "checking" | "ok" | "bad"; note?: string };

function KeyField({ id, label, hint, placeholder, value, onUse, onRemove, verify }: {
  id: string; label: string; hint: React.ReactNode; placeholder: string; value: string;
  onUse: (k: string) => void; onRemove: () => void; verify: (k: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState(value);
  const [show, setShow] = useState(false);
  const [check, setCheck] = useState<Check>({ status: "idle" });
  useEffect(() => setDraft(value), [value]);
  const save = async () => {
    const k = draft.trim();
    if (!k) return;
    const problem = keyProblem(k);
    if (problem) { setCheck({ status: "bad", note: problem }); return; }
    setCheck({ status: "checking" });
    try {
      const note = await verify(k);
      onUse(k);
      setCheck({ status: "ok", note });
    } catch (err) {
      setCheck({ status: "bad", note: (err as Error).message });
    }
  };
  return (
    <div className="flex min-w-0 flex-col">
      <label htmlFor={id} className="text-[14px] font-medium">{label}</label>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{hint}</p>
      <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); save(); }}>
        <div className="relative min-w-0 flex-1">
          <input id={id} type={show ? "text" : "password"} value={draft} onChange={e => { setDraft(e.target.value); setCheck({ status: "idle" }); }}
            placeholder={placeholder} autoComplete="off" spellCheck={false} aria-invalid={check.status === "bad" || undefined}
            className="w-full rounded-xl bg-row px-3.5 py-2.5 pr-14 font-mono text-[13px] outline-none ring-violet/40 transition placeholder:text-ink-3 focus:bg-white focus:ring-2 aria-[invalid]:ring-2 aria-[invalid]:ring-down/50" />
          <button type="button" onClick={() => setShow(!show)} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[12px] text-ink-2 hover:text-ink">{show ? "Hide" : "Show"}</button>
        </div>
        <button type="submit" disabled={!draft.trim() || check.status === "checking"} className="shrink-0 rounded-full bg-ink px-4 py-2.5 text-[13px] font-medium text-white transition hover:bg-violet disabled:bg-wash disabled:text-ink-3">
          {check.status === "checking" ? "Checking..." : "Check and use"}
        </button>
      </form>
      <div className="mt-2 min-h-[20px] text-[13px]">
        {check.note && <p className={check.status === "bad" ? "text-down" : "text-violet"}>{check.note}</p>}
        {value && <p className="text-ink-2">In use: <span className="font-mono">••••{value.slice(-4)}</span> <button type="button" onClick={() => { onRemove(); setDraft(""); setCheck({ status: "idle" }); }} className="ml-2 underline underline-offset-2 hover:text-down">Remove</button></p>}
      </div>
    </div>
  );
}

function KeyPanel({ crustKey, setCrustKey, aiKeyValue, setAiKey, setAiModel, remember, setRemember, setOpen, config }: {
  crustKey: string; setCrustKey: (k: string) => void; aiKeyValue: string; setAiKey: (k: string) => void; setAiModel: (m: string) => void;
  remember: boolean; setRemember: (r: boolean) => void; setOpen: (o: boolean) => void; config: KeyConfig | null;
}) {
  const demo = !config ? "" : !config.serverKey
    ? "This site has no free demo, so you need your own key."
    : config.demoDomains ? `Optional: the free demo covers ${config.demoDomains.join(", ")}.` : "Optional while the free demo lasts.";
  return (
    <div className="rise mt-5 w-full rounded-[20px] bg-frame p-1.5 text-left shadow-[inset_0_0_0_1px_rgba(18,17,24,.12)]">
      <div className="flex items-center justify-between px-4 pb-2.5 pt-3">
        <span className="text-[16px] font-medium">Use your own keys</span>
        <button type="button" onClick={() => setOpen(false)} className="text-[13px] text-ink-2 hover:text-ink">Close</button>
      </div>
      <div className="panel grid gap-8 p-5 md:grid-cols-2">
        <KeyField id="cd-key" label="Crustdata API key" placeholder="Paste your key" value={crustKey}
          hint={<>{demo} Get yours at <a href="https://app.crustdata.com" target="_blank" rel="noreferrer" className="text-violet hover:underline">app.crustdata.com</a>: start free with $20 in credits.</>}
          onUse={setCrustKey} onRemove={() => setCrustKey("")}
          verify={async k => {
            const r = await getJson<{ ok: boolean; missing: string[] }>("/api/check", {}, k);
            return r.missing.length ? `Key works. Not on your plan: ${r.missing.join(", ")}.` : "Key works. Every section is available.";
          }} />
        <KeyField id="ai-key" label="AI key (optional)" placeholder="sk-ant-... or sk-..." value={aiKeyValue}
          hint="Anthropic or OpenAI. With it, the AI writes the brief from the data on this page. Without it, the standard brief is used."
          onUse={setAiKey} onRemove={() => { setAiKey(""); setAiModel(""); }}
          verify={async k => {
            const r = await getJson<{ ok: boolean; model: string }>("/api/check-ai", { headers: { "x-ai-key": k } });
            setAiModel(r.model);
            return `Key works. ${r.model} will write the brief.`;
          }} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-2 pt-3">
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="accent-[#4f46d8]" /> Remember keys on this device
        </label>
        <p className="max-w-prose text-[13px] text-ink-2">Keys stay in this browser and go with each research only to make the calls. The server never stores or logs them.</p>
      </div>
    </div>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

// The brief as plain text, for a CRM note or an email.
function briefText(r: Research): string {
  const b = r.brief;
  if (b.ai) return `${r.company.name} (${r.company.domain})\n\n${b.ai.text.replace(/\*\*/g, "")}`;
  return [`${r.company.name} (${r.company.domain})`, "", b.summary, "", "What changed lately:", ...b.changes.map(c => `- ${c}`), "", "Questions to ask:", ...b.questions.map((q, i) => `${i + 1}. ${q}`)].join("\n");
}

function Researcher() {
  const params = useSearchParams();
  const router = useRouter();
  const [input, setInput] = useState(params.get("domain") ?? "");
  const [lite, setLite] = useState(truthy(params.get("lite")));
  const [state, setState] = useState<State | null>(null);
  const [copied, setCopied] = useState<"" | "json" | "brief" | "fail">("");
  const [apiKey, setApiKeyState] = useState("");
  const [aiKey, setAiKeyState] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [remember, setRememberState] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [config, setConfig] = useState<KeyConfig | null>(null);
  const [inputError, setInputError] = useState("");
  const [dev, setDevState] = useState(false);
  const [salesOnly, setSalesOnly] = useState(false);
  const keyRef = useRef("");
  const aiRef = useRef("");
  const run = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const pillsRef = useRef<HTMLElement>(null);

  // Keys live in this tab, and in localStorage only when "Remember keys on this device" is ticked.
  const persist = (store: string, k: string, on = remember) => { if (on && k) localStorage.setItem(store, k); else localStorage.removeItem(store); };
  const setApiKey = (k: string) => { keyRef.current = k; setApiKeyState(k); persist(KEY_STORE, k); };
  const setAiKey = (k: string) => { aiRef.current = k; setAiKeyState(k); persist(AI_STORE, k); rebrief(); };
  const setRemember = (r: boolean) => { setRememberState(r); persist(KEY_STORE, keyRef.current, r); persist(AI_STORE, aiRef.current, r); };
  const setDev = (v: boolean) => { setDevState(v); localStorage.setItem(DEV_STORE, v ? "1" : "0"); };
  useEffect(() => {
    const saved = localStorage.getItem(KEY_STORE);
    const savedAi = localStorage.getItem(AI_STORE);
    if (saved) { keyRef.current = saved; setApiKeyState(saved); setRememberState(true); }
    if (savedAi) { aiRef.current = savedAi; setAiKeyState(savedAi); setRememberState(true); }
    setDevState(localStorage.getItem(DEV_STORE) === "1");
    getJson<KeyConfig>("/api/config").then(cfg => { setConfig(cfg); if (!cfg.serverKey && !saved) setKeyOpen(true); }).catch(() => {});
  }, []);

  // The brief: written on the page from the data, or by the model when an AI key is set. A failed AI call falls back
  // to the standard brief, so the page never waits forever.
  const writeBrief = useCallback(async (id: number, company: CompanySection, hiring: HiringSection | null, signal?: AbortSignal) => {
    const facts = { company: company.company, people: company.people, hiring: hiring?.hiring ?? null };
    let brief: Brief = buildBrief(facts);
    if (aiRef.current) {
      try {
        const r = await getJson<{ brief: Brief }>("/api/brief", {
          method: "POST", signal,
          headers: { "content-type": "application/json", "x-ai-key": aiRef.current },
          body: JSON.stringify(facts),
        });
        brief = r.brief;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        brief = { ...brief, aiError: (err as Error).message };
      }
    }
    if (id === run.current) setState(s => s && { ...s, brief, generatedAt: new Date().toISOString() });
  }, []);

  const start = useCallback(async (raw: string, liteMode: boolean, push = true) => {
    const query = tidyInput(raw);
    if (!query) { setInputError("Type a company domain or name, for example stripe.com"); return; }
    setInputError("");
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const id = ++run.current;
    const live = () => id === run.current;
    setInput(query);
    setState({ input: query, lite: liteMode });
    setSalesOnly(false);
    const url = `?domain=${encodeURIComponent(query)}${liteMode ? "&lite=1" : ""}`;
    if (push) router.push(url, { scroll: false });
    setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);

    const key = keyRef.current || undefined;
    const companyP = getJson<CompanySection>(`/api/company${url}`, { signal: ctrl.signal }, key);
    const hiringP = getJson<HiringSection>(`/api/hiring${url}`, { signal: ctrl.signal }, key)
      .catch(err => { if (live() && (err as Error).name !== "AbortError") setState(s => s && { ...s, hiringError: (err as Error).message }); return null; });
    hiringP.then(h => { if (live()) setState(s => s && { ...s, hiring: h }); });

    let company: CompanySection;
    try {
      company = await companyP;
      if (live()) setState(s => s && { ...s, company });
    } catch (err) {
      if ((err as Error).name === "AbortError" || !live()) return;
      const needsKey = err instanceof ApiError && err.needsKey;
      setState({ input: query, lite: liteMode, error: (err as Error).message, needsKey });
      if (needsKey) {
        setKeyOpen(true);
        setTimeout(() => { const el = document.getElementById("cd-key"); el?.scrollIntoView({ behavior: "smooth", block: "center" }); el?.focus(); }, 120);
      } else {
        setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
      }
      return;
    }
    const hiring = await hiringP;
    if (!live()) return;
    await writeBrief(id, company, hiring, ctrl.signal);
  }, [router, writeBrief]);

  // Adding or removing an AI key after a research rewrites just the brief; the data is already on the page.
  const stateRef = useRef<State | null>(null);
  stateRef.current = state;
  function rebrief() {
    const st = stateRef.current;
    if (!st?.company || st.hiring === undefined) return;
    const id = run.current;
    setState(x => x && { ...x, brief: undefined });
    writeBrief(id, st.company, st.hiring ?? null);
  }

  // The URL is the source of truth: a reload, or Back and Forward, runs the research the URL names.
  useEffect(() => {
    const d = params.get("domain");
    const l = truthy(params.get("lite"));
    const st = stateRef.current;
    if (d && (!st || st.input !== tidyInput(d) || st.lite !== l)) { setLite(l); start(d, l, false); }
    if (!d && st) { abort.current?.abort(); run.current++; setState(null); setInput(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const switchDepth = (l: boolean) => {
    setLite(l);
    if (state?.company && state.lite !== l) start(state.input, l);
  };

  const c = state?.company;
  const searched = !!state && !state.error;
  const loading = !!state && !state.error && (!c || state.hiring === undefined || !state.brief);
  const result: Research | null = c && state?.brief && state.hiring !== undefined
    ? {
        schemaVersion: SCHEMA_VERSION, domain: c.domain, generatedAt: state.generatedAt ?? c.fetchedAt, fetchedAt: c.fetchedAt,
        company: c.company, people: c.people, hiring: state.hiring?.hiring ?? null, brief: state.brief, unavailable: c.unavailable,
        errors: [
          ...(state.hiringError ? [{ section: "hiring" as const, status: null, message: state.hiringError }] : []),
          ...(state.brief.aiError ? [{ section: "brief" as const, status: null, message: state.brief.aiError }] : []),
        ],
        credits: {
          identify: c.credits.identify, enrich: c.credits.enrich, jobs: state.hiring?.credits.jobs ?? 0,
          total: Math.round((c.credits.total + (state.hiring?.credits.total ?? 0)) * 100) / 100,
          cached: c.credits.cached && (state.hiring?.credits.cached ?? true),
        },
      }
    : null;
  const skipped = (g: string) => {
    const u = c?.unavailable.find(x => x.startsWith(g));
    return u ? (u.includes("lite") ? "Skipped in lite mode." : "Not available on this plan.") : null;
  };
  const groups = RESULT_NAV;
  const active = useScrollSpy(groups.flatMap(([, items]) => items.flatMap(i => [i.id, ...(i.sub?.map(x => x.id) ?? [])])), `${!!c}${state?.hiring !== undefined}${!!state?.brief}`);
  // Keep the active pill in view in the phone row.
  useEffect(() => {
    const bar = pillsRef.current, pill = bar?.querySelector<HTMLElement>('[aria-current="true"]');
    if (bar && pill) bar.scrollTo({ left: pill.offsetLeft - 8, behavior: "smooth" });
  }, [active]);
  const step = !state || state.error ? null
    : !c ? `Looking up ${state.input}...`
    : state.hiring === undefined ? "Checking job postings..."
    : !state.brief ? (aiKey ? "The AI is writing the brief..." : "Writing the brief...")
    : null;
  // A subdomain (aws.amazon.com) researches the company behind it: say so.
  const resolvedElsewhere = c && /\./.test(state!.input) && state!.input !== c.company.domain;
  const runFull = () => { setLite(false); if (state) start(state.input, false); };
  const copy = async (text: string, kind: "json" | "brief") => {
    try { await navigator.clipboard.writeText(text); setCopied(kind); } catch { setCopied("fail"); }
    setTimeout(() => setCopied(""), 1800);
  };

  return (
    <div className={`min-h-screen ${result ? "pb-28" : ""} ${dev ? "show-dev" : ""}`}>
      <TopBar repo={REPO} onHome={() => router.push("/", { scroll: true })} />

      <main className="mx-auto max-w-[1240px] px-5 sm:px-6">
        {/* On wide screens the hero sits over the results column, so the search box starts where "Company overview"
            starts and ends where the cards end; the empty first cell matches the section list on the left. */}
        <div className={searched ? "lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-12" : ""}>
        {searched && <div className="hidden lg:block" />}
        <section className={`mx-auto flex w-full max-w-[820px] flex-col items-center text-center ${searched ? "lg:max-w-none" : ""} ${searched ? "pt-10" : "pt-14 md:pt-20"}`}>
          <h1 className={`rise font-medium leading-[1.05] tracking-[-0.03em] ${searched ? "text-[32px] md:text-[40px]" : "text-[44px] md:text-[64px]"}`}>
            <span className="text-violet">Company</span> Researcher
          </h1>
          {!searched && (
            <p className="rise mt-5 max-w-[560px] text-[17px] leading-relaxed text-ink-2" style={{ animationDelay: "80ms" }}>
              Headcount by team, hiring, leaders and funding for any company. Type a domain or a name, get a brief in seconds.
            </p>
          )}
          <form ref={formRef} noValidate aria-invalid={!!(inputError || (state?.error && !state.needsKey)) || undefined}
            className={`rise w-full rounded-[22px] bg-white p-2 text-left shadow-[0_0_0_1px_rgba(18,17,24,.12),0_12px_40px_-12px_rgba(79,70,216,.25)] transition-shadow focus-within:shadow-[0_0_0_2px_rgba(79,70,216,.55),0_12px_40px_-12px_rgba(79,70,216,.35)] aria-[invalid]:shadow-[0_0_0_2px_rgba(194,65,12,.5)] ${searched ? "mt-6" : "mt-10"}`}
            style={{ animationDelay: "160ms" }} onSubmit={e => { e.preventDefault(); start(input, lite); }}>
            <input value={input} onChange={e => { setInput(e.target.value); setInputError(""); }} placeholder="Company domain or name, for example stripe.com" aria-label="Company domain or name"
              spellCheck={false} className="w-full bg-transparent px-4 pb-3 pt-3.5 text-[18px] outline-none placeholder:text-ink-3" />
            <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-1">
              <div className="flex items-center rounded-full bg-wash p-1" role="group" aria-label="Research depth">
                {([["Full", false, COST.full], ["Lite", true, COST.lite]] as Array<[string, boolean, string]>).map(([label, val, cost]) => (
                  <button key={label} type="button" aria-pressed={lite === val} onClick={() => switchDepth(val)}
                    title={val ? "Skips the tech stack and recent posts" : "Everything"}
                    className={`rounded-full px-3 py-1.5 text-[13px] transition ${lite === val ? "bg-white text-ink shadow-[0_1px_2px_rgba(18,17,24,.1),0_0_0_1px_rgba(18,17,24,.08)]" : "text-ink-2 hover:text-ink"}`}>
                    {label}<span className="dev-only text-ink-3"> {cost} cr</span>
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setKeyOpen(!keyOpen)} aria-expanded={keyOpen}
                className={`flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] transition ${keyOpen ? "bg-violet-soft text-violet" : "bg-wash text-ink-2 hover:text-ink"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${apiKey ? "bg-violet" : !config || config.serverKey ? "bg-ink-3" : "bg-down"}`} />
                {apiKey ? "Your key" : !config ? "API keys" : config.serverKey ? "Free demo" : "Add your key"}
                {aiKey && <span className="text-ink-3">+ AI</span>}
              </button>
              <button type="submit" aria-busy={loading || undefined}
                className={`ml-auto flex items-center gap-2 rounded-full bg-violet px-6 py-2.5 text-[14px] font-semibold text-white transition hover:bg-[#3f37c2] active:scale-[0.98] ${loading ? "cursor-wait" : ""}`}>
                {loading && <span className="spin inline-block h-3.5 w-3.5 rounded-full border-[1.5px] border-white/40 border-t-white" />}
                {loading ? "Researching" : "Research"}
              </button>
            </div>
          </form>
          {(inputError || (state?.error && !state.needsKey)) && <p role="alert" className="mt-2.5 w-full px-2 text-left text-[14px] text-down">{inputError || state!.error}</p>}
          {state?.error && state.needsKey && <p role="alert" className="mt-2.5 w-full px-2 text-left text-[14px] text-down">{state.error}</p>}
          {step && <p className="mt-2.5 w-full px-2 text-left text-[14px] text-ink-2" aria-live="polite">{step}</p>}
          {!searched && (
            <div className="rise mt-4 flex flex-wrap items-center justify-center gap-2 text-[13px]" style={{ animationDelay: "240ms" }}>
              <span className="text-ink-2">Try</span>
              {EXAMPLES.map(d => (
                <button key={d} type="button" disabled={loading} onClick={() => start(d, lite)}
                  className="rounded-full bg-white px-3 py-1 text-ink-2 shadow-[0_0_0_1px_rgba(18,17,24,.12)] transition hover:text-violet hover:shadow-[0_0_0_1px_rgba(79,70,216,.4)] disabled:opacity-50">{d}</button>
              ))}
            </div>
          )}
          {keyOpen && <KeyPanel crustKey={apiKey} setCrustKey={setApiKey} aiKeyValue={aiKey} setAiKey={setAiKey} setAiModel={setAiModel} remember={remember} setRemember={setRemember} setOpen={setKeyOpen} config={config} />}
        </section>
        </div>

        <div className={`grid grid-cols-1 gap-12 ${searched ? "mt-8 lg:mt-12 lg:grid-cols-[210px_minmax(0,1fr)]" : "mx-auto mt-16 max-w-[1000px] lg:mt-20"}`}>
          {searched && <aside><SideNav groups={groups} active={active} /></aside>}
          <div ref={resultsRef} className="min-w-0 scroll-mt-6">
            {searched ? (
              <>
                {/* Phones and tablets: the side list is hidden, so the groups become a sticky row of pills. */}
                <nav ref={pillsRef} aria-label="Sections" className="thin-x fade-right sticky top-3 z-10 mb-8 flex gap-1 overflow-x-auto rounded-[22px] bg-white p-1 pb-1.5 pr-6 shadow-[0_0_0_1px_rgba(18,17,24,.12),0_8px_24px_-12px_rgba(18,17,24,.25)] backdrop-blur-md lg:hidden">
                  {([["overview", "Overview"], ["people", "People"], ["hiring", "Hiring"], ["money", "Money"], ["socials", "News"]] as Array<[string, string]>).map(([id, label]) => (
                    <button key={id} aria-current={GROUP_OF[active] === id ? "true" : undefined} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                      className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] ${GROUP_OF[active] === id ? "bg-ink text-white" : "text-ink-2 hover:bg-wash hover:text-ink"}`}>{label}</button>
                  ))}
                </nav>
                {resolvedElsewhere && (
                  <p className="mb-6 rounded-2xl bg-white px-4 py-3 text-[14px] text-ink-2 shadow-[0_0_0_1px_rgba(18,17,24,.12)]">Showing <span className="font-medium text-ink">{c!.company.name} ({c!.company.domain})</span>, the company behind {state!.input}.</p>
                )}
                <Group id="overview" title="Company overview" lede="Who they are and what changed.">
                  {c ? <ProfileCard c={c.company} /> : <CardSkeleton id="profile" title="Profile" wide kind="profile" />}
                  <BriefCard brief={state?.brief ?? null} />
                </Group>

                <Group id="people" title="People" lede="Teams, places and leaders.">
                  {c ? (
                    <>
                      <HeadcountCards c={c.company} />
                      <RatingsCard c={c.company} />
                      <LeadershipCard p={c.people} />
                    </>
                  ) : <><CardSkeleton id="headcount" title="Headcount over time" wide /><CardSkeleton id="departments" title="Headcount by department" wide /></>}
                </Group>

                <Group id="hiring" title="Hiring" lede="Postings in the last 90 days.">
                  {state?.hiring !== undefined
                    ? <HiringCard j={state.hiring?.hiring ?? null} name={c?.company.name ?? state.input} salesOnly={salesOnly} setSalesOnly={setSalesOnly} />
                    : <CardSkeleton id="postings" title="Hiring" wide />}
                </Group>

                <Group id="money" title="Money and market" lede="Funding, traffic, competitors and stack.">
                  {c ? (
                    <>
                      <FundingCard c={c.company} />
                      <TrafficCard c={c.company} />
                      <CompetitorsCard c={c.company} />
                      <TechCard c={c.company} skipped={skipped("technographics")} onRunFull={runFull} />
                    </>
                  ) : <><CardSkeleton id="funding" title="Funding" wide /><CardSkeleton id="traffic" title="Traffic and audience" kind="list" /><CardSkeleton id="competitors" title="Search competitors" kind="list" /></>}
                </Group>

                <Group id="socials" title="News and posts" lede="Coverage and their own posts.">
                  {c ? <><NewsCard c={c.company} /><PostsCard c={c.company} skipped={skipped("social_posts")} onRunFull={runFull} /></> : <CardSkeleton id="news" title="Latest news" wide kind="list" />}
                </Group>

                <SourcesSection />
              </>
            ) : (
              <>
                <Returns />
                <SourcesSection />
              </>
            )}
            {/* Room under the last section, so the list on the left can highlight it. */}
            {searched && <div aria-hidden className="h-[12vh]" />}
          </div>
        </div>
      </main>

      {/* Site footer, the same as the reverse email lookup's: one hairline across, the copyright under it. */}
      <footer className={`mx-auto mt-20 max-w-[1240px] px-5 sm:px-6 ${result ? "mb-4" : ""}`}>
        <div className="border-t border-[#e7e7ec] pb-9 pt-[22px] text-[13.5px] text-[#70707c]">© {new Date().getFullYear()} Crustdata</div>
      </footer>

      {/* The action bar: only once a research is on screen, for its credits, Copy brief and the exports. */}
      {result && <div className="pointer-events-none fixed inset-x-0 bottom-3 z-20 sm:bottom-4">
        <div className={`mx-auto px-3 sm:px-6 ${searched ? "max-w-[1240px] lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-12" : "max-w-[1048px]"}`}>
          {searched && <div className="hidden lg:block" />}
          <div className="pointer-events-auto flex items-center justify-between gap-2 rounded-2xl bg-white/95 px-3 py-2 text-[13px] shadow-[0_0_0_1px_rgba(18,17,24,.12),0_16px_40px_-12px_rgba(18,17,24,.3)] backdrop-blur sm:px-4">
            <span className="min-w-0 truncate text-ink-2">
              <span className="num font-semibold text-ink">{fmtCredits(result.credits.total)}</span> credits
              <span className="hidden sm:inline">{result.credits.cached ? ` (from cache; a fresh run is about ${state?.lite ? COST.lite : COST.full})` : apiKey ? " on your key" : " on the free demo"}</span>
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              {result && (
                <>
                  <button className="rounded-full bg-wash px-3 py-1.5 transition hover:bg-violet-soft hover:text-violet" onClick={() => copy(briefText(result), "brief")}>{copied === "brief" ? "Copied" : "Copy brief"}</button>
                  <button className="hidden rounded-full bg-wash px-3 py-1.5 transition hover:bg-violet-soft hover:text-violet sm:inline-block" onClick={() => download(`${result.domain}.md`, toMarkdown(result), "text/markdown")}>Markdown</button>
                  <button className="dev-only rounded-full bg-wash px-3 py-1.5 transition hover:bg-violet-soft hover:text-violet" onClick={() => copy(JSON.stringify(result, null, 2), "json")}>{copied === "json" ? "Copied" : "Copy JSON"}</button>
                  {copied === "fail" && <span className="text-down">Copy failed</span>}
                </>
              )}
              <button aria-pressed={dev} onClick={() => setDev(!dev)} title="Show the API fields, endpoints and credits behind each card"
                className={`hidden rounded-full px-3 py-1.5 transition sm:inline-block ${dev ? "bg-ink text-white" : "bg-wash hover:bg-violet-soft hover:text-violet"}`}>API details</button>
            </div>
          </div>
        </div>
      </div>}
    </div>
  );
}

// What a research returns, in two groups: everything in the base call, and the add-ons that cost extra.
function Returns() {
  const base: Array<[string, string, string]> = [
    ["profile", "Profile", "What they do, where, since when"],
    ["headcount", "Headcount", "By team and place, 24 months"],
    ["leadership", "Leadership", "Founders and executives"],
    ["funding", "Funding", "Rounds and investors"],
    ["traffic", "Traffic", "Visits and followers"],
    ["ratings", "Ratings", "Employee reviews"],
  ];
  const addons: Array<[string, string, string, string]> = [
    ["hiring", "Hiring", "Postings and newest roles", "0.45"],
    ["tech", "Tech stack", "Tools they use", "+2"],
    ["posts", "Posts", "Their latest posts", "+5"],
  ];
  const Tile = ({ id, name, what, cost }: { id: string; name: string; what: string; cost?: string }) => (
    <div className="panel flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-soft text-violet"><SectionIcon id={id} size={26} /></span>
        {cost && <span className="num rounded-full bg-wash px-2.5 py-1 text-[12px] font-medium text-ink-2">{cost} credits</span>}
      </div>
      <div>
        <div className="text-[16px] font-medium">{name}</div>
        <div className="mt-0.5 text-[14px] leading-snug text-ink-2">{what}</div>
      </div>
    </div>
  );
  return (
    <section id="returns" className="scroll-mt-20 lg:scroll-mt-6">
      <h2 className="text-center text-[28px] font-medium leading-tight tracking-[-0.02em]">What one research returns</h2>
      <p className="mt-1.5 text-center text-[16px] text-ink-2">About {COST.full} credits for everything, {COST.lite} in Lite. Repeats within a day are free.</p>
      <div className="mt-8 grid gap-6">
        <div className="rounded-[20px] bg-frame p-1.5 shadow-[inset_0_0_0_1px_rgba(18,17,24,.12)]">
          <div className="flex items-center justify-between px-4 pb-2.5 pt-3"><span className="text-[16px] font-medium">In every research</span><span className="num rounded-full bg-ink px-2.5 py-1 text-[12px] font-medium text-white">2 credits</span></div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">{base.map(([id, n, w]) => <Tile key={id} id={id} name={n} what={w} />)}</div>
        </div>
        <div className="rounded-[20px] bg-frame p-1.5 shadow-[inset_0_0_0_1px_rgba(18,17,24,.12)]">
          <div className="px-4 pb-2.5 pt-3 text-[16px] font-medium">Add-ons</div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">{addons.map(([id, n, w, cr]) => <Tile key={id} id={id} name={n} what={w} cost={cr} />)}</div>
        </div>
      </div>
    </section>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Researcher />
    </Suspense>
  );
}
