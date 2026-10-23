/**
 * npm run replay -- fixtures/ml-engineer.json
 *
 * Runs `npm run source` end to end against saved API responses: no key, no network, no credits. Files are written to
 * a temporary folder so your own out/ folder is never touched; it is deleted at the end unless you pass --keep. Pass
 * --again to run the same role a second time and see the seen list skip everyone from the first run. Other flags
 * (for example --top 3) are passed on to the run.
 */

import "./node-check.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CSA_NO_DOTENV = "1";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => a.endsWith(".json"));
  if (!file) throw new Error("Pass a fixture: npm run replay -- fixtures/ml-engineer.json");
  let fixture;
  try { fixture = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`Cannot read ${file}: ${(err as Error).message}`); }

  const out = mkdtempSync(join(tmpdir(), "candidate-replay-"));
  process.env.OUT_DIR = out;
  process.env.CRUSTDATA_API_KEY = "offline-replay";
  const { fakeFetch } = await import("./fake-api.js");
  globalThis.fetch = fakeFetch(fixture).fetch;
  const { runSource } = await import("./source.js");

  console.log(`Offline replay of ${file}${fixture.description ? `: ${fixture.description}` : ""}\n`);
  // Extra flags (for example --top 3) are passed on to both runs.
  const extra = args.filter(a => a !== file && a !== "--again" && a !== "--keep");
  try {
    await runSource([...fixture.argv, ...extra, "--yes"]);
    const { lastRole, roleDir } = await import("./role.js");
    if (args.includes("--again")) {
      console.log("\n--- the same role again: the seen list skips everyone above ---\n");
      await runSource(["--name", lastRole() ?? "", ...extra, "--yes"]);
    }
    const name = lastRole();
    if (name) {
      try {
        console.log(`\n--- shortlist.md ---\n\n${readFileSync(join(roleDir(name), "shortlist.md"), "utf8")}`);
      } catch { /* the run stopped before writing a shortlist */ }
    }
  } finally {
    if (args.includes("--keep")) console.log(`Replay files: ${out}  (offline: nothing was sent, nothing was charged)`);
    else { rmSync(out, { recursive: true, force: true }); console.log("Offline: nothing was sent, nothing was charged. The replay files were deleted (--keep keeps them)."); }
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
