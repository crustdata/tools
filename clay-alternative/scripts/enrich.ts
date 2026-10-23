// Enrich a CSV from the terminal. Same engine as the web app, with a SQLite cache so nothing is paid for twice.
//
//   npm run enrich -- leads.csv                                   default columns
//   npm run enrich -- leads.csv --columns person.title,company.headcount,company.funding_total
//   npm run enrich -- leads.csv --all                             every column except Work email and Tech stack
//   npm run enrich -- leads.csv --dry-run                         the plan and the estimate, no calls
//   npm run enrich -- leads.csv --limit 50                        the first 50 usable rows
//   npm run enrich -- leads.csv --refresh                         ignore the cache
//   npm run enrich -- leads.csv --yes                             skip the confirmation (for scripts and cron)
//   npm run enrich -- leads.csv --max-credits 200                 stop before the next call once 200 credits are spent
//   npm run enrich -- leads.csv --max-age 30                      re-fetch cached records older than 30 days (default 30; 0 = never)
//
// Output: out/<file>.enriched.csv and out/<file>.unresolved.csv. Needs CRUSTDATA_API_KEY.

import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { apiKey, fail, numberFlag, parseArgs, plural, ROOT } from "./env";
import { readAccount } from "../lib/account";
import { SqliteCache } from "../lib/cache-sqlite";
import { COLUMNS, defaultsFor, resolveColumns } from "../lib/columns";
import { createClient } from "../lib/crustdata";
import { isExcel, readCsv } from "../lib/csv";
import { buildOutput } from "../lib/export";
import { describeEstimate, fmt, plan } from "../lib/plan";
import { runPlan } from "../lib/run";
import type { RunEvent } from "../lib/events";

