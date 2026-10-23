import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPipeline, pipelineRows, founderRows, PIPELINE_HEADER } from "../src/pipeline.js";
import { AI_HINT, md, money, pickQuestion, renderIndex, renderMemo } from "../src/memo.js";
import { matchPhrase, snippet, toQuote } from "../src/signals.js";
import { mergeSpec, parseFlags, parseSentence } from "../src/thesis.js";
import type { Deal } from "../src/types.js";

const fx = JSON.parse(readFileSync(new URL("../fixtures/seed-pipeline.json", import.meta.url), "utf8"));
const today = new Date("2026-10-21T12:00:00Z");
const spec = mergeSpec({ thesis: fx.thesis }, parseSentence(fx.thesis, today), parseFlags(fx.flags).flags);
const deals = buildPipeline(fx.inputs, spec, today).deals;
const byDomain = (d: string) => deals.find(x => x.company.domain === d)!;
const all = deals.map(d => renderMemo(d, "2026-10-21")).join("\n");

test("a memo has every section, and every section says something", () => {
  const m = renderMemo(byDomain("relaywise.example"), "2026-10-21");
  for (const h of ["## What it does", "## Snapshot", "## Timing", "## Hiring", "## Founders", "## Founders' posts", "## Score:", "## Question to ask"]) assert.ok(m.includes(h), h);
  assert.match(m, /Score \*\*\d+ \/ 100\*\*/);
  assert.match(m, /\$4\.2M/);
  assert.match(m, /\[Profile\]\(https:\/\/profiles\.example\/in\/example-jane-doe\)/);
  assert.ok(m.includes(AI_HINT));
});

test("no contact data anywhere: the API's funding.contact_email and phone_number never reach an output", () => {
  const csv = JSON.stringify([pipelineRows(deals), founderRows(deals), deals]);
  for (const out of [all, csv]) {
    assert.doesNotMatch(out, /team@|555 0100|contact_email|phone_number/);
  }
});

test("copy rules hold in generated text", () => {
  // The banned words are spelled out of pieces so this file passes the same copy grep.
  const banned = ["hon" + "estly", "noi" + "se", "sta" + "le"];
  assert.doesNotMatch(all, new RegExp(`[\u2014\u2013]|\\b(?:${banned.join("|")})\\b`, "i"));
});

test("one question, chosen by what the data shows", () => {
  assert.match(pickQuestion(byDomain("quietlayer.example")), /went from 11 to 8 people in the last 6 months, 21 months after the Seed round.*runway/);
  assert.match(pickQuestion(byDomain("kitebase.example")), /posted about a round on 2026-10-06/);
  assert.match(pickQuestion(byDomain("fernbridge.example")), /No round is on record/);
  assert.match(pickQuestion(byDomain("mosswire.example")), /full time on Mosswire/);
  assert.match(pickQuestion(byDomain("relaywise.example")), /The team posted 7 roles in the last 90 days/);
});

