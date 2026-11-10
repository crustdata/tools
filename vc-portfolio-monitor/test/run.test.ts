import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { fixtureApi, loadFixture, storeFromFixture, type Fixture } from "../src/fixture-api.js";
import { readPortfolioCsv } from "../src/portfolio.js";
import { ensureWatches, estimateImport, importPortfolio, pickByName, planImport, runCheck, runDigest } from "../src/run.js";
import { Store } from "../src/store.js";
import { DEFAULT_THRESHOLDS } from "../src/thresholds.js";

const fixture = (name: string) => loadFixture(resolve(import.meta.dirname, "..", "fixtures", `${name}.json`));
const ctxFor = (f: Fixture, store = storeFromFixture(f)) => ({ store, api: fixtureApi(f), thresholds: DEFAULT_THRESHOLDS, now: new Date(f.now ?? "2026-10-26T07:00:00Z") });

test("busy week: every rule fires once, the six-person company does not, runs are marked read", async () => {
  const ctx = ctxFor(fixture("busy-week"));
  const r = await runCheck(ctx);
  const got = r.signals.map(s => `${s.domain} ${s.kind} ${s.severity}`).sort();
  assert.deepEqual(got, [
    "brightwave.example hiring_jump good", "brightwave.example round good",
    "northwind.example headcount_down alert", "northwind.example leader_left alert", "northwind.example team_down alert",
    "quillstack.example ceo_changed alert", "quillstack.example news news",
    "tallyhoo.example bad_news alert", "tallyhoo.example hiring_stopped alert",
  ]);
  assert.equal(r.watcherCredits, 35);
  assert.equal(r.creditsUsed, 4); // four careers pages
  // The founder who left is recorded as gone but stays watched for 60 days, so a return (or a profile glitch undone) is seen.
  const dana = ctx.store.leaders("northwind.example", { all: true }).find(l => l.name === "Dana Doe")!;
  assert.equal(dana.status, "left");
  assert.ok(ctx.store.watchedProfileUrls(ctx.now).includes("https://www.profiles.example/in/example-dana-doe"));
  assert.ok(!ctx.store.watchedProfileUrls(new Date("2027-01-15T00:00:00Z")).includes("https://www.profiles.example/in/example-dana-doe"));
  // The round line links the article; the article itself waits for the digest.
  assert.equal(r.signals.find(s => s.kind === "round")!.url, "https://news.example/brightwave-series-a");
  // A second check finds nothing new: runs were read, signals are keyed, hiring is not due again.
  const again = await runCheck(ctx);
  assert.deepEqual(again.signals, []);
  assert.equal(again.creditsUsed, 0);
});

test("after a headcount alert the window restarts, so the same drop is not reported twice; a small move keeps adding up", async () => {
  const ctx = ctxFor(fixture("busy-week"));
  await runCheck(ctx, { hiring: "skip" });
  assert.equal(ctx.store.getMeta("hc_alert_at:northwind.example"), ctx.now.toISOString());
  // Fernhill (6 to 5) fired nothing: its window still starts at 6, so a further drop to 4 alerts.
  assert.equal(ctx.store.getMeta("hc_alert_at:fernhill.example"), undefined);
  const { companySignals } = await import("../src/run.js");
  const rec = (total: number) => ({ changes: [{ field: "headcount.total", type: "changed" }], record: { crustdata_company_id: 106, headcount: { total } } });
  assert.deepEqual(companySignals(ctx.store, rec(4), DEFAULT_THRESHOLDS, "2026-11-02T07:00:00.000Z").map(s => s.text), ["Headcount down 33% since Sep 28, 2026, from 6 to 4 (2 people fewer)"]);
  assert.deepEqual(companySignals(ctx.store, rec(41), DEFAULT_THRESHOLDS, "2026-11-02T07:00:00.000Z").filter(s => s.domain === "northwind.example"), []);
});

test("a dry run saves nothing", async () => {
  const ctx = ctxFor(fixture("busy-week"));
  const r = await runCheck(ctx, { dryRun: true });
  assert.ok(r.signals.length > 5);
  assert.equal(ctx.store.counts().signals, 0);
  assert.equal(ctx.store.seenRunIds("company").size, 0);
  assert.equal(ctx.store.readings("brightwave.example").length, 4);
});

