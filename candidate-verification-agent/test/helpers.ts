/** Shared test setup: an offline Crustdata, a virtual clock, a temporary output folder. */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clock, spend } from "../src/crustdata.js";
import { ROOT } from "../src/config.js";
import { fakeFetch, type Fixture } from "../src/fake-api.js";

export const fixture = (name: string): Fixture => JSON.parse(readFileSync(resolve(ROOT, "fixtures", name), "utf8"));
export const example = (name: string) => resolve(ROOT, "examples", name);

/** Installs the fake API and a clock that never really waits. Returns the calls made and the output folder. */
export function offline(fx: Fixture, extra?: (url: URL, init?: RequestInit) => Response | undefined) {
  const out = mkdtempSync(join(tmpdir(), "cva-test-"));
  process.env.OUT_DIR = out;
  process.env.CRUSTDATA_API_KEY = "test-key";
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.ANTHROPIC_API_KEY;
  let now = Date.parse("2026-11-11T12:00:00Z");
  clock.now = () => now;
  clock.sleep = async ms => { now += ms; };
  clock.serverOffset = 0;
  const fake = fakeFetch(fx);
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    return extra?.(url, init) ?? fake.fetch(input, init);
  }) as typeof fetch;
  spend.credits = 0;
  return { out, calls: fake.calls, count: (path: string) => fake.calls.filter(c => c.path === path).length };
}

/** Captures console.log output while running fn. */
export async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try { return { result: await fn(), output: lines.join("\n") }; }
  finally { console.log = log; }
}
