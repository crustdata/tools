import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, detectDelimiter, isExcel, parseCsv, readCsv, readList, toCsv } from "../lib/csv";
import { fixture } from "./helpers";

test("the messy CSV: BOM, semicolons, HubSpot headers, duplicates, a malformed email, a personal email, quotes", () => {
  const d = readCsv(fixture("messy.csv"));
  assert.equal(d.delimiter, ";");
  assert.equal(d.roles.email, "Email Address");
  assert.equal(d.roles.company, "Company");
  assert.equal(d.roles.domain, "Website");
  assert.equal(d.roles.firstName, "First Name");
  assert.equal(d.duplicates, 1, "the second Jane row shares an identifier");
  assert.equal(d.rows.length, 10, "and is kept");
  const lines = Object.fromEntries(d.rows.map(r => [r.line, r]));
  assert.equal(lines[2].id?.value, "jane@acme.example");
  assert.equal(lines[3].id?.value, "sam@acme.example", "upper case and trailing space fixed");
  assert.equal(lines[3].companyId?.value, "acme.example", "website column wins over the email domain");
  assert.equal(lines[5].id?.personal, true);
  assert.match(lines[6].problem ?? "", /Not a valid email/);
  assert.equal(lines[9].id?.kind, "company_name");
  assert.equal(lines[11].cells.Company, "");
  assert.equal(lines[11].cells["First Name"], "Quoted, Name");
  assert.equal(lines[11].cells["Last Name"], 'Says "hi"');
  assert.equal(lines[11].id?.value, "platform.example");
  assert.equal(d.counts.email, 6, "the row that shares Jane's email still counts");
  assert.equal(d.counts.unusable, 1);
});

test("a profile URL header is not also read as the website column", () => {
  const d = readCsv("Name,Profile URL\nJane,https://www.linkedin.com/in/example-jane-doe\n");
  assert.equal(d.roles.profileUrl, "Profile URL");
  assert.equal(d.roles.domain, undefined);
  assert.equal(d.rows[0].id?.kind, "profile_url");
  assert.equal(d.rows[0].companyId, undefined);
});

test("Salesforce, Attio and Sheets style headers are recognised", () => {
  assert.equal(readCsv("Account Name,Website\nAcme,acme.example\n").roles.company, "Account Name");
  assert.equal(readCsv("Full Name,Work Email\nJane Doe,jane@acme.example\n").roles.email, "Work Email");
  assert.equal(readCsv("Company Domain Name,LinkedIn URL\nacme.example,\n").roles.profileUrl, "LinkedIn URL");
  assert.equal(readCsv("Primary Work Email\njane@acme.example\n").rows[0].id?.kind, "email");
});

test("a header-less list and a pasted list are read as one column", () => {
  const d = readCsv("jane@acme.example\nacme.example\n");
  assert.equal(d.headers[0], "input");
  assert.equal(d.rows.length, 2);
  assert.equal(d.rows[0].line, 1);
  const l = readList("acme.example, northwind.example\nhttps://www.linkedin.com/in/example-jane-doe");
  assert.deepEqual(l.rows.map(r => r.id?.kind), ["domain", "domain", "profile_url"]);
  assert.equal(readList("Acme Analytics\nacme.example").rows[0].id?.kind, "company_name");
  assert.equal(readCsv("Thing,Other\nAcme Analytics,hello\n").rows[0].id, undefined, "two unrecognised columns do not turn text into company names");
});

test("a row with an unknown header still finds an identifier in any cell", () => {
  const d = readCsv("Thing,Other\nhello,jane@acme.example\n");
  assert.equal(d.rows[0].id?.value, "jane@acme.example");
});

test("tabs, CRLF and quoted newlines parse; separators inside quotes do not pick the delimiter", () => {
  assert.equal(detectDelimiter("a\tb\n1\t2\n"), "\t");
  assert.deepEqual(parseCsv('a,b\r\n"x\ny",2\r\n'), [["a", "b"], ["x\ny", "2"]]);
  assert.equal(detectDelimiter('email,industries\na@acme.example,"Software; SaaS; B2B; Cloud; AI; Data"\n'), ",");
  const d = readCsv('Email,Industries\na@acme.example,"Software; SaaS; B2B"\n');
  assert.equal(d.rows[0].id?.value, "a@acme.example");
});

test("repeated headers are kept apart and a __proto__ header is harmless", () => {
  const d = readCsv("email,email\na@x.example,b@y.example\n");
  assert.deepEqual(d.headers, ["email", "email (2)"]);
  assert.equal(d.rows[0].cells["email (2)"], "b@y.example");
  const p = readCsv("__proto__,Email\nx,a@x.example\n");
  assert.equal(p.rows[0].cells["__proto__"], "x");
  assert.equal(({} as any).polluted, undefined);
});

test("a pasted list splits on commas only between identifiers, so 'Acme, Inc' stays one name", () => {
  assert.deepEqual(readList("Acme, Inc\nacme.example, northwind.example").rows.map(r => r.id?.value), ["Acme, Inc", "acme.example", "northwind.example"]);
});

test("columns written by an earlier export never claim a role when the file comes back in", () => {
  const d = readCsv("Email,Profile URL (Crustdata),_match_status\na@acme.example,https://www.linkedin.com/in/example-jane-doe,matched\n");
  assert.equal(d.rows[0].id?.kind, "email");
});

test("output cells are quoted and never start a formula", () => {
  assert.equal(csvCell('say "hi", now'), '"say ""hi"", now"');
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvCell(-5), "-5");
  assert.equal(toCsv(["a"], [["x"]]), "a\nx\n");
});

test("an Excel file is recognised from its first bytes", () => {
  assert.equal(isExcel(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), true);
  assert.equal(isExcel(new TextEncoder().encode("a,b\n1,2")), false);
});
