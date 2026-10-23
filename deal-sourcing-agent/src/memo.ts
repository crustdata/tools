/**
 * One markdown memo per company, and the ranked index (pipeline.md). Rendered from saved data only, so
 * `npm run memo -- <domain>` costs nothing. Every number in a memo comes from a named Crustdata field; the footer says
 * which. Pure, no I/O.
 */

import { MIN_COVERAGE, monthYear, monthsSince, stageName } from "./score.js";
import { memoFile, type Gone } from "./pipeline.js";
import type { Deal, Founder } from "./types.js";

/** Text from the API goes into markdown escaped, so a description cannot inject links, HTML or tables. */
/** Control characters and terminal escape sequences are removed too, since `npm run memo` prints the memo. */
export const md = (s: string | undefined): string => (s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/[\\`*_[\]<>|#~]/g, c => `\\${c}`).replace(/\s+/g, " ").trim();
/** A link only for a real https URL; brackets, parentheses, angle brackets and spaces in it are percent-encoded so it cannot end the link early. */
const link = (text: string, url?: string) => {
  let ok = false;
  try { ok = !!url && new URL(url.trim()).protocol === "https:"; } catch { ok = false; }
  return ok ? `[${md(text)}](${new URL(url!.trim()).href.replace(/[()[\]<>\s\\]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))})` : md(text);
};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "..." : s);

export function money(n?: number): string {
  if (n === undefined) return "";
  if (n >= 1e9) return `$${Math.round(n / 1e8) / 10}B`;
  if (n >= 1e6) return `$${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}
const pct = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n)}%`;
const years = (r: { start?: string; end?: string }) => (r.start ? ` (${r.start.slice(0, 4)} to ${r.end ? r.end.slice(0, 4) : "now"})` : "");

export const AI_HINT = "Add an AI key (ANTHROPIC_API_KEY or OPENAI_API_KEY in .env) and run with --ai for a fuller analysis written from these facts.";

/**
 * One question, picked by rule from what the data shows or lacks. The first rule that applies wins. Plain text with
 * names from the API in it: renderMemo escapes it.
 */
export function pickQuestion(d: Deal, retrieved?: string): string {
  const c = d.company, t = d.score.timing.label;
  const raiseQuote = d.posts.quotes.find(q => q.kind === "raise");
  const traction = d.posts.quotes.find(q => q.kind === "traction");
  const prior = d.founders.find(f => f.priorFounder.length);
  const sideJob = d.founders.find(f => f.alsoNow.length);
  if (t === "May have just raised")
    return raiseQuote ? `${raiseQuote.author} posted about a round on ${raiseQuote.date}. Who led it, how much was it, and is there room left in it?`
      : "A founder's post may mention a round that is not in the funding data yet. Read the post before asking about it: who led it, and is there room left in it?";
  if (sideJob) return `${sideJob.name} also holds a current role as ${sideJob.alsoNow[0].title} at ${sideJob.alsoNow[0].company}. Is ${sideJob.name.split(" ")[0]} full time on ${c.name}?`;
  if (t.endsWith("but quiet"))
    return `${teamWords(c)}, ${monthsAfter(c, retrieved)} the ${stageName(c.lastRound) || "last"} round in ${monthYear(c.lastRoundDate)}. What changed, and how long is the runway?`;
  if (!c.lastRoundDate) return "No round is on record. Who has backed you so far, if anyone, and what would a first round pay for?";
  if ((d.jobs.last90 ?? 0) >= 5) return `The team posted ${d.jobs.last90} roles in the last 90 days. What milestone is the hiring for?`;
  if (traction) return `${traction.author} posted about ${traction.phrase} on ${traction.date}. Where are revenue and growth today, month over month?`;
  if (prior) return `${prior.name} was ${prior.priorFounder[0].title} at ${prior.priorFounder[0].company} before. What happened there, and what is different this time?`;
  return "What has to be true in the next 12 months for this to work, and what will it cost to get there?";
}

/** "The team went from 11 to 8 people in the last 6 months" (or the percent when the start is unknown). */
function teamWords(c: Deal["company"]): string {
  const g = c.growth6m;
  if (typeof g !== "number") return "No team growth is on record";
  if (c.headcount !== undefined && c.added6m !== undefined && c.headcount - c.added6m > 0)
    return `The team went from ${c.headcount - c.added6m} to ${c.headcount} people in the last 6 months`;
  return g < -0.5 ? `The team shrank ${Math.round(-g)}% in the last 6 months` : g > 0.5 ? `The team grew ${Math.round(g)}% in 6 months, but little else moved` : "The team has not grown in the last 6 months";
}
/** Months from the round to the day the data was retrieved, counted the same way as the Timing section. */
const monthsAfter = (c: Deal["company"], retrieved?: string) =>
  c.lastRoundDate ? `${monthsSince(c.lastRoundDate, retrieved ? new Date(retrieved + "T12:00:00Z") : new Date())} months after` : "after";

/** Model output goes into the memo without raw HTML or links other than https, whatever the model wrote. */
export const cleanAnalysis = (text: string): string => text
  .replace(/<[^>]*>/g, "")
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
  .replace(/^\s*\[[^\]]+\]:\s*(?!https:\/\/)\S.*$/gim, "")
  .replace(/\[([^\]]*)\]\((?!https:\/\/)(?:[^()]|\([^()]*\))*\)/gi, "$1")
  // Whatever is left of a link to anything but https (nested brackets in its text) is broken up: "] (" is not a link.
  .replace(/\]\((?!https:\/\/)/gi, "] (")
  .trim();

function founderBlock(f: Founder): string {
  const lines = [`### ${md(f.name)}, ${md(f.title)}${f.since ? ` (since ${monthYear(f.since)})` : ""}`, ""];
  const meta = [f.profileUrl ? link("Profile", f.profileUrl) : "", md(f.location)].filter(Boolean).join(" · ");
  if (meta) lines.push(meta, "");
  if (f.headline) lines.push(`> ${md(clip(f.headline, 200))}`, "");
  if (f.priorFounder.length) lines.push(`- **Founded or ran a company before:** ${f.priorFounder.slice(0, 3).map(r => `${md(r.title)} at ${md(r.company)}${years(r)}`).join("; ")}`);
  if (f.fromList.length) lines.push(`- **From your list:** ${f.fromList.map(h => `${md(h.role.company || h.entry)} (${md(h.role.title)}${h.role.start ? `, ${years(h.role).slice(2, -1)}` : ""})`).join("; ")}`);
  if (f.alsoNow.length) lines.push(`- **Also holds now:** ${f.alsoNow.slice(0, 3).map(r => `${md(r.title)} at ${md(r.company)}${r.start ? ` (since ${monthYear(r.start)})` : ""}`).join("; ")}`);
  const isPrior = (r: Founder["past"][number]) => f.priorFounder.some(p => p.title === r.title && p.company === r.company && p.start === r.start);
  const past = f.past.filter(r => !isPrior(r)).slice(0, 4);
  if (past.length) lines.push(`- **Past roles:** ${past.map(r => `${md(r.title)} at ${md(r.company)}${years(r)}`).join("; ")}`);
  if (f.schools.length) lines.push(`- **Schools:** ${f.schools.slice(0, 3).map(s => `${md(s.school)}${s.degree || s.field ? ` (${md([s.degree, s.field].filter(Boolean).join(", "))}${s.endYear ? `, ${s.endYear}` : ""})` : s.endYear ? ` (${s.endYear})` : ""}`).join("; ")}`);
  if (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

export function renderMemo(d: Deal, retrieved: string, opts: { aiHint?: boolean } = {}): string {
  const c = d.company, s = d.score;
  const out: string[] = [];
  out.push(`# ${md(c.name)}`, "");
  const status = d.status === "new" ? "New in this run" : d.status === "back" ? `Back in the pipeline (first seen ${d.firstSeen})` : `In the pipeline since ${d.firstSeen}`;
  out.push([c.domain && link(c.domain, c.website ?? `https://${c.domain}`), c.profileUrl && link("Company profile", c.profileUrl), `Score **${s.total} / 100**`, `**${s.timing.label}**`, status].filter(Boolean).join(" · "), "");

  if (d.change) out.push(`**Since the last run:** ${md(d.change)}`, "");
  out.push("## What it does", "", c.description ? md(clip(c.description, 700)) : "No description on record.", "");

  const team = c.headcount !== undefined
    ? [`${c.headcount} people`, typeof c.growth6m === "number" ? `${pct(c.growth6m)} in 6 months` : "", typeof c.growth3m === "number" ? `${pct(c.growth3m)} in 3 months` : ""].filter(Boolean).join(", ")
    : "Not on record";
  const roles = d.jobs.last90 === null ? "Not counted" : `${d.jobs.last90} in the last 90 days${d.jobs.last30 !== null ? `, ${d.jobs.last30} in the last 30` : ""}`;
  const followers = c.followers !== undefined ? `${c.followers.toLocaleString("en-US")}${typeof c.followers6m === "number" ? `, ${pct(c.followers6m)} in 6 months` : ""}` : "Not on record";
  const round = c.lastRoundDate ? [md(stageName(c.lastRound)) || "Round", monthYear(c.lastRoundDate), money(c.lastRoundUsd)].filter(Boolean).join(", ") : "None on record";
  out.push("## Snapshot", "",
    `- **Founded:** ${c.founded ?? "Not on record"}`,
    `- **HQ:** ${md(c.hq) || "Not on record"}`,
    `- **Team:** ${team}`,
    `- **Roles posted:** ${roles}`,
    `- **Followers:** ${followers}`,
    `- **Last round:** ${round}`,
    `- **Total raised:** ${money(c.totalUsd) || "None on record"}`,
    `- **Investors:** ${c.investors.length ? c.investors.map(md).join(", ") : "None on record"}`, "");

  out.push("## Timing", "", `**${md(s.timing.label)}.** ${md(s.timing.explain)}`, "");

  out.push("## Hiring", "");
  if (d.jobs.newest.length) out.push(...d.jobs.newest.map(j => `- ${link(j.title, j.url)}${j.date ? ` (posted ${md(j.date.slice(0, 10))})` : ""}`), "");
  else if (d.jobs.last90) out.push(`${d.jobs.last90} roles posted in the last 90 days. Their titles were fetched for the top companies only (--jobs sets how many).`, "");
  else out.push(d.jobs.last90 === 0 ? "No roles posted in the last 90 days." : "Roles were not counted for this company.", "");

  out.push("## Founders", "");
  out.push(d.founders.length ? d.founders.map(founderBlock).join("\n\n") : "No founder, CEO or CTO profile was found at this company.", "");

  out.push("## Founders' posts", "");
  if (d.posts.quotes.length) {
    for (const q of d.posts.quotes) out.push(`> ${md(q.text)}`, `>`, `> ${md(q.author)}, ${md(q.date)}${q.url ? ` · ${link("post", q.url)}` : ""} (matched "${md(q.phrase)}")`, "");
  } else if (d.posts.traction === null) out.push(`Not checked: ${d.posts.skipped ?? "posts were not checked"}.`, "");
  else if ((d.posts.traction ?? 0) + (d.posts.raise ?? 0) > 0) out.push(`${(d.posts.traction ?? 0) + (d.posts.raise ?? 0)} founder posts in the last 6 months mention traction or a round. They were quoted for the top companies only (--quotes sets how many).`, "");
  else out.push("No founder post in the last 6 months mentions revenue, customers, growth or a round.", "");

  out.push(`## Score: ${s.total} / 100`, "", "| Signal | Points | Why |", "|---|---|---|",
    ...s.signals.map(x => `| ${x.label} | ${x.points} / ${x.max} | ${md(x.reason)} |`), "");
  if (s.scoredOn !== undefined && s.applies !== undefined && s.scoredOn < s.applies)
    out.push(`Scored on ${s.scoredOn} of the ${s.applies} points that apply to this thesis. ${s.scoredOn < Math.round(s.applies * MIN_COVERAGE) ? `Data is missing for more than a fifth of them, so the score is out of ${Math.round(s.applies * MIN_COVERAGE)}: missing points beyond a fifth count as zero.` : "The signals without data are left out of the total."}`, "");
  if (s.notScored.length) out.push("Not scored:", "", ...s.notScored.map(n => `- ${md(n)}`), "");

  out.push("## Question to ask", "", md(pickQuestion(d, retrieved)), "");
  if (d.analysis) out.push(`## Analysis`, "", `*Written by ${md(d.analysis.model)} from the facts above only. Check every claim against them.*`, "", cleanAnalysis(d.analysis.text), "");
  else if (opts.aiHint !== false) out.push(`*${AI_HINT}*`, "");

  out.push("---", "",
    `Data from [Crustdata](https://crustdata.com), retrieved ${retrieved}. Team: \`headcount.total\`, \`headcount.growth_percent\`. ` +
    "Roles posted: `/job/search` counts by `metadata.date_added`. Followers: `followers.count`, `followers.six_months_growth_percent`. " +
    "Funding: `funding.last_round_type`, `last_fundraise_date`, `last_round_amount_usd`, `total_investment_usd`, `investors` (disclosed funding only). " +
    "Founders: person search on the current role at this company. Posts: founders' posts in the last 6 months.", "");
  return out.join("\n");
}

/** The ranked index, with links to every memo and the companies that left the pipeline since the last run. */
export function renderIndex(deals: Deal[], gone: Gone[], thesis: string, retrieved: string, samePipeline: boolean): string {
  const out = [`# Pipeline: ${md(thesis)}`, "", `${deals.length} companies, retrieved ${retrieved}. Scores are 0 to 100; open a memo for the reasons.`, ""];
  const count = (s: Deal["status"]) => deals.filter(d => d.status === s).length;
  if (samePipeline) out.push(`Since the last run: ${count("new")} new, ${count("still here")} still here, ${count("back")} back, ${gone.length} gone.`, "");
  out.push("| # | Company | Score | Timing | Stage | Team | Roles 90d | Status |", "|---|---|---|---|---|---|---|---|");
  deals.forEach((d, i) => out.push(`| ${i + 1} | [${md(d.company.name)}](memos/${memoFile(d)}) | ${d.score.total} | ${md(d.score.timing.label)} | ${md(stageName(d.company.lastRound)) || "No round"} | ${d.company.headcount ?? ""}${typeof d.company.growth6m === "number" ? ` (${pct(d.company.growth6m)})` : ""} | ${d.jobs.last90 ?? ""} | ${d.status} |`));
  out.push("");
  const changed = deals.filter(d => d.change);
  if (changed.length) out.push("## What changed since the last run", "", ...changed.map(d => `- ${md(d.company.name)}: ${md(d.change)}`), "");
  if (gone.length) {
    out.push("## Gone since the last run", "", "In the last run, not in this one: they stopped matching a filter, ranked below the limit, were excluded, or the ranked search returned a slightly different set this time. Their memos, if any, moved to memos/gone/.", "",
      ...gone.map(g => `- ${md(g.name || String(g.id))}${g.domain ? ` (${md(g.domain)})` : ""}, in the pipeline ${g.firstSeen} to ${g.lastSeen}`), "");
  }
  return out.join("\n");
}
