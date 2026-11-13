/**
 * Memo and comparison as markdown and CSV. Pure functions: a Memo in, text out.
 */

import { fmtInt, fmtMonth, fmtPct, fmtUsd, type Fact, type Leaver, type Memo } from "./memo.js";

/**
 * Text from the data, safe inside markdown: no stray formatting, links, HTML, headings, lists or rules. Line breaks
 * become spaces, so one value never spans lines.
 */
export function md(s: string | number | null | undefined): string {
  const t = String(s ?? "").replace(/(\r\n?|\n)+/g, " ").replace(/([\\`*_{}\[\]<>|#~])/g, "\\$1").trim();
  // A value at the start of a line could become a list item ("- x"), a numbered list ("1. x") or a rule ("---").
  return t.replace(/^([-+])(\s)/, "\\$1$2").replace(/^([-=]{3,})/, "\\$1").replace(/^(\d+)([.)])(\s)/, "$1\\$2$3");
}
/** A table cell. */
const cell = (s: string | number | null | undefined) => md(s) || " ";
/** A link only when the URL is plain http(s). */
const link = (text: string, url?: string) => (url && /^https?:\/\/[^\s()<>]+$/i.test(url) ? `[${md(text)}](${url})` : md(text));
const NA = "not available";
/** Text cut at a word boundary, with "..." when cut. */
export const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}...`);

function factTable(facts: Fact[]): string[] {
  if (!facts.length) return [];
  return [
    "| | Value | Source (field, as of) |",
    "| --- | --- | --- |",
    ...facts.map(f => `| ${cell(f.label)} | ${cell(f.text)} | ${cell(`${f.source}${f.as_of ? `, ${f.as_of}` : ""}`)} |`),
    "",
  ];
}

const section = (title: string, body: string[], missing: string) => [`### ${title}`, "", ...(body.length ? body : [`${missing}`, ""])];
const personCell = (l: Leaver) => (l.name ? (l.profile_url ? link(l.name, l.profile_url) : cell(l.name)) : "(not named)");

export function renderMemo(m: Memo): string {
  const c = m.company;
  const out: string[] = [];
  out.push(`# ${md(c.name)}: private company research memo`, "");
  if (c.description) out.push(md(c.description), "");
  const meta = [
    link(c.domain, `https://${c.domain}`),
    c.founded ? `founded ${c.founded}` : undefined,
    c.hq ? md(c.hq) : undefined,
    c.profile_url ? link("company profile", c.profile_url) : undefined,
    c.categories.length ? md(c.categories.join(", ")) : undefined,
  ].filter(Boolean);
  out.push(meta.join(" · "), "");
  out.push(`Researched ${m.generated_at.slice(0, 10)} from Crustdata data fetched ${m.data_fetched_at.slice(0, 10)}${m.credits_used ? `: ${m.credits_used} credits charged, ${m.list_price_credits} at list price (your plan can charge less)` : `: 0 credits, from answers saved by an earlier run (${m.list_price_credits} at list price when fetched fresh)`}. Every number names the Crustdata field it comes from and a date: the date the data describes where Crustdata gives one, otherwise the day it was fetched. Built with [private-company-research-agent](https://github.com/crustdata/tools/tree/main/private-company-research-agent).`, "");
  if (m.coverage.available < m.coverage.of / 2) out.push(`> **Thin data:** only ${m.coverage.available} of ${m.coverage.of} sections have data (missing: ${m.coverage.missing.join(", ")}). No red flags here does not mean a clean company.`, "");
  for (const w of m.warnings) out.push(`> **Check:** ${md(w)}`, "");

  out.push("## Snapshot", "", ...(m.snapshot.length ? factTable(m.snapshot) : [NA, ""]));

  const flags = m.findings.filter(f => f.kind === "red_flag");
  const signals = m.findings.filter(f => f.kind === "signal");
  out.push("## Red flags", "");
  if (flags.length) for (const f of flags) out.push(`- ${md(f.text)}  `, `  Evidence: ${md(f.evidence)}`);
  else out.push("None found by the rules this memo checks (leaders leaving or running another company, the team shrinking, falling traffic, low employee ratings, a long gap since the last round with a flat team, layoff or lawsuit news). That is not a clean bill of health: check the sections below.");
  out.push("");
  if (signals.length) {
    out.push("## Signals", "");
    for (const f of signals) out.push(`- ${md(f.text)}  `, `  Evidence: ${md(f.evidence)}`);
    out.push("");
  }
  out.push("## Questions for the founder call", "");
  if (m.questions.length) m.questions.forEach((q, i) => out.push(`${i + 1}. ${md(q)}`));
  else out.push("No questions came out of the data. Start with the sections below.");
  out.push("");
  if (m.ai_note) {
    out.push("## Analyst note (AI)", "");
    for (const para of m.ai_note.text.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean)) out.push(md(para), "");
    out.push(`Written by ${md(m.ai_note.model)} from the facts in this memo only. Check it against the tables before you rely on it.`, "");
  }

  // Team
  out.push("## Team", "");
  const t = m.team;
  const leaders = t.leaders.length ? [
    "| Name | Role | Joined | Before | Schools | Source |",
    "| --- | --- | --- | --- | --- | --- |",
    ...t.leaders.map(l => `| ${l.profile_url ? link(l.name, l.profile_url) : cell(l.name)}${l.founder ? " (founder)" : ""} | ${cell(l.title)} | ${cell(l.joined ?? "")} | ${cell(l.prior.join("; ") || "none listed")}${l.founded_before.length ? ` **Founded before: ${md(l.founded_before.join(", "))}.**` : ""}${l.also_running ? ` **Also listed now as ${md(l.also_running)}.**` : ""}${l.years_experience !== undefined ? ` ${l.years_experience} years of experience.` : ""} | ${cell(l.schools.join("; "))} | ${cell(`${l.source}${l.as_of ? `, ${l.as_of}` : ""}`)} |`),
    "",
    ...(t.other_leaders.length ? [`Other leaders: ${t.other_leaders.map(o => `${md(o.name)} (${md(o.title)})`).join(", ")}. Source: people.decision_makers.`, ""] : []),
  ] : [];
  out.push(...section("Founders and executives", leaders, `${NA}: Crustdata lists no founders or executives for this company.`));

  const fn = t.functions;
  const fnBody: string[] = [];
  if (fn && fn.rows.length) {
    const hasBefore = fn.rows.some(r => r.before !== undefined);
    fnBody.push(hasBefore ? `| Function | ${fmtMonth(fn.as_of) ?? "Now"} | ${fmtMonth(fn.before_date) ?? "6 months before"} | Change |` : "| Function | People | 6-month change |", hasBefore ? "| --- | ---: | ---: | ---: |" : "| --- | ---: | ---: |");
    for (const r of fn.rows.slice(0, 12)) {
      fnBody.push(hasBefore
        ? `| ${cell(r.function)} | ${r.now} | ${r.before ?? "n/a"} | ${r.change === undefined ? "n/a" : `${r.change > 0 ? "+" : ""}${r.change}${r.change_pct !== undefined ? ` (${fmtPct(r.change_pct)})` : ""}`} |`
        : `| ${cell(r.function)} | ${r.now} | ${r.change_pct === undefined ? "n/a" : fmtPct(r.change_pct)} |`);
    }
    fnBody.push("", `Source: ${fn.source}${fn.as_of ? `, as of ${fn.as_of}` : ""}. People whose profile names no function are not in this table, so it adds up to less than the headcount.`);
    if (t.engineering_share) fnBody.push(`Engineering is ${t.engineering_share.text} of the team (${t.engineering_share.source}, ${t.engineering_share.as_of}).`);
    if (t.countries.length) fnBody.push(`Where the team is: ${t.countries.map(x => `${md(x.country)} ${fmtInt(x.people)}`).join(", ")} (headcount.by_region_absolute).`);
    fnBody.push("");
  }
  out.push(...section("Team by function", fnBody, `${NA}: Crustdata has no function breakdown for this company.`));

  const d = t.departures;
  const depBody: string[] = [];
  if (d) {
    const parts = [
      d.excluded.interns ? `${d.excluded.interns} ${d.excluded.interns === 1 ? "was an intern or program member" : "were interns or program members"}` : "",
      d.excluded.advisors_or_contractors ? `${d.excluded.advisors_or_contractors} ${d.excluded.advisors_or_contractors === 1 ? "was an advisor or contractor" : "were advisors or contractors"}` : "",
    ].filter(Boolean);
    const staff = `${d.staff_estimated ? "about " : ""}${fmtInt(d.staff_total ?? 0)} ${parts.length ? "were staff" : "of them staff"}`;
    if (!d.searched || d.total === null) depBody.push(`The departures search failed for this company, so how many people left is not available. Senior role changes from the second search are shown below.`, "");
    else depBody.push(`${fmtInt(d.total)} ${d.total === 1 ? "person" : "people"} left since ${d.since}${parts.length ? `. Of the ${d.shown} read, ${parts.join(" and ")}, so ${staff}` : d.staff_estimated ? `, ${staff}` : ""}${d.share_of_headcount_pct !== undefined ? `${parts.length || d.staff_estimated ? ":" : ","} ${fmtPct(d.share_of_headcount_pct, false)} of today's headcount` : ""}. Counted from public profiles, so treat it as a lower bound. Source: person search on experience.employment_details (a role here ended since ${d.since}, no current role here).`, "");
    if (!d.searched) depBody.push("Only senior role changes were searched, so other people who left are not counted here.", "");
    else if (d.capped) depBody.push(`Leaders are checked among the ${d.shown} people read, not all ${fmtInt(d.total ?? 0)}: a leader among the others can be missed. Raise LEAVERS_LIMIT to read more (0.23 credits a person at list price).`, "");
    if (d.people.length) {
      depBody.push("| Name | Role here | Left | Now |", "| --- | --- | --- | --- |");
      for (const l of d.people) depBody.push(`| ${personCell(l)}${l.leader ? " **(leader)**" : l.senior ? " (senior)" : l.category !== "staff" ? ` (${l.category})` : ""} | ${cell(l.title)} | ${cell(l.ended ?? "")} | ${cell(l.now)} |`);
      depBody.push("");
    }
    if (d.stepped_back.length) {
      depBody.push("Stepped back but still listed at the company:", "");
      for (const l of d.stepped_back) depBody.push(`- ${personCell(l)}: ${md(l.title)} until ${md(l.ended ?? "an unknown date")}, now ${md(l.now)}`);
      depBody.push("");
    }
  }
  const depWhy = m.not_available.find(x => x.startsWith("Departures"));
  out.push(...section("Departures in the last 12 months", depBody, `${NA}${depWhy ? `: ${md(depWhy.replace(/^Departures \(|\)$/g, ""))}` : " (LEAVERS_LIMIT is 0)"}.`));

  const h = t.hiring;
  const hireBody: string[] = [];
  if (h) {
    if (h.postings === 0 && h.newest_posting) {
      const n = h.newest_posting;
      hireBody.push(`The job index looks behind for this company: Crustdata has ${fmtInt(n.on_record)} posting${n.on_record === 1 ? "" : "s"} on record, none added since ${h.since}. The newest${n.title ? ` (${md(n.title)})` : ""} ${n.date ? `is from ${n.date}` : "carries no date, and undated postings never match a date window"}. Check the company's careers page before reading this as a hiring freeze.`, "");
    } else if (h.postings === 0 && h.newest_posting === null) {
      hireBody.push("Crustdata has no job postings on record for this company. Check its careers page.", "");
    } else {
      hireBody.push(`${fmtInt(h.postings)} job posting${h.postings === 1 ? "" : "s"} added since ${h.since} (${h.roles} distinct role${h.roles === 1 ? "" : "s"})${h.categories.length ? `: ${h.categories.map(x => `${md(x.category)} ${x.count}`).join(", ")}` : ""}. Source: job search, job_details.title and job_details.category counts.`, "");
      if (h.titles.length) hireBody.push(`Roles: ${h.titles.map(md).join("; ")}.`, "");
      if (h.thin_for_growth) hireBody.push(`Only ${fmtInt(h.postings)} posting${h.postings === 1 ? " was" : "s were"} added in 90 days while headcount grew by ${fmtInt(h.thin_for_growth.added_3m)} in 3 months: Crustdata's job index is likely missing postings. Check the careers page before reading this as a slowdown.`, "");
      else hireBody.push("Crustdata's job index can miss postings. If this count looks low next to the headcount growth above, check the company's careers page.", "");
    }
  }
  out.push(...section("Hiring", hireBody, `${NA}.`));

  // Growth
  out.push("## Growth and traction", "");
  out.push(...section("Headcount", factTable(m.growth.headcount), `${NA}.`));
  const w = m.growth.web;
  out.push(...section(w ? `Web traffic (${md(w.domain)})` : "Web traffic", w ? [...factTable(w.facts), ...(w.other_domains.length ? [`Other domains with traffic data: ${w.other_domains.map(md).join(", ")} (not added in).`, ""] : [])] : [], `${NA}: Crustdata has no web traffic for this company.`));
  out.push(...section("Followers", factTable(m.growth.followers), `${NA}.`));
  out.push(...section("Search and ads", factTable(m.growth.search), `${NA}.`));
  out.push(...section("Product launches", factTable(m.growth.launches), `${NA}: no Product Hunt launches on record.`));
  out.push(...section("Employee reviews", factTable(m.growth.reviews), `${NA}: no employee reviews on record.`));

  // Funding
  out.push("## Funding", "");
  const fu = m.funding;
  if (fu.facts.length || fu.rounds.length) {
    out.push(...factTable(fu.facts));
    if (fu.rounds.length) {
      out.push("| Date | Round | Amount | Lead | Investors |", "| --- | --- | ---: | --- | ---: |");
      for (const r of fu.rounds) out.push(`| ${r.date} | ${cell(r.type)}${r.secondary ? " (not new money)" : ""} | ${r.amount_usd !== undefined ? fmtUsd(r.amount_usd) : "undisclosed"} | ${cell(r.lead ?? "")} | ${r.investors || ""} |`);
      out.push("", "Source: funding.milestones.", "");
    }
    if (fu.funds || fu.angels) out.push(`Investors on record: ${fu.funds} fund${fu.funds === 1 ? "" : "s"} and ${fu.angels} angel${fu.angels === 1 ? "" : "s"} (funding.investors_detailed).${fu.repeat_investors.length ? ` In more than one primary round: ${fu.repeat_investors.map(r => `${md(r.name)} (${r.rounds})`).join(", ")}.` : ""}`, "");
  } else out.push(`${NA}: no funding rounds on record. The company may be bootstrapped, or its rounds were never announced.`, "");

  // Peers
  out.push("## Peers", "");
  const p = m.peers;
  if (m.peers_skipped) out.push("Skipped (--no-peers or PEERS_LIMIT=0).", "");
  else if (p && p.rows.length > 1) {
    out.push("| Company | Headcount | 6-month growth | 12-month growth | Followers | Total raised | Last round |", "| --- | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const r of p.rows) {
      const kind = r.type && !/privately held/i.test(r.type) ? `, ${md(r.type.toLowerCase())}` : "";
      const nameCell = `${r.self ? "**" : ""}${md(r.name)}${r.self ? "**" : ""}${r.domain ? ` (${md(r.domain)}${kind})` : ""}`;
      out.push(`| ${nameCell} | ${r.headcount !== undefined ? fmtInt(r.headcount) : NA} | ${r.growth_6m_pct !== undefined ? fmtPct(r.growth_6m_pct) : NA} | ${r.growth_12m_pct !== undefined ? fmtPct(r.growth_12m_pct) : NA} | ${r.followers !== undefined ? fmtInt(r.followers) : NA} | ${r.total_raised_usd !== undefined ? fmtUsd(r.total_raised_usd) : "none on record"} | ${r.last_round ? `${md(r.last_round)}${r.last_round_date ? `, ${fmtMonth(r.last_round_date)}` : ""}` : "none on record"} |`);
    }
    const small = p.dropped.filter(x => x.reason === "small").map(x => md(x.domain));
    const unrelated = p.dropped.filter(x => x.reason === "unrelated").map(x => md(x.domain));
    const large = p.dropped.filter(x => x.reason === "large").map(x => md(x.domain));
    if (p.source === "auto" && p.rows.length < 3) out.push("", `Only ${p.rows.length - 1} automatic peer passed the filters, so this table says little about the market. Name the peers you care about with --peers a.com,b.com.`);
    out.push("", `${p.source === "user" ? "Peers you named (--peers)." : "Peers from Crustdata's search competitor lists (competitors.paid_seo, then competitors.organic_seo), kept only when they share an industry with this company and are between a tenth of its size and 20 times it. They are not checked by a person: confirm them, or name your own with --peers a.com,b.com."} Peer figures come from company search: headcount.total, headcount.growth_percent, followers.count, funding.*; a public company's private rounds can be missing, and for a company owned by private equity, total raised counts only the rounds on record, not the buyout.${small.length ? ` Left out as too small to compare: ${small.join(", ")}.` : ""}${unrelated.length ? ` Left out as in another industry: ${unrelated.join(", ")}.` : ""}${large.length ? ` Left out as far larger: ${large.join(", ")}.` : ""}${p.missing.length ? ` Not found in Crustdata: ${p.missing.map(md).join(", ")}.` : ""}`, "");
  } else out.push(`${NA}${p?.source === "user" ? ": none of the peers you named were found" : ": no usable competitors on record. Name some with --peers a.com,b.com"}.`, "");

  out.push("## Recent headlines (last 90 days)", "");
  if (m.news.length) {
    for (const n of m.news) out.push(`- ${n.date}: ${link(n.title, n.url)}${n.publisher ? ` (${md(n.publisher)})` : ""}`);
    out.push("", "Headlines from Crustdata's news for this company, kept when they name the company exactly (or its domain) and Crustdata is confident they are about it. A company named after an ordinary word can still get a stray one.");
  } else out.push("No headlines naming the company in the last 90 days on record (news).");
  out.push("");

  if (m.not_available.length) {
    out.push("## Not available", "", ...m.not_available.map(x => `- ${md(x)}`), "");
  }
  out.push("## Not in this memo", "", "Revenue, burn, customers and retention are not fields in Crustdata's record. Headlines above sometimes quote them; confirm any figure in the data room.", "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Comparison (a list of companies)
// ---------------------------------------------------------------------------

export type ComparisonRow = {
  asked: string;
  /** The company name from the input file, if it had one. */
  name?: string;
  /** Every column of the input row, passed through to the CSV so it can be joined back to the CRM. */
  fields?: Record<string, string>;
  memo?: Memo;
  memoPath?: string;
  error?: string;
};

const COLUMNS = [
  "domain", "company", "status", "what_it_does", "categories", "founded", "hq", "headcount", "growth_6m_pct", "growth_12m_pct",
  "engineering_share_pct", "monthly_visitors", "visitors_3m_change_pct", "total_raised_usd", "last_round", "last_round_date",
  "months_since_last_round", "left_last_12m", "staff_left_12m", "staff_left_pct", "leader_departures", "job_postings_90d", "jobs_note",
  "red_flags", "top_red_flag", "data_coverage", "rank", "memo",
] as const;
type Values = Record<(typeof COLUMNS)[number], string | number | undefined>;

function values(r: ComparisonRow): Values {
  const m = r.memo;
  const empty = Object.fromEntries(COLUMNS.map(c => [c, undefined])) as Values;
  if (!m) return { ...empty, domain: r.asked, company: r.name, status: r.error ?? "not researched" };
  const g = (label: string) => m.growth.headcount.find(f => f.label === label)?.value;
  const w = m.growth.web?.facts;
  const flags = m.findings.filter(f => f.kind === "red_flag");
  const n = (v: unknown) => (typeof v === "number" ? Math.round(v * 10) / 10 : undefined);
  const h = m.team.hiring;
  const jobsBehind = !!h && h.postings === 0 && h.newest_posting !== undefined;
  return {
    domain: m.company.domain,
    company: m.company.name,
    status: "ok",
    what_it_does: firstSentence(m.company.description),
    categories: m.company.categories.slice(0, 3).join("; ") || undefined,
    founded: m.company.founded,
    hq: m.company.hq,
    headcount: n(g("Headcount")),
    growth_6m_pct: n(g("6-month change")),
    growth_12m_pct: n(g("12-month change")),
    engineering_share_pct: n(m.team.engineering_share?.value),
    monthly_visitors: n(w?.find(f => f.label === "Monthly visitors")?.value),
    visitors_3m_change_pct: n(w?.find(f => f.label === "3-month change")?.value),
    total_raised_usd: n(m.funding.facts.find(f => f.label === "Total raised")?.value),
    last_round: m.last_round?.type,
    last_round_date: m.last_round?.date,
    months_since_last_round: n(m.funding.facts.find(f => f.label === "Months since last round")?.value),
    left_last_12m: m.team.departures?.searched ? m.team.departures.total ?? undefined : undefined,
    staff_left_12m: m.team.departures?.searched ? m.team.departures.staff_total ?? undefined : undefined,
    staff_left_pct: m.team.departures?.searched ? m.team.departures.share_of_headcount_pct : undefined,
    leader_departures: m.team.departures ? m.team.departures.people.filter(p => p.senior && p.category === "staff").length + m.team.departures.stepped_back.length : undefined,
    job_postings_90d: jobsBehind ? undefined : h?.postings,
    jobs_note: jobsBehind ? (h!.newest_posting ? "job index behind, check the careers page" : "no postings on record") : h?.thin_for_growth ? "few postings for this growth, check the careers page" : undefined,
    red_flags: flags.length,
    top_red_flag: flags[0]?.text,
    data_coverage: `${m.coverage.available}/${m.coverage.of}`,
    rank: undefined,
    memo: r.memoPath,
  };
}

/** The first sentence of a description, clipped, for a table cell. */
export function firstSentence(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const sentences = d.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [d];
  // A mission or vision line says nothing about what the company sells: take the next sentence.
  const s = sentences.map(x => x.trim()).find(x => !/\b(mission|vision|we believe|our purpose)\b/i.test(x)) ?? sentences[0].trim();
  return clip(s.replace(/^To [^,]{3,80}, /, "").replace(/^./, c => c.toUpperCase()), 70);
}

/** A cell a spreadsheet will not run as a formula (=, +, -, @, tab or return at the start, after any spaces). */
export function csvCell(v: string | number | undefined): string {
  if (v === undefined || v === null) return "";
  let s = String(v);
  if (typeof v === "string" && /^\s*[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderComparisonCsv(rows: ComparisonRow[]): string {
  // The input file's own columns come after ours, prefixed "input_", so the file joins back to the CRM. Rows keep the
  // file's order; "rank" is the screening order of comparison.md.
  const extra = [...new Set(rows.flatMap(r => Object.keys(r.fields ?? {})))];
  const header = [...COLUMNS, ...extra.map(h => `input_${h}`)];
  const ranked = screeningOrder(rows);
  return [header.map(h => csvCell(h)).join(","), ...rows.map(r => {
    const v = { ...values(r), rank: r.memo ? ranked.indexOf(r) + 1 : undefined };
    return [...COLUMNS.map(c => csvCell(v[c])), ...extra.map(h => csvCell(r.fields?.[h]))].join(",");
  })].join("\n") + "\n";
}

/** Researched companies first: fewest red flags, then fastest 12-month growth; thin data and not researched last. */
export function screeningOrder(rows: ComparisonRow[]): ComparisonRow[] {
  const ok = rows.filter(r => r.memo), not = rows.filter(r => !r.memo);
  const thin = (r: ComparisonRow) => (r.memo!.coverage.available < r.memo!.coverage.of / 2 ? 1 : 0);
  const flags = (r: ComparisonRow) => r.memo!.findings.filter(f => f.kind === "red_flag").length;
  const growth = (r: ComparisonRow) => { const v = r.memo!.growth.headcount.find(f => f.label === "12-month change")?.value; return typeof v === "number" ? v : -Infinity; };
  return [...ok.sort((a, b) => thin(a) - thin(b) || flags(a) - flags(b) || growth(b) - growth(a)), ...not];
}

export function renderComparisonMd(rows: ComparisonRow[], title: string, today: string, counts?: { rows: number; unresolved: number; duplicates: number }): string {
  const done = rows.filter(r => r.memo).length;
  const head = counts
    ? `${done} of ${counts.rows} rows researched${counts.unresolved ? `; ${counts.unresolved} in unresolved.csv` : ""}${counts.duplicates ? `; ${counts.duplicates} duplicate${counts.duplicates === 1 ? "" : "s"} skipped` : ""}`
    : `${done} researched${rows.length > done ? `, ${rows.length - done} not` : ""}`;
  const out = [
    `# ${md(title)}: ${head}`, "",
    `Researched ${today} with [private-company-research-agent](https://github.com/crustdata/tools/tree/main/private-company-research-agent) on Crustdata. Sorted by fewest red flags, then fastest 12-month headcount growth; companies with thin data come last. Growth is headcount growth. Open a memo for the source and date of every number.`, "",
  ];
  out.push("| Company | What it does | Headcount | 6 mo | 12 mo | Monthly visitors (3-month change) | Raised | Last round | Staff left 12 mo (% of team; leaders and directors) | Red flags |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |");
  for (const r of screeningOrder(rows)) {
    const v = values(r);
    if (!r.memo) { out.push(`| ${md(r.name ? `${r.name} (${r.asked})` : r.asked)} | ${md(r.error ?? "not researched")} | | | | | | | | |`); continue; }
    const name = r.memoPath ? `[${md(v.company)}](${encodeURI(r.memoPath)})` : md(v.company);
    const pct = (x: unknown) => (typeof x === "number" ? fmtPct(x) : "n/a");
    const thin = r.memo.coverage.available < r.memo.coverage.of / 2;
    const flagCell = v.red_flags ? `${v.red_flags}: ${md(clip(String(v.top_red_flag ?? ""), 90))}` : thin ? `not enough data (${v.data_coverage} sections)` : "none";
    const left = r.memo.team.departures && !r.memo.team.departures.searched ? "not available (search failed)" : typeof v.staff_left_12m === "number" ? `${r.memo.team.departures?.staff_estimated ? "about " : ""}${fmtInt(v.staff_left_12m)} (${typeof v.staff_left_pct === "number" ? `${fmtPct(v.staff_left_pct, false)}; ` : ""}${v.leader_departures ?? 0})` : "n/a";
    out.push(`| ${name} | ${md(String(v.what_it_does ?? clip(String(v.categories ?? ""), 40))) || "n/a"} | ${typeof v.headcount === "number" ? fmtInt(v.headcount) : "n/a"} | ${pct(v.growth_6m_pct)} | ${pct(v.growth_12m_pct)} | ${typeof v.monthly_visitors === "number" ? `${fmtInt(v.monthly_visitors)}${typeof v.visitors_3m_change_pct === "number" ? ` (${fmtPct(v.visitors_3m_change_pct)})` : ""}` : "n/a"} | ${typeof v.total_raised_usd === "number" ? fmtUsd(v.total_raised_usd) : "n/a"} | ${v.last_round ? `${md(String(v.last_round))}${v.last_round_date ? `, ${fmtMonth(String(v.last_round_date))}` : ""}` : "n/a"} | ${left} | ${flagCell} |`);
  }
  out.push("");
  return out.join("\n");
}
