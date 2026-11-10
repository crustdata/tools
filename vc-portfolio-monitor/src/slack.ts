/**
 * Slack through incoming webhooks (https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/), with
 * Block Kit. Alerts post right after each check, to the company owner's channel when SLACK_ROUTES has one, otherwise
 * to SLACK_WEBHOOK_URL. The weekly digest goes to SLACK_WEBHOOK_URL. Slack limits are respected (3,000 characters per
 * section, 50 blocks per message, about one message a second) and everything from outside is escaped, so a company
 * name or headline can never ping a channel or plant a link.
 */

import { config, ownerKey } from "./config.js";
import { counts, creditsLine, digestTitle, kindRank, orderCompanies, orderSignals, quietLabel, startLine, summaryLine } from "./digest.js";
import type { Digest } from "./run.js";
import type { Company } from "./store.js";
import { SEVERITY_LABEL, sentence, type Signal } from "./types.js";

export type SlackMessage = { text: string; blocks?: unknown[]; /** Signals this message carries (not sent to Slack). */ signalIds?: number[] };

const MAX_SECTION_CHARS = 2_800;
const MAX_BLOCKS = 45;

export const esc = (s?: string): string => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const link = (url: string | undefined, label: string): string =>
  url && /^https?:\/\//i.test(url) && url.length <= 1_000 ? ` <${url.replace(/[<>|\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)}|${esc(label).replace(/\|/g, "/")}>` : "";

export function signalLine(s: Signal): string {
  return `• *${SEVERITY_LABEL[s.severity]}:* ${esc(sentence(s.text))}${s.why ? ` _${esc(s.why)}_` : ""}${link(s.url, s.linkLabel ?? "source")}`.slice(0, MAX_SECTION_CHARS - 50);
}

export const orderForSlack = orderSignals;

/** Sections for one company: a bold name line, then its signals, split under Slack's section limit. */
function companySections(name: string, domain: string, lines: string[]): unknown[] {
  const head = `*${esc(name)}* (${esc(domain)})`;
  const out: unknown[] = [];
  let cur = head;
  for (const l of lines) {
    if (cur.length + l.length + 1 > MAX_SECTION_CHARS) { out.push({ type: "section", text: { type: "mrkdwn", text: cur } }); cur = `${head} (continued)`; }
    cur += `\n${l}`;
  }
  out.push({ type: "section", text: { type: "mrkdwn", text: cur } });
  return out;
}

/** Packs block groups into messages under the block limit; a group never splits unless it alone is too big. */
function pack(intro: unknown[], groups: unknown[][], tail: unknown[], title: string, groupIds: number[][] = []): SlackMessage[] {
  const messages: unknown[][] = [[...intro]];
  const ids: number[][] = [[]];
  groups.forEach((g, gi) => {
    for (let j = 0; j < g.length; j += MAX_BLOCKS - 1) {
      const part = g.slice(j, j + MAX_BLOCKS - 1);
      if (messages.at(-1)!.length + part.length > MAX_BLOCKS) { messages.push([]); ids.push([]); }
      messages.at(-1)!.push(...part);
      // A company split over two messages counts as delivered with the last one.
      if (j + MAX_BLOCKS - 1 >= g.length) ids.at(-1)!.push(...(groupIds[gi] ?? []));
    }
  });
  if (tail.length) { if (messages.at(-1)!.length + tail.length <= MAX_BLOCKS) messages.at(-1)!.push(...tail); else { messages.push([...tail]); ids.push([]); } }
  return messages.map((blocks, i) => ({ text: i === 0 ? title : `${title} (continued)`, blocks, signalIds: ids[i] }));
}

/** One check's alerts for one channel, grouped by company, most serious first. */
export function alertMessages(signals: (Signal & { id?: number })[]): SlackMessage[] {
  const by = new Map<string, (Signal & { id?: number })[]>();
  for (const s of signals) { if (!by.has(s.domain)) by.set(s.domain, []); by.get(s.domain)!.push(s); }
  const n = signals.filter(s => s.severity === "alert").length;
  const title = `${config.fundName}: ${signals.length} update${signals.length === 1 ? "" : "s"}${n ? `, ${n} alert${n === 1 ? "" : "s"}` : ""}`;
  const lists = [...by.values()].sort((a, b) => Math.min(...a.map(rankOf)) - Math.min(...b.map(rankOf)) || Math.min(...a.map(kindRank)) - Math.min(...b.map(kindRank)) || a[0].company.localeCompare(b[0].company));
  const groups = lists.map(list => companySections(list[0].company, list[0].domain, orderForSlack(list).map(signalLine)));
  const footer = { type: "context", elements: [{ type: "mrkdwn", text: "Data from Crustdata · <https://github.com/crustdata/tools/tree/main/vc-portfolio-monitor|vc-portfolio-monitor>" }] };
  return pack([{ type: "section", text: { type: "mrkdwn", text: `*${esc(title)}*` } }], groups, [footer], title, lists.map(l => l.flatMap(s => (typeof s.id === "number" ? [s.id] : []))));
}
function rankOf(s: Signal): number { return ["alert", "good", "note", "news"].indexOf(s.severity); }

