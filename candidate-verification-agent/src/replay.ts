/**
 * npm run replay -- fixtures/mixed-list.json
 *
 * Runs `npm run verify` end to end against saved API responses: no key, no network, no credits, no Slack. Files go
 * to a temporary folder (deleted at the end unless you pass --keep), so your own out/ folder is never touched.
 * Waiting for jobs takes no real time. Other flags (for example --quick or --ai) are passed on to the run.
 */

import "./node-check.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.CVA_NO_DOTENV = "1";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => a.endsWith(".json"));
  if (!file) throw new Error("Pass a fixture: npm run replay -- fixtures/mixed-list.json");
  let fixture;
  try { fixture = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`Cannot read ${file}: ${(err as Error).message}`); }

  const out = mkdtempSync(join(tmpdir(), "verification-replay-"));
  process.env.OUT_DIR = out;
  process.env.CRUSTDATA_API_KEY = "offline-replay";
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.ANTHROPIC_API_KEY;
  const { fakeFetch } = await import("./fake-api.js");
  globalThis.fetch = fakeFetch(fixture).fetch;
  const { clock } = await import("./crustdata.js");
  let now = Date.parse("2026-11-11T12:00:00Z");
  clock.now = () => now;
  clock.sleep = async ms => { now += ms; };
  const { ROOT } = await import("./config.js");
  const { runVerify } = await import("./verify.js");
  const { listName } = await import("./store.js");

  console.log(`Offline replay of ${file}${fixture.description ? `: ${fixture.description}` : ""}\n`);
  const extra = args.filter(a => a !== file && a !== "--keep");
  try {
    await runVerify([resolve(ROOT, fixture.input), ...(fixture.argv ?? []), ...extra, "--yes"]);
    try { console.log(`\n--- report.md ---\n\n${readFileSync(join(out, listName(fixture.input), "report.md"), "utf8")}`); } catch { /* stopped before writing */ }
  } finally {
    if (args.includes("--keep")) console.log(`Replay files: ${join(out, listName(fixture.input))}  (offline: nothing was sent, nothing was charged)`);
    else { rmSync(out, { recursive: true, force: true }); console.log("Offline: nothing was sent, nothing was charged. The replay files were deleted (--keep keeps them)."); }
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
