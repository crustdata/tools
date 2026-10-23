/**
 * End to end, offline: every fixture pushed through the real `runDigest` and `init` with a fixture-driven API and an
 * in-memory store. Nothing is sent and nothing is written.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { jobWatchFilters, postWatchFilters } from "../src/crustdata.js";
import { fixtureApi, fixtureCompetitors, loadFixture, storeFromFixture, type Fixture } from "../src/fixture-api.js";
import { loadKeywords, watchKeywords } from "../src/posts.js";
import { dedupeHeadlines, estimateInit, estimateWeek, init, runDigest } from "../src/run.js";
import { digestMessages } from "../src/slack.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const keywords = loadKeywords();
const load = (name: string, edit?: (f: Fixture) => void) => {
  const fixture = loadFixture(resolve(FIXTURES, `${name}.json`));
  edit?.(fixture);
  const store = storeFromFixture(fixture);
  const api = fixtureApi(fixture);
  return { fixture, store, api, deps: { store, competitors: fixtureCompetitors(fixture), keywords, api, now: new Date(fixture.now!) } };
};
const quiet = { send: false, writeFile: false };
/** The text of one section of one competitor: the bullet lines, or the inline quiet line. */
const section = (md: string, competitor: string, title: string): string => {
  const block = md.split(`## ${competitor}`)[1]?.split("\n## ")[0] ?? "";
  const inline = block.split(`**${title}:** `)[1]?.split("\n")[0];
  if (inline !== undefined) return inline;
  return block.split(`**${title}**`)[1]?.split("\n\n")[0] ?? "";
};
const items = (d: { competitors: { sections: Record<string, { items: unknown[] }> }[] }) => d.competitors.reduce((n, c) => n + Object.values(c.sections).reduce((m, s) => m + s.items.length, 0), 0);

