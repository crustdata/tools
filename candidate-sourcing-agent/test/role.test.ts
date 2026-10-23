import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIST_PRICE, bandsFor, buildConditions, estimateCost, mergeSpec, parseFlags, parseSentence, pricesFrom, roleName, slugify, stripProtected, titleFilter } from "../src/role.js";

test("the README example sentence", () => {
  const { spec, skillCandidates, sources } = parseSentence("Machine learning engineer, 4+ years, PyTorch, shipped models in production, United States, at a company under 500 people");
  assert.equal(spec.title, "Machine learning engineer");
  assert.deepEqual(spec.years, [4, null]);
  assert.deepEqual(spec.countries, ["United States"]);
  assert.deepEqual(spec.sizes, ["2-10", "11-50", "51-200", "201-500"]);
  assert.ok(skillCandidates.includes("PyTorch"));
  assert.equal(sources["shipped models in production"], "shipped models in production");
});

test("a messy recruiter sentence keeps its skills, years and places", () => {
  const { spec, skillCandidates } = parseSentence("looking for a senior ML engineer with 5-8 yrs experience in PyTorch, TensorFlow and MLOps, Bay Area or NYC");
  assert.equal(spec.title, "senior ML engineer");
  assert.deepEqual(spec.years, [5, 8]);
  assert.deepEqual(spec.near?.map(n => n.location), ["San Francisco", "New York"]);
  for (const s of ["PyTorch", "TensorFlow", "MLOps"]) assert.ok(skillCandidates.includes(s), s);
});

test("skills after with, a year range and a city", () => {
  const { spec, skillCandidates } = parseSentence("Data engineer with Spark and Airflow in Berlin, 3 to 7 years");
  assert.equal(spec.title, "Data engineer");
  assert.deepEqual(spec.years, [3, 7]);
  assert.deepEqual(spec.near, [{ location: "Berlin", km: 50 }]);
  assert.deepEqual(skillCandidates.slice(0, 2), ["Spark", "Airflow"]);
  assert.deepEqual(parseSentence("Analyst, 1.5 years").spec.years, [1, null]);
  assert.deepEqual(parseSentence("Analyst, 2.5+ years").spec.years, [2, null]);
});

test("age, gender and origin words are taken out of the query and never become filters", () => {
  const p = parseSentence("Backend engineer, native English speaker, under 30 years old, young and hungry, London");
  assert.equal(p.spec.years, undefined, "a number of years old is not years of experience");
  assert.equal(p.spec.query, "Backend engineer, and hungry, London");
  assert.ok(p.notes.some(n => n.includes("never searches, filters or scores on age")));
  assert.deepEqual(stripProtected("Cloud native engineer, React Native").found, []);
  for (const work of ["SRE, single sign-on, race conditions, mature codebase, man-hours", "women's health products sales lead", "Young & Rubicam alum, Christian Dior", "Black Duck security engineer", "Latin America sales"]) {
    assert.deepEqual(stripProtected(work).found, [], work);
  }
  const caught = stripProtected("Engineer, under 35, in their 20s, born after 1990, English native, gay, Asian engineers").found.map(f => f.phrase);
  for (const p of ["under 35", "in their 20s", "born after 1990", "English native", "gay", "Asian"]) assert.ok(caught.includes(p), p);
  assert.deepEqual(stripProtected("under 500 people, over 10 engineers").found, []);
  const flags = parseFlags(["--keywords", "female +engineer", "--title", "Female engineer"]);
  assert.equal(flags.flags.keywords, "+engineer");
  assert.equal(flags.flags.title, "engineer");
  assert.equal(flags.options.notes.length, 2);
  assert.equal(stripProtected("Female software engineer").text, "software engineer");
  // The upper end of a years range only scores: a maximum on experience works as an age filter.
  const c = buildConditions(mergeSpec({ role: "x", name: "x", years: [3, 7] }));
  assert.deepEqual(c.find(x => x.label.includes("years"))?.filter, { field: "years_of_experience_raw", type: "=>", value: 3 });
  assert.ok(!c.some(x => JSON.stringify(x.filter).includes('"years_of_experience_raw","type":"=<"')));
});

