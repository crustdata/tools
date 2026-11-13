/** Test helpers: a fresh out/ folder, the fake API from a fixture, and a run of the CLI with captured output. */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CRUSTDATA_API_KEY = "test-key";
process.env.CACHE_DAYS = "7";
process.env.LEAVERS_LIMIT = "25";
process.env.PEERS_LIMIT = "5";
process.env.MAX_CREDITS_PER_RUN = "150";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import { pacing } from "../src/crustdata.js";
import { fakeFetch, type Fixture } from "../src/fake-api.js";
pacing.on = false;

export const NOW = new Date("2026-11-13T12:00:00.000Z");

export function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", name), "utf8"));
}

export function freshOut(): string {
  const dir = mkdtempSync(join(tmpdir(), "pcra-test-"));
  process.env.OUT_DIR = dir;
  return dir;
}

/** Runs the CLI against the fake API; returns the exit code, stderr, stdout and the API calls made. */
export async function runCli(fx: Fixture, argv: string[]) {
  const { fetch, calls } = fakeFetch(fx);
  globalThis.fetch = fetch;
  const { main, DEFAULTS } = await import("../src/cli.js");
  DEFAULTS.now = NOW;
  const err: string[] = [], out: string[] = [];
  const e = process.stderr.write.bind(process.stderr), o = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((s: string) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  try {
    const code = await main(argv);
    return { code, stderr: err.join(""), stdout: out.join(""), calls };
  } finally {
    process.stderr.write = e;
    process.stdout.write = o;
  }
}
