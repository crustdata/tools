/**
 * Slack output through incoming webhooks (https://api.slack.com/messaging/webhooks), formatted with Block Kit.
 * One message per change, and one message for the daily digest. Everything taken from profiles is escaped, so a
 * name or title can never ping a channel or plant a link.
 */

import { config } from "./config.js";
import { duration, headline, monthYear, type ChangeKind, type JobChange } from "./notification.js";

export type SlackMessage = { text: string; blocks?: unknown[] };

/** Slack's limits: 3,000 characters per section, 50 blocks per message. We stay under both. */
const MAX_SECTION_CHARS = 2_800;
const MAX_BLOCKS = 45;

/** Escapes text for Slack mrkdwn. */
export const esc = (s?: string): string => clip(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Profile text can be any length; keep each field short enough that a message always fits Slack's limits. */
const clip = (s?: string, max = 200): string => { const t = s ?? ""; return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const link = (url: string | undefined, label: string): string => (url ? `<${url.replace(/[<>|]/g, "")}|${esc(label).replace(/\|/g, "/")}>` : esc(label));
const bold = (s?: string) => (s ? `*${esc(s)}*` : "");

const ownerKey = (owner: string) => owner.trim().toLowerCase();

function ownerLabel(owner?: string): string | undefined {
  if (!owner) return undefined;
  const id = config.ownerSlackIds[ownerKey(owner)];
  return id ? `<@${id.replace(/[^A-Z0-9]/gi, "")}>` : esc(owner);
}

const domainLink = (domain?: string) => (domain ? ` (${link(`https://${domain}`, domain)})` : "");
const since = (date?: string) => (monthYear(date) ? `, since ${monthYear(date)}` : "");

/** The lines of one alert, in Slack mrkdwn. Shared by the real-time message and the digest. */
export function alertLines(e: JobChange): { title: string; details: string[]; next?: string } {
  const who = `*${link(e.profileUrl, e.name ?? "Someone on your list")}*`;
  const tenure = duration(e.previousTenureMonths);
  switch (e.kind) {
    case "new_company":
      return {
        title: `${who} moved to ${bold(e.newCompany) || "a new company"}${domainLink(e.newCompanyDomain)}`,
        details: [
          e.newTitle && `${esc(e.newTitle)}${since(e.startDate)}`,
          e.previousCompany && `Was ${esc([e.previousTitle, e.previousCompany].filter(Boolean).join(" at "))}${tenure ? ` for ${tenure}` : ""}`,
        ].filter(Boolean) as string[],
        next: `Congratulate them and reopen the conversation at ${esc(e.newCompany ?? "their new company")}.`,
      };
    case "title_change":
      return {
        title: `${who} has a new title at ${bold(e.newCompany) || "their company"}`,
        details: [`${esc(e.previousTitle ?? "Previous title")} → ${esc(e.newTitle ?? "new title")}${since(e.startDate)}`],
        next: "Congratulate them on the new role.",
      };
    case "left_company":
      return {
        title: `${who} left ${bold(e.previousCompany) || "their company"}`,
        details: [`Was ${esc(e.previousTitle ?? "there")}${tenure ? ` for ${tenure}` : ""}. ${e.stillCompany ? `Still ${esc([e.stillTitle, e.stillCompany].filter(Boolean).join(" at "))}.` : "No new role listed yet."}`],
        next: `Find out who now owns the relationship at ${esc(e.previousCompany ?? "the account")}.`,
      };
    case "added_role":
      return {
        title: `${who} added a role: ${esc(e.newTitle ?? "a role")} at ${bold(e.newCompany)}`,
        details: [e.stillCompany ? `Still ${esc([e.stillTitle, e.stillCompany].filter(Boolean).join(" at "))}.` : ""].filter(Boolean),
      };
    case "title_edit":
      return { title: `${who} edited their title`, details: [] };
  }
}

export function jobChangeMessage(e: JobChange): SlackMessage {
  const { title, details, next } = alertLines(e);
  const owner = ownerLabel(e.owner);
  const lines = [title, ...details, owner && `Owner: ${owner}`].filter(Boolean);
  return {
    text: esc(headline(e)),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      { type: "context", elements: [{ type: "mrkdwn", text: [next && `Next: ${next}`, "Data from Crustdata"].filter(Boolean).join("  ·  ") }] },
    ],
  };
}

/** Digest headings, in display order. Typed so a new ChangeKind cannot be forgotten here. */
const KIND_HEADINGS: Record<Exclude<ChangeKind, "title_edit">, string> = {
  new_company: "Moved to a new company",
  left_company: "Left their company",
  title_change: "New title at the same company",
  added_role: "Added a side role",
};

export type DigestPart = { message: SlackMessage; ids: string[] };
const MAX_DIGEST_MESSAGES = 20;

/**
 * The digest as one or more Slack messages, grouped by kind and split to fit Slack's limits (3,000 characters per
 * section, 50 blocks per message). Past 20 messages the rest are counted, not shown; `npm run changes` lists them.
 */
export function digestMessages(changes: JobChange[], periodLabel: string): DigestPart[] {
  const heading = `${changes.length} job change${changes.length === 1 ? "" : "s"} ${periodLabel}`;
  const sections: { text: string; ids: string[] }[] = [];
  for (const kind of Object.keys(KIND_HEADINGS) as (keyof typeof KIND_HEADINGS)[]) {
    const group = changes.filter(c => c.kind === kind);
    if (!group.length) continue;
    let current = { text: `*${KIND_HEADINGS[kind]}*`, ids: [] as string[] };
    for (const c of group) {
      const { title, details } = alertLines(c);
      const owner = ownerLabel(c.owner);
      const body = [title, ...details].map(t => t.replace(/\.$/, "")).join(". ");
      const line = `\n• ${body}${owner ? `. Owner: ${owner}` : ""}`.slice(0, MAX_SECTION_CHARS - 100);
      if (current.text.length + line.length > MAX_SECTION_CHARS) { sections.push(current); current = { text: "", ids: [] }; }
      current.text += line;
      current.ids.push(c.id);
    }
    sections.push(current);
  }

  const parts: DigestPart[] = [];
  let blocks: unknown[] = [];
  let ids: string[] = [];
  const flush = () => { if (blocks.length) parts.push({ message: { text: parts.length ? `${heading} (continued)` : heading, blocks }, ids }); blocks = []; ids = []; };
  for (const section of sections) {
    if (!blocks.length) blocks.push({ type: "header", text: { type: "plain_text", text: (parts.length ? `${heading} (continued)` : heading).slice(0, 150) } });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: section.text.trimStart() } });
    ids.push(...section.ids);
    if (blocks.length >= MAX_BLOCKS) flush();
  }
  flush();

  const shown = parts.slice(0, MAX_DIGEST_MESSAGES);
  const hidden = parts.slice(MAX_DIGEST_MESSAGES).reduce((n, p) => n + p.ids.length, 0);
  const last = shown.at(-1);
  if (last) {
    const footer = [hidden > 0 && `…and ${hidden} more. Run \`npm run changes\` to list them all.`, "Daily digest from Job Change Alert Bot. Data from Crustdata."].filter(Boolean).join("  ");
    (last.message.blocks as unknown[]).push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] });
    if (hidden) last.ids.push(...parts.slice(MAX_DIGEST_MESSAGES).flatMap(p => p.ids));
  }
  return shown;
}

