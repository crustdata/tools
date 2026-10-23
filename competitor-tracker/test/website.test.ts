import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePrices, customerItems, decodeEntities, diffPages, discoverPages, extractLinks, extractLogos, launchItems, looksBlocked, mergeLinks, normalizeUrl, pageKind, parsePage, visibleText } from "../src/website.js";

const html = (body: string, nav = "") => `<html><head><title>Acme &amp; Co</title><script>var x = "<p>not text</p>";</script><style>p{}</style></head><body><header><nav>${nav}</nav><p>Introducing Acme Agents, now available</p></header><main>${body}</main><footer><nav><a href="/terms">Terms</a></nav></footer></body></html>`;

test("parsePage keeps visible text, one block per line, deduplicated; drops scripts, navigation and the title", () => {
  const p = parsePage("https://acme.example/", "acme.example", html("<h1>Hello</h1><p>World &amp; <b>friends</b></p><p>World &amp; <b>friends</b></p><div hidden>secret</div>"), null);
  assert.equal(p.title, "Acme & Co");
  assert.deepEqual(p.text.split("\n"), ["Introducing Acme Agents, now available", "Hello", "World & friends"]);
  assert.ok(!p.text.includes("not text"), "script contents are dropped");
  assert.ok(!p.text.includes("Terms"), "navigation is dropped");
});

test("only a real hidden attribute hides content, not classes that contain the word", () => {
  const text = visibleText(`<div class="rounded-xl overflow-hidden"><h3>Enterprise</h3><p>$99 per user / month</p></div><div class="hidden md:block"><p>Introducing Acme Agents</p></div><input type="hidden" name="x"><p>After the input</p><div aria-hidden="true"><p>Decorative</p></div><article><header><h2>Agents API now available</h2></header></article>`);
  assert.deepEqual(text.split("\n"), ["Enterprise", "$99 per user / month", "Introducing Acme Agents", "After the input", "Agents API now available"]);
});

test("malformed or huge HTML is read in linear time", () => {
  const started = Date.now();
  visibleText(`<p>start</p><!--${"x".repeat(400_000)}`);
  visibleText(`<p>start</p>${"<a href='/x'>".repeat(60_000)}`);
  extractLinks(`${"<a href='/x'>text ".repeat(60_000)}`, "https://acme.example/");
  visibleText(`<script>${"if (a<b) { x = '<div>'; } ".repeat(40_000)}`);
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
});

test("links are normalised: no query, fragment, www, trailing slash or http, so tracking parameters are not new pages", () => {
  assert.equal(normalizeUrl("http://www.Acme.example/pricing/?utm_source=x#top"), "https://acme.example/pricing");
  assert.equal(normalizeUrl("/", "https://acme.example/a/b"), "https://acme.example/");
  assert.equal(normalizeUrl("mailto:a@b.c"), null);
  const links = extractLinks(`<a href="/pricing#top">Pricing</a><a href='https://other.example/x'>Other</a><a href="mailto:a@b.c">Mail</a><a href="javascript:void(0)">JS</a><a href="/pricing?v=2">Dup</a>`, "https://acme.example/");
  assert.deepEqual(links.map(l => l.href), ["https://acme.example/pricing", "https://other.example/x"]);
  const prev = parsePage("https://acme.example/", "acme.example", html("<p>x</p>", `<a href="/agents?v=1">Agents</a>`), null);
  const next = parsePage("https://acme.example/", "acme.example", html("<p>x</p>", `<a href="https://www.acme.example/agents/?v=2">Agents</a>`), null);
  assert.deepEqual(launchItems(diffPages(prev, next), next), []);
});

test("logos: alt texts inside a logo wall, names with dots kept, file names ignored", () => {
  const logos = extractLogos(`<section class="customers"><img alt="Globex"><img alt="Initech logo"><img alt="Monday.com"></section><img src="/img/logo-slack.svg" alt="Slack"><img alt="A long sentence describing a screenshot of the product."><img alt="Hero">`);
  assert.deepEqual(logos, ["Globex", "Initech", "Monday.com"]);
});

test("pageKind recognises the usual pages and treats the rest as other", () => {
  assert.equal(pageKind("https://a.example/"), "home");
  assert.equal(pageKind("https://a.example/pricing/"), "pricing");
  assert.equal(pageKind("https://a.example/changelog"), "changelog");
  assert.equal(pageKind("https://a.example/customers"), "customers");
  assert.equal(pageKind("https://a.example/docs"), "docs");
  assert.equal(pageKind("https://a.example/about"), "other");
});

