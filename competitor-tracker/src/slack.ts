/**
 * Slack output through an incoming webhook (https://api.slack.com/messaging/webhooks), formatted with Block Kit.
 * One message for the whole digest when it fits: competitors with news in full, quiet ones together on one line. A
 * very long digest is packed into as few messages as Slack's limits allow (3,000 characters per section, 50 blocks
 * per message, about one message a second). Everything that came from a page, a post or a profile is escaped, so no
 * name can ping a channel or plant a link.
 */

import { config } from "./config.js";
import { FIRST_RUN_NOTE, QUIET, creditsLine, digestTitle, isQuiet, itemCount, orderCompetitors, orderItems } from "./digest.js";
import type { CompetitorDigest, Digest, Item, Section } from "./types.js";
import { SECTIONS, SECTION_TITLES, capitalise, sentence, shortDate } from "./types.js";

export type SlackMessage = { text: string; blocks?: unknown[] };

const MAX_SECTION_CHARS = 2_800;
const MAX_BLOCKS = 45;

export const esc = (s?: string): string => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A Slack link, or just the label when the URL is not http(s) or is too long to fit safely in a section. */
const link = (url: string | undefined, label: string): string => (url && /^https?:\/\//i.test(url) && url.length <= 1_000 ? `<${url.replace(/[<>|\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)}|${esc(label).replace(/\|/g, "/")}>` : esc(label));

export function itemText(i: Item): string {
  const date = shortDate(i.date, i.text);
  const what = sentence(`${esc(i.text)}${date ? ` (${date})` : ""}`);
  const why = i.why ? ` _${sentence(capitalise(esc(i.why)))}_` : "";
  return `• ${what}${why}${i.url ? ` ${link(i.url, i.linkLabel ?? "source")}` : ""}`;
}

/** The mrkdwn for one section, split into chunks under Slack's section limit. */
export function sectionChunks(section: Section, c: CompetitorDigest): string[] {
  const items = orderItems(c.sections[section].items);
  const title = `*${SECTION_TITLES[section]}*`;
  if (!items.length) return [`${title}: ${sentence(capitalise(esc(c.sections[section].note ?? QUIET[section])))}`];
  const chunks: string[] = [];
  let cur = title;
  for (const i of items) {
    const line = `\n${itemText(i).slice(0, MAX_SECTION_CHARS - 100)}`;
    if (cur.length + line.length > MAX_SECTION_CHARS) { chunks.push(cur); cur = `${title} (continued)`; }
    cur += line;
  }
  if (c.sections[section].note) cur += `\n_${esc(c.sections[section].note)}_`;
  chunks.push(cur);
  return chunks;
}

export function competitorBlocks(c: CompetitorDigest): unknown[] {
  if (isQuiet(c)) {
    return [{ type: "section", text: { type: "mrkdwn", text: `*${esc(c.name)}* (${esc(c.domain)}): nothing new in any section this week.` } }];
  }
  return [
    { type: "header", text: { type: "plain_text", text: `${c.name} (${c.domain})`.slice(0, 150), emoji: false } },
    ...SECTIONS.flatMap(s => sectionChunks(s, c).map(text => ({ type: "section", text: { type: "mrkdwn", text } }))),
  ];
}

/** The digest as one or more Slack messages, each under the block limit. */
const hasNews = (c: CompetitorDigest) => !isQuiet(c);

export function digestMessages(d: Digest): SlackMessage[] {
  const n = itemCount(d);
  const title = digestTitle(d);
  const intro = { type: "section", text: { type: "mrkdwn", text: `*${esc(title)}*: ${d.competitors.length} competitor${d.competitors.length === 1 ? "" : "s"}, ${n} item${n === 1 ? "" : "s"}.${d.firstRun ? ` ${esc(FIRST_RUN_NOTE)}` : ""}${(d.notices ?? []).map(x => `\n_${esc(x)}_`).join("")}` } };
  const ordered = orderCompetitors(d.competitors);
  const busy = ordered.filter(hasNews);
  const quiet = ordered.filter(c => !hasNews(c));
  const groups = busy.map(competitorBlocks);
  if (quiet.length) groups.push([{ type: "context", elements: [{ type: "mrkdwn", text: `Nothing new this week: ${quiet.map(c => esc(c.name)).join(", ")}.`.slice(0, MAX_SECTION_CHARS) }] }]);
  const warn = d.warnings.length ? [{ type: "context", elements: [{ type: "mrkdwn", text: `Warnings: ${d.warnings.map(esc).join(" · ")}`.slice(0, MAX_SECTION_CHARS) }] }] : [];
  const footer = { type: "context", elements: [{ type: "mrkdwn", text: `${esc(creditsLine(d))}  ·  Headcount lines, and funding lines without a link, are Crustdata company data  ·  Data from Crustdata  ·  <https://github.com/crustdata/tools/tree/main/competitor-tracker|competitor-tracker>` }] };

  // Pack whole competitors into messages; a competitor too big for one message is split across several.
  const messages: unknown[][] = [[intro]];
  for (const g of groups) {
    for (let j = 0; j < g.length; j += MAX_BLOCKS - 1) {
      const part = g.slice(j, j + MAX_BLOCKS - 1);
      const current = messages.at(-1)!;
      if (current.length + part.length <= MAX_BLOCKS) current.push(...part);
      else messages.push([...part]);
    }
  }
  const tail = [...warn, footer];
  if (messages.at(-1)!.length + tail.length <= MAX_BLOCKS) messages.at(-1)!.push(...tail);
  else messages.push(tail);
  return messages.map((blocks, i) => ({ text: i === 0 ? `${title}: ${n} item${n === 1 ? "" : "s"}` : `${title} (continued)`, blocks }));
}

/** Posts one message. Resolves to null when Slack accepted it, or to the reason it did not. */
export async function postToSlack(message: SlackMessage, webhookUrl = config.slackWebhookUrl): Promise<string | null> {
  if (!webhookUrl) return "SLACK_WEBHOOK_URL is not set";
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message), signal: AbortSignal.timeout(20_000) });
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
    if (res.status === 404 || /no_service|channel_not_found|invalid_token/.test(body)) return "Slack says this webhook no longer exists. Create a new one and run npm run setup.";
    return `Slack answered ${res.status}: ${body.slice(0, 200)}`;
  }
  return lastStatus === 429 ? "Slack kept rate limiting; try again later" : `Slack answered ${lastStatus} four times in a row; try again later`;
}

/**
 * Sends the messages of a digest in order, pausing between them, starting at `from` (messages already delivered by an
 * earlier attempt are not posted twice). Stops at the first failure; `onSent` records progress after each message.
 */
export async function sendDigestToSlack(d: Digest, from = 0, onSent: (delivered: number) => void = () => {}): Promise<string | null> {
  const messages = digestMessages(d);
  for (let i = from; i < messages.length; i++) {
    if (i > from) await new Promise(r => setTimeout(r, 1_100));
    const problem = await postToSlack(messages[i]);
    if (problem) return `message ${i + 1} of ${messages.length}: ${problem}`;
    onSent(i + 1);
  }
  return null;
}
