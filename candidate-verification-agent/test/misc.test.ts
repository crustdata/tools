import { test } from "node:test";
import assert from "node:assert/strict";
import { envText, quote } from "../src/setup.js";
import { csvCell, verifiedCsv } from "../src/output.js";
import { dropReportSections } from "../src/forget.js";
import { looksLikeSlackWebhook, summaryMessage } from "../src/slack.js";
import { reusable } from "../src/store.js";

test(".env writing keeps comments and unknown keys, and quotes values safely", () => {
  const text = envText("# key\nCRUSTDATA_API_KEY=\n# slack\nSLACK_WEBHOOK_URL=\nOUT_DIR=out\n", { CRUSTDATA_API_KEY: "abc", SLACK_WEBHOOK_URL: "", MY_OWN: "x y" });
  assert.equal(text, "# key\nCRUSTDATA_API_KEY=abc\n# slack\nSLACK_WEBHOOK_URL=\nOUT_DIR=out\n\n# Other settings\nMY_OWN='x y'\n");
  assert.equal(quote("it's $1"), '"it\'s $1"', "Node's .env reader does not expand $, so it is written as it is");
  assert.throws(() => quote("a'b\"c"), /both kinds of quote/);
});

test("CSV cells never run as spreadsheet formulas", () => {
  assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(csvCell("+1 555"), "+1 555", "a phone number cannot run as a formula");
  assert.equal(csvCell("-"), "-");
  assert.equal(csvCell("+cmd|calc"), "'+cmd|calc");
  assert.equal(csvCell("-5"), "-5");
  assert.equal(csvCell("+44 20 7946 0000"), "+44 20 7946 0000");
  assert.equal(csvCell("-2+3+cmd|' /C calc'!A0"), "'-2+3+cmd|' /C calc'!A0");
  assert.equal(csvCell("@SUM(1)"), "'@SUM(1)");
  assert.equal(csvCell("a;b", ";"), '"a;b"');
  assert.equal(csvCell(0.5), "0.5");
  const text = verifiedCsv(["verdict"], []);
  assert.match(text, /^﻿verdict,review_rank,review_group,cv_verdict,verdict_label,/);
});

test("Slack webhook URLs are checked", () => {
  assert.ok(looksLikeSlackWebhook("https://hooks.slack.com/services/T000/B000/abc123"));
  assert.ok(!looksLikeSlackWebhook("http://hooks.slack.com/services/T000/B000/abc"));
  assert.ok(!looksLikeSlackWebhook("https://hooks.slack.com.evil.example/services/a/b/c"));
});

test("Slack summary stays within Slack's limits for a long list", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    candidate: { line: i + 2, cells: [], name: `Person ${i}` },
    result: { profileUrl: `https://www.linkedin.com/in/example-${i}`, check: "full" as const, checkedAt: "2026-11-11", verdict: "probably_fabricated" as const, reasoning: "x".repeat(2000), flags: [], citations: [], dateConflicts: [] },
  }));
  const msg = summaryMessage("big", rows, { unresolved: 0, credits: 2000, quick: false });
  const blocks = msg.blocks as any[];
  assert.ok(blocks.length <= 50);
  for (const b of blocks) if (b.text?.text) assert.ok(b.text.text.length <= 3000);
  assert.match(JSON.stringify(blocks), /and 175 more/);
});

test("cached results: fresh enough and strong enough only", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");
  const r = (check: "full" | "quick" | "none", days: number) => ({ profileUrl: "u", check, checkedAt: new Date(now - days * 86_400_000).toISOString(), verdict: "clearly_genuine" as const, flags: [], citations: [], dateConflicts: [] });
  assert.ok(reusable(r("full", 3), true, 30, now));
  assert.ok(reusable(r("full", 3), false, 30, now));
  assert.ok(!reusable(r("quick", 3), true, 30, now));
  assert.ok(!reusable(r("full", 31), true, 30, now));
  assert.ok(!reusable(r("none", 1), false, 30, now));
  assert.ok(!reusable(r("full", 1), true, 0, now));
});

test("forget drops only that person's report section", () => {
  const md = "# T\n\n## Review first (2)\n\n### A\n\n- Profile: https://www.linkedin.com/in/example-a\n\n### B\n\n- Profile: https://www.linkedin.com/in/example-b\n\n---\n";
  const { text, removed } = dropReportSections(md, "https://www.linkedin.com/in/example-a");
  assert.equal(removed, 1);
  assert.ok(!text.includes("example-a"));
  assert.ok(text.includes("### B"));
});

test("the AI never sees the candidate's name or profile URL", async () => {
  const { factsFor } = await import("../src/ai.js");
  const facts = factsFor({ profileUrl: "https://www.linkedin.com/in/example-jane-doe", check: "full", checkedAt: "2026-11-11", verdict: "probably_genuine", reasoning: "Jane Doe's role at Example Co is supported; Doe has 4 coworkers engaging.", flags: [], citations: [], dateConflicts: [], person: { name: "Jane Doe", title: "Engineer", company: "Example Co" } });
  assert.ok(!/jane|doe|linkedin/i.test(facts), facts);
  assert.match(facts, /the candidate's role at Example Co/);
});