test("discoverPages picks one page per kind, prefers untranslated paths, skips legal pages", () => {
  const home = parsePage("https://acme.example/", "acme.example", html("", `<a href="/de/pricing">Preise</a><a href="/pricing">Pricing</a><a href="/legal/privacy">Privacy</a><a href="/blog">Blog</a><a href="/customers">Customers</a><a href="https://docs.acme.example/">Docs</a><a href="/en/changelog">Changelog</a>`), null);
  assert.deepEqual(discoverPages(home, 6), ["https://acme.example/", "https://acme.example/pricing", "https://acme.example/en/changelog", "https://acme.example/customers", "https://acme.example/blog"]);
  assert.deepEqual(discoverPages(home, 2), ["https://acme.example/", "https://acme.example/pricing"]);
});

test("comparePrices: a changed figure under the right plan, reordering ignored", () => {
  const prev = "Plans\nFree\n$0 per user / month\n1k credits included\nPro\n$49 per user / month\n10k credits included";
  const next = "Plans\nPro\n$49 per user / month\n20k credits included\nFree\n$0 per user / month\n1k credits included";
  const r = comparePrices(prev, next);
  assert.deepEqual(r.priceChanges, [{ plan: "Pro", from: "10k credits included", to: "20k credits included" }]);
  assert.deepEqual(r.newPriceLines, []);
});

test("comparePrices: one cell of a comparison table changing is found, paired by position", () => {
  const prev = "Contacts\n1,000 contacts\n10,000 contacts\n50,000 contacts\nSeats\nUp to 50 seats";
  const next = "Contacts\n1,000 contacts\n5,000 contacts\n50,000 contacts\nSeats\nUp to 60 seats";
  const r = comparePrices(prev, next);
  assert.deepEqual(r.priceChanges, [{ plan: "Contacts", from: "10,000 contacts", to: "5,000 contacts" }, { plan: "Seats", from: "Up to 50 seats", to: "Up to 60 seats" }]);
});

test("a visitor counter on the homepage is not a pricing change; a price there is", () => {
  const prev = parsePage("https://acme.example/", "acme.example", html("<p>Join 12,431 users today</p><p>Plans from $10 per month</p>"), null);
  const next = parsePage("https://acme.example/", "acme.example", html("<p>Join 12,502 users today</p><p>Plans from $12 per month</p>"), null);
  const items = launchItems(diffPages(prev, next), next);
  assert.equal(items.length, 1);
  assert.match(items[0].text, /Pricing changed: "Plans from \$10 per month" is now "Plans from \$12 per month"/);
});

test("a rebuilt page with the same words is not a change", () => {
  const prev = parsePage("https://acme.example/", "acme.example", "<html><body><p>Same words</p></body></html>", null);
  const next = parsePage("https://acme.example/", "acme.example", `<html><body><div class="new-layout"><section><span>Same words</span></section></div></body></html>`, null);
  const d = diffPages(prev, next);
  assert.deepEqual(d.addedBlocks, []);
  assert.deepEqual(launchItems(d, next), []);
});

test("new logos and a new case study become customer items", () => {
  const prev = parsePage("https://acme.example/customers", "acme.example", html(`<section class="logos"><img alt="Globex"></section><a href="/customers/globex">How Globex uses Acme</a>`), null);
  const next = parsePage("https://acme.example/customers", "acme.example", html(`<section class="logos"><img alt="Globex"><img alt="Hooli"></section><a href="/customers/globex">How Globex uses Acme</a><a href="/customers/hooli">How Hooli uses Acme</a>`), null);
  const items = customerItems(diffPages(prev, next), next);
  assert.equal(items.length, 2);
  assert.match(items[0].text, /1 new logo on the customers page: Hooli/);
  assert.equal(items[1].url, "https://acme.example/customers/hooli");
});

test("translation and legal links are never new pages; a new product page is", () => {
  const prev = parsePage("https://acme.example/", "acme.example", html("<p>x</p>", `<a href="/pricing">Pricing</a>`), null);
  const next = parsePage("https://acme.example/", "acme.example", html("<p>x</p>", `<a href="/pricing">Pricing</a><a href="/de/">Deutsch</a><a href="/legal/terms">Terms</a><a href="/agents">Agents API</a>`), null);
  const items = launchItems(diffPages(prev, next), next);
  assert.equal(items.length, 1);
  assert.match(items[0].text, /Agents API \(\/agents\)/);
});

