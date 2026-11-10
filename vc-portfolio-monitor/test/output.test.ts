import assert from "node:assert/strict";
import { test } from "node:test";

// Settings are read once when config loads, so set them before importing anything that uses it.
process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/main";
process.env.SLACK_ROUTES = JSON.stringify({ "priya shah": "https://hooks.slack.com/services/T000/B000/priya" });
process.env.FUND_NAME = "Example Ventures";
const { resolve } = await import("node:path");
const { fixtureApi, loadFixture, storeFromFixture } = await import("../src/fixture-api.js");
const { runCheck, runDigest } = await import("../src/run.js");
const { sendAlerts } = await import("../src/deliver.js");
const { alertMessages, digestMessages, esc, signalLine } = await import("../src/slack.js");
const { digestHtml } = await import("../src/email.js");
const { digestMarkdown } = await import("../src/digest.js");
const { DEFAULT_THRESHOLDS } = await import("../src/thresholds.js");
const { quoteEnv, parseEnv, renderEnv, slackProblem } = await import("../src/setup.js");

const fixture = (name: string) => loadFixture(resolve(import.meta.dirname, "..", "fixtures", `${name}.json`));

test("alerts go to the owner's channel when there is a route, else the main channel; posted once", async () => {
  const f = fixture("busy-week");
  const store = storeFromFixture(f);
  await runCheck({ store, api: fixtureApi(f), thresholds: DEFAULT_THRESHOLDS, now: new Date(f.now!) });
  const posts: { url: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => { posts.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("ok"); }) as typeof fetch;
  try {
    const r = await sendAlerts(store);
    assert.equal(r.problems.length, 0);
    const priya = posts.filter(p => p.url.endsWith("/priya")).map(p => JSON.stringify(p.body));
    const main = posts.filter(p => p.url.endsWith("/main")).map(p => JSON.stringify(p.body));
    assert.ok(priya.join().includes("Northwind Robotics") && priya.join().includes("Tallyhoo"));
    assert.ok(main.join().includes("Brightwave") && !main.join().includes("Northwind"));
    // News-only items wait for the digest.
    assert.ok(!main.join().includes("Ten developer tools"));
    posts.length = 0;
    assert.equal((await sendAlerts(store)).posted, 0);
    assert.equal(posts.length, 0);
  } finally { globalThis.fetch = original; }
});

test("a failed Slack post keeps the alerts for the next run", async () => {
  const f = fixture("busy-week");
  const store = storeFromFixture(f);
  await runCheck({ store, api: fixtureApi(f), thresholds: DEFAULT_THRESHOLDS, now: new Date(f.now!) });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no_service", { status: 404 })) as unknown as typeof fetch;
  try {
    const r = await sendAlerts(store);
    assert.equal(r.posted, 0);
    assert.match(r.problems[0], /no longer exists/);
    assert.ok(store.unposted().length > 0);
  } finally { globalThis.fetch = original; }
});

test("outside text cannot ping a channel or plant a link, in Slack, email or markdown", async () => {
  const f = fixture("edge-cases");
  const store = storeFromFixture(f);
  const ctx = { store, api: fixtureApi(f), thresholds: DEFAULT_THRESHOLDS, now: new Date(f.now!) };
  await runCheck(ctx);
  const d = await runDigest(ctx);
  const slack = JSON.stringify(digestMessages(d.digest));
  assert.ok(!slack.includes("<!channel>") && slack.includes("&lt;!channel&gt;"));
  assert.ok(!slack.includes("<https://evil.example"));
  const html = digestHtml(d.digest);
  assert.ok(!html.includes("<!channel>") && !html.includes('href="https://evil.example'));
  assert.ok(!/[^\\]<https:\/\/evil/.test(digestMarkdown(d.digest))); // shown as text, never a link
  assert.equal(esc("<!here> & <@U1>"), "&lt;!here&gt; &amp; &lt;@U1&gt;");
});

test("Slack messages stay under the block and section limits for a large portfolio", () => {
  const signals = Array.from({ length: 400 }, (_, i) => ({ key: `k${i}`, domain: `c${i % 120}.example`, company: `Company ${i % 120}`, kind: "news" as const, severity: "alert" as const, text: "x".repeat(300), url: "https://news.example/a" }));
  const msgs = alertMessages(signals);
  assert.ok(msgs.length > 1);
  for (const m of msgs) {
    assert.ok((m.blocks as any[]).length <= 50);
    for (const b of m.blocks as any[]) if (b.text?.text) assert.ok(b.text.text.length <= 3000);
  }
  assert.match(signalLine(signals[0]), /^• \*Alert:\*/);
});

