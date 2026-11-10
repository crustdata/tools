/**
 * The rules: Crustdata changes in, signals out. Each signal carries a fixed "why it matters" line written for a fund
 * (no AI model). Pure functions, no I/O; thresholds come from config/thresholds.json.
 *
 * Signal keys decide what counts as "the same event" (stored and posted once). Every key names the company's domain,
 * so two portfolio companies in one story never collapse into one, and names what makes the event itself distinct
 * (the article URL, the round date, the person and the day).
 */

import type { Leader, LeaderEvent, LeaderRole } from "./leaders.js";
import type { Thresholds } from "./thresholds.js";
import { clip, isoDate, longDate, plural, shortDate, type Signal } from "./types.js";

export type CompanyRef = { domain: string; name: string; companyId?: number };

export type CompanyRecord = {
  crustdata_company_id?: number;
  basic_info?: { name?: string; primary_domain?: string; status?: string; employee_count_range?: string } | null;
  headcount?: {
    total?: number | null;
    growth_percent?: Record<string, number | null> | null;
    growth_absolute?: Record<string, number | null> | null;
    by_function_timeseries?: { CURRENT_FUNCTION?: Record<string, { date: string; employee_count: number }[]> } | null;
  } | null;
  funding?: {
    last_round_type?: string | null;
    last_round_amount_usd?: number | null;
    last_fundraise_date?: string | null;
    total_investment_usd?: number | null;
    investors?: string[] | null;
    acquired_by?: unknown[] | null;
    acquisitions?: unknown[] | null;
  } | null;
  news?: unknown[] | null;
};

export const WHY = {
  headcount_down: "A drop this size usually means layoffs or a hiring freeze. Worth asking about runway and the plan.",
  team_down: "One team shrinking while the rest holds often means a change of plan for that function.",
  headcount_up: "Fast growth raises the burn. Worth checking runway and whether a round is coming.",
  founder_left: "A founder leaving often comes before a change in direction, a sale or a wind-down. Worth a call this week.",
  ceo_left: "A CEO change usually follows a board decision. Ask who leads now and what changes.",
  c_level_left: "A C-level departure can slow the team they ran. Ask who covers the role.",
  ceo_changed: "A CEO moving to chair or another title usually means a new CEO. Ask who runs the company day to day.",
  stepped_back: "Moving to an advisor, board or chair seat usually means stepping back from day to day work.",
  role: "A new title at the same company: a promotion, a new remit or a reshuffle at the top.",
  side_role: "A leader taking a main role elsewhere may be on the way out. Worth a quiet check.",
  returned: "A leader recorded as gone lists the company again: the earlier change may have been a profile edit.",
  joined_ceo: "A new CEO or CFO usually comes with a new plan or a fundraise. Worth an intro.",
  joined: "A new senior hire: worth knowing before the next board meeting.",
  hiring_stopped: "A full stop on hiring is often the first sign of a freeze or a cash squeeze.",
  hiring_jump: "Hiring doubling usually follows a round or strong revenue. Check the plan behind it.",
  hiring_slowed: "Hiring slowing down can be a cost cut or a plan that changed.",
  hiring_started: "Hiring again after a quiet stretch: new money, new revenue or a new plan.",
  round: "A new round: check your pro rata rights and whether you were offered an allocation.",
  bridge: "A bridge, an extension or debt after a priced round often means the next priced round is not ready. Ask about runway and the terms.",
  investors: "New names on the cap table usually mean a round or a secondary sale.",
  financing: "A note or debt before a priced round: ordinary at this stage, and worth knowing the terms.",
  secondary: "Some holders sold shares. Ask at what price: it can set a new mark for your stake.",
  acquisition: "An acquisition changes the plan and the burn. Ask how it was paid for.",
  acquired: "Check the deal terms, your preference stack and what you receive.",
  status: "The company's status changed in Crustdata's company data. Confirm with the founders.",
  bad_news: "Bad news in the press. Worth hearing it from the founders first.",
  legal_news: "A legal or security story. Worth asking the founders about exposure.",
  down_round: "A down round, a bridge or a recapitalisation in the press. Check your preference stack and anti-dilution terms.",
  funding_news: "Press about money: a round, a valuation or a sale. Check it against what the founders told you.",
};

