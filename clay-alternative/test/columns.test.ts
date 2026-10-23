import { test } from "node:test";
import assert from "node:assert/strict";
import { COLUMNS, DEFAULT_COLUMNS, fieldsFor, resolveColumns, roundName } from "../lib/columns";
import { responses } from "./helpers";

const acme = responses.enrich[0].matches[0].company_data;
const acmeIdentify = responses.identify[0].matches[0].company_data;
const jane = responses.person[0].matches[0].person_data;

test("every column has a unique id, a group, a path and a source", () => {
  const ids = new Set(COLUMNS.map(c => c.id));
  assert.equal(ids.size, COLUMNS.length);
  for (const c of COLUMNS) {
    assert.ok(c.id.startsWith(c.group === "Person" ? "person." : "company."), c.id);
    assert.ok(c.path.length > 3, c.id);
    assert.ok(c.note.length > 1, c.id);
  }
  for (const id of DEFAULT_COLUMNS) assert.ok(ids.has(id), id);
});

test("every person column reads a value from the fixture person", () => {
  for (const c of COLUMNS.filter(c => c.group === "Person")) {
    const v = c.pick(jane, {});
    assert.notEqual(v, null, `${c.id} picked nothing`);
  }
  assert.equal(COLUMNS.find(c => c.id === "person.email")!.pick(jane, {}), "jane@acme.example");
  assert.equal(COLUMNS.find(c => c.id === "person.company_domain")!.pick(jane, {}), "acme.example");
  assert.equal(COLUMNS.find(c => c.id === "person.past_employers")!.pick(jane, {}), "Northwind Robotics; Example Labs");
  assert.equal(COLUMNS.find(c => c.id === "person.education")!.pick(jane, {}), "Example University: MS, Computer Science");
});

test("every free company column reads from the identify record, every paid one from the enrich record", () => {
  for (const c of COLUMNS.filter(c => c.source.kind === "identify")) assert.notEqual(c.pick(acmeIdentify, {}), null, c.id);
  for (const c of COLUMNS.filter(c => c.source.kind !== "identify" && c.group === "Company")) assert.notEqual(c.pick(acme, { domain: "acme.example" }), null, c.id);
  assert.equal(COLUMNS.find(c => c.id === "company.last_round_type")!.pick(acme, {}), "Series B");
  assert.equal(COLUMNS.find(c => c.id === "company.hiring_growth_12m")!.pick(acme, {}), 40);
  assert.equal(COLUMNS.find(c => c.id === "company.web_traffic")!.pick(acme, { domain: "acme.example" }), 240000);
  assert.match(String(COLUMNS.find(c => c.id === "company.headcount_by_department")!.pick(acme, {})), /^Sales \d+; Operations \d+; /);
});

test("missing values come back null, never a guess", () => {
  for (const c of COLUMNS) assert.equal(c.pick({}, {}), null, c.id);
  assert.equal(roundName(null), null);
  assert.equal(roundName("seed"), "Seed");
});

test("unknown column names fail with the closest names", () => {
  const r = resolveColumns(["headcnt", "person.title", "company.fundng_total"]);
  assert.equal(r.columns.length, 1);
  assert.equal(r.unknown[0].closest[0], "company.headcount");
  assert.equal(r.unknown[1].closest[0], "company.funding_total");
  assert.equal(resolveColumns(["Title"]).columns[0].id, "person.title");
});

test("the field groups follow the columns", () => {
  const f = fieldsFor(resolveColumns(["person.skills", "company.name", "company.tech_stack", "person.email"]).columns);
  assert.deepEqual(f.person, ["basic_profile", "contact.business_emails", "experience", "skills"]);
  assert.deepEqual(f.company, ["technographics"]);
  assert.equal(f.identify, true);
  assert.equal(f.email, true);
  assert.equal(f.tech, true);
  const free = fieldsFor(resolveColumns(["company.name", "company.headcount"]).columns);
  assert.equal(free.companyEnrich, false);
  assert.equal(free.personEnrich, false);
});
