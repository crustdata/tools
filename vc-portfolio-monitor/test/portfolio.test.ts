import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDomain, normalizeProfileUrl, parseCsv, readPortfolioCsv, readSource, sheetCsvUrl, unresolvedCsv } from "../src/portfolio.js";

test("reads CRM-style columns, semicolons and a byte order mark", () => {
  const p = readPortfolioCsv("﻿Organization Name;Website;Deal Lead;Founders\nNorthwind;https://www.Northwind.example/about;Priya Shah;https://uk.profiles.example/in/Example-Dana/ https://www.profiles.example/in/example-lee\n");
  assert.equal(p.rows.length, 1);
  assert.deepEqual(p.rows[0], { line: 2, name: "Northwind", domain: "northwind.example", owner: "Priya Shah", careers: undefined, leaders: ["https://www.profiles.example/in/example-dana", "https://www.profiles.example/in/example-lee"] });
});

test("a bad website cell falls back to the name with a note; unusable rows are skipped with the line number", () => {
  const p = readPortfolioCsv('company,website\nA,a.example\n"B, Inc.",https://www.profiles.example/company/b\nC,not a site\n,\nA again,A.EXAMPLE\nNameOnly,n/a\nd.example,\n,https://www.profiles.example/company/x\nTwo,"two.example, two.io"\n');
  assert.deepEqual(p.rows.map(r => [r.line, r.name ?? null, r.domain ?? null]), [[2, "A", "a.example"], [3, "B, Inc.", null], [4, "C", null], [7, "NameOnly", null], [8, null, "d.example"], [10, "Two", "two.example"]]);
  assert.deepEqual(p.skipped.map(s => s.line), [9]);
  assert.equal(p.duplicates, 1);
  assert.ok(p.notes.some(n => /Line 3: the website cell holds a profile or directory page/.test(n)));
});

test("Affinity exports: Organization Website, Deal Team with several partners, exited rows skipped", () => {
  const p = readPortfolioCsv("Organization Name,Organization Website,Deal Team,Status\nNorthwind,www.northwind.example ,Priya Shah / Sam Lee,Active\nOldCo,oldco.example,Sam Lee,Exited\nGone,gone.example,Sam Lee,Written off\n");
  assert.deepEqual(p.rows.map(r => [r.domain, r.owner]), [["northwind.example", "Priya Shah, Sam Lee"]]);
  assert.deepEqual(p.skipped.map(s => s.line), [3, 4]);
  assert.match(p.skipped[0].reason, /status is "Exited"/);
  assert.equal(p.notes.length, 0);
  assert.match(readPortfolioCsv("Company\nNorthwind\n").notes[0], /No website column found/);
  const st = readPortfolioCsv("company,website,status,owner\nA,a.example,Closed Won,Jo Park <jo@fund.vc>\nB,b.example,Not exited,Smith & Co\nC,c.example,Passed,\nD,d.example,Exit pending,\nE,github.com/e,,\n");
  assert.deepEqual(st.rows.map(r => [r.name, r.domain ?? null, r.owner ?? null]), [["A", "a.example", "Jo Park"], ["B", "b.example", "Smith & Co"], ["D", "d.example", null], ["E", null, null]]);
});

test("a file with no recognisable column says so", () => {
  const p = readPortfolioCsv("foo,bar\n1,2\n");
  assert.equal(p.rows.length, 0);
  assert.match(p.skipped[0].reason, /no column named like a company or website/);
});

test("quoted fields, newlines inside quotes and real line numbers", () => {
  const { rows, lines } = parseCsv('company,notes\n"Acme","line one\nline two"\nBeta,x\n');
  assert.equal(rows[0].notes, "line one\nline two");
  assert.deepEqual(lines, [2, 4]);
});

test("domains and profile URLs normalise", () => {
  assert.equal(normalizeDomain("HTTPS://www.Acme.example/pricing"), "acme.example");
  assert.equal(normalizeDomain("localhost"), null);
  assert.equal(normalizeDomain("10.0.0.1"), null);
  assert.equal(normalizeProfileUrl("uk.profiles.example/in/Jos%C3%A9-X/en/"), "https://www.profiles.example/in/josé-x");
});

test("Google Sheet links become CSV export links, keeping the tab", () => {
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/abc_123/edit#gid=456"), "https://docs.google.com/spreadsheets/d/abc_123/export?format=csv&gid=456");
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pubhtml"), "https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pub?output=csv");
  assert.equal(sheetCsvUrl("https://example.com/sheet"), null);
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/u/1/d/abc/edit"), "https://docs.google.com/spreadsheets/d/abc/export?format=csv");
});

test("readSource: a Sheet that is not shared gets the sharing steps; a CSV is read", async () => {
  const html = (async () => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  await assert.rejects(readSource("https://docs.google.com/spreadsheets/d/abc/edit", html), /Anyone with the link/);
  const csv = (async (u: string) => { assert.match(String(u), /export\?format=csv/); return new Response("company,website\nA,a.example\n", { headers: { "content-type": "text/csv" } }); }) as unknown as typeof fetch;
  assert.match(await readSource("https://docs.google.com/spreadsheets/d/abc/edit", csv), /a\.example/);
  await assert.rejects(readSource("https://example.com/list"), /CSV file, a Google Sheet link/);
  await assert.rejects(readSource("./portfolio.xlsx"), /No portfolio file|spreadsheet file/);
  await assert.rejects(readSource("https://drive.google.com/file/d/x/view"), /Google Drive file/);
  await assert.rejects(readSource("./src"), /is a folder/);
  const evil = (async () => Object.assign(new Response("company\nA\n", { headers: { "content-type": "text/csv" } }), {})) as unknown as typeof fetch;
  // A response that came back from another host after redirects is refused.
  const redirected = (async () => { const r = new Response("company\nA\n", { headers: { "content-type": "text/csv" } }); Object.defineProperty(r, "url", { value: "https://evil.example/x.csv" }); return r; }) as unknown as typeof fetch;
  await assert.rejects(readSource("https://docs.google.com/spreadsheets/d/abc/edit", redirected), /redirected somewhere other than Google/);
  assert.match(await readSource("https://docs.google.com/spreadsheets/d/abc/edit", evil), /company/);
});

test("unresolved rows come back as a CSV to fix", () => {
  const csv = unresolvedCsv([{ row: { line: 3, name: "Linear", leaders: [] }, reason: "3 companies match", candidates: ["linear.app", "linear.fi"] }]);
  assert.equal(csv, "company,website,owner,reason,candidates\nLinear,,,3 companies match,linear.app linear.fi\n");
});
