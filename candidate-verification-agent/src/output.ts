/**
 * What the recruiter gets back: verified.csv (their own file, new columns added, doubtful first), report.md and
 * unresolved.csv. Pure text builders plus one writer.
 */

import type { Candidate } from "./input.js";
import { SECTIONS, VERDICTS, sectionOf, verdictCode, flagTexts, labelFor, reasonsText, reviewOrder, sourcesText, summaryLine, verdictLabel, type Result, type Verdict } from "./verdict.js";

/**
 * One cell. Values starting with = + - @ get a leading apostrophe, so a name or headline can never run as a
 * spreadsheet formula. Numbers, phone numbers and a lone "-" are written as they are (they cannot run).
 */
export function csvCell(v: unknown, sep = ","): string {
  if (v === undefined || v === null) return "";
  let s = String(v);
  // = and @ always start a formula; + and - unless the whole cell is a plain number or phone number ("-5",
  // "+44 20 7946 0000"), so "-2+3+cmd|..." is still made safe.
  if (typeof v !== "number" && (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?[\d\s().-]*\d[\d\s().-]*$/.test(s) && s !== "-"))) s = `'${s}`;
  return s.includes(sep) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A CSV file's text, with the same separator as the file it came from (Excel in many European locales uses ";").
 * It starts with a byte order mark so Excel shows names like 王小明 correctly.
 */
export const csvText = (header: string[], rows: unknown[][], sep = ","): string =>
  "\uFEFF" + [header, ...rows].map(r => r.map(c => csvCell(c, sep)).join(sep)).join("\r\n") + "\r\n";

/** The columns added to the recruiter's file, in order. */
export const ADDED_COLUMNS = [
  "review_rank", "review_group", "verdict", "verdict_label", "confidence", "trust_tier", "summary", "reasons", "flags",
  "sources", "check_type", "checked_name", "checked_title", "checked_company", "profile_url_checked", "checked_at",
];

/** One row of the output. `duplicateOf` is the line of the row this one repeats (same verdict, checked once). */
export type Row = { candidate: Candidate; result: Result; duplicateOf?: number };

/** Header names already in the file get a "cv_" prefix for ours, so nothing of theirs is overwritten. */
export function addedHeader(original: string[]): string[] {
  const taken = new Set(original.map(h => h.trim().toLowerCase()));
  return ADDED_COLUMNS.map(c => (taken.has(c) ? `cv_${c}` : c));
}

export function resultCells(r: Result, summary: string, rank: number): unknown[] {
  return [
    rank, sectionOf(reviewOrder(r)).title, verdictCode(r), verdictLabel(r),
    r.confidence !== undefined ? Math.round(r.confidence * 100) / 100 : "", r.tier ?? "",
    summary, reasonsText(r), flagTexts(r).join("; "), sourcesText(r),
    r.check, r.person?.name, r.person?.title, r.person?.company, r.profileUrl, r.checkedAt.slice(0, 10),
  ];
}

/** verified.csv: every original column as it was, then ours. Rows in review order. */
export function verifiedCsv(headers: string[], rows: Row[], sep = ","): string {
  const width = Math.max(headers.length, ...rows.map(r => r.candidate.cells.length));
  const head = [...headers, ...Array.from({ length: width - headers.length }, (_, i) => `column_${headers.length + i + 1}`)];
  return csvText([...head, ...addedHeader(head)], rows.map(({ candidate, result }, i) => {
    const own = [...candidate.cells, ...Array(width - candidate.cells.length).fill("")];
    return [...own, ...resultCells(result, result.aiSummary || summaryLine(result), i + 1)];
  }), sep);
}

/** unresolved.csv: rows that were not checked, with the reason, in file order. */
export function unresolvedCsv(headers: string[], items: Array<{ candidate: Candidate; reason: string }>, sep = ","): string {
  return csvText(["line", "reason", ...headers], items.map(({ candidate, reason }) => [candidate.line, reason, ...candidate.cells]), sep);
}

