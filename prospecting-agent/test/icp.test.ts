import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRounds, isSideRole, keepAcrossSentences, mergeSpec, parseFlags, parseSentence, peopleFilters, personRank, sentenceWarnings, titleIndex, titleLeaf, whyDropped } from "../src/icp.js";

const today = new Date("2026-10-15T00:00:00Z");
const parse = (s: string) => parseSentence(s, today);

test("reads size, stage range and leaves the business description as the query", () => {
  assert.deepEqual(parse("companies building AI sales or recruiting agents, 20 to 500 people, raised seed to Series B"), {
    size: [20, 500], raised: ["seed", "series_a", "series_b"], query: "companies building AI sales or recruiting agents",
  });
});

test("reads country, a stage list and a raise recency in the same clause", () => {
  const r = parse("B2B SaaS, 50 to 500 people, US, raised Series A or B in the last 18 months, sells to finance teams");
  assert.deepEqual(r.size, [50, 500]);
  assert.deepEqual(r.raised, ["series_a", "series_b"]);
  assert.deepEqual(r.countries, ["USA"]);
  assert.equal(r.since, "2025-04-15");
  assert.equal(r.query, "B2B SaaS, sells to finance teams");
});

test("size phrasings", () => {
  assert.deepEqual(parse("fintech under 200 employees").size, [1, 200]);
  assert.deepEqual(parse("dev tools with 1,000+ employees").size, [1000, 1_000_000]);
  assert.deepEqual(parse("over 1.5k employees").size, [1500, 1_000_000]);
  assert.deepEqual(parse("between 50 and 500 people").size, [50, 500]);
  assert.equal(parse("robotics companies between 50 and 500 people").query, "robotics companies");
});

test("stage ranges, plus and reversed ranges", () => {
  assert.deepEqual(parse("series A-C companies").raised, ["series_a", "series_b", "series_c"]);
  assert.deepEqual(parse("raised Series A through C").raised, ["series_a", "series_b", "series_c"]);
  assert.deepEqual(parse("series h+ companies").raised, ["series_h", "series_i", "series_j"]);
  assert.deepEqual(parse("Series B to seed").raised, ["seed", "series_a", "series_b"]);
  assert.deepEqual(parse("series g companies").raised, ["series_g"]);
});

test("does not read stages out of other words", () => {
  for (const s of ["linseed oil makers", "aniseed exporters", "selling to C-level buyers", "Series E-commerce platforms"]) {
    assert.equal(parse(s).raised, undefined, s);
  }
  assert.deepEqual(parse("Series B and e-commerce").raised, ["series_b"]);
});

test("countries: U.S., North America, and no false USA for Latin America", () => {
  assert.deepEqual(parse("SaaS in the U.S. market").countries, ["USA"]);
  assert.deepEqual(parse("SaaS in North America").countries, ["USA", "CAN"]);
  assert.deepEqual(parse("fintech in Latin America").countries, ["BRA", "MEX", "ARG", "COL", "CHL", "PER", "URY", "ECU"]);
  assert.equal(parse("fintech in Latin America").query, "fintech");
  assert.equal(parse("software for us and our friends").countries, undefined);
});

test("a recency only becomes a raise date when the clause talks about funding", () => {
  assert.equal(parse("companies founded in the last 2 years").since, undefined);
  assert.equal(parse("startups, headcount grew 30% in the past 12 months").since, undefined);
  assert.equal(parse("startups that raised a seed round since 2025").since, "2025-01-01");
  assert.equal(parse("startups that raised since 2025-13").since, undefined);
});

