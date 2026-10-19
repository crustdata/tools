/**
 * The daily digest: every alert received since the last digest, sent to Slack and, if configured, email.
 * Changes are marked as digested only when at least one channel accepted the digest, so nothing is lost on a
 * Slack outage. A digest missed while the server was down is sent as soon as it is back.
 * Each digest also checks that the watches are still active, so a suspended watch never fails silently.
 */

import { config } from "./config.js";
import { jobChanges, settings, watchIds } from "./store.js";
import { digestMessages, postToSlack } from "./slack.js";
import { emailConfigured, sendDigestEmail } from "./email.js";
import { getWatch } from "./crustdata.js";

const today = () => new Date().toISOString().slice(0, 10);

export async function sendDigest({ evenIfEmpty = false } = {}): Promise<number> {
  const last = settings.get("last_digest_at");
  const period = last ? `since ${new Date(last).toUTCString().slice(5, 16)}` : "so far";
  const changes = jobChanges.notYetDigested();
  const warnings = await watchWarnings();
  for (const w of warnings) await postToSlack({ text: `Job Change Alert Bot: ${w}` });

  if (!changes.length) {
    console.log(`Digest ${today()}: no job changes ${period}.`);
    if (evenIfEmpty) await postToSlack({ text: `No job changes on your list ${period}.` });
    settings.set("last_digest_at", new Date().toISOString());
    return 0;
  }

  // Slack: one or more messages; a change counts as digested once the message holding it was accepted.
  const parts = digestMessages(changes, period);
  const delivered = new Set<string>();
  if (config.slackWebhookUrl) {
    for (const part of parts) {
      let result = await postToSlack(part.message);
      for (let retry = 0; !result.ok && result.status === 429 && retry < 3; retry++) {
        await new Promise(r => setTimeout(r, (result.retryAfterSeconds ?? 5) * 1000 + 500));
        result = await postToSlack(part.message);
      }
      if (!result.ok) break;
      part.ids.forEach(id => delivered.add(id));
      if (parts.length > 1) await new Promise(r => setTimeout(r, 1_100));
    }
  }
  const emailOk = await sendDigestEmail(changes, period);
  if (emailOk) changes.forEach(c => delivered.add(c.id));
  if (!config.slackWebhookUrl && !emailConfigured()) { console.log(parts[0]?.message.text); changes.forEach(c => delivered.add(c.id)); }
  if (!delivered.size) {
    console.error(`Digest ${today()}: no channel accepted it; the ${changes.length} change(s) will be included next time.`);
    return 0;
  }
  jobChanges.markDigested([...delivered]);
  settings.set("last_digest_at", new Date().toISOString());
  if (delivered.size < changes.length) console.warn(`Digest ${today()}: Slack stopped accepting part way; ${changes.length - delivered.size} change(s) will be included next time.`);
  console.log(`Digest ${today()}: sent ${delivered.size} job change(s).`);
  return delivered.size;
}

/** Warnings worth posting: a watch that is no longer active, or has not run for twice its interval. */
export async function watchWarnings(): Promise<string[]> {
  const warnings: string[] = [];
  const undelivered = config.alertMode === "digest" ? 0 : jobChanges.newlyUndelivered();
  if (undelivered) warnings.push(`${undelivered} alert(s) could not be posted to Slack for 2 days${config.alertMode === "realtime" ? "; run npm run changes to see them" : ", so they are only in this digest"}. Check that SLACK_WEBHOOK_URL and SLACK_ROUTES still work (npm run test-slack).`);
  for (const id of watchIds.get()) {
    try {
      const w = await getWatch(id);
      const advice = w.status === "suspended" ? "Top up your Crustdata credits, then run npm run resume."
        : w.status === "cancelled" || w.status === "expired" ? "Run npm run import to create a new one (new people are baselined silently)."
        : "Run npm run resume to restart it.";
      if (w.status !== "active") warnings.push(`watch ${id} is ${w.status}, so no job changes are being detected. ${advice}`);
      const every = w.config?.trigger?.every_hours ?? config.checkEveryHours;
      if (w.status === "active" && w.last_run_at && Date.now() - Date.parse(w.last_run_at) > 2 * every * 3600_000) warnings.push(`watch ${id} has not run since ${w.last_run_at}.`);
    } catch (err) {
      warnings.push(`could not check watch ${id}: ${(err as Error).message}`);
    }
  }
  return warnings;
}

/** Sends the digest once a day at or after `hourUtc`. Checks at startup and every minute; no cron dependency. */
export function scheduleDailyDigest(hourUtc: number): void {
  const tick = () => {
    try {
      const now = new Date();
      if (now.getUTCHours() < hourUtc || settings.get("last_digest_day") === today()) return;
      settings.set("last_digest_day", today());
      if (config.alertMode === "realtime") {
        // No digest, but still check the watches once a day so a suspended watch never fails silently.
        void watchWarnings().then(ws => Promise.all(ws.map(w => postToSlack({ text: `Job Change Alert Bot: ${w}` })))).catch(err => console.error("watch check failed:", err));
      } else {
        sendDigest().catch(err => console.error("digest failed:", err));
      }
    } catch (err) {
      console.error("digest check failed:", (err as Error).message);
    }
  };
  tick();
  setInterval(tick, 60_000);
  console.log(config.alertMode === "realtime" ? "Daily digest off (ALERT_MODE=realtime); watches are still checked daily." : `Daily digest scheduled for ${String(hourUtc).padStart(2, "0")}:00 UTC.`);
}
