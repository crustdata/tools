/**
 * What a run writes to out/<run>/:
 *
 *   report.md      every job, best first: fit and why, company trend, people with profile URLs and draft notes
 *   jobs.json      the same data for the dashboard, scripts and the Claude Code skills
 *   jobs.csv       one row per job for a spreadsheet
 *   jobs/<n>.md    one file per job (the Claude Code skill writes its own notes next to these, in ai/)
 *
 * Pure functions return the text; `writeRun` writes the files.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fundingLine, trendLine } from "./company.js";
import { fmtCredits } from "./crustdata.js";
import { MIN_SCORE_FOR_PEOPLE, type JobResult, type Run } from "./hunt.js";
import { KIND_LABEL, type Kind } from "./people.js";

/** Text from the API inside markdown: one line, no table breaks, no link or HTML syntax. */
export const md = (s: string | null | undefined): string =>
  String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").replace(/([\\`*_[\]<>|#])/g, "\\$1")
    // A bare address in a name or title would turn into a link in most markdown viewers.
    .replace(/:\/\//g, ":\\/\\/").replace(/\bwww\./gi, m => `${m.slice(0, 3)}\\.`).trim();

/** Only http(s) links are written, so a stored value can never become a javascript: link. */
export const safeUrl = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.toString().replace(/\)/g, "%29").replace(/ /g, "%20") : null; } catch { return null; }
};

const link = (text: string, url: string | null | undefined) => {
  const u = safeUrl(url);
  return u ? `[${md(text)}](${u})` : md(text);
};

export function postedLine(r: JobResult): string {
  if (r.daysAgo === null) return "posting date not known";
  return r.daysAgo === 0 ? "posted today" : r.daysAgo === 1 ? "posted yesterday" : `posted ${r.daysAgo} days ago`;
}

export function openLine(r: JobResult): string {
  if (r.open === "open") return "open on the job board today";
  if (r.open === "closed") return "closed on the job board";
  return "not checked (this job site has no free way to check)";
}

/** A weak fit whose people were not looked up (to save credits). */
export const skippedWeak = (r: JobResult): boolean => !r.people.length && r.fit.score < MIN_SCORE_FOR_PEOPLE && r.job.company.id !== null;

const ORDER: Kind[] = ["recruiter", "manager", "team", "alumni"];

export function jobSection(r: JobResult, n: number, run: Pick<Run, "me">): string {
  const j = r.job;
  const out: string[] = [];
  out.push(`## ${n}. ${md(j.title)} at ${md(j.company.name)}`, "");
  out.push(`**${r.fit.score}/100, ${r.fit.label}**${r.isNew ? "" : " (seen in an earlier run)"}`, "");
  const where = [j.location, j.workplace, j.employmentType?.replace(/_/g, " ")].filter(Boolean).map(x => md(x)).join(", ");
  out.push(`- Posting: ${link("open the posting", j.url)}, ${postedLine(r)}${where ? `, ${where}` : ""}. ${openLine(r)[0].toUpperCase()}${openLine(r).slice(1)}.${j.alsoListed ? ` Also listed ${j.alsoListed} more time${j.alsoListed === 1 ? "" : "s"} on other sites.` : ""}`);
  out.push(`- Company: ${link(j.company.name, j.company.domain ? `https://${j.company.domain}` : null)}. ${md(trendLine(r.momentum))}.${fundingLine(r.momentum) ? ` Last round: ${md(fundingLine(r.momentum))}.` : ""}`);
  out.push(`- Why this score: ${r.fit.reasons.map(md).join(" ")} Skills: ${r.fit.parts.skills}/50, title and level ${r.fit.parts.title}/20, place ${r.fit.parts.place}/10, company ${r.fit.parts.company}/10, freshness ${r.fit.parts.freshness}/10${r.fit.parts.penalties ? `, flags -${r.fit.parts.penalties}` : ""}.`);
  if (r.fit.matched.length) out.push(`- Skills you have that it asks for: ${r.fit.matched.map(md).join(", ")}.`);
  if (r.fit.missing.length) out.push(`- Asks for, not on your CV: ${r.fit.missing.map(s => (run.me.learning ?? []).includes(s) ? `${md(s)} (marked learning on your CV)` : md(s)).join(", ")}.`);
  if (r.fit.flags.length) out.push(`- Flags: ${r.fit.flags.map(md).join(" ")}`);
  out.push("", "### Who to talk to", "");
  if (r.people.length) out.push("Write to one person at a company first, and wait a week before writing to a second. Every note is a draft: read it and make it yours.", "");
  if (!r.people.length) out.push(j.company.id === null ? "No company record, so no people search." : skippedWeak(r) ? `A weak fit: people were not looked up, to save credits (add --all to include weak fits).` : "Nobody found at this company for these searches.");
  const firstKind = r.people.find(p => p.first)?.kind;
  for (const kind of firstKind ? [firstKind, ...ORDER.filter(k => k !== firstKind)] : ORDER) {
    const group = r.people.filter(p => p.kind === kind);
    if (!group.length) continue;
    out.push(`**${KIND_LABEL[kind]}**`, "");
    for (const p of group) {
      const extra = [
        p.school ? `${md(p.school)}${p.schoolYear ? ` ${p.schoolYear}` : ""}` : null,
        p.location ? md(p.location) : null,
        p.email ? `\`${p.email.replace(/[`\s]/g, "")}\`` : null,
      ].filter(Boolean).join(", ");
      out.push(`- ${p.first ? "**Write to first:** " : ""}${link(p.name, p.profileUrl)}, ${md(p.title)}${extra ? ` (${extra})` : ""}`);
      out.push(p.alsoFor ? `  Also listed for job ${p.alsoFor} at this company: write once, about both roles.` : `  > ${md(p.note)}`);
    }
    out.push("");
  }
  if (run.me.schools.length && !r.people.some(p => p.kind === "alumni") && j.company.id !== null && !skippedWeak(r)) out.push(`No alumni from ${run.me.schools.map(md).join(" or ")} found there.`, "");
  return out.join("\n").trimEnd();
}