test("flags: values, none clears, unknown flags and missing values fail", () => {
  assert.deepEqual(parseFlags(["--size", "50-500", "--raised=series_a,series_b", "--yes"]), { flags: { size: [50, 500], raised: ["series_a", "series_b"] }, yes: true, fresh: false, explain: false, force: false });
  assert.deepEqual(parseFlags(["--explain", "--fallback", "none"]).flags, { fallback: false });
  assert.equal(parseFlags(["--explain"]).explain, true);
  assert.deepEqual(parseFlags(["--since", "none"]).flags, { since: null });
  assert.throws(() => parseFlags(["--sise", "50-500"]), /Unknown flag --sise/);
  assert.throws(() => parseFlags(["--job-keywords", "x"]), /Unknown flag/, "watching is set up with Crustdata, not here");
  assert.throws(() => parseFlags(["--size"]), /needs a value/);
  assert.throws(() => parseFlags(["--since", "2025-13"]), /Dates look like/);
});

test("merging: flags win, null clears, a new sentence keeps titles and exclusions", () => {
  const saved = mergeSpec({ icp: "old", query: "old", size: [1, 10], titles: ["CFO"], exclude: ["acme.com"], since: "2025-01-01" });
  const next = mergeSpec(keepAcrossSentences(saved), { icp: "new sentence" }, { query: "new sentence" }, { since: null });
  assert.deepEqual(next.titles, ["CFO"]);
  assert.deepEqual(next.exclude, ["acme.com"]);
  assert.deepEqual(next.size, [10, 1_000_000], "the default floor comes back when a sentence has no size");
  assert.equal(next.since, undefined);
  assert.equal(next.limit, 100);
  assert.throws(() => mergeSpec({}), /Describe your ideal customer/);
});

test("rounds add one group of filters at a time; an open-ended size has no upper bound", () => {
  const spec = mergeSpec({ icp: "x", size: [1000, 1_000_000], raised: ["seed"], growth: 20 });
  const rounds = buildRounds(spec);
  assert.equal(rounds.length, 3);
  assert.deepEqual(rounds.map(r => r.name), ["Round 1: the sentence plus size and place", "Round 2: plus funding", "Round 3: plus growth"]);
  assert.equal(buildRounds(mergeSpec({ icp: "x", industries: ["Software Development"], growth: 20 }))[1].name, "Round 2: plus industry and growth");
  assert.deepEqual(rounds[0].filters, { op: "and", conditions: [{ field: "headcount.total", type: "=>", value: 1000 }] });
  assert.equal((rounds[2].filters as any).conditions.length, 3);
  assert.equal(buildRounds(mergeSpec({ icp: "x", size: null }))[0].filters, undefined);
  assert.deepEqual((buildRounds(mergeSpec({ icp: "x" }))[0].filters as any).conditions, [{ field: "headcount.total", type: "=>", value: 10 }]);
});

test("why a company dropped names the filter it failed", () => {
  const spec = mergeSpec({ icp: "x", raised: ["seed"], industries: ["Software Development"] });
  assert.equal(whyDropped({ crustdata_company_id: 1, funding: { last_round_type: "series_c" }, taxonomy: { professional_network_industries: ["Banking"] } }, spec), "last round series_c, industry");
  assert.equal(whyDropped({ crustdata_company_id: 1, funding: { last_round_type: "seed" }, taxonomy: { professional_network_industries: ["Software Development"] } }, spec), "ranked lower once the filters changed the candidate pool");
});

