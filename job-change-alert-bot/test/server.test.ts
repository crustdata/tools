// End to end through the HTTP app with an in-memory database and a fake Slack, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

process.env.DB_PATH = ":memory:";
process.env.CRUSTDATA_API_KEY = "testkey";
process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/fake";
process.env.ALERT_MODE = "both";

const posted: any[] = [];
let slackStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).startsWith("https://hooks.slack.com/")) { posted.push(JSON.parse(init.body)); return new Response("ok", { status: slackStatus }); }
  return realFetch(url, init);
}) as typeof fetch;

const { app } = await import("../src/server.js");
const { deliverPending } = await import("../src/handle.js");
const { sendDigest } = await import("../src/digest.js");
const { jobChanges } = await import("../src/store.js");

const settle = () => new Promise(r => setTimeout(r, 1_500)); // let the delivery the server starts after each webhook finish

const sign = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", "testkey").update(`${t}.${body}`).digest("hex")}`;
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const post = (body: string, headers: Record<string, string> = { "x-crustdata-signature": sign(body) }) =>
  app.request("/webhooks/crustdata", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

test("health check returns no personal data", async () => {
  const res = await app.request("/");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()).sort(), ["alertsReceived", "ok", "peopleWatched", "watches"]);
});

test("unsigned, badly signed, malformed and oversized webhooks are rejected", async () => {
  const body = fixture("job-change.json");
  assert.equal((await post(body, {})).status, 401);
  assert.equal((await post(body, { "x-crustdata-signature": sign(body + "x") })).status, 401);
  assert.equal((await post("[]")).status, 400);
  assert.equal((await post('{"metadata":null}')).status, 400);
  const big = JSON.stringify({ metadata: { watch_id: 1 }, pad: "x".repeat(6 * 1024 * 1024) });
  assert.equal((await post(big)).status, 413);
});

test("baseline and test notifications store nothing", async () => {
  for (const f of ["baseline.json", "test-notification.json"]) {
    const res = await post(fixture(f));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).stored, 0);
  }
});

test("a job change is stored once, delivered to Slack, and redeliveries are ignored", async () => {
  const body = fixture("job-change.json");
  posted.length = 0;
  assert.equal((await (await post(body)).json()).stored, 1);
  assert.equal((await (await post(body)).json()).duplicates, 1);
  await settle();
  await deliverPending();
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /Sherry Robinson moved to Northwind Analytics/);
});

test("title edits are stored but never alerted", async () => {
  posted.length = 0;
  await post(fixture("title-edit.json"));
  await settle();
  await deliverPending();
  assert.equal(posted.length, 0);
});

test("a Slack outage keeps the alert for a retry instead of losing it", async () => {
  slackStatus = 500;
  posted.length = 0;
  await post(fixture("promotion.json"));
  await settle();
  await deliverPending();
  assert.equal(posted.length, 1, "one attempt, then backoff");
  assert.equal(jobChanges.dueForSlack().length, 0, "not due again immediately (backoff)");
  slackStatus = 200;
});

test("the digest is only marked as sent when Slack accepts it", async () => {
  slackStatus = 500;
  assert.equal(await sendDigest(), 0);
  assert.ok(jobChanges.notYetDigested().length > 0);
  slackStatus = 200;
  assert.ok((await sendDigest()) > 0);
  assert.equal(jobChanges.notYetDigested().length, 0);
});
