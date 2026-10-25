/**
 * npm run replay -- fixtures/meeting.json
 *
 * Runs `npm run research` end to end against saved API answers: no key, no network, no credits. Files go to a
 * temporary folder (deleted at the end unless you pass --keep), so your own out/ folder is never touched. Other
 * flags (for example --posts 2 or --json) are passed on to the run. The people in the fixtures are made up.
 */

import "./node-check.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PR_NO_DOTENV = "1";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => a.endsWith(".json"));
  if (!file) throw new Error("Pass a fixture: npm run replay -- fixtures/meeting.json (or single-email.json, name-pick.json)");
  let fixture;
  try { fixture = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`Cannot read ${file}: ${(err as Error).message}`); }

  const out = mkdtempSync(join(tmpdir(), "person-replay-"));
  process.env.OUT_DIR = out;
  process.env.CACHE_HOURS = "0";
  process.env.SKIP_DOMAINS = "";
  process.env.PR_REPLAY = "1";
  if (!args.includes("--keep")) process.env.PR_REPLAY_QUIET = "1";
  process.env.CRUSTDATA_API_KEY = "offline-replay";
  const { fakeFetch } = await import("./fake-api.js");
  const { pacing } = await import("./crustdata.js");
  pacing.on = false;
  globalThis.fetch = fakeFetch(fixture).fetch;
  const { DEFAULTS } = await import("./research.js");
  if (fixture.now) DEFAULTS.now = new Date(fixture.now);
  const { main: run } = await import("./cli.js");

  process.stderr.write(`Offline replay of ${file}${fixture.description ? `: ${fixture.description}` : ""}\n\n`);
  const extra = args.filter(a => a !== file && a !== "--keep");
  try {
    process.exitCode = await run([...fixture.argv, ...extra]);
    if (!args.includes("--json") && (fixture.argv.length > 1 || fixture.argv.includes("--file"))) {
      try { console.log(`\n--- index.md ---\n\n${readFileSync(join(out, "index.md"), "utf8")}`); } catch { /* one person, no index */ }
    }
  } finally {
    if (args.includes("--keep")) process.stderr.write(`Replay files: ${out}  (offline: nothing was sent, nothing was charged)\n`);
    else { rmSync(out, { recursive: true, force: true }); process.stderr.write("Offline: nothing was sent, nothing was charged. The replay files were deleted (--keep keeps them).\n"); }
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
