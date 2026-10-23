import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOutput, outcome, rowStatusText } from "../lib/export";
import { parseCsv } from "../lib/csv";
import { fixture, runCsv } from "./helpers";

test("the enriched CSV keeps the original columns, adds the new ones and the three status columns", async () => {
  const { detected, columns, result } = await runCsv(fixture("messy.csv"));
  const out = buildOutput(detected.rows, columns, result.cells, result.status, detected.headers);
  const rows = parseCsv(out.enrichedCsv, ",");
  assert.deepEqual(rows[0].slice(0, 5), ["First Name", "Last Name", "Email Address", "Company", "Website"]);
  assert.deepEqual(rows[0].slice(-3), ["_match_status", "_match_confidence", "_source_row"]);
  assert.equal(rows[0].includes("Company name"), true);
  const jane = rows[1];
  assert.equal(jane[0], "Jane");
  assert.equal(jane.at(-1), "2");
  assert.equal(jane.at(-3), "matched");
  assert.equal(jane.at(-2), "1");
  assert.equal(rows.length - 1, detected.rows.length, "every input row is in the output");
  const un = parseCsv(out.unresolvedCsv, ",");
  assert.deepEqual(un[0].slice(0, 3), ["_source_row", "_match_status", "reason"]);
  // Unresolved: Lee (no employer on the profile), the broken email, nobody (person not found), Zzqx (ambiguous), hidden (redacted), platform.example (not found).
  assert.equal(out.unresolved, 6);
  assert.equal(out.matched, 4);
  assert.ok(un.some(r => r[0] === "6" && /Not a valid email/.test(r[2])));
  assert.ok(!un.some(r => r[0] === "11" && /person/.test(r[1])), "a domain-only row is not judged on person columns");
  assert.equal(out.json.length, detected.rows.length);
});

test("a column that already exists in the input gets a suffix instead of overwriting", async () => {
  const { detected, columns, result } = await runCsv("Name,Website\nAcme,acme.example\n", ["company.name"]);
  const out = buildOutput(detected.rows, columns, result.cells, result.status, detected.headers);
  assert.match(out.enrichedCsv.split("\n")[0], /Company name/);
  const d2 = await runCsv("Company name,Website\nAcme,acme.example\n", ["company.name"]);
  assert.match(buildOutput(d2.detected.rows, d2.columns, d2.result.cells, d2.result.status, d2.detected.headers).enrichedCsv.split("\n")[0], /Company name \(Crustdata\)/);
});

test("row status text reads plainly and judges only the entities a row can reach", () => {
  const email = { line: 2, cells: {}, id: { kind: "email" as const, value: "jane@acme.example", personal: false } };
  const gmail = { line: 3, cells: {}, id: { kind: "email" as const, value: "lee@gmail.com", personal: true } };
  const domain = { line: 4, cells: {}, id: { kind: "domain" as const, value: "acme.example" } };
  assert.equal(rowStatusText(email, { person: "matched", company: "matched" }, true, true), "matched");
  assert.equal(rowStatusText(email, { person: "not_found", company: "matched" }, true, true), "person not found; company matched");
  assert.equal(rowStatusText(gmail, { person: "matched", company: "matched" }, true, true), "matched (personal email)");
  assert.equal(rowStatusText(domain, { person: "no_identifier", company: "ambiguous" }, true, true), "company ambiguous");
  assert.equal(rowStatusText(domain, { person: "no_identifier", company: "matched" }, true, true), "matched");
  assert.equal(rowStatusText(email, undefined, true, true), "not run");
  assert.equal(outcome(domain, { person: "no_identifier", company: "matched" }, true, true), "matched");
  assert.equal(outcome(email, { person: "not_found", company: "matched" }, true, true), "partial", "a work email row's company comes from the domain, so it still counts");
  const url = { line: 5, cells: {}, id: { kind: "profile_url" as const, value: "https://www.linkedin.com/in/example-x" } };
  assert.equal(outcome(url, { person: "not_found" }, true, true), "unresolved", "a profile row whose person was not found is not judged on the company it cannot reach");
  assert.equal(outcome(email, { person: "matched", company: "not_found" }, true, true), "partial");
});

test("rows that share an identifier are all kept and all filled", async () => {
  const { detected, columns, result } = await runCsv("First Name,Website\nJane,acme.example\nSam,acme.example\nRita,acme.example\n", ["company.name", "company.funding_total"]);
  assert.equal(detected.rows.length, 3);
  assert.equal(detected.duplicates, 2);
  const out = buildOutput(detected.rows, columns, result.cells, result.status, detected.headers);
  const rows = parseCsv(out.enrichedCsv, ",");
  assert.equal(rows.length, 4);
  assert.ok(rows.slice(1).every(r => r[2] === "Acme Analytics"));
  assert.equal(result.cost.credits, 2, "one company profile for three rows");
});

test("export headers collide without case, and the meta columns are protected too", async () => {
  const d = await runCsv("Company Name,Website,_match_status\nAcme,acme.example,old\n", ["company.name"]);
  const header = buildOutput(d.detected.rows, d.columns, d.result.cells, d.result.status, d.detected.headers).enrichedCsv.split("\n")[0];
  assert.match(header, /Company name \(Crustdata\)/);
  assert.match(header, /_match_status \(Crustdata\)/);
  assert.equal(d.detected.roles.domain, "Website");
});
