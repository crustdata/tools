// Catch-up reads every run summary format Crustdata uses, and one bad run never blocks the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.DB_PATH = ":memory:";
process.env.CRUSTDATA_API_KEY = "testkey";
process.env.SLACK_WEBHOOK_URL = "";
process.env.ALERT_MODE = "digest";

const job = JSON.parse(readFileSync(new URL("../fixtures/job-change.json", import.meta.url), "utf8"));
const promo = JSON.parse(readFileSync(new URL("../fixtures/promotion.json", import.meta.url), "utf8"));
const runs = [
  { id: 801, status: "SUCCESS", new_records_count: 1, notification_http_status: 500, started_at: new Date().toISOString() },  // inline payload (docs)
  { id: 802, status: "SUCCESS", new_records_count: 1, notification_http_status: null, started_at: new Date().toISOString() }, // link via payload_delivery (docs)
  { id: 803, status: "SUCCESS", new_records_count: 1, notification_http_status: 502, started_at: new Date().toISOString() },  // broken: summary fails
];
globalThis.fetch = (async (input: any) => {
  const url = String(input);
  if (url.includes("/watch/person/9/runs/801/summary")) return Response.json({ id: 801, notifications: [{ payload: { notifications: job.results.map((r: any) => ({ uid: "u1", ...r })) } }] });
  if (url.includes("/watch/person/9/runs/802/summary")) return Response.json({ id: 802, payload_delivery: { type: "link", url: "https://bucket.s3.amazonaws.com/802.ndjson" } });
  if (url.includes("/watch/person/9/runs/803/summary")) return new Response("boom", { status: 404 });
  if (url.includes("/watch/person/9/runs")) return Response.json({ runs, next_cursor: null });
  if (url.includes("/watch/person/8/runs")) return new Response("gone", { status: 404 });
  if (url === "https://bucket.s3.amazonaws.com/802.ndjson") return new Response(`${JSON.stringify(promo.results[0])}\n{not json\n`);
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const { watchIds } = await import("../src/store.js");
const { catchUpMissedRuns } = await import("../src/handle.js");

test("inline and linked run summaries are both recovered; a broken run and a broken watch are skipped, not fatal", async () => {
  watchIds.set([8, 9]);
  const first = await catchUpMissedRuns({ deliver: false });
  assert.deepEqual(first, { runs: 2, changes: 2 });
  const second = await catchUpMissedRuns({ deliver: false });
  assert.deepEqual(second, { runs: 0, changes: 0 }, "recovered runs are not handled again; the broken one is retried next time without blocking");
});
