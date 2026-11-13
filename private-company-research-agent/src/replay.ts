/**
 * npm run replay -- fixtures/fast-grower.json
 *
 * Runs `npm run research` end to end against saved API answers: no key, no network, no credits. Files go to a
 * temporary folder (deleted at the end unless you pass --keep), so your own out/ folder is never touched. Other flags
 * (for example --no-peers or --json) are passed on to the run. The companies and people in the fixtures are made up.
 */

import "./node-check.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.PCRA_NO_DOTENV = "1";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => a.endsWith(".json"));
  if (!file) throw new Error("Pass a fixture: npm run replay -- fixtures/fast-grower.json (or struggling.json, sparse.json, inbound-deals.json)");
  let fixture;
  try { fixture = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`Cannot read ${file}: ${(err as Error).message}`); }

  const out = mkdtempSync(join(tmpdir(), "pcra-replay-"));
  process.env.OUT_DIR = out;
  process.env.CACHE_DAYS = "0";
  process.env.LEAVERS_LIMIT = "25";
  process.env.PEERS_LIMIT = "5";
  process.env.MAX_CREDITS_PER_RUN = "0";
  process.env.CRUSTDATA_API_KEY = "offline-replay";
  const { ROOT } = await import("./config.js");
  const { fakeFetch } = await import("./fake-api.js");
  const { pacing } = await import("./crustdata.js");
  pacing.on = false;
  globalThis.fetch = fakeFetch(fixture).fetch;
  const { main: run, DEFAULTS } = await import("./cli.js");
  if (fixture.now) DEFAULTS.now = new Date(fixture.now);

  process.stderr.write(`Offline replay of ${file}${fixture.description ? `: ${fixture.description}` : ""}\n\n`);
  // A list file in a fixture is named relative to the project folder.
  const argv = (fixture.argv as string[]).map(a => (/\.(csv|txt|tsv)$/i.test(a) ? resolve(ROOT, a) : a));
  const extra = args.filter(a => a !== file && a !== "--keep");
  try {
    process.exitCode = await run([...argv, ...extra]);
    if (!extra.includes("--json")) {
      for (const d of readdirSync(out, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith(".")) continue;
        for (const name of ["comparison.md", "memo.md"]) {
          try { console.log(`\n--- ${d.name}/${name} ---\n\n${readFileSync(join(out, d.name, name), "utf8")}`); } catch { /* not this kind of folder */ }
        }
      }
    }
  } finally {
    if (args.includes("--keep")) process.stderr.write(`Replay files: ${out}  (offline: nothing was sent, nothing was charged)\n`);
    else { rmSync(out, { recursive: true, force: true }); process.stderr.write("Offline: nothing was sent, nothing was charged. The replay files were deleted (--keep keeps them).\n"); }
  }
}

import { isEntryPoint } from "./entry.js";
if (isEntryPoint(import.meta.url)) main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