test("company size words only count when the person is at that company; team sizes never do", () => {
  assert.equal(parseSentence("Enterprise account executive, 5+ years, New York").spec.sizes, undefined);
  assert.deepEqual(parseSentence("Enterprise account executive at a scale-up").spec.sizes, ["201-500", "501-1000"]);
  const startup = parseSentence("Backend engineer with startup experience");
  assert.equal(startup.spec.sizes, undefined);
  assert.ok(startup.notes.some(n => n.includes("--size startup")));
  assert.deepEqual(parseSentence("Designer at an early-stage startup").spec.sizes, ["2-10", "11-50", "51-200"]);
  assert.equal(parseSentence("Engineering manager, managing 20+ people").spec.sizes, undefined);
  assert.deepEqual(parseSentence("Engineer at a company of 50 to 200 people").spec.sizes, ["51-200"]);
  assert.deepEqual(parseSentence("Engineer at a company of 1000+ employees").spec.sizes, ["1001-5000", "5001-10000", "10001+"], "1000+ does not pull in 501-1000");
  assert.deepEqual(parseSentence("Engineer at a startup or scale-up").spec.sizes, ["2-10", "11-50", "51-200", "201-500", "501-1000"]);
});

test("places: lowercase, US needs capitals, longest state first, ambiguous names are noted", () => {
  assert.equal(parseSentence("Engineer who wants to join us").spec.countries, undefined);
  assert.deepEqual(parseSentence("machine lerning engineer, pytorch, 4+ yrs, united states").spec.countries, ["United States"]);
  assert.deepEqual(parseSentence("Product designer in California, US").spec.states, ["California"]);
  assert.deepEqual(parseSentence("Product designer in Washington state").spec.states, ["Washington"]);
  assert.deepEqual(parseSentence("Nurse in West Virginia").spec.states, ["West Virginia"]);
  assert.deepEqual(parseSentence("Policy analyst in Washington, DC").spec.near?.[0]?.location, "Washington, DC");
  const georgia = parseSentence("Nurse practitioner, 5+ years, Georgia");
  assert.equal(georgia.spec.states, undefined);
  assert.ok(georgia.notes.some(n => n.includes("--state Georgia")));
  assert.ok(!georgia.skillCandidates.includes("Georgia"));
  assert.deepEqual(parseSentence("Nurse in the UK").spec.countries, ["United Kingdom"]);
  assert.ok(parseSentence("Go engineer, remote").notes.some(n => n.startsWith('"remote"')));
});

test("place words inside company and school names are names, not where the person lives", () => {
  const bank = parseSentence("Engineer previously at Bank of America");
  assert.deepEqual(bank.spec.past, ["Bank of America"]);
  assert.equal(bank.spec.countries, undefined);
  assert.equal(parseSentence("Engineer, ex-Texas Instruments").spec.states, undefined);
  assert.deepEqual(parseSentence("Engineer, studied at University of Texas").spec.schools, ["University of Texas"]);
  assert.equal(parseSentence("Engineer, studied at University of Texas").spec.states, undefined);
});

test("several kinds of place are all kept; a state or country that names a city's own region is not", () => {
  const p = parseSentence("Engineer in London or Germany").spec;
  assert.deepEqual([p.near?.map(n => n.location), p.countries], [["London"], ["Germany"]]);
  const c = buildConditions(mergeSpec({ role: "x", name: "x", ...p }));
  assert.match(JSON.stringify(c.find(x => x.label.startsWith("lives"))?.filter), /"op":"or".*geo_distance.*"Germany"/);
  assert.equal(parseSentence("Engineer in Austin, Texas").spec.states, undefined);
  assert.equal(parseSentence("Designer in Berlin, Germany").spec.countries, undefined);
  assert.deepEqual(parseSentence("Nurse, New Jersey or New York").spec.states, ["New Jersey"]);
});

test("titles stop before a describing word; CI/CD stays one skill", () => {
  assert.equal(parseSentence("Engineer experienced with Kafka").spec.title, "Engineer");
  assert.deepEqual(parseSentence("DevOps engineer with CI/CD and Terraform").skillCandidates, ["CI/CD", "Terraform"]);
});

