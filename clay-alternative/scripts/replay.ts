// Runs a saved case offline, against a fake Crustdata built from fixtures, and prints the table. No key, no calls.
//   npm run replay -- fixtures/emails.json

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fail, table } from "./env";
import { accountFromEndpoints } from "../lib/account";
import { MemoryCache } from "../lib/cache";
import { DEFAULT_COLUMNS, resolveColumns } from "../lib/columns";
import { createClient } from "../lib/crustdata";
import { readCsv } from "../lib/csv";
import { buildOutput, rowStatusText } from "../lib/export";
import { describeEstimate, fmt, plan } from "../lib/plan";
import { runPlan } from "../lib/run";
import { DEFAULT_ENDPOINTS, stubFetch, type Fixture } from "../lib/stub";

export function loadFixture(file: string): Fixture {
  const fx = JSON.parse(readFileSync(file, "utf8"));
  if (typeof fx.responses === "string") fx.responses = JSON.parse(readFileSync(resolve(dirname(file), fx.responses), "utf8"));
  return fx;
}

async function main() {
  const file = process.argv[2];
  if (!file) fail(new Error("Usage: npm run replay -- fixtures/<case>.json"));
  const fx = loadFixture(file);
  const detected = readCsv(fx.csv ?? "");
  const { columns, unknown } = resolveColumns(fx.columns ?? DEFAULT_COLUMNS);
  if (unknown.length) fail(new Error(`Unknown columns in the fixture: ${unknown.map(u => u.id).join(", ")}`));
  const client = createClient({ apiKey: "fixture", fetch: stubFetch(fx), sleep: async () => {} });
  const account = accountFromEndpoints(fx.endpoints ?? DEFAULT_ENDPOINTS, fx.credits ?? 1000);
  account.emailLookup = true;
  const p = plan(detected.rows, columns, account);
  console.log(`${fx.name ?? file}: ${describeEstimate(p.estimate, "shown")}`);
  for (const w of p.warnings) console.log(`Note: ${w}`);
  const result = await runPlan(p, { client, cache: new MemoryCache(), account, emit: () => {} });
  const hasPerson = columns.some(c => c.group === "Person"), hasCompany = columns.some(c => c.group === "Company");
  const rows = [["line", "input", ...columns.map(c => c.label), "status"]];
  detected.rows.forEach((row, i) => {
    const c = result.cells.get(i) ?? {};
    rows.push([String(row.line), row.id?.value ?? row.problem ?? "", ...columns.map(col => clip(c[col.id]?.value)), rowStatusText(row, result.status.get(i), hasPerson, hasCompany)]);
  });
  console.log(table(rows));
  const out = buildOutput(detected.rows, columns, result.cells, result.status, detected.headers);
  console.log(`\n${result.summary.matched} matched, ${result.summary.partial} partly, ${result.summary.unresolved} unresolved; ${fmt(result.cost.credits)} credits (fake).`);
  if (out.unresolved) console.log(`Unresolved:\n${out.unresolvedCsv}`);
}

const clip = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return s.length > 28 ? s.slice(0, 27) + "…" : s; };

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) main().catch(fail);
