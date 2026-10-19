// Slack outbox and catch-up, with an in-memory database and stubbed Slack and Crustdata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.DB_PATH = ":memory:";
process.env.CRUSTDATA_API_KEY = "testkey";
process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/default";
process.env.SLACK_ROUTES = JSON.stringify({ "Busy Rep": "https://hooks.slack.com/services/T/B/busy" });
process.env.ALERT_MODE = "realtime";

const posts: { url: string; text: string }[] = [];
const job = readFileSync(new URL("../fixtures/job-change.json", import.meta.url), "utf8");
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url === "https://hooks.slack.com/services/T/B/busy") return new Response("rate_limited", { status: 429, headers: { "retry-after": "60" } });
  if (url.startsWith("https://hooks.slack.com/")) { posts.push({ url, text: JSON.parse(init.body).text }); return new Response("ok"); }
  if (url.includes("/watch/person/50991/runs/700/summary")) return Response.json({ id: 700, records_download: { url: "https://bucket.s3.amazonaws.com/run-700.ndjson" } });
  if (url.includes("/watch/person/50991/runs")) return Response.json({ runs: [
    { id: 700, status: "SUCCESS", new_records_count: 1, notification_http_status: 503 },
    { id: 699, status: "SUCCESS", new_records_count: 1, notification_http_status: 200 },
  ] });
  if (url === "https://bucket.s3.amazonaws.com/run-700.ndjson") return new Response(JSON.parse(job).results.map((r: unknown) => JSON.stringify(r)).join("\n"));
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const { people, watchIds, jobChanges } = await import("../src/store.js");
const { catchUpMissedRuns, deliverPending, handleNotification } = await import("../src/handle.js");
const { toJobChanges } = await import("../src/notification.js");

test("a rate-limited rep's channel does not hold back anyone else's alerts", async () => {
  // 60 alerts for the busy rep, then one for someone with no route.
  for (let i = 0; i < 60; i++) people.upsert({ profile_url: `https://www.example.com/in/busy-${i}`, crustdata_person_id: 1000 + i, owner: "Busy Rep" });
  const busy = Array.from({ length: 60 }, (_, i) => ({ ...toJobChanges(1, 1, JSON.parse(job).results)[0], id: `busy:${i}`, crustdataPersonId: 1000 + i, owner: "Busy Rep" }));
  const free = { ...busy[0], id: "free:1", owner: undefined, name: "Free Person" };
  jobChanges.insertMany([...busy, free], () => true);
  await deliverPending();
  assert.equal(posts.length, 1, "the unrouted alert went out");
  assert.equal(posts[0].url, "https://hooks.slack.com/services/T/B/default");
});

test("catch-up recovers a run whose delivery failed, exactly once", async () => {
  watchIds.set([50991]);
  assert.deepEqual(await catchUpMissedRuns(), { runs: 1, changes: 1 });
  assert.deepEqual(await catchUpMissedRuns(), { runs: 0, changes: 0 }, "the run is not processed twice");
});

test("a run delivered normally is never re-processed by catch-up", async () => {
  await handleNotification(JSON.parse(job));
  assert.deepEqual(await catchUpMissedRuns(), { runs: 0, changes: 0 });
});