const USAGE = "Usage: npm run enrich -- <file.csv> [--columns a,b,c | --all] [--dry-run] [--limit N] [--refresh] [--yes] [--max-credits N] [--max-age DAYS] [--out dir]";

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const file = positional[0];
  if (!file) fail(new Error(USAGE));
  if (!existsSync(file)) fail(new Error(`File not found: ${file}`));
  const bytes = readFileSync(file);
  if (isExcel(bytes)) fail(new Error(`${file} is an Excel file. Save it as CSV (File, Save As, CSV UTF-8) and run that.`));
  const detected = readCsv(bytes.toString("utf8"));

  if (flags.columns === true) fail(new Error("--columns needs a list, for example --columns person.title,company.headcount"));
  const ids = flags.all ? COLUMNS.filter(c => c.source.kind !== "person_premium" && c.source.kind !== "company_premium").map(c => c.id)
    : typeof flags.columns === "string" ? flags.columns.split(",") : defaultsFor(detected.counts);
  const { columns, unknown } = resolveColumns(ids);
  if (unknown.length) fail(new Error(unknown.map(u => `Unknown column "${u.id}". Closest: ${u.closest.join(", ")}.`).join("\n") + "\nRun npm run columns to see every column."));
  if (!columns.length) fail(new Error("No columns chosen. Run npm run columns to see every column."));

  let rows = detected.rows;
  const limit = numberFlag(flags, "limit", { integer: true, min: 1 });
  if (limit !== undefined) rows = rows.filter(r => r.id).slice(0, limit);
  console.log(`${file}: ${plural(rows.length, "row")} read${detected.duplicates ? `, ${detected.duplicates} sharing an identifier with another row (looked up once)` : ""} (${Object.entries(detected.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ")}).`);
  const roleLine = Object.entries(detected.roles).map(([r, h]) => `${r}: "${h}"`).join(", ");
  if (roleLine) console.log(`Columns recognised: ${roleLine}.`);

  const key = apiKey();
  const client = createClient({ apiKey: key });
  const account = await readAccount(client, { probeEmail: rows.some(r => r.id?.kind === "email") });
  if (columns.some(c => c.source.kind === "person_premium") && !account.emailColumn) fail(new Error("The person.email column needs contact data enabled on your Crustdata account; self-serve keys do not have it. Drop the column and run again."));
  const p = plan(rows, columns, account);
  for (const w of p.warnings) console.log(`Note: ${w}`);
  if (p.problems.length) console.log(`${plural(p.problems.length, "row")} cannot be enriched (line ${p.problems.slice(0, 10).map(x => x.line).join(", ")}${p.problems.length > 10 ? ", ..." : ""}); they go to the unresolved file.`);
  console.log(`\nColumns: ${columns.map(c => c.id).join(", ")}`);
  for (const l of p.estimate.lines) console.log(`  ${l.label}: ${l.count} x ${fmt(l.each)} = up to ${fmt(l.credits)} credits`);
  console.log(`Estimate: ${describeEstimate(p.estimate, "shown")}. Misses and cache hits are free.${p.estimate.note ? ` ${p.estimate.note}` : ""}`);
  if (account.credits !== null) console.log(`Credits remaining: ${fmt(account.credits)}.`);
  if (flags["dry-run"]) { console.log("Dry run: no calls made."); return; }
  if (!flags.yes && p.estimate.credits > 0) {
    if (!process.stdin.isTTY) fail(new Error("Not a terminal: add --yes to run without the confirmation."));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Run it? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") { console.log("Stopped. Nothing was called."); return; }
  }

  const cachePath = process.env.CACHE_PATH || "data/cache.sqlite";
  const cache = new SqliteCache(cachePath === ":memory:" ? cachePath : resolve(ROOT, cachePath));
  const envCap = process.env.MAX_CREDITS_PER_RUN ? Number(process.env.MAX_CREDITS_PER_RUN) : NaN;
  const maxCredits = numberFlag(flags, "max-credits") ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : undefined);
  const maxAgeDays = numberFlag(flags, "max-age") ?? 30;
  let line = "";
  const print = (s: string) => { process.stdout.write(`\r${" ".repeat(line.length)}\r${s}`); line = s; };
  const progress = { people: [0, 0], companies: [0, 0] };
  const emit = (e: RunEvent) => {
    if (e.type === "progress") { progress[e.phase] = [e.done, e.total]; print(`people ${progress.people[0]}/${progress.people[1]}, companies ${progress.companies[0]}/${progress.companies[1]}, credits ${fmt(client.spend.credits)}`); }
    if (e.type === "error") { process.stdout.write("\n"); console.error(e.message); }
    if (e.type === "note") { process.stdout.write("\n"); console.log(e.message); }
  };
  const result = await runPlan(p, { client, cache, account, emit, maxCredits, maxAgeDays, refresh: !!flags.refresh, readRemaining: true });
  process.stdout.write("\n");
  cache.close();

  const outDir = resolve(ROOT, typeof flags.out === "string" ? flags.out : "out");
  mkdirSync(outDir, { recursive: true });
  const stem = basename(file).replace(/\.csv$/i, "");
  const out = buildOutput(rows, columns, result.cells, result.status, detected.headers);
  writeFileSync(resolve(outDir, `${stem}.enriched.csv`), out.enrichedCsv);
  if (out.unresolved) writeFileSync(resolve(outDir, `${stem}.unresolved.csv`), out.unresolvedCsv);
  const s = result.summary;
  console.log(`Done: ${s.matched} of ${s.rows} rows fully matched, ${s.partial} partly, ${s.unresolved} unresolved (people ${s.people.matched} matched, companies ${s.companies.matched} matched).`);
  console.log(`Credits used: ${fmt(result.cost.credits)}${result.cost.cached ? ` (${fmt(result.cost.cached)} saved by the cache)` : ""}${Object.keys(result.cost.byEndpoint).length ? `: ${Object.entries(result.cost.byEndpoint).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")}` : ""}.`);
  console.log(`Wrote ${resolve(outDir, `${stem}.enriched.csv`)}${out.unresolved ? ` and ${stem}.unresolved.csv (${plural(out.unresolved, "row")} to fix and run again)` : ""}.`);
}

main().catch(fail);
