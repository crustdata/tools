/**
 * npm run watch-example: know when a researcher you found changes jobs, done by Crustdata, not by this repo.
 *
 * Writes the request body for a Crustdata person watcher over the profile URLs of the people in one search folder
 * (out/<name>/people.json), and prints the curl that creates it. This file sends nothing and creates nothing. Once
 * you send it, Crustdata checks those people on a schedule and tells you (email, Slack or a webhook) when one starts
 * at a new employer. A promotion at the same employer stays silent (the current role is keyed on the employer). You
 * can also build the same watcher at https://app.crustdata.com/watch.
 *
 * Price at list: the first run is a free baseline; after that, 5 credits per watched person whose tracked role
 * changed on a run, with profiles refreshed every 30 days (the setting below), so a move can show up to about a month
 * late; a 7-day refresh is 20 credits per change.
 * Docs: https://docs.crustdata.com/watcher-docs/person/entity
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../src/csv.js";
import { slugify } from "../src/args.js";
import { folderFor, latestRun, shown } from "../src/find.js";
import { profileUrlOf } from "../src/profile.js";
import type { Found } from "../src/rubric.js";

type Channel = { type: "slack"; webhook_url: string } | { type: "email"; to: string[] } | { type: "webhook"; url: string };

/** Job moves: a current role at an employer new to the watch. Keyed on the employer, so a promotion does not fire. */
export const JOB_MOVE_TRACK = { field: "experience.employment_details.current", type: "added", keys: ["crustdata_company_id", "name"] };

export function watchBody(profileUrls: string[], channels: Channel[], refreshDays = 30) {
  return {
    entities: { professional_network_profile_urls: profileUrls.slice(0, 10_000) },
    track: JOB_MOVE_TRACK,
    fields: ["basic_profile", "experience", "social_handles"],
    // One alert per watched person per run at most (the API default is 25 a run, which would cut off a team move).
    // Above 1,000 results a run, Crustdata delivers a link to the results file instead of the results inline.
    config: { trigger: { type: "interval", every_hours: 24 }, refresh_frequency_days: refreshDays, max_results_per_run: Math.max(1, Math.min(profileUrls.length, 10_000)), ...(profileUrls.length > 1000 ? { payload_delivery_type: "link" } : {}) },
    notifications: channels,
  };
}

function parse(argv: string[]) {
  const out: { name?: string; channels: Channel[]; top?: number } = { channels: [] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    if (flag === "--help") throw Object.assign(new Error("npm run watch-example -- --email <addresses> | --slack <webhook URL> | --webhook <https URL> [--name <folder>] [--top N]"), { help: true });
    const value = inline ?? argv[++i];
    if (!value) throw new Error(`${flag} needs a value.`);
    if (flag === "--slack") {
      if (!/^https:\/\/hooks\.slack\.com\/services\//.test(value)) throw new Error("--slack takes a Slack incoming webhook URL, starting with https://hooks.slack.com/services/");
      out.channels.push({ type: "slack", webhook_url: value });
    } else if (flag === "--email") {
      const to = value.split(",").map(s => s.trim()).filter(Boolean);
      const bad = to.filter(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      if (!to.length || bad.length) throw new Error(`--email takes email addresses, comma separated${bad.length ? ` (not an address: ${bad.join(", ")})` : ""}.`);
      out.channels.push({ type: "email", to });
    }
    else if (flag === "--webhook") {
      if (!/^https:\/\//.test(value)) throw new Error("--webhook takes an https:// URL.");
      out.channels.push({ type: "webhook", url: value });
    } else if (flag === "--name") out.name = slugify(value) || undefined;
    else if (flag === "--top") {
      out.top = Number(value);
      if (!Number.isInteger(out.top) || out.top < 1) throw new Error("--top takes a whole number, 1 or more.");
    }
    else throw new Error(`Unknown flag ${flag}. Flags: --email <addresses>, --slack <webhook URL>, --webhook <URL>, --name <folder>, --top N`);
  }
  return out;
}

export async function runWatchExample(argv: string[]): Promise<void> {
  let flags: ReturnType<typeof parse>;
  try { flags = parse(argv); } catch (err) { if ((err as { help?: boolean }).help) { console.log((err as Error).message); return; } throw err; }
  const name = flags.name ?? latestRun();
  if (!name) throw new Error("No saved search yet. Run npm run find first, then npm run watch-example.");
  const file = join(folderFor(name), "people.json");
  if (!existsSync(file)) throw new Error(`No people saved in ${shown(folderFor(name))}. Run npm run find first.`);
  const found = JSON.parse(readFileSync(file, "utf8")) as Found[];
  let urls = found.map(f => profileUrlOf(f.person)).filter(Boolean);
  // --top N watches only the best scored (the order of researchers.csv).
  if (flags.top) {
    const csv = join(folderFor(name), "researchers.csv");
    if (!existsSync(csv)) throw new Error(`--top needs ${shown(join(folderFor(name), "researchers.csv"))}. Run npm run rescore -- --name ${name} first.`);
    {
      const [header, ...rows] = parseCsv(readFileSync(csv, "utf8"));
      const col = header.indexOf("profile_url");
      urls = rows.map(r => r[col]).filter(Boolean).slice(0, flags.top);
    }
  }
  if (!urls.length) throw new Error(`Nobody in ${shown(folderFor(name))} has a profile URL to watch.`);
  if (!flags.channels.length) throw new Error("Say where to send alerts: --email you@yourcompany.com, --slack <Slack webhook URL> or --webhook <https URL>.");
  if (urls.length > 10_000) console.log(`A watcher holds up to 10,000 people; the first 10,000 of ${urls.length} are in the request (use --top to choose).`);
  const missing = found.length - found.filter(f => profileUrlOf(f.person)).length;
  if (missing) console.log(`${missing} ${missing === 1 ? "person has" : "people have"} no profile URL and cannot be watched.`);
  const body = watchBody(urls, flags.channels);
  const out = join(folderFor(name), "watch-request.json");
  writeFileSync(out, JSON.stringify(body, null, 2), { mode: 0o600 });
  const where = shown(out);
  console.log(`Wrote ${where}: a Crustdata watcher for job moves of ${body.entities.professional_network_profile_urls.length} people.

Nothing was sent. To create it (the first run is a free baseline):

curl https://api.crustdata.com/watch/person \\
  --header "authorization: Bearer $CRUSTDATA_API_KEY" \\
  --header "content-type: application/json" \\
  --header "x-api-version: 2025-11-01" \\
  --data "@${where}"

Or build the same watcher at https://app.crustdata.com/watch.`);
}