export function reportMd(run: Run): string {
  const s = run.search;
  const date = new Date(run.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const where = s.remote === "only" ? `remote in ${s.country}` : `within ${s.radiusMiles} miles of ${s.location}${s.remote === "also" ? ", plus remote" : ""}`;
  const out: string[] = [];
  out.push(run.kind === "job" && run.jobs[0]
    ? `# ${md(run.jobs[0].job.title)} at ${md(run.jobs[0].job.company.name)} (${date})`
    : `# Job hunt: ${md(s.titles.join(" or "))}, ${md(where)} (${date})`, "");
  if (run.kind === "hunt") {
    const skipped = Object.entries(run.counts.skipped).map(([k, v]) => `${v} ${k}`).join(", ");
    out.push(`${run.counts.matching.toLocaleString("en-US")} jobs posted in the last ${s.days} days match. The newest ${run.counts.scanned} were read (${run.counts.unique} after folding duplicates${skipped ? `; left out: ${skipped}` : ""}), scored against your CV, and the best ${run.jobs.length} kept (people looked up for those that fit).${run.counts.closed ? ` ${run.counts.closed} closed on their job board and dropped.` : ""} Credits used: ${fmtCredits(run.credits)}.`, "");
  } else {
    out.push(`Credits used: ${fmtCredits(run.credits)}.`, "");
  }
  const yearsText = run.me.years === null ? "years not known" : `${run.me.years} years of experience (${run.me.yearsFrom === "you" ? "profile.json or --years" : "from your CV"})`;
  out.push(`About you: ${yearsText}; ${run.me.skills.length} skills (${run.me.skills.slice(0, 12).map(md).join(", ")}${run.me.skills.length > 12 ? ", ..." : ""}); ${run.me.schools.length ? `school${run.me.schools.length > 1 ? "s" : ""}: ${run.me.schools.map(md).join("; ")}` : "no school found, so no alumni search"}.`, "");
  if (run.notes.length) out.push(...run.notes.map(n => `> ${md(n)}`), "");
  if (run.jobs.length > 1) {
    out.push("| # | Fit | Job | Company | Team | Posted | People |", "|---|---|---|---|---|---|---|");
    run.jobs.forEach((r, i) => {
      const trend = r.momentum.trend === "unknown" ? "" : `${r.momentum.trend}${r.momentum.growth6m !== null ? ` ${r.momentum.growth6m > 0 ? "+" : ""}${Math.round(r.momentum.growth6m)}%` : ""}`;
      out.push(`| ${i + 1} | ${r.fit.score} | ${link(r.job.title, r.job.url)}${r.isNew ? "" : " (seen)"} | ${md(r.job.company.name)} | ${trend} | ${r.daysAgo === null ? "" : `${r.daysAgo}d`} | ${r.people.length} |`);
    });
    out.push("");
  }
  run.jobs.forEach((r, i) => out.push(jobSection(r, i + 1, run), ""));
  if (run.closed.length) {
    out.push("## Closed on their job board", "");
    for (const c of run.closed) out.push(`- ${link(c.title, c.url)} at ${md(c.company)}`);
    out.push("");
  }
  out.push("---", "", "Drafts only: nothing was sent or applied for. Read each note, edit it, and send it yourself. Data from [Crustdata](https://crustdata.com) (job postings, company headcount and funding, people search).");
  return `${out.join("\n").trimEnd()}\n`;
}

/** A cell that a spreadsheet will not run as a formula. */
export const csvCell = (v: unknown): string => {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
};

export function jobsCsv(run: Run): string {
  const head = ["rank", "score", "fit", "title", "company", "website", "posting_url", "posted_days_ago", "open", "team_trend", "headcount_growth_6m_pct", "last_round", "last_round_date", "write_to_first", "write_to_first_url", "recruiters", "recruiter_email", "hiring_manager", "hiring_manager_url", "team", "alumni", "skills_matched", "skills_missing", "flags", "job_id"];
  const rows = run.jobs.map((r, i) => {
    const of = (k: Kind) => r.people.filter(p => p.kind === k);
    const names = (k: Kind) => of(k).map(p => `${p.name} (${p.profileUrl ?? ""})`).join("; ");
    return [
      i + 1, r.fit.score, r.fit.label, r.job.title, r.job.company.name, r.job.company.domain, r.job.url, r.daysAgo, r.open,
      r.momentum.trend, r.momentum.growth6m === null ? "" : Math.round(r.momentum.growth6m), r.momentum.lastRound, r.momentum.lastRoundDate?.slice(0, 10),
      r.people.find(p => p.first)?.name, r.people.find(p => p.first)?.profileUrl,
      names("recruiter"), of("recruiter").map(p => p.email).filter(Boolean).join("; "), of("manager")[0]?.name, of("manager")[0]?.profileUrl,
      names("team"), names("alumni"), r.fit.matched.join("; "), r.fit.missing.join("; "), r.fit.flags.join(" "), r.job.id,
    ].map(csvCell).join(",");
  });
  return `${[head.join(","), ...rows].join("\n")}\n`;
}

/** File name for one job: "01-northwind-robotics-senior-software-engineer.md". */
export function jobFile(r: JobResult, i: number): string {
  const s = `${r.job.company.name} ${r.job.title}`.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${String(i + 1).padStart(2, "0")}-${s || "job"}.md`;
}

export function writeRun(run: Run, outDir: string): string {
  // Another run (a second terminal, a scheduled run) may have taken this folder in the same second.
  for (let k = 2; existsSync(join(outDir, run.id)); k++) run.id = `${run.id.replace(/-r\d+$/, "")}-r${k}`;
  const dir = join(outDir, run.id);
  mkdirSync(join(dir, "jobs"), { recursive: true });
  writeFileSync(join(dir, "report.md"), reportMd(run));
  writeFileSync(join(dir, "jobs.json"), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(dir, "jobs.csv"), jobsCsv(run));
  // The posting is someone else's text: kept as plain text in a fence, so it can never render as HTML or links.
  run.jobs.forEach((r, i) => writeFileSync(join(dir, "jobs", jobFile(r, i)), `${jobSection(r, i + 1, run)}\n\n## Posting (text from the job board)\n\n\`\`\`text\n${(r.job.description || "No posting text.").replace(/`{3,}/g, "``")}\n\`\`\`\n`));
  return dir;
}

/** The short summary printed in the terminal at the end of a run. */
export function summary(run: Run, dir: string | null): string {
  const lines: string[] = [""];
  run.jobs.forEach((r, i) => {
    const who = (["recruiter", "manager", "team", "alumni"] as Kind[]).map(k => [k, r.people.filter(p => p.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => `${n} ${k === "manager" ? "manager" : k}`).join(", ");
    lines.push(`${String(i + 1).padStart(2)}. ${String(r.fit.score).padStart(3)}  ${r.job.title} at ${r.job.company.name}${r.momentum.trend !== "unknown" ? ` (${r.momentum.trend})` : ""}${who ? `  people: ${who}` : skippedWeak(r) ? "  weak fit, people not looked up" : "  no people found"}${r.fit.flags.length ? "  !" : ""}`);
  });
  for (const n of run.notes) lines.push("", `Note: ${n}`);
  lines.push("", `Credits used: ${fmtCredits(run.credits)}${Math.abs(run.listCredits - run.credits) > 0.05 ? ` (${fmtCredits(run.listCredits)} at list price)` : ""}.`);
  if (dir && process.env.JHA_REPLAY === "1") lines.push("This was a replay: the report is printed below and is not kept (add --keep to keep it). The dashboard shows your own runs from npm run hunt.");
  else if (dir) lines.push(`Report: ${join(dir, "report.md")}`, "See it in the dashboard: npm run dashboard");
  lines.push("Nothing was sent. Read each draft note, edit it, and send it yourself.");
  return lines.join("\n");
}
