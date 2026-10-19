/**
 * `npm run replay -- fixtures/job-change.json`: show the alert a saved notification produces, fully offline.
 * Uses a throwaway in-memory database and prints instead of posting, so nothing reaches your list, your Slack
 * channel or your digest. Add --slack to post the alerts to SLACK_WEBHOOK_URL.
 */

import "./node-check.js";
import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--"));
const toSlack = args.includes("--slack");
if (!file || !existsSync(file)) {
  console.error(`Usage: npm run replay -- fixtures/job-change.json [--slack]${file ? `\nFile not found: ${file}` : ""}`);
  process.exit(1);
}

process.env.DB_PATH = ":memory:";
process.env.ALERT_MODE = "realtime";
if (!toSlack) { process.env.SLACK_WEBHOOK_URL = ""; process.env.SLACK_ROUTES = ""; }

const handle: typeof import("./handle.js") = await import("./handle.js");
const { toJobChanges, isBaselineOrTest }: typeof import("./notification.js") = await import("./notification.js");
const { jobChangeMessage }: typeof import("./slack.js") = await import("./slack.js");
const { config }: typeof import("./config.js") = await import("./config.js");

const body = JSON.parse(readFileSync(file, "utf8"));
handle.validateNotification(body);
if (body.metadata.test || isBaselineOrTest(body)) {
  console.log(`${file}: ${body.metadata.test ? "a test notification" : "a baseline run"}, which never produces alerts.`);
  process.exit(0);
}

const plain = (s: string) => s.replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/\*/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const results = body.results ?? [];
const changes = toJobChanges(body.metadata.watch_id, body.metadata.run_id, results);
const withChanges = results.filter((r: { changes?: unknown[] }) => Array.isArray(r?.changes) && r.changes.length).length;
if (changes.length < withChanges) console.log(`\n[no alert] ${withChanges - changes.length} result(s) had a change not worth an alert, for example a side role ending while the main role continues.`);

for (const change of changes) {
  if (change.kind === "title_edit") { console.log(`\n[title_edit] never alerted: only the case or punctuation of the title changed.`); continue; }
  const alerted = config.alertKinds.includes(change.kind);
  console.log(`\n[${change.kind}] ${alerted ? "would be alerted" : `would be stored but not alerted (add ${change.kind} to ALERT_KINDS to be told)`}`);
  const msg = jobChangeMessage(change);
  const blocks = msg.blocks as { text?: { text: string }; elements?: { text: string }[] }[];
  for (const line of blocks[0].text!.text.split("\n")) console.log(`  ${plain(line)}`);
  console.log(`  ${plain(blocks[1].elements![0].text)}`);
}

if (toSlack) {
  await handle.handleNotification(body, { checkWatchId: false });
  console.log(`\nPosted ${await handle.deliverPending()} alert(s) to Slack.`);
} else {
  console.log("\nOffline: nothing was posted or saved. Add --slack to post the alerts.");
}
