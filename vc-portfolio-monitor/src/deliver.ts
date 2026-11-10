/**
 * Delivery after a run has been saved: alerts to Slack (owner routes or the main channel), digests to Slack, email
 * and a markdown file. Anything a channel did not accept stays pending and is sent by the next run or `npm run resend`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, hasEmail, hasSlack, ownerKey } from "./config.js";
import { sendDigestEmail } from "./email.js";
import type { Digest } from "./run.js";
import { alertMessages, digestMessages, postToSlack, routesFor, sendMessages } from "./slack.js";
import type { Store } from "./store.js";

/** null: sent. "skipped": nothing to send on this channel. A string: why it failed. */
export type Delivery = null | "skipped" | string;

/**
 * Posts every alert, good news and note not posted yet, to each owner's channel (a company with two owners goes to
 * both) or the main channel. A signal is marked posted once every channel it goes to has accepted the message that
 * carries it, so a post that fails halfway resends only what did not arrive. An owner channel whose webhook is gone
 * falls back to the main channel. Without Slack, signals are only marked (the digest has them).
 */
export async function sendAlerts(store: Store): Promise<{ posted: number; problems: string[]; warnings: string[] }> {
  const pending = store.unposted();
  const warnings: string[] = [];
  if (!pending.length) return { posted: 0, problems: [], warnings };
  if (!hasSlack()) { store.markPosted(pending.map(s => s.id)); return { posted: 0, problems: [], warnings }; }
  // Each signal goes to each of its channels once: a channel that already accepted it is skipped on a retry.
  const routeId = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 16);
  const main = config.slackWebhookUrl;
  const routes = new Map<number, string[]>(pending.map(s => [s.id, routesFor(store.company(s.domain))]));
  const finish = (ids: number[]) => {
    const done = ids.filter(id => { const got = store.postedRoutes(id); return (routes.get(id) ?? []).every(u => got.has(routeId(u))); });
    if (done.length) store.markPosted(done);
  };
  // Owner channels first, the main channel last, so alerts from an owner channel that is gone can join the main list.
  const order = [...new Set(pending.flatMap(s => routes.get(s.id)!))].sort((a, b) => (a === main ? 1 : 0) - (b === main ? 1 : 0));
  if (!order.includes(main)) order.push(main);
  const extraForMain: typeof pending = [];
  const deadRoutes = new Set<string>();
  const notices: string[] = [];
  const problems: string[] = [];
  for (const url of order) {
    const owed = (url === main ? [...pending.filter(s => routes.get(s.id)!.includes(main)), ...extraForMain] : pending.filter(s => routes.get(s.id)!.includes(url)))
      .filter((s, i, a) => a.findIndex(x => x.id === s.id) === i && !store.postedRoutes(s.id).has(routeId(main === url ? main : url)));
    if (!owed.length) continue;
    const messages = alertMessages(owed);
    const problem = await sendMessages(messages, url, 0, n => {
      const ids = messages[n - 1].signalIds ?? [];
      for (const id of ids) {
        store.markRoutePosted(id, routeId(url));
        // A signal that came to the main channel in place of a gone owner channel: that owner's share is delivered too.
        for (const r of routes.get(id) ?? []) if (url === main && deadRoutes.has(r)) store.markRoutePosted(id, routeId(r));
      }
      finish(ids);
    });
    if (problem && url !== main && /no longer exists/.test(problem)) {
      // The partner's webhook was removed or its channel archived: what did not arrive goes to the main channel.
      deadRoutes.add(url);
      const key = Object.entries(config.slackRoutes).find(([, u]) => u === url)?.[0];
      const owner = (key && config.slackRouteNames[key]) || key || "an owner";
      extraForMain.push(...owed.filter(s => !store.postedRoutes(s.id).has(routeId(url))));
      notices.push(`${owner}'s Slack channel no longer accepts posts (the webhook was removed or the channel archived), so their alerts are posted here. Update ${owner} in SLACK_ROUTES.`);
      warnings.push(`${owner}'s Slack channel no longer accepts posts; their alerts go to the main channel. Update ${owner} in SLACK_ROUTES.`);
      continue;
    }
    if (problem) problems.push(`${url === main ? "main channel" : "an owner channel"}: ${problem}`);
  }
  if (notices.length) { const n = await postToSlack({ text: notices.join("\n") }, main); if (n) problems.push(`main channel: ${n}`); }
  const posted = pending.filter(s => (routes.get(s.id) ?? []).every(u => store.postedRoutes(s.id).has(routeId(u)))).length;
  return { posted, problems, warnings };
}

/** Owners named in the portfolio with no Slack route (their alerts go to the main channel). */
export function ownersWithoutRoute(store: Store): string[] {
  if (!Object.keys(config.slackRoutes).length) return [];
  const owners = new Map<string, string>();
  for (const c of store.companies()) for (const o of (c.owner ?? "").split(", ").filter(Boolean)) if (!owners.has(ownerKey(o))) owners.set(ownerKey(o), o);
  return [...owners.entries()].filter(([k]) => !config.slackRoutes[k]).map(([, o]) => o);
}

/** Writes digests/<date>.md and returns its path. */
export function writeDigestFile(markdown: string, to: string): string {
  mkdirSync(config.digestDir, { recursive: true });
  // A second digest on the same day gets its own file.
  let file = resolve(config.digestDir, `${to.slice(0, 10)}.md`);
  for (let n = 2; existsSync(file); n++) file = resolve(config.digestDir, `${to.slice(0, 10)}-${n}.md`);
  writeFileSync(file, markdown);
  return file;
}

/**
 * Sends a saved digest to every channel it still owes. `force` sends again to every configured channel. Slack resumes
 * from the message where an earlier attempt stopped.
 */
export async function sendDigest(store: Store, id: number, d: Digest, { force = false } = {}): Promise<{ slack: Delivery; email: Delivery }> {
  const saved = store.recentDigests(50).find(x => x.id === id);
  const owesSlack = hasSlack() && (force || (saved?.wantSlack && !saved.sentSlack));
  const owesEmail = hasEmail() && (force || (saved?.wantEmail && !saved.sentEmail));
  let slack: Delivery = "skipped";
  let email: Delivery = "skipped";
  if (owesSlack) {
    const from = force ? 0 : store.slackDelivered(id);
    slack = await sendMessages(digestMessages(d), config.slackWebhookUrl, from, n => store.setSlackDelivered(id, n));
    if (slack === null) store.markDigestSent(id, "slack");
  }
  if (owesEmail) {
    email = await sendDigestEmail(d);
    if (email === null) store.markDigestSent(id, "email");
  }
  return { slack, email };
}
