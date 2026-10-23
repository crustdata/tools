import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAbout } from "../src/competitors.js";
import { fundingBaselineItems, fundingItems, money, newsItems, newsQuery, roundLabel } from "../src/money.js";

const record = {
  basic_info: { name: "Northwind", professional_network_url: "https://profiles.example/company/northwind-example" },
  funding: { last_round_type: "series_b", last_round_amount_usd: 40_000_000, last_fundraise_date: "2026-10-21", acquisitions: [{ acquiree_company_name: "Tailspin Toys", announced_on_date: "2026-10-14" }], investors: ["Example Ventures"] },
  news: [
    { article_title: "Northwind raises $40M", article_url: "https://news.example/a", article_publish_date: "2026-10-22", article_publisher_name: "Example News" },
    { article_title: "Old news", article_url: "https://news.example/old", article_publish_date: "2026-01-02", article_publisher_name: "Example News" },
  ],
};

test("money and roundLabel format plainly", () => {
  assert.equal(money(40_000_000), "$40M");
  assert.equal(money(1_500_000_000), "$1.5B");
  assert.equal(money(52_020_932), "$52.0M");
  assert.equal(money(0), undefined);
  assert.equal(roundLabel("series_b"), "Series B");
  assert.equal(roundLabel("seed"), "seed");
});

test("fundingItems reads watch changes: round, acquisition, investors, news in the period", () => {
  const items = fundingItems([
    { field: "funding.last_round_type", type: "changed", from: "series_a", to: "series_b" },
    { field: "funding.acquisitions", type: "added", new_elements: [{ acquiree_company_name: "Tailspin Toys", announced_on_date: "2026-10-14" }] },
    { field: "funding.investors", type: "added", new_elements: ["Sample Capital"] },
    { field: "news", type: "added", new_elements: record.news },
    { field: "headcount.total", type: "changed", from: 1, to: 2 },
  ], record, "2026-10-19");
  assert.deepEqual(items.map(i => i.text), [
    "Raised Series B ($40M) on Oct 21, 2026",
    "Acquired Tailspin Toys, announced Oct 14, 2026, from Crustdata funding data",
    'In the news: "Northwind raises $40M" (Example News)',
  ]);
  assert.equal(items[0].date, "2026-10-21");
  assert.equal(items[0].url, "https://news.example/a", "a round links to an article about it, never to a profile page");
  assert.equal(items[2].url, "https://news.example/a");
});

test("a new investor without a new round is its own line", () => {
  const items = fundingItems([{ field: "funding.investors", type: "added", new_elements: ["Sample Capital", { name: "Other Fund" }] }], record);
  assert.equal(items[0].text, "New investors: Sample Capital, Other Fund");
});

test("week one reads the record itself, inside the period only", () => {
  const items = fundingBaselineItems(record, "2026-10-12");
  assert.deepEqual(items.map(i => i.text), ["Raised Series B ($40M) on Oct 21, 2026", "Acquired Tailspin Toys, announced Oct 14, 2026, from Crustdata funding data", 'In the news: "Northwind raises $40M" (Example News)']);
  assert.deepEqual(fundingBaselineItems(record, "2026-10-23"), []);
});

const northwind = { name: "Northwind", domain: "northwind.example", about: "CRM" };

test("newsItems keeps articles that name the company with what it makes, or its website", () => {
  const items = newsItems([
    { title: "Northwind raises $40M Series B led by Example Ventures", url: "https://techpress.example/a", snippet: "Northwind, the CRM for modern teams, announced..." },
    { title: "Northwind goes agent-native: SQL access and event data", url: "https://dealroom.example/b", snippet: "Interview with the founder of northwind.example" },
    { title: "Northwind - 2026 Funding Rounds & List of Investors", url: "https://tracxn.com/d/northwind", snippet: "Northwind CRM funding" },
    { title: "Northwind CRM company profile", url: "https://dealroom.example/companies/northwind", snippet: "Northwind CRM" },
    { title: "Top 10 CRMs for 2027", url: "https://blog.example/top", snippet: "A roundup mentioning Northwind." },
    { title: "Northwind Grill wins best burger in town", url: "https://localnews.example/c" },
    { title: "Northwind changelog", url: "https://northwind.example/changelog", snippet: "Northwind CRM release notes" },
    { title: "Northwind raises $40M Series B led by Example Ventures", url: "https://techpress.example/a", snippet: "Northwind CRM" },
  ], northwind);
  assert.deepEqual(items.map(i => i.url), ["https://techpress.example/a", "https://dealroom.example/b"]);
  assert.equal(items[0].text, 'In the news: "Northwind raises $40M Series B led by Example Ventures" (techpress.example)');
});

