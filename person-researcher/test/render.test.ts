import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief } from "../src/brief.js";
import { md, renderBrief, renderIndex } from "../src/render.js";

const NOW = new Date("2026-10-23T12:00:00Z");

test("external text cannot open links, HTML or headings in the markdown", () => {
  assert.equal(md("[click](https://evil.example) <script>"), "\\[click\\](https://evil.example) \\<script\\>");
  const b = buildBrief({
    input: "x", matchedBy: "profile URL", now: NOW, days: 180,
    person: { basic_profile: { name: "# Jane [x](https://evil.example)", headline: "a | b" }, experience: { employment_details: { current: [{ name: "Acme", title: "CEO **boss**", start_date: "2020-01-01" }] } } },
  });
  const out = renderBrief(b);
  assert.ok(out.startsWith("# \\# Jane \\[x\\](https://evil.example)"));
  assert.ok(!out.includes("[x](https://evil.example)"));
  assert.ok(out.includes("CEO \\*\\*boss\\*\\*"));
});

test("sections appear only when there is data, and the source line names each endpoint used", () => {
  const b = buildBrief({ input: "x", matchedBy: "work email", now: NOW, days: 180, person: { basic_profile: { name: "Jane Doe" } } });
  const out = renderBrief(b);
  assert.ok(out.includes("## What changed lately"));
  assert.ok(!out.includes("## Recent posts"));
  assert.ok(!out.includes("## In the news"));
  assert.ok(!out.includes("## Contact"));
  assert.match(out, /Sources: profile, career, education and company from Crustdata Person Enrich/);
  assert.ok(!out.includes("Social Post Search"));
  const withContact = renderBrief({ ...b, contact: { business: [], personal: [], phones: [] } });
  assert.match(withContact, /No contact details found \(not charged\)/);
});

test("the index lists done people with their latest change and explains the rest", () => {
  const out = renderIndex([
    { input: "jane@acme.com", status: "done", name: "Jane Doe", title: "CEO at Acme", file: "jane-doe.md", changed: "Joined Acme as CEO in Aug 2026." },
    { input: "x@y.com", status: "not_found", note: "No one found for this email (not charged)." },
  ], "6.5", "2026-10-23");
  assert.match(out, /1 of 2 people researched\. Credits used: 6\.5\./);
  assert.match(out, /\[Jane Doe\]\(jane-doe\.md\), CEO at Acme\. Joined Acme as CEO in Aug 2026\./);
  assert.match(out, /x@y\.com: No one found/);
});
