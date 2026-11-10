/**
 * npm run replay -- fixtures/example-labs.json
 *
 * Runs `npm run find` end to end against saved API responses: no key, no network, no credits. The people and labs
 * in the fixtures are made up. Files go to a temporary folder so your own out/ folder is never touched; it is deleted
 * at the end unless you pass --keep. Pass --again to run the same search a second time and see everyone found the
 * first time skipped. Other flags (for example --top 3) are passed on to the run.
 */

import "./node-check.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARF_NO_DOTENV = "1";
// Replay mode: no pacing, and the credit line says what a live run would have used.
process.env.ARF_REPLAY = "1";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => a.endsWith(".json"));
  if (!file) throw new Error("Pass a fixture: npm run replay -- fixtures/example-labs.json");
  let fixture;
  try { fixture = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`Cannot read ${file}: ${(err as Error).message}`); }

  const out = mkdtempSync(join(tmpdir(), "researcher-replay-"));
  process.env.OUT_DIR = out;
  process.env.CRUSTDATA_API_KEY = "offline-replay";
  delete process.env.ANTHROPIC_API_KEY;
  const { fakeFetch } = await import("./fake-api.js");
  globalThis.fetch = fakeFetch(fixture).fetch;
  const { runFind, latestRun, folderFor } = await import("./find.js");

  console.log(`Offline replay of ${file}${fixture.description ? `: ${fixture.description}` : ""}\n`);
  const extra = args.filter(a => a !== file && a !== "--again" && a !== "--keep");
  const mode = fixture.mode === "map" ? "map" : "find";
  try {
    await runFind([...fixture.argv, ...extra], mode);
    if (args.includes("--again")) {
      console.log("\n--- the same search again: everyone above is skipped and not billed ---\n");
      await runFind(["--name", latestRun() ?? "", ...extra], mode);
    }
    const name = latestRun();
    if (name) {
      try { console.log(`\n--- report.md ---\n\n${readFileSync(join(folderFor(name), "report.md"), "utf8")}`); } catch { /* the run stopped before writing */ }
    }
  } finally {
    if (args.includes("--keep")) console.log(`Replay files: ${out}  (offline: nothing was sent, nothing was charged)`);
    else { rmSync(out, { recursive: true, force: true }); console.log("Offline: nothing was sent, nothing was charged. The replay files were deleted (--keep keeps them)."); }
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
