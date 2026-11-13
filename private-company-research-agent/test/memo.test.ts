import { test } from "node:test";
import assert from "node:assert/strict";
import { NOW, fixture, freshOut as freshOutLocal } from "./helpers.js";
import { Cache } from "../src/cache.js";
import { collect, competitorDomains, pickMatch } from "../src/collect.js";
import { fakeFetch, type Fixture } from "../src/fake-api.js";
import { sanitizeCompany } from "../src/sanitize.js";
import {
  aboutCompany, buildMemo, cleanNews, countries, fmtPct, fmtUsd, monthsBetween, namesCompany, parseRange, roundName, steppedBack, whenIso, type Memo,
} from "../src/memo.js";
import { renderMemo } from "../src/render.js";
import type { Bundle } from "../src/types.js";

async function bundleFor(fx: Fixture, domain: string, peers?: string[]): Promise<Bundle> {
  globalThis.fetch = fakeFetch(fx).fetch;
  const got = await collect(domain, { today: NOW, leaversLimit: 25, peersLimit: 5, peers }, new Cache("/nonexistent", 0));
  assert.equal(got.status, "ok");
  return (got as { bundle: Bundle }).bundle;
}
const memoFor = async (name: string, domain: string, peers?: string[]): Promise<Memo> => buildMemo(await bundleFor(fixture(name), domain, peers), NOW);

test("fast grower: a VP who left and a CTO who stepped back are red flags; a promotion is not", async () => {
  const m = await memoFor("fast-grower.json", "quillnote.example");
  const flags = m.findings.filter(f => f.kind === "red_flag");
  assert.deepEqual(flags.map(f => f.id), ["founder_elsewhere", "leader_departure", "leader_step_back"]);
  assert.match(flags[1].text, /Morgan Pipeline \(VP of Sales\) left in Jul 2026; now CRO, Tally Minutes/);
  assert.match(flags[2].text, /Blake Founder moved from Chief Technology Officer to Technical Advisor in May 2026/);
  assert.ok(!JSON.stringify(m).includes("Drew Promoted"), "a promotion is not a departure");
  assert.equal(m.team.departures?.total, 6);
});

test("fast grower: signals, questions and every headcount number with its field and date", async () => {
  const m = await memoFor("fast-grower.json", "quillnote.example");
  const ids = m.findings.filter(f => f.kind === "signal").map(f => f.id);
  assert.deepEqual(ids, ["traffic_growing", "fast_headcount_growth", "function_mix_shift", "repeat_founder", "insider_support"]);
  assert.match(m.findings.find(f => f.id === "function_mix_shift")!.text, /Sales grew from 6 to 18 people \(\+200%\) in 6 months while engineering went from 22 to 30/);
  assert.ok(m.questions.length >= 5 && m.questions.length <= 10);
  assert.ok(m.questions.some(q => /added 28 people since the Series B 6 months ago/.test(q)));
  for (const f of [...m.snapshot, ...m.growth.headcount, ...(m.growth.web?.facts ?? []), ...m.funding.facts]) {
    assert.ok(f.source && f.as_of, `${f.label} has a source and a date`);
  }
  assert.ok(!/grew \+/.test(JSON.stringify(m)), "no doubled signs in prose");
});

test("fast grower: auto peers keep list order, drop look-alikes and report the missing", async () => {
  const m = await memoFor("fast-grower.json", "quillnote.example");
  assert.deepEqual(m.peers?.rows.map(r => r.name), ["Quillnote", "Tally Minutes", "Recapr"]);
  assert.deepEqual(m.peers?.dropped, [{ domain: "lookalike-blog.example", reason: "small" }, { domain: "quillmotion.example", reason: "unrelated" }]);
  assert.deepEqual(m.peers?.missing, ["notfound-zzz.example"]);
  assert.equal(m.peers?.rows[1].growth_12m_pct, 21.5);
});

test("user peers replace the automatic list and are kept even when small", async () => {
  const m = await memoFor("fast-grower.json", "quillnote.example", ["lookalike-blog.example", "recapr.example"]);
  assert.equal(m.peers?.source, "user");
  assert.deepEqual(m.peers?.rows.map(r => r.name), ["Quillnote", "Lookalike Blog", "Recapr"]);
});

