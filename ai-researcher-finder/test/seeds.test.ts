import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, parseSeeds, samePaper } from "../src/seeds.js";

test("Google Scholar URLs keep only the profile id, whatever else the link carries", () => {
  const s = classify("https://scholar.google.co.uk/citations?hl=en&user=EXJANE00AAAJ&view_op=list_works");
  assert.deepEqual(s && "kind" in s && [s.kind, s.value], ["scholar", "https://scholar.google.com/citations?user=EXJANE00AAAJ"]);
  const bad = classify("https://scholar.google.com/scholar?q=attention");
  assert.ok(bad && "problem" in bad);
});

test("GitHub profile URLs become the account; repository links and reserved pages are refused (each lookup is billed)", () => {
  const s = classify("github.com/Example-Dev");
  assert.deepEqual(s && "kind" in s && [s.kind, s.value], ["github", "https://github.com/example-dev"]);
  assert.match((classify("https://github.com/example-org/some-repo") as { problem: string }).problem, /repository link/);
  assert.ok("problem" in (classify("https://github.com/orgs/example") as object));
});

test("paper titles are plain text; paper links ask for the title; short words are refused", () => {
  const s = classify("Attention Is All You Need");
  assert.deepEqual(s && "kind" in s && s.kind, "paper");
  assert.match((classify("https://arxiv.org/abs/1706.03762") as { problem: string }).problem, /title/);
  assert.ok("problem" in (classify("LLMs") as object));
});

test("a CSV with a header, several columns, duplicates and a BOM", () => {
  const text = "﻿name,scholar,github\nJane,https://scholar.google.com/citations?user=EXJANE00AAAJ,https://github.com/jane-example\nJane again,https://scholar.google.com/citations?user=EXJANE00AAAJ&hl=en,\n,,https://example.com/x\n";
  const { seeds, problems } = parseSeeds(text);
  // The name column is not read as paper titles (each title search is billed); the Scholar URL is kept once.
  assert.deepEqual(seeds.map(s => s.kind), ["scholar", "github"]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 4);
});

test("a header row with a title column reads titles there only", () => {
  const { seeds } = parseSeeds("name,paper title\nJane Example Doe,Speculative decoding for example models\n");
  assert.deepEqual(seeds.map(s => [s.kind, s.value]), [["paper", "Speculative decoding for example models"]]);
});

test("one title per line in a text file", () => {
  const { seeds } = parseSeeds("Speculative decoding for example models\nScaling laws for example pretraining runs\n");
  assert.deepEqual(seeds.map(s => s.value), ["Speculative decoding for example models", "Scaling laws for example pretraining runs"]);
});

test("the same paper with a year or a tag; a different paper with the same words is not", () => {
  assert.ok(samePaper("Attention is all you need", "Attention Is All You Need (2017)"));
  assert.ok(samePaper("Attention is all you need", "Attention is all you need [J]"));
  assert.ok(!samePaper("Attention is all you need", "Channel attention is all you need for video frame interpolation"));
  assert.ok(!samePaper("Speculative decoding for example models", "Speculative decoding for example models of speech recognition at scale"));
});

test("a recruiting export's job Title column is not read as paper titles; a one-column file is", () => {
  const exp = parseSeeds("Name,Title,Company,Scholar\nJane Doe,Senior Research Scientist,Example Labs,https://scholar.google.com/citations?user=EXJANE00AAAJ\n");
  assert.deepEqual(exp.seeds.map(s => s.kind), ["scholar"]);
  assert.equal(exp.ignored, 3);
  assert.equal(parseSeeds("Maria de la Cruz,Example Labs\n").seeds.length, 0);
  assert.equal(parseSeeds("Speculative decoding for example models\n").seeds.length, 1);
});

test("a malformed profile URL is a skipped seed, not a crash; Scholar ids keep their case", () => {
  assert.ok("problem" in (classify("https://www.linkedin.com/in/foo%E0%A4%A") as object));
  const { seeds } = parseSeeds("https://scholar.google.com/citations?user=AbCdEf12AAAJ\nhttps://scholar.google.com/citations?user=abcdef12AAAJ\n");
  assert.equal(seeds.length, 2);
});

test("blank lines do not shift the line numbers of skipped seeds", () => {
  const { problems } = parseSeeds("https://scholar.google.com/citations?user=EXJANE00AAAJ\n\n\nhttps://github.com/orgs/example\n");
  assert.equal(problems[0].line, 4);
});

test("a paper with extra words is a different paper", () => {
  assert.ok(!samePaper("Attention is all you need", "Attention is all you need for speech"));
  assert.ok(samePaper("Attention is all you need", "Attention is all you need. arXiv preprint 2017"));
});

test("a text file is read one line at a time: titles with commas and any first line are kept", () => {
  const { seeds } = parseSeeds("Link prediction based on graph neural networks\nLearning to summarize, from human feedback\nhttps://github.com/example-dev\n", { lines: true });
  assert.deepEqual(seeds.map(s => s.kind), ["paper", "paper", "github"]);
  assert.equal(seeds[1].value, "Learning to summarize, from human feedback");
});

test("a Google Scholar export reads Title as papers and never searches the venue", () => {
  const { seeds, ignored } = parseSeeds("Authors,Title,Publication,Year\n\"J Doe, S Example\",Speculative decoding for example models,Advances in neural information processing systems,2025\n");
  assert.deepEqual(seeds.map(s => s.value), ["Speculative decoding for example models"]);
  assert.ok(ignored >= 1);
});

test("a first row is a header only when every cell is a column name", () => {
  const { seeds } = parseSeeds("Speculative decoding for example models\nScaling laws for example pretraining runs\n");
  assert.equal(seeds.length, 2);
});

test("line numbers count file lines, even after a quoted cell over two lines", () => {
  const { problems } = parseSeeds("name,scholar\n\"Jane\nDoe\",https://scholar.google.com/citations?user=EXJANE00AAAJ\nX,https://github.com/orgs/example\n");
  assert.equal(problems[0].line, 4);
});

test("a CSV with a paper column next to other columns reads the papers; links inside text lines are found", () => {
  assert.deepEqual(parseSeeds("Name,Paper,Affiliation\nJane,Speculative decoding for example models,Example U\n").seeds.map(s => s.kind), ["paper"]);
  assert.deepEqual(parseSeeds("Jane Doe - https://scholar.google.com/citations?user=EXJANE00AAAJ\n", { lines: true }).seeds.map(s => s.kind), ["scholar"]);
  assert.equal(parseSeeds("Scaling 5\" models for real\nNext title here please\n").seeds.length, 2);
});
