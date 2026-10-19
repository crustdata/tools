// Offline tests on one real, scrubbed /company/enrich response and one /job/search capture for vercel.com.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shapeCompany, shapeHiring, shapePeople } from "../lib/shape";
import { buildBrief } from "../lib/brief";
import { toMarkdown } from "../lib/markdown";
import { normalizeDomain, parseQuery } from "../lib/research";
import type { Research } from "../lib/types";

const NOW = new Date("2026-10-16T00:00:00Z");
const enrich = JSON.parse(readFileSync(new URL("../fixtures/vercel.enrich.json", import.meta.url), "utf8"));
const jobs = JSON.parse(readFileSync(new URL("../fixtures/vercel.jobs.json", import.meta.url), "utf8"));
const cd = enrich[0].matches[0].company_data;

const company = shapeCompany(cd, NOW);
const people = shapePeople(cd.people, cd.crustdata_company_id, company.founded, NOW);
const hiring = shapeHiring(jobs);
const brief = buildBrief({ company, people, hiring }, NOW);

test("company profile is read from the enrich groups", () => {
  assert.equal(company.name, "Vercel");
  assert.equal(company.domain, "vercel.com");
  assert.equal(company.founded, 2015);
  assert.equal(company.headcount?.total, 1014);
  assert.equal(Math.round(company.headcount!.growthPercent.m12!), 29);
  assert.equal(company.headcount?.byDepartment[0].name, "Engineering");
  assert.ok(company.headcount!.byCountry.some(c => c.name === "United States"));
  assert.ok(company.headcount!.byMetro.every(m => !m.name.includes("United States") || m.name.includes("Area")));
  assert.equal(company.funding?.lastRound?.type, "Series F");
  assert.equal(company.funding?.totalUsd, 863_000_000);
  assert.ok((company.techStack?.byCategory.length ?? 0) > 0);
  assert.equal(company.webTraffic?.[0].domain, "vercel.com");
});

test("leadership keeps current, dated, senior people only", () => {
  assert.ok(people.executives.some(p => p.name === "Guillermo Rauch"));
  for (const p of [...people.founders, ...people.executives, ...people.decisionMakers]) {
    assert.ok(p.startDate, `${p.name} has a start date`);
    assert.doesNotMatch(p.title, /assistant|executive business partner|chief of staff/i);
  }
  const names = [...people.founders, ...people.executives, ...people.decisionMakers].map(p => p.name);
  assert.equal(new Set(names).size, names.length, "no one is listed twice");
});

