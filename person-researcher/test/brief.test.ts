import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, career, changes, clip, dateRange, duration, firstSentences, paragraphs, pickLinks, postLines, roles, searchPhrase } from "../src/brief.js";
import type { PersonData, Role } from "../src/crustdata.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const r = (name: string, title: string, start: string | null, end: string | null = null, extra: Partial<Role> = {}): Role =>
  ({ name, title, crustdata_company_id: extra.crustdata_company_id ?? name.length * 1000 + name.charCodeAt(0), start_date: start ? `${start}-01T00:00:00+00:00` : null, end_date: end ? `${end}-01T00:00:00+00:00` : null, ...extra });
const person = (current: Role[], past: Role[] = [], extra: Partial<PersonData> = {}): PersonData =>
  ({ crustdata_person_id: 1, basic_profile: { name: "Jane Doe" }, experience: { employment_details: { current, past } }, ...extra });

test("dates and durations read the way people write them", () => {
  assert.equal(dateRange("2022-01-01T00:00:00+00:00", "2024-02-01T00:00:00+00:00", false), "Jan 2022 to Feb 2024");
  assert.equal(dateRange("2024-01-01T00:00:00+00:00", null, true), "Jan 2024 to now");
  assert.equal(dateRange(null, "2024-02-01", false), "to Feb 2024");
  assert.equal(dateRange(null, null, false), "");
  assert.equal(duration(27), "2 yrs 3 mos");
  assert.equal(duration(1), "1 mo");
  assert.equal(duration(null), "");
});

test("a promotion at the same company is a new title, naming the old one", () => {
  const p = person([r("Acme", "VP Sales", "2026-08")], [r("Acme", "Director of Sales", "2023-01", "2026-08"), r("Globex", "AE", "2019-01", "2022-12")]);
  const c = changes(p, NOW, 180);
  assert.deepEqual(c.map(x => x.kind), ["new_title"]);
  assert.match(c[0].text, /New title at Acme: VP Sales \(was Director of Sales\), since Aug 2026/);
});

test("a move to a new company names the previous role and does not also say they left it", () => {
  const p = person([r("Initech", "Head of Data", "2026-07")], [r("Umbrella", "Data Scientist", "2021-01", "2026-06")]);
  const c = changes(p, NOW, 180);
  assert.deepEqual(c.map(x => x.kind), ["new_company"]);
  assert.match(c[0].text, /Joined Initech as Head of Data in Jul 2026\. Before: Data Scientist at Umbrella until Jun 2026\./);
});

test("a side role next to an older current role is an added role", () => {
  const p = person([r("Hooli", "CTO", "2022-02", null, { is_default: true }), r("Vandelay", "Advisor", "2026-09")]);
  const c = changes(p, NOW, 180);
  assert.deepEqual(c.map(x => x.kind), ["added_role"]);
  assert.match(c[0].text, /still CTO at Hooli/);
});

test("leaving with no current role, one line per company, newest first", () => {
  const p = person([], [r("Massive", "Director", "2024-01", "2026-09"), r("Massive", "Manager", "2021-01", "2024-01"), r("Soylent", "PM", "2017-01", "2026-06")]);
  const c = changes(p, NOW, 180);
  assert.deepEqual(c.map(x => x.text), ["Left Massive (Director) in Sep 2026. No current role listed.", "Left Soylent (PM) in Jun 2026. No current role listed."]);
});

test("old moves, undated roles and the window edge", () => {
  assert.deepEqual(changes(person([r("Acme", "CEO", "2020-01")]), NOW, 180), []);
  assert.deepEqual(changes(person([r("Acme", "CEO", null)], [r("Globex", "VP", "2015-01", "2026-09")]), NOW, 180).map(x => x.kind), ["left"]);
  // 180 days back from 23 Oct 2026 is late April: May counts, March does not.
  assert.equal(changes(person([r("Acme", "CEO", "2026-05")]), NOW, 180).length, 1);
  assert.equal(changes(person([r("Acme", "CEO", "2026-03")]), NOW, 180).length, 0);
  assert.equal(changes(person([r("Acme", "CEO", "2026-03")]), NOW, 365).length, 1);
});

test("a role listed twice under two ids counts once", () => {
  const twice = [r("Umbrella", "Data Scientist", "2021-01", "2026-06", { position_id: "a" }), r("Umbrella", "Data Scientist", "2021-01", "2026-06", { position_id: "b" })];
  const p = person([r("Initech", "Head of Data", "2026-07")], twice);
  assert.equal(roles(p).past.length, 1);
  assert.deepEqual(changes(p, NOW, 180).map(x => x.kind), ["new_company"]);
});

