import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_UPPER_YEAR, buildRounds, estimateCost, fundingFilter, keepAcrossSentences, mergeSpec, parseFlags, parseSentence, pipelineKey,
  describeSpec, resolveDates, sameSpec, searchKey, sentenceWarnings,
} from "../src/thesis.js";

const today = new Date("2026-10-21T12:00:00Z");

test("the README thesis: stage, place and founding year become filters, the rest is the query", () => {
  const p = parseSentence("AI infrastructure, pre-seed or seed, US, founded 2024 or later", today);
  assert.deepEqual(p.stages, ["pre_seed", "seed"]);
  assert.deepEqual(p.countries, ["USA"]);
  assert.deepEqual(p.founded, [2024, NO_UPPER_YEAR]);
  assert.equal(p.query, "AI infrastructure");
  assert.equal(p.unfunded, undefined);
});

test("the brief's long thesis: size range, two places, B2B words stay in the query", () => {
  const p = parseSentence("B2B infrastructure for AI agents, pre-seed or seed, founded 2024 or later, 3 to 40 people, US or Europe", today);
  assert.deepEqual(p.size, [3, 40]);
  assert.ok(p.countries!.includes("USA") && p.countries!.includes("DEU"));
  assert.equal(p.query, "B2B infrastructure for AI agents");
});

test("founding year phrasings", () => {
  assert.deepEqual(parseSentence("dev tools founded in 2025", today).founded, [2025, 2025]);
  assert.deepEqual(parseSentence("dev tools founded since 2023", today).founded, [2023, NO_UPPER_YEAR]);
  assert.deepEqual(parseSentence("dev tools founded after 2023", today).founded, [2024, NO_UPPER_YEAR]);
  assert.deepEqual(parseSentence("dev tools founded 2022 to 2024", today).founded, [2022, 2024]);
  // Relative ages stay relative and become a year on each run, so a weekly re-run keeps meaning "the last 2 years".
  assert.equal(parseSentence("dev tools founded in the last 2 years", today).foundedWithinYears, 2);
  assert.equal(parseSentence("dev tools less than 3 years old", today).foundedWithinYears, 3);
  const rel = mergeSpec({ thesis: "x" }, { foundedWithinYears: 2, raisedWithinMonths: 12 });
  assert.deepEqual(resolveDates(rel, today).founded, [2024, NO_UPPER_YEAR]);
  assert.deepEqual(resolveDates(rel, new Date("2027-10-21T12:00:00Z")).founded, [2025, NO_UPPER_YEAR]);
  assert.equal(resolveDates(rel, today).raisedSince, "2025-10-21");
  // "founded in the last 2 years" is not a raise date
  assert.equal(parseSentence("dev tools founded in the last 2 years", today).raisedSince, undefined);
});

test("stages: ranges, Series letters, unfunded, and words that are not stages", () => {
  assert.deepEqual(parseSentence("fintech, seed to Series B", today).stages, ["seed", "series_a", "series_b"]);
  assert.deepEqual(parseSentence("fintech, Series A or B", today).stages, ["series_a", "series_b"]);
  const u = parseSentence("climate software, pre-seed, seed or unfunded", today);
  assert.deepEqual(u.stages, ["pre_seed", "seed"]);
  assert.equal(u.unfunded, true);
  assert.equal(parseSentence("bootstrapped vertical SaaS", today).unfunded, true);
  assert.equal(parseSentence("Series E-commerce tools for C-level buyers", today).stages, undefined);
});

test("growth, raise recency and investors", () => {
  const g = parseSentence("agent tooling growing 30% in the last 3 months", today);
  assert.equal(g.minGrowth, 30);
  assert.equal(g.query, "agent tooling", "the period is read, not left in the query");
  const g12 = parseSentence("agent tooling that grew 50% in the last 12 months", today);
  assert.equal(g12.growthPeriod, "12m");
  assert.match(JSON.stringify(buildRounds(mergeSpec({ thesis: "x" }, g12)).at(-1)!.filters), /headcount.growth_percent.12m/);
  assert.equal(parseSentence("agent tooling grew 40% in 6 months", today).growthPeriod, "6m");
  assert.equal(parseSentence("agent tooling, seed, raised in the last 18 months", today).raisedWithinMonths, 18);
  assert.deepEqual(parseSentence("YC-backed devtools", today).withInvestors, ["Y Combinator"]);
});