const md = (s: string | undefined) => (s ?? "").replace(/([\\`*_[\]<>|#])/g, "\\$1").replace(/\s+/g, " ").trim();
/** The applicant's name from your file first: the profile may belong to someone else (see nameMismatch). */
const who = (row: Row) => md(row.candidate.name || row.result.person?.name || (row.result.profileUrl.replace(/^https:\/\/www\./, "") || `Line ${row.candidate.line}`));
const role = (r: Result) => md([r.person?.title, r.person?.company && `at ${r.person.company}`].filter(Boolean).join(" "));

export type ReportMeta = {
  listName: string;
  date: string;
  creditsSpent: number;
  reused: number;
  unresolved: number;
  duplicates: number;
  quick: boolean;
  aiReport?: string;
};

/** The score line: Crustdata's confidence is a fixed band per verdict, so it is shown as a plain score. */
const scoreText = (r: Result) => (r.confidence !== undefined ? `, Crustdata score ${r.confidence.toFixed(2)} (each verdict has its own fixed range; compare only with the same verdict)` : r.tier !== undefined ? `, trust tier ${r.tier} of 9 (0 is most trusted)` : "");

/** Counts per verdict, most doubtful first. */
export function verdictCounts(rows: Row[]): Array<{ verdict: Verdict; count: number }> {
  return (Object.keys(VERDICTS) as Verdict[])
    .map(verdict => ({ verdict, count: rows.filter(r => r.result.verdict === verdict).length }))
    .filter(c => c.count);
}

/** Counts per label: a quick-screen score and a full-check verdict are counted apart, each under its own words. */
export function labelCounts(rows: Row[]): Array<{ label: string; count: number }> {
  const out: Array<{ label: string; count: number }> = [];
  for (const v of Object.keys(VERDICTS) as Verdict[]) for (const quick of [false, true]) {
    const n = rows.filter(r => r.result.verdict === v && (r.result.check === "quick") === quick && !r.result.rawVerdict).length;
    if (n) out.push({ label: labelFor(v, quick), count: n });
  }
  const unknown = rows.filter(r => r.result.rawVerdict).length;
  if (unknown) out.unshift({ label: "New verdicts this version does not know", count: unknown });
  return out;
}

/** report.md: counts, then every candidate in review order with the reason and the sources. */
export function reportMarkdown(rows: Row[], meta: ReportMeta): string {
  const lines: string[] = [`# Candidate verification: ${md(meta.listName)}`, ""];
  const people = rows.filter(r => !r.duplicateOf);
  const withVerdict = people.filter(r => r.result.check !== "none").length;
  lines.push(`${people.length} candidate${people.length === 1 ? "" : "s"}: ${withVerdict} with a verdict, ${people.length - withVerdict} not checked. Checked on ${meta.date}; ${meta.creditsSpent} credits spent${meta.reused ? `; ${meta.reused} verdict${meta.reused === 1 ? "" : "s"} reused from earlier runs (see checked_at)` : ""}.`);
  const noVerdict = people.filter(r => r.result.check === "none" && r.result.profileUrl).length;
  if (meta.unresolved) lines.push(`${meta.unresolved} row${meta.unresolved === 1 ? "" : "s"} could not be checked (reasons in unresolved.csv)${noVerdict ? `; ${noVerdict} more got no verdict from Crustdata (not charged)` : ""}; all are listed under "Not checked".`);
  else if (noVerdict) lines.push(`${noVerdict} got no verdict from Crustdata (not charged), listed under "Not checked".`);
  if (meta.duplicates) lines.push(`${meta.duplicates} row${meta.duplicates === 1 ? " repeats" : "s repeat"} a candidate above; ${meta.duplicates === 1 ? "it gets" : "they get"} the same verdict (checked once, not charged twice).`);
  const quick = people.filter(r => r.result.check === "quick").length;
  const full = people.filter(r => r.result.check === "full").length;
  if (quick) {
    lines.push("", `**${!full ? "This list was" : `${quick} of these candidates were`} checked with the quick screen:** a score for the whole profile with no reasons or sources. It does not check the current role. Do not use it alone to doubt or clear anyone.`);
  }
  lines.push("", "A verdict is evidence for a person to review, not a hiring decision. A profile that holds up does not show that the applicant owns it: confirm identity separately for remote roles. Talk to the candidate before acting on anything here.", "");
  if (meta.aiReport) lines.push("## Overview", "", meta.aiReport.trim(), "");

  lines.push("| Verdict | Candidates |", "|---|---|");
  for (const c of labelCounts(people)) lines.push(`| ${c.label} | ${c.count} |`);
  lines.push("");
  const conflicts = people.filter(r => r.result.dateConflicts.length).length;
  const mismatches = people.filter(r => r.result.nameMismatch).length;
  if (conflicts) lines.push(`${conflicts} candidate${conflicts === 1 ? " has" : "s have"} dates that overlap study (moved up the list as a question, not a red flag).`);
  if (mismatches) lines.push(`${mismatches} candidate${mismatches === 1 ? "'s" : "s'"} profile name differs from the name in your file: check the profile URL first.`);
  if (conflicts || mismatches) lines.push("");

  for (const section of SECTIONS) {
    const group = rows.filter(r => { const o = reviewOrder(r.result); return o >= section.from && o <= section.to; });
    if (!group.length) continue;
    const repeats = group.filter(r => r.duplicateOf).length;
    lines.push(`## ${section.title} (${group.length - repeats}${repeats ? `, plus ${repeats} repeated row${repeats === 1 ? "" : "s"}` : ""})`, "", `_${section.about}._`, "");
    for (const row of group) {
      const r = row.result;
      lines.push(`### ${who(row)}`, "");
      lines.push(`- **${md(verdictLabel(r))}**${scoreText(r)} (${r.check === "full" ? "full check" : r.check === "quick" ? "quick screen" : "no verdict"})`);
      if (row.duplicateOf) { lines.push(`- Line ${row.candidate.line}: same person as line ${row.duplicateOf} (checked once, not charged twice)`, ""); continue; }
      if (r.nameMismatch) lines.push(`- **${md(r.nameMismatch)}**`);
      if (role(r)) lines.push(`- Current role on the profile${r.person?.name && r.person.name !== row.candidate.name ? ` of ${md(r.person.name)}` : ""}: ${role(r)}`);
      const where = [r.profileUrl && `Profile: ${r.profileUrl}`, row.candidate.job && `Applied for: ${md(row.candidate.job)}`, `Line ${row.candidate.line} of your file`].filter(Boolean);
      lines.push(`- ${where.join(" · ")}`);
      if (r.aiSummary) lines.push(`- Summary: ${md(r.aiSummary)}`);
      if (r.reasoning) lines.push(`- Why: ${md(r.reasoning)}`);
      else if (!r.aiSummary && r.check === "none") lines.push(`- ${md(r.note ?? "No verdict")}`);
      else if (!r.aiSummary && r.check === "full") lines.push(`- ${md(summaryLine(r))}`);
      const cv = r.coverage;
      if (cv?.social_ran) lines.push(`- Coworker check: ${cv.coworker_hits ?? 0} of ${cv.engagers_resolved ?? 0} identified people who engaged with ${cv.posts_checked ?? 0} recent post${cv.posts_checked === 1 ? "" : "s"} work at the claimed employer${cv.coworker_hits ? "" : " (this alone is not a warning sign)"}`);
      for (const c of r.dateConflicts) lines.push(`- Dates: ${md(c)} (a question for the screen: part-time study is often not labelled)`);
      for (const f of flagTexts(r)) lines.push(`- Note: ${md(f)}`);
      if (r.citations.length) {
        lines.push("- Sources:");
        for (const c of r.citations.slice(0, 8)) lines.push(`  - [${md(c.title || c.url)}](${String(c.url).replace(/[()\s]/g, encodeURIComponent)})`);
      }
      lines.push("");
    }
  }
  lines.push("---", "", "Made with [Candidate Verification Agent](https://github.com/crustdata/tools/tree/main/candidate-verification-agent). Data from [Crustdata](https://crustdata.com).", "");
  return lines.join("\n");
}