test("edge cases: nothing fires that should not", async () => {
  const ctx = ctxFor(fixture("edge-cases"));
  const r = await runCheck(ctx);
  const got = r.signals.map(s => `${s.domain} ${s.kind}`).sort();
  assert.deepEqual(got, [
    "alderpoint.example hiring_started",
    "birchline.example news", "birchline.example news", "birchline.example news",
    "cobaltfox.example leader_stepped_back", "cobaltfox.example round", "dunmore.example acquired",
  ]);
  assert.equal(r.warnings.filter(w => /careers page/.test(w)).length, 2);
  // The same article with a tracking parameter is stored once.
  assert.equal(r.signals.filter(s => /top workplace/.test(s.text)).length, 1);
  // Ian Koe's record (a different person id, a country subdomain URL) still matched him: no event, still watched.
  assert.ok(ctx.store.watchedProfileUrls().includes("https://www.profiles.example/in/example-ian-koe"));
});

test("watcher problems become plain warnings", async () => {
  const f = fixture("quiet-week");
  f.api!.watchInfo = { company: { status: "suspended" } };
  f.api!.deletedWatches = ["person"];
  const r = await runCheck(ctxFor(f), { hiring: "skip" });
  assert.ok(r.warnings.some(w => /suspended, usually because the account ran out of credits/.test(w)));
  assert.ok(r.warnings.some(w => /leader watcher was deleted outside this tool/.test(w)));
});

test("digest: groups by company, alerts first, quiet companies on one line, credits since the last digest", async () => {
  const ctx = ctxFor(fixture("busy-week"));
  await runCheck(ctx);
  const d = await runDigest({ ...ctx, now: new Date("2026-10-26T08:00:00Z") });
  assert.equal(d.digest.companies[0].name, "Northwind Robotics");
  assert.deepEqual(d.digest.quiet, ["Fernhill Bio", "Mossgrove"]);
  assert.deepEqual(d.digest.credits, { own: 4, watchers: 35 });
  // Everything went into this digest; the next one starts empty.
  const next = await runDigest({ ...ctx, now: new Date("2026-11-02T08:00:00Z") });
  assert.equal(next.digest.companies.length, 0);
});

test("first digest shows each company's starting point", async () => {
  const ctx = ctxFor(fixture("first-run"));
  await runCheck(ctx);
  const d = await runDigest(ctx);
  assert.equal(d.digest.firstDigest, true);
  assert.equal(d.digest.companies.length, 4);
  assert.ok(d.digest.companies.every(c => c.start));
  assert.equal(d.digest.companies[0].name, "Tallyhoo"); // the one with an alert
});

// ---------------------------------------------------------------- import

const importFixture = (): Fixture => ({
  now: "2026-10-26T07:00:00Z",
  api: {
    identify: {
      domains: { "northwind.example": [{ id: 101, name: "Northwind Robotics", domain: "northwind.example", confidence: 1 }], "ghost.example": [] },
      names: {
        Linear: [{ id: 1, name: "Linear", domain: "linear.example", confidence: 1 }, { id: 2, name: "linear", domain: "lineardesign.example", confidence: 1 }, { id: 3, name: "Linear", domain: "linear.fi.example", confidence: 1 }],
        Brightwave: [{ id: 102, name: "Brightwave", domain: "brightwave.example", confidence: 1 }, { id: 9, name: "Brightwave Ltd", domain: "bw.example", confidence: 0.8 }],
      },
    },
    enrich: {
      "101": { crustdata_company_id: 101, headcount: { total: 48, growth_absolute: { six_months: 4 }, growth_percent: { six_months: 9 } } },
      "102": { crustdata_company_id: 102, headcount: { total: 22, growth_absolute: { six_months: -6 }, growth_percent: { six_months: -21 } } },
    },
    leaders: {
      "101": [{ personId: 1, name: "Dana Doe", title: "Co-Founder & CTO", profileUrl: "https://www.profiles.example/in/example-dana-doe" }, { personId: 2, name: "Zed", title: "Chief of Staff", profileUrl: "https://www.profiles.example/in/example-zed" }],
      "102": [],
    },
    people: { "https://www.profiles.example/in/example-ana": { personId: 3, name: "Ana Moe", current: [{ title: "Founder & CEO", name: "Brightwave", crustdata_company_id: 102 }] } },
    pages: { "https://northwind.example/careers": { success: false }, "https://northwind.example/jobs": { roles: 7 }, "https://brightwave.example/careers": { content: "<html><head><title>Careers</title></head><body><p>No open roles right now, check back soon please.</p></body></html>" } },
    jobIndex: { "102": 1 },
  },
});
const csv = "company,website,owner,leaders\nNorthwind Robotics,northwind.example,Priya Shah,\nLinear,,Sam Lee,\nBrightwave,,Sam Lee,https://www.profiles.example/in/example-ana\nGhost,ghost.example,,\n";