test("a headline about another company's layoffs is not a red flag", async () => {
  const m = await memoFor("fast-grower.json", "quillnote.example");
  assert.ok(!m.findings.some(f => f.id === "news_words"));
  assert.equal(m.news.filter(n => /CRM sync/.test(n.title)).length, 1, "duplicate headlines are kept once");
});

test("struggling company: every rule fires with its evidence", async () => {
  const m = await memoFor("struggling.json", "ledgerlane.example");
  const ids = new Set(m.findings.filter(f => f.kind === "red_flag").map(f => f.id));
  for (const id of ["leader_departure", "leadership_churn", "team_contraction", "traffic_falling", "low_employee_rating", "weak_business_outlook", "long_gap_flat_team", "news_words"]) {
    assert.ok(ids.has(id), `${id} fires`);
  }
  const contraction = m.findings.find(f => f.id === "team_contraction")!;
  assert.match(contraction.text, /The team is shrinking: headcount fell by 12 people/);
  assert.match(contraction.text, /Sales shrank from 20 to 12/);
  assert.match(contraction.text, /people left in the last 12 months, \d+% of today's headcount \(interns, advisors and contractors not counted\)/);
  assert.match(m.findings.find(f => f.id === "leadership_churn")!.text, /3 senior sales people left/);
  assert.equal(m.questions[0].startsWith("About the 2026-09-30 story"), true, "news questions come first");
  assert.deepEqual(m.team.departures?.excluded, { interns: 1, advisors_or_contractors: 1 });
  assert.match(m.findings.find(f => f.id === "long_gap_flat_team")!.text, /30 months since the last round, and headcount fell 17% over 12 months/);
  assert.equal(m.findings.filter(f => f.id === "news_words").length, 2, "the layoff and the lawsuit, not the old round");
  assert.ok(m.findings.every(f => f.evidence));
});

test("sparse company: missing sections say not available, never zero", async () => {
  const m = await memoFor("sparse.json", "sproutkit.example");
  assert.equal(m.findings.length, 0);
  assert.ok(m.not_available.some(x => /^Web traffic/.test(x)));
  assert.ok(m.not_available.some(x => /^Funding/.test(x)));
  assert.ok(m.not_available.some(x => /Crustdata lists no competitors/.test(x)));
  const text = renderMemo(m);
  assert.match(text, /### Web traffic\n\nnot available/);
  assert.ok(!/undefined|NaN|\$0\b/.test(text));
  assert.equal(m.funding.facts.length, 0);
});

test("headcount far above the company page range adds a warning", async () => {
  const fx = fixture("fast-grower.json");
  fx.companies[0].basic_info!.employee_count_range = "2-10";
  const m = buildMemo(await bundleFor(fx, "quillnote.example"), NOW);
  assert.ok(m.warnings.some(w => /company page says 2-10/.test(w)));
});

test("a 403 on person search leaves departures out and says why", async () => {
  const fx = fixture("fast-grower.json");
  fx.forbidden = ["/person/search"];
  const m = buildMemo(await bundleFor(fx, "quillnote.example"), NOW);
  assert.equal(m.team.departures, null);
  assert.ok(m.not_available.some(x => /Departures \(not enabled on this Crustdata key/.test(x)));
});

test("identify: the match must own the domain asked; competitor domains are cleaned", () => {
  const row = { matches: [{ company_data: { crustdata_company_id: 1, basic_info: { primary_domain: "other.com", all_domains: ["other.com"] } } }] };
  assert.equal(pickMatch(row, "acme.com"), undefined);
  assert.equal(pickMatch(row, "app.other.com")?.crustdata_company_id, 1);
  assert.deepEqual(competitorDomains({ basic_info: { primary_domain: "acme.com" }, competitors: { paid_seo: [" b.com", "acme.com"], organic_seo: ["b.com", " https://c.io/x"] } }), ["b.com", "c.io"]);
});

test("helpers: news matching, step-backs, countries, ranges, money, rounds, dates", () => {
  assert.equal(namesCompany("Granola lawsuit raises concerns", "Granola", "granola.ai"), true);
  assert.equal(namesCompany("Meta to lay off hundreds", "Granola", "granola.ai"), false);
  assert.equal(namesCompany("Pocket raises seed", "Pocket (YC W26)", "heypocket.com"), true);
  assert.equal(namesCompany("Rival sues read.ai", "Read AI", "read.ai"), true);
  const stepped = { experience: { employment_details: {
    past: [{ title: "CTO", end_date: "2026-05-01", seniority_level: "CXO", crustdata_company_id: 5 }],
    current: [{ title: "Advisor", seniority_level: "Entry Level", crustdata_company_id: 5 }] } } };
  assert.equal(steppedBack(stepped, 5), true);
  const promoted = { experience: { employment_details: {
    past: [{ title: "Director of Product", end_date: "2026-04-01", seniority_level: "Director", crustdata_company_id: 5 }],
    current: [{ title: "VP of Product", seniority_level: "Vice President", crustdata_company_id: 5 }] } } };
  assert.equal(steppedBack(promoted, 5), false);
  assert.deepEqual(countries({ "United States": 10, "California, United States": 8, "Greater London": 4, "United Kingdom": 5, "San Francisco Bay Area": 3, Stockholm: 16, Sweden: 17 }).map(c => c.country), ["Sweden", "United States", "United Kingdom"]);
  assert.deepEqual(parseRange("11-50"), [11, 50]);
  assert.deepEqual(parseRange("10001+"), [10001, Infinity]);
  assert.equal(fmtUsd(125_000_000), "$125M");
  assert.equal(fmtUsd(4_250_000), "$4.25M");
  assert.equal(fmtUsd(60_080), "$60.1K");
  assert.equal(fmtPct(-35.5), "-36%");
  assert.equal(fmtPct(7.77), "+7.8%");
  assert.equal(roundName("series_c"), "Series C");
  assert.equal(roundName("pre_seed"), "Pre-seed");
  assert.equal(monthsBetween("2026-03-25", "2026-11-13"), 7);
  assert.equal(whenIso(1747292460)?.slice(0, 10), "2025-05-15");
  assert.equal(cleanNews([{ article_title: "A", article_publish_date: "2026-01-01" }, { article_title: "B", article_publish_date: null }], "2025-12-01").length, 1);
});

test("leaders only: account reps, chiefs of staff, contract recruiters and advisors are not leadership departures", async () => {
  const { isLeader } = await import("../src/memo.js");
  assert.equal(isLeader({ title: "Strategic Account Executive", seniority_level: "Strategic" }), false);
  assert.equal(isLeader({ title: "Senior Talent Acquisition Partner (via Scede)", seniority_level: "Senior" }), false);
  assert.equal(isLeader({ title: "AI Founder & Startup Advisor - Example Program", seniority_level: "Owner / Partner" }), false);
  assert.equal(isLeader({ title: "Chief of Staff to the CEO", seniority_level: "CXO" }), false);
  assert.equal(isLeader({ title: "Head of Accounting & Tax (Interim)", seniority_level: "Director" }), true);
  assert.equal(isLeader({ title: "CRO, Head of Revenue", seniority_level: "CXO" }), true);
  assert.equal(isLeader({ title: "Regional Director, US-Central", seniority_level: "Director" }), false);
  const lateral = { experience: { employment_details: {
    past: [{ title: "Chief of Staff to the CEO", end_date: "2026-05-01", seniority_level: "CXO", crustdata_company_id: 5 }],
    current: [{ title: "Product Partnerships", seniority_level: "Senior", crustdata_company_id: 5 }] } } };
  assert.equal(steppedBack(lateral, 5), false);
});

test("a secondary sale is not the last round; Legal growing is not a go-to-market signal", async () => {
  const fx = fixture("fast-grower.json");
  const q = fx.companies[0];
  q.funding!.last_round_type = "secondary_market";
  q.funding!.last_fundraise_date = "2026-09-01";
  q.funding!.milestones!.unshift({ date: "2026-09-01", amount_usd: null, round_type: "secondary_market", investors: "Someone" });
  q.headcount!.by_function_timeseries!.CURRENT_FUNCTION!.Sales = q.headcount!.by_function_timeseries!.CURRENT_FUNCTION!.Engineering!;
  q.headcount!.by_function_timeseries!.CURRENT_FUNCTION!.Legal = [{ date: "2026-02-01 00:00:00", employee_count: 2 }, { date: "2026-08-01 00:00:00", employee_count: 9 }];
  const m = buildMemo(await bundleFor(fx, "quillnote.example"), NOW);
  assert.match(m.snapshot.find(f => f.label === "Last round")!.text, /^Series B, \$30M, Apr 2026$/);
  assert.match(m.snapshot.find(f => f.label === "Latest secondary sale")!.text, /Sep 2026/);
  assert.equal(m.funding.facts.find(f => f.label === "Months since last round")!.value, 6);
  assert.ok(!m.findings.some(f => f.id === "function_mix_shift" && /Legal/.test(f.text)));
});

test("no postings in 90 days: the newest posting on record shows whether the job index is behind", async () => {
  const fx = fixture("fast-grower.json");
  fx.jobs!["9000001"] = { total: 0, titles: [], categories: [], newest: { date: "2026-03-02", title: "Account Executive", on_record: 12 } };
  const m = buildMemo(await bundleFor(fx, "quillnote.example"), NOW);
  assert.deepEqual(m.team.hiring?.newest_posting, { date: "2026-03-02", title: "Account Executive", on_record: 12 });
  assert.match(renderMemo(m), /The job index looks behind for this company: Crustdata has 12 postings on record, none added since 2026-08-15\. The newest \(Account Executive\) is from 2026-03-02/);
  fx.jobs!["9000001"].newest = { title: "Staff Engineer", on_record: 18 };
  assert.match(renderMemo(buildMemo(await bundleFor(fx, "quillnote.example"), NOW)), /carries no date, and undated postings never match a date window/);
  const sparse = await memoFor("sparse.json", "sproutkit.example");
  assert.match(renderMemo(sparse), /no job postings on record/);
});

test("a secondary sale is left out of total raised, last round and repeat investors", async () => {
  const fx = fixture("fast-grower.json");
  const f = fx.companies[0].funding!;
  f.milestones!.unshift({ date: "2026-09-01", amount_usd: 20000000, round_type: "secondary_market", investors: "Harbor Light Ventures, Example Capital", lead_investors: "Harbor Light Ventures" });
  f.total_investment_usd = 58500000;
  f.last_round_type = "secondary_market";
  f.last_fundraise_date = "2026-09-01";
  const m = buildMemo(await bundleFor(fx, "quillnote.example"), NOW);
  const total = m.snapshot.find(x => x.label === "Total raised")!;
  assert.equal(total.value, 38500000);
  assert.match(total.text, /\$38\.5M in primary rounds \(the \$58\.5M on record also counts \$20M of secondary sales/);
  assert.deepEqual(m.last_round, { type: "Series B", date: "2026-04-14", amount_usd: 30000000 });
  assert.equal(m.funding.repeat_investors.find(r => r.name === "Harbor Light Ventures"), undefined, "the secondary does not make it a repeat investor");
  assert.equal(m.funding.rounds[0].secondary, true);
});

test("founders: a founder role held at the same time is not 'founded before'; assistants are not executives", async () => {
  const m = await memoFor("fast-grower.json", "quillnote.example");
  const sam = m.team.leaders.find(l => l.name === "Sam Sidequest")!;
  assert.deepEqual(sam.founded_before, [], "Overlap Labs overlapped with this company");
  assert.match(sam.also_running!, /Founder & CEO, Sidequest AI Example \(since May 2025\)/);
  const avery = m.team.leaders.find(l => l.name === "Avery Quill")!;
  assert.deepEqual(avery.founded_before, ["Earlier Startup Example (to 2022)"]);
  assert.ok(!m.team.leaders.some(l => /Assistant/.test(l.title)));
  assert.match(m.findings.find(f => f.id === "repeat_founder")!.text, /Avery Quill \(Earlier Startup Example \(to 2022\)\)/);
});

test("news: a same-name headline with low confidence never becomes a red flag", async () => {
  const m = await memoFor("fast-grower.json", "quillnote.example");
  assert.ok(!m.findings.some(f => f.id === "news_words"));
  assert.ok(!m.news.some(n => /TV networks/.test(n.title)), "below 0.85 confidence it is not listed either");
  assert.equal(aboutCompany({ title: "Linear TV networks lay off staff", confidence: 0.95 }, "Linear", "linear.app"), false);
  assert.equal(aboutCompany({ title: "Linear lays off 20", confidence: 0.95 }, "Linear", "linear.app"), true);
  assert.equal(aboutCompany({ title: "linear regression lays off", confidence: 0.95 }, "Linear", "linear.app"), false);
  assert.equal(aboutCompany({ title: "Layoffs at the notes startup", url: "https://linear.app/blog/changes", confidence: 0.5 }, "Linear", "linear.app"), true);
  assert.equal(aboutCompany({ title: "Dropbox layoffs", url: "https://blog.dropbox.com/layoffs", confidence: 0.5 }, "Box", "box.com"), false);
  assert.equal(aboutCompany({ title: "Tramp lays off", url: "https://tramp.com.au/x", confidence: 0.5 }, "Ramp", "ramp.com"), false);
});

test("PEOPLE_DETAIL=leaders: former staff who are not leaders are not named", async () => {
  const m = buildMemo(await bundleFor(fixture("struggling.json"), "ledgerlane.example"), NOW, { peopleDetail: "leaders" });
  const people = m.team.departures!.people;
  assert.ok(people.some(p => p.leader && p.name));
  assert.ok(people.filter(p => !p.leader).every(p => p.name === "" && !p.profile_url));
  assert.match(renderMemo(m), /\(not named\)/);
});

test("odd API shapes never crash the memo", async () => {
  const mutations: Array<(c: any) => void> = [
    c => { c.funding.milestones[0].investors = ["A", "B"]; },
    c => { c.funding.milestones[0].lead_investors = ["A"]; },
    c => { c.funding.milestones = { x: 1 }; },
    c => { c.basic_info.name = 42; },
    c => { c.taxonomy.categories = "SaaS"; },
    c => { c.headcount.by_function_timeseries.CURRENT_FUNCTION.Sales[0].date = "N/A"; },
    c => { c.web_traffic.domain_traffic["quillnote.example"].monthly_visitors_timeseries[0].date = "2026-13-01"; },
    c => { c.headcount.timeseries[0].date = 20260101; },
    c => { c.people.founders[0].experience.employment_details.past[0].employee_start_date = 2018; },
    c => { c.news[0].article_title = 7; },
    c => { c.basic_info.employee_count_range = 50; },
    c => { c.headcount.timeseries = { a: 1 }; },
    c => { c.people.founders.push(null); },
    c => { c.followers = "many"; },
    c => { c.people = []; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const fx = fixture("fast-grower.json");
    const b = await bundleFor(fx, "quillnote.example");
    mutate(b.company);
    assert.doesNotThrow(() => renderMemo(buildMemo(b, NOW)), `mutation ${i}`);
  }
  assert.equal(sanitizeCompany({ basic_info: { name: 42 } }).basic_info?.name, "42");
});

test("a big company: only C-level, VP and founders are leaders; heads of are senior", async () => {
  const fx = fixture("struggling.json");
  fx.companies[1].headcount!.total = 600;
  const m = buildMemo(await bundleFor(fx, "ledgerlane.example"), NOW);
  const head = m.team.departures!.people.find(p => p.title === "Head of Sales")!;
  assert.equal(head.leader, false);
  assert.equal(head.senior, true);
  assert.ok(m.team.departures!.people.find(p => p.title === "VP Engineering")!.leader);
});

test("round 2: far larger peers, rep titles, GTM leaders, named founder question, country question threshold", async () => {
  const fx = fixture("fast-grower.json");
  fx.companies.find(c => c.crustdata_company_id === 9000011)!.headcount!.total = 5000;
  const m = buildMemo(await bundleFor(fx, "quillnote.example"), NOW);
  assert.ok(m.peers!.dropped.some(d => d.domain === "tallyminutes.example" && d.reason === "large"));
  const { isLeader } = await import("../src/memo.js");
  assert.equal(isLeader({ title: "GTM Leader", seniority_level: "Senior" }), true);
  assert.equal(isLeader({ title: "Engineering Lead", seniority_level: "Senior" }), false, "a lead at a mid-size company is senior, not a leader");
  assert.equal(isLeader({ title: "Engineering Lead", seniority_level: "Senior" }, false, true), true, "below 100 people it is a leader");
  assert.equal(isLeader({ title: "President's Club Sales Rep", seniority_level: "Senior" }), false);
  const s = buildMemo(await bundleFor(fixture("struggling.json"), "ledgerlane.example"), NOW);
  assert.ok(!s.team.departures!.people.some(p => p.title === "Strategic Account Director" && p.senior));
  assert.match(m.questions.find(q => /founded/.test(q))!, /Avery Quill founded Earlier Startup Example before: what happened to it, and what are you doing differently at Quillnote\?/);
  assert.ok(!m.questions.some(q => /where will the next hires go/.test(q)), "13% in the second country is too small to ask about");
});

test("round 2 engineer: a failed departures search is not a small real number; step-backs follow company size; names stay hidden", async () => {
  const fx = fixture("struggling.json");
  fx.faults = [{ path: "/person/search", call: 1, status: 500, message: "boom" }];
  const m = buildMemo(await bundleFor(fx, "ledgerlane.example"), NOW);
  assert.equal(m.team.departures?.searched, false);
  assert.equal(m.team.departures?.share_of_headcount_pct, undefined);
  assert.ok(m.not_available.some(x => /^Departures \(.*only senior role changes are shown\)/.test(x)));
  assert.ok(!m.findings.some(f => f.id === "high_attrition" || /left in the last 12 months, \d+%/.test(f.text)));
  assert.match(renderMemo(m), /The departures search failed for this company/);

  const big = fixture("fast-grower.json");
  big.companies[0].headcount!.total = 600;
  big.senior!["9000001"].people[1].experience!.employment_details!.past![0].title = "Head of Partnerships";
  big.senior!["9000001"].people[1].experience!.employment_details!.past![0].seniority_level = "Director";
  const mb = buildMemo(await bundleFor(big, "quillnote.example"), NOW, { peopleDetail: "leaders" });
  assert.ok(!mb.findings.some(f => f.id === "leader_step_back"), "a head of at 600 people is not a leader");
  const ml = buildMemo(await bundleFor(fixture("struggling.json"), "ledgerlane.example"), NOW, { peopleDetail: "leaders" });
  for (const f of ml.findings) assert.ok(!/Alex Example|Robin Example|Kim Example|Pat Intern|Lee Contract/.test(`${f.text} ${f.question ?? ""}`), f.text);
});

test("round 2 engineer: odd shapes in the identify and enrich answers never stop a list", async () => {
  freshOutLocal();
  const fx = fixture("inbound-deals.json");
  (fx.companies[0] as any).competitors = { paid_seo: { a: 1 }, organic_seo: "x" };
  (fx.companies[0] as any).basic_info.all_domains = { x: 1 };
  globalThis.fetch = fakeFetch(fx).fetch;
  const got = await collect("quillnote.example", { today: NOW, leaversLimit: 25, peersLimit: 5 }, new Cache("/nonexistent", 0));
  assert.equal(got.status, "ok");
});

test("round 3: few postings next to fast hiring say the index is likely missing them", async () => {
  const fx = fixture("fast-grower.json");
  fx.jobs!["9000001"] = { total: 1, titles: [{ title: "Engineer", count: 1 }], categories: [] };
  const m = buildMemo(await bundleFor(fx, "quillnote.example"), NOW);
  assert.deepEqual(m.team.hiring?.thin_for_growth, { added_3m: 11 });
  assert.match(renderMemo(m), /Only 1 posting was added in 90 days while headcount grew by 11 in 3 months/);
});
