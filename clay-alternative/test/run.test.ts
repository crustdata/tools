import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryCache } from "../lib/cache";
import { SqliteCache } from "../lib/cache-sqlite";
import { pickDomainMatch, pickNameMatch } from "../lib/run";
import { fixture, responses, runCsv } from "./helpers";
import { stubFetch } from "../lib/stub";

test("the messy CSV fills every row from the fixture and bills what the API billed", async () => {
  const { detected, result, events, log } = await runCsv(fixture("messy.csv"));
  const at = (line: number) => { const i = detected.rows.findIndex(r => r.line === line); return { c: result.cells.get(i)!, s: result.status.get(i) }; };
  const jane = at(2);
  assert.equal(jane.c["person.name"].value, "Jane Doe");
  assert.equal(jane.c["person.name"].source, "POST /person/enrich basic_profile.name");
  assert.equal(jane.c["company.headcount"].value, 240);
  assert.equal(jane.c["company.headcount"].source, "POST /company/identify headcount.total");
  assert.equal(jane.c["company.last_round_type"].value, "Series B");
  assert.equal(jane.s?.person, "matched");
  assert.equal(jane.s?.company, "matched");
  const lee = at(5);
  assert.equal(lee.c["person.name"].value, "Lee Nodomain");
  assert.equal(lee.s?.company, "not_found");
  assert.match(lee.s?.note ?? "", /Personal email/);
  const broken = at(6);
  assert.equal(broken.c["person.name"].status, "invalid");
  const nobody = at(7);
  assert.equal(nobody.s?.person, "not_found");
  assert.equal(nobody.c["company.name"].value, "Acme Analytics", "a company match does not need a person match");
  const hidden = at(10);
  assert.equal(hidden.c["person.title"].status, "redacted");
  // 5 matched people (jane, sam, rita, lee, and nobody is a miss) = 4 credits, 2 company profiles = 4
  assert.equal(result.cost.credits, 8);
  assert.equal(result.summary.people.matched, 4);
  assert.equal(result.summary.people.not_found, 1);
  assert.equal(result.summary.people.redacted, 1);
  assert.equal(result.summary.companies.ambiguous, 1);
  assert.equal(result.summary.companies.matched, 2, "acme and northwind, each counted once however many rows");
  assert.equal(result.summary.companies.not_found, 1, "platform.example");
  assert.equal(result.summary.matched, 4, "Jane twice, Sam, Rita");
  assert.equal(result.summary.partial, 3, "Lee (no employer on the profile), nobody and hidden (company matched from the domain, person not found or redacted)");
  assert.equal(log.filter(l => l.path === "/person/enrich").length, 1);
  assert.equal(log.filter(l => l.path === "/company/enrich").length, 1);
  assert.deepEqual(log.find(l => l.path === "/company/enrich")!.body.fields, ["funding"]);
  assert.equal(events[0].type, "start");
  assert.equal(events.at(-1)!.type, "done");
  assert.ok(events.some(e => e.type === "cost"));
});

test("an address Crustdata rejects is pulled out of the batch, which is retried once", async () => {
  const { result, log } = await runCsv("Email\njane@acme.example\nweird@acme.example\n", ["person.title"], { fixture: { invalidEmails: ["weird@acme.example"] } });
  assert.equal(log.filter(l => l.path === "/person/enrich").length, 2);
  assert.deepEqual(log.filter(l => l.path === "/person/enrich")[1].body.business_emails, ["jane@acme.example"]);
  assert.equal(result.cells.get(0)!["person.title"].value, "Co-Founder & CEO");
  assert.equal(result.cells.get(1)!["person.title"].status, "invalid");
  assert.equal(result.cost.credits, 1);
});

