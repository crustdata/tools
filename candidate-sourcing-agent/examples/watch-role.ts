/**
 * npm run watch-example: keep sourcing a role every week, done by Crustdata, not by this repo.
 *
 * Writes the request body for a Crustdata person discovery watcher over the same filters as your role, plus a title
 * filter (watchers take filters only, not the plain-English query), and prints the curl that creates it. This file
 * sends nothing and creates nothing. Once you send it, Crustdata re-runs the filters on a schedule and delivers the
 * people whose profiles newly match or changed since the last run to Slack, email or a webhook. You can also build
 * the same watcher at https://app.crustdata.com/watch.
 *
 * What it does not do: use seen.csv (people you already sourced can be delivered again when their profile changes),
 * rank by the sentence, or score. For the ranked, de-duplicated batch, run npm run source weekly instead.
 *
 * Price at list: the first run is a free baseline (a sample of up to 5 people); after that 0.5 credits per person
 * delivered, never for a run that finds nobody. Docs: https://docs.crustdata.com/watcher-docs/person/discovery
 */

import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { and, type Filter } from "../src/crustdata.js";
import { buildConditions, lastRole, loadRole, roleDir, slugify, titleFilter, writeFileSafe, type RoleSpec } from "../src/role.js";

type Channel = { type: "slack"; webhook_url: string } | { type: "email"; to: string[] } | { type: "webhook"; url: string };

export function watchBody(spec: RoleSpec, channels: Channel[], opts: { everyDays?: number; perRun?: number } = {}) {
  const conditions = buildConditions(spec).map(c => c.filter);
  // Without the ranking query, the title is what keeps a weekly feed on the role.
  if (spec.title && !spec.titleStrict) conditions.push(titleFilter(spec.title));
  const filters: Filter = and(...conditions);
  return {
    filters,
    fields: ["basic_profile", "experience.employment_details.current", "skills", "social_handles"],
    config: { trigger: { type: "interval", every_hours: 24 * (opts.everyDays ?? 7) }, max_results_per_run: opts.perRun ?? 50 },
    notifications: channels,
  };
}

function parse(argv: string[]) {
  const out: { name?: string; channels: Channel[]; everyDays?: number; perRun?: number } = { channels: [] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = inline ?? argv[++i];
    if (!value) throw new Error(`${flag} needs a value.`);
    if (flag === "--slack") {
      if (!/^https:\/\/hooks\.slack\.com\/services\//.test(value)) throw new Error("--slack takes a Slack incoming webhook URL, starting with https://hooks.slack.com/services/");
      out.channels.push({ type: "slack", webhook_url: value });
    } else if (flag === "--email") out.channels.push({ type: "email", to: value.split(",").map(s => s.trim()).filter(Boolean) });
    else if (flag === "--webhook") out.channels.push({ type: "webhook", url: value });
    else if (flag === "--name") out.name = slugify(value) || (() => { throw new Error("--name needs letters or numbers."); })();
    else if (flag === "--every-days") out.everyDays = Number(value);
    else if (flag === "--per-run") out.perRun = Number(value);
    else throw new Error(`Unknown flag ${flag}. Flags: --slack <webhook URL>, --email <addresses>, --webhook <URL>, --name <role>, --every-days N, --per-run N`);
  }
  if (out.everyDays !== undefined && !(Number.isInteger(out.everyDays) && out.everyDays >= 1)) throw new Error("--every-days takes a whole number of days, 1 or more.");
  if (out.perRun !== undefined && !(Number.isInteger(out.perRun) && out.perRun >= 1 && out.perRun <= 1000)) throw new Error("--per-run takes a whole number from 1 to 1000.");
  return out;
}

export async function runWatchExample(argv: string[]): Promise<void> {
  const flags = parse(argv);
  const name = flags.name ?? lastRole();
  const saved = name ? loadRole(name) : undefined;
  if (!name || !saved) throw new Error("No saved role yet. Run npm run source first; the watcher uses the same filters.");
  const body = watchBody(saved.spec, flags.channels, flags);
  const dir = roleDir(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "watch-request.json");
  // Owner-only: it can hold a Slack webhook URL.
  writeFileSafe(file, JSON.stringify(body, null, 2) + "\n");
  const shown = relative(process.cwd(), file);
  const perRun = body.config.max_results_per_run;
  console.log(`Wrote the Crustdata watcher request for ${name} to ${shown}. Nothing was sent or created.

It finds people whose profiles newly match the role's filters${saved.spec.title ? ` and its title ("${saved.spec.title}", any level)` : ""}, or changed since the last run,
every ${body.config.trigger.every_hours / 24} days, and delivers up to ${perRun} a run to ${flags.channels.length ? flags.channels.map(c => c.type).join(" and ") : "no channel (read the runs with the API; add --slack, --email or --webhook)"}.
It does not use seen.csv or the score: people you already sourced can come again when their profile changes.
Cost at list price: the first run is a free sample of up to 5 people, then 0.5 credits per person delivered
(at most ${perRun * 0.5} credits a run), and nothing for a run with nobody to deliver.

To create it (the first line loads your key from .env into this terminal):

  set -a; . ./.env; set +a
  curl --request POST https://api.crustdata.com/watch/person/search \\
    --header "authorization: Bearer $CRUSTDATA_API_KEY" \\
    --header "content-type: application/json" \\
    --header "x-api-version: 2025-11-01" \\
    --data @${/\s/.test(shown) ? JSON.stringify(shown) : shown}

The response has the watcher's id. Pause it with PATCH /watch/person/search/<id> and { "status": "paused" },
cancel it with DELETE /watch/person/search/<id>. Or set it up in the dashboard: https://app.crustdata.com/watch`);
}
