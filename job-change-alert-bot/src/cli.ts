/**
 * Command line. Run through npm, for example `npm run import -- champions.csv`.
 *
 *   import <file.csv>         add the people in the CSV to the watch (never removes anyone)
 *   sync <file.csv>           make the watch match the CSV exactly: adds new people, removes people not in it
 *   status                    watches, counts, recent runs and credits
 *   test-webhook              ask Crustdata to send a signed sample notification to your server (free)
 *   test-slack                post a "connected" message to the Slack channel
 *   digest                    send the digest now
 *   unresolved                list emails that did not match, and write them to data/unresolved.csv
 *   changes [days]            list every change received in the last [days] days (default 7), and write data/changes.csv
 *   catch-up                  process runs whose delivery failed (server was down), from Crustdata's run history
 *   adopt <watch id>          use a watch that already exists (created elsewhere, or a lost database)
 *   pause | resume            pause or resume the watches
 *   delete                    cancel the watches (needed before changing what is tracked)
 *   purge <days>              delete stored profile data older than <days> days
 */

import "./node-check.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, configProblems, ROOT, webhookUrl } from "./config.js";
import * as crustdata from "./crustdata.js";
import { CrustdataError, MAX_PEOPLE_PER_WATCH, normalizeProfileUrl } from "./crustdata.js";
import { COLUMN_ALIASES, readPeopleCsv } from "./csv.js";
import { jobChanges, people, settings, unresolved, watchIds } from "./store.js";
import { sendDigest } from "./digest.js";
import { catchUpMissedRuns } from "./handle.js";
import { connectedMessage, postToSlack } from "./slack.js";
import { headline } from "./notification.js";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function importCsv(file: string | undefined, { sync = false } = {}) {
  if (!file) throw new Error(`Usage: npm run ${sync ? "sync" : "import"} -- champions.csv`);
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  if (!config.publicUrl) throw new Error("PUBLIC_URL is not set, so Crustdata would have nowhere to deliver changes. Run npm run setup first.");

  const bytes = readFileSync(file);
  const magic = bytes.subarray(0, 4).toString("hex");
  if (magic === "504b0304" || magic === "d0cf11e0") throw new Error(`${file} is an Excel file. Export it as CSV (in Excel: File, Save As, CSV UTF-8) and import that.`);
  const csv = readPeopleCsv(bytes.toString("utf8"));
  console.log(`Read ${plural(csv.people.length, "person", "people")} from ${file}.`);
  if (csv.duplicates) console.log(`  ${plural(csv.duplicates, "duplicate row")} merged.`);
  if (csv.skippedLines.length) console.log(`  ${plural(csv.skippedLines.length, "row")} skipped: no email or profile URL (line ${csv.skippedLines.slice(0, 15).join(", ")}${csv.skippedLines.length > 15 ? ", ..." : ""}).`);
  if (!csv.people.length) {
    throw new Error(`No usable rows. Columns found: ${csv.headers.join(", ") || "none"}.\nThe bot needs an email column (${COLUMN_ALIASES.email.slice(0, 4).join(", ")}) or a profile URL column (${COLUMN_ALIASES.profileUrl.slice(0, 3).join(", ")}).`);
  }

  const keep = new Set<string>();

  // Rows with a profile URL need no lookup and cost nothing.
  for (const row of csv.people.filter(r => r.profileUrl)) {
    const url = normalizeProfileUrl(row.profileUrl!);
    keep.add(url);
    people.upsert({ profile_url: url, name: row.name, title: row.title, company: row.company, source_input: row.email ?? url, owner: row.owner });
    if (row.email) unresolved.remove(row.email);
  }

  // Rows with only an email are resolved once: 1 credit per match, no charge when there is no match.
  // Matches made by name and company domain (confidence below 1) are watched only if MIN_MATCH_CONFIDENCE allows,
  // checked on every import, so changing the setting applies to matches already made.
  const emailRows = csv.people.filter(r => !r.profileUrl && r.email);
  const byEmail = new Map(emailRows.map(r => [r.email!, r]));
  const counts = { matched: 0, not_found: 0, redacted: 0, invalid: 0, no_profile_url: 0, low_confidence: 0, likely: 0 };
  const rejected = new Map<string, string>(); // low-confidence email -> profile URL, removed after every row is read
  const accept = (email: string, profileUrl: string, confidence: number, extra: { crustdataPersonId?: number; name?: string; title?: string } = {}) => {
    const row = byEmail.get(email);
    if (confidence < config.minMatchConfidence) {
      rejected.set(email, profileUrl);
      counts.low_confidence++;
      return;
    }
    if (confidence < 1) counts.likely++;
    keep.add(profileUrl);
    unresolved.remove(email);
    people.upsert({ profile_url: profileUrl, crustdata_person_id: extra.crustdataPersonId, name: row?.name ?? extra.name, title: extra.title, company: row?.company, source_input: email, owner: row?.owner });
  };

  const already = people.resolvedEmails();
  for (const email of byEmail.keys()) {
    const known = already.get(email);
    if (known) accept(email, known.profileUrl, known.confidence);
  }
  const skip = unresolved.skippable();
  const toResolve = [...byEmail.keys()].filter(e => !already.has(e) && !skip.has(e));

  if (toResolve.length) {
    const minutes = Math.ceil(toResolve.length / 25 / 28);
    console.log(`Looking up ${plural(toResolve.length, "email")}${minutes > 1 ? `, about ${minutes} minutes (Crustdata allows 30 lookups a minute)` : ""}...`);
    await crustdata.identifyEmails(toResolve, (batch, done, total) => {
      for (const r of batch) {
        const row = byEmail.get(r.input);
        if (r.status === "matched" && r.profileUrl) {
          counts.matched++;
          people.rememberEmail(r.input, r.profileUrl, r.confidence ?? 1);
          accept(r.input, r.profileUrl, r.confidence ?? 1, { crustdataPersonId: r.crustdataPersonId, name: r.name, title: r.title });
        } else {
          counts[r.status as keyof typeof counts]++;
          unresolved.add(r.input, r.status, { name: row?.name, company: row?.company, owner: row?.owner });
        }
      }
      if (total > 50 && done) console.log(`  ${done} of ${total} looked up`);
    });
    console.log(`Matched ${counts.matched} of ${toResolve.length}.`);
    const misses = counts.not_found + counts.invalid + counts.redacted + counts.no_profile_url;
    if (misses) {
      writeUnresolvedCsv();
      const reasons = [
        counts.not_found && `${counts.not_found} not found`,
        counts.invalid && `${plural(counts.invalid, "invalid address", "invalid addresses")}`,
        counts.no_profile_url && `${counts.no_profile_url} without a profile URL`,
        counts.redacted && `${counts.redacted} removed at the person's request`,
      ].filter(Boolean).join(", ");
      console.log(`  Not matched: ${reasons}. Full list: data/unresolved.csv (fill in its profile_url column and import that file).`);
    }
  }
  // Stop watching low-confidence matches, unless the same person is wanted through an exact match or a profile URL.
  for (const [email, profileUrl] of rejected) if (!keep.has(profileUrl)) people.removeByEmail(email);

  if (counts.likely || counts.low_confidence) {
    const file = writeCsv("likely-matches.csv", ["email", "confidence", "profile_url", "watched"],
      people.likelyMatches().map(m => [m.email, m.confidence, m.profile_url, m.confidence >= config.minMatchConfidence ? "yes" : "no"]));
    console.log(`  ${counts.likely ? `${counts.likely} matched by name and company domain rather than an exact email. ` : ""}${counts.low_confidence ? `${counts.low_confidence} below MIN_MATCH_CONFIDENCE ${config.minMatchConfidence}, not watched. ` : ""}Check them in ${file}; set MIN_MATCH_CONFIDENCE=1 and import again to watch exact matches only.`);
  }

  if (sync) {
    const removed = people.removeAllExcept(keep);
    console.log(`Sync: ${plural(removed, "person", "people")} not in the CSV removed from the watch.`);
  }
  await syncWatches();
}