test("pickByName takes one clear match only", () => {
  const m = (name: string, confidence: number, domain?: string) => ({ id: 1, name, domain, confidence });
  assert.equal(pickByName("Cal.com", [m("Cal.com", 1, "cal.example"), m("Cal Com Systems", 0.8, "x.example")]).match?.domain, "cal.example");
  assert.equal(pickByName("Linear", [m("Linear", 1, "a.example"), m("Linear", 1, "b.example")]).match, undefined);
  assert.equal(pickByName("Acme", [m("Acme", 1)]).match, undefined); // no website to watch
});

test("import: resolves, asks about the right things, costs what it said, sets up both watchers", async () => {
  const f = importFixture();
  const ctx = { ...ctxFor(f, new Store(":memory:")) };
  const plan = await planImport(ctx, readPortfolioCsv(csv));
  assert.deepEqual(plan.add.map(r => r.domain), ["northwind.example", "brightwave.example"]);
  assert.deepEqual(plan.unresolved.map(u => u.row.name ?? u.row.domain), ["Ghost", "Linear"]);
  assert.deepEqual(plan.unresolved[1].candidates, ["linear.example", "lineardesign.example", "linear.fi.example"]);
  const est = estimateImport(plan);
  const result = await importPortfolio(ctx, plan);
  assert.ok(result.creditsUsed <= est.total, `${result.creditsUsed} <= ${est.total}`);
  // Chief of Staff is not a leader; the listed founder is added by profile URL.
  assert.deepEqual(ctx.store.watchedProfileUrls(), ["https://www.profiles.example/in/example-ana", "https://www.profiles.example/in/example-dana-doe"]);
  // /careers failed, /jobs listed 7 roles; Brightwave's page lists none and the index has 1, so its page is used.
  assert.equal(ctx.store.company("northwind.example")!.careersUrl, "https://northwind.example/jobs");
  assert.equal(ctx.store.readings("northwind.example")[0].roles, 7);
  assert.equal(ctx.store.company("brightwave.example")!.hiringSource, "careers");
  assert.ok(result.notes.some(n => /Brightwave: no open roles found/.test(n)));
  // Brightwave was already down 21% (6 people) over 6 months: flagged as a starting-point alert.
  assert.match(result.starting.find(s => s.domain === "brightwave.example")!.flag!.text, /from 28 to 22/);
  assert.deepEqual(ctx.api.calls.filter(c => c.startsWith("create:")), ["create:company:2", "create:person:2"]);
  // Brightwave lists its leaders, so it was not searched.
  assert.ok(!ctx.api.calls.includes("leaders:102"));
});

test("a row that lists leaders replaces the searched ones; a size mismatch is noted", async () => {
  const f = importFixture();
  (f.api!.enrich as any)["101"].basic_info = { employee_count_range: "11-50" };
  (f.api!.enrich as any)["101"].headcount.total = 11373;
  f.api!.people!["https://www.profiles.example/in/example-jake"] = { personId: 7, name: "Jake", current: [{ title: "Founder", name: "Northwind Robotics", crustdata_company_id: 101 }] };
  const ctx = ctxFor(f, new Store(":memory:"));
  const first = await importPortfolio(ctx, await planImport(ctx, readPortfolioCsv(csv)));
  assert.ok(first.notes.some(n => /counts 11373 people but sizes the company at 11-50/.test(n)));
  assert.ok(ctx.store.watchedProfileUrls().includes("https://www.profiles.example/in/example-dana-doe"));
  const fixed = csv.replace("Northwind Robotics,northwind.example,Priya Shah,", "Northwind Robotics,northwind.example,Priya Shah,https://www.profiles.example/in/example-jake");
  await importPortfolio(ctx, await planImport(ctx, readPortfolioCsv(fixed)));
  const urls = ctx.store.leaders("northwind.example").map(l => l.profileUrl);
  assert.deepEqual(urls, ["https://www.profiles.example/in/example-jake"]);
});