test("common-word names need the product word: Twenty is not the number twenty", () => {
  const twenty = { name: "Twenty", domain: "twenty.com", about: "CRM" };
  const items = newsItems([
    { title: "Twenty-two more Division I singles berths filled", url: "https://tennis.example/a" },
    { title: "Twenty years of folk music in the park", url: "https://local.example/b" },
    { title: "Twenty, the open source CRM, ships a new API", url: "https://dev.example/c" },
    { title: "Twenty Years of Friends of Netarts Bay Celebrated", url: "https://local.example/e", snippet: "Jim had a dream. The native sailed the world as" },
    { title: "Test Twenty: New Mixed-Gender Cricket Format to Debut in Colombo", url: "https://cricket.example/f" },
    { title: "CBN Governor to headline CRMI's 25th anniversary conference", url: "https://ng.example/g" },
  ], twenty);
  assert.deepEqual(items.map(i => i.url), ["https://dev.example/c"]);
  const folk = newsItems([
    { title: "Spooky folk trail opens for Halloween", url: "https://local.example/d" },
    { title: "Folk festival raises funding for a new stage", url: "https://local.example/h" },
  ], { name: "folk", domain: "folk.app", about: "CRM" });
  assert.deepEqual(folk, [], "a lowercase name needs the product word or the website");
  const attio = newsItems([{ title: "Attio goes agent-native: SQL access, event data and 1.6 billion API calls a month", url: "https://dealroom.example/news/1", snippet: "Key takeaways from a Scaling Europe interview with Attio Founder" }], { name: "Attio", domain: "attio.com", about: "CRM" });
  assert.equal(attio.length, 1, "a capitalised name next to a business word counts");
});

test("newsQuery and deriveAbout", () => {
  assert.equal(newsQuery(northwind), '"Northwind" CRM');
  assert.equal(newsQuery({ name: "Acme", domain: "acme.example" }), '"Acme" acme.example');
  assert.equal(deriveAbout("Attio is the agentic CRM that meets you where you work"), "CRM");
  assert.equal(deriveAbout("Building the modern Salesforce, powered by the Open Source community"), "CRM");
  assert.equal(deriveAbout("Global payments infrastructure for the internet"), "payments");
  assert.equal(deriveAbout("We make things"), "software");
  assert.equal(deriveAbout(undefined), "software");
});

test("roundups, comparisons, reviews, share-price stories and one-letter names are not news", () => {
  const items = newsItems([
    { title: "Top 20 CRM tools, including Northwind and others", url: "https://blog.example/1", snippet: "Northwind CRM" },
    { title: "Northwind vs Contoso: which CRM is right for you", url: "https://blog.example/2", snippet: "Northwind CRM" },
    { title: "Northwind CRM review 2026", url: "https://blog.example/3", snippet: "Northwind CRM" },
    { title: "Northwind stock falls after earnings", url: "https://markets.example/4", snippet: "Northwind CRM" },
  ], northwind);
  assert.deepEqual(items, []);
  const x = { name: "X", domain: "x.example", about: "software" };
  assert.deepEqual(newsItems([{ title: "X (formerly Twitter) changes its software", url: "https://news.example/x" }], x), [], "a one-letter name needs the website");
  assert.equal(newsItems([{ title: "x.example launches a new API", url: "https://news.example/y" }], x).length, 1);
});

test("a round dated well before the period is labelled as newly listed, not as this week's money", () => {
  const old = { ...record, funding: { ...record.funding, last_fundraise_date: "2024-03-01" }, news: [] };
  const items = fundingItems([{ field: "funding.last_round_type", type: "changed", from: "series_a", to: "series_b" }], old, "2026-10-19");
  assert.equal(items[0].text, "Crustdata now lists a Series B ($40M) dated Mar 1, 2024, from Crustdata funding data");
  assert.equal(items[0].why, "an older round newly added to the record");
});
