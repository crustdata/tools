import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv, readCandidates, readTable } from "../src/input.js";
import { findProfileUrls, normalizeProfileUrl } from "../src/profile-url.js";
import { example } from "./helpers.js";

test("profile URLs: one spelling per person", () => {
  const want = "https://www.linkedin.com/in/example-jane-doe";
  for (const raw of ["linkedin.com/in/Example-Jane-Doe/", "http://uk.linkedin.com/in/example-jane-doe?trk=x", "https://m.linkedin.com/in/example-jane-doe/en", "https://www.linkedin.com/in/example-jane-doe#about", " <https://www.linkedin.com/in/example-jane-doe> "]) {
    assert.equal(normalizeProfileUrl(raw), want, raw);
  }
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/in/jos%C3%A9-example"), "https://www.linkedin.com/in/josé-example");
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/company/example-co"), undefined);
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/posts/example-123"), undefined);
  assert.equal(normalizeProfileUrl("https://example.com/in/jane"), undefined);
  assert.equal(normalizeProfileUrl("not a url"), undefined);
});

test("profile URLs are found inside cells with other links and text", () => {
  assert.deepEqual(findProfileUrls("https://github.com/x,https://www.linkedin.com/in/example-a"), ["https://www.linkedin.com/in/example-a"]);
  assert.deepEqual(findProfileUrls("Linkedin: linkedin.com/in/example-b. | Twitter: https://x.com/b"), ["https://www.linkedin.com/in/example-b"]);
  assert.deepEqual(findProfileUrls("https://www.linkedin.com/in/example-a https://linkedin.com/in/Example-A/"), ["https://www.linkedin.com/in/example-a"]);
});

test("CSV reader: quotes, commas and newlines in cells, CRLF, BOM, semicolons, real line numbers", () => {
  const rows = parseCsv('﻿Name,Note\r\n"Doe, Jane","line one\nline two"\r\n\r\nSam,"say ""hi"""\r\n');
  assert.deepEqual(rows.map(r => r.cells), [["Name", "Note"], ["Doe, Jane", "line one\nline two"], ["Sam", 'say "hi"']]);
  assert.deepEqual(rows.map(r => r.line), [1, 2, 5]);
  assert.deepEqual(parseCsv("a;b\n1,5;2\n").map(r => r.cells), [["a", "b"], ["1,5", "2"]]);
  assert.deepEqual(parseCsv("a\tb\n1\t2").map(r => r.cells), [["a", "b"], ["1", "2"]]);
});

for (const [file, column] of [["ashby-export.csv", "LinkedIn URL"], ["lever-export.csv", "Links"], ["workable-export.csv", "Social profiles"], ["greenhouse-export.xlsx", "Social Media"]] as const) {
  test(`reads a ${file.split("-")[0]} export as it comes`, () => {
    const list = readCandidates(readTable(example(file)));
    assert.equal(list.columns.profileUrl, column);
    assert.equal(list.candidates.length, 10);
    assert.deepEqual(list.duplicates.map(d => [d.line, d.of]), [[12, 2]]);
    const priya = list.candidates[0];
    assert.equal(priya.profileUrl, "https://www.linkedin.com/in/example-priya-example");
    assert.equal(priya.name, "Priya Example");
    assert.equal(priya.email, "priya@example.com");
    assert.equal(priya.job, "Senior Backend Engineer");
    const casey = list.candidates.find(c => c.name === "Casey Emailonly")!;
    assert.equal(casey.profileUrl, undefined);
    assert.equal(casey.email, "casey.emailonly@example.com");
    assert.match(list.candidates.find(c => c.name === "Morgan Nolink")!.problem!, /No profile URL or email/);
  });
}

test("Lever: the owner's email is never taken as the candidate's", () => {
  const list = readCandidates(readTable(example("lever-export.csv")));
  assert.ok(list.candidates.every(c => c.email !== "robin.recruiter@example.com"));
  assert.equal(list.candidates.find(c => c.name === "Morgan Nolink")!.email, undefined);
});

test("no named column: the profile URL is found in any cell; two different URLs is a problem", () => {
  const list = readCandidates({ headers: ["Who", "Notes"], rows: [
    { cells: ["A", "see https://www.linkedin.com/in/example-a"], line: 2 },
    { cells: ["B", "https://www.linkedin.com/in/example-b and https://www.linkedin.com/in/example-c"], line: 3 },
  ] });
  assert.equal(list.columns.scanned, true);
  assert.equal(list.candidates[0].profileUrl, "https://www.linkedin.com/in/example-a");
  assert.match(list.candidates[1].problem!, /2 different profile URLs/);
});