test("import again: nothing to pay, no new watchers; a removed row stops being watched", async () => {
  const f = importFixture();
  const ctx = ctxFor(f, new Store(":memory:"));
  await importPortfolio(ctx, await planImport(ctx, readPortfolioCsv(csv)));
  const again = await planImport(ctx, readPortfolioCsv(csv));
  assert.equal(estimateImport(again).total, 0);
  assert.equal(again.add.length, 0);
  const smaller = await planImport(ctx, readPortfolioCsv("company,website\nNorthwind Robotics,northwind.example\n"));
  assert.deepEqual(smaller.remove.map(c => c.domain), ["brightwave.example"]);
  await importPortfolio(ctx, smaller);
  assert.equal(ctx.store.companies().length, 1);
  assert.deepEqual(ctx.store.watchedProfileUrls(), ["https://www.profiles.example/in/example-dana-doe"]);
  assert.ok(ctx.api.calls.some(c => c === "patch:company:900:1"));
  assert.equal(ctx.api.calls.filter(c => c.startsWith("create:")).length, 2);
});

test("ensureWatches reuses a matching watcher already on the account instead of creating a duplicate", async () => {
  const f = importFixture();
  const store = new Store(":memory:");
  store.saveCompany({ domain: "northwind.example", name: "Northwind Robotics", companyId: 101, hiringSource: "none", addedAt: "2026-10-01T00:00:00Z" });
  const { COMPANY_TRACK, COMPANY_FIELDS } = await import("../src/crustdata.js");
  // Same list and track but delivering to someone's webhook: not ours to reuse.
  f.api!.activeWatches = { company: [
    { id: 4241, status: "active", track: COMPANY_TRACK, fields: COMPANY_FIELDS, entities: { crustdata_company_ids: [101] }, notifications: [{ type: "webhook" }] },
    { id: 4242, status: "active", track: COMPANY_TRACK, fields: COMPANY_FIELDS, entities: { crustdata_company_ids: [101] }, notifications: [] },
  ] };
  f.api!.runs = { company: [{ run: { id: 77, started_at: "2026-09-01T06:00:00Z", status: "SUCCESS", new_records_count: 1 }, records: [{ changes: [{ field: "headcount.total", type: "changed" }], record: { crustdata_company_id: 101, headcount: { total: 1 } } }] }] };
  const ctx = ctxFor(f, store);
  const notes: string[] = [];
  const w = await ensureWatches(ctx, notes);
  assert.equal(w.company, 4242);
  assert.ok(!ctx.api.calls.some(c => c.startsWith("create:company")));
  assert.ok(notes.some(n => /Reused the company watcher 4242/.test(n)));
  // Its earlier runs are history: marked read, and its config is set to ours.
  assert.ok(store.seenRunIds("company").has(77));
  assert.ok(ctx.api.calls.includes("patch:company:4242:1"));
});