test("busy week: every kind of change shows up once, with a source, in the right section", async () => {
  const { store, api, deps } = load("busy-week");
  const { digest, markdown, slack, email, id } = await runDigest(deps, quiet);
  assert.equal(slack, "skipped");
  assert.equal(email, "skipped");
  assert.ok(id, "the digest is saved");
  assert.equal(digest.firstRun, false);
  assert.equal(digest.from, "2026-10-19");
  assert.deepEqual(digest.warnings, []);
  assert.deepEqual(digest.competitors.map(c => c.name), ["Northwind", "Contoso"], "busiest first");

  const launches = section(markdown, "Northwind", "Launches");
  assert.match(launches, /Pricing changed \(Pro\): "10k credits included" is now "20k credits included"/);
  assert.match(launches, /New changelog entry: Agents API in beta.*changelog\/agents-api/);
  assert.match(launches, /New page linked from the homepage: Agents \(\/agents\)/);
  assert.ok(!launches.includes("/fr/") && !launches.includes("privacy"), "translations and legal pages are not launches");

  const customers = section(markdown, "Northwind", "Customers");
  assert.match(customers, /2 new logos on the homepage: Hooli, Stark Industries/);
  assert.match(customers, /New case study: How Hooli closes deals 2x faster/);

  const money = section(markdown, "Northwind", "Money and news");
  assert.match(money, /Raised Series B \(\$40M\) on Oct 21, 2026\. Fresh/);
  assert.match(money, /\[source\]\(https:\/\/news\.example\/northwind-series-b\)/, "the round links to an article, not a profile page");
  assert.equal((money.match(/In the news/g) ?? []).length, 0, "press about the round is folded into the round's own line");
  assert.ok(!money.includes("tracxn") && !money.includes("Grill"), "listing sites and unrelated namesakes are dropped");

  assert.match(section(markdown, "Northwind", "Hiring"), /15 new postings, up from about 3 a week: 14 sales roles \(10 in London, 4 in New York\) and 1 engineering role/);
  assert.match(section(markdown, "Northwind", "Headcount"), /Headcount up 8% since Sep 28 \(200 to 215\)/);
  assert.match(section(markdown, "Northwind", "Headcount"), /Engineering up 25%/);

  const posts = section(markdown, "Northwind", "Posts");
  assert.match(posts, /CEO posted: "We just crossed \$10M ARR/);
  assert.ok(!posts.includes("Jane Doe"), "staff names are hidden by default");
  assert.match(posts, /Welcome aboard Hooli/);
  assert.ok(!posts.includes("webinar") && !posts.includes("Should CRMs"), "promos and questions dropped");
  assert.equal((posts.match(/Introducing Northwind Agents/g) ?? []).length, 1, "repost dropped");

  assert.match(markdown, /## Contoso \(contoso\.example\)\n\nNothing new in any section this week\./);

  // State moved on: runs are marked seen, the new record and pages are stored, items do not repeat.
  assert.deepEqual([...store.seenRunIds("company")], [501]);
  assert.equal(store.getCompanyRecord("northwind.example")?.record.headcount.total, 215);
  assert.ok(store.getPage("https://northwind.example/pricing")?.text.includes("20k credits included"));
  assert.ok(api.calls.every(c => !c.startsWith("posts:") && !c.startsWith("jobs:northwind.example:limit=100")), "no paid direct searches after week one");
  const again = await runDigest({ ...deps, now: new Date("2026-10-26T09:00:00Z") }, quiet);
  assert.equal(items(again.digest), 0, "a second run reports nothing twice");
  assert.ok(!JSON.stringify(digestMessages(digest)).includes("<!"), "nothing in Slack can ping");
});

test("dry run: builds the same digest and leaves no trace, so the real run still has everything", async () => {
  const { store, deps } = load("busy-week");
  const dry = await runDigest(deps, { ...quiet, dryRun: true });
  assert.equal(dry.id, undefined);
  assert.equal(items(dry.digest), 15);
  assert.equal(store.lastDigest()?.createdAt, "2026-10-19T08:00:00Z", "no digest saved");
  assert.equal(store.seenRunIds("company").size, 0, "no run marked as read");
  const real = await runDigest(deps, quiet);
  assert.equal(items(real.digest), 15, "the real run after a dry run still has every item");
});

test("a crash halfway leaves no trace; the next run reports everything", async () => {
  const { store, deps } = load("busy-week");
  const original = store.addWeeklyJobs.bind(store);
  store.addWeeklyJobs = () => { throw new TypeError("boom"); }; // fails after pages, news and watcher runs were read
  await assert.rejects(runDigest(deps, quiet), /boom/);
  store.addWeeklyJobs = original;
  assert.equal(store.seenRunIds("company").size, 0);
  assert.equal(store.isSeen("news", "https://techpress.example/northwind-raises-40m"), false);
  const ok = await runDigest(deps, quiet);
  assert.equal(items(ok.digest), 15);
});

test("a rejected key or an empty account stops before anything is saved or sent", async () => {
  for (const status of [401, 402]) {
    const { store, deps } = load("busy-week", f => { f.api!.creditsStatus = status; });
    await assert.rejects(runDigest(deps, quiet), (err: any) => err.status === status);
    assert.equal(store.lastDigest()?.createdAt, "2026-10-19T08:00:00Z", `${status}: no digest saved`);
  }
});

test("quiet week: one line per competitor and nothing spent on posts or jobs", async () => {
  const { deps, api } = load("quiet-week");
  const { digest, markdown } = await runDigest(deps, quiet);
  assert.equal(markdown.match(/^- /gm), null, "no item lines");
  assert.equal(markdown.match(/Nothing new in any section this week\./g)?.length, 2);
  assert.deepEqual(digest.warnings, []);
  assert.ok(api.calls.every(c => !c.startsWith("posts:")));
});

test("first run: website sections compare with the starting point, the rest comes from 7-day searches and the record", async () => {
  const { deps, api } = load("first-run");
  const { digest, markdown } = await runDigest(deps, quiet);
  assert.equal(digest.firstRun, true);
  assert.match(markdown, /First digest: posts, hiring, funding and news cover the last 7 days/);
  assert.match(section(markdown, "Northwind", "Money and news"), /Raised Series B \(\$40M\) on Oct 15, 2026/);
  assert.match(section(markdown, "Northwind", "Money and news"), /Acquired Tailspin Toys/);
  assert.match(section(markdown, "Northwind", "Headcount"), /Headcount up 6% in the last month/);
  assert.match(section(markdown, "Northwind", "Posts"), /crossed \$10M ARR/);
  assert.match(section(markdown, "Northwind", "Hiring"), /3 new postings/);
  assert.ok(!markdown.includes("Oct 2"), "nothing dated after the digest");
  assert.ok(api.calls.includes("posts:northwind.example:limit=25"), "week one searches posts directly");
  assert.ok(api.calls.includes("jobs:northwind.example:limit=100"), "week one searches jobs directly");
  assert.ok(!api.calls.includes("posts:fabrikam.example:limit=25"), "no searches for a company outside the index");
});

test("edge cases: huge page skipped, failed pricing page noted, pings escaped, deleted watcher warned, a running run left for later", async () => {
  const { store, deps } = load("edge-cases");
  const { digest, markdown } = await runDigest(deps, quiet);
  const launches = section(markdown, "Northwind", "Launches");
  assert.match(launches, /too large to compare line by line/);
  assert.match(launches, /the pricing page could not be fetched this week/);
  assert.ok(!markdown.includes("Pricing changed"), "a 503 page is not compared");
  assert.ok(markdown.includes("\\<!channel\\>"), "markdown escapes the ping");
  assert.match(section(markdown, "Fabrikam", "Launches"), /starting point saved/i);
  assert.ok(digest.warnings.some(w => /hiring watcher was deleted in your Crustdata account/.test(w)), digest.warnings.join(" | "));
  assert.equal(store.seenRunIds("company").has(503), false, "a RUNNING run is not marked as read");
  const slack = JSON.stringify(digestMessages(digest));
  assert.ok(!slack.includes("<!channel>") && slack.includes("&lt;!channel&gt;"));
});

test("posts not enabled on the account: said once at the top, and a quiet competitor still collapses to one line", async () => {
  // Without post search the post watcher can never be created, so there is none.
  const { deps } = load("first-run", f => { f.api!.postSearchStatus = 403; delete f.state!.watches!.social_post; });
  const { digest, markdown } = await runDigest(deps, quiet);
  assert.match(markdown.split("## ")[0], /Posts are off: Social Post Search is not enabled on this Crustdata account/);
  assert.match(section(markdown, "Northwind", "Posts"), /off on this Crustdata account \(see the note at the top\)/i);
  assert.match(markdown, /## Contoso \(contoso\.example\)\n\nNothing new in any section this week\./);
  assert.ok(!digest.warnings.some(w => /Social Post Search/.test(w)), "not repeated as a warning every week");
});

test("a skipped week: the period covers both weeks and the hiring rate is per week", async () => {
  const { deps } = load("busy-week", f => { f.now = "2026-11-02T08:00:00Z"; });
  const { digest, markdown } = await runDigest(deps, quiet);
  assert.equal(digest.from, "2026-10-19");
  assert.match(section(markdown, "Northwind", "Hiring"), /15 new postings over 2 weeks, up from about 3 a week/);
});

const fresh = () => {
  const fixture = loadFixture(resolve(FIXTURES, "busy-week.json"));
  fixture.state = {};
  fixture.api = { ...fixture.api, identify: {}, enrich: { "101": { crustdata_company_id: 101, headcount: { total: 200 } }, "102": { crustdata_company_id: 102 } } };
  return fixture;
};

test("init: saves pages, enriches, creates three pull-only watchers, and a second run pays for nothing", async () => {
  const fixture = fresh();
  const store = storeFromFixture(fixture);
  const api = fixtureApi(fixture);
  const deps = { store, competitors: fixtureCompetitors(fixture), keywords, api, now: new Date(fixture.now!) };
  const result = await init(deps);
  assert.equal(result.pagesSaved, 6);
  assert.deepEqual(api.created.map(c => c.dataset), ["company", "job", "social_post"]);
  assert.deepEqual(api.created[0].body, [101, 102]);
  assert.ok(((api.created[2].body as any).keywords as string[]).includes("introducing"));
  assert.equal(store.getCompanyRecord("northwind.example")?.record.headcount.total, 200);
  assert.ok(store.getMeta("initialized_at"));
  const before = api.calls.length;
  await init(deps);
  const later = api.calls.slice(before);
  assert.ok(!later.some(c => /^(create|identify|fetch|enrich|delete):/.test(c)), later.join(", "));
});

test("init: reuses a matching watcher already on the account instead of creating a duplicate", async () => {
  const fixture = fresh();
  const competitors = fixtureCompetitors(fixture);
  fixture.api!.activeWatches = {
    job: [{ id: 77, status: "active", notifications: [], filters: jobWatchFilters(competitors.competitors.map(c => c.domain).sort()) }],
    social_post: [{ id: 78, status: "active", notifications: [{ type: "slack" }], filters: postWatchFilters([{ id: 101, name: "Northwind" }, { id: 102, name: "Contoso" }], watchKeywords(keywords)) }],
  };
  const store = storeFromFixture(fixture);
  const api = fixtureApi(fixture);
  await init({ store, competitors, keywords, api, now: new Date(fixture.now!) });
  assert.equal(store.getWatchId("job"), 77, "matching job watcher reused");
  assert.deepEqual(api.created.map(c => c.dataset), ["company", "social_post"], "a watcher that posts to Slack is someone else's, so a new one is made");
});

test("init: a failure halfway keeps what worked; posts not enabled is a note, not a failure", async () => {
  const fixture = fresh();
  fixture.api!.createStatus = { job: 500, social_post: 403 };
  const store = storeFromFixture(fixture);
  const api = fixtureApi(fixture);
  const deps = { store, competitors: fixtureCompetitors(fixture), keywords, api, now: new Date(fixture.now!) };
  await assert.rejects(init(deps), (err: any) => err.status === 500);
  const companyId = store.getWatchId("company");
  assert.ok(companyId, "the company watcher created before the failure is kept");
  fixture.api!.createStatus = { social_post: 403 };
  const result = await init(deps);
  assert.equal(store.getWatchId("company"), companyId, "not recreated");
  assert.ok(!api.calls.includes(`delete:company:${companyId}`));
  assert.ok(store.getWatchId("job"));
  assert.equal(store.getWatchId("social_post"), undefined);
  assert.ok(result.notes.some(n => /Social post search is not enabled/.test(n)));
});

test("init: a changed competitor list replaces the job and post watchers and updates the company watcher in place", async () => {
  const fixture = loadFixture(resolve(FIXTURES, "busy-week.json"));
  fixture.state = { ...fixture.state, watches: { company: 1, job: 2, social_post: 3 } };
  const store = storeFromFixture(fixture);
  const api = fixtureApi(fixture);
  store.setMeta("watch_signature_job", "an older list");
  store.setMeta("watch_signature_social_post", "an older list");
  await init({ store, competitors: fixtureCompetitors(fixture), keywords, api, now: new Date(fixture.now!) });
  assert.ok(api.calls.includes("status:job:2:paused") && api.calls.includes("status:social_post:3:paused"), "old watchers paused, not deleted");
  assert.ok(!api.calls.some(c => c.startsWith("delete:")), "nothing deleted before its last runs are read");
  assert.ok(!api.calls.includes("status:company:1:paused"));
  assert.notEqual(store.getWatchId("job"), 2);
  assert.equal(store.getMeta("retired_job"), "[2]");
  assert.ok(store.getMeta("gap_since_job"), "the next digest searches the short gap since the old watcher last ran");
});

test("estimates and headline dedupe", () => {
  assert.equal(estimateInit(3, 6), 24);
  assert.deepEqual(estimateWeek(3, 6, 500, 200), { quiet: 21, busy: 21 + 15 + 15 + 24, ceiling: 21 + 15 + 7 * 72 * 0.5 + 7 * 29 * 2 });
  const press = [{ text: 'In the news: "Acme raises $40M Series B" (a)' }, { text: 'In the news: "Acme raises $40M Series B led by X" (b)' }];
  assert.equal(dedupeHeadlines(press).length, 1, "same story from two outlets once");
  assert.deepEqual(dedupeHeadlines([...press, { text: "Raised Series B ($40M)" }]).map(i => i.text), ["Raised Series B ($40M)"]);
  assert.equal(dedupeHeadlines([{ text: "Raised Series B", url: "https://x.example/a" }, { text: 'In the news: "Acme opens Berlin office" (x)', url: "https://x.example/a" }]).length, 1);
});

test("a pricing page shown in another currency is skipped once, then accepted if it stays that way", async () => {
  const gbp = (f: Fixture) => { const p = f.api!.pages!["https://northwind.example/pricing"]; p.content = p.content!.replace(/\$/g, "£"); };
  const { deps, store } = load("busy-week", gbp);
  const first = await runDigest(deps, quiet);
  assert.match(section(first.markdown, "Northwind", "Launches"), /not compared this week: https:\/\/northwind\.example\/pricing \(prices came back in £ instead of \$/);
  assert.ok(!first.markdown.includes("Pricing changed"), "no false price changes from a currency switch");
  assert.ok(store.getPage("https://northwind.example/pricing")?.text.includes("$"), "last week's copy is kept");
  const second = await runDigest({ ...deps, now: new Date("2026-11-02T08:00:00Z") }, quiet);
  assert.match(second.markdown, /now shows prices in another currency; compared again from next week/);
  assert.ok(store.getPage("https://northwind.example/pricing")?.text.includes("£"));
});

test("a watcher that has not run since the last digest says so instead of 'nothing new'", async () => {
  const { deps } = load("quiet-week", f => { f.api!.watchInfo = { job: { last_run_at: "2026-10-20T06:00:00Z" } }; });
  const { markdown } = await runDigest(deps, quiet);
  assert.match(section(markdown, "Northwind", "Hiring"), /the hiring watcher has not run since the last digest; what it finds will be in the next one/i);
});

test("a suspended watcher and a skipped run are warnings, and the section is not reported as quiet", async () => {
  const { deps } = load("quiet-week", f => {
    f.api!.watchInfo = { company: { status: "suspended" } };
    f.api!.runs = { ...f.api!.runs, job: [{ run: { id: 610, started_at: "2026-10-30T06:00:00Z", status: "SKIPPED", new_records_count: 0, failure_reason: "INSUFFICIENT_CREDITS" } as any, records: [] }] };
  });
  const { digest, markdown } = await runDigest(deps, quiet);
  assert.ok(digest.warnings.some(w => /company changes watcher is not running: Crustdata suspended it/.test(w)), digest.warnings.join(" | "));
  assert.ok(digest.warnings.some(w => /did not complete \(Crustdata: insufficient credits\).*Top up/.test(w)), digest.warnings.join(" | "));
  assert.match(section(markdown, "Northwind", "Hiring"), /not checked this week/i);
  assert.match(section(markdown, "Northwind", "Headcount"), /not checked this week/i);
});

test("a replaced watcher is read one last time, then deleted; a short catch-up search covers the switch", async () => {
  const { deps, store, api } = load("busy-week", f => {
    f.api!.jobSearch = { ...f.api!.jobSearch, "northwind.example": { total_count: 44, job_listings: [{ crustdata_job_id: 9001, job_details: { title: "Solutions Engineer", category: "Engineering", url: "https://jobs.example/9001" }, location: { city: "Austin", country: "United States" }, metadata: { date_added: "2026-10-25T10:00:00" } }] } };
  });
  store.setMeta("retired_job", "[2]");
  store.setWatchId("job", 950);
  store.setMeta("gap_since_job", "2026-10-25T06:00:00Z");
  const { markdown } = await runDigest(deps, quiet);
  assert.ok(deps.api.calls.includes("jobs:northwind.example:limit=30"), "a small catch-up, not a 7-day search");
  assert.ok(api.calls.includes("runs:job:2"), "the old watcher's runs are read");
  assert.match(section(markdown, "Northwind", "Hiring"), /16 new postings/, "15 from the old watcher plus 1 from the catch-up search");
  assert.ok(!deps.api.calls.some(c => c.startsWith("posts:")), "only the replaced watcher's dataset is caught up");
  assert.ok(api.calls.includes("delete:job:2"), "then it is deleted");
  assert.equal(store.getMeta("retired_job"), "[]");
  assert.equal(store.getMeta("gap_since_job"), undefined);
});

test("a dry run never deletes a replaced watcher", async () => {
  const { deps, store, api } = load("busy-week");
  store.setMeta("retired_job", "[2]");
  await runDigest(deps, { ...quiet, dryRun: true });
  assert.ok(!api.calls.some(c => c.startsWith("delete:")));
  assert.equal(store.getMeta("retired_job"), "[2]");
});

test("the same story from another outlet next week is not news again", async () => {
  const { deps } = load("quiet-week", f => { f.api!.news = { "northwind.example": [{ title: "Northwind opens a Berlin office for its CRM team", url: "https://a.example/1" }], "contoso.example": [] }; });
  const first = await runDigest(deps, quiet);
  assert.match(section(first.markdown, "Northwind", "Money and news"), /Berlin office/);
  const fixture = loadFixture(resolve(FIXTURES, "quiet-week.json"));
  fixture.api!.news = { "northwind.example": [{ title: "Northwind opens a Berlin office for its CRM team", url: "https://b.example/2" }], "contoso.example": [] };
  const second = await runDigest({ ...deps, api: fixtureApi(fixture), now: new Date("2026-11-09T08:00:00Z") }, quiet);
  assert.ok(!second.markdown.includes("Berlin office"), second.markdown);
});

test("a page that stays much shorter two runs in a row becomes the new reference", async () => {
  const shrink = (f: Fixture) => {
    const home = f.state!.pages!.find(p => p.url === "https://northwind.example/")!;
    home.html = `<html><body>${Array.from({ length: 60 }, (_, i) => `<p>Northwind feature block number ${i} describes the product.</p>`).join("")}</body></html>`;
    f.api!.pages!["https://northwind.example/"] = { title: "Northwind", content: "<html><body><p>Northwind is coming soon with a new site</p></body></html>" };
  };
  const { deps, store } = load("busy-week", shrink);
  const first = await runDigest(deps, quiet);
  assert.match(section(first.markdown, "Northwind", "Launches"), /not compared this week: https:\/\/northwind\.example\/ \(the page came back mostly empty\)/);
  const second = await runDigest({ ...deps, now: new Date("2026-11-02T08:00:00Z") }, quiet);
  assert.match(second.markdown, /is now much shorter than it was \(a redesign\?\); compared again from next week/);
  assert.ok(store.getPage("https://northwind.example/")?.text.includes("coming soon"));
});

test("adopting a watcher marks what it caught before as read, so the first digest is not flooded", async () => {
  const fixture = fresh();
  const competitors = fixtureCompetitors(fixture);
  fixture.api!.activeWatches = { job: [{ id: 77, status: "active", notifications: [], filters: jobWatchFilters(competitors.competitors.map(c => c.domain).sort()) }] };
  fixture.api!.runs = { job: [{ run: { id: 41, started_at: "2026-08-01T06:00:00Z", status: "SUCCESS", new_records_count: 3 } as any, records: [] }, { run: { id: 42, started_at: "2026-09-01T06:00:00Z", status: "SUCCESS", new_records_count: 2 } as any, records: [] }] };
  const store = storeFromFixture(fixture);
  await init({ store, competitors, keywords, api: fixtureApi(fixture), now: new Date(fixture.now!) });
  assert.deepEqual([...store.seenRunIds("job")].sort(), [41, 42]);
});

test("a dry run does not write competitors.json", async () => {
  const { deps, store } = load("busy-week");
  store.deleteMeta("pages_discovered_contoso.example");
  let saved = 0;
  await runDigest({ ...deps, saveCompetitors: () => { saved++; } }, { ...quiet, dryRun: true });
  assert.equal(saved, 0);
  await runDigest({ ...deps, saveCompetitors: () => { saved++; } }, quiet);
  assert.equal(saved, 1, "a real run writes the pages it found");
});

test("a competitor added since the last digest gets a 7-day look back; the others do not pay for one", async () => {
  const { deps, store, api } = load("busy-week");
  store.setMeta("new_domains", JSON.stringify(["contoso.example"]));
  await runDigest(deps, quiet);
  assert.ok(api.calls.includes("jobs:contoso.example:limit=100") && api.calls.includes("posts:contoso.example:limit=25"));
  assert.ok(!api.calls.includes("jobs:northwind.example:limit=100") && !api.calls.includes("posts:northwind.example:limit=25"));
  assert.equal(store.getMeta("new_domains"), undefined);
});

test("a failed direct search marks that competitor's section as not checked", async () => {
  const { deps, api } = load("first-run");
  const broken = { ...api, searchJobs: async (f: any, o: any) => { if (o.limit > 0) throw new Error("timeout"); return api.searchJobs(f, o); } };
  const { markdown } = await runDigest({ ...deps, api: broken }, quiet);
  assert.match(section(markdown, "Northwind", "Hiring"), /not checked this week/i);
});

test("a replaced watcher whose last read failed is kept for next time, not deleted", async () => {
  const { deps, store, api } = load("busy-week");
  store.setMeta("retired_job", "[77]");
  const flaky = { ...api, newRunRecords: async (ds: any, id: number, seen: Set<number>) => { if (id === 77) throw new Error("503 Service Unavailable"); return api.newRunRecords(ds, id, seen); } };
  await runDigest({ ...deps, api: flaky }, quiet);
  assert.ok(!api.calls.includes("delete:job:77"));
  assert.equal(store.getMeta("retired_job"), "[77]");
});

test("the posts-off notice clears once the post watcher delivers", async () => {
  const { deps, store } = load("busy-week");
  store.setMeta("disabled_social_post", "Posts are off");
  const { markdown } = await runDigest(deps, quiet);
  assert.ok(!markdown.includes("Posts are off"));
  assert.equal(store.getMeta("disabled_social_post"), undefined);
});

test("adoption never picks a watcher that is retired or not active", async () => {
  const fixture = fresh();
  const competitors = fixtureCompetitors(fixture);
  const filters = jobWatchFilters(competitors.competitors.map(c => c.domain).sort());
  fixture.api!.activeWatches = { job: [{ id: 2, status: "paused", notifications: [], filters }, { id: 3, status: "active", notifications: [], filters }] };
  const store = storeFromFixture(fixture);
  store.setMeta("retired_job", "[3]");
  const api = fixtureApi(fixture);
  await init({ store, competitors, keywords, api, now: new Date(fixture.now!) });
  assert.ok(![2, 3].includes(store.getWatchId("job")!), "a new watcher, not the paused or retired one");
});

test("a replaced watcher with a run still in progress is read again next week, not deleted", async () => {
  const { deps, store, api } = load("busy-week");
  store.setMeta("retired_job", "[77]");
  const busy = { ...api, newRunRecords: async (ds: any, id: number, seen: Set<number>) => (id === 77 ? Object.assign([], { pending: true }) : api.newRunRecords(ds, id, seen)) };
  await runDigest({ ...deps, api: busy }, quiet);
  assert.ok(!api.calls.includes("delete:job:77"));
  assert.equal(store.getMeta("retired_job"), "[77]");
});

test("the catch-up post search covers the whole gap since the old watcher last ran", async () => {
  const { deps, store, api } = load("busy-week");
  store.setMeta("retired_social_post", "[5]");
  store.setMeta("gap_since_social_post", new Date(deps.now.getTime() - 3.5 * 86_400_000).toISOString());
  const windows: string[] = [];
  const spy = { ...api, searchPosts: async (f: any, o: any) => { windows.push(JSON.stringify(f).match(/"value":"(now-[^"]+)"/)?.[1] ?? ""); return api.searchPosts(f, o); } };
  await runDigest({ ...deps, api: spy }, quiet);
  assert.ok(windows.length && windows.every(w => w === "now-4d"), windows.join(","));
});

test("a competitor added without npm run init is searched directly and the digest says to run init", async () => {
  const { deps, store, api } = load("busy-week");
  store.setMeta("watch_signature_job", JSON.stringify({ filters: jobWatchFilters(["northwind.example"]), max: 500 }));
  const { digest } = await runDigest(deps, quiet);
  assert.ok(digest.warnings.some(w => /Not in the watchers yet: contoso\.example\. Run npm run init/.test(w)), digest.warnings.join(" | "));
  assert.ok(api.calls.includes("jobs:contoso.example:limit=100"));
  assert.ok(!api.calls.includes("jobs:northwind.example:limit=100"));
});
