import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, findEmails, normalizeProfileUrl, parseList, parseNameLine, splitCsvLine } from "../src/input.js";

test("profile URLs are normalised to one form", () => {
  const want = "https://www.linkedin.com/in/example-jane-doe";
  for (const raw of ["https://www.linkedin.com/in/example-jane-doe", "linkedin.com/in/Example-Jane-Doe/", "http://uk.linkedin.com/in/example-jane-doe?trk=abc#x", " <https://www.linkedin.com/in/example-jane-doe/> "]) {
    assert.equal(normalizeProfileUrl(raw), want, raw);
  }
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/in/j%C3%B6rg-example"), "https://www.linkedin.com/in/j%C3%B6rg-example");
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/in/jörg-example"), "https://www.linkedin.com/in/j%C3%B6rg-example");
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/company/acme"), null);
  assert.equal(normalizeProfileUrl("https://example.com/in/jane"), null);
});

test("emails are found in invite-style text, several per line, lowercased, once each", () => {
  assert.deepEqual(findEmails("Jane Doe <Jane@Acme.com>, sam@globex.io; jane@acme.com"), ["jane@acme.com", "sam@globex.io"]);
  assert.deepEqual(findEmails("mailto:ana@initech.co.uk."), ["ana@initech.co.uk"]);
  assert.deepEqual(findEmails("not an email @ all"), []);
});

test("names with a company in several common forms", () => {
  assert.deepEqual(parseNameLine("Jane Doe, Acme"), { name: "Jane Doe", company: "Acme" });
  assert.deepEqual(parseNameLine("Jane Doe at acme.com"), { name: "Jane Doe", company: "acme.com" });
  assert.deepEqual(parseNameLine("Jane Doe @ Acme Corp"), { name: "Jane Doe", company: "Acme Corp" });
  assert.deepEqual(parseNameLine("Jane Doe (Acme)"), { name: "Jane Doe", company: "Acme" });
  assert.deepEqual(parseNameLine("Zoë Ångström"), { name: "Zoë Ångström" });
  assert.deepEqual(parseNameLine("Mary-Kate O'Neil - VP Sales"), { name: "Mary-Kate O'Neil - VP Sales" });
  assert.equal(parseNameLine("123456"), null);
});

test("classify tells URLs, emails and names apart and explains what it rejects", () => {
  assert.equal(classify("https://www.linkedin.com/in/example-jane-doe").inputs[0].kind, "url");
  assert.equal(classify("jane@acme.com").inputs[0].kind, "email");
  assert.equal(classify("a@x.com, b@y.com").inputs.length, 2);
  assert.equal(classify("Jane Doe, Acme").inputs[0].kind, "name");
  assert.match(classify("https://www.linkedin.com/company/acme").reason ?? "", /not a person's profile URL/);
  assert.match(classify("https://acme.com/team").reason ?? "", /not a person's profile URL/);
  assert.match(classify("jane@acme").reason ?? "", /not a valid address/);
});

test("CSV line splitting honours quotes", () => {
  assert.deepEqual(splitCsvLine('"Doe, Jane",jane@acme.com,"Acme ""Labs"""', ","), ["Doe, Jane", "jane@acme.com", 'Acme "Labs"']);
});

test("a CRM export with First Name and Last Name, a BOM and a skipped row keeps real line numbers", () => {
  const csv = "﻿First Name,Last Name,Email,Company Name\nJane,Doe,jane@acme.com,Acme\nSam,Lee,,Globex\n,,,\n42,,,\nJane,Doe,JANE@acme.com,Acme\n";
  const { inputs, skipped } = parseList(csv);
  assert.deepEqual(inputs.map(i => i.kind), ["email", "name"]);
  assert.deepEqual(inputs[1], { kind: "name", raw: "Sam Lee, Globex", name: "Sam Lee", company: "Globex" });
  assert.equal(inputs[0].raw, "jane@acme.com");
  assert.deepEqual(skipped.map(s => s.line), [5]);
});

test("semicolon CSV with a profile URL column, and a plain list with comments", () => {
  const semi = parseList("Name;Profile URL\nJane Doe;https://www.linkedin.com/in/example-jane-doe/\nSam;https://www.linkedin.com/company/acme\n");
  assert.equal(semi.inputs[0].kind, "url");
  assert.match(semi.skipped[0].reason, /not a person's profile/);
  assert.equal(semi.skipped[0].line, 3);
  const plain = parseList("# attendees\njane@acme.com\n\nhttps://www.linkedin.com/in/example-sam-lee\nAna Silva, Initech\n???\n");
  assert.deepEqual(plain.inputs.map(i => i.kind), ["email", "url", "name"]);
  assert.deepEqual(plain.skipped.map(s => s.line), [6]);
});