/** Makes the watches hold exactly the people in the database, 10,000 per watch. */
async function syncWatches() {
  const urls = people.all().map(p => p.profile_url);
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += MAX_PEOPLE_PER_WATCH) chunks.push(urls.slice(i, i + MAX_PEOPLE_PER_WATCH));

  let ids = watchIds.get();
  if (!ids.length) {
    const existing = (await crustdata.listActiveWatches()).filter(w => w.notifications?.some(n => n.url === webhookUrl()));
    if (existing.length) {
      ids = existing.map(w => w.id);
      console.log(`Found ${ids.length} existing watch(es) already delivering to ${webhookUrl()} (${ids.join(", ")}); using them instead of creating new ones.`);
    }
  }

  const kept: number[] = [];
  // Saved after every step, so a failure part way never leaves a paid-for watch the bot does not know about.
  const save = (i: number) => watchIds.set([...kept, ...ids.slice(i + 1)]);
  for (let i = 0; i < Math.max(chunks.length, ids.length); i++) {
    const id = ids[i];
    const chunk = chunks[i];
    if (id && !chunk) {
      await crustdata.deleteWatch(id);
      console.log(`Watch ${id} no longer needed and was cancelled.`);
      save(i);
      continue;
    }
    if (id) {
      try {
        const w = await crustdata.getWatch(id);
        if (w.status === "cancelled" || w.status === "expired") throw new CrustdataError(404, `watch ${id}`, w.status);
        if (!crustdata.tracksJobChanges(w)) throw new Error(`Watch ${id} tracks different changes than this version of the bot. Run npm run delete-watch, then import again (new people are baselined silently, so this sends no false alerts).`);
        await crustdata.setWatchedPeople(id, chunk!);
        if (!w.notifications?.some(n => n.type === "webhook" && n.url === webhookUrl())) await crustdata.setWatchDelivery(w, webhookUrl());
        if (w.config?.refresh_frequency_days !== config.refreshFrequencyDays || w.config?.trigger?.every_hours !== config.checkEveryHours) {
          await crustdata.setWatchSchedule(id);
          console.log(`Watch ${id} now uses ${config.refreshFrequencyDays}-day freshness, reporting every ${config.checkEveryHours}h.`);
        }
        kept.push(id);
        save(i);
        console.log(`Watch ${id} covers ${plural(chunk!.length, "person", "people")}. People new to it are baselined silently on its next run.`);
        continue;
      } catch (err) {
        if (!(err instanceof CrustdataError && err.status === 404)) throw err;
        console.log(`Watch ${id} no longer exists or was cancelled in the dashboard; creating a new one.`);
      }
    }
    let w: crustdata.Watch;
    try {
      w = await crustdata.createWatch(chunk!, webhookUrl());
    } catch (err) {
      // The create may have gone through even though the response failed: adopt any watch delivering here that we do not know.
      const orphan = (await crustdata.listActiveWatches().catch(() => [])).find(x => x.notifications?.some(n => n.url === webhookUrl()) && !kept.includes(x.id) && !ids.includes(x.id));
      if (!orphan) throw err;
      console.log(`Creating the watch failed, but watch ${orphan.id} exists for this URL; using it.`);
      await crustdata.setWatchedPeople(orphan.id, chunk!);
      w = orphan;
    }
    kept.push(w.id);
    save(i);
    console.log(`Created watch ${w.id} over ${plural(chunk!.length, "person", "people")}, reporting every ${config.checkEveryHours}h at ${config.refreshFrequencyDays}-day freshness, delivering to ${webhookUrl()}.`);
    console.log("Its first run is a free baseline: it records where everyone works today and alerts on nothing.");
  }
  watchIds.set(kept);
  settings.set("delivery_url", webhookUrl());
}

