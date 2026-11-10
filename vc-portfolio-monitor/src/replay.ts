/**
 * `npm run replay -- fixtures/<name>.json`: one daily check and one weekly digest, fully offline against a fixture (no
 * Crustdata calls, in-memory state, nothing sent). Prints the alerts as they would post and the digest. `--slack` also
 * prints the Slack payloads as JSON.
 */

import "./node-check.js";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";
import { digestMarkdown } from "./digest.js";
import { fixtureApi, loadFixture, storeFromFixture } from "./fixture-api.js";
import { runCheck, runDigest } from "./run.js";
import { alertMessages, digestMessages } from "./slack.js";
import { loadThresholds } from "./thresholds.js";
import { SEVERITY_LABEL } from "./types.js";

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("-"));
const list = () => readdirSync(resolve(ROOT, "fixtures")).filter(f => f.endsWith(".json")).map(f => `  npm run replay -- fixtures/${f}`).join("\n");
if (!file) { console.log(`Usage: npm run replay -- fixtures/<name>.json [--slack]\n\nFixtures:\n${list()}`); process.exit(1); }
const path = resolve(process.cwd(), file);
if (!existsSync(path)) { console.error(`No fixture at ${file}. Try one of:\n${list()}`); process.exit(1); }

process.env.SLACK_WEBHOOK_URL = "";
process.env.RESEND_API_KEY = "";

try {
  const fixture = loadFixture(path);
  const store = storeFromFixture(fixture);
  const now = fixture.now ? new Date(fixture.now) : new Date();
  const ctx = { store, api: fixtureApi(fixture), thresholds: loadThresholds(), now, log: (s: string) => console.error(s) };
  const check = await runCheck(ctx);
  if (fixture.description) console.log(`(${fixture.description})\n`);
  console.log(`# Daily check, ${now.toISOString().slice(0, 10)}: what posts to Slack right away\n`);
  for (const w of check.warnings) console.log(`! ${w}`);
  // What the real check would post: everything new and not posted yet, including a starting-point alert from import.
  const instant = store.unposted();
  if (!instant.length) console.log("Nothing to post.");
  for (const s of instant) console.log(`- ${SEVERITY_LABEL[s.severity]}: ${s.company}: ${s.text}.${s.why ? ` ${s.why}` : ""}`);
  const digest = await runDigest({ ...ctx, now: new Date(now.getTime() + 60_000) });
  console.log(`\n${digestMarkdown(digest.digest)}`);
  if (args.includes("--slack")) console.log(JSON.stringify({ alerts: alertMessages(instant), digest: digestMessages(digest.digest) }, null, 2));
  store.close();
} catch (err) {
  console.error(`Could not replay ${file}: ${(err as Error).message}`);
  process.exit(1);
}