test("past employers and schools stay inside their own phrase", () => {
  assert.deepEqual(parseSentence("ML engineer, ex-Example Labs or Example AI, studied at Example State University").spec.past, ["Example Labs", "Example AI"]);
  assert.deepEqual(parseSentence("Senior ML Engineer, ex-Example Labs or ex-Example AI, 5+ years").spec.past, ["Example Labs", "Example AI"]);
  assert.deepEqual(parseSentence("Engineer previously at Example Labs, Germany").spec.past, ["Example Labs"]);
  assert.deepEqual(parseSentence("Engineer previously at Example Labs, Germany").spec.countries, ["Germany"]);
  assert.deepEqual(parseSentence("Designer, studied at Example Art School, 10+ years").spec.schools, ["Example Art School"]);
  assert.deepEqual(parseSentence("Engineer, MIT grads").spec.schools, ["MIT"]);
  assert.deepEqual(parseSentence("Researcher who worked at Example Robotics, Seattle").spec.past, ["Example Robotics"]);
  assert.equal(parseSentence("Engineer from Berlin").spec.schools, undefined);
});

test("open to work words set --open-only", () => {
  assert.equal(parseSentence("Data scientist open to new roles").spec.openOnly, true);
});

test("flags: ranges, sizes, places, repeated lists, switches and none", () => {
  const dir = mkdtempSync(join(tmpdir(), "flags-"));
  const list = join(dir, "do-not-poach.txt");
  writeFileSync(list, "https://www.Acme.example/jobs\nother.example\n");
  const { flags, options } = parseFlags(["--years", "3-7", "--size", "startup", "--near", "Berlin:30", "--exclude", list, "--fresh", "--top", "5", "--must", "Go", "--must", "Rust"]);
  assert.deepEqual(flags.years, [3, 7]);
  assert.deepEqual(flags.sizes, ["2-10", "11-50", "51-200"]);
  assert.deepEqual(flags.near, [{ location: "Berlin", km: 30 }]);
  assert.deepEqual(flags.exclude, ["acme.example", "other.example"]);
  assert.deepEqual(flags.must, ["Go", "Rust"]);
  assert.equal(options.fresh, true);
  assert.equal(options.top, 5);
  assert.deepEqual(parseFlags(["--years", "5-8 yrs"]).flags.years, [5, 8]);
  assert.deepEqual(parseFlags(["--years", "4+"]).flags.years, [4, null]);
  assert.equal(parseFlags(["--years", "none"]).flags.years, null);
  assert.deepEqual(parseFlags(["--near", "Bay Area"]).flags.near, [{ location: "San Francisco", km: 80 }]);
  assert.deepEqual(parseFlags(["--country", "USA"]).flags.countries, ["United States"]);
  assert.deepEqual(parseFlags(["--size", "1-500"]).flags.sizes, ["2-10", "11-50", "51-200", "201-500"]);
  assert.throws(() => parseFlags(["--size", "500-100"]), /covers no company size/);
  assert.throws(() => parseFlags(["--exclude", "typo.txt"]), /no file called typo.txt/);
  assert.throws(() => parseFlags(["--limit", "0x10"]), /--limit takes/);
  assert.throws(() => parseFlags(["--fresh=no"]), /is a switch/);
  assert.throws(() => parseFlags(["--seen", "--fresh"]), /--seen needs a value/);
  assert.throws(() => parseFlags(["--nope", "x"]), /Unknown flag --nope/);
  assert.equal(parseFlags(["--help"]).options.help, true);
  assert.equal(parseFlags(["--dry-run"]).options.dryRun, true);
  assert.equal(parseFlags(["--open-only"]).flags.openOnly, true);
  assert.equal(parseFlags(["--no-open-only"]).flags.openOnly, false);
});

test("headcount bands come from the closed set", () => {
  assert.deepEqual(bandsFor(1, 499), ["2-10", "11-50", "51-200", "201-500"]);
  assert.deepEqual(bandsFor(1001, Infinity), ["1001-5000", "5001-10000", "10001+"]);
});

test("a must-have is a filter, so it is not scored twice", () => {
  const spec = mergeSpec({ skills: ["PyTorch", "Python"], nice: ["pytorch", "Kubernetes"] }, { must: ["PyTorch"] });
  assert.deepEqual(spec.skills, ["Python"]);
  assert.deepEqual(spec.nice, ["Kubernetes"]);
  assert.equal(spec.limit, 20);
});

