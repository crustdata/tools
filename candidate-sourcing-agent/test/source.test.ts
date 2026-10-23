/** The whole run against the offline fixtures: no key, no network, no credits. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchBody } from "../examples/watch-role.js";
import { factsFor, whySentences } from "../src/ai.js";
import { NO_CONTACT_ACCESS, contactAccess, runContacts } from "../src/contacts.js";
import type { Person } from "../src/crustdata.js";
import { parseCsv } from "../src/csv.js";
import { fakeFetch, type Fixture } from "../src/fake-api.js";
import { runForget } from "../src/forget.js";
import { loadRole } from "../src/role.js";
import { scoreCandidate } from "../src/score.js";
import { loadSeen } from "../src/seen.js";
import { runRescore, runSource } from "../src/source.js";

const load = (name: string): Fixture => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const quiet = async (fn: () => Promise<void>) => {
  const log = console.log, err = console.error;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try { await fn(); } catch (e) { lines.push(`THROWN: ${(e as Error).message}`); } finally { console.log = log; console.error = err; }
  process.exitCode = 0;
  return lines.join("\n");
};
function setup(fixture: Fixture) {
  const out = mkdtempSync(join(tmpdir(), "candidates-test-"));
  process.env.OUT_DIR = out;
  process.env.CRUSTDATA_API_KEY = "test";
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[k];
  const fake = fakeFetch(fixture);
  globalThis.fetch = fake.fetch;
  return { out, calls: fake.calls };
}
const ROLE = "machine-learning-engineer-united-states";
const searches = (calls: Array<{ path: string; body: any }>) => calls.filter(c => c.path === "/person/search" && c.body?.search);

test("a first run writes the shortlist, the CSV and the seen list; the next run skips everyone and gets the next batch", async () => {
  const fx = load("ml-engineer.json");
  const { out, calls } = setup(fx);
  const log = await quiet(() => runSource([...fx.argv, "--yes"]));
  const dir = join(out, ROLE);
  for (const f of ["candidates.csv", "shortlist.md", "seen.csv", "role.json", "profiles.json"]) assert.ok(existsSync(join(dir, f)), f);

  const rows = parseCsv(readFileSync(join(dir, "candidates.csv"), "utf8"));
  assert.equal(rows[0][2], "name");
  assert.deepEqual(rows.slice(1).map(r => r[2]), ["Jane Doe", "Rahul Example", "Maria Example"], "Alex is dropped: a second current role at the excluded company");
  assert.equal(rows.find(r => r[2] === "Rahul Example")?.[4], "Example Health", "the advisor role is not the main job");
  assert.match(log, /Round 2: lists the skill PyTorch, 4\+ years of experience: 55,766 people/);
  assert.ok(readFileSync(join(dir, "shortlist.md"), "utf8").includes("Before: Example AI (Machine Learning Engineer, 2019 to 2023)"));

  const first = searches(calls)[0];
  assert.equal(first.body.mode, "exact");
  assert.equal(first.body.search.mode, "hybrid");
  assert.equal(first.body.post_processing, undefined);
  assert.ok(calls.every(c => !c.body || !JSON.stringify(c.body).includes("has_all")));
  assert.equal(loadSeen(join(dir, "seen.csv")).byUrl.size, 4, "everyone returned is seen, including the person dropped here");

  calls.length = 0;
  const again = await quiet(() => runSource(["--name", ROLE, "--yes"]));
  assert.equal(searches(calls)[0].body.post_processing.exclude_profiles.length, 4);
  assert.match(again, /4 new candidates \(7 in total for this role\)/);
  assert.equal(loadRole(ROLE)?.spec.must[0], "PyTorch");
});

test("filters that match nobody stop before the ranked search and name the filter to drop", async () => {
  const fx = load("empty.json");
  const { out, calls } = setup(fx);
  const log = await quiet(() => runSource([...fx.argv, "--yes"]));
  assert.match(log, /"lists the skill Rust" removes everyone/);
  assert.match(log, /--must "PyTorch"/);
  assert.ok(!existsSync(join(out, ROLE, "candidates.csv")));
  assert.equal(searches(calls).length, 1, "the ranked search ran once and found nobody; no second paid search");
});

test("a must-have that is not a stored skill stops the run before anything is billed", async () => {
  const fx = load("ml-engineer.json");
  const { calls } = setup(fx);
  const log = await quiet(() => runSource(["--role", "Machine learning engineer, United States", "--must", "Pytorchh", "--yes"]));
  assert.match(log, /--must "Pytorchh" is not a stored skill name/);
  assert.ok(!calls.some(c => c.path === "/person/search"));
});

test("--dry-run shows the plan and the cost and sends no search", async () => {
  const fx = load("ml-engineer.json");
  const { calls } = setup(fx);
  const log = await quiet(() => runSource([...fx.argv, "--dry-run"]));
  assert.match(log, /cost:\s+about/);
  assert.match(log, /Dry run: nothing was searched or charged/);
  assert.ok(!calls.some(c => c.path === "/person/search"));
});

test("a large run with no terminal and no --yes is not run", async () => {
  const fx = load("ml-engineer.json");
  const { calls } = setup(fx);
  const log = await quiet(() => runSource([...fx.argv, "--limit", "1000"]));
  assert.match(log, /Not run: this search is about \d+ credits\. Add --yes/);
  assert.ok(!calls.some(c => c.path === "/person/search"));
});

test("fewer people than asked for: the round that cut the most and the flag that widens it", async () => {
  const fx = load("account-executive.json");
  setup(fx);
  const log = await quiet(() => runSource([...fx.argv, "--yes"]));
  assert.match(log, /Only 3 new people match every filter, fewer than the 20 asked for/);
  assert.match(log, /--size none/);
});

test("a key that cannot read skills: the search runs again without them instead of finding nobody", async () => {
  const fx = load("ml-engineer.json");
  fx.endpoints = [{ path: "/person/search", status: "enabled", fields: { enabled: ["basic_profile"], disabled: ["skills"] } }];
  const { calls } = setup(fx);
  const log = await quiet(() => runSource([...fx.argv, "--yes"]));
  assert.match(log, /cannot read skills/);
  assert.match(log, /3 new candidates/);
  assert.ok(!searches(calls)[1].body.fields.includes("skills"));
});

test("a failure after the ranked search keeps everyone billed in seen.csv, so the next run does not bill them again", async () => {
  const fx = load("ml-engineer.json");
  fx.pageSize = 2;
  fx.faults = [{ path: "/person/search", search: true, call: 2, status: 500, message: "page 2 failed" }];
  const { out } = setup(fx);
  const log = await quiet(() => runSource([...fx.argv, "--yes"]));
  assert.match(log, /server error/);
  const seen = loadSeen(join(out, ROLE, "seen.csv"));
  assert.equal(seen.byUrl.size, 2, "page 1 was billed and is kept");
  assert.equal(JSON.parse(readFileSync(join(out, ROLE, "profiles.json"), "utf8")).length, 2);

  const fx2 = load("ml-engineer.json");
  fx2.faults = [{ path: "/person/search", call: 3, status: 402, message: "insufficient credits" }];
  const s2 = setup(fx2);
  const log2 = await quiet(() => runSource([...fx2.argv, "--yes"]));
  assert.match(log2, /open-to-new-roles check failed/);
  assert.ok(existsSync(join(s2.out, ROLE, "candidates.csv")), "the shortlist is still written");
});

test("--skip-from reads an ATS export and never changes it; a shared --seen list is remembered by the role", async () => {
  const fx = load("ml-engineer.json");
  const { out, calls } = setup(fx);
  const ats = join(out, "ats.csv");
  const text = "Candidate,Email,Profile,Stage\nJane Doe,jane@corp.example,https://www.example.com/in/example-jane-doe/,Offer\n";
  writeFileSync(ats, text);
  const refused = await quiet(() => runSource([...fx.argv, "--seen", ats, "--yes"]));
  assert.match(refused, /not a seen list made by this tool/);
  assert.equal(readFileSync(ats, "utf8"), text);

  const team = join(out, "team-seen.csv");
  await quiet(() => runSource([...fx.argv, "--skip-from", ats, "--seen", team, "--yes"]));
  assert.equal(readFileSync(ats, "utf8"), text, "the export is unchanged");
  assert.ok(searches(calls).at(-1)!.body.post_processing.exclude_profiles.includes("https://www.example.com/in/example-jane-doe"));
  assert.equal(loadRole(ROLE)?.seenFile, team);
  calls.length = 0;
  const shared = loadSeen(team).byUrl.size;
  const log = await quiet(() => runSource(["--name", ROLE, "--yes"]));
  assert.equal(searches(calls)[0].body.post_processing.exclude_profiles.length, shared + 1, "the next batch uses the shared list and the remembered --skip-from file");
  assert.match(log, /still skipping the people in/);
  // forget reaches the shared list too.
  await quiet(() => runForget(["https://www.example.com/in/example-rahul-example"]));
  assert.ok(!readFileSync(team, "utf8").includes("Rahul Example"));
});

test("a failed write after a billed page keeps those people in a separate file, and the role can be resumed", async () => {
  const fx = load("ml-engineer.json");
  const { out } = setup(fx);
  const { chmodSync } = await import("node:fs");
  // The role folder turns read-only right after the billed search answers (like a file held open on Windows).
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await real(input, init);
    if (String(input).endsWith("/person/search") && String(init?.body).includes('"search"')) chmodSync(join(out, ROLE), 0o500);
    return res;
  }) as typeof fetch;
  const log = await quiet(() => runSource([...fx.argv, "--yes"]));
  chmodSync(join(out, ROLE), 0o700);
  assert.match(log, /could not be added to/);
  const fallback = (await import("node:fs")).readdirSync(out).find(f => f.startsWith("seen-unsaved-"));
  assert.ok(fallback, "the billed people are written to a fallback file");
  assert.equal(loadSeen(join(out, fallback!)).byUrl.size, 4);
  assert.ok(loadRole(ROLE), "role.json is saved before the search, so --name works");
});

test("people seen without a profile URL are excluded by their Crustdata id", async () => {
  const fx = load("ml-engineer.json");
  fx.search.profiles[0].social_handles = { professional_network_identifier: { profile_url: null } };
  const { calls } = setup(fx);
  await quiet(() => runSource([...fx.argv, "--yes"]));
  calls.length = 0;
  await quiet(() => runSource(["--name", ROLE, "--yes"]));
  assert.match(JSON.stringify(searches(calls)[0].body.filters), /"crustdata_person_id","type":"not_in","value":\[9001\]/);
});

test("rewording the role lands in the same folder, says what it keeps, and still skips the people seen", async () => {
  const fx = load("ml-engineer.json");
  const { calls } = setup(fx);
  await quiet(() => runSource([...fx.argv, "--yes"]));
  calls.length = 0;
  const log = await quiet(() => runSource(["--role", "Senior ML engineer, 4+ years, PyTorch, US", "--yes"]));
  assert.match(log, /New sentence for: machine-learning-engineer-united-states/);
  assert.match(log, /kept from before: --must "PyTorch"/);
  assert.equal(searches(calls)[0].body.post_processing.exclude_profiles.length, 4);
});

test("rescore takes no role flags; forget removes a person everywhere but keeps them out of later runs", async () => {
  const fx = load("ml-engineer.json");
  const { out } = setup(fx);
  await quiet(() => runSource([...fx.argv, "--yes"]));
  assert.match(await quiet(() => runRescore(["--nice", "Python"])), /takes only --name and --top/);
  await quiet(() => runForget(["https://www.example.com/in/example-jane-doe"]));
  const dir = join(out, ROLE);
  assert.ok(!readFileSync(join(dir, "candidates.csv"), "utf8").includes("Jane Doe"));
  assert.ok(!readFileSync(join(dir, "profiles.json"), "utf8").includes("Jane Doe"));
  const seen = readFileSync(join(dir, "seen.csv"), "utf8");
  assert.ok(seen.includes("example-jane-doe") && !seen.includes("Jane Doe"), "URL kept, name blanked");
  await quiet(() => runForget(["https://www.example.com/in/example-jane-doe", "--erase"]));
  assert.ok(!readFileSync(join(dir, "seen.csv"), "utf8").includes("example-jane-doe"));
});

test("contacts: personal email by default, saved batch by batch, refused without contact access or in a script without --yes", async () => {
  const fx = load("ml-engineer.json");
  const { out, calls } = setup(fx);
  await quiet(() => runSource([...fx.argv, "--yes"]));
  assert.match(await quiet(() => runContacts(["--top", "3"])), /Add --yes/);
  await quiet(() => runContacts(["--top", "3", "--yes"]));
  const enrich = calls.find(c => c.path === "/person/contact/enrich")!;
  assert.deepEqual(enrich.body.fields, ["contact.personal_emails"]);
  const rows = parseCsv(readFileSync(join(out, ROLE, "contacts.csv"), "utf8"));
  assert.equal(rows[1][4], "jane.doe@example.com");
  assert.equal(rows.length - 1, 3);

  assert.equal(contactAccess([{ path: "/person/contact/enrich", status: "disabled" }], ["contact.personal_emails"]), undefined);
  assert.equal(contactAccess([{ path: "/person/enrich", status: "enabled", fields: { enabled: ["contact.personal_emails"] } }], ["contact.personal_emails"]), "/person/enrich");
  fx.endpoints = [];
  setup(fx);
  await quiet(() => runSource([...fx.argv, "--yes"]));
  assert.match(await quiet(() => runContacts(["--top", "3", "--yes"])), new RegExp(NO_CONTACT_ACCESS.slice(0, 40)));
});

test("contacts: a failure on a later batch keeps the batches already paid for", async () => {
  const fx = load("ml-engineer.json");
  const base = fx.search.profiles[0];
  fx.search.profiles = Array.from({ length: 30 }, (_, i): Person => ({ ...base, crustdata_person_id: 20000 + i,
    basic_profile: { ...base.basic_profile, name: `Person ${i}` },
    social_handles: { professional_network_identifier: { profile_url: `https://www.example.com/in/example-person-${i}` } } }));
  fx.search.total_count = 30;
  fx.argv = fx.argv.map(a => (a === "4" ? "30" : a));
  fx.faults = [{ path: "/person/contact/enrich", call: 2, status: 500 }];
  const { out } = setup(fx);
  await quiet(() => runSource([...fx.argv, "--yes"]));
  const log = await quiet(() => runContacts(["--top", "30", "--yes"]));
  assert.match(log, /server error/);
  const rows = parseCsv(readFileSync(join(out, ROLE, "contacts.csv"), "utf8"));
  assert.equal(rows.length - 1, 25, "the first batch of 25 is saved");
});

test("the watcher example uses the role's filters plus its title at any level, and sends nothing", async () => {
  const fx = load("ml-engineer.json");
  const { calls } = setup(fx);
  await quiet(() => runSource([...fx.argv, "--yes"]));
  const spec = loadRole(ROLE)!.spec;
  const body = watchBody(spec, [{ type: "slack", webhook_url: "https://hooks.slack.com/services/T0/B0/X" }]);
  const text = JSON.stringify(body.filters);
  assert.match(text, /"value":"machine learning engineer"/);
  assert.match(text, /"value":"ML engineer"/);
  assert.match(text, /"skills.professional_network_skills","type":"=","value":"PyTorch"/);
  assert.equal(body.config.trigger.every_hours, 168);
  assert.ok(!calls.some(c => c.path.startsWith("/watch")));
});

test("the AI sentence gets the record's facts only (no name, no profile URL), and is skipped without a key", async () => {
  const fx = load("ml-engineer.json");
  setup(fx);
  const p = fx.search.profiles[0];
  const spec = { role: "Machine learning engineer", name: "t", must: [], skills: [], nice: [], limit: 20 };
  const facts = factsFor(spec, p, scoreCandidate(spec, p));
  assert.match(facts, /Current: Senior Machine Learning Engineer at Example Labs/);
  assert.ok(!facts.includes("Jane"), "no name is sent");
  assert.ok(!facts.includes("/in/"), "no profile URL is sent");
  const stripped = { ...spec, role: "Female machine learning engineer, under 30 years old", query: "machine learning engineer" };
  assert.ok(!factsFor(stripped, p, scoreCandidate(stripped, p)).toLowerCase().includes("female"), "protected words never reach the model");
  assert.deepEqual(await whySentences([{ facts }], () => {}), [""]);
});

test("switching an existing role to a shared --seen list still skips everyone the role already paid for", async () => {
  const fx = load("ml-engineer.json");
  const { out, calls } = setup(fx);
  await quiet(() => runSource([...fx.argv, "--yes"]));
  calls.length = 0;
  await quiet(() => runSource(["--name", ROLE, "--seen", join(out, "team-seen.csv"), "--yes"]));
  assert.equal(searches(calls)[0].body.post_processing.exclude_profiles.length, 4);
});

test("people kept in a fallback file are skipped by the next run of that role and merged back into its seen list", async () => {
  const fx = load("ml-engineer.json");
  const { out, calls } = setup(fx);
  const { writeFileSync: write, existsSync: exists } = await import("node:fs");
  const row = "profile URL,name,first seen,crustdata person id\nhttps://www.example.com/in/example-jane-doe,Jane Doe,2026-10-21,9001\n";
  const own = join(out, `seen-unsaved-${ROLE}--2026-10-21.csv`), other = join(out, "seen-unsaved-another-role--2026-10-21.csv");
  write(own, row); write(other, row);
  await quiet(() => runSource([...fx.argv, "--dry-run"]));
  assert.ok(exists(own), "a dry run reads the file and leaves it");
  const log = await quiet(() => runSource([...fx.argv, "--yes"]));
  assert.ok(searches(calls)[0].body.post_processing.exclude_profiles.includes("https://www.example.com/in/example-jane-doe"));
  assert.match(log, /added the people in/);
  assert.ok(!exists(own));
  assert.ok(exists(other), "another role's file is not touched");
});

test("contacts: a second lookup with --work-email asks only for the work email, not the personal email again", async () => {
  const fx = load("ml-engineer.json");
  const { calls } = setup(fx);
  await quiet(() => runSource([...fx.argv, "--yes"]));
  await quiet(() => runContacts(["--top", "2", "--yes"]));
  calls.length = 0;
  await quiet(() => runContacts(["--top", "2", "--work-email", "--yes"]));
  const enrich = calls.filter(c => c.path === "/person/contact/enrich");
  assert.equal(enrich.length, 1);
  assert.deepEqual(enrich[0].body.fields, ["contact.business_emails"]);
});

test('a skill stored under other spellings: --must "Go" matches "Golang" or "Go (Programming Language)", and scores them', async () => {
  const fx = load("ml-engineer.json");
  fx.search.profiles[0].skills = { professional_network_skills: ["Golang"] };
  const { out, calls } = setup(fx);
  const log = await quiet(() => runSource(["--role", "Backend engineer, United States", "--must", "Go", "--yes"]));
  assert.match(log, /--must "Go" is stored as "Golang" or "Go \(Programming Language\)"; any of them counts/);
  assert.match(JSON.stringify(searches(calls)[0].body.filters), /"op":"or","conditions":\[\{"field":"skills.professional_network_skills","type":"=","value":"Golang"\},\{"field":"skills.professional_network_skills","type":"=","value":"Go \(Programming Language\)"\}\]/);
  const rows = parseCsv(readFileSync(join(out, "backend-engineer-united-states", "candidates.csv"), "utf8"));
  const jane = rows.find(r => r[2] === "Jane Doe")!;
  assert.ok(jane[16].includes("has Go"), jane[16]);
});
