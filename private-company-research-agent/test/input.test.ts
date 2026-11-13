import { test } from "node:test";
import assert from "node:assert/strict";
import { CsvError, isFreeMail, looksBinary, normalizeDomain, notASite, parseCsv, parseDeals, sniffDelimiter } from "../src/input.js";

test("normalizeDomain: websites, emails and junk", () => {
  assert.equal(normalizeDomain("https://www.Acme.com/pricing?x=1"), "acme.com");
  assert.equal(normalizeDomain("acme.com"), "acme.com");
  assert.equal(normalizeDomain("jane@acme.co.uk"), "acme.co.uk");
  assert.equal(normalizeDomain("acme.com:443"), "acme.com");
  assert.equal(normalizeDomain("  <https://acme.io/>, "), "acme.io");
  assert.equal(normalizeDomain("app.acme.com"), "app.acme.com");
  assert.equal(normalizeDomain("www2.acme.com"), "acme.com");
  assert.equal(normalizeDomain("Acme Inc"), undefined);
  assert.equal(normalizeDomain("192.168.0.1"), undefined);
  assert.equal(normalizeDomain(""), undefined);
  assert.equal(normalizeDomain("acme"), undefined);
});

test("parseCsv keeps quoted commas and line breaks, and real line numbers", () => {
  const rows = parseCsv('name,domain\n"Acme, Inc",acme.com\n"Multi\nline",multi.com\nlast,last.com', ",");
  assert.deepEqual(rows.map(r => r.cells[1]), ["domain", "acme.com", "multi.com", "last.com"]);
  assert.equal(rows[1].cells[0], "Acme, Inc");
  assert.equal(rows[2].line, 3);
  assert.equal(rows[3].line, 5);
});

test("sniffDelimiter finds semicolons from European Excel", () => {
  assert.equal(sniffDelimiter("Name;Website\nAcme;acme.com"), ";");
  assert.equal(sniffDelimiter("Name\tWebsite"), "\t");
  assert.equal(sniffDelimiter("acme.com"), ",");
});

test("parseDeals reads HubSpot, Salesforce, Attio and Affinity exports", () => {
  const hubspot = parseDeals("﻿Company name,Company Domain Name\r\nAcme,acme.com\r\n");
  assert.deepEqual(hubspot.rows.map(r => [r.domain, r.name]), [["acme.com", "Acme"]]);
  assert.equal(hubspot.column, "Company Domain Name");
  assert.deepEqual(parseDeals("Account Name;Website\nAcme;https://www.acme.com/\n").rows.map(r => r.domain), ["acme.com"]);
  assert.deepEqual(parseDeals('Record,Domains\nAcme,"acme.com, acme.io"\n').rows.map(r => r.domain), ["acme.com"]);
  assert.deepEqual(parseDeals("Organization Name,Organization Domain\nAcme,acme.com\n").rows.map(r => r.domain), ["acme.com"]);
});

test("parseDeals: a plain list, duplicates, founder emails, personal email and bad rows", () => {
  const plain = parseDeals("acme.com\nhttps://beta.io\nacme.com\n");
  assert.deepEqual(plain.rows.map(r => r.domain), ["acme.com", "beta.io"]);
  assert.deepEqual(plain.duplicates, [{ line: 3, domain: "acme.com", firstLine: 1 }]);

  const list = parseDeals("Company,Website,Founder Email\nA,,ann@alpha.dev\nB,,bob@gmail.com\nC,not a site,\nD,delta.com,\n");
  assert.deepEqual(list.rows.map(r => r.domain), ["alpha.dev", "delta.com"]);
  assert.deepEqual(list.skipped.map(s => s.line), [3, 4]);
  assert.match(list.skipped[0].reason, /personal email/);
});

test("parseDeals says when there is no domain column", () => {
  const r = parseDeals("Company,Stage\nAcme,Inbound\n");
  assert.equal(r.rows.length, 0);
  assert.match(r.skipped[0].reason, /no website, domain or email column/);
});

test("looksBinary catches Excel files", () => {
  assert.match(looksBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]), "deals.csv")!, /spreadsheet file/);
  assert.match(looksBinary(new Uint8Array([1, 2]), "deals.xlsx")!, /CSV UTF-8/);
  assert.equal(looksBinary(Buffer.from("domain\nacme.com"), "deals.csv"), undefined);
});

test("an unclosed quote is an error naming its line, not a silently shorter list", () => {
  const rows = ["Company,Website", ...Array.from({ length: 40 }, (_, i) => `C${i},c${i}.com`), '"Broken,broken.com', ...Array.from({ length: 59 }, (_, i) => `D${i},d${i}.com`)];
  assert.throws(() => parseDeals(rows.join("\n")), (e: unknown) => e instanceof CsvError && /Line 42 opens a quote/.test((e as Error).message));
});