test("a second run reads everything from the cache and bills nothing", async () => {
  const cache = new MemoryCache();
  const first = await runCsv(fixture("messy.csv"), undefined, { cache });
  assert.equal(first.result.cost.credits, 8);
  const second = await runCsv(fixture("messy.csv"), undefined, { cache });
  assert.equal(second.result.cost.credits, 0);
  assert.equal(second.result.cost.cached, 8, "the cache reports what it saved");
  assert.equal(second.log.filter(l => l.path.startsWith("/person") || l.path.startsWith("/company")).length, 0);
  assert.deepEqual([...second.result.cells.get(0)!["person.name"].value as any], [..."Jane Doe"]);
});

test("the SQLite cache does the same across processes", async () => {
  const cache = new SqliteCache(":memory:");
  await runCsv(fixture("domains.csv"), ["company.funding_total"], { cache });
  const again = await runCsv(fixture("domains.csv"), ["company.funding_total"], { cache });
  assert.equal(again.result.cost.credits, 0);
  assert.equal(cache.stats().companies, 2);
  // Asking for a group the cache does not hold calls again, once.
  const more = await runCsv(fixture("domains.csv"), ["company.funding_total", "company.open_roles"], { cache });
  assert.equal(more.result.cost.credits, 4);
  assert.deepEqual(more.log.find(l => l.path === "/company/enrich")!.body.fields, ["funding", "hiring"]);
  cache.close();
});

test("--refresh ignores the cache", async () => {
  const cache = new MemoryCache();
  await runCsv(fixture("domains.csv"), ["company.funding_total"], { cache });
  const again = await runCsv(fixture("domains.csv"), ["company.funding_total"], { cache, refresh: true });
  assert.equal(again.result.cost.credits, 4);
});

test("a domain hosted on a platform is not matched to the platform's lookalike", async () => {
  const { result } = await runCsv("Website\nplatform.example\n", ["company.name"]);
  assert.equal(result.cells.get(0)!["company.name"].status, "not_found");
  assert.match(result.cells.get(0)!["company.name"].note ?? "", /closest: Hosted Lookalike/);
  const r = pickDomainMatch(responses.identify[2].matches, "platform.example");
  assert.equal(r.status, "not_found");
  assert.equal(pickDomainMatch(responses.identify[0].matches, "acme.example").status, "matched");
  assert.equal(pickDomainMatch(responses.identify[0].matches, "shop.acme.example").status, "matched", "a subdomain of the company's domain matches");
  const platform = [{ confidence_score: 1, company_data: { crustdata_company_id: 9, basic_info: { name: "Heroku", primary_domain: "herokuapp.com", all_domains: ["herokuapp.com", null] } } }];
  assert.equal(pickDomainMatch(platform, "acme.herokuapp.com").status, "not_found", "a platform host is never a parent match, and a null domain does not crash");
  const suffix = [{ confidence_score: 1, company_data: { crustdata_company_id: 9, basic_info: { name: "x", primary_domain: "co.uk" } } }];
  assert.equal(pickDomainMatch(suffix, "acme.co.uk").status, "not_found");
});

test("results are matched to inputs by identifier, never by position", async () => {
  const swapped = { ...responses, person: [
    { matched_on: "https://www.linkedin.com/in/example-sam-example", match_type: "professional_network_profile_url", match_status: "matched", matches: responses.person[7].matches },
    { matched_on: "https://www.linkedin.com/in/example-jane-doe", match_type: "professional_network_profile_url", match_status: "matched", matches: responses.person[6].matches },
  ] };
  const { result } = await runCsv("Profile URL\nhttps://www.linkedin.com/in/Example-Jane-Doe\nhttps://www.linkedin.com/in/example-sam-example\n", ["person.name"], { fixture: swapped });
  assert.equal(result.cells.get(0)!["person.name"].value, "Jane Doe");
  assert.equal(result.cells.get(1)!["person.name"].value, "Sam Example");
  const silent: typeof fetch = async (input, init) => String(input).endsWith("/person/enrich") ? new Response("[]", { status: 200, headers: { "content-type": "application/json", "x-credits-used": "0" } }) : stubFetch({ responses })(input, init);
  const { createClient } = await import("../lib/crustdata");
  const { readCsv } = await import("../lib/csv");
  const { resolveColumns } = await import("../lib/columns");
  const { plan } = await import("../lib/plan");
  const { runPlan } = await import("../lib/run");
  const { fakeAccount } = await import("./helpers");
  const client = createClient({ apiKey: "x", fetch: silent, sleep: async () => {} });
  const d = readCsv("Profile URL\nhttps://www.linkedin.com/in/example-jane-doe\n");
  const pl = plan(d.rows, resolveColumns(["person.name"]).columns, fakeAccount());
  const r2 = await runPlan(pl, { client, cache: new MemoryCache(), account: fakeAccount(), emit: () => {} });
  assert.equal(r2.cells.get(0)!["person.name"].status, "error", "a result Crustdata did not echo is an error, not someone else's record");
});

