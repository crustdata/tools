/**
 * Slack output through an incoming webhook (https://api.slack.com/messaging/webhooks): one summary message per run,
 * with the counts and the candidates to review first. Everything taken from profiles and files is escaped, so a
 * name can never ping a channel or plant a link.
 */

import type { Row } from "./output.js";
import { labelCounts } from "./output.js";
import { VERDICTS, reviewOrder, summaryLine, verdictLabel } from "./verdict.js";

export type SlackMessage = { text: string; blocks?: unknown[] };

/** Slack's limits: 3,000 characters per section, 50 blocks per message. We stay well under both. */
const MAX_SECTION_CHARS = 2_800;
const MAX_LISTED = 25;

const clip = (s: string | undefined, max: number): string => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
/** Escapes text for Slack mrkdwn: &, <, > (so "<!channel>" is shown, not run). */
export const esc = (s?: string, max = 200): string => clip(s, max).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const link = (url: string, label: string): string => `<${url.replace(/[<>|\s]/g, "")}|${esc(label, 80).replace(/\|/g, "/")}>`;

/**
 * The run summary as one Slack message: counts per review section, then (unless `detail` is "counts") the
 * candidates to review first or clarify in the screen, by the name in your file, with the reason.
 */
export function summaryMessage(listName: string, rows: Row[], extra: { unresolved: number; credits: number; quick: boolean; detail?: "names" | "counts" }): SlackMessage {
  const people = rows.filter(r => !r.duplicateOf);
  const inSection = (from: number, to: number) => people.filter(r => { const o = reviewOrder(r.result); return o >= from && o <= to; });
  const review = inSection(1, 4);
  const ask = inSection(5, 6).length;
  const holds = inSection(8, 9).length;
  const lowRisk = inSection(10, 10).length;
  const unchecked = inSection(7, 7).length;
  const heading = `Candidate verification: ${clip(listName, 80)}`;
  const counts = [
    `${people.filter(r => r.result.check !== "none").length} checked${extra.quick ? " (quick screen: scores only, no reasons)" : ""}`,
    `*${review.length} to review first or clarify*`,
    ask && `${ask} to ask about in the first call`,
    holds && `${holds} hold up`,
    lowRisk && `${lowRisk} with a low-risk profile score`,
    unchecked && `${unchecked} not checked`,
  ].filter(Boolean).join(" · ");

  const sections: string[] = [];
  let current = "";
  const listed = extra.detail === "counts" ? [] : review.slice(0, MAX_LISTED);
  for (const row of listed) {
    const r = row.result;
    const name = row.candidate.name || r.person?.name || "Candidate";
    const role = [r.person?.title, r.person?.company && `at ${r.person.company}`].filter(Boolean).join(" ");
    const reason = r.aiSummary || summaryLine(r).replace(new RegExp(`^${verdictLabel(r).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?\\s*`), "");
    const line = `• *${link(r.profileUrl, name)}*${role ? `, ${esc(role, 120)}` : ""}\n   _${esc(verdictLabel(r), 100)}_${reason ? `: ${esc(reason, 260)}` : ""}\n`.slice(0, MAX_SECTION_CHARS);
    if (current && current.length + line.length > MAX_SECTION_CHARS) { sections.push(current); current = ""; }
    current += line;
  }
  if (current) sections.push(current);
  const more = listed.length ? review.length - listed.length : 0;

  const breakdown = labelCounts(people).map(c => `${c.label}: ${c.count}`).join(" · ");
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: heading.slice(0, 150) } },
    { type: "section", text: { type: "mrkdwn", text: counts } },
    ...sections.map(text => ({ type: "section", text: { type: "mrkdwn", text } })),
    ...(more > 0 ? [{ type: "section", text: { type: "mrkdwn", text: `…and ${more} more in verified.csv.` } }] : []),
    ...(extra.detail === "counts" ? [{ type: "section", text: { type: "mrkdwn", text: "Names and reasons are in verified.csv and report.md." } }] : []),
    { type: "context", elements: [{ type: "mrkdwn", text: `${esc(breakdown, 400)}  ·  ${extra.credits} credits  ·  A verdict is evidence to review, not a decision.  ·  Data from Crustdata` }] },
  ];
  return { text: `${esc(heading, 150)}: ${review.length} to review first or clarify, of ${people.length}`, blocks };
}

/** Slack incoming webhook URLs look like https://hooks.slack.com/services/T.../B.../... */
export const looksLikeSlackWebhook = (url: string): boolean => /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(url.trim());

/** A short message that proves the webhook reaches the right channel. Used by setup and npm run test-slack. */
export const connectedMessage = (): SlackMessage => ({
  text: "Candidate Verification Agent is connected. A summary of each verified candidate list will be posted in this channel.",
});

export type SlackResult = { ok: boolean; status?: number; error?: string };

/** Posts one message, with one retry after a 429 or a network error. */
export async function postToSlack(webhookUrl: string, message: SlackMessage, wait = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<SlackResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message), signal: AbortSignal.timeout(15_000) });
      if (res.ok) return { ok: true, status: res.status };
      const body = (await res.text()).slice(0, 200);
      if (res.status === 429 && attempt === 0) { await wait((Number(res.headers.get("retry-after")) || 2) * 1000); continue; }
      const hint = res.status === 404 || /no_service|invalid_token/.test(body) ? " The webhook was removed or is wrong: make a new one and run npm run setup." : res.status === 403 || /action_prohibited/.test(body) ? " Slack refused it (the app may have been removed from the channel)." : "";
      return { ok: false, status: res.status, error: `Slack answered ${res.status} ${body}.${hint}` };
    } catch (err) {
      if (attempt === 0) { await wait(2000); continue; }
      return { ok: false, error: `Slack could not be reached: ${(err as Error).message}` };
    }
  }
  return { ok: false, error: "Slack is rate limiting this webhook" };
}