/** The whole digest as a single message, for callers that only need a preview. */
export const digestMessage = (changes: JobChange[], periodLabel: string): SlackMessage => digestMessages(changes, periodLabel)[0]?.message ?? { text: `No job changes ${periodLabel}` };

/** A short message that proves the webhook reaches the right channel. Used by setup and `npm run test-slack`. */
export const connectedMessage = (): SlackMessage => ({
  text: "Job Change Alert Bot is connected. Job change alerts and the daily digest will be posted in this channel.",
});

/** Slack incoming webhook URLs look like https://hooks.slack.com/services/T.../B.../... */
export const looksLikeSlackWebhook = (url: string): boolean => /^https:\/\/hooks\.slack\.com\/services\/\S+$/.test(url);

/** Where an alert goes: the owner's own channel when SLACK_ROUTES has one, otherwise SLACK_WEBHOOK_URL. */
export const webhookFor = (owner?: string): string => (owner && config.slackRoutes[ownerKey(owner)]) || config.slackWebhookUrl;

export type SlackResult = { ok: boolean; status?: number; retryAfterSeconds?: number };

/** Posts to Slack. Without a webhook URL it prints the message instead, so everything works locally. */
export async function postToSlack(message: SlackMessage, webhookUrl = config.slackWebhookUrl): Promise<SlackResult> {
  if (!webhookUrl) {
    console.log(`[slack not configured] ${message.text}`);
    return { ok: true };
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true, status: res.status };
    console.error(`Slack webhook failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return { ok: false, status: res.status, retryAfterSeconds: Number(res.headers.get("retry-after")) || undefined };
  } catch (err) {
    console.error(`Slack webhook unreachable: ${(err as Error).message}`);
    return { ok: false };
  }
}
