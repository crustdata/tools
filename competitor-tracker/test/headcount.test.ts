import assert from "node:assert/strict";
import { test } from "node:test";
import { functionCounts, headcountBaselineItems, headcountItems, spanLabel, type CompanyRecord } from "../src/headcount.js";

const record = (total: number, fns: Record<string, number>, growth?: CompanyRecord["headcount"] extends infer H ? (H extends { growth_percent?: infer G } ? G : never) : never): CompanyRecord => ({
  crustdata_company_id: 1,
  basic_info: { name: "Northwind", primary_domain: "northwind.example", professional_network_url: "https://profiles.example/company/northwind-example" },
  headcount: {
    total,
    growth_percent: growth ?? null,
    by_function_timeseries: { CURRENT_FUNCTION: Object.fromEntries(Object.entries(fns).map(([fn, n]) => [fn, [{ date: "2026-09-01 00:00:00", employee_count: 1 }, { date: "2026-10-01 00:00:00", employee_count: n }]])) },
  },
});

test("functionCounts reads the latest point of every function", () => {
  assert.deepEqual(functionCounts(record(10, { Engineering: 6, Sales: 4 })), { Engineering: 6, Sales: 4 });
  assert.deepEqual(functionCounts(undefined), {});
});

test("spanLabel names the date of the reference record", () => {
  assert.equal(spanLabel("2026-09-28T00:00:00Z"), "since Sep 28");
  assert.equal(spanLabel(undefined), "since the last record");
});

test("meaningful moves are reported, small ones are not", () => {
  const prev = record(200, { Engineering: 60, Sales: 38, Legal: 2 });
  const next = record(215, { Engineering: 75, Sales: 40, Legal: 3 });
  const items = headcountItems(prev, next, "2026-07-01T00:00:00Z", "2026-10-01T00:00:00Z");
  assert.equal(items.length, 2);
  assert.equal(items[0].text, "Headcount up 8% since Jul 1 (200 to 215)");
  assert.equal(items[1].text, "Engineering up 25% since Jul 1 (60 to 75)");
  assert.equal(items[0].why, undefined, "no claim about the total that the data does not support");
  assert.equal(items[1].why, "investing in engineering");
  assert.equal(items[1].url, undefined, "headcount is Crustdata's own data: no outside link");
  assert.deepEqual(headcountItems(prev, record(206, { Engineering: 64, Sales: 39, Legal: 2 })), [], "3% total and 7% engineering are below the bar");
});

test("shrinkage reads as a cut", () => {
  const items = headcountItems(record(100, { Sales: 20 }), record(90, { Sales: 12 }));
  assert.equal(items[0].text, "Headcount down 10% since the last record (100 to 90)");
  assert.equal(items[1].text, "Sales down 40% since the last record (20 to 12)");
  assert.equal(items[1].why, "pulling back on sales");
});

test("no record, no items; tiny functions are ignored", () => {
  assert.deepEqual(headcountItems(undefined, undefined), []);
  assert.deepEqual(headcountItems(record(50, { Legal: 1 }), record(50, { Legal: 2 })), []);
});

test("week one uses the API's own growth figures only when they clear the bar", () => {
  assert.equal(headcountBaselineItems(record(200, {}, { mom: 6, qoq: 12, six_months: 30 }))[0].text, "Headcount up 6% in the last month (now 200)");
  assert.equal(headcountBaselineItems(record(200, {}, { mom: 1, qoq: 12, six_months: 30 }))[0].text, "Headcount up 12% in the last 3 months (now 200)");
  assert.deepEqual(headcountBaselineItems(record(200, {}, { mom: 1, qoq: 2, six_months: 5 })), []);
});
