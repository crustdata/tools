/** The weekly digest as markdown (also the email's plain-text part and the file in digests/). Pure functions. */

import type { Digest, DigestCompany } from "./run.js";
import { SEVERITY_LABEL, SEVERITY_ORDER, longDate, sentence, type Severity, type Signal } from "./types.js";

/** The most serious kinds first within one severity. */
const KIND_ORDER = ["leader_left", "ceo_changed", "acquired", "bad_news", "bridge_round", "status", "hiring_stopped", "headcount_down", "team_down"];
export const kindRank = (s: Signal) => { const i = KIND_ORDER.indexOf(s.kind); return i < 0 ? KIND_ORDER.length : i; };
/** One order everywhere (Slack, email, markdown): severity, then the most serious kind, then the newest. */
export const orderSignals = (signals: Signal[]): Signal[] =>
  [...signals].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || kindRank(a) - kindRank(b) || String(b.date ?? "").localeCompare(String(a.date ?? "")));

const rank = (c: DigestCompany) => Math.min(...c.signals.map(s => SEVERITY_ORDER.indexOf(s.severity)), c.start ? 4 : 5);
/** Companies with alerts first, then good news, notes, news, new companies. Alphabetical within each. */
export const orderCompanies = (cs: DigestCompany[]): DigestCompany[] => [...cs].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

export function counts(d: Digest): Record<Severity, number> {
  const out: Record<Severity, number> = { alert: 0, good: 0, note: 0, news: 0 };
  for (const c of d.companies) for (const s of c.signals) out[s.severity]++;
  return out;
}

export const digestTitle = (d: Digest): string => `${d.fund} weekly digest, ${longDate(d.from)} to ${longDate(d.to)}`;

export function summaryLine(d: Digest): string {
  const n = counts(d);
  const parts = [`${n.alert} alert${n.alert === 1 ? "" : "s"}`, `${n.good} good news`, `${n.note} note${n.note === 1 ? "" : "s"}`, `${n.news} news mention${n.news === 1 ? "" : "s"}`];
  const total = d.companies.length + d.quiet.length;
  return `${total} compan${total === 1 ? "y" : "ies"}: ${parts.join(", ")}.`;
}

export const creditsLine = (d: Digest): string =>
  `Credits since the last digest: ${d.credits.own} for this tool's own calls, ${d.credits.watchers} billed by the watchers.`;

/** "Nothing new", unless the watchers could not be checked: then the quiet list is not an all-clear. */
export const quietLabel = (d: Digest): string =>
  d.warnings.some(w => /Could not check|has not run|last ran on|not running|is paused|is suspended|deleted outside/.test(w)) ? "Not confirmed, see the warnings above" : "Nothing new";

export const startLine = (c: DigestCompany): string =>
  `Starting point: ${[c.start, c.hiring, c.leaders !== undefined ? `${c.leaders} leader${c.leaders === 1 ? "" : "s"} watched` : undefined].filter(Boolean).join("; ")}.`;

const mdEscape = (s: string) => s.replace(/([\\`*_[\]<>|])/g, "\\$1");

export function signalMarkdown(s: Signal): string {
  const link = s.url && /^https?:\/\//i.test(s.url) ? ` [${s.linkLabel ?? "source"}](${s.url.replace(/[()\s]/g, encodeURIComponent)})` : "";
  return `- **${SEVERITY_LABEL[s.severity]}:** ${mdEscape(sentence(s.text))}${s.why ? ` _${mdEscape(s.why)}_` : ""}${link}`;
}

export function digestMarkdown(d: Digest): string {
  const out = [`# ${digestTitle(d)}`, "", summaryLine(d), ""];
  if (d.firstDigest) out.push("First digest: each company's starting point is below. From here on, the digest lists what changed.", "");
  for (const w of d.warnings) out.push(`> ${mdEscape(w)}`, "");
  for (const c of orderCompanies(d.companies)) {
    out.push(`## ${mdEscape(c.name)} (${c.domain})${c.owner ? `, ${mdEscape(c.owner)}` : ""}`, "");
    for (const s of orderSignals(c.signals)) out.push(signalMarkdown(s));
    if (c.start !== undefined) out.push(`- ${mdEscape(startLine(c))}`);
    out.push("");
  }
  if (d.quiet.length) out.push(`${quietLabel(d)}: ${d.quiet.map(mdEscape).join(", ")}.`, "");
  out.push("---", "", `${creditsLine(d)} Headcount and funding lines are Crustdata company data; hiring lines count the roles on each careers page. Data from [Crustdata](https://crustdata.com). Built with [vc-portfolio-monitor](https://github.com/crustdata/tools/tree/main/vc-portfolio-monitor).`, "");
  return out.join("\n");
}