const csvCell = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function writeCsv(name: string, header: string[], rows: unknown[][]): string {
  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  const path = resolve(ROOT, "data", name);
  writeFileSync(path, [header, ...rows].map(r => r.map(csvCell).join(",")).join("\n") + "\n");
  return `data/${name}`;
}

function writeUnresolvedCsv() {
  const rows = unresolved.all();
  writeCsv("unresolved.csv", ["email", "reason", "name", "company", "owner", "profile_url"], rows.map(r => [r.input, r.status, r.name, r.company, r.owner, ""]));
  return rows.length;
}

function requireWatchIds(): number[] {
  const ids = watchIds.get();
  if (!ids.length) throw new Error("No watch yet. Run: npm run import -- champions.csv");
  return ids;
}

const commands: Record<string, (arg?: string) => Promise<void>> = {
  import: file => importCsv(file),
  sync: file => importCsv(file, { sync: true }),

  async status() {
    const byKind = Object.fromEntries(jobChanges.countByKind().map(r => [r.kind, r.n]));
    console.log(`People on the list: ${people.count()}. Unmatched emails: ${unresolved.all().length}.`);
    console.log(`Changes received: ${Object.entries(byKind).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ") || "none yet"}.`);
    for (const id of requireWatchIds()) {
      const w = await crustdata.getWatch(id);
      console.log(`\nWatch ${w.id}: ${w.status}, ${plural(w.entities.professional_network_profile_urls.length, "person", "people")}, ${w.config?.refresh_frequency_days ?? "?"}-day freshness, last run ${w.last_run_at ?? "not yet"}, ${w.notifications_count ?? 0} notifications, ${w.credits_consumed ?? 0} credits used.`);
      const { runs } = await crustdata.listRuns(id);
      if (runs?.length) {
        console.log("  Run started           Status   Checked  Changed  Credits");
        for (const r of runs.slice(0, 5)) console.log(`  ${String(r.started_at ?? "").slice(0, 19).padEnd(21)} ${String(r.status ?? "").padEnd(8)} ${String(r.records_searched ?? "").padStart(7)}  ${String(r.new_records_count ?? "").padStart(7)}  ${String(r.credits_deducted ?? 0).padStart(7)}`);
      }
    }
  },

  async "test-webhook"() {
    for (const id of requireWatchIds()) {
      const r = await crustdata.sendTestNotification(id);
      const deliveries: any[] = r?.delivered ?? r?.deliveries ?? [];
      const failed = deliveries.filter(d => d.ok === false);
      if (failed.length) {
        const statuses = failed.map(d => d.http_status ?? d.status);
        const hint = statuses.includes(401) ? "Your server rejected the signature: it must run with the same CRUSTDATA_API_KEY as this command." : "Is npm run serve running, and does PUBLIC_URL reach it?";
        throw new Error(`Crustdata could not deliver to your server: ${failed.map(d => `${d.endpoint ?? d.url ?? d.type} answered ${d.http_status ?? d.status ?? "no response"}`).join("; ")}. ${hint}`);
      }
      console.log(`Watch ${id}: sample sent${deliveries[0]?.http_status ? ` (your server answered ${deliveries[0].http_status})` : ""}. The server log should say "test notification, nothing to do".`);
    }
  },

  async "test-slack"() {
    if (!config.slackWebhookUrl) throw new Error("SLACK_WEBHOOK_URL is not set. Run: npm run setup");
    if (!(await postToSlack(connectedMessage())).ok) throw new Error("Slack did not accept the message. Check SLACK_WEBHOOK_URL (the webhook may have been removed).");
    console.log("Posted. Check the Slack channel.");
  },

  async digest() {
    await sendDigest({ evenIfEmpty: true });
  },

  async unresolved() {
    const rows = unresolved.all();
    if (!rows.length) return console.log("Every email matched a profile.");
    for (const r of rows) console.log(`${r.input}  ${r.status}`);
    writeUnresolvedCsv();
    console.log(`\n${rows.length} total, also written to data/unresolved.csv. Fill in its profile_url column and import that file to add them.`);
  },

  async changes(days) {
    const n = days ? Number(days) : 7;
    if (!Number.isInteger(n) || n < 1) throw new Error("Usage: npm run changes -- 30   (changes received in the last 30 days)");
    const list = jobChanges.since(n);
    if (!list.length) return console.log(`No changes received in the last ${n} days.`);
    for (const c of list) console.log(`${c.receivedAt.slice(0, 10)}  ${c.kind.padEnd(12)} ${c.alerted ? " " : "(not alerted)"} ${headline(c)}${c.owner ? `  [${c.owner}]` : ""}`);
    const file = writeCsv("changes.csv", ["received_at", "kind", "alerted", "name", "previous_title", "previous_company", "new_title", "new_company", "start_date", "owner", "profile_url"],
      list.map(c => [c.receivedAt, c.kind, c.alerted ? "yes" : "no", c.name, c.previousTitle, c.previousCompany, c.newTitle, c.newCompany, c.startDate, c.owner, c.profileUrl]));
    console.log(`\n${list.length} change(s), also written to ${file}.`);
  },

  async "catch-up"() {
    requireWatchIds();
    const { runs, changes } = await catchUpMissedRuns({ deliver: false }); // the server posts them, so nothing is sent twice
    if (!runs) return console.log("No missed deliveries: every run with changes reached the server.");
    console.log(`Handled ${plural(runs, "run")} whose delivery had failed: ${plural(changes, "new change")}.${changes ? " Keep npm run serve running to post them." : ""}`);
  },

  async adopt(id) {
    if (!id || !/^\d+$/.test(id)) throw new Error("Usage: npm run adopt -- <watch id>   (find ids in the Crustdata dashboard or npm run status on the old machine)");
    const w = await crustdata.getWatch(Number(id));
    for (const url of w.entities.professional_network_profile_urls) people.upsert({ profile_url: normalizeProfileUrl(url) });
    watchIds.set([...new Set([...watchIds.get(), w.id])]);
    console.log(`Now using watch ${w.id} (${w.status}, ${w.entities.professional_network_profile_urls.length} people). Import your CSV again to bring back names and owners.`);
  },

  async pause() {
    for (const id of requireWatchIds()) console.log(`Watch ${id} is ${(await crustdata.setWatchStatus(id, "paused")).status}.`);
  },

  async resume() {
    for (const id of requireWatchIds()) console.log(`Watch ${id} is ${(await crustdata.setWatchStatus(id, "active")).status}.`);
  },

  async delete() {
    for (const id of requireWatchIds()) { await crustdata.deleteWatch(id); console.log(`Watch ${id} cancelled.`); }
    watchIds.set([]);
    settings.delete("delivery_url");
    console.log("Run import again to create a new watch. Your list is kept.");
  },

  async purge(days) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) throw new Error("Usage: npm run purge -- 180   (deletes stored profile data older than 180 days)");
    console.log(`Deleted ${jobChanges.purgeOlderThan(n)} stored change(s) older than ${n} days.`);
  },
};

