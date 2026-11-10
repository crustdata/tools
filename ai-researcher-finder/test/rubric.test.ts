import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Person } from "../src/crustdata.js";
import { parseRubric, scorePerson, type Found } from "../src/rubric.js";
import type { TeamGuess } from "../src/teams.js";

const NOW = new Date("2026-10-28");
const ctx = { topics: ["speculative decoding"], labIds: new Set([9001]), labNames: ["Example Labs"], now: NOW };
const rubric = parseRubric(readFileSync(new URL("../rubric.json", import.meta.url), "utf8"));

const jane: Person = {
  crustdata_person_id: 1,
  fit: "strong",
  basic_profile: { name: "Jane Doe", current_title: "Member of Technical Staff" },
  experience: { employment_details: { current: [{ title: "Member of Technical Staff", name: "Example Labs", crustdata_company_id: 9001, start_date: "2024-03-01" }], past: [{ title: "Research Engineer", name: "DeepMind", start_date: "2017-01-01", end_date: "2024-02-01" }] } },
  research_profiles: [{ articles: [{ title: "Speculative decoding for example models", publication_year: "2025" }, { title: "Paged attention at example scale", publication_year: "2024" }], h_index: { all: 14 }, citations_count: { all: 2310 } }],
};
const stated: TeamGuess = { team: "Inference", label: "stated", evidence: ["role description: \"Inference\""], also: [] };

test("the shipped rubric.json is valid", () => {
  assert.ok(rubric.rules.length >= 5);
  assert.ok(rubric.ask.length >= 1);
});

test("every point comes with its evidence", () => {
  const s = scorePerson(rubric, { person: jane, via: ["search"] }, stated, ctx);
  const by = (label: RegExp) => s.outcomes.find(o => label.test(o.rule))!;
  assert.match(by(/frontier lab/).evidence!, /DeepMind \(2017 to 2024\)/); // an older name of a frontier lab counts
  assert.match(by(/topic/).evidence!, /Speculative decoding for example models/);
  assert.equal(by(/h-index/).evidence, "h-index 14");
  assert.equal(by(/model research team/).earned, 15);
  assert.ok(s.score > 80 && s.score <= 100);
});

test("an inferred team earns half; a missing research profile is no data, not a no", () => {
  const thin: Person = { ...jane, research_profiles: null };
  const s = scorePerson(rubric, { person: thin, via: ["search"] }, { team: "Inference", label: "inferred", evidence: ["paper"], also: [] }, ctx);
  assert.equal(s.outcomes.find(o => /model research team/.test(o.rule))!.earned, 7.5);
  const h = s.outcomes.find(o => /h-index/.test(o.rule))!;
  assert.equal(h.earned, 0);
  assert.equal(h.noData, true);
});

test("people found only from their work are not marked down for having no search tier", () => {
  const s = scorePerson(rubric, { person: { ...jane, fit: null }, via: ["Google Scholar profile x"] }, stated, ctx);
  assert.ok(!s.outcomes.some(o => /match to the search/.test(o.rule)));
  assert.ok(s.outcomes.find(o => /from their work/.test(o.rule))!.earned > 0);
});

test("the topic rule is left out when the run has no --topic", () => {
  const s = scorePerson(rubric, { person: jane, via: ["search"] }, stated, { ...ctx, topics: [] });
  assert.ok(!s.outcomes.some(o => /topic/.test(o.rule)));
});

test("rubric mistakes are named with their rule number before anything is billed", () => {
  assert.throws(() => parseRubric('{"rules":[{"points":10,"if":"h-index","value":10}]}'), /rule 1: "if" must be one of/);
  assert.throws(() => parseRubric('{"rules":[{"points":10,"if":"h_index","value":"ten"}]}'), /must be a number/);
  assert.throws(() => parseRubric('{"rules": [ {"points": 5, "if": "title"} ]'), /not valid JSON/);
  assert.throws(() => parseRubric('{"rules":[{"points":5,"if":"title","value":["x"]}],"ask":[{"question":""}]}'), /ask 1/);
});