test("wrong files get a plain next step", () => {
  const dir = mkdtempSync(join(tmpdir(), "cva-input-"));
  writeFileSync(join(dir, "old.xls"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  assert.throws(() => readTable(join(dir, "old.xls")), /old Excel \.xls file/);
  writeFileSync(join(dir, "bad.xlsx"), "PK not really");
  assert.throws(() => readTable(join(dir, "bad.xlsx")), /Save it as CSV/);
  assert.throws(() => readTable(join(dir, "missing.csv")), /Cannot find/);
});

test("email columns: any header with email in it, never an owner's or recruiter's", () => {
  const read = (headers: string[]) => readCandidates({ headers, rows: [{ cells: headers.map((_, i) => `p${i}@example.com`), line: 2 }] }).candidates[0].email;
  assert.equal(read(["Name", "E-mail address"]), "p1@example.com");
  assert.equal(read(["Owner Email", "Candidate E-Mail"]), "p1@example.com");
  assert.equal(read(["Recruiter email", "Name"]), undefined);
});

test("a title above the column names, other people's columns, and links that are not public profile URLs", async () => {
  const { withHeader, nonPublicProfileLink } = await import("../src/input.js");
  const t = withHeader([
    { cells: ["Candidates export - Engineering"], line: 1 },
    { cells: ["Exported 2026-11-01"], line: 2 },
    { cells: ["Name", "LinkedIn Profile", "Referred By"], line: 4 },
    { cells: ["Ref Case", "", "https://www.linkedin.com/in/example-referrer"], line: 5 },
    { cells: ["Tool Link", "https://www.linkedin.com/talent/profile/AEMAAABCD123", ""], line: 6 },
  ]);
  assert.equal(t.headerLine, 4);
  const list = readCandidates(t);
  assert.equal(list.candidates[0].name, "Ref Case");
  assert.equal(list.candidates[0].profileUrl, undefined, "a referrer's profile is never taken as the candidate's");
  assert.match(list.candidates[1].problem!, /not a public profile URL/);
  assert.ok(nonPublicProfileLink("linkdin.com/in/someone"));
  assert.ok(nonPublicProfileLink("https://www.linkedin.com/in/"));
  assert.equal(nonPublicProfileLink("https://www.linkedin.com/in/example-a"), undefined);
  assert.equal(withHeader([{ cells: ["a", "b"], line: 1 }]).noKnownHeaders, true);
});

test("member id slugs keep their case; other slugs are lowercased", () => {
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/in/ACoAAB1234xyZ/"), "https://www.linkedin.com/in/ACoAAB1234xyZ");
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/in/Jane-Doe"), "https://www.linkedin.com/in/jane-doe");
});

test("file encodings: UTF-16 and Windows-1252 keep their accents; a CSV starting with PK is still a CSV", async () => {
  const { decodeText } = await import("../src/input.js");
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Name\nJosé", "utf16le")])), "Name\nJosé");
  assert.equal(decodeText(Buffer.from([0x4a, 0x6f, 0x73, 0xe9])), "José");
  assert.equal(decodeText(Buffer.from([0x00, 0x01, 0x02])), undefined);
  const dir = mkdtempSync(join(tmpdir(), "cva-input-"));
  writeFileSync(join(dir, "pk.csv"), "PK Name,Profile URL\nA,https://www.linkedin.com/in/example-a\n");
  assert.equal(readCandidates(readTable(join(dir, "pk.csv"))).candidates[0].profileUrl, "https://www.linkedin.com/in/example-a");
});

test("profile URL edge cases: the name search page is not a person; parentheses stay in a slug", () => {
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/pub/dir/Jane/Doe"), undefined);
  assert.deepEqual(findProfileUrls("https://www.linkedin.com/in/jane-doe-(she-her)"), ["https://www.linkedin.com/in/jane-doe-(she-her)"]);
});

test("a data cell named like a header is not taken for the header row", async () => {
  const { withHeader } = await import("../src/input.js");
  const t = withHeader([
    { cells: ["Candidate Full Name", "LinkedIn Profile Link", "Mail", "Lead Source"], line: 1 },
    { cells: ["Gus Hale", "https://www.linkedin.com/in/example-gus", "gus@example.com", "Referral"], line: 2 },
    { cells: ["Ida Moss", "https://www.linkedin.com/in/example-ida", "ida@example.com", "LinkedIn"], line: 3 },
  ]);
  assert.equal(t.rows.length, 2);
});

test("URLs copied from a profile's subpages, Lead columns in CRM exports, semicolon files with a title line", async () => {
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/in/jane-doe/overlay/contact-info/"), "https://www.linkedin.com/in/jane-doe");
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/in/jane-doe-1234abc/details/experience/"), "https://www.linkedin.com/in/jane-doe-1234abc");
  const crm = readCandidates({ headers: ["Lead Name", "Lead Email", "Lead LinkedIn URL", "Company"], rows: [{ cells: ["Jane Doe", "jane@example.com", "https://www.linkedin.com/in/example-jane", "Acme"], line: 2 }] });
  assert.equal(crm.candidates[0].profileUrl, "https://www.linkedin.com/in/example-jane");
  const { csvDelimiter, withHeader, parseCsv } = await import("../src/input.js");
  const text = "Candidates report\nExported 2026-11-01\n\nName;Source;LinkedIn\nJane;Referral;https://www.linkedin.com/in/example-jane\n";
  assert.equal(csvDelimiter(text), ";");
  const firstRowIsCandidate = withHeader([{ cells: ["Applicant Full Name", "Source", "Socials"], line: 1 }, { cells: ["Jane Doe", "LinkedIn", ""], line: 2 }]);
  assert.equal(firstRowIsCandidate.rows.length, 1, "a candidate row is never taken for the header");
  void parseCsv;
});

test("an unclosed quote is reported with its line; a quote inside a cell is fine", async () => {
  const { unclosedQuoteLine } = await import("../src/input.js");
  assert.equal(unclosedQuoteLine('Name,Note\nA,"open\nB,x\n'), 2);
  assert.equal(unclosedQuoteLine('Name,Height\nA,5\'10"\nB,"ok, quoted"\n'), undefined);
});
