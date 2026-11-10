import assert from "node:assert/strict";
import { test } from "node:test";
import type { Person } from "../src/crustdata.js";
import { guessTeams, headlineNow, labWidePaper, loadTaxonomy, teamsIn } from "../src/teams.js";

const tax = loadTaxonomy();
const NOW = new Date("2026-10-28");
const LAB = 1;
const person = (id: number, o: { title?: string; desc?: string; headline?: string; papers?: Array<[string, number]>; interests?: string[]; sid?: string; coauthors?: Array<[string, string]>; name?: string; lab?: number; past?: string }): Person => ({
  crustdata_person_id: id,
  basic_profile: { name: o.name ?? `Person ${id}`, headline: o.headline ?? "", current_title: o.title ?? "Member of Technical Staff" },
  experience: { employment_details: { current: [{ title: o.title ?? "Member of Technical Staff", name: "Example Labs", crustdata_company_id: o.lab ?? LAB, description: o.desc ?? "" }], past: o.past ? [{ title: o.past, name: "Example Cloud" }] : [] } },
  research_profiles: o.papers || o.interests || o.coauthors || o.sid ? [{ id: o.sid, articles: (o.papers ?? []).map(([title, y]) => ({ title, publication_year: String(y) })), research_interests: o.interests ?? [], co_authors: (o.coauthors ?? []).map(([id, name]) => ({ id, name })) }] : null,
});

test("the team in a title or role description is stated, earliest mention first", () => {
  const t = guessTeams([person(1, { desc: "Pretraining and inference performance" })], new Set([LAB]), tax, NOW).get(1)!;
  assert.equal(t.team, "Pretraining");
  assert.equal(t.label, "stated");
  assert.deepEqual(t.also, ["Inference"]);
  assert.match(t.evidence[0], /role description/);
});

test("only the part of a headline about now counts", () => {
  assert.equal(headlineNow("Code RL @Lab, Past: Post-Training/RL of a model at X"), "Code RL @Lab");
  assert.equal(headlineNow("Ex-Google Brain | Post-training at Example Labs"), "Post-training at Example Labs");
  assert.equal(headlineNow("Former Googler. Now inference at Example Labs"), "Now inference at Example Labs");
  const t = guessTeams([person(1, { headline: "Building things, previously inference at Example Cloud" })], new Set([LAB]), tax, NOW).get(1)!;
  assert.equal(t.label, "not stated");
});

test("generic titles name no team; whole words only (rl is not in world)", () => {
  assert.deepEqual(teamsIn("Member of Technical Staff, Machine Learning", tax), []);
  assert.deepEqual(teamsIn("Hello world", tax), []);
  assert.equal(teamsIn("RL go brrrr", tax)[0].team, "Post-training and RL");
  assert.deepEqual(teamsIn("Code RL", tax).map(t => t.team), ["Code", "Post-training and RL"]);
});

test("recent paper titles infer a team; one old paper alone does not", () => {
  const people = [
    person(1, { papers: [["Efficient serving of example language models", 2025], ["Speculative decoding for example models", 2024]] }),
    person(2, { papers: [["Quantization of example transformers", 2015]] }),
  ];
  const teams = guessTeams(people, new Set([LAB]), tax, NOW);
  assert.equal(teams.get(1)!.team, "Inference");
  assert.equal(teams.get(1)!.label, "inferred");
  assert.match(teams.get(1)!.evidence[0], /paper \(2025\)/);
  assert.equal(teams.get(2)!.label, "not stated");
});

test("a co-author at the same lab with a stated team is evidence; at another lab it is not", () => {
  const jane = person(1, { name: "Jane Doe", desc: "Inference", sid: "EXJANE00AAAJ" });
  const sam = person(2, { name: "Sam Example", coauthors: [["EXJANE00AAAJ", "J. Doe"]] });
  const other = person(3, { name: "Ola Example", coauthors: [["EXJANE00AAAJ", "Jane Doe"]], lab: 2 });
  const teams = guessTeams([jane, sam, other], new Set([LAB, 2]), tax, NOW);
  assert.equal(teams.get(2)!.team, "Inference");
  assert.match(teams.get(2)!.evidence.join(" "), /co-author of Jane Doe \(Inference, stated\)/);
  assert.equal(teams.get(3)!.label, "not stated");
});