test("warnings say what is not a filter, before any credit is spent", () => {
  const s = "repeat founders from ex-Ledgerpine teams building payments infra with real ARR";
  const w = sentenceWarnings(s, parseSentence(s, today)).join("\n");
  assert.match(w, /No stage/);
  assert.match(w, /--founders-from/);
  assert.match(w, /Repeat founders score higher/);
  assert.match(w, /Revenue is not a filter/);
  assert.match(sentenceWarnings("Seris A fintech", parseSentence("Seris A fintech", today)).join(), /did you mean Series A/);
});

test("flags: values, switches, none clears, bad values fail with the fix", () => {
  const { flags, out, ai } = parseFlags(["--thesis", "x", "--size", "3-40", "--founded", "2024+", "--only-founders-from", "ledgerpine.example, Cloudmere", "--schools", "MIT", "--timing", "fresh", "--out", "out/fund-a", "--ai", "--no-posts", "--stage", "Pre-Seed"]);
  assert.deepEqual(flags.size, [3, 40]);
  assert.deepEqual(flags.founded, [2024, NO_UPPER_YEAR]);
  assert.deepEqual(flags.foundersFrom, ["ledgerpine.example", "Cloudmere"]);
  assert.equal(flags.onlyFoundersFrom, true);
  assert.equal(flags.timing, "fresh");
  assert.equal(flags.postsFor, 0);
  assert.equal(flags.quotes, 0);
  assert.deepEqual(flags.stages, ["pre_seed"]);
  assert.equal(out, "out/fund-a");
  assert.equal(ai, true);
  assert.equal(parseFlags(["--stage", "none"]).flags.stages, null);
  assert.equal(parseFlags(["--unfunded"]).flags.unfunded, true);
  assert.throws(() => parseFlags(["--timing", "soon"]), /due, fresh or off/);
  assert.throws(() => parseFlags(["--size", "big"]), /range like 3-40/);
  assert.throws(() => parseFlags(["--wat", "1"]), /Unknown flag --wat/);
  assert.throws(() => parseFlags(["--limit"]), /needs a value/);
  assert.throws(() => parseFlags(["stray"]), /Unexpected argument/);
});

test("merging: flags win over the sentence; a new sentence keeps your lists and limits", () => {
  const s = "AI infrastructure, seed, US";
  const spec = mergeSpec({ thesis: s }, parseSentence(s, today), parseFlags(["--country", "GBR", "--founders-from", "ledgerpine.example", "--limit", "40"]).flags);
  assert.deepEqual(spec.countries, ["GBR"]);
  assert.equal(spec.limit, 40);
  const kept = keepAcrossSentences(spec);
  assert.equal(kept.countries, undefined);
  assert.deepEqual(kept.foundersFrom, ["ledgerpine.example"]);
  assert.equal(kept.limit, 40);
  assert.equal(mergeSpec({ thesis: "x" }).timing, "due");
  assert.throws(() => mergeSpec({}), /--thesis/);
});

test("what counts as the same search, the same pipeline and the same settings", () => {
  const a = mergeSpec({ thesis: "x" }, { stages: ["seed"] });
  const b = mergeSpec({ thesis: "x" }, { stages: ["seed"], schools: ["MIT"], timing: "fresh" });
  const c = mergeSpec({ thesis: "x" }, { stages: ["seed"], limit: 50 });
  assert.equal(searchKey(a), searchKey(b), "schools and timing only change the score");
  assert.notEqual(searchKey(a), searchKey(c), "a bigger limit is a new search");
  assert.equal(pipelineKey(a), pipelineKey(c), "a bigger limit is still the same pipeline");
  assert.ok(!sameSpec(a, b));
  assert.ok(sameSpec(a, mergeSpec({ stages: ["seed"] }, { thesis: "x" })));
});

test("rounds and the funding filter", () => {
  const spec = mergeSpec({ thesis: "x", query: "x" }, { stages: ["seed"], unfunded: true, founded: [2024, NO_UPPER_YEAR], minGrowth: 20, excludeInvestors: ["Fund A"], countries: ["USA"] });
  const rounds = buildRounds(spec);
  assert.equal(rounds.length, 3);
  const json = JSON.stringify(rounds[2].filters);
  assert.match(json, /"field":"basic_info.year_founded","type":"=>","value":2024/);
  assert.match(json, /"field":"funding.last_fundraise_date","type":"is_null","value":null/);
  assert.match(json, /"field":"funding.investors","type":"not_in","value":\["Fund A"\]/);
  assert.match(json, /"field":"headcount.growth_percent.3m","type":"=>","value":20/);
  assert.doesNotMatch(json, />=|<=/, "Crustdata writes => and =<");
  const f = fundingFilter(mergeSpec({ thesis: "x" }, { stages: ["seed"], unfunded: true }));
  assert.equal((f.filter as { op: string }).op, "or");
  assert.equal(fundingFilter(mergeSpec({ thesis: "x" })).filter, undefined);
});