test("rules with no data count at a quarter: a thin profile is not marked to zero, nor lifted above a full one", () => {
  const thin: Person = { ...jane, research_profiles: null };
  const full = scorePerson(rubric, { person: jane, via: ["search"] }, stated, ctx);
  const s = scorePerson(rubric, { person: thin, via: ["search"] }, stated, ctx);
  assert.ok(s.checked < full.checked);
  assert.ok(s.coverage < 100);
  assert.ok(s.score < full.score && s.score >= 50, `${s.score} vs ${full.score}`);
  // A record with almost nothing in it ranks below a strong full one.
  const empty: Person = { crustdata_person_id: 9, basic_profile: { name: "Empty" }, experience: { employment_details: { current: [{ name: "Example Labs", crustdata_company_id: 9001 }], past: [] } } };
  assert.ok(scorePerson(rubric, { person: empty, via: ["GitHub profile x"] }, undefined, ctx).score < full.score);
});

test("frontier labs match by company id and full name: OpenAI, Inc. counts, SSI Schaefer does not", () => {
  const at = (name: string, id?: number): Person => ({ ...jane, experience: { employment_details: { current: [{ title: "Engineer", name, crustdata_company_id: id }], past: [] } } });
  const rule = parseRubric('{"rules":[{"points":10,"if":"worked_at","value":["frontier"]}]}').rules;
  const score = (p: Person) => scorePerson({ rules: rule, ask: [] }, { person: p, via: ["search"] }, stated, ctx).earned;
  assert.equal(score(at("OpenAI, Inc.")), 10);
  assert.equal(score(at("Reflection", 949125)), 10);
  assert.equal(score(at("SSI Schaefer")), 0);
  assert.equal(score(at("Reflection")), 0);
});

test("rubric mistakes get a hint: line numbers, did you mean, unknown keys, unknown teams, text labels", () => {
  assert.throws(() => parseRubric('{\n "rules": [\n  {"points": 5, "if": "title", "value": ["x"]},\n ]\n}'), /not valid JSON near line \d.*comma after the last item/s);
  assert.throws(() => parseRubric('{"rules":[{"points":5,"if":"hindex","value":5}]}'), /did you mean "h_index"/);
  assert.throws(() => parseRubric('{"rules":[{"points":5,"if":"title","values":["x"]}]}'), /unknown key "values" \(did you mean "value"\?\)/);
  assert.throws(() => parseRubric('{"rules":[{"points":5,"if":"team","value":["Infernce"]}]}', "r.json", ["Inference"]), /did you mean "Inference"/);
  assert.throws(() => parseRubric('{"rules":[{"points":5,"if":"title","value":["x"],"label":5}]}'), /"label" must be text/);
});

test("frontier only matches the word frontier; interests match one way; stacked company suffixes are stripped", () => {
  const at = (name: string, id?: number): Person => ({ ...jane, experience: { employment_details: { current: [{ title: "Engineer", name, crustdata_company_id: id }], past: [] } } });
  const rule = (value: string[]) => ({ rules: parseRubric(JSON.stringify({ rules: [{ points: 10, if: "worked_at", value }] })).rules, ask: [] });
  assert.equal(scorePerson(rule(["Frontier Communications"]), { person: at("OpenAI", 631466), via: ["search"] }, stated, ctx).earned, 0);
  assert.equal(scorePerson(rule(["frontier"]), { person: at("DeepMind Technologies Limited"), via: ["search"] }, stated, ctx).earned, 10);
  const interests = { rules: parseRubric('{"rules":[{"points":5,"if":"interests","value":["reinforcement learning from human feedback"]}]}').rules, ask: [] };
  const p: Person = { ...jane, research_profiles: [{ research_interests: ["Learning"] }] };
  assert.equal(scorePerson(interests, { person: p, via: ["search"] }, stated, ctx).earned, 0);
});

test("no_data_share in rubric.json sets how much an unknown rule counts", () => {
  const r = parseRubric('{"no_data_share":0,"rules":[{"points":10,"if":"h_index","value":5},{"points":10,"if":"title","value":["member of technical staff"]}]}');
  const thin: Person = { ...jane, research_profiles: null };
  assert.equal(scorePerson(r, { person: thin, via: ["search"] }, stated, ctx).score, 50);
  assert.throws(() => parseRubric('{"no_data_share":2,"rules":[{"points":1,"if":"years","value":1}]}'), /no_data_share/);
});
