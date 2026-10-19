/**
 * The always-on part: receives Crustdata webhooks, delivers alerts to Slack and sends the daily digest.
 * Start with `npm run serve`.
 *
 *   POST /webhooks/crustdata   signed notifications from the watch (5 MB limit)
 *   GET  /                     health check; returns no personal data
 */

import "./node-check.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { config, configProblems, webhookUrl, WEBHOOK_PATH } from "./config.js";
import { setWatchDelivery, signatureProblem, getWatch } from "./crustdata.js";
import { catchUpMissedRuns, deliverPending, handleNotification, validateNotification } from "./handle.js";
import { scheduleDailyDigest } from "./digest.js";
import { jobChanges, people, settings, watchIds } from "./store.js";

export const app = new Hono();

app.get("/", c => c.json({ ok: true, watches: watchIds.get().length, peopleWatched: people.count(), alertsReceived: jobChanges.count() }));

app.post(
  WEBHOOK_PATH,
  async (c, next) => (c.req.header("x-crustdata-signature") || config.allowUnsignedWebhooks ? next() : c.json({ error: "missing signature" }, 401)),
  bodyLimit({ maxSize: 5 * 1024 * 1024, onError: c => c.json({ error: "body too large" }, 413) }),
  async c => {
    const rawBody = await c.req.text();
    const problem = signatureProblem(c.req.header("x-crustdata-signature"), rawBody, config.crustdataApiKey);
    if (problem && !config.allowUnsignedWebhooks) {
      console.warn(`Rejected a webhook: ${problem}.`);
      return c.json({ error: "invalid signature" }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
      validateNotification(body);
    } catch (err) {
      console.warn(`Rejected a webhook: ${(err as Error).message}.`);
      return c.json({ error: (err as Error).message }, 400);
    }

    try {
      const result = await handleNotification(body);
      const label = `Watch ${body.metadata.watch_id}${body.metadata.run_id ? ` run ${body.metadata.run_id}` : ""}`;
      console.log(result.ignored ? `${label}: ${result.ignored}, nothing to do.` : `${label}: ${result.stored} new change(s), ${result.duplicates} duplicate(s).`);
      void deliverPending();
      return c.json({ ok: true, ...result });
    } catch (err) {
      console.error(`Could not process a notification: ${(err as Error).message}`);
      return c.json({ error: "processing failed" }, 500);
    }
  },
);

/** If PUBLIC_URL changed since the watches were created (a new tunnel, a new host), point them at the new URL. */
async function syncDeliveryUrl(): Promise<void> {
  if (!config.publicUrl || settings.get("delivery_url") === webhookUrl()) return;
  for (const id of watchIds.get()) {
    try {
      const w = await getWatch(id);
      if (!w.notifications?.some(n => n.type === "webhook" && n.url === webhookUrl())) { await setWatchDelivery(w, webhookUrl()); console.log(`Watch ${id} now delivers to ${webhookUrl()}.`); }
    } catch (err) {
      console.warn(`Could not update watch ${id}'s delivery URL: ${(err as Error).message}`);
      return;
    }
  }
  if (watchIds.get().length) settings.set("delivery_url", webhookUrl());
}

if (process.argv[1]?.endsWith("server.ts")) {
  const problems = configProblems();
  if (problems.length) { console.error(["Fix these settings in .env first:", ...problems.map(p => `  - ${p}`)].join("\n")); process.exit(1); }
  try { config.crustdataApiKey; } catch (err) { console.error((err as Error).message); process.exit(1); }

  const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
    console.log(`Job Change Alert Bot listening on port ${port}.`);
    console.log(config.publicUrl ? `Crustdata delivers to ${webhookUrl()}` : "PUBLIC_URL is not set: run npm run setup before npm run import.");
    if (!config.slackWebhookUrl) console.log("SLACK_WEBHOOK_URL is not set: alerts will print here instead of Slack.");
    scheduleDailyDigest(config.digestHourUtc);
    void syncDeliveryUrl();
    setInterval(() => void deliverPending(), 30_000); // deliverPending catches its own errors
    // Recover changes Crustdata could not deliver while the server was down: at startup, then every 6 hours.
    const catchUp = () => catchUpMissedRuns().catch(err => console.warn(`Catch-up skipped: ${(err as Error).message}`));
    setTimeout(catchUp, 10_000);
    setInterval(catchUp, 6 * 3600_000);
  });
  const stop = () => { console.log("Shutting down."); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5_000).unref(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${config.port} is already in use. Set PORT in .env to a free port, for example PORT=3456.` : err.message);
    process.exit(1);
  });
}