test("a 5xx on a paid call is not retried, a 5xx on a free call is", async () => {
  let n = 0;
  const flaky: typeof fetch = async (input, init) => {
    n++;
    const path = String(input).replace("https://api.crustdata.com", "");
    if ((path === "/person/enrich" || path === "/company/identify") && n <= 2) return new Response("bad gateway", { status: 502, headers: { "x-credits-used": "0" } });
    return stubFetch({ responses })(input, init);
  };
  const { createClient } = await import("../lib/crustdata");
  const client = createClient({ apiKey: "x", fetch: flaky, sleep: async () => {} });
  await assert.rejects(client.enrichPeople({ emails: ["jane@acme.example"] }, ["basic_profile"]), /did not respond/);
  n = 0;
  const r = await client.identifyCompanies({ domains: ["acme.example"] });
  assert.equal(r[0].matches.length, 1);
});

test("a work-email row never shows 'not found' for the company while the profile may still name the employer", async () => {
  const csv = "Email\nsam@acme-brand.example\n";
  const fx = { responses: { ...responses, person: [{ matched_on: "sam@acme-brand.example", match_type: "business_email", match_status: "matched", matches: responses.person[1].matches }] } };
  const { events, result } = await runCsv(csv, ["company.name"], { fixture: fx });
  const companyCells = events.filter(e => e.type === "cells" && e.cells["company.name"]) as any[];
  assert.equal(companyCells.length, 1);
  assert.equal(companyCells[0].cells["company.name"].status, "matched");
  assert.equal(result.cost.credits, 1, "one person lookup to read the employer, the company itself is free");
  assert.deepEqual(result.summary.companies, { matched: 1, not_found: 0, ambiguous: 0 }, "the rescued email domain is not counted as a miss");
});

test("cached records older than --max-age are fetched again", async () => {
  const cache = new MemoryCache();
  await runCsv(fixture("domains.csv"), ["company.funding_total"], { cache, now: () => new Date("2026-01-01T00:00:00Z") });
  const fresh = await runCsv(fixture("domains.csv"), ["company.funding_total"], { cache, maxAgeDays: 30 });
  assert.equal(fresh.result.cost.credits, 4);
  const kept = await runCsv(fixture("domains.csv"), ["company.funding_total"], { cache, maxAgeDays: 30 });
  assert.equal(kept.result.cost.credits, 0);
});

test("company names need a clear winner", async () => {
  assert.equal(pickNameMatch(responses.identify[3].matches, "Acme Analytics").status, "matched");
  assert.equal(pickNameMatch(responses.identify[3].matches, "acme analytics inc").status, "matched");
  assert.equal(pickNameMatch(responses.identify[4].matches, "Northwind Robotics").status, "ambiguous");
  assert.equal(pickNameMatch(responses.identify[5].matches, "Zzqx Widgets").status, "ambiguous");
  assert.equal(pickNameMatch([], "Nothing").status, "not_found");
  const big = [{ confidence_score: 1, company_data: { crustdata_company_id: 1, basic_info: { name: "Acme" }, headcount: { total: 5000 } } }, { confidence_score: 1, company_data: { crustdata_company_id: 2, basic_info: { name: "ACME" }, headcount: { total: 12 } } }];
  const r = pickNameMatch(big, "Acme");
  assert.equal(r.status, "matched");
  assert.match(r.data.note ?? "", /Largest of 2/);
});

