import { readFileSync } from "node:fs";
import { accountFromEndpoints } from "../lib/account";
import { MemoryCache } from "../lib/cache";
import { DEFAULT_COLUMNS, resolveColumns } from "../lib/columns";
import { createClient } from "../lib/crustdata";
import { readCsv } from "../lib/csv";
import { plan } from "../lib/plan";
import { runPlan, type RunOptions } from "../lib/run";
import { DEFAULT_ENDPOINTS, stubFetch, type Fixture, type StubLog } from "../lib/stub";
import type { RunEvent } from "../lib/events";

export const responses = JSON.parse(readFileSync(new URL("../fixtures/responses.json", import.meta.url), "utf8"));
export const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

export function fakeClient(over: Partial<Fixture> = {}, log: StubLog = []) {
  const fx: Fixture = { responses, invalidEmails: ["not-an-email"], ...over };
  return { client: createClient({ apiKey: "test", fetch: stubFetch(fx, log), sleep: async () => {} }), log };
}

export function fakeAccount(over: Partial<ReturnType<typeof accountFromEndpoints>> = {}) {
  return { ...accountFromEndpoints(DEFAULT_ENDPOINTS, 1000), emailLookup: true as const, ...over };
}

export async function runCsv(csv: string, columnIds: string[] = DEFAULT_COLUMNS, opts: Partial<RunOptions> & { fixture?: Partial<Fixture> } = {}) {
  const detected = readCsv(csv);
  const { columns } = resolveColumns(columnIds);
  const account = opts.account ?? fakeAccount();
  const log: StubLog = [];
  const { client } = fakeClient(opts.fixture, log);
  const p = plan(detected.rows, columns, account);
  const events: RunEvent[] = [];
  const cache = opts.cache ?? new MemoryCache();
  const result = await runPlan(p, { client, cache, account, emit: e => events.push(e), ...opts });
  return { detected, columns, plan: p, result, events, log, cache, client };
}