test("people: exact match for short titles, side roles, ranking by your title order", () => {
  assert.equal((titleLeaf("CTO") as any).conditions[0].type, "[.]", "short titles match as exact words");
  assert.equal((titleLeaf("CTO") as any).conditions[1].value, "Chief Technology Officer", "and their long form");
  assert.equal((titleLeaf("Head of Engineering") as any).type, "(.)");
  assert.equal(titleIndex("Chief Executive Officer", ["CEO"]), 0);
  assert.equal(titleIndex("Senior Executive Assistant to the Chief Sales Officer", ["CEO", "CRO"]), -1);
  assert.equal(titleIndex("VP of Sales", ["VP Sales"]), 0);
  assert.equal(titleIndex("VP, Engineering", ["VP Engineering"]), 0, "punctuation between the words does not matter");
  assert.equal(titleIndex("Vice President - Engineering", ["VP Engineering"]), 0);
  assert.equal(titleIndex("Vice President (Engineering)", ["VP of Engineering"]), 0);
  assert.equal(titleIndex("CTO / Co-Founder", ["CEO", "CTO"]), 1);
  assert.equal(titleIndex("SVP of Sales", ["VP Sales"]), -1, "a senior VP is not a VP");
  assert.equal(titleIndex("Senior Vice President, Sales", ["SVP Sales"]), 0);
  assert.equal(titleIndex("EVP Sales", ["Executive Vice President of Sales"]), 0);
  assert.equal(titleIndex("Senior Vice President of Sales", ["VP Sales"]), -1);
  assert.equal(titleIndex("Associate VP, Sales", ["VP Sales"]), -1);
  assert.equal(titleIndex("Co-Founder & CEO", ["Co-Founder"]), 0, "punctuation in your own title is fine too");
  assert.equal(titleIndex("Co-founder", ["Co-Founder"]), 0);
  assert.equal(titleIndex("Founder/CEO", ["Founder/CEO"]), 0);
  assert.equal(titleIndex("Head of FP&A", ["Head of FP&A"]), 0);
  assert.equal(isSideRole("Advisor"), true);
  assert.equal(isSideRole("Founder & CEO"), false);
  assert.equal(isSideRole("Head of International Sales"), false);
  const titles = ["CEO", "CTO"];
  assert.ok(personRank("Co-Founder & CEO", "CXO", titles) < personRank("CTO", "CXO", titles));
  assert.ok(personRank("CTO", "CXO", titles) < personRank("VP Sales", "Vice President", titles));
  assert.ok(personRank("Director of Data", "Director", titles) > personRank("VP Sales", "Vice President", titles));
});

test("round 2 review cases: articles, -stage/-funded, founded vs raised, hyphenated countries", () => {
  assert.deepEqual(parse("Series B, a fintech").raised, ["series_b"]);
  assert.deepEqual(parse("raised Series B and a great team").raised, ["series_b"]);
  assert.deepEqual(parse("seed-stage fintech").raised, ["seed"]);
  assert.equal(parse("seed-stage fintech").query, "fintech");
  assert.deepEqual(parse("Series A-funded robotics").raised, ["series_a"]);
  const h = parse("healthtech with 50 to 500 people founded in the last 3 years that raised a seed round");
  assert.deepEqual([h.size, h.raised, h.since], [[50, 500], ["seed"], undefined]);
  assert.equal(h.query, "healthtech founded in the last 3 years");
  assert.equal(parse("companies founded since 2020 that raised a series a").since, undefined);
  assert.equal(parse("fintech, Series A or B in the last 18 months").since, "2025-04-15");
  assert.equal(parse("startups that raised money in the last 6 months").query, "startups");
  const us = parse("US-based logistics software");
  assert.deepEqual([us.countries, us.query], [["USA"], "logistics software"]);
  assert.equal(parse("developer tools for America's small businesses").query, "developer tools for small businesses");
  assert.deepEqual(parse("companies in the U.S.A.").countries, ["USA"]);
  assert.deepEqual(parse("SaaS in the UK and Ireland").countries, ["GBR", "IRL"]);
  assert.equal(parse("European climate tech").countries?.length, 16);
  assert.equal(parse("teams of 10 to 50 people building agents").query, "teams building agents");
  assert.equal(parse("from 50 to 500 people, robotics").query, "robotics");
  assert.equal(parse("Series A or seed, 10 to 50 people, in North America").query, "companies");
});

test("round 3 review cases: a founding date before the raise date, from the US, spaced stage words", () => {
  const a = parse("fintech founded in the last 5 years that raised in the last 12 months");
  assert.equal(a.since, "2025-10-15");
  assert.equal(a.query, "fintech founded in the last 5 years");
  assert.equal(parse("fintech founded since 2020, raised since 2024").since, "2024-01-01");
  assert.equal(parse("fintech from the US").query, "fintech");
  assert.deepEqual([parse("Series A funded robotics").raised, parse("Series A funded robotics").query], [["series_a"], "robotics"]);
  assert.deepEqual([parse("Seed stage fintech").raised, parse("Seed stage fintech").query], [["seed"], "fintech"]);
});