test("profile URL rows get their company from the current employer", async () => {
  const { result } = await runCsv(fixture("profile-urls.csv"));
  const jane = result.cells.get(0)!;
  assert.equal(jane["company.name"].value, "Acme Analytics");
  assert.equal(result.status.get(0)!.employerDomain, "acme.example");
  assert.equal(result.cells.get(2)!["company.name"].status, "not_found");
  assert.equal(result.cost.credits, 5, "3 people and one company profile (Acme once for Jane and Sam)");
});

test("the email column is left as needs_access without contact data, and skipped from the call", async () => {
  const { result, log } = await runCsv("Email\njane@acme.example\n", ["person.email", "person.title"], { account: { ...((await import("./helpers")).fakeAccount({ emailColumn: false })) } });
  assert.equal(result.cells.get(0)!["person.email"].status, "needs_access");
  assert.equal(result.cells.get(0)!["person.title"].value, "Co-Founder & CEO");
  assert.ok(!log.find(l => l.path === "/person/enrich")!.body.fields.includes("contact.business_emails"));
  assert.equal(result.cost.credits, 1);
});

test("with contact access the email column costs one more credit per person with an email", async () => {
  const { result } = await runCsv("Email\njane@acme.example\nrita@northwind.example\n", ["person.email"]);
  assert.equal(result.cells.get(0)!["person.email"].value, "jane@acme.example");
  assert.equal(result.cells.get(1)!["person.email"].value, null, "Rita has no email on file");
  assert.equal(result.cost.credits, 3);
});

test("a key that cannot look emails up marks email rows needs_access and makes no call", async () => {
  const { result, log } = await runCsv("Email\njane@acme.example\n", ["person.title"], { account: (await import("./helpers")).fakeAccount({ emailLookup: false }) });
  assert.equal(result.cells.get(0)!["person.title"].status, "needs_access");
  assert.equal(log.filter(l => l.path === "/person/enrich").length, 0);
});

test("an enrich group the key cannot read is dropped, the rest is filled, and the cells say so", async () => {
  const { result, events } = await runCsv("Website\nacme.example\n", ["company.funding_total", "company.tech_stack"], { fixture: { disabledGroups: ["technographics"] } });
  assert.equal(result.cells.get(0)!["company.funding_total"].value, 48000000);
  assert.equal(result.cells.get(0)!["company.tech_stack"].status, "needs_access");
  assert.ok(events.some(e => e.type === "note" && /technographics/.test(e.message)));
});

test("the run stops at the credit cap and says so, keeping what it has", async () => {
  const csv = "Website\n" + ["acme.example", "northwind.example"].join("\n") + "\n";
  const { result, events } = await runCsv(csv, ["company.funding_total"], { maxCredits: 0 });
  const err = events.find(e => e.type === "error") as any;
  assert.match(err.message, /credit cap/);
  assert.equal(err.fatal, false);
  assert.equal(result.cost.credits, 0);
  assert.equal(result.cells.get(0)!["company.funding_total"].status, "error", "the paid column was never filled, and says so");
  assert.equal(result.summary.unresolved, 2);
});

test("a domain-only row has no person columns to fill", async () => {
  const { result } = await runCsv("Website\nacme.example\n");
  assert.equal(result.cells.get(0)!["person.name"].status, "no_identifier");
  assert.equal(result.cells.get(0)!["company.name"].status, "matched");
});