test("a careers page that comes back as a small shell with no roles is not counted as zero", async () => {
  const f = fixture("busy-week");
  const ctx = ctxFor(f);
  ctx.store.setMeta("careers_len:tallyhoo.example", "50000");
  const r = await runCheck(ctx);
  assert.ok(!r.signals.some(s => s.kind === "hiring_stopped"));
  assert.ok(r.warnings.some(w => /Tallyhoo's careers page came back much smaller than usual/.test(w)));
  assert.equal(ctx.store.readings("tallyhoo.example").length, 4);
});

test("a company removed and added back is looked up again", async () => {
  const f = importFixture();
  const ctx = ctxFor(f, new Store(":memory:"));
  await importPortfolio(ctx, await planImport(ctx, readPortfolioCsv(csv)));
  await importPortfolio(ctx, await planImport(ctx, readPortfolioCsv("company,website\nBrightwave,brightwave.example\n")));
  const back = await planImport(ctx, readPortfolioCsv(csv));
  assert.deepEqual(back.add.map(r => r.domain), ["northwind.example"]);
  await importPortfolio(ctx, back);
  assert.ok(ctx.store.leaders("northwind.example").length > 0);
  assert.equal(ctx.store.company("northwind.example")!.hiringSource, "careers");
});

test("a careers page failure does not hold back the watchers' alerts", async () => {
  const f = fixture("busy-week");
  const ctx = ctxFor(f);
  ctx.api.fetchPages = async () => { throw new Error("Web Fetch is not enabled"); };
  const r = await runCheck(ctx);
  assert.ok(r.signals.some(s => s.kind === "leader_left"));
  assert.ok(r.warnings.some(w => /Careers pages not read this time/.test(w)));
  assert.equal(ctx.store.seenRunIds("company").size, 1);
});

test("a careers page that stays small and empty on two days is believed, so a real stop is reported", async () => {
  const f = fixture("busy-week");
  const ctx = ctxFor(f);
  ctx.store.setMeta("careers_len:tallyhoo.example", "50000");
  await runCheck(ctx); // first short read: not counted, retried next time
  assert.equal(ctx.store.readings("tallyhoo.example", 70, ctx.now).length, 4);
  // The page is not paid for again the next day: it is due again after HIRING_CHECK_DAYS.
  const next = await runCheck({ ...ctx, now: new Date("2026-10-27T07:00:00.000Z") });
  assert.equal(next.readings, 0);
  const week = await runCheck({ ...ctx, now: new Date("2026-11-02T07:00:00.000Z") });
  assert.equal(ctx.store.readings("tallyhoo.example", 70, new Date("2026-11-02T07:00:00.000Z")).at(-1)!.roles, 0);
  assert.ok(!week.warnings.some(w => /Tallyhoo's careers page came back much smaller/.test(w)));
});

test("Web Fetch answers in another order: each page still goes to the right company", async () => {
  const { fetchPages } = await import("../src/crustdata.js");
  const original = globalThis.fetch;
  process.env.CRUSTDATA_API_KEY = "test";
  globalThis.fetch = (async () => new Response(JSON.stringify([
    { url: "https://b.example/careers/", success: true, content: "B" },
    { url: null, success: false, content: null },
  ]), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  try {
    const pages = await fetchPages(["https://a.example/careers", "https://www.b.example/careers"]);
    assert.deepEqual(pages.map(p => [p.success, p.content]), [[false, null], [true, "B"]]);
  } finally { globalThis.fetch = original; delete process.env.CRUSTDATA_API_KEY; }
});

test("import: a new careers page restarts that company's readings; two websites of one company count once", async () => {
  const f = importFixture();
  const ctx = ctxFor(f, new Store(":memory:"));
  await importPortfolio(ctx, await planImport(ctx, readPortfolioCsv(csv)));
  (f.api!.identify!.domains as any)["northwind.io"] = [{ id: 101, name: "Northwind Robotics", domain: "northwind.io", confidence: 1 }];
  f.api!.pages!["https://boards.greenhouse.io/northwind"] = { roles: 30 };
  const changed = csv.replace("company,website,owner,leaders", "company,website,owner,leaders,careers").replace("Northwind Robotics,northwind.example,Priya Shah,", "Northwind Robotics,northwind.example,Priya Shah,,https://boards.greenhouse.io/northwind") + "Northwind again,northwind.io,,\n";
  const plan = await planImport(ctx, readPortfolioCsv(changed));
  assert.equal(plan.add.length, 0);
  assert.equal(plan.duplicates, 1);
  assert.deepEqual(plan.unfinishedCareers, ["northwind.example"]);
  await importPortfolio(ctx, plan);
  assert.deepEqual(ctx.store.readings("northwind.example", 70, ctx.now).map(r => r.roles), [30]);
});

test("refresh-leaders reports a new leader, and leaves companies whose leaders the portfolio lists alone", async () => {
  const f = importFixture();
  const ctx = ctxFor(f, new Store(":memory:"));
  await importPortfolio(ctx, await planImport(ctx, readPortfolioCsv(csv)));
  f.api!.leaders!["101"].push({ personId: 9, name: "Kim New", title: "Chief Financial Officer", profileUrl: "https://www.profiles.example/in/example-kim", startDate: "2026-10-15" });
  // There all along (started years ago, just not found the first time): watched from now on, but not news.
  f.api!.leaders!["101"].push({ personId: 10, name: "Long Time", title: "Chief Product Officer", profileUrl: "https://www.profiles.example/in/example-long", startDate: "2021-03-01" });
  const { refreshLeaders } = await import("../src/run.js");
  const r = await refreshLeaders(ctx);
  assert.deepEqual(r.signals.map(s => [s.kind, s.severity, s.domain]), [["leader_joined", "alert", "northwind.example"]]);
  assert.ok(ctx.store.watchedProfileUrls().includes("https://www.profiles.example/in/example-long"));
  assert.ok(!ctx.api.calls.includes("leaders:102") || ctx.api.calls.filter(c => c === "leaders:102").length === 0);
});

test("a careers page that leads to a job board is not looked up again by every import", async () => {
  const f = importFixture();
  f.api!.pages!["https://northwind.example/careers"] = { content: '<html><head><title>Careers</title></head><body><p>See all our open roles on our board.</p><a href="https://jobs.ashbyhq.com/northwind">Jobs</a></body></html>' };
  f.api!.pages!["https://jobs.ashbyhq.com/northwind"] = { roles: 12 };
  const ctx = ctxFor(f, new Store(":memory:"));
  const list = csv.replace("company,website,owner,leaders", "company,website,owner,leaders,careers").replace("Northwind Robotics,northwind.example,Priya Shah,", "Northwind Robotics,northwind.example,Priya Shah,,https://northwind.example/careers");
  await importPortfolio(ctx, await planImport(ctx, readPortfolioCsv(list)));
  assert.equal(ctx.store.company("northwind.example")!.careersUrl, "https://jobs.ashbyhq.com/northwind");
  const again = await planImport(ctx, readPortfolioCsv(list));
  assert.deepEqual(again.unfinishedCareers, []);
  assert.equal(estimateImport(again).total, 0);
});

test("the leader watcher identifies a role by company and title together, and an old-style watcher is replaced", async () => {
  const { PERSON_TRACK } = await import("../src/crustdata.js");
  for (const leaf of PERSON_TRACK.conditions.filter((c: any) => c.keys)) assert.deepEqual((leaf as any).keys, [["crustdata_company_id", "title"], ["name", "title"]]);
  const f = importFixture();
  const store = new Store(":memory:");
  store.saveCompany({ domain: "northwind.example", name: "Northwind Robotics", companyId: 101, hiringSource: "none", addedAt: "2026-10-01T00:00:00Z" });
  store.saveLeader({ profileUrl: "https://www.profiles.example/in/example-x", name: "X", title: "CEO", role: "ceo", domain: "northwind.example", company: "Northwind Robotics", companyId: 101 });
  store.setWatchId("person", 555);
  const ctx = ctxFor(f, store);
  const api = ctx.api as any;
  const getWatch = api.getWatch;
  api.getWatch = async (ds: string, id: number) => ({ ...(await getWatch(ds, id)), track: ds === "person" ? { op: "or", conditions: [{ field: "experience.employment_details.current", type: "added", keys: ["crustdata_company_id", "title"] }] } : undefined });
  const notes: string[] = [];
  const { ensureWatches } = await import("../src/run.js");
  const w = await ensureWatches(ctx, notes);
  assert.notEqual(w.person, 555);
  // The old one is paused and read once more by the next check, then deleted.
  assert.ok(api.calls.includes("status:person:555:paused"));
  assert.deepEqual(JSON.parse(store.getMeta("retired:person")!), [555]);
  assert.ok(notes.some(n => /Replaced the leader watcher 555/.test(n)));
  await runCheck({ ...ctx, now: new Date("2026-10-27T07:00:00Z") }, { hiring: "skip" });
  assert.ok(api.calls.includes("runs:person:555"));
  assert.ok(api.calls.includes("delete:person:555"));
  assert.deepEqual(JSON.parse(store.getMeta("retired:person")!), []);
});

test("round 2 engineer fixes: a quiet company's drop, no second departure alert, one post per channel, unattended warnings kept", async () => {
  // A company at 12 for seven months (nothing in the window), then 8: compared with the last reading before the window.
  const store = new Store(":memory:");
  store.saveCompany({ domain: "q.example", name: "Quiet Co", companyId: 5, hiringSource: "none", addedAt: "2026-01-01T00:00:00Z" });
  store.addPoint("q.example", "2026-03-01T00:00:00.000Z", 12);
  const { companySignals } = await import("../src/run.js");
  const s = companySignals(store, { changes: [{ field: "headcount.total", type: "changed" }], record: { crustdata_company_id: 5, headcount: { total: 8 } } }, DEFAULT_THRESHOLDS, "2026-10-26T07:00:00.000Z");
  assert.equal(s[0]?.kind, "headcount_down");

  // A founder who left is not made active again by the next import listing them, so no second alert.
  const f = fixture("busy-week");
  const ctx = ctxFor(f);
  await runCheck(ctx);
  const rows = "company,website,leaders\nNorthwind Robotics,northwind.example,https://www.profiles.example/in/example-dana-doe https://www.profiles.example/in/example-lee-roe\n";
  ctx.api.identifyCompanies = async () => ({});
  const { planImport: plan, importPortfolio: apply } = await import("../src/run.js");
  await apply(ctx, { ...(await plan(ctx, readPortfolioCsv(rows))), remove: [] });
  assert.equal(ctx.store.leaders("northwind.example", { all: true }).find(l => l.name === "Dana Doe")!.status, "left");
  assert.ok(ctx.store.leaders("northwind.example", { all: true }).every(l => l.source === "csv"));
});

test("a round whose type and date arrive on different runs is reported once", async () => {
  const store = new Store(":memory:");
  store.saveCompany({ domain: "a.example", name: "Acme", companyId: 1, hiringSource: "none", addedAt: "2026-01-01T00:00:00Z" });
  const { companySignals } = await import("../src/run.js");
  const r1 = companySignals(store, { changes: [{ field: "funding.last_round_type", type: "changed", from: "series_a", to: "series_b" }], record: { crustdata_company_id: 1, funding: { last_round_type: "series_b", last_fundraise_date: "2025-01-10" } } }, DEFAULT_THRESHOLDS, "2026-10-25T07:00:00.000Z");
  for (const s of r1) store.addSignal(s, "2026-10-25T07:00:00.000Z");
  const r2 = companySignals(store, { changes: [{ field: "funding.last_fundraise_date", type: "changed", from: "2025-01-10", to: "2026-10-20" }], record: { crustdata_company_id: 1, funding: { last_round_type: "series_b", last_fundraise_date: "2026-10-20" } } }, DEFAULT_THRESHOLDS, "2026-10-26T07:00:00.000Z");
  assert.deepEqual(r1.map(s => s.kind), ["round"]);
  assert.deepEqual(r2, []);
});

test("round 3: one headcount drop is reported once, and a reading older than the window does not stand in when the window has readings", async () => {
  const ctx = ctxFor(fixture("busy-week"));
  await runCheck(ctx, { hiring: "skip" });
  const { companySignals } = await import("../src/run.js");
  const rec = (total: number) => ({ changes: [{ field: "headcount.total", type: "changed" }], record: { crustdata_company_id: 101, headcount: { total } } });
  assert.deepEqual(companySignals(ctx.store, rec(40), DEFAULT_THRESHOLDS, "2026-10-30T07:00:00.000Z"), []);
  const store = new Store(":memory:");
  store.saveCompany({ domain: "w.example", name: "W", companyId: 9, hiringSource: "none", addedAt: "2026-01-01T00:00:00Z" });
  store.addPoint("w.example", "2026-01-01T00:00:00.000Z", 100);
  store.addPoint("w.example", "2026-09-01T00:00:00.000Z", 48);
  assert.deepEqual(companySignals(store, { changes: [{ field: "headcount.total", type: "changed" }], record: { crustdata_company_id: 9, headcount: { total: 47 } } }, DEFAULT_THRESHOLDS, "2026-10-26T07:00:00.000Z"), []);
});

test("round 3: a new round in the same season is its own round, with its investors", async () => {
  const store = new Store(":memory:");
  store.saveCompany({ domain: "a.example", name: "Acme", companyId: 1, hiringSource: "none", addedAt: "2026-01-01T00:00:00Z" });
  const { companySignals } = await import("../src/run.js");
  const first = companySignals(store, { changes: [{ field: "funding.last_round_type", type: "changed", from: "pre_seed", to: "seed" }, { field: "funding.last_fundraise_date", type: "changed", from: "2025-01-01", to: "2026-07-25" }], record: { crustdata_company_id: 1, funding: { last_round_type: "seed", last_fundraise_date: "2026-07-25" } } }, DEFAULT_THRESHOLDS, "2026-07-28T07:00:00.000Z");
  for (const s of first) store.addSignal(s, "2026-07-28T07:00:00.000Z");
  const second = companySignals(store, { changes: [{ field: "funding.last_fundraise_date", type: "changed", from: "2026-07-25", to: "2026-10-20" }, { field: "funding.investors", type: "added", new_elements: ["Big Fund Capital"] }], record: { crustdata_company_id: 1, funding: { last_round_type: "seed", last_fundraise_date: "2026-10-20" } } }, DEFAULT_THRESHOLDS, "2026-10-22T07:00:00.000Z");
  assert.equal(second.length, 1);
  assert.match(second[0].text, /Big Fund Capital/);
});