test("filters: one = leaf per must-have skill (has_all is rejected on skills), least trusted profiles left out", () => {
  const spec = mergeSpec({ role: "x", name: "x", must: ["PyTorch", "Rust"], countries: ["United States"], years: [4, null], openOnly: true });
  const c = buildConditions(spec);
  assert.match(JSON.stringify(c[0].filter), /assessment\.authenticity\.tier/);
  const skills = c.filter(x => x.label.startsWith("lists the skill"));
  assert.deepEqual(skills.map(x => x.filter), [
    { field: "skills.professional_network_skills", type: "=", value: "PyTorch" },
    { field: "skills.professional_network_skills", type: "=", value: "Rust" },
  ]);
  assert.equal(skills[0].clear, '--must "Rust"');
  assert.ok(!JSON.stringify(c).includes("has_all"));
  assert.ok(c.some(x => x.label === "says they are open to new roles"));
});

test("the title filter matches every level and the abbreviation", () => {
  const f = JSON.stringify(titleFilter("Senior ML engineer"));
  assert.match(f, /"value":"ml engineer"/);
  assert.match(f, /"value":"machine learning engineer"/);
  assert.ok(!f.includes("senior"));
});

test("cost: list price per group, each round billed only for its own filters, or the account's own prices", () => {
  const spec = mergeSpec({ role: "x", name: "x", must: ["PyTorch"], years: [4, null], countries: ["United States"], sizes: ["51-200"], limit: 20 });
  const est = estimateCost(spec, buildConditions(spec), [1, 2], LIST_PRICE);
  // 20 x (0.03 + 0.1 experience + 0.1 skills filters + 0.3 returned) + round 1 (0.03) + round 2 (0.13) + 2 open (0.23 each)
  assert.ok(Math.abs(est.credits - (20 * 0.53 + 0.03 + 0.13 + 2 * 0.23)) < 1e-9);
  assert.match(est.text, /about 11 credits at list price \(0\.53 per candidate, 20 candidates\)/);
  const free = pricesFrom([{ path: "/person/search", base_credits: 0.03, premium_filters: [{ field: "experience", credits: 0 }, { field: "skills", credits: 0 }], premium_fields: [{ field: "experience", credits: 0 }] }]);
  const mine = estimateCost(spec, buildConditions(spec), [1, 2], free);
  assert.match(mine.text, /about 0\.7 credits on your account.*about 11 at list price/);
  // An account with no extras lists base_credits alone; missing keys mean nothing extra, not list price.
  assert.match(estimateCost(spec, buildConditions(spec), [1, 2], pricesFrom([{ path: "/person/search", base_credits: 0.03 }])).text, /about 0\.7 credits on your account/);
  // The longest matching field wins: the open-to-work filter is priced on its own path.
  const open = pricesFrom([{ path: "/person/search", base_credits: 0.03, premium_filters: [{ field: "professional_network.connections", credits: 0 }, { field: "professional_network.open_to_cards", credits: 0.2 }] }]);
  assert.equal(open.filter.professional_network, 0.2);
});

test("role names: the same role in other words lands in the same folder", () => {
  const a = parseSentence("Machine learning engineer, United States").spec;
  const b = parseSentence("Senior ML engineer, US").spec;
  assert.equal(roleName(a, ""), "machine-learning-engineer-united-states");
  assert.equal(roleName(b, ""), roleName(a, ""));
  assert.equal(roleName(parseSentence("Data engineer, Bay Area or NYC").spec, ""), "data-engineer-several-places");
  assert.notEqual(roleName(parseSentence("Junior software engineer, Berlin").spec, ""), roleName(parseSentence("Staff software engineer, Berlin").spec, ""));
  assert.equal(slugify("Ingénieur données / Paris"), "ingenieur-donnees-paris");
});

test("round 3: protected words before a title, origin and age phrasings, names with &, and work phrases", () => {
  assert.equal(parseSentence("Female ML engineer, US").spec.title, "ML engineer");
  const born = parseSentence("Software engineer born in India, 3+ years, Python");
  assert.equal(born.spec.countries, undefined, "a birthplace is never a place filter");
  assert.equal(born.spec.title, "Software engineer");
  for (const p of ["of Indian origin", "40 or younger", "graduated 2020 or later", "mother tongue Spanish", "German nationals only", "under the age of 40", "people of color"]) {
    assert.ok(stripProtected(`Engineer, ${p}`).found.length, p);
  }
  for (const w of ["ex-Procter & Gamble", "Johnson & Johnson", "ex-Ernst & Young", "under 40 hours a week", "Hispanic marketing agency", "mentor her team", "disability insurance products"]) {
    assert.equal(stripProtected(w).text, w, w);
  }
  assert.deepEqual(parseSentence("Engineer, ex-Procter & Gamble").spec.past, ["Procter & Gamble"]);
});

