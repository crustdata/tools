import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, readPeopleCsv } from "../src/csv.js";

test("parses quoted fields, escaped quotes, CRLF and a byte order mark", () => {
  const { rows } = parseCsv('﻿name,company\r\n"Doe, Jane","Acme ""Labs"""\r\n');
  assert.deepEqual(rows, [{ name: "Doe, Jane", company: 'Acme "Labs"' }]);
});

test("reads a HubSpot export: first and last name, job title, owner, duplicates, skipped rows", () => {
  const csv = readPeopleCsv([
    "First Name,Last Name,Email,Company Name,Job Title,Contact owner",
    "Jane,Doe,Jane.Doe@Acme.com ,Acme,VP Sales,sam@yourco.com",
    "Jane,Doe,jane.doe@acme.com,Acme,VP Sales,sam@yourco.com",
    "Mei,Lin,,Nowhere,,",
  ].join("\n"));
  assert.deepEqual(csv.people, [{ name: "Jane Doe", email: "jane.doe@acme.com", company: "Acme", title: "VP Sales", owner: "sam@yourco.com", profileUrl: undefined }]);
  assert.equal(csv.duplicates, 1);
  assert.deepEqual(csv.skippedLines, [4]);
});

test("reads Salesforce's Account Name as the company", () => {
  assert.equal(readPeopleCsv("Email,Account Name\na@b.co,Globex\n").people[0].company, "Globex");
});

test("reports the headers it found when nothing is usable", () => {
  const csv = readPeopleCsv("Phone,City\n123,Paris\n");
  assert.equal(csv.people.length, 0);
  assert.deepEqual(csv.headers, ["phone", "city"]);
});

test("reads semicolon-separated exports from European Excel", () => {
  const csv = readPeopleCsv("Email;Associated Company;Owner Name\njane@acme.com;Acme;Sam Lee\n");
  assert.deepEqual(csv.people[0], { email: "jane@acme.com", company: "Acme", owner: "Sam Lee", name: undefined, profileUrl: undefined, title: undefined });
});

test("skipped rows are reported on their real line, after blank lines and multi-line cells", () => {
  const csv = readPeopleCsv('Email,Notes\n\na@b.co,"two\nlines"\n,no email here\n');
  assert.deepEqual(csv.skippedLines, [5]);
});
