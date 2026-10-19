import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, parseCsv } from "../src/csv.js";
import { companyWatchBody, jobWatchBody, shortlistIds } from "../examples/watch-accounts.js";

test("CSV cells: quoting and no formulas", () => {
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-1+1"), "'-1+1");
  assert.equal(csvCell(-8.9), "-8.9");
  assert.equal(csvCell(["a", "b"]), "a; b");
});

test("CSV round trip: quotes, commas and newlines inside cells", () => {
  const row = ['say "hi", ok', "two\nlines", "", "plain"];
  assert.deepEqual(parseCsv(row.map(csvCell).join(",") + "\r\n"), [row]);
});

test("watch example: ids from accounts.csv, rows you deleted stay out", () => {
  const csv = 'name,domain,crustdata id,why matched\n"Acme, Inc",acme.com,101,"rank 1"\nBeta,beta.io,202,rank 2\nBeta again,beta.io,202,dup\n';
  assert.deepEqual(shortlistIds(csv), [101, 202]);
  assert.throws(() => shortlistIds("name,domain\nAcme,acme.com\n"), /no "crustdata id" column/);
});

test("watch example: request bodies follow the watcher docs", () => {
  const slack = [{ type: "slack" as const, webhook_url: "https://hooks.slack.com/services/T/B/X" }];
  const company = companyWatchBody([1, 2], slack);
  assert.deepEqual(company.entities, { crustdata_company_ids: [1, 2] });
  assert.equal(company.config.trigger.type, "interval");
  assert.deepEqual(company.notifications, slack);
  const job = jobWatchBody([1], ["RevOps"], [{ type: "email", to: ["a@b.co"] }]) as any;
  assert.deepEqual(job.filters.conditions[0], { field: "company.basic_info.company_id", type: "in", value: [1] });
  assert.equal(job.filters.conditions[1].conditions.length, 2);
});
