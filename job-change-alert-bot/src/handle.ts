/**
 * What happens when a notification arrives, and how alerts reach Slack.
 *
 *   handleNotification  read the records, classify them, store them all in one transaction, remember new roles.
 *                       Fast, so Crustdata gets its 200 straight away. Sends nothing itself.
 *   deliverPending      the outbox: posts stored alerts to Slack one per second, retrying failures with backoff
 *                       (honouring Slack's Retry-After, at most every 6 hours) until the alert is two days old.
 */

import { config } from "./config.js";
import { isBaselineOrTest, parseNdjson, toJobChanges, type JobChange, type Notification, type WatchResult } from "./notification.js";
import { jobChanges, people, runsSeen, watchIds } from "./store.js";
import { getRunSummary, listRuns } from "./crustdata.js";
import { jobChangeMessage, postToSlack, webhookFor } from "./slack.js";

export type HandleResult = { stored: number; duplicates: number; ignored?: string };

/** Throws on a malformed body (the server answers 400). */
export function validateNotification(body: unknown): asserts body is Notification {
  const n = body as Notification;
  if (!n || typeof n !== "object" || Array.isArray(n)) throw new Error("body is not a JSON object");
  if (!n.metadata || typeof n.metadata !== "object") throw new Error("missing metadata");
  if (typeof n.metadata.watch_id !== "number") throw new Error("metadata.watch_id is not a number");
  if (n.results !== undefined && !Array.isArray(n.results)) throw new Error("results is not an array");
}

export async function handleNotification(n: Notification, { checkWatchId = true } = {}): Promise<HandleResult> {
  if (n.metadata.test) return { stored: 0, duplicates: 0, ignored: "test notification" };
  const ours = watchIds.get();
  if (checkWatchId && ours.length && !ours.includes(n.metadata.watch_id)) return { stored: 0, duplicates: 0, ignored: `watch ${n.metadata.watch_id} is not one of this bot's watches` };

  const results = await readResults(n);
  const seen = () => { if (n.metadata.run_id) runsSeen.add(n.metadata.watch_id, n.metadata.run_id); };
  if (!results.length || isBaselineOrTest({ ...n, results })) { seen(); return { stored: 0, duplicates: 0, ignored: "baseline run" }; }
  if ((n.metadata as any).summary?.truncated) console.warn(`Watch ${n.metadata.watch_id} run ${n.metadata.run_id} was truncated by max_results_per_run; some changes were not delivered.`);

  const runKey = n.metadata.run_id ?? (n.metadata as any).notification_id;
  const changes = toJobChanges(n.metadata.watch_id, runKey, results, (personId, profileUrl) => {
    const known = people.find(personId, profileUrl);
    return known ? { title: known.title ?? undefined, company: known.company ?? undefined, companyId: known.company_id ?? undefined } : undefined;
  }).map(c => {
    const person = people.find(c.crustdataPersonId, c.profileUrl);
    if (person && c.crustdataPersonId) people.linkPersonId(person.profile_url, c.crustdataPersonId);
    return { ...c, owner: person?.owner ?? undefined, name: c.name ?? person?.name ?? undefined };
  });

  const stored = jobChanges.insertMany(changes, c => config.alertKinds.includes(c.kind));
  seen(); // only after storing, so a failed insert is retried by catch-up
  for (const c of changes) rememberRole(c);
  return { stored, duplicates: changes.length - stored };
}

/** So the person's next move shows the right "Was". */
function rememberRole(c: JobChange): void {
  if (c.kind === "new_company" || c.kind === "title_change") people.updateRole(c.profileUrl, c.crustdataPersonId, { title: c.newTitle, company: c.newCompany, companyId: c.newCompanyId });
  if (c.kind === "left_company") people.updateRole(c.profileUrl, c.crustdataPersonId, {});
}

/** Inline runs carry `results`; runs delivered as a link carry a signed S3 URL to an NDJSON file instead. */
async function readResults(n: Notification): Promise<WatchResult[]> {
  const delivery = n.metadata.payload_delivery;
  if (delivery?.type !== "link" || !delivery.url) return n.results ?? [];
  return downloadRecords(delivery.url);
}

