import assert from "node:assert/strict";
import { test } from "node:test";
import { fundingSignals, headcountSignals, hiringSignals, money, newsSignals, roundLabel, startingPoint, teamSignals } from "../src/signals.js";
import { DEFAULT_THRESHOLDS as t, mergeThresholds } from "../src/thresholds.js";

const c = { domain: "acme.example", name: "Acme" };
const series = (fns: Record<string, number>, date: string) => ({ headcount: { by_function_timeseries: { CURRENT_FUNCTION: Object.fromEntries(Object.entries(fns).map(([k, v]) => [k, [{ date, employee_count: v }]])) } } });
const kinds = (prev: number, next: number) => headcountSignals(c, [{ at: "2026-09-28T00:00:00Z", total: prev }], { at: "2026-10-26T00:00:00Z", total: next }, t).map(s => s.kind);

test("headcount down needs 10% AND 3 people (25 or more always counts); small companies use 25% and 2", () => {
  assert.deepEqual(kinds(6, 5), []); // 17%, 1 person
  assert.deepEqual(kinds(6, 4), ["headcount_down"]); // small company: 33%, 2 people
  assert.deepEqual(kinds(20, 18), []); // 10%, 2 people
  assert.deepEqual(kinds(20, 17), ["headcount_down"]); // 15%, 3 people
  assert.deepEqual(kinds(200, 185), []); // 7.5%, 15 people
  assert.deepEqual(kinds(200, 180), ["headcount_down"]);
  assert.deepEqual(kinds(500, 470), ["headcount_down"]); // 6%, but 30 people
});

test("headcount up needs 25% AND 5 people", () => {
  assert.deepEqual(kinds(8, 12), []); // 50%, 4 people
  assert.deepEqual(kinds(20, 25), ["headcount_up"]);
  assert.deepEqual(kinds(100, 120), []);
});

test("headcount compares with the peak in the window: a slow decline adds up, and a drop after a rehire is seen", () => {
  const months = Array.from({ length: 7 }, (_, i) => ({ at: `2026-${String(i + 3).padStart(2, "0")}-01T00:00:00Z`, total: Math.round(100 * 0.98 ** i) }));
  const now = months.pop()!;
  assert.deepEqual(headcountSignals(c, months, now, t).map(s => s.text), ["Headcount down 11% since Mar 1, 2026, from 100 to 89 (11 people fewer)"]);
  const rehire = [{ at: "2026-09-01T00:00:00Z", total: 85 }, { at: "2026-09-20T00:00:00Z", total: 100 }];
  assert.equal(headcountSignals(c, rehire, { at: "2026-10-10T00:00:00Z", total: 85 }, t)[0].kind, "headcount_down");
});

test("a team shrinking needs 20%, 3 people and a team of 5 or more, and names the months compared", () => {
  const s = teamSignals(c, series({ SALES: 10, ENGINEERING: 20, LEGAL: 4 }, "2026-06-01"), series({ SALES: 6, ENGINEERING: 18, LEGAL: 1 }, "2026-08-01"), t);
  assert.deepEqual(s.map(x => x.text), ["Sales team down 40%, from 10 to 6 (monthly department counts, Jun 2026 to Aug 2026)"]);
  assert.deepEqual(teamSignals(c, series({ SALES: 10 }, "2026-08-01"), series({ SALES: 2 }, "2026-08-01"), t), []); // same month: nothing new
});

test("thresholds file: partial files keep defaults, bad values are refused", () => {
  const m = mergeThresholds({ headcount_down: { percent: 20 } });
  assert.equal(m.headcount_down.percent, 20);
  assert.equal(m.headcount_down.people, 3);
  assert.throws(() => mergeThresholds({ headcount_down: { percent: "ten" } }), /must be a number/);
  assert.throws(() => mergeThresholds({ headcount_dwon: { percent: 5 } }), /unknown setting "headcount_dwon"/);
  assert.throws(() => mergeThresholds({ hiring_stopped: { from_at_least: 0 } }), /1 or more/);
});

test("starting point flags a 6-month drop with the same rule", () => {
  const r = { headcount: { total: 64, growth_absolute: { six_months: -10 }, growth_percent: { six_months: -13.5 } }, funding: { last_round_type: "series_a", last_round_amount_usd: 15e6, last_fundraise_date: "2025-01-10" } };
  const sp = startingPoint(c, r, t);
  assert.equal(sp.line, "64 people (-14% over 6 months), last round: Series A ($15M) in Jan 2025");
  assert.match(sp.flag!.text, /from 74 to 64/);
  assert.equal(startingPoint(c, { headcount: { total: 6, growth_absolute: { six_months: -1 }, growth_percent: { six_months: -14 } } }, t).flag, undefined);
});

