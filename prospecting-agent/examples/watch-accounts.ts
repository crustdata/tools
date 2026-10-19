/**
 * npm run watch-example: the Crustdata watcher request for the accounts in out/accounts.csv. It sends nothing.
 *
 * Watching is done by Crustdata, not by this repo: a watcher re-checks your accounts on a schedule and posts what
 * changed straight to Slack, Google Chat or email. There is no server to run. This script only writes the request
 * body for your shortlist, so you can create the watcher yourself with one curl, or copy the company ids into the
 * Crustdata dashboard at https://app.crustdata.com/watch.
 *
 *   npm run watch-example -- --slack https://hooks.slack.com/services/...      deliver to a Slack channel
 *   npm run watch-example -- --email you@company.com                           or to email (both is fine)
 *   npm run watch-example -- --job-keywords "RevOps, Salesforce admin"         also a job watcher for those roles
 *
 * Docs: https://docs.crustdata.com/watcher-docs/company/entity (company changes)
 *       https://docs.crustdata.com/watcher-docs/job/watch (new job posts)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";
import { parseCsv } from "../src/csv.js";

const SLACK_PLACEHOLDER = "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK";
/** How often the watchers check, and the most one check may deliver, so a busy day has a known ceiling in credits. */
const EVERY_HOURS = 24;
const MAX_COMPANY_CHANGES_PER_RUN = 300;
const MAX_JOBS_PER_RUN = 100;

export type Channel = { type: "slack"; webhook_url: string } | { type: "email"; to: string[] };

/** The company ids in accounts.csv ("crustdata id" column). Rows you deleted are left out. */
export function shortlistIds(csv: string): number[] {
  const [header, ...rows] = parseCsv(csv);
  const col = header?.indexOf("crustdata id") ?? -1;
  if (col < 0) throw new Error('accounts.csv has no "crustdata id" column. Run npm run find to write it again.');
  return [...new Set(rows.map(r => Number(r[col])).filter(n => Number.isInteger(n) && n > 0))];
}

/**
 * Company entity watcher: fires when an account's headcount, last funding round, open roles or news changes.
 * Drop the headcount line if every hire and exit is more than you want to hear about (each fire is billed).
 */
export function companyWatchBody(companyIds: number[], notifications: Channel[]) {
  return {
    entities: { crustdata_company_ids: companyIds },
    track: {
      op: "or",
      conditions: [
        { field: "headcount.total", type: "changed" },
        { field: "funding.last_round_type", type: "changed" },
        { field: "hiring.openings_count", type: "changed" },
        { field: "news", type: "added" },
      ],
    },
    fields: ["basic_info", "headcount", "funding", "hiring", "news"],
    config: { trigger: { type: "interval", every_hours: EVERY_HOURS }, max_results_per_run: MAX_COMPANY_CHANGES_PER_RUN },
    notifications,
  };
}

/** Job watcher: new job posts at the accounts whose title or description has one of the phrases. */
export function jobWatchBody(companyIds: number[], phrases: string[], notifications: Channel[]) {
  return {
    filters: {
      op: "and",
      conditions: [
        { field: "company.basic_info.company_id", type: "in", value: companyIds },
        { op: "or", conditions: phrases.flatMap(p => [{ field: "job_details.title", type: "[.]", value: p }, { field: "content.description", type: "[.]", value: p }]) },
      ],
    },
    fields: ["job_details", "company.basic_info", "location", "metadata"],
    sorts: [{ field: "metadata.date_added", order: "desc" }],
    config: { trigger: { type: "interval", every_hours: EVERY_HOURS }, max_results_per_run: MAX_JOBS_PER_RUN },
    notifications,
  };
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`--${name} needs a value.`);
  return v;
}

const curl = (path: string, file: string) => [
  `curl -X POST https://api.crustdata.com${path} \\`,
  `  -H "authorization: Bearer $CRUSTDATA_API_KEY" -H "content-type: application/json" -H "x-api-version: 2025-11-01" \\`,
  `  --data @${file}`,
].join("\n");

export async function runWatchExample(args: string[]): Promise<void> {
  const known = ["--slack", "--email", "--job-keywords"];
  const unknown = args.filter((a, i) => a.startsWith("--") && !known.includes(a) && !known.includes(args[i - 1]));
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(", ")}. Use --slack, --email and --job-keywords.`);

  const csvPath = join(config.outDir, "accounts.csv");
  if (!existsSync(csvPath)) throw new Error(`No ${csvPath} yet. Run npm run find first.`);
  const ids = shortlistIds(readFileSync(csvPath, "utf8"));
  if (!ids.length) throw new Error(`${csvPath} has no accounts.`);

  const slack = option(args, "slack");
  if (slack && !/^https:\/\/hooks\.slack\.com\//.test(slack)) throw new Error("--slack takes a Slack incoming webhook URL (https://hooks.slack.com/...).");
  const emails = (option(args, "email") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const channels: Channel[] = [];
  if (slack || !emails.length) channels.push({ type: "slack", webhook_url: slack ?? SLACK_PLACEHOLDER });
  if (emails.length) channels.push({ type: "email", to: emails });
  const phrases = (option(args, "job-keywords") ?? "").split(",").map(s => s.trim()).filter(Boolean);

  mkdirSync(config.outDir, { recursive: true });
  const companyFile = join(config.outDir, "watch-company.json");
  writeFileSync(companyFile, JSON.stringify(companyWatchBody(ids, channels), null, 2) + "\n");
  const jobFile = join(config.outDir, "watch-jobs.json");
  if (phrases.length) writeFileSync(jobFile, JSON.stringify(jobWatchBody(ids, phrases, channels), null, 2) + "\n");

  console.log(`Watcher request for the ${ids.length} ${ids.length === 1 ? "account" : "accounts"} in ${csvPath}. Nothing was sent and nothing was billed.\n`);
  if (!slack && !emails.length) console.log(`Put your Slack webhook in ${companyFile} (or run again with --slack <url> or --email <address>).\n`);
  console.log(`Company changes (headcount, funding round, open roles, news), checked every ${EVERY_HOURS}h:\n\n${curl("/watch/company", companyFile)}\n`);
  if (phrases.length) console.log(`New job posts mentioning ${phrases.join(" or ")}:\n\n${curl("/watch/job/search", jobFile)}\n`);
  else console.log('Add --job-keywords "RevOps, Salesforce admin" to also get a job watcher for the roles that signal a need.\n');
  console.log(`Cost: 5 credits per account that changes${phrases.length ? " and 0.5 per new job post" : ""}, at most ${Math.min(ids.length, MAX_COMPANY_CHANGES_PER_RUN) * 5 + (phrases.length ? MAX_JOBS_PER_RUN * 0.5 : 0)} a day at list price (max_results_per_run in the file caps it).`);
  console.log("Crustdata posts each change to your channel itself; you run nothing after this.");
  console.log("Set it up yourself: run the curl above, or use the Crustdata dashboard at https://app.crustdata.com/watch.");
  console.log("Docs: https://docs.crustdata.com/watcher-docs/company/entity and https://docs.crustdata.com/watcher-docs/job/watch");
}