/** Downloads a run's NDJSON file. Only https files on Amazon S3 are fetched. */
async function downloadRecords(link: string): Promise<WatchResult[]> {
  const url = new URL(link);
  if (url.protocol !== "https:" || !/(^|\.)amazonaws\.com$/.test(url.hostname)) throw new Error(`refusing to download run file from ${url.hostname}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`could not download run file (${res.status})`);
  return parseNdjson(await res.text());
}

let delivering = false;
let rerunRequested = false;
/** Slack rate limits apply per webhook, so a 429 pauses every alert for that webhook, not just one. */
const pausedUntil = new Map<string, number>();

/** Posts due alerts to Slack. Safe to call often; only one run at a time; never throws. */
export async function deliverPending(): Promise<number> {
  if (config.alertMode === "digest") return 0;
  if (delivering) { rerunRequested = true; return 0; }
  delivering = true;
  let sent = 0;
  try {
    // Keep going until nothing is due: alerts stored while this loop runs are picked up too.
    // A failed or paused alert is skipped until its time comes, so this always ends.
    const skipped = new Set<string>();
    for (let batch = jobChanges.dueForSlack(50); batch.length; batch = jobChanges.dueForSlack(50, [...skipped])) {
      for (const change of batch) {
        const url = webhookFor(change.owner);
        if ((pausedUntil.get(url) ?? 0) > Date.now()) { skipped.add(change.id); continue; }
        const result = await postToSlack(jobChangeMessage(change), url);
        if (result.ok) {
          jobChanges.markSentToSlack(change.id);
          if (config.alertMode === "realtime") jobChanges.markDigested([change.id]);
          sent++;
        } else if (result.status === 429) {
          const waitMs = (result.retryAfterSeconds ?? 30) * 1000;
          pausedUntil.set(url, Date.now() + waitMs);
          setTimeout(() => void deliverPending(), waitMs + 200).unref(); // pick up again as soon as Slack allows
          skipped.add(change.id);
        } else {
          if (result.status && [403, 404, 410].includes(result.status)) console.error(`Slack says the webhook${change.owner ? ` for ${change.owner}` : ""} no longer exists (${result.status}). Create a new one and update .env; alerts are retried for 2 days.`);
          jobChanges.markSlackFailed(change.id, Math.min(60 * 2 ** change.slackAttempts, 6 * 3600));
          skipped.add(change.id);
        }
        await new Promise(r => setTimeout(r, 1_100)); // Slack allows about one message per second per webhook
      }
    }
  } catch (err) {
    console.error(`Slack delivery paused: ${(err as Error).message}. It will retry shortly.`);
  } finally {
    delivering = false;
  }
  if (rerunRequested) { rerunRequested = false; sent += await deliverPending(); }
  return sent;
}

/**
 * Catch-up: Crustdata records every run, including whether delivery to this server worked. Runs with changes whose
 * delivery failed (server down, asleep, or an old tunnel URL) are downloaded from the run history and handled now,
 * so no change is lost. Safe to run often; each run is handled once.
 */
export async function catchUpMissedRuns({ deliver = true } = {}): Promise<{ runs: number; changes: number }> {
  let recovered = 0;
  let runsHandled = 0;
  for (const watchId of watchIds.get()) {
    try {
      const runs = await missedRuns(watchId);
      for (const run of runs.reverse()) {
        try {
          const results = await runResults(watchId, run.id);
          if (!results) { console.warn(`Run ${run.id} of watch ${watchId} had no readable records; skipped.`); runsSeen.add(watchId, run.id); continue; }
          const result = await handleNotification({ metadata: { watch_id: watchId, run_id: run.id }, results }, { checkWatchId: false });
          runsSeen.add(watchId, run.id);
          runsHandled++;
          recovered += result.stored;
          console.log(`Recovered watch ${watchId} run ${run.id} (delivery had failed): ${result.stored} new change(s).`);
        } catch (err) {
          console.warn(`Could not recover run ${run.id} of watch ${watchId}: ${(err as Error).message}. Will try again later.`);
        }
      }
    } catch (err) {
      console.warn(`Could not read run history for watch ${watchId}: ${(err as Error).message}`);
    }
  }
  if (recovered && deliver) void deliverPending();
  return { runs: runsHandled, changes: recovered };
}

/** Runs with changes whose delivery did not get a 2xx and that were never handled, newest first, paging back about 30 days. */
async function missedRuns(watchId: number): Promise<any[]> {
  const missed: any[] = [];
  const cutoff = Date.now() - 30 * 86_400_000;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const { runs, next_cursor } = await listRuns(watchId, 25, cursor);
    for (const r of runs ?? []) {
      if (r.status === "SUCCESS" && (r.new_records_count ?? 0) > 0 && !(r.notification_http_status >= 200 && r.notification_http_status < 300) && !runsSeen.has(watchId, r.id)) missed.push(r);
    }
    const oldest = runs?.at(-1)?.started_at ? Date.parse(runs.at(-1).started_at) : 0;
    if (!next_cursor || !runs?.length || oldest < cutoff) break;
    cursor = next_cursor;
  }
  return missed;
}

/**
 * A run's records. The live API returns `records_download.url` (an NDJSON file); the docs also describe
 * `payload_delivery.url` for link watches and an inline `notifications[].payload.notifications[]` list. All three are read.
 */
async function runResults(watchId: number, runId: number): Promise<WatchResult[] | undefined> {
  const summary: any = await getRunSummary(watchId, runId);
  const link = summary?.records_download?.url ?? summary?.payload_delivery?.url;
  if (link) return downloadRecords(link);
  const inline = (summary?.notifications ?? []).flatMap((n: any) => n?.payload?.notifications ?? n?.payload?.results ?? []);
  if (!inline.length) return undefined;
  const byUid = new Map<string, WatchResult>();
  for (const r of inline) byUid.set(r.uid ?? JSON.stringify(r.record ?? r), { changes: r.changes ?? [], record: r.record ?? {} });
  return [...byUid.values()];
}
