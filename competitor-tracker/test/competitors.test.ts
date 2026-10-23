import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCompetitors, looksLikeDomain, normalizeDomain, validateCompetitors, withId } from "../src/competitors.js";
import { mask, parseEnv, quoteEnv, renderEnv } from "../src/setup.js";
import { Store, weekLabel } from "../src/store.js";

test("normalizeDomain accepts URLs, www, paths and case; rejects junk", () => {
  assert.equal(normalizeDomain("https://www.Acme.com/pricing"), "acme.com");
  assert.equal(normalizeDomain("acme.com"), "acme.com");
  assert.equal(normalizeDomain("folk.app"), "folk.app");
  assert.equal(normalizeDomain("not a domain"), null);
  assert.equal(normalizeDomain("localhost"), null);
  assert.equal(normalizeDomain(""), null);
  assert.equal(looksLikeDomain("Acme"), false);
  assert.equal(looksLikeDomain("acme.com"), true);
});

test("validateCompetitors normalises, dedupes and explains mistakes", () => {
  const ok = validateCompetitors({ competitors: [{ domain: "https://Acme.com/" }, { name: " Folk ", domain: "folk.app", crustdata_company_id: 5, pages: ["https://folk.app/", "nope"] }], cities: [" London ", 3] });
  assert.deepEqual(ok.competitors[0], { name: "acme.com", domain: "acme.com", crustdata_company_id: undefined, pages: undefined });
  assert.deepEqual(ok.competitors[1], { name: "Folk", domain: "folk.app", crustdata_company_id: 5, pages: ["https://folk.app/"] });
  assert.deepEqual(ok.cities, ["London"]);
  assert.throws(() => validateCompetitors({}), /"competitors" array/);
  assert.throws(() => validateCompetitors({ competitors: [] }), /no competitors/);
  assert.throws(() => validateCompetitors({ competitors: [{ domain: "a.com" }, { domain: "A.com" }] }), /listed twice/);
  assert.throws(() => validateCompetitors({ competitors: [{ name: "x" }] }), /needs a "domain"/);
  assert.equal(withId(ok.competitors).length, 1);
});

test(".env: values come back unchanged through Node's own .env reader, comments and unknown keys handled", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const existing = parseEnv(`# comment\nCRUSTDATA_API_KEY='abc'\nCUSTOM="keep me"\nMAX_POSTS_PER_WEEK=200 # cap\nSLACK_WEBHOOK_URL=https://hooks.slack.com/services/T1/B1/x\n`);
  assert.equal(existing.CRUSTDATA_API_KEY, "abc");
  assert.equal(existing.CUSTOM, "keep me");
  assert.equal(existing.MAX_POSTS_PER_WEEK, "200", "inline comment stripped");
  const values = { CRUSTDATA_API_KEY: "new'key", DIGEST_EMAIL_FROM: `O'Brien <ob@x.example>`, DIGEST_EMAIL_TO: `a"b'c@x.example` };
  const out = renderEnv(values, existing);
  assert.ok(out.startsWith("CRUSTDATA_API_KEY="), out);
  assert.ok(out.includes("CUSTOM='keep me'"));
  const dir = mkdtempSync(join(tmpdir(), "ct-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, out, { mode: 0o600 });
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(values)) assert.equal(process.env[k], v, `${k} round trip through Node`);
  assert.equal(parseEnv(readFileSync(file, "utf8")).DIGEST_EMAIL_FROM, values.DIGEST_EMAIL_FROM);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
  Object.assign(process.env, before);
});

test("saved secrets are always shown masked", () => {
  assert.equal(mask("3f9a8c7d6e5b4a3928171615141312ab"), "3f9a…12ab");
  assert.equal(mask("re_123"), "••••");
  assert.equal(quoteEnv("plain"), "'plain'");
});