test("career groups roles by company, main current company first, then by latest end date", () => {
  const p = person(
    [r("Side Project", "Founder", "2025-01"), r("Acme", "VP", "2026-08", null, { is_default: true })],
    [r("Acme", "Director", "2023-01", "2026-08"), r("Globex", "AE", "2018-01", "2022-12"), r("Initech", "Intern", "2016-06", "2016-09")],
  );
  const c = career(p, NOW);
  assert.deepEqual(c.map(g => g.company), ["Acme", "Side Project", "Globex", "Initech"]);
  assert.deepEqual(c[0].roles.map(x => x.title), ["VP", "Director"]);
  assert.equal(c[0].current, true);
  assert.equal(c[3].span, "4 mos");
  assert.equal(c[0].roles[0].description, undefined);
  const withText = career(person([r("Acme", "VP", "2026-08", null, { description: "Runs sales." })], [r("Globex", "AE", "2018-01", "2022-12", { description: "Sold things." })]), NOW);
  assert.equal(withText[0].roles[0].description, "Runs sales.");
  assert.equal(withText[1].roles[0].description, undefined);
});

test("clip and firstSentences cut at words and repair joined sentences", () => {
  assert.equal(clip("one two three four five", 12), "one two...");
  assert.equal(clip("short", 50), "short");
  assert.equal(firstSentences("Acme makes payroll software.It is used by restaurants. Founded 2019.", 60), "Acme makes payroll software. It is used by restaurants.");
});

test("web links drop the profile site, contact-lookup sites and repeats", () => {
  const links = pickLinks([
    { url: "https://www.linkedin.com/in/example-jane-doe", title: "Jane" },
    { url: "https://www.linkedin.com/posts/example-1", title: "post" },
    { url: "https://rocketreach.co/jane-doe", title: "Jane Doe email" },
    { url: "https://www.crunchbase.com/person/jane-doe", title: "cb" },
    { url: "https://podcast.example/ep-1?utm=x", title: "Episode 1" },
    { url: "https://podcast.example/ep-1", title: "Episode 1 again" },
    { url: "javascript:alert(1)", title: "bad" },
    { url: "https://blog.example/a", title: "" },
  ], ["rocketreach.co", "crunchbase.com/person"], "https://www.linkedin.com/in/example-jane-doe", 5);
  assert.deepEqual(links.map(l => l.url), ["https://podcast.example/ep-1?utm=x", "https://blog.example/a"]);
  assert.equal(links[1].title, "blog.example");
});

test("post line breaks become sentence breaks", () => {
  assert.equal(paragraphs("Here is ours:\n\nWe launched\nIt worked."), "Here is ours: We launched. It worked.");
});

test("posts: reactions fall back to the per-type sum; empty posts are dropped", () => {
  const lines = postLines([
    { text: "Hello  world", date_posted: "2026-08-04T20:26:35Z", engagement: { reactions_by_type: { LIKE: 3, PRAISE: 2 }, total_comments: 1 }, share_url: "https://x.example/p" },
    { text: "", share_url: "" },
  ]);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { date: "4 Aug 2026", text: "Hello world", reactions: 5, comments: 1, shares: 0, url: "https://x.example/p" });
});

test("the search phrase quotes the name and drops tags like (YC F24) from the company", () => {
  assert.equal(searchPhrase(person([r("Crustdata (YC F24)", "CEO", "2024-01", null, { is_default: true })])), '"Jane Doe" Crustdata');
  assert.equal(searchPhrase(person([])), '"Jane Doe"');
});

test("a quiet brief says so, and older posts get the index-delay note", () => {
  const b = buildBrief({
    input: "x", matchedBy: "profile URL", now: NOW, days: 180,
    person: person([r("Acme", "CEO", "2020-01")], [], { updated_at: "2026-10-20T00:00:00Z" }),
    posts: { items: [{ text: "Old post", date_posted: "2026-07-01T00:00:00Z" }], total: 40 },
  });
  assert.equal(b.quiet, "No role change in the last 6 months. Profile refreshed on 2026-10-20.");
  assert.match(b.posts?.note ?? "", /Newest indexed post: 1 Jul 2026/);
  const none = buildBrief({ input: "x", matchedBy: "x", now: NOW, days: 90, person: person([]), posts: { items: [], total: 0 } });
  assert.equal(none.quiet, "No roles on this profile (or this key cannot read them), so changes cannot be shown.");
  const quiet90 = buildBrief({ input: "x", matchedBy: "x", now: NOW, days: 90, person: person([r("Acme", "CEO", "2020-01")]) });
  assert.equal(quiet90.quiet, "No role change in the last 3 months.");
  assert.match(none.posts?.note ?? "", /No posts by them/);
});
