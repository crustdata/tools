// Shared by every script: Node version check, .env loading, the key, and plain-English failures.

import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node ${process.versions.node} is too old. This tool needs Node 22.13 or newer (https://nodejs.org).`);
  process.exit(1);
}

// .env is read by hand so a file saved with a BOM (Notepad, Excel) still works, and existing variables win.
if (!process.env.CLAY_NO_DOTENV && existsSync(resolve(ROOT, ".env"))) {
  const parsed = parseEnv(readFileSync(resolve(ROOT, ".env"), "utf8").replace(/^\ufeff/, ""));
  for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v;
}

export function apiKey(): string {
  const key = process.env.CRUSTDATA_API_KEY?.trim();
  if (!key) {
    console.error("CRUSTDATA_API_KEY is not set. Copy .env.example to .env and paste your key from https://app.crustdata.com, or export it in your shell.");
    process.exit(1);
  }
  return key;
}

/** --name value and --flag parsing, plus positionals. */
export function parseArgs(argv: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[k] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

/** A numeric flag: present with a whole or decimal number, or absent. "--limit" alone and "--limit abc" are errors. */
export function numberFlag(flags: Record<string, string | true>, name: string, { integer = false, min = 0 } = {}): number | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  const n = v === true ? NaN : Number(v);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min) fail(new Error(`--${name} needs a ${integer ? "whole " : ""}number${min ? ` of at least ${min}` : ""} (got ${v === true ? "nothing" : v}).`));
  return n;
}

export function fail(err: unknown): never {
  console.error((err as Error).message ?? String(err));
  process.exit(1);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Fixed-width table for the terminal. */
export function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => (r[i] ?? "").length)));
  return rows.map(r => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}
