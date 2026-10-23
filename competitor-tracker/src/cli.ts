#!/usr/bin/env node
/**
 * Commands:
 *   init             resolve competitors, save the starting point, set up the three Crustdata watchers (asks first)
 *   digest           the weekly run: read the watchers, compare pages, search news, save and send one digest
 *   resend           send every recent digest a channel missed (--all: the latest digest to every channel again)
 *   status           watchers, credits, last digest, what is stored
 *   add <domain>     add a competitor (then run init)
 *   remove <domain>  remove a competitor (updates the watchers)
 *   pause | resume   pause or resume the three watchers
 *   delete-watches   cancel the watchers (your snapshots stay)
 *   test-slack       send a short test message to SLACK_WEBHOOK_URL
 */

import "./node-check.js";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { config, configProblems, hasEmail, hasSlack } from "./config.js";
import { deriveAbout, loadCompetitors, looksLikeDomain, normalizeDomain, saveCompetitors, type Competitors } from "./competitors.js";
import * as crustdata from "./crustdata.js";
import { loadKeywords } from "./posts.js";
import { postToSlack } from "./slack.js";
import { Store } from "./store.js";
import { deleteAllWatches, ensureWatches, estimateInit, estimateWeek, FIRST_DIGEST_MAX_PER_COMPETITOR, init, needsStartingPoint, resendLast, resendPending, runDigest, undelivered, undeliveredAll, watchersToReplace, type Delivery } from "./run.js";

const [command, ...args] = process.argv.slice(2);
const yes = args.includes("--yes") || args.includes("-y");
const dry = args.includes("--dry-run");
const all = args.includes("--all");
const positional = args.filter(a => !a.startsWith("-"));
const log = (s: string) => console.log(s);