test("links seen in recent weeks are kept, so a link that flickers in and out is not new each time", () => {
  const merged = mergeLinks([{ href: "https://a.example/x", text: "X" }], [{ href: "https://a.example/y", text: "Y" }, { href: "https://a.example/x", text: "X" }]);
  assert.deepEqual(merged.map(l => l.href), ["https://a.example/x", "https://a.example/y"]);
});

test("a bot check, a nearly empty page or prices in another currency are flagged, not compared", () => {
  const challenge = parsePage("https://acme.example/", "acme.example", "<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing acme.example</p></body></html>", null);
  assert.match(looksBlocked(challenge) ?? "", /bot check/);
  const full = parsePage("https://acme.example/", "acme.example", Array.from({ length: 200 }, (_, i) => `<p>Real content block number ${i}.</p>`).join(""), null);
  const empty = parsePage("https://acme.example/", "acme.example", "<p>Loading the application now</p>", null);
  assert.match(looksBlocked(empty, full) ?? "", /mostly empty/);
  assert.equal(looksBlocked(full, full), null);
  const usd = parsePage("https://acme.example/pricing", "acme.example", "<h3>Plus</h3><p>$ 44 35 per user/month</p><h3>Pro</h3><p>$ 99 79 per user/month</p>", null);
  const gbp = parsePage("https://acme.example/pricing", "acme.example", "<h3>Plus</h3><p>£ 34 27 per user/month</p><h3>Pro</h3><p>£ 74 59 per user/month</p>", null);
  assert.match(looksBlocked(gbp, usd) ?? "", /prices came back in £ instead of \$/);
  assert.equal(looksBlocked(usd, usd), null);
});

test("a huge page is skipped instead of compared", () => {
  const big = Array.from({ length: 7000 }, (_, i) => `<p>Entry ${i} of a very long directory listing with plenty of words to pad it out</p>`).join("");
  const prev = parsePage("https://acme.example/dir", "acme.example", `<html><body>${big}</body></html>`, null);
  const next = parsePage("https://acme.example/dir", "acme.example", `<html><body>${big}<p>one more</p></body></html>`, null);
  const d = diffPages(prev, next);
  assert.equal(d.tooBig, true);
  assert.deepEqual(launchItems(d, next), []);
});

test("decodeEntities handles named, decimal and hex entities and leaves unknown ones", () => {
  assert.equal(decodeEntities("a &amp; b &#39;c&#x27; &nbsp;d &unknown;"), "a & b 'c'  d &unknown;");
});

test("a removed plan and a reworded price are reported, not lost", () => {
  const prev = "Plans\nFree\n$0 per month\nPro\n$29 per user per month";
  const next = "Plans\nPro\n$39/seat/mo, billed annually";
  const r = comparePrices(prev, next);
  assert.deepEqual(r.priceChanges, [{ plan: "Pro", from: "$29 per user per month", to: "$39/seat/mo, billed annually" }]);
  assert.deepEqual(r.removedPriceLines, [{ plan: "Free", line: "$0 per month" }]);
  const page = parsePage("https://acme.example/pricing", "acme.example", "<h3>Pro</h3><p>$39/seat/mo, billed annually</p>", null);
  const before = parsePage("https://acme.example/pricing", "acme.example", "<h3>Free</h3><p>$0 per month</p><h3>Pro</h3><p>$29 per user per month</p>", null);
  const items = launchItems(diffPages(before, page), page);
  assert.ok(items.some(i => i.text === 'Removed from the pricing page (Free): "$0 per month"'), items.map(i => i.text).join(" | "));
});