test("the cost line names list price and the free counts", () => {
  const line = estimateCost(mergeSpec({ thesis: "x" }, { stages: ["seed"] }), 1);
  assert.match(line, /credits at list price/);
  assert.match(line, /Counting roles and posts is free/);
  assert.doesNotMatch(line, /\$/);
});

test("several places in one thesis are all kept, as one either-or filter", () => {
  const f = (s: string) => JSON.stringify(buildRounds(mergeSpec({ thesis: s }, parseSentence(s, today)))[0].filters);
  const bayOrLondon = parseSentence("AI agents, seed, Bay Area or London", today);
  assert.deepEqual(bayOrLondon.near?.map(n => n.location), ["San Francisco, CA", "London, UK"]);
  assert.match(f("AI agents, seed, Bay Area or London"), /"op":"or".*San Francisco.*London/);
  const txCa = parseSentence("fintech, seed, Texas or Canada", today);
  assert.deepEqual(txCa.states, ["Texas"]);
  assert.deepEqual(txCa.countries, ["CAN"]);
  assert.ok(parseSentence("AI startups in California or Europe", today).countries!.includes("DEU"));
  assert.equal(parseSentence("devtools, Bay Area, US", today).countries, undefined, "the US only repeats where the Bay Area is");
  assert.deepEqual(parseSentence("govtech in Washington DC", today).near?.map(n => n.location), ["Washington, DC"]);
  assert.equal(parseSentence("govtech in Washington DC", today).states, undefined);
  assert.equal(parseSentence("AI for the US Army", today).countries, undefined, "a customer, not a place");
});

test("stage words that describe the customer are not stages", () => {
  assert.equal(parseSentence("software for angel investors and VCs", today).stages, undefined);
  assert.equal(parseSentence("cap table tools for seed funds", today).stages, undefined);
  assert.deepEqual(parseSentence("fintech, pre-Series A", today).stages, ["pre_seed", "seed"]);
  assert.deepEqual(parseSentence("fintech, Series B+", today).stages?.slice(0, 2), ["series_b", "series_c"]);
  assert.deepEqual(parseSentence("fintech, Series B and later", today).stages?.at(-1), "series_j");
  assert.deepEqual(parseSentence("fintech, post-seed", today).stages, ["seed"]);
  assert.doesNotMatch(parseSentence("fintech, post-seed", today).query!, /post/);
  assert.equal(parseSentence("fintech in Canada or the US, seed to Series A", today).query, "fintech");
});

test("flags: whole numbers, real dates, 10+, did you mean, --out needs a folder", () => {
  assert.throws(() => parseFlags(["--limit", "2.7"]), /whole number/);
  assert.throws(() => parseFlags(["--min-growth", "0x10"]), /takes a number/);
  assert.throws(() => parseFlags(["--raised-since", "2025-02-31"]), /Dates look like/);
  assert.deepEqual(parseFlags(["--size", "10+"]).flags.size, [10, 1_000_000]);
  assert.throws(() => parseFlags(["--school", "MIT"]), /Did you mean --schools/);
  assert.throws(() => parseFlags(["--out", "--force"]), /--out needs a value/);
  assert.deepEqual(parseFlags(["--exclude", "My Portfolio, 2026.csv"]).flags.exclude, ["My Portfolio, 2026.csv"], "a file name with a comma stays whole");
  assert.equal(parseFlags(["--growth-months", "6"]).flags.growthPeriod, "6m");
  assert.throws(() => parseFlags(["--growth-months", "9"]), /3, 6 or 12/);
});

test("the cost line gives a typical figure and a ceiling, from the same model as the README", () => {
  const spec = mergeSpec({ thesis: "x" }, { stages: ["seed"] });
  const line = estimateCost(spec, 1);
  assert.match(line, /^about 2\d credits at list price, at most 5\d /);
  assert.match(line, /about 20 founder profiles/);
});

