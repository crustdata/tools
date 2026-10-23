// Refreshes the stored results behind the three sample buttons on the page (public/samples/results.json).
// Runs each sample CSV through the real engine once with your key and saves the events, so visitors replay them for free.
//   npm run samples              all three
//   npm run samples -- emails    one of them

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { apiKey, fail, ROOT } from "./env";
import { readAccount } from "../lib/account";
import { SqliteCache } from "../lib/cache-sqlite";
import { defaultsFor, resolveColumns } from "../lib/columns";
import { createClient } from "../lib/crustdata";
import { readCsv } from "../lib/csv";
import { plan } from "../lib/plan";
import { runPlan } from "../lib/run";
import type { RunEvent } from "../lib/events";

export const SAMPLES = ["emails", "domains", "profile-urls"] as const;

/** Visitors replaying a sample pay nothing and see no credit numbers, so none are stored. */
export function stripCredits(events: RunEvent[]): RunEvent[] {
  return events.filter(e => e.type !== "cost").map(e => {
    if (e.type === "start") return { ...e, estimate: { ...e.estimate, credits: -1, listCredits: -1, lines: [], listLines: [], note: "" } };
    if (e.type === "done") return { ...e, cost: { ...e.cost, credits: -1, byEndpoint: {}, cached: -1 }, remaining: null };
    return e;
  });
}

async function main() {
  const client = createClient({ apiKey: apiKey() });
  const account = await readAccount(client, { probeEmail: true });
  const file = resolve(ROOT, "public/samples/results.json");
  const out: Record<string, { events: RunEvent[]; columns: string[]; fetchedAt: string }> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const only = process.argv.slice(2).filter(a => (SAMPLES as readonly string[]).includes(a));
  // Results are cached in data/samples-cache.sqlite, so a re-run after a code change pays only for what is new.
  const cache = new SqliteCache(resolve(ROOT, "data/samples-cache.sqlite"));
  for (const name of only.length ? only : SAMPLES) {
    const csv = readFileSync(resolve(ROOT, "public/samples", `${name}.csv`), "utf8");
    const detected = readCsv(csv);
    const { columns } = resolveColumns(defaultsFor(detected.counts));
    const p = plan(detected.rows, columns, account);
    const events: RunEvent[] = [];
    const before = client.spend.credits;
    await runPlan(p, { client, cache, account, emit: e => events.push(e), pricing: "hidden" });
    out[name] = { events: stripCredits(events), columns: columns.map(c => c.id), fetchedAt: new Date().toISOString().slice(0, 10) };
    console.log(`${name}: ${detected.rows.length} rows, ${Math.round((client.spend.credits - before) * 100) / 100} credits.`);
  }
  cache.close();
  writeFileSync(file, JSON.stringify(out));
  console.log(`Wrote public/samples/results.json. Total: ${client.spend.credits} credits.`);
}

main().catch(fail);