test("rounds: labels, amounts, one signal per round, investors folded in", () => {
  assert.equal(roundLabel("series_b"), "Series B");
  assert.equal(roundLabel("pre_seed"), "pre-seed");
  assert.equal(money(12_000_000), "$12M");
  assert.equal(money(1_500_000_000), "$1.5B");
  const s = fundingSignals(c, [
    { field: "funding.last_round_type", type: "changed", from: "seed", to: "series_a" },
    { field: "funding.last_fundraise_date", type: "changed", to: "2026-10-20" },
    { field: "funding.investors", type: "added", new_elements: ["Harbor Capital"] },
  ], { funding: { last_round_amount_usd: 12e6 } });
  assert.equal(s.length, 1);
  assert.equal(s[0].text, "New round: Series A, $12M (Oct 20, 2026); last round before was seed. New investors: Harbor Capital");
  assert.equal(s[0].severity, "good");
});

test("bridges, extensions and debt after a priced round are alerts; a date moved back is not a round", () => {
  const k = (from: string, to: string) => fundingSignals(c, [{ field: "funding.last_round_type", type: "changed", from, to }], {})[0];
  assert.equal(k("series_a", "convertible_note").severity, "alert");
  assert.equal(k("series_b", "debt_financing").kind, "bridge_round");
  assert.equal(k("series_a", "seed").severity, "alert");
  assert.equal(k("seed", "convertible_note").severity, "alert"); // a bridge after a priced seed
  assert.equal(k("pre_seed", "convertible_note").severity, "note"); // a note before a priced seed is ordinary financing
  assert.equal(k("seed", "series_a").severity, "good");
  const ext = fundingSignals(c, [{ field: "funding.last_fundraise_date", type: "changed", from: "2026-01-01", to: "2026-09-01" }], { funding: { last_round_type: "series_a" } })[0];
  assert.match(ext.text, /^Extension: Series A/);
  assert.equal(ext.severity, "note"); // only the date moved: could be Crustdata correcting it
  assert.equal(fundingSignals(c, [{ field: "funding.last_fundraise_date", type: "changed", from: "2026-03-01", to: "2024-11-01" }], {}).length, 0);
  assert.deepEqual(fundingSignals(c, [{ field: "funding.investors", type: "added", new_elements: "Sequoia Capital" }], {}).map(s => s.text), ["New investors on the cap table: Sequoia Capital"]);
});

test("acquired is one alert, not two; a secondary sale is a note", () => {
  const acq = fundingSignals(c, [{ field: "funding.acquired_by", type: "added", new_elements: [{ name: "BigCo" }] }, { field: "basic_info.status", type: "changed", from: "active", to: "acquired" }], {});
  assert.deepEqual(acq.map(x => x.kind), ["acquired"]);
  const sec = fundingSignals(c, [{ field: "funding.last_round_type", type: "changed", from: "series_b", to: "secondary_market" }], {});
  assert.equal(sec[0].severity, "note");
  assert.match(sec[0].text, /^Secondary sale recorded/);
});

test("news: the company must be the subject; the first kind of word after its name decides; old articles wait", () => {
  const now = new Date("2026-10-26T00:00:00Z");
  const one = (title: string, date = "2026-10-24", co = c) => newsSignals(co, [{ field: "news", type: "added", new_elements: [{ article_title: title, article_url: `https://news.example/${encodeURIComponent(title)}`, article_publish_date: date }] }], now)[0];
  const sev = (title: string, date?: string) => one(title, date)?.severity;
  for (const t of ["Acme lays off 20% of staff", "Acme cuts 30% of its workforce", "Acme files for Chapter 11", "Acme announces reduction in force", "Acme misses payroll", "Layoffs sweep retail; Acme lays off 20%", "Acme raises a down round at a lower valuation",
    "Acme raises $5M bridge from existing investors", "Acme valuation slashed in new round", "Acme trims workforce by 15%", "Acme reduces headcount by 20%", "Acme furloughs staff", "Acme to shut down", "Acme shuts down operations"]) assert.equal(sev(t), "alert", t);
  for (const t of ["Retailer lays off 300; suppliers including Acme watch", "Acme sunsets its legacy API", "Acme is on a list of tools", "Acme launches tool to help teams restructure debt",
    "Acme shuts down its legacy API", "Acme fired up over new launch", "Acme rival Beta lays off 30%", "Acme parent company lays off staff", "Acme launches Bridge, a payments product"]) assert.equal(sev(t), "news", t);
  assert.equal(sev("Acme raises $20M to help retailers avoid layoffs"), "good");
  assert.equal(sev("Rival sues Acme over patents"), "news"); // Acme is the object, not the subject: digest only
  assert.equal(sev("Acme sued by rival over patents"), "note");
  assert.equal(sev("Acme shuts down its hardware line", "2026-07-01"), "news");
  assert.equal(one("Front-line workers laid off at a retailer", undefined, { domain: "front.example", name: "Front" }), undefined);
  assert.equal(one("Example Corp cuts jobs across Europe"), undefined); // does not name the company: dropped
  assert.match(one("Acme raises $20M").text, /^In the news \(Oct 24\): /);
  // Two portfolio companies in one story each get it.
  const art = [{ field: "news", type: "added", new_elements: [{ article_title: "Acme acquires Beta", article_url: "https://news.example/ab", article_publish_date: "2026-10-24" }] }];
  assert.notEqual(newsSignals(c, art, now)[0].key, newsSignals({ domain: "beta.example", name: "Beta" }, art, now)[0].key);
});