test("round 2: DC, West Virginia, non-YC, past year, customer markets, canonical values, flags", () => {
  assert.equal(parseSentence("EV charging networks building DC fast chargers, seed", today).near, undefined);
  assert.equal(parseSentence("power electronics for DC microgrids", today).near, undefined);
  assert.deepEqual(parseSentence("govtech startups in DC, seed", today).near?.map(n => n.location), ["Washington, DC"]);
  assert.equal(parseSentence("apps for the LA Lakers fans", today).near, undefined);
  assert.deepEqual(parseSentence("supply chain software in West Virginia", today).states, ["West Virginia"]);
  const nonYc = parseSentence("Non-YC AI startups, seed", today);
  assert.deepEqual(nonYc.excludeInvestors, ["Y Combinator"]);
  assert.equal(nonYc.withInvestors, undefined);
  assert.equal(parseSentence("devtools that grew 40% over the past year", today).growthPeriod, "12m");
  assert.deepEqual(parseSentence("fintech for the UK market, seed, US", today).countries, ["USA"]);
  assert.equal(parseSentence("AI agents for seed-stage startups", today).stages, undefined);
  assert.deepEqual(parseSentence("Copilots for lawyers seed stage", today).stages, ["seed"]);
  assert.doesNotMatch(parseSentence("multi-stage pipelines for any stage company, seed", today).query!, /-\s|\bany\b/);
  const canon = mergeSpec({ thesis: "x" }, { countries: ["usa", "germany"], states: ["texas"] });
  assert.deepEqual(canon.countries, ["USA", "Germany"]);
  assert.deepEqual(canon.states, ["Texas"]);
  assert.throws(() => parseFlags(["--limit", "2000"]), /at most 1000/);
  assert.equal(parseFlags(["--yes=true"]).yes, true);
  assert.throws(() => parseFlags(["stray"]), /put -- before the flags/);
  const cleared = parseFlags(["--exclude", "a.example", "--exclude", "none"]).flags;
  assert.equal(cleared.exclude, null);
  assert.doesNotMatch(estimateCost(mergeSpec({ thesis: "x" }, { quotes: 0, jobsFor: 0, postsFor: 0 }), 1), /up to 0|and posts/);
});

test("round 3: year over year, New England, New South Wales, negations, founded before, per-stage timing line", () => {
  const yoy = parseSentence("fintech growing 25% year over year", today);
  assert.equal(yoy.growthPeriod, "12m");
  assert.equal(yoy.query, "fintech");
  assert.deepEqual(parseSentence("New England biotech, seed", today).countries, undefined);
  assert.ok(parseSentence("New England biotech, seed", today).states!.includes("Massachusetts"));
  assert.deepEqual(parseSentence("fintech in New South Wales", today).countries, ["AUS"]);
  assert.equal(parseSentence("Bank of America alumni building fintech", today).countries, undefined);
  assert.deepEqual(parseSentence("fintech, seed, not backed by Y Combinator", today).excludeInvestors, ["Y Combinator"]);
  assert.deepEqual(parseSentence("AI agents, seed, not backed by Sequoia Capital", today).excludeInvestors, ["Sequoia Capital"]);
  const notUs = parseSentence("devtools, seed, not in the US", today);
  assert.equal(notUs.countries, undefined);
  assert.match(notUs.notes!.join(), /places to leave out are not read/);
  assert.deepEqual(parseSentence("robotics founded before 2022", today).founded, [1900, 2021]);
  assert.match(describeSpec(resolveDates(mergeSpec({ thesis: "x" }, { stages: ["series_a"] }), today)), /18 to 30 months after a Series A or later/);
  assert.equal(parseSentence("AI agents for seed-stage startups and Series A companies", today).stages, undefined);
  assert.deepEqual(mergeSpec({ thesis: "x" }, { countries: ["US", "uk"] }).countries, ["USA", "GBR"]);
  assert.equal(parseFlags(["--yes=false"]).yes, false);
});