test("an AI analysis replaces the hint, labelled with its model", () => {
  const d: Deal = { ...byDomain("relaywise.example"), analysis: { model: "test-model", text: "**Strengths**\n- Fast growth." } };
  const m = renderMemo(d, "2026-10-21");
  assert.match(m, /## Analysis/);
  assert.match(m, /Written by test-model from the facts above only/);
  assert.ok(!m.includes(AI_HINT));
});

test("text from the API cannot inject markdown, links or HTML", () => {
  assert.equal(md("<script>x</script> [a](b) | #1 *hi*"), "\\<script\\>x\\</script\\> \\[a\\](b) \\| \\#1 \\*hi\\*");
  const evil: Deal = { ...byDomain("relaywise.example"), company: { ...byDomain("relaywise.example").company, description: "Nice <img src=x onerror=alert(1)> [click](javascript:alert(1))", website: "javascript:alert(1)" } };
  const m = renderMemo(evil, "2026-10-21");
  assert.doesNotMatch(m, /(?<!\\)<img|(?<!\\)\]\(javascript:/, "only escaped, so it shows as text");
});

test("the index links every memo and lists companies that left", () => {
  const idx = renderIndex(deals, [{ id: 9, name: "Gonecorp", domain: "gonecorp.example", firstSeen: "2026-10-14", lastSeen: "2026-10-14" }], fx.thesis, "2026-10-21", true);
  for (const d of deals) assert.ok(idx.includes(`(memos/${d.company.domain}.md)`), d.company.domain);
  assert.match(idx, /## Gone since the last run/);
  assert.match(idx, /Gonecorp/);
});

test("pipeline.csv has one row per company, columns in the header's order", () => {
  const rows = pipelineRows(deals);
  assert.equal(rows.length, deals.length);
  for (const r of rows) assert.equal(r.length, PIPELINE_HEADER.length);
  assert.equal(rows[0][PIPELINE_HEADER.indexOf("memo")], `memos/${deals[0].company.domain}.md`);
});

test("money", () => {
  assert.equal(money(4_200_000), "$4.2M");
  assert.equal(money(215_000), "$215K");
  assert.equal(money(1_500_000_000), "$1.5B");
  assert.equal(money(undefined), "");
});

test("post phrases: round news first, whole words only, a readable snippet", () => {
  assert.deepEqual(matchPhrase("We closed our seed and hit $20K MRR"), { phrase: "closed our seed", kind: "raise" });
  assert.equal(matchPhrase("We closed our first enterprise customer this week")?.kind, undefined, "a contract win is not a round");
  assert.equal(matchPhrase("We raised the bar on latency"), undefined);
  assert.equal(matchPhrase("This week we closed our first six-figure contract")?.kind, undefined);
  assert.equal(matchPhrase("We hit $20K MRR")?.kind, "traction");
  assert.equal(matchPhrase("Garrett's barrel"), undefined, '"ARR" inside a word does not count');
  assert.equal(matchPhrase("Growth is everything in this market"), undefined, "plain growth talk is not traction");
  const long = "Intro sentence. " + "word ".repeat(80) + "and now we are at $40K MRR after launch. Another sentence follows.";
  const s = snippet(long, "MRR");
  assert.ok(s.length <= 280 && s.includes("MRR"));
  assert.ok(!s.startsWith("Intro"));
  const q = toQuote({ date_posted: "2026-09-01T10:00:00Z", text: "Thrilled: we raised a pre-seed round!", actor: { name: "Jane Doe" }, share_url: "https://x.example/p" });
  assert.equal(q?.kind, "raise");
  assert.equal(q?.date, "2026-09-01");
  assert.equal(toQuote({ date_posted: "2026-09-01", text: "Nothing to see" }), undefined);
});

test("the question escapes names from the API, and AI text loses raw HTML and non-https links", async () => {
  const { cleanAnalysis } = await import("../src/memo.js");
  const d = byDomain("mosswire.example");
  const evil: Deal = { ...d, founders: [{ ...d.founders[0], name: "Eve <img src=x onerror=alert(1)> [click](javascript:alert(2))" }] };
  const m = renderMemo(evil, "2026-10-21");
  const q = m.slice(m.indexOf("## Question to ask"));
  assert.doesNotMatch(q, /(?<!\\)<img|(?<!\\)\]\(javascript:/);
  assert.equal(cleanAnalysis("Good <script>x</script> [a](javascript:alert(1)) [b](https://ok.example)"), "Good x a [b](https://ok.example)");
});

test("round 2: traction and round phrases", () => {
  for (const t of ["We doubled down on AI agents", "We crossed paths at the conference", "How to make your SaaS profitable", "helps sales teams find new customers", "Arr matey"])
    assert.equal(matchPhrase(t), undefined, t);
  assert.equal(matchPhrase("Thrilled to be announcing our $12M Series A led by a great fund")?.kind, "raise");
  assert.equal(matchPhrase("We just closed a $3M seed round!")?.kind, "raise");
  assert.equal(matchPhrase("We closed our biggest customer this quarter")?.kind, undefined);
  assert.equal(matchPhrase("We hit $40K MRR")?.kind, "traction");
});

test("round 2: memo text strips control characters and the question uses the timing month count", async () => {
  const { cleanAnalysis } = await import("../src/memo.js");
  const d = byDomain("quietlayer.example");
  const evil: Deal = { ...d, company: { ...d.company, name: "Quiet\u001b[31mlayer\u009b" } };
  assert.doesNotMatch(renderMemo(evil, "2026-10-21"), /[\u001b\u009b]/);
  const m = renderMemo(d, "2026-10-21");
  const timingMonths = /\((\d+) months ago\)/.exec(m)![1];
  assert.match(m, new RegExp(`${timingMonths} months after the Seed round`));
  assert.equal(cleanAnalysis("See [ref][1] and ![pixel](https://evil.example/p.png)\n\n[1]: javascript:alert(1)"), "See [ref][1] and pixel");
});

test("round 3: a URL cannot end its link early and add another", () => {
  const d = byDomain("relaywise.example");
  const evil: Deal = { ...d, jobs: { ...d.jobs, newest: [{ title: "Engineer", url: "https://jobs.example/x) [Wire the deposit here](https://phish.example/login" }] } };
  const m = renderMemo(evil, "2026-10-21");
  assert.doesNotMatch(m, /\]\(https:\/\/phish/);
  assert.match(m, /\[Engineer\]\(https:\/\/jobs\.example\/x%29%20%5BWire/);
});

test("round 5: a URL with leading spaces still becomes a working https link", () => {
  const d = byDomain("relaywise.example");
  const m = renderMemo({ ...d, jobs: { ...d.jobs, newest: [{ title: "Engineer", url: "  https://jobs.example/x" }] } }, "2026-10-21");
  assert.match(m, /\[Engineer\]\(https:\/\/jobs\.example\/x\)/);
});

test("round 6: tildes, nested link brackets, backslashes and semicolons cannot break memos or CSV", async () => {
  assert.equal(md("~~~ hidden"), "\\~\\~\\~ hidden");
  const { cleanAnalysis } = await import("../src/memo.js");
  assert.doesNotMatch(cleanAnalysis("[a [b]](http://evil.example/)"), /\]\(http/);
  assert.doesNotMatch(cleanAnalysis("see [a [b] c](javascript:alert(1))"), /\]\(javascript/);
  const { csvCell } = await import("../src/csv.js");
  assert.equal(csvCell("Acme;=1+1"), '"Acme;=1+1"');
  assert.equal(csvCell("x\t=1+1"), '"x\t=1+1"');
});
