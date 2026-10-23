// Find the people at a company by title and write them as rows you can enrich.
//   npm run find-people -- --domain acme.example --titles "VP Sales, Head of Marketing" --limit 5
//   npm run find-people -- --domains acme.example,northwind.example --titles "CEO, CTO"
// Writes out/people-<domain>.csv (name, title, company, profile URL). Cost: about 0.03 credits per result at list price.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { apiKey, fail, parseArgs, plural, ROOT, table } from "./env";
import { readAccount } from "../lib/account";
import { createClient } from "../lib/crustdata";
import { toCsv } from "../lib/csv";
import { findPeople } from "../lib/find-people";
import { normalizeDomain } from "../lib/normalize";
import { fmt } from "../lib/plan";

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const raw = typeof flags.domains === "string" ? flags.domains : typeof flags.domain === "string" ? flags.domain : "";
  const domains = raw.split(",").map(s => normalizeDomain(s)).filter((d): d is string => !!d);
  if (!domains.length) fail(new Error('Usage: npm run find-people -- --domain acme.example --titles "VP Sales, Head of Marketing" [--limit 5]'));
  const titles = typeof flags.titles === "string" ? flags.titles.split(",").map(s => s.trim()).filter(Boolean) : [];
  const limit = flags.limit ? Number(flags.limit) : 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(new Error("--limit must be between 1 and 100"));
  const client = createClient({ apiKey: apiKey() });
  await readAccount(client);
  const rows: unknown[][] = [];
  for (const domain of domains) {
    const r = await findPeople(client, domain, titles, limit);
    if (!r.company) { console.log(`${domain}: no company with that domain in Crustdata.`); continue; }
    console.log(`${r.company.name} (${domain}): ${plural(r.people.length, "person", "people")}${titles.length ? ` matching ${titles.join(", ")}` : ""}, ${fmt(r.credits)} credits.`);
    if (r.people.length) console.log(table([["Name", "Title", "Location"], ...r.people.map(p => [p.name, p.title, p.location])]));
    for (const p of r.people) rows.push([p.name, p.title, p.company, p.domain, p.profileUrl, p.seniority, p.location]);
  }
  if (!rows.length) return;
  mkdirSync(resolve(ROOT, "out"), { recursive: true });
  const file = resolve(ROOT, "out", `people-${domains.length === 1 ? domains[0] : "accounts"}.csv`);
  writeFileSync(file, toCsv(["Name", "Title", "Company", "Website", "Profile URL", "Seniority", "Location"], rows));
  console.log(`Wrote ${file}. Enrich it with: npm run enrich -- ${file.replace(ROOT + "/", "")} --columns person.email,company.headcount`);
}

main().catch(fail);
