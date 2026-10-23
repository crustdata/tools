import { test } from "node:test";
import assert from "node:assert/strict";
import { findPeople, titleMatches } from "../lib/find-people";
import { fakeClient, responses } from "./helpers";

test("titles match as whole words with VP variants", () => {
  assert.equal(titleMatches("Vice President, Sales", ["VP Sales"]), "VP Sales");
  assert.equal(titleMatches("VP - Sales EMEA", ["VP Sales"]), "VP Sales");
  assert.equal(titleMatches("Head of Marketing", ["VP Sales", "Head of Marketing"]), "Head of Marketing");
  assert.equal(titleMatches("Sales Development Rep", ["VP Sales"]), null);
});

test("find-people resolves the company, searches by title and drops side roles", async () => {
  const profiles = [responses.person[1].matches[0].person_data, responses.person[0].matches[0].person_data, responses.person[3].matches[0].person_data];
  const { client, log } = fakeClient({ responses: { ...responses, search: { profiles } } });
  const r = await findPeople(client, "acme.example", ["VP Sales", "CEO"], 5);
  assert.equal(r.company?.name, "Acme Analytics");
  assert.deepEqual(r.people.map(p => p.name), ["Sam Example", "Jane Doe"]);
  const search = log.find(l => l.path === "/person/search")!;
  assert.equal(search.body.filters.conditions[0].value[0], 100001);
  assert.equal(search.body.filters.conditions[1].conditions.length, 2);
  const none = await findPeople(client, "nothing.example", [], 5);
  assert.equal(none.company, null);
});