const pct = (from: number, to: number) => (from === 0 ? 0 : ((to - from) / from) * 100);
const fmtPct = (p: number) => `${Math.round(Math.abs(p))}%`;
const fnLabel = (fn: string) => fn.toLowerCase().replace(/_/g, " ").replace(/\b(it|hr|qa)\b/g, m => m.toUpperCase());
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Headcount
// ---------------------------------------------------------------------------

export type Point = { at: string; total: number };

/** Whether a drop from `from` to `to` crosses the thresholds (small companies have their own). */
export function isDrop(from: number, to: number, t: Thresholds): boolean {
  const down = from - to;
  if (down <= 0 || from <= 0) return false;
  const p = (down / from) * 100;
  if (down >= t.headcount_down.or_people) return true;
  const rule = from < t.small_company.below ? t.small_company : t.headcount_down;
  return p >= rule.percent && down >= rule.people;
}

/**
 * Headcount total against its highest (for a drop) and lowest (for growth) reading in the window: the readings since
 * the last headcount alert, within `reference_days`. A slow decline adds up, and a second drop after a rehire is seen.
 */
export function headcountSignals(c: CompanyRef, window: Point[], now: Point, t: Thresholds): Signal[] {
  const out: Signal[] = [];
  const earlier = window.filter(p => p.at < now.at && typeof p.total === "number");
  if (!earlier.length) return out;
  const peak = earlier.reduce((a, b) => (b.total >= a.total ? b : a));
  const low = earlier.reduce((a, b) => (b.total <= a.total ? b : a));
  const date = now.at.slice(0, 10);
  if (isDrop(peak.total, now.total, t)) {
    const down = peak.total - now.total;
    out.push({ key: `headcount_down:${c.domain}:${peak.at.slice(0, 10)}:${now.total}`, domain: c.domain, company: c.name, kind: "headcount_down", severity: "alert", text: `Headcount down ${fmtPct(pct(peak.total, now.total))} since ${longDate(peak.at)}, from ${peak.total} to ${now.total} (${plural(down, "person", "people")} fewer)`, why: WHY.headcount_down, date });
  } else if (now.total - low.total >= t.headcount_up.people && pct(low.total, now.total) >= t.headcount_up.percent) {
    out.push({ key: `headcount_up:${c.domain}:${low.at.slice(0, 10)}:${now.total}`, domain: c.domain, company: c.name, kind: "headcount_up", severity: "good", text: `Headcount up ${fmtPct(pct(low.total, now.total))} since ${longDate(low.at)}, from ${low.total} to ${now.total}`, why: WHY.headcount_up, date });
  }
  return out;
}

/** The latest count per department, with the month it is for, from the by-function time series. */
export function functionCounts(r: CompanyRecord | undefined): Record<string, { count: number; date: string }> {
  const out: Record<string, { count: number; date: string }> = {};
  for (const [fn, points] of Object.entries(r?.headcount?.by_function_timeseries?.CURRENT_FUNCTION ?? {})) {
    const valid = (Array.isArray(points) ? points : []).filter(p => p && typeof p.date === "string" && typeof p.employee_count === "number");
    const last = valid.sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    if (last) out[fn] = { count: last.employee_count, date: last.date.slice(0, 10) };
  }
  return out;
}

