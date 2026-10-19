/**
 * Configuration. Every setting comes from environment variables, read from `.env` when that file exists.
 * See `.env.example` for the full list with comments.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (name: string, fallback = ""): string => process.env[name] || fallback;

export const config = {
  /** Crustdata API key. Needed by `npm run find`; `npm run watch-example` runs without it. */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Copy .env.example to .env and fill it in.");
    return key;
  },

  /** Where `npm run find` writes accounts.csv, people.csv and icp.json. One folder per client when you run several. */
  outDir: env("OUT_DIR", "./out"),

  /** Optional: Claude reads the ICP sentence. Off when ANTHROPIC_API_KEY is empty. */
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL", "claude-opus-5"),
};

/** The saved ICP: the spec and the exact filters of the last run, next to the CSVs it produced. */
export const icpPath = (): string => join(config.outDir, "icp.json");