test("round 5: negated investors and place lists never become the opposite filter; YoY forms; under N people", () => {
  const ex = parseSentence("AI infra, excluding companies backed by Y Combinator", today);
  assert.deepEqual(ex.excludeInvestors, ["Y Combinator"]);
  assert.equal(ex.withInvestors, undefined);
  const both = parseSentence("YC-backed fintech, not backed by Sequoia Capital", today);
  assert.deepEqual(both.withInvestors, ["Y Combinator"]);
  assert.deepEqual(both.excludeInvestors, ["Sequoia Capital"]);
  assert.equal(parseSentence("devtools, seed, not in the US or Canada", today).countries, undefined);
  assert.equal(parseSentence("devtools, seed, outside the US and Europe", today).countries, undefined);
  assert.equal(parseSentence("Climate startups. Not in the US", today).countries, undefined);
  assert.equal(parseSentence("fintech with 40% YoY growth", today).growthPeriod, "12m");
  assert.equal(parseSentence("fintech with YoY growth of 40%", today).growthPeriod, "12m");
  assert.equal(parseSentence("fintech with YoY growth of 40%", today).query, "fintech");
  assert.deepEqual(parseSentence("fintech, under 50 people", today).size, [2, 49]);
  assert.deepEqual(parseSentence("fintech, up to 50 people", today).size, [2, 50]);
  assert.match(sentenceWarnings("fintech not backed by a16z", parseSentence("fintech not backed by a16z", today)).join(), /--exclude-investors/);
});

test("round 6: founder backgrounds stay out of the description query; the stage note respects --stage", () => {
  assert.equal(parseSentence("climate tech, Bay Area, repeat founders", today).query, "climate tech");
  assert.equal(parseSentence("devtools startups founded by ex-Stripe engineers", today).query, "devtools");
  assert.equal(parseSentence("fintech with serial founders, seed", today).query, "fintech");
  const s = "AI infrastructure";
  assert.match(sentenceWarnings(s, parseSentence(s, today)).join(), /No stage/);
  assert.doesNotMatch(sentenceWarnings(s, parseSentence(s, today), { stages: ["seed"] }).join(), /No stage/);
  assert.match(sentenceWarnings("devtools founded by ex-Stripe engineers", parseSentence("devtools founded by ex-Stripe engineers", today)).join(), /--founders-from "Stripe"/);
});

test("round 6: negated places, stages, investor lists and sizes never become the opposite filter", () => {
  const p = (s: string) => parseSentence(s, today);
  for (const s of ["climate, not based in New York or Boston", "seed fintech, not headquartered in London", "non-US AI startups",
    "AI not from the US", "healthcare AI, anywhere but the US", "not US-based AI startups"]) {
    const r = p(s);
    assert.equal(r.countries, undefined, s); assert.equal(r.states, undefined, s); assert.equal(r.near, undefined, s);
    assert.doesNotMatch(r.query ?? "", /\b(?:not|non|but)\b/, s);
  }
  assert.equal(p("robotics, not Series A").stages, undefined);
  assert.deepEqual(p("robotics, Series A, not seed").stages, ["series_a"]);
  assert.deepEqual(p("seed or pre-seed, not Series A").stages, ["pre_seed", "seed"]);
  assert.equal(p("companies that have not raised a Series A").stages, undefined);
  assert.deepEqual(p("not backed by Sequoia or Y Combinator").excludeInvestors, ["Sequoia", "Y Combinator"]);
  assert.equal(p("not backed by Sequoia or Y Combinator").withInvestors, undefined);
  assert.equal(p("without backing from YC").withInvestors, undefined);
  assert.deepEqual(p("Seed companies with no more than 20 employees in Berlin").size, [2, 20]);
  assert.equal(p("Seed companies with no more than 20 employees in Berlin").near?.length, 1, "a number ends the negation");
  assert.equal(p("no-code tools in Berlin, seed").near?.length, 1, "no-code is not a negation");
  assert.deepEqual(p("no fewer than 10 people, devtools").size, [10, 1000000]);
  assert.deepEqual(p("Series A, tools for angel investors").stages, ["series_a"]);
  assert.deepEqual(p("seed-stage fintech selling to Series A companies").stages, ["seed"]);
  assert.deepEqual(p("founded in 2024 or 2025, devtools").founded, [2024, 2025]);
  for (const s of ["fintech, 50% YoY, seed", "headcount up 30% YoY, seed", "fintech that grew 2x year over year, seed"]) assert.equal(p(s).growthPeriod, "12m", s);
  assert.equal(p("fintech that grew 2x year over year, seed").minGrowth, 100);
  const austin = p("seed robotics in Austin, Texas");
  assert.equal(austin.states, undefined, "a city's own state is part of its name");
  assert.equal(austin.near?.[0].location, "Austin, TX");
});

test("round 6: --country or --state replaces the places in the sentence", () => {
  const s = "fintech in Boston, seed";
  const spec = mergeSpec({ thesis: s }, parseSentence(s, today), parseFlags(["--country", "GBR"]).flags);
  assert.deepEqual(spec.countries, ["GBR"]);
  assert.ok(!spec.near?.length && !spec.states?.length);
});