const monthYear = (iso: string) => { const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`); return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }); };

/**
 * Departments that shrank between two records. Department counts are monthly and lag, so the line names the months
 * it compares rather than a "since" date.
 */
export function teamSignals(c: CompanyRef, prev: CompanyRecord | undefined, next: CompanyRecord | undefined, t: Thresholds): Signal[] {
  const a = functionCounts(prev);
  const b = functionCounts(next);
  const teams: { fn: string; from: { count: number; date: string }; to: { count: number; date: string }; p: number }[] = [];
  for (const [fn, to] of Object.entries(b)) {
    const from = a[fn];
    if (!from || from.count < t.team_down.min_team || to.date <= from.date) continue;
    const p = pct(from.count, to.count);
    if (to.count < from.count && -p >= t.team_down.percent && from.count - to.count >= t.team_down.people) teams.push({ fn, from, to, p });
  }
  return teams.sort((m, n) => m.p - n.p).slice(0, 3).map(x => ({
    key: `team_down:${c.domain}:${x.fn}:${x.to.date}`, domain: c.domain, company: c.name, kind: "team_down", severity: "alert",
    text: `${capital(fnLabel(x.fn))} team down ${fmtPct(x.p)}, from ${x.from.count} to ${x.to.count} (monthly department counts, ${monthYear(x.from.date)} to ${monthYear(x.to.date)})`,
    why: WHY.team_down, date: x.to.date,
  }));
}

/**
 * The starting point for a company just added, from its current record: headcount now and over 6 months, the last
 * round, and a flag when the 6-month change already crosses a threshold. Shown in the import output and first digest.
 */
export function startingPoint(c: CompanyRef, r: CompanyRecord | undefined, t: Thresholds): { line: string; flag?: Signal } {
  const parts: string[] = [];
  let flag: Signal | undefined;
  const total = r?.headcount?.total;
  if (typeof total === "number") {
    const abs = r?.headcount?.growth_absolute?.six_months;
    const p = r?.headcount?.growth_percent?.six_months;
    if (typeof abs === "number" && typeof p === "number" && total - abs > 0) {
      const from = total - abs;
      parts.push(`${total} people (${abs >= 0 ? "+" : "-"}${Math.round(Math.abs(p))}% over 6 months)`);
      if (isDrop(from, total, t)) {
        flag = { key: `start_headcount_down:${c.domain}`, domain: c.domain, company: c.name, kind: "headcount_down", severity: "alert", text: `Headcount down ${fmtPct(p)} over the last 6 months, from ${from} to ${total}`, why: WHY.headcount_down, date: isoDate(new Date()) };
      }
    } else parts.push(`${total} people`);
  }
  const f = r?.funding;
  if (f?.last_round_type) {
    const amount = money(f.last_round_amount_usd);
    const label = roundLabel(f.last_round_type).replace(/^(a|an) /, "").replace("round (series not disclosed)", "undisclosed series");
    parts.push(`last round: ${label}${amount ? ` (${amount})` : ""}${f.last_fundraise_date ? ` in ${monthYear(f.last_fundraise_date)}` : ""}`);
  }
  return { line: parts.join(", ") || "no company data yet", flag };
}

// ---------------------------------------------------------------------------
// Funding and company status (from the company watch's `changes`)
// ---------------------------------------------------------------------------

export type Change = { field?: string; type?: string; from?: unknown; to?: unknown; new_elements?: unknown };

const ROUND_LABELS: Record<string, string> = {
  pre_seed: "pre-seed", seed: "seed", angel: "angel", series_unknown: "a round (series not disclosed)", undisclosed: "an undisclosed round",
  secondary_market: "a secondary sale", debt_financing: "debt financing", convertible_note: "a convertible note", grant: "a grant",
  corporate_round: "a corporate round", private_equity: "private equity", equity_crowdfunding: "equity crowdfunding",
  product_crowdfunding: "product crowdfunding", initial_coin_offering: "a token sale", post_ipo_equity: "post-IPO equity",
  post_ipo_debt: "post-IPO debt", post_ipo_secondary: "a post-IPO secondary", non_equity_assistance: "non-equity support",
};
export function roundLabel(type: string): string {
  const t = String(type).toLowerCase();
  const series = /^series_([a-z])$/.exec(t);
  if (series) return `Series ${series[1].toUpperCase()}`;
  return ROUND_LABELS[t] ?? t.replace(/_/g, " ");
}

/** Rank of a priced round (pre-seed 1, seed 2, Series A 3...), or undefined for debt, notes and undisclosed rounds. */
export function pricedRank(type: string | undefined | null): number | undefined {
  const t = String(type ?? "").toLowerCase();
  if (t === "pre_seed" || t === "angel") return 1;
  if (t === "seed") return 2;
  const s = /^series_([a-z])$/.exec(t);
  return s ? 3 + s[1].charCodeAt(0) - 97 : undefined;
}
/** Debt and notes: a bridge when they follow a priced round. (An undisclosed series may well be the next priced round.) */
const NOT_PRICED = /^(convertible_note|debt_financing|post_ipo_debt)$/;

export function money(usd: number | null | undefined): string | undefined {
  if (typeof usd !== "number" || !(usd > 0)) return undefined;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(usd >= 1e10 ? 0 : 1).replace(/\.0$/, "")}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(usd >= 1e8 ? 0 : 1).replace(/\.0$/, "")}M`;
  return `$${Math.round(usd / 1e3)}K`;
}
/** new_elements as a list whatever shape arrives (a single string or object counts as one). */
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const names = (v: unknown): string[] =>
  asList(v).map(x => (typeof x === "string" ? x : (x as any)?.name ?? (x as any)?.acquiree_name ?? (x as any)?.acquirer_name ?? (x as any)?.company_name)).filter((x): x is string => typeof x === "string" && x.trim() !== "").map(x => clip(x, 80));