test("setup helpers: .env values round-trip through Node's reader; webhook URLs are checked", () => {
  const values = { CRUSTDATA_API_KEY: "abc'def", SLACK_ROUTES: JSON.stringify({ "Priya Shah": "https://hooks.slack.com/services/T1/B1/x" }), PORTFOLIO: "https://docs.google.com/spreadsheets/d/x/edit#gid=0" };
  const text = renderEnv(values, { KEEP_ME: "yes", EMPTY: "" });
  const back = parseEnv(text);
  assert.equal(back.CRUSTDATA_API_KEY, "abc'def");
  assert.deepEqual(JSON.parse(back.SLACK_ROUTES), { "Priya Shah": "https://hooks.slack.com/services/T1/B1/x" });
  assert.equal(back.PORTFOLIO, values.PORTFOLIO);
  assert.equal(back.KEEP_ME, "yes");
  assert.ok(!("EMPTY" in back));
  assert.equal(quoteEnv("a\nb"), "'a b'");
  assert.equal(slackProblem("https://hooks.slack.com/services/T0123/B0456/abcDEF123"), null);
  assert.ok(slackProblem("http://hooks.slack.com/services/x"));
});

test("a company with two owners goes to both channels; a dead owner webhook falls back to the main channel", async () => {
  const { Store } = await import("../src/store.js");
  const store = new Store(":memory:");
  store.saveCompany({ domain: "a.example", name: "A", companyId: 1, owner: "Priya Shah, Sam Lee", hiringSource: "none", addedAt: "2026-10-01T00:00:00Z" });
  store.addSignal({ key: "k1", domain: "a.example", company: "A", kind: "headcount_down", severity: "alert", text: "Headcount down" });
  const posts: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { posts.push(String(url).split("/").pop()!); return String(url).endsWith("/priya") ? new Response("no_service", { status: 404 }) : new Response("ok"); }) as typeof fetch;
  try {
    const r = await sendAlerts(store);
    assert.deepEqual(r.problems, []);
    assert.match(r.warnings[0], /go to the main channel/);
    assert.ok(posts.includes("main"));
    assert.equal(store.unposted().length, 0);
  } finally { globalThis.fetch = original; }
});

test("a post that fails on its second message resends only what did not arrive", async () => {
  const { Store } = await import("../src/store.js");
  const store = new Store(":memory:");
  for (let i = 0; i < 60; i++) {
    store.saveCompany({ domain: `c${i}.example`, name: `C${i}`, companyId: i + 1, hiringSource: "none", addedAt: "2026-10-01T00:00:00Z" });
    store.addSignal({ key: `k${i}`, domain: `c${i}.example`, company: `C${i}`, kind: "headcount_down", severity: "alert", text: `Headcount down (${i})` });
  }
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => (++n === 2 ? new Response("bad", { status: 400 }) : new Response("ok"))) as unknown as typeof fetch;
  try {
    await sendAlerts(store);
    const left = store.unposted().length;
    assert.ok(left > 0 && left < 60, `left ${left}`);
  } finally { globalThis.fetch = original; }
});

test("round 3: a dead owner channel plus an owner without a route reaches the main channel once", async () => {
  const { Store } = await import("../src/store.js");
  const store = new Store(":memory:");
  store.saveCompany({ domain: "a.example", name: "A", companyId: 1, owner: "Priya Shah, Nobody", hiringSource: "none", addedAt: "2026-10-01T00:00:00Z" });
  store.addSignal({ key: "k1", domain: "a.example", company: "A", kind: "headcount_down", severity: "alert", text: "Headcount down" });
  const posts: { to: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => { posts.push({ to: String(url).split("/").pop()!, body: JSON.parse(init.body) }); return String(url).endsWith("/priya") ? new Response("channel_is_archived", { status: 410 }) : new Response("ok"); }) as typeof fetch;
  try {
    await sendAlerts(store);
    const mainAlerts = posts.filter(p => p.to === "main" && JSON.stringify(p.body).includes("Headcount down"));
    assert.equal(mainAlerts.length, 1);
    assert.ok(posts.every(p => !("signalIds" in p.body)));
    assert.equal(store.unposted().length, 0);
    posts.length = 0;
    await sendAlerts(store);
    assert.equal(posts.length, 0);
  } finally { globalThis.fetch = original; }
});
