/**
 * Configuration. Every setting comes from environment variables, read from `.env` in this folder when it exists
 * (never under tests, and never when DSA_NO_DOTENV=1). See `.env.example` for the full list with comments.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** The project folder (the one with package.json), wherever the command is run from. */
export const projectDir = fileURLToPath(new URL("..", import.meta.url));

const envFile = join(projectDir, ".env");
const underTest = !!process.env.NODE_TEST_CONTEXT || process.env.DSA_NO_DOTENV === "1";
if (!underTest && existsSync(envFile)) process.loadEnvFile(envFile);

const env = (name: string, fallback = ""): string => process.env[name] || fallback;

export const config = {
  /** Crustdata API key. Needed by `npm run source`; `memo` and `replay` run without it. */
  get crustdataApiKey(): string {
    const key = env("CRUSTDATA_API_KEY");
    if (!key) throw new Error("CRUSTDATA_API_KEY is not set. Run npm run setup, or copy .env.example to .env and fill it in.");
    return key;
  },

  /** Where the pipeline, memos and saved data go. One folder per thesis when you run several (or pass --out). */
  get outDir(): string { return env("OUT_DIR", "./out"); },

  /** The closing line that points at Crustdata watchers. WATCH_HINT=false (or --no-watch-hint) turns it off. */
  get watchHint(): boolean { return !["false", "0", "no", "off"].includes(env("WATCH_HINT", "true").toLowerCase()); },

  /** Optional AI analysis in each memo, only with --ai. Either key works; Anthropic is used when both are set. */
  get anthropicApiKey(): string { return env("ANTHROPIC_API_KEY"); },
  get openaiApiKey(): string { return env("OPENAI_API_KEY"); },
  /** Pin a model. Empty: the newest general model the key can use, read from the provider's model list. */
  get anthropicModel(): string { return env("ANTHROPIC_MODEL"); },
  get openaiModel(): string { return env("OPENAI_MODEL"); },
};

/** Files in the output folder. */
export const paths = {
  thesis: () => join(config.outDir, "thesis.json"),
  data: () => join(config.outDir, "data.json"),
  history: () => join(config.outDir, "history.json"),
  pipelineCsv: () => join(config.outDir, "pipeline.csv"),
  foundersCsv: () => join(config.outDir, "founders.csv"),
  pipelineMd: () => join(config.outDir, "pipeline.md"),
  memos: () => join(config.outDir, "memos"),
};

/** The prompt the optional AI analysis uses. Edit the file; no code change needed. */
export const promptPath = join(projectDir, "prompts", "memo-analysis.md");
