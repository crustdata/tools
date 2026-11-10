/**
 * The files a run writes: researchers.csv (everyone, every column) and report.md (the team map, then the top people
 * with their evidence trail). Building the text is pure, so it is tested; writing is in find.ts.
 */

import type { Person } from "./crustdata.js";
import { citations, clip, hIndex, interestsOf, locationOf, nameOf, pastRoles, profileUrlOf, recentPapers, researchOf, roleAt, scholarUrl, span, yearsWorked } from "./profile.js";
import { isFrontierRole, type Found, type Scored } from "./rubric.js";
import type { TeamGuess } from "./teams.js";

/** `lab` is the searched lab the person is at, or NOT_AT_LAB; `employer` is their main current employer. */
export type Row = { found: Found; team: TeamGuess; scored: Scored; lab: string; employer: string };

/** People who are not at any of the searched labs (found from their work, or who left) are grouped under this. */
export const NOT_AT_LAB = "Not at a searched lab";

/** Escape text for a markdown table cell or line: names and titles come from the web. */
export const md = (s: string): string => String(s).replace(/\\/g, "\\\\").replace(/([|*_`[\]<>#])/g, "\\$1").replace(/\s+/g, " ").trim()
  // A text starting with "1. " or "- " would render as a list.
  .replace(/^(\d+)([.)])(\s)/, "$1\\$2$3").replace(/^([-+])(\s)/, "\\$1$2");

/** A markdown link only to an https URL, with the characters that could end the link encoded. */
export const mdLink = (text: string, url: string): string => {
  if (!/^https:\/\/[^\s]+$/i.test(url)) return "";
  const enc: Record<string, string> = { "(": "%28", ")": "%29", "<": "%3C", ">": "%3E" };
  return `[${md(text)}](${url.replace(/[()<>]/g, ch => enc[ch])})`;
};

const teamText = (t: TeamGuess) => (t.team ? `${t.team} (${t.label})${t.also.length ? `, also ${t.also.join(", ")}` : ""}` : "not stated");

/**
 * Where a person sits in the team map: the searched lab their current role is at (shown by its display name), or
 * NOT_AT_LAB. With no labs searched (seeds only), their main current employer.
 */
export function labOf(p: Person, labNames: Map<number, string>): { lab: string; employer: string } {
  const ids = new Set(labNames.keys());
  const role = roleAt(p, ids);
  const employer = role?.name?.trim() || "No current employer listed";
  if (!ids.size) return { lab: employer, employer };
  const id = role?.crustdata_company_id;
  return { lab: id && ids.has(id) ? labNames.get(id)! : NOT_AT_LAB, employer };
}

/** Best score first; on a tie, the one scored on more of the rubric. */
export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => b.scored.score - a.scored.score || b.scored.coverage - a.scored.coverage || b.scored.earned - a.scored.earned || nameOf(a.found.person).localeCompare(nameOf(b.found.person)));
}

export const CSV_HEADER = [
  "rank", "score", "coverage", "checked_score", "points", "name", "lab", "current_company", "team", "team_label", "team_also", "team_evidence",
  "current_title", "location", "years_worked", "past_frontier_labs", "h_index", "citations", "papers_last_3_years", "recent_papers",
  "research_interests", "found_by", "found_at", "scholar_refreshed", "points_earned", "no_data_for", "profile_url", "scholar_url",
  "crustdata_person_id",
];

export function csvRows(rows: Row[], labIds: Set<number>, now = new Date()): unknown[][] {
  return sortRows(rows).map((r, i) => {
    const p = r.found.person;
    const recent = recentPapers(p, 3, now);
    const frontierPast = [...new Set(pastRoles(p).filter(isFrontierRole).map(x => x.name ?? ""))].filter(Boolean);
    return [
      // checked_score is left blank when under 40% of the rubric could be checked: too little to say.
      i + 1, r.scored.score, `${r.scored.coverage}%`, r.scored.coverage >= 40 ? r.scored.checkedScore : "", `${r.scored.earned} of ${r.scored.checked}`, nameOf(p), r.lab, r.employer,
      r.team.team ?? "", r.team.label, r.team.also.join("; "), r.team.evidence.join(" | "),
      roleAt(p, labIds)?.title ?? p.basic_profile?.current_title ?? "", locationOf(p), yearsWorked(p, now) ?? "", frontierPast.join("; "),
      hIndex(p) ?? "", citations(p) ?? "", recent.length || (scholarUrl(p) ? 0 : ""), recent.slice(0, 3).map(x => `${x.title}${x.year ? ` (${x.year})` : ""}`).join(" | "),
      interestsOf(p).join("; "), r.found.via.join("; "), (r.found.found_at ?? "").slice(0, 10), (researchOf(p)?.metadata?.last_scraped_source ?? "").slice(0, 10),
      // Short here; the evidence for every point is in report.md.
      r.scored.outcomes.filter(o => o.earned > 0).map(o => `${o.rule} ${o.earned} of ${o.points}`).join("; "),
      r.scored.outcomes.filter(o => o.noData).map(o => o.rule).join("; "),
      profileUrlOf(p), scholarUrl(p), p.crustdata_person_id,
    ];
  });
}

/** The team map: per lab, per team, who is there and how sure. People outside the searched labs come last. */
export function teamMap(rows: Row[]): string {
  const byLab = new Map<string, Row[]>();
  for (const r of rows) byLab.set(r.lab, [...(byLab.get(r.lab) ?? []), r]);
  const labs = [...byLab.entries()].sort((a, b) => Number(a[0] === NOT_AT_LAB) - Number(b[0] === NOT_AT_LAB) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const out: string[] = [];
  for (const [lab, list] of labs) {
    const outside = lab === NOT_AT_LAB;
    const who = (r: Row) => md(nameOf(r.found.person)) + (outside ? ` (${md(r.employer)})` : "");
    out.push(`### ${md(lab)} (${list.length} ${list.length === 1 ? "person" : "people"})`, "");
    const teams = new Map<string, Row[]>();
    for (const r of list) teams.set(r.team.team ?? "", [...(teams.get(r.team.team ?? "") ?? []), r]);
    const order = [...teams.entries()].filter(([t]) => t).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    if (order.length) {
      out.push("| Team | Stated | Inferred |", "|---|---|---|");
      for (const [team, people] of order) {
        const names = (label: string) => sortRows(people.filter(r => r.team.label === label)).map(who).join(", ") || " ";
        out.push(`| ${md(team)} | ${names("stated")} | ${names("inferred")} |`);
      }
    }
    const unknown = sortRows(teams.get("") ?? []);
    if (unknown.length) out.push(...(order.length ? [""] : []), `Team not stated: ${unknown.map(who).join(", ")}`);
    out.push("");
  }
  return out.join("\n");
}

const hasLetters = (s?: string | null) => !!s && /\p{L}/u.test(s);

/** One person's evidence trail. */
export function personBlock(r: Row, rank: number, labIds: Set<number>, now = new Date()): string {
  const p = r.found.person;
  const role = roleAt(p, labIds);
  const recent = recentPapers(p, 3, now);
  const research = [
    hIndex(p) !== undefined && `h-index ${hIndex(p)}`,
    citations(p) !== undefined && `${citations(p)!.toLocaleString("en-US")} citations`,
    scholarUrl(p) && `${recent.length} paper${recent.length === 1 ? "" : "s"} in the last 3 years`,
  ].filter(Boolean);
  const evidence = r.team.evidence.length ? `, from the ${md(r.team.evidence.join("; "))}` : "";
  const missing = r.scored.outcomes.filter(o => o.noData).length;
  const lines = [
    `### ${rank}. ${md(nameOf(p))}, score ${r.scored.score} (${r.scored.coverage}% of the rubric checked)`,
    "",
    md([role?.title ?? p.basic_profile?.current_title, role?.name && `at ${role.name}`, role && span(role) && `(${span(role)})`].filter(Boolean).join(" ") || "No current role listed") + (locationOf(p) ? `. ${md(locationOf(p))}` : ""),
    "",
    `- **Team:** ${md(teamText(r.team))}${evidence}`,
    `- **Found by:** ${md(r.found.via.join("; "))}`,
    research.length ? `- **Research:** ${research.join(", ")}` : "- **Research:** no Google Scholar profile on file",
    ...(recent.length ? [`- **Recent papers:** ${recent.slice(0, 3).map(x => `"${md(clip(x.title, 100))}"${x.year ? ` (${x.year})` : ""}`).join("; ")}`] : []),
    ...(hasLetters(p.basic_profile?.headline) ? [`- **Headline:** ${md(clip(p.basic_profile!.headline!, 160))}`] : []),
    `- **Points (${r.scored.earned} of ${r.scored.checked} checked${missing ? `; ${missing} rule${missing === 1 ? "" : "s"} with no data, counted at a part of their points` : ""}):**`,
    ...r.scored.outcomes.map(o => `  - ${o.noData ? `no data (of ${o.points})` : `${o.earned > 0 ? `+${o.earned}` : "0"} of ${o.points}`}, ${md(o.rule)}${o.evidence ? `: ${md(o.evidence)}` : ""}`),
    `- **Links:** ${[mdLink("profile", profileUrlOf(p)), mdLink("Google Scholar", scholarUrl(p))].filter(Boolean).join(" · ") || "none on file"}`,
    "",
  ];
  return lines.join("\n");
}

export type ReportMeta = { title: string; searched: string[]; date: string; credits?: string; notes: string[]; fetched?: string; rubricName?: string };

export function report(rows: Row[], meta: ReportMeta, top: number, labIds: Set<number>, now = new Date()): string {
  const sorted = sortRows(rows);
  const stated = rows.filter(r => r.team.label === "stated").length, inferred = rows.filter(r => r.team.label === "inferred").length;
  return [
    `# ${md(meta.title)}`,
    "",
    `${rows.length} people. Team stated for ${stated}, inferred for ${inferred}, not stated for ${rows.length - stated - inferred}. Written ${meta.date}${meta.fetched ? `; records fetched ${meta.fetched}` : ""}.${meta.credits ? ` ${meta.credits}` : ""}`,
    "",
    ...meta.searched.map(s => `- ${md(s)}`),
    ...meta.notes.map(s => `- Note: ${md(s)}`),
    "",
    `A team marked inferred is a guess from paper titles, research interests, past roles or co-authors; the evidence is under each person. Scores follow ${meta.rubricName ?? "rubric.json"}; a rule the profile has no data for counts at a part of its points (no_data_share), and the share of the rubric checked is shown next to each score. Use the scores to decide who to read first.`,
    "",
    "## Team map",
    "",
    teamMap(rows),
    `## Top ${Math.min(top, sorted.length)} by score`,
    "",
    ...sorted.slice(0, top).map((r, i) => personBlock(r, i + 1, labIds, now)),
    "Data from [Crustdata](https://crustdata.com). Full list with every column: researchers.csv.",
    "",
  ].join("\n");
}