async function confirm(question: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log(`${question}\nNo terminal to answer in: pass --yes (npm run init -- --yes) to go ahead without the prompt.`);
    process.exitCode = 1;
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

let openStore: Store | undefined;

/**
 * One command at a time may change the state: a lock file next to the database, holding the process id. A lock left
 * by a process that is gone (or older than two hours) is taken over.
 */
function lock(): void {
  if (config.dbPath === ":memory:") return;
  const file = resolve(dirname(config.dbPath), ".tracker.lock");
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${process.pid} ${new Date().toISOString()}`, { flag: "wx" });
      const release = () => { try { unlinkSync(file); } catch { /* already gone */ } };
      process.on("exit", release);
      // Ctrl-C or a stop signal: roll back anything half done, release the lock, and exit.
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { try { openStore?.close(); } catch { /* closed */ } release(); process.exit(sig === "SIGINT" ? 130 : 143); });
      return;
    } catch {
      const read = () => { try { return readFileSync(file, "utf8").trim().split(/\s+/); } catch { return ["", ""]; } };
      let [pid, at] = read();
      // An empty file is another process between creating the lock and writing to it: look again once.
      if (!/^\d+$/.test(pid ?? "")) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); [pid, at] = read(); }
      // Our own process id in the file means a lock left by an earlier run of this container (pid 1 again); a process
      // we may not signal (EPERM) is alive. No readable process id at all: a lock left half written by a crash.
      const owner = /^\d+$/.test(pid ?? "") ? Number(pid) : 0;
      const alive = owner > 0 && owner !== process.pid && (() => { try { process.kill(owner, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } })();
      const since = new Date(at ?? "").getTime();
      if (alive && (Number.isNaN(since) || Date.now() - since < 2 * 3_600_000)) fail(`Another competitor-tracker command is running (process ${pid}). Wait for it to finish and run this again.`);
      try { unlinkSync(file); } catch { /* raced with its owner */ }
    }
  }
  fail("Could not take the competitor-tracker lock. Run the command again.");
}

function fail(message: string): never {
  console.error(`\n${message}`);
  try { openStore?.close(); } catch { /* already closed */ }
  process.exit(1);
}

/** Checks settings (and the key, unless `needKey` is false), then opens the state and the competitor list. */
function open({ needKey = true, needCompetitors = true, readOnly = false } = {}): { store: Store; competitors?: Competitors; save: (c: Competitors) => void } {
  const problems = configProblems({ needKey });
  if (problems.length) fail(problems.join("\n"));
  if (!readOnly) lock();
  let competitors: Competitors | undefined;
  if (needCompetitors || existsSync(config.competitorsFile)) {
    try { competitors = loadCompetitors(); } catch (err) { if (needCompetitors) fail((err as Error).message); competitors = undefined; }
  }
  openStore = new Store();
  return { store: openStore, competitors, save: c => saveCompetitors(c) };
}

const failed = (d: Delivery) => d !== null && d !== "skipped";

function reportDelivery(slack: Delivery, email: Delivery): void {
  if (hasSlack()) console.log(failed(slack) ? `✗ Slack: ${slack}` : slack === "skipped" ? "· Slack: nothing to send (already sent, or set up after this digest was made; --all sends it anyway)" : "✓ Sent to Slack");
  if (hasEmail()) console.log(failed(email) ? `✗ Email: ${email}` : email === "skipped" ? "· Email: nothing to send (already sent, or set up after this digest was made; --all sends it anyway)" : `✓ Emailed to ${config.digestEmailTo.join(", ")}`);
  if (failed(slack) || failed(email)) {
    console.log("The digest is saved. Fix the channel, then run npm run resend to send it again.");
    process.exitCode = 2;
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "init": {
      const { store, competitors, save } = open();
      const keywords = loadKeywords();
      const n = competitors!.competitors.length;
      const fresh = needsStartingPoint(store, competitors!).length;
      const week = estimateWeek(n);
      const balance = await crustdata.getCreditBalance().catch(err => fail(crustdata.explain(err)));
      const replace = watchersToReplace(store, competitors!, keywords);
      if (fresh === 0 && store.allWatches().length && !replace.datasets.length) {
        console.log(`All ${n} competitors already have a starting point. Checking the watchers (free)...`);
      } else if (fresh === 0 && store.allWatches().length) {
        console.log(`All ${n} competitors already have a starting point, but the ${replace.datasets.map(ds => (ds === "job" ? "job" : "post")).join(" and ")} watcher${replace.datasets.length > 1 ? "s" : ""} must be replaced (the competitor list or post words changed, and filters are fixed once created).`);
        console.log(`The new watcher's first run is free; the next digest runs a short catch-up search for the gap: up to about ${replace.catchUpCredits} credits.`);
        if (balance !== undefined) console.log(`Your balance: ${Math.round(balance)} credits.`);
        if (!(await confirm("\nGo ahead?"))) { console.log("Nothing was changed."); return; }
      } else {
        console.log(`\n${n} competitor${n === 1 ? "" : "s"}: ${competitors!.competitors.map(c => c.domain).join(", ")}${fresh < n ? ` (${n - fresh} already set up)` : ""}`);
        console.log(`\nThis will, with your Crustdata key:`);
        console.log(`  1. Resolve each new domain to a Crustdata company (free).`);
        console.log(`  2. Fetch up to ${config.pagesPerCompetitor} pages per new competitor as the starting point (1 credit per page).`);
        console.log(`  3. Pull one company record each for headcount and funding (2 credits each).`);
        console.log(`  4. Set up three watchers (company changes weekly; new jobs and announcement posts daily) that send nothing`);
        console.log(`     themselves; the digest reads them. First runs are free; then 5 per changed company, 0.5 per new job,`);
        console.log(`     2 per post caught. A watcher that already matches on your account is reused, not duplicated.`);
        console.log(`\nOne-time cost now: up to about ${estimateInit(fresh)} credits. The ${store.lastDigest() ? "next" : "first"} digest adds up to ${Math.round(fresh * FIRST_DIGEST_MAX_PER_COMPETITOR)} for its 7-day searches${replace.catchUpCredits ? `, plus up to about ${replace.catchUpCredits} for a short catch-up search while the ${replace.datasets.map(ds => (ds === "job" ? "job" : "post")).join(" and ")} watcher${replace.datasets.length > 1 ? "s are" : " is"} replaced` : ""}.`);
        console.log(`Each week after: about ${week.quiet} credits on a quiet week, ${week.busy} on a busy one, at most ${week.ceiling} with the current caps.`);
        if (balance !== undefined) console.log(`Your balance: ${Math.round(balance)} credits.`);
        if (!(await confirm("\nGo ahead?"))) { console.log("Nothing was created."); return; }
        console.log("");
      }
      const result = await init({ store, competitors: competitors!, keywords, log, saveCompetitors: save });
      for (const note of result.notes) console.log(`· ${note}`);
      console.log(`\n✓ ${result.resolved.length} of ${n} competitors resolved, ${result.pagesSaved} pages saved, watchers: company ${result.watches.company ?? "none"}, jobs ${result.watches.job ?? "none"}, posts ${result.watches.social_post ?? "none"}.`);
      if (result.unresolved.length) console.log(`· Not in the company index: ${result.unresolved.join(", ")} (website and news only).`);
      console.log(`  Credits used: ${Math.round(result.creditsUsed * 100) / 100}.`);
      console.log(store.lastDigest() ? "\nNext: the weekly npm run digest picks this up." : "\nNext: npm run digest for a first digest of the last 7 days, then schedule it weekly (docs/deploy.md).");
      return;
    }
    case "digest": {
      const { store, competitors, save } = open();
      const keywords = loadKeywords();
      const pending = dry ? [] : undeliveredAll(store);
      if (pending.length) {
        console.log(`${pending.length === 1 ? `The ${pending[0].createdAt.slice(0, 10)} digest` : `${pending.length} earlier digests`} did not reach every channel. Sending ${pending.length === 1 ? "it" : "them"} again first.`);
        const again = await resendPending(store);
        reportDelivery(again.slack, again.email);
        // A channel that still fails does not hold back the new digest for the channels that work.
        if (process.exitCode === 2) console.log(`The earlier digests are in ${config.digestDir}. Building this week's digest anyway.\n`);
      }
      if (!store.getMeta("initialized_at")) console.log("Note: npm run init has not been run. This digest uses direct searches; run init to set up the watchers.\n");
      const result = await runDigest({ store, competitors: competitors!, keywords, log, saveCompetitors: save, showNames: config.showPosterNames }, { send: !dry, writeFile: !dry, dryRun: dry });
      console.log(result.markdown);
      if (result.file) console.log(`Written to ${result.file}`);
      if (dry) { console.log(`Dry run: nothing was saved, sent or marked as reported (it used ${Math.round((result.digest.creditsUsed) * 100) / 100} credits for pages and searches). Run npm run digest to send it.`); return; }
      if (!hasSlack() && !hasEmail()) console.log("· No Slack or email set up; the digest is the file above. Run npm run setup to add a channel.");
      reportDelivery(result.slack, result.email);
      return;
    }
    case "resend": {
      const { store } = open({ needKey: false, needCompetitors: false });
      if (!hasSlack() && !hasEmail()) fail("No Slack or email is set up. Run npm run setup to add one.");
      if (all) {
        const r = await resendLast(store, { all });
        if (!r.digest) fail("No digest has been saved yet. Run npm run digest.");
        console.log(`Digest of ${r.digest.createdAt.slice(0, 10)}:`);
        reportDelivery(r.slack, r.email);
      } else {
        if (!store.lastDigest()) fail("No digest has been saved yet. Run npm run digest.");
        const r = await resendPending(store);
        if (!r.count) { console.log("Every channel has every digest made since it was set up. npm run resend -- --all sends the last one again anyway."); return; }
        console.log(`Resent ${r.count} digest${r.count === 1 ? "" : "s"}, the last from ${r.digest!.createdAt.slice(0, 10)}:`);
        reportDelivery(r.slack, r.email);
      }
      return;
    }
    case "status": {
      const { store, competitors } = open({ needCompetitors: false, readOnly: true });
      if (competitors) {
        console.log(`\nCompetitors (${competitors.competitors.length}): ${competitors.competitors.map(c => `${c.name} (${c.domain}${c.crustdata_company_id ? "" : ", not resolved"})`).join(", ")}`);
        if (competitors.cities.length) console.log(`Hiring places: ${competitors.cities.join(", ")}`);
      } else console.log(`\nNo competitors file at ${config.competitorsFile}.`);
      const counts = store.counts();
      console.log(`Stored: ${counts.pages} page snapshots, ${counts.companies} company records, ${counts.digests} digests.`);
      const last = store.lastDigest();
      console.log(`Last digest: ${last ? `${last.createdAt.slice(0, 10)}${undelivered(store) ? " (not delivered everywhere: npm run resend)" : ""}` : "none yet"}`);
      const watches = store.allWatches();
      if (!watches.length) console.log("Watchers: none. Run npm run init.");
      for (const w of watches) {
        try {
          const live = await crustdata.getWatch(w.dataset, w.watch_id);
          console.log(`Watcher ${w.dataset} ${w.watch_id}: ${live.status}, ${live.notifications_count ?? 0} items caught, ${live.credits_consumed ?? 0} credits spent, last run ${live.last_run_at ?? "pending"}`);
        } catch (err) { console.log(`Watcher ${w.dataset} ${w.watch_id}: ${crustdata.explain(err)}`); }
      }
      for (const ds of ["company", "job", "social_post"]) { const m = store.getMeta(`disabled_${ds}`); if (m) console.log(`· ${m}`); }
      const balance = await crustdata.getCreditBalance().catch(err => { console.log(`Credits: ${crustdata.explain(err)}`); return undefined; });
      if (balance !== undefined) console.log(`Credits left: ${Math.round(balance)}`);
      console.log(`Slack: ${hasSlack() ? "set up" : "not set up"}. Email: ${hasEmail() ? `to ${config.digestEmailTo.join(", ")}` : "not set up"}.`);
      return;
    }
    case "add":
    case "remove": {
      const raw = positional[0];
      if (!raw) fail(`Usage: npm run ${command} -- acme.com`);
      const domain = looksLikeDomain(raw) ? normalizeDomain(raw) : null;
      if (!domain) fail(`${raw} is not a website. Use the competitor's domain: npm run ${command} -- acme.com`);
      const { store, competitors, save } = open({ needCompetitors: command === "remove" });
      const list: Competitors = competitors ?? { competitors: [], cities: [] };
      const keywords = loadKeywords();
      if (command === "add") {
        if (list.competitors.some(c => c.domain === domain)) fail(`${domain} is already tracked.`);
        const [found] = await crustdata.identifyCompanies([domain]).catch(err => fail(crustdata.explain(err)));
        list.competitors.push({ name: found?.name ?? domain, domain, crustdata_company_id: found?.id, about: deriveAbout(found?.description) });
        save(list);
        console.log(`Added ${found?.name ?? domain} (${domain})${found?.id ? "" : ", not in the company index yet: website and news only"}. News is matched on "${list.competitors.at(-1)!.about}" (edit "about" in competitors.json to change it).`);
        const catchUp = watchersToReplace(store, list, keywords).catchUpCredits;
        console.log(`Run npm run init to save its starting point and update the watchers (about ${estimateInit(1)} credits now, and up to ${FIRST_DIGEST_MAX_PER_COMPETITOR} more for its 7-day look back in the next digest${catchUp ? `, plus up to about ${catchUp} for a short catch-up search on the job and post watchers, which are replaced` : ""}).`);
      } else {
        const idx = list.competitors.findIndex(c => c.domain === domain);
        if (idx < 0) fail(`${domain} is not tracked. Tracked: ${list.competitors.map(c => c.domain).join(", ")}`);
        if (list.competitors.length === 1) fail(`${domain} is the last competitor. To stop tracking altogether, run npm run delete-watches (so nothing more is billed), then edit competitors.json.`);
        list.competitors.splice(idx, 1);
        save(list);
        store.deletePagesFor(domain);
        store.deleteCompanyRecord(domain);
        console.log(`Removed ${domain}.`);
        if (store.allWatches().length) {
          console.log("Updating the watchers (the next digest also runs a short catch-up search, at most about 5 credits per competitor)...");
          await ensureWatches({ store, competitors: list, keywords, log }, crustdata, log);
        }
      }
      return;
    }
    case "pause":
    case "resume": {
      const { store } = open({ needCompetitors: false });
      const watches = store.allWatches();
      if (!watches.length) fail("No watchers. Run npm run init.");
      for (const w of watches) {
        await crustdata.setWatchStatus(w.dataset, w.watch_id, command === "pause" ? "paused" : "active");
        console.log(`  ${w.dataset} watcher ${w.watch_id} ${command === "pause" ? "paused" : "active"}.`);
      }
      if (command === "pause") console.log("Paused watchers catch nothing and bill nothing. Digests still compare pages and search the news.");
      return;
    }
    case "delete-watches": {
      const { store } = open({ needCompetitors: false });
      const n = await deleteAllWatches(store, crustdata, log);
      console.log(n ? `${n} watcher${n === 1 ? "" : "s"} deleted. Your snapshots are kept; npm run init sets up new ones.` : "No watchers to delete.");
      return;
    }
    case "test-slack": {
      const problems = configProblems({ needKey: false });
      if (problems.length) fail(problems.join("\n"));
      if (!hasSlack()) fail("SLACK_WEBHOOK_URL is not set. Run npm run setup.");
      const problem = await postToSlack({ text: "competitor-tracker: test message. Your weekly digest will arrive here." });
      if (problem) fail(`Slack: ${problem}`);
      console.log("✓ Test message sent to Slack.");
      return;
    }
    default:
      console.log("Usage: npm run <init | digest | resend | status | add | remove | pause | resume | delete-watches | test-slack>\n\nFlags: --yes (init: skip the prompt), --dry-run (digest: preview, nothing saved or sent), --all (resend: every channel).");
      process.exit(command ? 1 : 0);
  }
}

// Closing checkpoints SQLite's write-ahead log into the one .sqlite file, so the file alone can be copied or committed.
main().then(() => openStore?.close(), err => fail(crustdata.explain(err)));