test("a model's launch paper or technical report is not evidence of a team", () => {
  const t = guessTeams([person(1, { papers: [["Gemini 1.5: Unlocking multimodal understanding at scale", 2025], ["Example multimodal models: a family of highly capable models", 2024], ["Example-4 technical report on multimodal inference", 2024]] })], new Set([LAB]), tax, NOW).get(1)!;
  assert.equal(t.label, "not stated");
});

test("research interests and a past role add up to an inferred team", () => {
  const t = guessTeams([person(1, { interests: ["Reinforcement Learning"], past: "RLHF engineer" })], new Set([LAB]), tax, NOW).get(1)!;
  assert.equal(t.team, "Post-training and RL");
  assert.equal(t.label, "inferred");
});

test("statistics and policy words do not map to model teams", () => {
  assert.deepEqual(teamsIn("Research Scientist, Causal Inference", tax), []);
  assert.deepEqual(teamsIn("Variational inference for Bayesian deep networks", tax), []);
  assert.deepEqual(teamsIn("Trust and Safety policy lead", tax), []);
  assert.deepEqual(teamsIn("Kernel methods for Gaussian processes", tax), []);
  assert.deepEqual(teamsIn("Agent-based modeling of markets", tax), []);
  assert.equal(teamsIn("Inference: speculative decoding", tax)[0].team, "Inference");
  assert.equal(teamsIn("Head of Pretraining Data", tax)[0].team, "Data");
  assert.equal(teamsIn("Member of Technical Staff, Claude Code", tax)[0].team, "Code");
});

test("a co-author who only shares a name is weaker than a Scholar id match", () => {
  const jane = person(1, { name: "Wei Zhang", desc: "Inference", sid: "EXWEI000AAAJ" });
  const byName = person(2, { coauthors: [["OTHER0000AAJ", "Wei Zhang"]] });
  const byId = person(3, { coauthors: [["EXWEI000AAAJ", "W. Zhang"]] });
  const teams = guessTeams([jane, byName, byId], new Set([LAB]), tax, NOW);
  assert.equal(teams.get(2)!.label, "not stated"); // both have ids and they differ: not the same person
  assert.equal(teams.get(3)!.team, "Inference");
});

test("whole-lab papers are recognised; ordinary titles with a colon are not", () => {
  for (const t of ["The Llama 3 Herd of Models", "DeepSeek-V3 technical report", "Mixtral of Experts", "Gemini 1.5: Unlocking things", "Qwen2.5: a report"]) assert.ok(labWidePaper(t), t);
  for (const t of ["T5: exploring transfer learning", "Wav2vec 2.0: a framework", "Inception-v4, Inception-ResNet", "Product of Experts for X", "Speculative decoding for example models"]) assert.ok(!labWidePaper(t), t);
});

test("prev. and ex. in a headline mark the past, and the evidence quotes the headline as written", () => {
  assert.equal(headlineNow("MTS at Lab (prev. pretraining at Example Cloud)"), "MTS at Lab");
  assert.equal(headlineNow("Building at Lab. Prev. inference at Example Co"), "Building at Lab");
  const t = guessTeams([person(1, { headline: "Pretraining at Example Labs (ex-Example Co)" })], new Set([LAB]), tax, NOW).get(1)!;
  assert.equal(t.team, "Pretraining");
  assert.match(t.evidence[0], /\(ex-Example Co\)/);
});

test("broad words do not make a team: code of conduct, payroll code, applied math, video games", () => {
  for (const x of ["Wrote code for the payroll system", "Code of conduct committee", "Applied math", "Video games", "Vision and strategy", "Safety-critical systems"]) assert.deepEqual(teamsIn(x, tax), [], x);
});

test("a current role after an Ex- piece is kept; previous and prior mark the past", () => {
  assert.equal(headlineNow("Ex-Example Co, Research Scientist working on inference at Example Labs"), "Research Scientist working on inference at Example Labs");
  assert.equal(headlineNow("Previous: Example Brain alignment | now inference at X"), "now inference at X");
  assert.equal(headlineNow("Formerly @ Example Mind (RL), Inference at Lab"), "Inference at Lab");
});
