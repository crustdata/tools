import { test } from "node:test";
import assert from "node:assert/strict";
import { emailIdentifier, identifierFromText, nameKey, normalizeDomain, normalizeEmail, normalizeProfileUrl } from "../lib/normalize";

test("emails are lower-cased and trimmed, and malformed ones rejected", () => {
  assert.equal(normalizeEmail("  Jane@Acme.Example "), "jane@acme.example");
  assert.equal(normalizeEmail("mailto:jane@acme.example"), "jane@acme.example");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("two@@acme.example"), null);
  assert.equal(normalizeEmail("jane@localhost"), null);
  assert.equal(normalizeEmail("Jane Doe <jane@acme.example>"), "jane@acme.example");
  assert.equal(normalizeEmail("jose@müller.de"), "jose@xn--mller-kva.de");
  assert.equal(normalizeEmail("a@-x.example"), null);
});

test("personal email providers are flagged", () => {
  assert.equal(emailIdentifier("lee@gmail.com")?.personal, true);
  assert.equal(emailIdentifier("jane@acme.example")?.personal, false);
});

test("domains lose scheme, www, path, port and case", () => {
  assert.equal(normalizeDomain("https://www.Stripe.com/pricing?x=1"), "stripe.com");
  assert.equal(normalizeDomain("acme.example/"), "acme.example");
  assert.equal(normalizeDomain("http://acme.example:8080"), "acme.example");
  assert.equal(normalizeDomain("Acme Analytics"), null);
  assert.equal(normalizeDomain(""), null);
  assert.equal(normalizeDomain("müller.de"), "xn--mller-kva.de");
  assert.equal(normalizeDomain("-bad-.example"), null);
  assert.equal(normalizeDomain("192.168.0.1"), null);
});

test("profile URLs get one spelling", () => {
  const want = "https://www.linkedin.com/in/example-jane-doe";
  assert.equal(normalizeProfileUrl("linkedin.com/in/example-jane-doe/"), want);
  assert.equal(normalizeProfileUrl("http://WWW.LinkedIn.com/in/example-jane-doe?trk=x"), want);
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/in/example%2Djane%2Ddoe"), want);
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/in/Example-Jane-Doe/details/experience/"), want, "case and detail paths fold into one spelling");
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/in/a%20b"), null, "a slug with a space is not a profile");
  assert.equal(normalizeProfileUrl("https://www.linkedin.com/company/acme"), null);
  assert.equal(normalizeProfileUrl("https://example.com/in/jane"), null);
});

test("pasted lines are read as what they look like", () => {
  assert.equal(identifierFromText("jane@acme.example")?.kind, "email");
  assert.equal(identifierFromText("acme.example")?.kind, "domain");
  assert.equal(identifierFromText("https://www.linkedin.com/in/example-jane-doe")?.kind, "profile_url");
  assert.equal(identifierFromText("Acme Analytics")?.kind, "company_name");
  assert.equal(identifierFromText("   "), null);
});

test("company names compare without suffixes or punctuation", () => {
  assert.equal(nameKey("Acme Analytics, Inc."), nameKey("acme analytics"));
  assert.equal(nameKey("Northwind GmbH"), "northwind");
  assert.equal(nameKey("AB InBev"), "ab inbev", "a suffix word inside a name is kept");
  assert.equal(nameKey("The Co-operative Group"), "co operative group");
});