test("links to decks, profiles and hosted pages are not company websites; the founder email is used instead", () => {
  assert.match(notASite("docsend.com", true)!, /link to a file, a profile or a hosted page/);
  for (const d of ["gamma.app", "cal.com", "pitch.com", "coda.io", "linktr.ee", "airtable.com", "docsend.com"]) assert.equal(notASite(d), undefined, `${d} as a bare domain is a company`);
  assert.match(notASite("linkedin.com")!, /link/);
  assert.match(notASite("delta.notion.site")!, /notion\.site/);
  assert.equal(notASite("acme.com"), undefined);
  const r = parseDeals("Company,Website,Founder Email\nTiny,https://github.com/tinytool,ann@tinytool.dev\nDeck,https://docsend.com/view/abc,\nReal,real.io,\n");
  assert.deepEqual(r.rows.map(x => x.domain), ["tinytool.dev", "real.io"]);
  assert.match(r.skipped[0].reason, /docsend\.com is a link/);
  assert.equal(r.skipped[0].name, "Deck");
  const li = parseDeals("Company,LinkedIn URL,Email\nAcme,https://www.linkedin.com/company/example-acme,a@acme.com\n");
  assert.deepEqual(li.rows.map(x => x.domain), ["acme.com"], "a profile-link column is never the website column");
});

test("personal email providers in every country; international and zero-width domains", () => {
  for (const d of ["yahoo.co.uk", "hotmail.fr", "outlook.de", "gmx.de", "web.de", "pm.me"]) assert.ok(isFreeMail(d), d);
  assert.equal(isFreeMail("acme.co.uk"), false);
  assert.equal(normalizeDomain("münchen.de"), "xn--mnchen-3ya.de");
  assert.equal(normalizeDomain("xn--mnchen-3ya.de"), "xn--mnchen-3ya.de");
  assert.equal(normalizeDomain("acme.com\u200b"), "acme.com");
  assert.equal(normalizeDomain("ａｃｍｅ.com"), "acme.com");
});

test("every input column is kept for the comparison CSV", () => {
  const r = parseDeals("Record ID,Company,Website,Owner\n101,Acme,acme.com,Ann\n");
  assert.deepEqual(r.rows[0].fields, { "Record ID": "101", Company: "Acme", Website: "acme.com", Owner: "Ann" });
});

test("university and government domains from a founder's email are skipped, with the source named", () => {
  const r = parseDeals("Company,Website,Founder Email\nDelta,,ann@stanford.edu\nIota,,x@protonmail.ch\nGov,,a@nhs.gov.uk\nReal,,b@real.io\n");
  assert.deepEqual(r.rows.map(x => [x.domain, x.source]), [["real.io", "email"]]);
  assert.match(r.skipped[0].reason, /stanford\.edu is a university or government domain.*\(from the founder's email\)/);
  assert.match(r.skipped[1].reason, /protonmail\.ch is a personal email provider/);
  assert.match(parseDeals("Company,Stage\nAcme,Inbound\n").skipped[0].reason, /columns: Company, Stage\)\. Add a column named website/);
});

test("round 2 engineer: a domain in the first row is data, duplicate column names stay apart, gamma.app in a CSV is a company", () => {
  const r = parseDeals("urlbox.io\nacme.com\n");
  assert.deepEqual(r.rows.map(x => x.domain), ["urlbox.io", "acme.com"]);
  const d = parseDeals("Company,Email,Email\nAcme,a@acme.com,b@other.com\n");
  assert.deepEqual(Object.keys(d.rows[0].fields!), ["Company", "Email", "Email (2)"]);
  const g = parseDeals("Company,Website\nGamma,https://gamma.app\nDeck,https://gamma.app/docs/abc\n");
  assert.deepEqual(g.rows.map(x => x.domain), ["gamma.app"]);
  assert.match(g.skipped[0].reason, /gamma\.app is a link/);
});

test("round 3 engineer: a header-less file whose first row has a name with url or domain in it; repeated header names; live.ai", () => {
  assert.deepEqual(parseDeals("acme.com,Hurley Inc\nbeta.io,Beta\ngamma.ai,Gamma\n").rows.map(r => r.domain), ["acme.com", "beta.io", "gamma.ai"]);
  assert.deepEqual(Object.keys(parseDeals("Company,Email,Email,Email (2)\nA,a@acme.com,b@beta.io,c@gamma.ai\n").rows[0].fields!), ["Company", "Email", "Email (2)", "Email (2) (2)"]);
  assert.equal(isFreeMail("live.ai"), false);
  assert.equal(isFreeMail("yahoo.co.jp"), true);
});