test("protected: US citizens only and native speakers are taken out", () => {
  for (const s of ["Backend engineer, US citizens only, Berlin", "Support lead, English native speakers, Dublin"]) {
    const { spec } = parseSentence(s);
    assert.doesNotMatch(spec.query ?? "", /citizens|native/i, s);
  }
});

test("--title-strict accepts developer and engineer for the same software job", () => {
  const values = JSON.stringify(titleFilter("Senior backend engineer"));
  assert.match(values, /"backend engineer"/);
  assert.match(values, /"backend developer"/);
  assert.match(JSON.stringify(titleFilter("Frontend developer")), /"frontend engineer"/);
});

test("round 3: commas in numbers, a state with a country, --state narrows, city with a state code, punctuation", () => {
  assert.deepEqual(parseSentence("Engineer at a company under 1,000 employees").spec.sizes, ["2-10", "11-50", "51-200", "201-500", "501-1000"]);
  const both = parseSentence("Data engineer in California or Germany").spec;
  assert.deepEqual([both.states, both.countries], [["California"], ["Germany"]]);
  assert.equal(parseFlags(["--state", "California"]).flags.countries, null);
  assert.deepEqual(parseSentence("Backend engineer in Boise, ID").spec.near, [{ location: "Boise, ID", km: 50 }]);
  assert.deepEqual(parseSentence("Data engineer in Raleigh, NC, Spark").spec.near, [{ location: "Raleigh", km: 50 }]);
  assert.deepEqual(parseSentence("Data engineer in Raleigh, NC, Spark").skillCandidates, ["Spark"], "the state code is not a skill");
  assert.ok(parseSentence("Backend engineer based in Boise, 5+ years").notes.some(n => n.includes('--near "Boise:50"')));
  // A skill before a state code is not a city; a known city with another state's code is that other city.
  const py = parseSentence("Data engineer, Python, CA");
  assert.equal(py.spec.near, undefined);
  assert.deepEqual(py.skillCandidates, ["Python"]);
  assert.ok(py.notes.some(n => n.includes('"CA" after "Python" is not read as a place')));
  assert.deepEqual(parseSentence("Backend engineer in Portland, ME").spec.near, [{ location: "Portland, ME", km: 50 }]);
  assert.deepEqual(parseSentence("Backend engineer in Portland, OR").spec.near, [{ location: "Portland", km: 50 }]);
  // "or anywhere in the US" widens the place instead of being dropped as the city's country.
  const wide = parseSentence("Backend engineer, New York or anywhere in the US").spec;
  assert.deepEqual([wide.near?.map(n => n.location), wide.countries], [["New York"], ["United States"]]);
  assert.equal(parseSentence("Backend engineer, New York, United States").spec.countries, undefined);
  assert.ok(!parseSentence("Data engineer in Atlanta, Georgia").notes.some(n => n.includes("can be a US state")));
  // Filler words go only at the edges of a skill phrase.
  assert.ok(parseSentence("Backend engineer, Ruby on Rails, Berlin").skillCandidates.includes("Ruby on Rails"));
  assert.equal(parseSentence("Sr. - Staff platform engineer, Kubernetes, Seattle").spec.title, "Sr. - Staff platform engineer");
  assert.deepEqual(parseSentence("ML engineer | PyTorch | 4+ years | US").skillCandidates, ["PyTorch"]);
  assert.equal(parseSentence("Full-stack engineer (React, Node.js)").spec.title, "Full-stack engineer");
  assert.deepEqual(parseSentence("Engineer with at least five years").spec.years, [5, null]);
  assert.deepEqual(parseSentence("Engineer with Rust experience in Seattle").skillCandidates, ["Rust"]);
  assert.throws(() => parseFlags(["--exclude", "Acme Inc., initech.example"]), /"Acme Inc\." is not a website domain/);
});