test("hiring reads role types from titles, adds up, and dedupes postings", () => {
  assert.ok(hiring.postingsLast90d! > 0);
  assert.equal(hiring.byRoleType.reduce((a, b) => a + b.count, 0), hiring.postingsLast90d);
  assert.ok(hiring.byRoleType.some(b => b.type === "Engineering"));
  assert.ok(hiring.byRoleType.at(-1)!.type === "Other" || !hiring.byRoleType.some(b => b.type === "Other"));
  const keys = hiring.newest.map(j => `${j.title}|${j.date}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("templated brief renders from the data alone", () => {
  assert.match(brief.summary, /^Vercel \(vercel\.com\) is a software development company based in San Francisco, founded 2015\./);
  assert.match(brief.summary, /1,014 people as of September 2026, up 29% in 12 months/);
  assert.match(brief.summary, /Engineering is 42% of staff/);
  assert.match(brief.summary, /Last raised a Series F \(\$300M\) in September 2025\. Total raised \$863M\./);
  assert.ok(brief.changes.length >= 4);
  assert.equal(brief.questions.length, 3);
  for (const q of brief.questions) assert.match(q, /\?$/);
});

test("markdown output keeps the house rules", () => {
  const r: Research = {
    schemaVersion: "1", domain: "vercel.com", generatedAt: NOW.toISOString(), fetchedAt: NOW.toISOString(), errors: [], company, people, hiring, brief, unavailable: [],
    credits: { identify: 0, enrich: 9, jobs: 0.45, total: 9.45, cached: false },
  };
  const md = toMarkdown(r);
  for (const heading of ["## Brief", "## Headcount", "## Hiring", "## Leadership", "## Funding", "## Web traffic and audience", "## Tech stack", "## Employee ratings", "## Search competitors", "## Recent news (last 90 days)", "## Recent posts by the company"]) {
    assert.ok(md.includes(heading), heading);
  }
  assert.match(md, /Credits used: 9\.45/);
  assert.doesNotMatch(md, /[\u2013\u2014]/, "no en or em dashes");
  assert.doesNotMatch(md, /\b(honestly|noise|stale)\b/i);
  assert.doesNotMatch(md, /linkedin/i);
});

test("a section the key cannot read says so", () => {
  const r: Research = {
    schemaVersion: "1", domain: "vercel.com", generatedAt: NOW.toISOString(), fetchedAt: NOW.toISOString(), errors: [], company: { ...company, techStack: null }, people, hiring, brief,
    unavailable: ["technographics"], credits: { identify: 0, enrich: 2, jobs: 0.45, total: 2.45, cached: false },
  };
  assert.match(toMarkdown(r), /Not available on this plan \(`technographics`\)/);
});

test("domains are normalised, and names are accepted", () => {
  assert.deepEqual(parseQuery("HubSpot"), { name: "HubSpot" });
  assert.deepEqual(parseQuery("  https://www.Clay.com/pricing "), { domain: "clay.com" });
  assert.throws(() => parseQuery(""));
  assert.throws(() => parseQuery("<script>"));
  assert.equal(normalizeDomain("https://www.Stripe.com/pricing?x=1"), "stripe.com");
  assert.equal(normalizeDomain("vercel.com"), "vercel.com");
  assert.throws(() => normalizeDomain("not a domain"));
});

// ---------- regressions from the adversarial review ----------

const base = JSON.parse(JSON.stringify(cd));
const person = (name: string, title: string, start: string) => ({
  basic_profile: { name, current_title: title },
  experience: { employment_details: { current: [{ employer_company_id: [String(cd.crustdata_company_id)], employee_title: title, employee_start_date: start }] } },
});

test("leadership: C-suite outranks vice presidents, joke and fake titles are dropped, founders keep their CEO title", () => {
  const p = shapePeople({
    founders: [person("Ada Founder", "CEO", "2015-03-01")],
    cxos: [person("Vic Vee", "Vice President, Sales", "2024-01-01"), person("Cora Chief", "Chief Revenue Officer", "2024-01-01"),
      person("Pot Ter", "Chief Pottery Officer", "2024-01-01"), person("Fake Profile", "Certification Pro, Hubspot CEO", "1978-01-01"),
      person("Field Guy", "Field CTO", "2024-01-01"), person("Mark Eter", "Principal Marketer | CRO", "2024-01-01")],
    decision_makers: [person("Vic Vee", "Vice President, Sales", "2024-01-01"), person("Sam Svp", "SVP Engineering", "2023-01-01"), person("Hea Dof", "Head of Engineering", "2022-01-01"),
      person("Other Co", "Founder/CEO of Kurtie", "2021-01-01"), person("Ea Person", "EA to the CEO", "2021-01-01"), person("Old Timer", "CEO", "1925-01-01")],
  }, cd.crustdata_company_id, 2015, NOW, "Vercel");
  assert.deepEqual(p.founders.map(x => x.name), ["Ada Founder"]);
  assert.deepEqual(p.executives.map(x => x.name), ["Cora Chief"]);
  const dm = p.decisionMakers.map(x => x.name);
  assert.ok(dm.indexOf("Sam Svp") < dm.indexOf("Vic Vee"), "SVP ranks above VP");
  assert.ok(dm.includes("Hea Dof"), "Head of Engineering stays");
  for (const junk of ["Other Co", "Ea Person", "Old Timer"]) assert.ok(!dm.includes(junk), `${junk} is dropped`);
});

test("funding: secondary sales are not counted as money raised", () => {
  const f = JSON.parse(JSON.stringify(base));
  f.funding.total_investment_usd = 392_000_000;
  f.funding.milestones = [
    { round_type: "series_d", date: "2026-09-09", amount_usd: 115_000_000 },
    { round_type: "secondary_market", date: "2026-01-28", amount_usd: 55_000_000 },
    { round_type: "secondary_market", date: "2025-05-08", amount_usd: 20_000_000 },
    { round_type: "series_c", date: "2025-06-13", amount_usd: 100_000_000 },
  ];
  const c = shapeCompany(f, NOW);
  assert.equal(c.funding?.totalUsd, 317_000_000);
  assert.equal(c.funding?.secondaryUsd, 75_000_000);
  assert.equal(c.funding?.roundCount, 2);
  assert.equal(c.funding?.lastRound?.type, "Series D");
});

test("ratings: a score from two ratings is flagged, not shown as 132 reviews", () => {
  const c = shapeCompany(base, NOW);
  assert.equal(c.employeeRatings?.ratingsCount, 2);
  assert.equal(c.employeeRatings?.lowSample, true);
});

test("places: cities never land under countries", () => {
  const f = JSON.parse(JSON.stringify(base));
  f.headcount.by_region_absolute = { "United States": 500, "Dublin": 80, "Ireland": 90, "Lisbon": 40, "California, United States": 300, "San Francisco Bay Area": 200 };
  const h = shapeCompany(f, NOW).headcount!;
  assert.deepEqual(h.byCountry.map(x => x.name), ["United States", "Ireland"]);
  assert.ok(h.byMetro.some(x => x.name === "Dublin"));
  assert.ok(!h.byMetro.some(x => x.name.startsWith("California")));
});

test("news: everyday-word names need business context; quote pages and repeats go", () => {
  const f = JSON.parse(JSON.stringify(base));
  f.basic_info.name = "Unify"; f.basic_info.primary_domain = "unifygtm.com";
  const d = "2026-10-01";
  f.news = [
    { article_title: "AI-Modulated Urns Unify Grief and Memory", article_url: "https://a.com/1", article_publish_date: d },
    { article_title: "Unify raises $40M Series B for its GTM platform", article_url: "https://b.com/2", article_publish_date: d },
    { article_title: "Unify raises $40M Series B for its GTM platform", article_url: "https://c.com/3", article_publish_date: d },
    { article_title: "Unify (UNFY) stock price, news, quote", article_url: "https://d.com/4", article_publish_date: d },
  ];
  const c = shapeCompany(f, NOW);
  assert.deepEqual(c.news.map(n => n.url), ["https://b.com/2"]);
  assert.equal(c.newsLast90d, 1);
  assert.equal(c.newsSignals[0]?.kind, "funding");
});

test("competitors: lookalike names and SEO sites are dropped", () => {
  const f = JSON.parse(JSON.stringify(base));
  f.competitors = { paid_seo: [], organic_seo: ["turboproject.eu", " vercelapp.dev", " netlify.com", " top5-crm.com", " neilpatel.com", " foo.github.io"] };
  const c = shapeCompany(f, NOW);
  assert.deepEqual(c.competitors?.organicSearch, ["turboproject.eu", "netlify.com"]);
});

test("brief: layoffs in the news lead the changes and the questions", () => {
  const f = JSON.parse(JSON.stringify(base));
  f.news = [{ article_title: "Vercel cuts nearly 7% of workforce", article_url: "https://x.com/1", article_publish_date: "2026-10-10" }, ...f.news];
  const c = shapeCompany(f, NOW);
  const b = buildBrief({ company: c, people, hiring }, NOW);
  assert.match(b.changes[0], /cuts nearly 7% of workforce/);
  assert.match(b.questions[0], /cuts/);
});

test("news: a product headline is not an exit, and a backed startup's round is not the company's", () => {
  const f = JSON.parse(JSON.stringify(base));
  const d = "2026-10-01";
  f.news = [
    { article_title: "Vercel Labs Ships scriptc, a TypeScript-to-Native Compiler That Leaves the JavaScript Engine behind", article_url: "https://a.com/1", article_publish_date: d },
    { article_title: "Vercel-backed Photon raises $4.5M to put AI agents inside iMessage", article_url: "https://b.com/2", article_publish_date: d },
    { article_title: "Vercel CTO steps down after five years", article_url: "https://c.com/3", article_publish_date: d },
  ];
  const c = shapeCompany(f, NOW);
  assert.deepEqual(c.newsSignals.map(s => [s.kind, s.url]), [["exec_exit", "https://c.com/3"]]);
});

test("news: funding, deals and launches count only when the company does them", () => {
  const f = JSON.parse(JSON.stringify(base));
  const d = "2026-10-01";
  f.news = [
    { article_title: "Truist Raises Price Target on Vercel to $275 From $230", article_url: "https://a.com/1", article_publish_date: d },
    { article_title: "Vercel - 2026 Funding Rounds & List of Investors", article_url: "https://b.com/2", article_publish_date: d },
    { article_title: "FedEx Puts Electrification And Vercel Growth On Its Valuation Case", article_url: "https://c.com/3", article_publish_date: d },
    { article_title: "Vercel (VRCL) Unveils A New Agent Platform", article_url: "https://d.com/4", article_publish_date: d },
    { article_title: "Vercel raises $300M Series F", article_url: "https://e.com/5", article_publish_date: d },
  ];
  const c = shapeCompany(f, NOW);
  assert.deepEqual(c.newsSignals.map(s => `${s.kind} ${s.url}`).sort(), ["funding https://e.com/5", "launch https://d.com/4"]);
});

test("leadership: a subsidiary CEO ranks after the company CEO", () => {
  const person = (name: string, title: string, start: string) => ({
    basic_profile: { name },
    experience: { employment_details: { current: [{ employer_company_id: [1], employee_title: title, employee_start_date: start }] } },
  });
  const raw = { cxos: [person("Sub Boss", "Chief Executive Officer of Stripe Payments UK Ltd", "2020-01-01"), person("Main Boss", "CEO", "2012-01-01")] };
  const p = shapePeople(raw, 1, 2010, NOW, "Stripe");
  assert.equal(p.executives[0]?.name, "Main Boss");
});
