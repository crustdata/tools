import assert from "node:assert/strict";
import { test } from "node:test";
import { creditsLine, digestMarkdown, digestTitle, itemLine, orderCompetitors, orderItems, sectionMarkdown } from "../src/digest.js";
import { digestHtml, escapeHtml } from "../src/email.js";
import { digestMessages, esc, itemText } from "../src/slack.js";
import { emptySections, type CompetitorDigest, type Digest, type Item } from "../src/types.js";

const competitor = (name: string, launches: Item[] = []): CompetitorDigest => {
  const c: CompetitorDigest = { name, domain: `${name.toLowerCase()}.example`, sections: emptySections() };
  c.sections.launches.items = launches;
  return c;
};
const digest = (competitors: CompetitorDigest[], extra: Partial<Digest> = {}): Digest => ({ week: "2026-W44", from: "2026-10-19", to: "2026-10-26", firstRun: false, competitors, creditsUsed: 12.5, watcherCredits: 0, warnings: [], ...extra });

test("markdown: title by dates, one heading per competitor, six sections, quiet lines inline, safe links, escaped text", () => {
  const md = digestMarkdown(digest([competitor("Acme", [{ text: "New page: <b>Agents</b> *API*", url: "https://acme.example/agents (beta)", why: "launch", date: "2026-10-22" }])]));
  assert.match(md, /^# Competitor digest, Oct 19 to Oct 26, 2026/);
  assert.match(md, /## Acme \(acme\.example\)/);
  for (const s of ["Launches", "Money and news", "Customers", "Hiring", "Headcount", "Posts"]) assert.ok(md.includes(`**${s}**`) || md.includes(`**${s}:**`), s);
  assert.ok(md.includes("- New page: \\<b\\>Agents\\</b\\> \\*API\\* (Oct 22). Launch. [source](https://acme.example/agents%20%28beta%29)"), md);
  assert.match(md, /\*\*Money and news:\*\* Nothing new this week\./);
  assert.match(md, /Credits: 12\.5 for this run's pages and searches\./);
});

test("markdown: notes replace or follow items, warnings are listed, first run is flagged", () => {
  const c = competitor("Acme");
  c.sections.launches.note = "starting point saved";
  assert.equal(sectionMarkdown("launches", c.sections.launches), "**Launches:** Starting point saved.");
  c.sections.launches.items = [{ text: "x" }];
  assert.match(sectionMarkdown("launches", c.sections.launches), /- x\.\n- _starting point saved_/);
  const md = digestMarkdown(digest([c], { firstRun: true, warnings: ["job watch missing"] }));
  assert.match(md, /First digest: posts, hiring, funding and news cover the last 7 days/);
  assert.match(md, /\*\*Warnings\*\*\n- job watch missing/);
});

test("line format: date in brackets, why as its own sentence, custom link label, no doubled stops, no repeated date", () => {
  assert.equal(itemLine({ text: "x" }), "- x.");
  assert.equal(itemLine({ text: 'Said "hi."', why: "a reason" }), '- Said "hi." A reason.');
  assert.equal(itemLine({ text: "Raised on 2026-10-21", date: "2026-10-21" }), "- Raised on 2026-10-21.");
  assert.equal(itemLine({ text: "15 postings", url: "https://jobs.example/1", linkLabel: "one of them" }), "- 15 postings. [one of them](https://jobs.example/1)");
  assert.equal(itemLine({ text: "x", url: `https://a.example/${"y".repeat(1200)}` }), "- x.", "very long URLs are dropped");
});

test("title and credits line", () => {
  assert.equal(digestTitle(digest([])), "Competitor digest, Oct 19 to Oct 26, 2026");
  assert.equal(creditsLine(digest([], { creditsUsed: 0, watcherCredits: 0 })), "No credits used this run.");
  assert.equal(creditsLine(digest([], { creditsUsed: 21, watcherCredits: 9.5 })), "Credits: 21 for this run's pages and searches, plus 9.5 billed by the watchers for what they caught.");
});

test("items are newest first and deduplicated; competitors with news come first", () => {
  const items = orderItems([{ text: "a" }, { text: "b", date: "2026-10-01" }, { text: "c", date: "2026-10-05" }, { text: "a" }]);
  assert.deepEqual(items.map(i => i.text), ["c", "b", "a"]);
  const ordered = orderCompetitors([competitor("Zed"), competitor("Acme"), competitor("Mid", [{ text: "x" }])]);
  assert.deepEqual(ordered.map(c => c.name), ["Mid", "Acme", "Zed"]);
});

test("a competitor with nothing anywhere collapses to one line", () => {
  const md = digestMarkdown(digest([competitor("Quiet")]));
  assert.match(md, /## Quiet \(quiet\.example\)\n\nNothing new in any section this week\./);
});

test("slack: everything external is escaped, links are safe, one message, quiet competitors on one line", () => {
  const messages = digestMessages(digest([competitor("Acme", [{ text: "Posted <!channel> & <https://evil.example|click>", url: "https://acme.example/x|y" }]), competitor("Quiet"), competitor("Calm")]));
  assert.equal(messages.length, 1);
  const json = JSON.stringify(messages[0]);
  assert.ok(!json.includes("<!channel>"), "channel ping escaped");
  assert.ok(json.includes("&lt;!channel&gt;"));
  assert.ok(json.includes("<https://acme.example/x%7Cy|source>"), "pipe in URL encoded");
  assert.ok(json.includes("Nothing new this week: Calm, Quiet."), json);
  assert.equal(esc("<a>&"), "&lt;a&gt;&amp;");
  assert.equal(itemText({ text: "x", why: "y" }), "• x. _Y._");
  assert.equal(itemText({ text: 'Posted: "Done."', date: "2026-10-22" }), '• Posted: "Done." (Oct 22).');
});

test("slack: twenty competitors with news fit in as few messages as the block limit allows", () => {
  const many = Array.from({ length: 20 }, (_, i) => competitor(`Comp${i}`, [{ text: `item ${i}` }]));
  const messages = digestMessages(digest(many));
  assert.ok(messages.length <= 4, `${messages.length} messages`);
  for (const m of messages) assert.ok((m.blocks?.length ?? 0) <= 50, "under 50 blocks");
  assert.match(messages[0].text, /Competitor digest/);
});

test("slack: a very long section is chunked under 3,000 characters, and a huge URL does not break it", () => {
  const long = competitor("Acme", Array.from({ length: 40 }, (_, i) => ({ text: `A fairly long item number ${i} that describes a change in enough words to take up space on the line`, url: `https://acme.example/${i === 0 ? "z".repeat(3000) : i}` })));
  const sections = digestMessages(digest([long])).flatMap(m => (m.blocks ?? []) as any[]).filter(b => b.type === "section");
  assert.ok(sections.length >= 3);
  for (const s of sections) assert.ok(s.text.text.length <= 3000, `${s.text.text.length}`);
});

test("email: built from the digest, every outside text escaped, only our own links", () => {
  const html = digestHtml(digest([competitor("Acme", [{ text: "Posted [Read the full announcement](https://phish.example/login) **URGENT** <script>", url: "https://acme.example/agents" }])]));
  assert.match(html, /<h1[^>]*>Competitor digest, Oct 19 to Oct 26, 2026<\/h1>/);
  assert.match(html, /<h2[^>]*>Acme <span[^>]*>\(acme\.example\)<\/span><\/h2>/);
  assert.ok(!html.includes("phish.example/login\""), "markdown in page text never becomes a link");
  assert.ok(!html.includes("<strong>URGENT"), "nor bold text");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes('<a href="https://acme.example/agents"'));
  assert.equal(escapeHtml(`"'<>&`), "&quot;&#39;&lt;&gt;&amp;");
});