const list = (xs: string[], max = 5) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);

export function fundingSignals(c: CompanyRef, changes: Change[], record: CompanyRecord | undefined): Signal[] {
  const out: Signal[] = [];
  const f = record?.funding ?? {};
  const field = (name: string) => changes.find(ch => ch?.field === name);
  const roundType = field("funding.last_round_type");
  const roundDate = field("funding.last_fundraise_date");
  const investors = names(field("funding.investors")?.new_elements);
  const fromDate = isoDate(roundDate?.from as string | undefined);
  const toDate = isoDate(String(roundDate?.to ?? f.last_fundraise_date ?? ""));
  // A round date moved earlier, or by less than two months with nothing else changing, is a data fix, not a new round.
  const shift = fromDate && toDate ? (new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86_400_000 : undefined;
  const backfill = Boolean(roundDate && !roundType && !investors.length && shift !== undefined && (shift < 0 || shift < 60));
  if ((roundType || roundDate) && !backfill) {
    const type = String(roundType?.to ?? f.last_round_type ?? "");
    const before = (roundType?.from as string | undefined) ?? (roundType ? undefined : type);
    const amount = money(f.last_round_amount_usd);
    const was = roundType?.from ? `; last round before was ${roundLabel(String(roundType.from))}` : "";
    const secondary = /secondary/.test(type);
    const newRank = pricedRank(type);
    const oldRank = pricedRank(before);
    // Debt, a note or an undisclosed round after a priced round, a smaller round type than before, or another round
    // of the same series: a bridge or an extension, which a fund wants to hear about as a warning.
    // From a priced seed round up: a fund's bridge risk starts there.
    const bridge = !secondary && oldRank !== undefined && oldRank >= 2 && ((NOT_PRICED.test(type)) || (newRank !== undefined && newRank <= oldRank));
    // Only the date moved, same round type: an extension, or Crustdata correcting the date. Worth a note, not an alarm.
    const dateOnly = bridge && !roundType;
    const what = secondary ? "Secondary sale recorded" : bridge ? `${newRank !== undefined && newRank === oldRank ? "Extension" : "Bridge or smaller round"}: ${type ? roundLabel(type) : "type not disclosed"}${amount ? `, ${amount}` : ""}` : `${NOT_PRICED.test(type) ? "New financing" : "New round"}: ${type ? roundLabel(type) : "type not disclosed"}${amount ? `, ${amount}` : ""}`;
    // A note or debt before a priced seed is ordinary, but not a round to claim pro rata in.
    const unpriced = !bridge && !secondary && NOT_PRICED.test(type);
    const text = `${what}${toDate ? ` (${longDate(toDate)})` : ""}${was}${investors.length ? `. New investors: ${list(investors)}` : ""}`;
    out.push({ key: `round:${c.domain}:${toDate ?? "nodate"}:${type}`, domain: c.domain, company: c.name, kind: bridge ? "bridge_round" : "round", severity: secondary || dateOnly || unpriced ? "note" : bridge ? "alert" : "good", text, why: secondary ? WHY.secondary : bridge ? WHY.bridge : unpriced ? WHY.financing : WHY.round, date: toDate });
  } else if (investors.length) {
    out.push({ key: `investors:${c.domain}:${investors.slice().sort().join("|").toLowerCase()}`, domain: c.domain, company: c.name, kind: "investors", severity: "note", text: `New investors on the cap table: ${list(investors)}`, why: WHY.investors });
  }
  const acquired = names(field("funding.acquired_by")?.new_elements);
  if (acquired.length) out.push({ key: `acquired:${c.domain}:${acquired[0].toLowerCase()}`, domain: c.domain, company: c.name, kind: "acquired", severity: "alert", text: `Acquired by ${list(acquired, 2)} (Crustdata company data)`, why: WHY.acquired });
  const bought = names(field("funding.acquisitions")?.new_elements);
  if (bought.length) out.push({ key: `acquisition:${c.domain}:${bought.slice().sort().join("|").toLowerCase()}`, domain: c.domain, company: c.name, kind: "acquisition", severity: "note", text: `Acquired ${list(bought)}`, why: WHY.acquisition });
  const status = field("basic_info.status");
  // "acquired" status next to an acquired-by change says the same thing twice.
  if (status && status.to && status.to !== status.from && !(acquired.length && /acquir/i.test(String(status.to)))) {
    const to = String(status.to).toLowerCase();
    out.push({ key: `status:${c.domain}:${to}`, domain: c.domain, company: c.name, kind: "status", severity: to === "active" ? "note" : "alert", text: `Company status changed from ${String(status.from ?? "unknown").toLowerCase()} to ${to}`, why: WHY.status });
  }
  return out;
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

/** Layoffs, shutdowns, insolvency, executive exits. */
const BAD = /\b(lay(s|ing)? off|laid off|layoffs?|job cuts|(cuts?|cutting|to cut|sheds?|shedding|to shed) ((\d[\d,]*%?|a third|a quarter|half|hundreds|dozens) (of )?)?(its |the )?(jobs|staff|workforce|employees|roles|headcount|team(?!'s)|people)|(cuts?|cutting|to cut|sheds?|shedding) \d[\d,]*%(?! of (its )?(emissions|costs?|spend|bill|time|prices?))|fires \d[\d,]*( |$)|(cuts?|to cut|cutting|sheds?) \d[\d,]*$|reduction in force|lets? go (of )?\d*|slash(es|ing)? (\d+ )?(jobs|staff|headcount|workforce)|trims? (\d+%? (of )?)?(its )?(workforce|staff|headcount|jobs)|reduces? (its )?(workforce|headcount|staff)|furlough(s|ed|ing)?|downsiz(es|ing)|restructur(es|ing) (its )?(team|workforce|company|business|operations)|(shut(s|ting)?|to shut) down(?=\s*($|operations|after|amid|as|following|[,.;:]))|shutdown(?=\s*($|[,.;:]))|winds? down|winding down|bankrupt(cy)?|chapter (7|11)|files? for (bankruptcy|chapter|insolvency)|insolven(t|cy)|(enters|into) administration|receivership|ceases? operations|closes? (its )?doors|misses payroll|explores? (a )?sale|resigns?|steps? down|stepping down|(ceo|founder|co-?founder|cto|cfo|coo|president)\s+(\S+\s+){0,3}steps? back|ousted|is fired|was fired|fires (its )?(ceo|founder|co-?founder|cto|cfo|coo|president)|(founder|co-?founder|ceo|cto|cfo) (leaves|exits|departs|quits)(?!\s+(twitter|x|social|instagram|facebook|threads))|(pauses|freezes) hiring|hiring freeze)\b/i;
/** Down rounds and rescue financing: warnings even though the headline is about money. */
const DOWN = /\b(down round|flat round|bridge (round|loan|financing|funding|note)|raises?[^.;:]{0,25}\bbridge\b|extension round|raises? (an? )?extension|lower valuation|valuation (cut|slashed|halved)|(slash|cut|halve)(s|es|d|ed|ing)? (its )?valuation|recapitali[sz](ation|es|ed)|rescue (round|financing))\b/i;
/** Legal and security stories: worth a note, not an alarm. */
const LEGAL = /\b(lawsuit|sued( by)?|sues|class action|investigation|probe|regulator|fined|data breach|breach|hacked|cyberattack|leak(ed)?)\b/i;
const MONEY = /\b(raises?|raised|secures?|closes? (a |an |its )?(\$|round|seed|series)|funding round|series [a-h]\b|seed round|pre-seed|valuation|valued at|unicorn|acquires?|acquired|acquisition|merges?|merger|buys|to buy|ipo|goes public)\b/i;
/** Headlines where the portfolio company is the object: "Layoffs hit Acme", "Google acquires Acme". */
const BAD_OBJECT = /\b(layoffs?|job cuts|cuts|bankruptcy|insolvency|shutdown|restructuring)\s+(at|hits?|hit|of|for|by|rock|rocks|strike|strikes)\s+$/i;
const BOUGHT = /\b(acquires?|acquired|to acquire|buys|to buy|bought|snaps up|picks up|takes over)\s+$/i;

/** Where the company's name first appears in a headline, as a whole word ("Front-line" is not "Front"); -1 when not. */
const nameAt = (name: string, title: string): number => {
  const n = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!n) return -1;
  const m = new RegExp(`(^|[^\\p{L}\\p{N}-])${n}($|[^\\p{L}\\p{N}-])`, "iu").exec(title);
  return m ? m.index + m[1].length : -1;
};
const namedAt = (c: CompanyRef, title: string): number => {
  // The domain's first part stands for the name only when it is long enough not to be an everyday word ("go", "ai").
  const stem = c.domain.split(".")[0];
  const at = [nameAt(c.name, title), stem.length >= 4 ? nameAt(stem, title) : -1].filter(i => i >= 0);
  return at.length ? Math.min(...at) : -1;
};
/** Someone else's news that mentions the company first ("Acme rival Beta lays off 30%"). */
const OTHER_PARTY = /\b(rival|rivals|competitor|competitors|parent|customer|customers|partner|partners|investor|investors|backer|supplier|client)\b/i;
/** First match of `re` at or after `from` with no other party named in between, or Infinity. */
const firstAfter = (re: RegExp, title: string, from: number): number => {
  for (const m of title.matchAll(new RegExp(re.source, "gi"))) if (m.index! >= from && !OTHER_PARTY.test(title.slice(from, m.index!))) return m.index!;
  return Infinity;
};

export type Article = { article_title?: string; article_url?: string; article_publish_date?: string; article_publisher_name?: string };

/**
 * News articles the company watch added. The company must be the subject: named before the words that decide the
 * kind ("Acme lays off", not "Retailer lays off 300; suppliers including Acme"), and whichever of the money, bad,
 * down-round or legal words comes first after the name wins ("Acme raises $20M to help retailers avoid layoffs" is
 * money). Layoffs, shutdowns and down rounds are alerts; legal stories notes; money good news; the rest digest only.
 * Articles older than 30 days (added late) are digest only, and articles that do not name the company are dropped.
 */
export function newsSignals(c: CompanyRef, changes: Change[], now = new Date()): Signal[] {
  const out: Signal[] = [];
  const added = changes.filter(ch => ch?.field === "news" && ch.type === "added").flatMap(ch => asList(ch.new_elements) as Article[]);
  for (const a of added) {
    const title = clip(String(a?.article_title ?? ""), 160);
    const url = typeof a?.article_url === "string" && /^https?:\/\//i.test(a.article_url) ? a.article_url : undefined;
    if (!title || !url) continue;
    const at = namedAt(c, title);
    if (at < 0) continue;
    const date = isoDate(a.article_publish_date);
    const recent = !date || now.getTime() - new Date(date).getTime() <= 30 * 86_400_000;
    const publisher = a.article_publisher_name ? ` (${clip(String(a.article_publisher_name), 40)})` : "";
    const base = { key: `news:${c.domain}:${url.replace(/[?#].*$/, "").toLowerCase()}`, domain: c.domain, company: c.name, url, linkLabel: "article", date, text: `In the news${date ? ` (${shortDate(date)})` : ""}: "${title}"${publisher}` };
    // An aside right after the name ("Acme, the Stripe rival, lays off 20%") is skipped when reading what Acme did.
    const subjectText = title.slice(0, at) + title.slice(at).replace(/^(\S+(\s\S+){0,3}?),\s[^,]{1,80},\s/, "$1 ");
    const hits = [
      { kind: "down", i: firstAfter(DOWN, subjectText, at) },
      { kind: "bad", i: firstAfter(BAD, subjectText, at) },
      { kind: "money", i: firstAfter(MONEY, subjectText, at) },
      { kind: "legal", i: firstAfter(LEGAL, subjectText, at) },
    ].filter(h => h.i !== Infinity).sort((x, y) => x.i - y.i || (x.kind === "down" ? -1 : 0));
    // A down round or rescue financing is a warning even when the headline leads with "raises".
    // The company as the object of the headline: what comes just before its name decides, unless another party follows
    // the name ("Google acquires Acme rival Beta" is about Beta).
    const before = title.slice(0, at);
    const after = title.slice(at, at + 40).replace(/^\S+/, "");
    const aboutSomeoneElse = /^\s*('s)?\s*\b(rival|rivals|competitor|competitors|customer|customers|partner|partners|supplier|client|investor|backer|parent|subsidiary)\b/i.test(after);
    const object = recent && !aboutSomeoneElse ? (BOUGHT.test(before) ? "bought" : BAD_OBJECT.test(before) ? "bad" : undefined) : undefined;
    const first = object ?? (recent ? (hits.some(h => h.kind === "down") ? "down" : hits[0]?.kind) : undefined);
    if (first === "bought") out.push({ ...base, kind: "acquired", severity: "alert", why: WHY.acquired });
    else if (first === "down") out.push({ ...base, kind: "bad_news", severity: "alert", why: WHY.down_round });
    else if (first === "bad") out.push({ ...base, kind: "bad_news", severity: "alert", why: WHY.bad_news });
    else if (first === "legal") out.push({ ...base, kind: "legal_news", severity: "note", why: WHY.legal_news });
    else if (first === "money") out.push({ ...base, kind: "funding_news", severity: "good", why: WHY.funding_news });
    else out.push({ ...base, kind: "news", severity: "news" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leaders
// ---------------------------------------------------------------------------

const roleWord = (role: LeaderRole) => (role === "founder" ? "founder" : role === "ceo" ? "CEO" : "leader");

export function leaderSignal(l: Leader, e: LeaderEvent, now = new Date()): Signal {
  const who = `${l.name} (${clip(l.title, 60)})`;
  const day = isoDate(now)!;
  const base = { domain: l.domain, company: l.company, url: l.profileUrl, linkLabel: "profile", date: day };
  if (e.kind === "left") {
    const where = e.newCompany ? `; now ${e.newTitle ? `${clip(e.newTitle, 60)} at ` : "at "}${clip(e.newCompany, 60)}` : "; no new role listed yet";
    const why = l.role === "founder" ? WHY.founder_left : l.role === "ceo" ? WHY.ceo_left : WHY.c_level_left;
    return { ...base, key: `leader_left:${l.domain}:${l.profileUrl}:${day}`, kind: "leader_left", severity: "alert", text: `${capital(roleWord(l.role))} left: ${who} no longer lists a role at ${l.company}${where}`, why };
  }
  if (e.kind === "ceo_changed") return { ...base, key: `ceo_changed:${l.domain}:${l.profileUrl}:${day}`, kind: "ceo_changed", severity: "alert", text: `CEO change: ${l.name} is no longer CEO at ${l.company}; now ${clip(e.newTitle, 60)} there${e.elsewhereCompany ? `, and ${e.elsewhereTitle ? `${clip(e.elsewhereTitle, 60)} at ` : "at "}${clip(e.elsewhereCompany, 60)}` : ""}`, why: WHY.ceo_changed };
  if (e.kind === "stepped_back") return { ...base, key: `leader_stepped_back:${l.domain}:${l.profileUrl}:${day}`, kind: "leader_stepped_back", severity: "alert", text: `Stepped back: ${who} is now ${clip(e.newTitle, 60)} at ${l.company}`, why: WHY.stepped_back };
  if (e.kind === "role") return { ...base, key: `leader_role:${l.domain}:${l.profileUrl}:${day}`, kind: "leader_role", severity: "note", text: `${who} is now ${clip(e.newTitle, 60)} at ${l.company}`, why: WHY.role };
  if (e.kind === "returned") return { ...base, key: `leader_returned:${l.domain}:${l.profileUrl}:${day}`, kind: "leader_returned", severity: "note", text: `${l.name} lists a role at ${l.company} again${e.newTitle ? ` (${clip(e.newTitle, 60)})` : ""}`, why: WHY.returned };
  return { ...base, key: `leader_side_role:${l.domain}:${l.profileUrl}:${day}`, kind: "leader_side_role", severity: "note", text: `${who} now lists a main role${e.newTitle ? ` as ${clip(e.newTitle, 60)}` : ""}${e.newCompany ? ` at ${clip(e.newCompany, 60)}` : " elsewhere"}, while still at ${l.company}`, why: WHY.side_role };
}

/** A founder or C-level found by a later search who was not there before. */
export function leaderJoinedSignal(l: Leader, now = new Date()): Signal {
  const big = l.role === "ceo" || /\b(CEO|CFO|chief (executive|financial) officer)\b/i.test(l.title);
  return { key: `leader_joined:${l.domain}:${l.profileUrl}`, domain: l.domain, company: l.company, kind: "leader_joined", severity: big ? "alert" : "note", text: `New leader: ${l.name} (${clip(l.title, 60)}) now lists a role at ${l.company}`, why: big ? WHY.joined_ceo : WHY.joined, url: l.profileUrl, linkLabel: "profile", date: isoDate(now) };
}

// ---------------------------------------------------------------------------
// Hiring
// ---------------------------------------------------------------------------

export type Reading = { at: string; roles: number };

/**
 * Hiring signals from the role counts of the last 10 weeks (oldest first, the newest last). Compares with the reading
 * closest to 4 weeks before the newest one (3 to 6 weeks back), so one odd week does not fire.
 */
export function hiringSignals(c: CompanyRef, readings: Reading[], t: Thresholds, source: string): Signal[] {
  const out: Signal[] = [];
  if (readings.length < 2) return out;
  const now = readings.at(-1)!;
  const prev = readings.at(-2)!;
  const nowT = new Date(now.at).getTime();
  const daysBack = (r: Reading) => (nowT - new Date(r.at).getTime()) / 86_400_000;
  const base = readings.slice(0, -1).filter(r => daysBack(r) >= 21 && daysBack(r) <= 42).sort((a, b) => Math.abs(daysBack(a) - 28) - Math.abs(daysBack(b) - 28))[0];
  const date = now.at.slice(0, 10);
  // A careers page reading links the page itself, so only the job postings index is named in the text.
  const mk = (kind: Signal["kind"], severity: Signal["severity"], text: string, why: string): Signal => ({ key: `${kind}:${c.domain}:${date}`, domain: c.domain, company: c.name, kind, severity, text: source === "careers page" ? text : `${text} (${source})`, why, date });

  // Stopped: two readings in a row at zero, after one with open roles. Two, because one empty page can be a glitch.
  const lastWithRoles = [...readings].reverse().find(r => r.roles > 0);
  if (now.roles === 0 && prev.roles === 0 && lastWithRoles && lastWithRoles.roles >= t.hiring_stopped.from_at_least && readings.at(-3) === lastWithRoles) {
    out.push(mk("hiring_stopped", "alert", `No open roles found ${source === "careers page" ? "on the careers page " : ""}for two readings in a row (${lastWithRoles.roles} on ${shortDate(lastWithRoles.at)})`, WHY.hiring_stopped));
    return out;
  }
  if (base) {
    const more = now.roles - base.roles;
    if (base.roles > 0 && now.roles >= base.roles * t.hiring_jump.times && more >= t.hiring_jump.more_roles) {
      out.push(mk("hiring_jump", "good", `Hiring jumped: ${now.roles} open roles, up from ${base.roles} on ${shortDate(base.at)}`, WHY.hiring_jump));
    } else if (now.roles > 0 && -more >= t.hiring_slowed.fewer_roles && (-more / Math.max(base.roles, 1)) * 100 >= t.hiring_slowed.percent) {
      out.push(mk("hiring_slowed", "note", `Hiring slowed: ${now.roles} open roles, down from ${base.roles} on ${shortDate(base.at)}`, WHY.hiring_slowed));
    }
  }
  // Started: zero on every reading over the quiet stretch (one reading from its start is enough, so a monthly schedule
  // works too), now some.
  const qd = t.hiring_started.quiet_weeks * 7;
  const quiet = readings.slice(0, -1).filter(r => daysBack(r) <= qd + 10);
  const longEnough = quiet.some(r => daysBack(r) >= qd - 3);
  if (now.roles >= t.hiring_started.to_at_least && longEnough && quiet.every(r => r.roles === 0)) {
    out.push(mk("hiring_started", "good", `Hiring again: ${plural(now.roles, "open role")} after ${t.hiring_started.quiet_weeks}+ weeks with none`, WHY.hiring_started));
  }
  return out;
}