test("a 401 stops the run with a plain message", async () => {
  const bad = async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, headers: { "x-credits-used": "0" } });
  const { createClient } = await import("../lib/crustdata");
  const { readCsv } = await import("../lib/csv");
  const { resolveColumns } = await import("../lib/columns");
  const { plan } = await import("../lib/plan");
  const { runPlan } = await import("../lib/run");
  const { fakeAccount } = await import("./helpers");
  const client = createClient({ apiKey: "x", fetch: bad as any, sleep: async () => {} });
  const d = readCsv("Website\nacme.example\n");
  const p = plan(d.rows, resolveColumns(["company.funding_total"]).columns, fakeAccount());
  const events: any[] = [];
  await assert.rejects(runPlan(p, { client, cache: new MemoryCache(), account: fakeAccount(), emit: e => events.push(e) }), /not accepted/);
  assert.equal(events.find(e => e.type === "error").fatal, true);
});

test("a work email whose domain finds no company falls back to the employer on the profile", async () => {
  const csv = "Email\nsam@acme-brand.example\n";
  const fx = { responses: { ...responses, person: [{ matched_on: "sam@acme-brand.example", match_type: "business_email", match_status: "matched", matches: responses.person[1].matches }] } };
  const { result, log } = await runCsv(csv, ["person.title", "company.name", "company.funding_total"], { fixture: fx });
  assert.equal(result.cells.get(0)!["company.name"].value, "Acme Analytics");
  assert.equal(result.cells.get(0)!["company.funding_total"].value, 48000000);
  assert.match(result.status.get(0)!.note ?? "", /using the employer on the profile \(acme.example\)/);
  assert.deepEqual(log.filter(l => l.path === "/company/identify").map(l => l.body.domains[0]), ["acme-brand.example", "acme.example"]);
});

test("a work email whose domain and profile employer both miss ends as company not found, not pending", async () => {
  const sam = JSON.parse(JSON.stringify(responses.person[1].matches));
  sam[0].person_data.experience.employment_details.current[0].company_website_domain = "nowhere.example";
  const fx = { responses: { ...responses, person: [{ matched_on: "sam@acme-brand.example", match_type: "business_email", match_status: "matched", matches: sam }] } };
  const { result } = await runCsv("Email\nsam@acme-brand.example\n", ["person.name", "company.name"], { fixture: fx });
  assert.equal(result.cells.get(0)!["company.name"].status, "not_found");
  assert.equal(result.status.get(0)!.company, "not_found");
  assert.equal(result.summary.companies.not_found, 1);
  const lazy = await runCsv("Email\nsam@acme-brand.example\n", ["company.name"], { fixture: fx });
  assert.equal(lazy.result.cells.get(0)!["company.name"].status, "not_found");
});

test("the lazy employer lookup is skipped for a key that cannot look emails up", async () => {
  const { fakeAccount } = await import("./helpers");
  const { result, log } = await runCsv("Email\nsam@acme-brand.example\n", ["company.name"], { account: fakeAccount({ emailLookup: false }) });
  assert.equal(log.filter(l => l.path === "/person/enrich").length, 0);
  assert.equal(result.cells.get(0)!["company.name"].status, "not_found");
  assert.match(result.cells.get(0)!["company.name"].note ?? "", /cannot read the profile/);
});

test("a stale identify miss is asked again under --max-age", async () => {
  const cache = new MemoryCache();
  await runCsv("Website\nnothing.example\n", ["company.name"], { cache, now: () => new Date("2026-01-01T00:00:00Z") });
  const again = await runCsv("Website\nnothing.example\n", ["company.name"], { cache, maxAgeDays: 30 });
  assert.equal(again.log.filter(l => l.path === "/company/identify").length, 1);
});

test("an enrich record absent only because its groups were dropped is not remembered as a miss", async () => {
  const cache = new MemoryCache();
  const first = await runCsv("Website\nacme.example\n", ["company.tech_stack"], { cache, fixture: { disabledGroups: ["technographics"] } });
  assert.equal(first.result.cells.get(0)!["company.tech_stack"].status, "needs_access");
  const second = await runCsv("Website\nacme.example\n", ["company.tech_stack"], { cache });
  assert.equal(second.result.cells.get(0)!["company.tech_stack"].value, "Python; PostgreSQL; React; Kubernetes; Salesforce");
});