/**
 * Which webhooks a company's alerts go to: every owner's route (a company can have two owners), and the main channel
 * when it has no owner or an owner has no route of their own (so that owner still sees it).
 */
export function routesFor(c: Pick<Company, "owner"> | undefined): string[] {
  const owners = (c?.owner ?? "").split(", ").map(ownerKey).filter(Boolean);
  const urls = new Set(owners.map(o => config.slackRoutes[o]).filter(Boolean));
  if (!owners.length || owners.some(o => !config.slackRoutes[o])) urls.add(config.slackWebhookUrl);
  return [...urls];
}

/** The weekly digest as Slack messages. */
export function digestMessages(d: Digest): SlackMessage[] {
  const title = digestTitle(d);
  const intro = [{ type: "section", text: { type: "mrkdwn", text: `*${esc(title)}*\n${esc(summaryLine(d))}${d.firstDigest ? "\nFirst digest: each company's starting point is below." : ""}${d.warnings.map(w => `\n_${esc(w)}_`).join("")}` } }];
  const groups = orderCompanies(d.companies).map(c => companySections(c.name, c.domain, [
    ...orderForSlack(c.signals).map(signalLine),
    ...(c.start !== undefined ? [`• ${esc(startLine(c))}`] : []),
  ]));
  if (d.quiet.length) groups.push([{ type: "context", elements: [{ type: "mrkdwn", text: `${quietLabel(d)}: ${d.quiet.map(esc).join(", ")}.`.slice(0, MAX_SECTION_CHARS) }] }]);
  const footer = { type: "context", elements: [{ type: "mrkdwn", text: `${esc(creditsLine(d))} · Data from Crustdata · <https://github.com/crustdata/tools/tree/main/vc-portfolio-monitor|vc-portfolio-monitor>` }] };
  const n = counts(d);
  return pack(intro, groups, [footer], `${title}: ${n.alert} alert${n.alert === 1 ? "" : "s"}`);
}

/** A message's blocks as plain text (the fallback when Slack refuses the layout). */
export function plainText(m: SlackMessage): string {
  const parts: string[] = [m.text];
  for (const b of (m.blocks ?? []) as any[]) {
    if (b?.text?.text) parts.push(b.text.text);
    for (const e of b?.elements ?? []) if (e?.text) parts.push(e.text);
  }
  return parts.join("\n").slice(0, 39_000);
}

/** Posts one message. Resolves to null when Slack accepted it, or to the reason it did not. */
export async function postToSlack(message: SlackMessage, webhookUrl = config.slackWebhookUrl): Promise<string | null> {
  if (!webhookUrl) return "SLACK_WEBHOOK_URL is not set";
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res: Response;
    try {
      const { signalIds: _ids, ...body } = message; // internal bookkeeping, not for Slack
      res = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      if (attempt === 4) return `could not reach Slack (${(err as Error).message})`;
      await new Promise(r => setTimeout(r, attempt * 2000));
      continue;
    }
    if (res.ok) return null;
    const body = await res.text();
    if (res.status === 429 || res.status >= 500) {
      lastStatus = res.status;
      if (attempt === 4) break;
      const wait = Math.max(Number(res.headers.get("retry-after") || 0) * 1000, attempt * 2000);
      await new Promise(r => setTimeout(r, Math.min(wait, 30_000)));
      continue;
    }
    // Slack refused the layout: send the same lines as plain text once, so one odd message never blocks a channel.
    if (res.status === 400 && /invalid_blocks|invalid_payload|invalid_attachments/.test(body) && message.blocks) {
      return postToSlack({ text: plainText(message) }, webhookUrl);
    }
    if (res.status === 404 || res.status === 410 || /no_service|channel_not_found|channel_is_archived|invalid_token|team_disabled|no_team/.test(body)) return "Slack says this webhook no longer exists (or its channel was archived). Create a new one and run npm run setup.";
    return `Slack answered ${res.status}: ${body.slice(0, 200)}`;
  }
  return lastStatus === 429 ? "Slack kept rate limiting; try again later" : `Slack answered ${lastStatus} four times in a row; try again later`;
}

/** Posts messages in order, a second apart, from `from`. Stops at the first failure; `onSent` records progress. */
export async function sendMessages(messages: SlackMessage[], webhookUrl: string, from = 0, onSent: (delivered: number) => void = () => {}): Promise<string | null> {
  for (let i = from; i < messages.length; i++) {
    if (i > from) await new Promise(r => setTimeout(r, 1_100));
    const problem = await postToSlack(messages[i], webhookUrl);
    if (problem) return `message ${i + 1} of ${messages.length}: ${problem}`;
    onSent(i + 1);
  }
  return null;
}