test("hiring: stopped needs two zero readings after 3+ roles; jump and slowdown compare with about 4 weeks back", () => {
  const r = (pairs: [string, number][]) => pairs.map(([d, roles]) => ({ at: `${d}T07:00:00Z`, roles }));
  const k = (pairs: [string, number][]) => hiringSignals(c, r(pairs), t, "careers page").map(s => s.kind);
  assert.deepEqual(k([["2026-10-12", 5], ["2026-10-19", 0], ["2026-10-26", 0]]), ["hiring_stopped"]);
  assert.deepEqual(k([["2026-10-05", 5], ["2026-10-12", 0], ["2026-10-19", 0], ["2026-10-26", 0]]), []); // already reported
  assert.deepEqual(k([["2026-10-19", 5], ["2026-10-26", 0]]), []);
  assert.deepEqual(k([["2026-10-12", 2], ["2026-10-19", 0], ["2026-10-26", 0]]), []);
  assert.deepEqual(k([["2026-09-28", 6], ["2026-10-19", 9], ["2026-10-26", 15]]), ["hiring_jump"]);
  assert.deepEqual(k([["2026-09-28", 3], ["2026-10-26", 7]]), []); // doubled, but only 4 more
  assert.deepEqual(k([["2026-09-28", 20], ["2026-10-26", 8]]), ["hiring_slowed"]);
  assert.deepEqual(k([["2026-09-21", 0], ["2026-10-05", 0], ["2026-10-19", 0], ["2026-10-26", 4]]), ["hiring_started"]);
  assert.deepEqual(k([["2026-10-19", 0], ["2026-10-26", 4]]), []); // one quiet week is not a quiet stretch
});

test("round 2 fixes: object headlines, date corrections, undisclosed rounds, monthly hiring, short domain stems", () => {
  const now = new Date("2026-10-26T00:00:00Z");
  const one = (title: string, co = c) => newsSignals(co, [{ field: "news", type: "added", new_elements: [{ article_title: title, article_url: `https://news.example/${encodeURIComponent(title)}`, article_publish_date: "2026-10-24" }] }], now)[0];
  assert.equal(one("Layoffs hit Acme as funding dries up").severity, "alert");
  assert.equal(one("Google acquires Acme for $2B").kind, "acquired");
  assert.equal(one("Stripe to buy Acme").severity, "alert");
  assert.equal(one("Why startups go bankrupt", { domain: "go.example", name: "Gopher Labs" }), undefined);
  const fix = (from: string, to: string) => fundingSignals(c, [{ field: "funding.last_fundraise_date", type: "changed", from, to }], { funding: { last_round_type: "series_a" } });
  assert.equal(fix("2025-01-10", "2025-01-24").length, 0); // a correction
  assert.equal(fix("2025-01-10", "2025-09-24").length, 1);
  assert.equal(fundingSignals(c, [{ field: "funding.last_round_type", type: "changed", from: "series_a", to: "series_unknown" }], { funding: { last_round_amount_usd: 4e7 } })[0].severity, "good");
  assert.notEqual(fundingSignals(c, [{ field: "funding.last_round_type", type: "changed", from: "seed", to: "series_a" }], { funding: { last_fundraise_date: "2026-10-01" } })[0].key,
    fundingSignals(c, [{ field: "funding.last_round_type", type: "changed", from: "series_a", to: "series_b" }], { funding: { last_fundraise_date: "2026-10-01" } })[0].key);
  const monthly = [{ at: "2026-08-29T07:00:00Z", roles: 0 }, { at: "2026-09-26T07:00:00Z", roles: 0 }, { at: "2026-10-24T07:00:00Z", roles: 5 }];
  assert.deepEqual(hiringSignals(c, monthly, t, "careers page").map(s => s.kind), ["hiring_started"]);
  assert.throws(() => mergeThresholds({ headcount_down: { percent: 150 } }), /100 or less/);
  assert.equal(mergeThresholds({ headcount_down: { _note: "x" } }).headcount_down.percent, 10);
});

test("round 3: asides, other parties, object headlines, executive exits, valuation cuts", () => {
  const now = new Date("2026-10-26T00:00:00Z");
  const sev = (title: string) => newsSignals(c, [{ field: "news", type: "added", new_elements: [{ article_title: title, article_url: `https://news.example/${encodeURIComponent(title)}`, article_publish_date: "2026-10-24" }] }], now)[0]?.severity;
  for (const t of ["Acme, the Stripe rival, lays off 20%", "Acme, fresh off a $50M raise, lays off 20%", "Acme to cut 1,200 jobs", "Acme is cutting 30% of staff", "Acme sheds 40% of its workforce",
    "Acme fires CEO", "Acme founder leaves company", "Acme freezes hiring", "Acme slashes valuation in new round"]) assert.equal(sev(t), "alert", t);
  for (const t of ["Google acquires Acme rival Beta", "Layoffs hit Acme customer Walmart"]) assert.notEqual(sev(t), "alert", t);
  assert.equal(sev("Acme raises $20M to help retailers avoid layoffs"), "good");
});