test("parser edge cases: class lists, an open head, raw-text elements, quoted '>', CDATA", () => {
  const cases: [string, string][] = [
    ['<div class="mt-4 hidden lg:block"><p>Enterprise plan $99/mo</p></div><p>Other text here</p>', "Enterprise plan $99/mo|Other text here"],
    ['<!doctype html><html><head><meta charset=utf-8><title>Acme</title><body><h1>Pricing</h1><p>Pro $49/mo</p>', "Pricing|Pro $49/mo"],
    ['<script>var s = "<script>";</script><h1>Pricing</h1>', "Pricing"],
    ['<script>if(x.indexOf("<!--")>0){}</script><h1>Pricing</h1>', "Pricing"],
    ['<style>a[title="<style>"]{}</style><h1>Pricing</h1>', "Pricing"],
    ['<div data-x="a>b">Hello world</div>', "Hello world"],
    ['<div data-x="a>b" hidden>Secret text</div><p>Shown text</p>', "Shown text"],
    ['<![CDATA[ x < y ]]><p>After cdata</p>', "After cdata"],
  ];
  for (const [input, want] of cases) assert.equal(visibleText(input).split("\n").join("|"), want, input);
});

test("unclosed tags and stray '<' stay fast", () => {
  const started = Date.now();
  visibleText("<div ".repeat(80_000));
  visibleText("<p>" + "if a<b then ".repeat(80_000));
  assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started} ms`);
});

test("a new euro tier on a dollar pricing page is a change, not a currency switch", () => {
  const usd = parsePage("https://acme.example/pricing", "acme.example", "<h3>Plus</h3><p>$44 per user/month</p>", null);
  const mixed = parsePage("https://acme.example/pricing", "acme.example", "<h3>Plus</h3><p>$44 per user/month</p><h3>Enterprise</h3><p>€990 per month</p>", null);
  assert.equal(looksBlocked(mixed, usd), null);
  assert.ok(launchItems(diffPages(usd, mixed), mixed).some(i => /New line on the pricing page \(Enterprise\): "€990 per month"/.test(i.text)));
});

test("a price reworded around the same figure says so", () => {
  const before = parsePage("https://acme.example/pricing", "acme.example", "<h3>Pro</h3><p>$49 per seat per month</p>", null);
  const after = parsePage("https://acme.example/pricing", "acme.example", "<h3>Pro</h3><p>Starting at $49 per user monthly</p>", null);
  const items = launchItems(diffPages(before, after), after);
  assert.equal(items[0].why, "the wording changed; the figure is the same");
});

test("round 3 scanner cases: long tags, optional end tags, inline joins, entities, until-found", () => {
  const big = "x".repeat(2200);
  const cases: [string, string][] = [
    [`<p>Bulk export</p><img alt="Bulk export screenshot" srcset="${big}"><p>After image</p>`, "Bulk export|After image"],
    [`<div hidden data-x="${big}">Secret</div><p>Shown</p>`, "Shown"],
    ["<ul><li hidden>Hidden item<li>Visible item</ul><p>footer text</p>", "Visible item|footer text"],
    ["<p aria-hidden=true>Decor<div>Real block text</div>", "Real block text"],
    ["<p>Pro <span>$</span><span>29</span>/mo</p>", "Pro $29/mo"],
    ["<p>Price &euro;29 &pound;25 caf&eacute;</p>", "Price €29 £25 café"],
    ['<details><div hidden="until-found">Searchable answer</div></details>', "Searchable answer"],
  ];
  for (const [input, want] of cases) assert.equal(visibleText(input).split("\n").join("|"), want, input);
});

test("a geo currency switch that keeps one fixed dollar line is still a switch", () => {
  const usd = parsePage("https://a.example/pricing", "a.example", "<h3>Plus</h3><p>$29/mo</p><h3>Pro</h3><p>$49/mo</p><p>API $0.01 per request</p>", null);
  const eur = parsePage("https://a.example/pricing", "a.example", "<h3>Plus</h3><p>€27/mo</p><h3>Pro</h3><p>€45/mo</p><p>API $0.01 per request</p>", null);
  assert.match(looksBlocked(eur, usd) ?? "", /prices came back in € instead of \$/);
});

test("visibleText: a long JSON attribute with a > inside, and a hidden list item holding a nested list", () => {
  const x = "x".repeat(3000);
  assert.equal(visibleText(`<div data-json='${x} a > b ${x}'>Shown text</div>`), "Shown text");
  assert.equal(visibleText("<ul><li hidden>Hid<ul><li>Sub</li></ul><li>Shown li</ul>"), "Shown li");
  assert.equal(visibleText("<table><tr><td hidden>Hid<table><tr><td>Inner</td></tr></table><td>Shown td</table>"), "Shown td");
  const started = Date.now();
  visibleText(("<a x='" + "y".repeat(100)).repeat(20000));
  assert.ok(Date.now() - started < 2000, "stays bounded on a page of unclosed quotes");
});
