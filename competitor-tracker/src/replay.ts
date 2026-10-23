/**
 * `npm run replay -- fixtures/<name>.json`: runs one weekly digest fully offline against a fixture (no Crustdata calls,
 * in-memory state, nothing sent) and prints the digest. `--slack` also prints the Slack payload as JSON.
 */

import "./node-check.js";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";
import { fixtureApi, fixtureCompetitors, loadFixture, storeFromFixture } from "./fixture-api.js";
import { loadKeywords } from "./posts.js";
import { runDigest } from "./run.js";
import { digestMessages } from "./slack.js";

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("-"));
if (!file) {
  const list = readdirSync(resolve(ROOT, "fixtures")).filter(f => f.endsWith(".json")).map(f => `  fixtures/${f}`).join("\n");
  console.log(`Usage: npm run replay -- fixtures/<name>.json [--slack]\n\nFixtures:\n${list}`);
  process.exit(1);
}

process.env.SLACK_WEBHOOK_URL = "";
process.env.RESEND_API_KEY = "";

const path = resolve(process.cwd(), file);
if (!existsSync(path)) {
  const list = readdirSync(resolve(ROOT, "fixtures")).filter(f => f.endsWith(".json")).map(f => `  npm run replay -- fixtures/${f}`).join("\n");
  console.error(`No fixture at ${file}. Try one of:\n${list}`);
  process.exit(1);
}
let run: Awaited<ReturnType<typeof runDigest>>;
let fixture: ReturnType<typeof loadFixture>;
try {
  fixture = loadFixture(path);
  const store = storeFromFixture(fixture);
  run = await runDigest(
    { store, competitors: fixtureCompetitors(fixture), keywords: loadKeywords(), api: fixtureApi(fixture), now: fixture.now ? new Date(fixture.now) : new Date(), log: s => console.error(s) },
    { send: false, writeFile: false, dryRun: true },
  );
  store.close();
} catch (err) {
  console.error(`Could not replay ${file}: ${(err as Error).message}`);
  process.exit(1);
}
const result = run;
if (fixture.description) console.log(`(${fixture.description})\n`);
console.log(result.markdown);
if (args.includes("--slack")) console.log(JSON.stringify(digestMessages(result.digest), null, 2));
