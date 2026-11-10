/**
 * npm run replay -- fixtures/hunt-sf.json
 *
 * Runs `npm run hunt` (or `npm run job`) end to end against saved answers: no key, no network, no credits. Files
 * go to a temporary folder (deleted at the end unless you pass --keep) and the database is in memory, so your own
 * out/ and data/ are never touched. Other flags (for example --top 3 or --json) are passed on to the run. Every
 * company and person in the fixtures is made up.
 */

import "./node-check.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JHA_NO_DOTENV = "1";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => a.endsWith(".json"));
  if (!file) throw new Error("Pass a fixture: npm run replay -- fixtures/hunt-sf.json (or fixtures/one-job.json)");
  let fixture;
  try { fixture = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`Cannot read ${file}: ${(err as Error).message}`); }

  const out = mkdtempSync(join(tmpdir(), "job-hunt-replay-"));
  process.env.OUT_DIR = out;
  process.env.DB_PATH = ":memory:";
  process.env.PROFILE_PATH = join(out, "no-profile.json");
  process.env.CACHE_DAYS = "14";
  process.env.CRUSTDATA_API_KEY = "offline-replay";
  process.env.JHA_REPLAY = args.includes("--keep") ? "keep" : "1";
  if (fixture.now) process.env.JHA_NOW = fixture.now;
  const { fakeFetch } = await import("./fake-api.js");
  const { pacing } = await import("./crustdata.js");
  pacing.on = false;
  globalThis.fetch = fakeFetch(fixture).fetch;
  const { main: run, explain } = await import("./cli.js");

  process.stderr.write(`Offline replay of ${file}${fixture.description ? `: ${fixture.description}` : ""}\n\n`);
  const extra = args.filter(a => a !== file && a !== "--keep");
  try {
    process.exitCode = await run([...fixture.argv, ...extra]);
    if (!args.includes("--json")) {
      const { readdirSync } = await import("node:fs");
      const dir = readdirSync(out).find(d => !d.endsWith(".json"));
      if (dir) console.log(`\n--- report.md ---\n\n${readFileSync(join(out, dir, "report.md"), "utf8")}`);
    }
  } catch (err) {
    console.error(explain(err));
    process.exitCode = 1;
  } finally {
    if (args.includes("--keep")) process.stderr.write(`\nReplay files: ${out}  (offline: nothing was sent, nothing was charged)\n`);
    else { rmSync(out, { recursive: true, force: true }); process.stderr.write("\nOffline: nothing was sent, nothing was charged. The replay files were deleted (--keep keeps them).\n"); }
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