test("optional settings: connections floor only when asked", () => {
  const conditions = (spec: ReturnType<typeof mergeSpec>) => (peopleFilters([1], spec, "titles") as any).conditions.map((c: any) => c.field);
  assert.equal(conditions(mergeSpec({ icp: "x", titles: ["CEO"] })).includes("professional_network.connections"), false);
  assert.equal(conditions(mergeSpec({ icp: "x", titles: ["CEO"], minConnections: 100 })).includes("professional_network.connections"), true);
  assert.deepEqual(parseFlags(["--min-connections", "none"]).flags, { minConnections: null });
});

test("places and shapes from the persona reviews: states, metros, PE, YC, size words, warnings", () => {
  const bay = parse("B2B SaaS companies in the Bay Area that use Salesforce, 50-300 employees");
  assert.deepEqual([bay.near, bay.size, bay.tech], [{ location: "San Francisco, CA", km: 80 }, [50, 300], ["Salesforce"]]);
  assert.equal(bay.query, "B2B SaaS companies");
  assert.match(sentenceWarnings("B2B SaaS companies in the Bay Area that use Salesforce", bay).join(" "), /Salesforce.*technographics/);
  assert.deepEqual(parse("ecommerce brands built on Shopify or BigCommerce").tech, ["Shopify", "BigCommerce"]);
  assert.match(sentenceWarnings("B2B software companies with an outbound sales team", parse("B2B software companies with an outbound sales team")).join(" "), /what the company does/);
  assert.match(sentenceWarnings("companies selling to HR teams, Seris A", parse("companies selling to HR teams, Seris A")).join(" "), /did you mean Series A/);
  assert.equal(sentenceWarnings("Series A fintech", parse("Series A fintech")).some(w => /did you mean/.test(w)), false);
  assert.equal(sentenceWarnings("fintech companies that serve a global market", parse("fintech companies that serve a global market")).some(w => /did you mean/.test(w)), false, "serve a is English, not a typo");
  const ai = parse("B2B SaaS companies using AI for sales, 50 to 500 people");
  assert.equal(ai.tech, undefined, "using AI describes the company, it is not a tool in use");
  assert.match(ai.query ?? "", /using AI/);
  assert.deepEqual(parse("B2B SaaS using HubSpot or Salesforce").tech, ["HubSpot", "Salesforce"]);
  const tx = parse("PE-backed home services roll-ups in Texas");
  assert.deepEqual([tx.states, tx.countries, tx.raised, tx.query], [["Texas"], ["USA"], ["private_equity"], "home services roll-ups"]);
  assert.deepEqual(parse("YC companies building dev tools").investors, ["Y Combinator"]);
  assert.deepEqual(parse("mid-market logistics companies").size, [100, 1000]);
  assert.equal(parse("payroll software that sells to mid-market companies").size, undefined);
  assert.equal(parse("developer tools for America's small businesses").size, undefined);
  assert.deepEqual(parse("ecommerce brands in Australia and New Zealand").countries, ["AUS", "NZL"]);
  assert.deepEqual(parse("fintechs in Mexico and Brazil").countries, ["BRA", "MEX"]);
  const vague = parse("startups that would buy sales software");
  assert.match(sentenceWarnings("startups that would buy sales software", vague).join(" "), /No size/);
  assert.match(sentenceWarnings("companies hiring SDRs", parse("companies hiring SDRs")).join(" "), /job watch/);
  assert.match(sentenceWarnings("Shopify DTC brands doing 1-10M in revenue", parse("Shopify DTC brands doing 1-10M in revenue")).join(" "), /Revenue/);
  assert.equal(parse("B2B SaaS that raised a Series B in the last 12 months, selling to HR").query, "B2B SaaS, selling to HR");
});
