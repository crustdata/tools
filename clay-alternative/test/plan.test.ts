import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COLUMNS, resolveColumns } from "../lib/columns";
import { readCsv } from "../lib/csv";
import { describeEstimate, plan } from "../lib/plan";
import { fakeAccount, fixture } from "./helpers";

const cols = (ids: string[]) => resolveColumns(ids).columns;

test("the messy CSV plans one person per unique email and one company per unique domain", () => {
  const d = readCsv(fixture("messy.csv"));
  const p = plan(d.rows, cols(DEFAULT_COLUMNS), fakeAccount());
  assert.deepEqual(p.people.emails.sort(), ["hidden@northwind.example", "jane@acme.example", "lee.nodomain@gmail.com", "nobody@acme.example", "rita@northwind.example", "sam@acme.example"]);
  assert.deepEqual(p.companies.domains.sort(), ["acme.example", "northwind.example", "platform.example"]);
  assert.deepEqual(p.companies.names, ["Zzqx Widgets"]);
  assert.equal(p.estimate.companiesFromPeople, 1, "the personal email row gets its company from the profile");
  assert.equal(p.problems.length, 1);
  assert.equal(p.estimate.usable, 9);
  // 6 people x 1 + (4 + 1) companies x 2 = 16 at list price
  assert.equal(p.estimate.credits, 16);
  assert.equal(p.estimate.listCredits, 16);
  assert.equal(describeEstimate(p.estimate, "shown"), "10 rows (1 without an identifier), 5 companies, 6 people: up to 16 credits");
  assert.equal(describeEstimate(p.estimate, "hidden"), "10 rows (1 without an identifier), 5 companies, 6 people");
});

test("free columns cost nothing and need no person call", () => {
  const d = readCsv(fixture("domains.csv"));
  const p = plan(d.rows, cols(["company.name", "company.headcount", "company.hq"]), fakeAccount());
  assert.equal(p.estimate.credits, 0);
  assert.equal(p.needsCompanyEnrich, false);
  assert.equal(p.needsPersonEnrich, false);
  assert.equal(describeEstimate(p.estimate, "shown"), "4 rows, 4 companies: free");
});

test("the tech stack adds 2 per company and the email column 1 per person, at the account's prices", () => {
  const d = readCsv(fixture("messy.csv"));
  const account = fakeAccount({ prices: { companyEnrich: 1, technographics: 1, personEnrich: 0.5, businessEmail: 0.5, personSearch: 0.03 } });
  const p = plan(d.rows, cols(["person.email", "company.tech_stack"]), account);
  assert.equal(p.estimate.credits, 6 * 0.5 + 6 * 0.5 + 5 * 1 + 5 * 1);
  assert.equal(p.estimate.listCredits, 6 + 6 + 10 + 10);
  assert.match(describeEstimate(p.estimate, "shown"), /up to 16 credits at your prices \(32 at list price\)/);
});

test("without contact access the email column is warned about and not requested", () => {
  const d = readCsv("Email\njane@acme.example\n");
  const p = plan(d.rows, cols(["person.email", "person.title"]), fakeAccount({ emailColumn: false }));
  assert.match(p.warnings[0], /contact data enabled on your Crustdata account; self-serve keys do not have it/);
  assert.ok(!p.personFields.includes("contact.business_emails"));
  assert.equal(p.estimate.credits, 1);
});

test("profile URL rows with company columns count their employers as companies to find", () => {
  const d = readCsv(fixture("profile-urls.csv"));
  const p = plan(d.rows, cols(["company.headcount", "company.funding_total"]), fakeAccount());
  assert.equal(p.people.urls.length, 4);
  assert.equal(p.estimate.companiesFromPeople, 4);
  assert.equal(p.needsPersonEnrich, true, "the person is looked up to find the employer");
  assert.equal(p.estimate.lines.find(l => l.label.includes("employer"))?.count, 4);
});

test("a key without email lookup warns and plans no email calls", () => {
  const d = readCsv("Email\njane@acme.example\n");
  const p = plan(d.rows, cols(["person.title"]), fakeAccount({ emailLookup: false }));
  assert.match(p.warnings[0], /cannot look people up by email/);
});

test("company-only columns on work emails price the worst-case employer lookups", () => {
  const d = readCsv("Email\njane@acme.example\nsam@acme.example\n");
  const p = plan(d.rows, cols(["company.name", "company.headcount"]), fakeAccount());
  assert.equal(p.estimate.credits, 2, "up to one person lookup per email, only when the domain is not the company's own");
  assert.match(p.estimate.note, /worst case/);
});