/** Turns API and file errors into a next step a non-developer can follow. */
function friendly(err: unknown): string {
  if (err instanceof CrustdataError) {
    if (err.status === 401) return "Crustdata rejected your API key. Run npm run setup and paste the key from https://app.crustdata.com";
    if (err.status === 402) return "Your Crustdata account is out of credits. Add credits at https://app.crustdata.com, then run the command again.";
    if (err.status === 403 && err.path.includes("identify")) return "Your Crustdata account does not have email lookup (/person/identify) enabled. Ask Crustdata to enable it, or add a profile URL column to your CSV.";
    if (err.status === 403) return `Your Crustdata key is not allowed to call ${err.path}. Ask Crustdata to enable it.`;
    if (err.status === 429) return "Crustdata is rate limiting this key. Wait a minute and run the command again; everything matched so far is saved.";
  }
  return (err as Error)?.message ?? String(err);
}

const [name, arg] = process.argv.slice(2);
const command = commands[name ?? ""];
if (!command) {
  console.log("Commands: npm run import | sync | status | test-webhook | test-slack | digest | unresolved | changes | catch-up | adopt | pause | resume | delete-watch | purge");
  process.exit(name ? 1 : 0);
}
const problems = configProblems();
if (problems.length) { console.error(["Fix these settings in .env first:", ...problems.map(p => `  - ${p}`)].join("\n")); process.exit(1); }
command(arg).catch(err => {
  console.error(friendly(err));
  process.exit(1);
});