test("store: pages, records, weekly jobs, seen items and digests round-trip in memory", () => {
  const s = new Store(":memory:");
  s.savePage({ url: "https://a.example/", domain: "a.example", title: "A", text: "x\ny", links: [{ href: "https://a.example/p", text: "P" }], logos: ["Globex"], fetchedAt: "2026-10-19T00:00:00Z" });
  assert.deepEqual(s.getPage("https://a.example/")?.links, [{ href: "https://a.example/p", text: "P" }]);
  assert.equal(s.pagesFor("a.example").length, 1);
  s.saveCompanyRecord("a.example", { headcount: { total: 3 } }, "2026-10-19T00:00:00Z");
  assert.equal(s.getCompanyRecord("a.example")?.record.headcount.total, 3);
  s.addWeeklyJobs("a.example", "2026-W42", 2, 10);
  s.addWeeklyJobs("a.example", "2026-W42", 3, null);
  assert.deepEqual(s.weeklyJobs("a.example"), [{ domain: "a.example", week: "2026-W42", newJobs: 5, recentJobs: 10 }], "a second run in a week adds, never overwrites");
  assert.deepEqual(s.firstTime("news", ["u1", "u2", "u1"], x => x), ["u1", "u2"]);
  assert.deepEqual(s.firstTime("news", ["u1", "u3"], x => x), ["u3"]);
  assert.equal(s.lastDigest(), undefined);
  const d = { week: "2026-W43", from: "2026-10-12", to: "2026-10-19", firstRun: true, competitors: [], creditsUsed: 1, watcherCredits: 0, warnings: [] };
  const id = s.saveDigest(d, "# x");
  s.markDigestSent(id, "slack");
  assert.equal(s.lastDigest()?.sentSlack, true);
  assert.equal(s.lastDigest()?.sentEmail, false);
  assert.deepEqual(s.lastDigest()?.digest, d);
  s.setWatchId("job", 7);
  s.markRunSeen("job", 1);
  assert.deepEqual([...s.seenRunIds("job")], [1]);
  s.clearWatch("job");
  assert.equal(s.getWatchId("job"), undefined);
  assert.deepEqual([...s.seenRunIds("job")], [1], "read runs stay read: run ids never repeat");
  s.close();
});

test("store: a rolled-back transaction leaves nothing behind", () => {
  const s = new Store(":memory:");
  s.begin();
  s.markSeen("news", "u1");
  s.setMeta("k", "v");
  s.rollback();
  assert.equal(s.isSeen("news", "u1"), false);
  assert.equal(s.getMeta("k"), undefined);
  s.begin();
  s.markSeen("news", "u2");
  s.commit();
  assert.equal(s.isSeen("news", "u2"), true);
  s.close();
});

test("competitors.json with a byte order mark loads", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "ct-c-")), "competitors.json");
  writeFileSync(file, "\uFEFF" + JSON.stringify({ competitors: [{ domain: "acme.example" }] }));
  assert.equal(loadCompetitors(file).competitors[0].domain, "acme.example");
});

test("weekLabel follows ISO weeks", () => {
  assert.equal(weekLabel(new Date("2026-10-26T08:00:00Z")), "2026-W44");
  assert.equal(weekLabel(new Date("2026-01-01T00:00:00Z")), "2026-W01");
  assert.equal(weekLabel(new Date("2027-01-03T00:00:00Z")), "2026-W53");
});

test("a digest remembers which channels it was meant for, and how far a Slack send got", () => {
  const s = new Store(":memory:");
  const d = { week: "w", from: "2026-10-12", to: "2026-10-19", firstRun: false, competitors: [], creditsUsed: 0, watcherCredits: 0, warnings: [] };
  const id = s.saveDigest(d, "# x", undefined, { slack: true, email: false });
  assert.equal(s.lastDigest()?.wantSlack, true);
  assert.equal(s.lastDigest()?.wantEmail, false, "an email channel added later is not owed this digest");
  s.setSlackDelivered(id, 2);
  assert.equal(s.slackDelivered(id), 2);
  s.close();
});

test("a database from an earlier version gets the new columns", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { DatabaseSync } = await import("node:sqlite");
  const file = join(mkdtempSync(join(tmpdir(), "ct-db-")), "old.sqlite");
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE digests (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, markdown TEXT NOT NULL, payload TEXT NOT NULL, sent_slack INTEGER NOT NULL DEFAULT 0, sent_email INTEGER NOT NULL DEFAULT 0)");
  old.close();
  const s = new Store(file);
  const id = s.saveDigest({ week: "w", from: "a", to: "b", firstRun: false, competitors: [], creditsUsed: 0, watcherCredits: 0, warnings: [] }, "# x", undefined, { slack: true, email: false });
  assert.equal(s.lastDigest()?.wantSlack, true);
  s.setSlackDelivered(id, 1);
  s.close();
});
