#!/usr/bin/env node
/**
 * Commands:
 *   import            read the portfolio, find leaders and careers pages, set up the two watchers (asks before spending)
 *   check             the daily run: what the watchers caught, careers pages when due, alerts to Slack
 *   digest            the weekly summary to Slack, email and digests/<date>.md
 *   resend            send anything a channel missed (--all: the latest digest to every channel again)
 *   status            companies, leaders, hiring, watchers, credits
 *   refresh-leaders   look for new founders and C-level (one company: npm run refresh-leaders -- acme.com)
 *   pause | resume    pause or resume both watchers
 *   delete-watches    cancel both watchers (your data stays)
 *   test-slack        a short test message to every Slack channel set up
 */

import "./node-check.js";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { config, configProblems, hasEmail, hasSlack, leaderPrice, ROOT } from "./config.js";
import * as crustdata from "./crustdata.js";
import { LEADER_PRICE_WORST } from "./crustdata.js";
import { ownersWithoutRoute, sendAlerts, sendDigest, writeDigestFile, type Delivery } from "./deliver.js";
import { digestMarkdown } from "./digest.js";
import { readPortfolioCsv, readSource, unresolvedCsv } from "./portfolio.js";
import { estimateImport, estimateMonth, hiringLine, importPortfolio, planImport, refreshLeaders, runCheck, runDigest, SERIOUS, type Ctx } from "./run.js";
import { postToSlack } from "./slack.js";
import { Store } from "./store.js";
import { loadThresholds } from "./thresholds.js";
import { SEVERITY_LABEL } from "./types.js";

const [command, ...args] = process.argv.slice(2);
const yes = args.includes("--yes") || args.includes("-y");
const dry = args.includes("--dry-run");
const allowRemovals = args.includes("--allow-removals");
const positional = args.filter(a => !a.startsWith("-"));
const log = (s: string) => console.log(s);

async function confirm(question: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log(`${question}\nNo terminal to answer in: add --yes (npm run ${command} -- --yes) to go ahead without the prompt.`);
    process.exitCode = 1;
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

let openStore: Store | undefined;

/** One command at a time may change the state: a lock file next to the database holding the process id. */
function lock(): void {
  if (config.dbPath === ":memory:") return;
  const file = resolve(dirname(config.dbPath), ".monitor.lock");
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${process.pid} ${new Date().toISOString()}`, { flag: "wx" });
      const release = () => { try { unlinkSync(file); } catch { /* already gone */ } };
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { try { openStore?.close(); } catch { /* closed */ } release(); process.exit(sig === "SIGINT" ? 130 : 143); });
      return;
    } catch {
      let [pid, at] = (() => { try { return readFileSync(file, "utf8").trim().split(/\s+/); } catch { return ["", ""]; } })();
      const owner = /^\d+$/.test(pid ?? "") ? Number(pid) : 0;
      const alive = owner > 0 && owner !== process.pid && (() => { try { process.kill(owner, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } })();
      const since = new Date(at ?? "").getTime();
      if (alive && (Number.isNaN(since) || Date.now() - since < 2 * 3_600_000)) fail(`Another vc-portfolio-monitor command is running (process ${pid}). Wait for it to finish and run this again.`);
      try { unlinkSync(file); } catch { /* raced with its owner */ }
    }
  }
  fail("Could not take the vc-portfolio-monitor lock. Run the command again.");
}

function fail(message: string): never {
  console.error(`\n${message}`);
  try { openStore?.close(); } catch { /* already closed */ }
  process.exit(1);
}

function open({ needKey = true, readOnly = false } = {}): Ctx {
  const problems = configProblems({ needKey });
  if (problems.length) fail(problems.join("\n"));
  let thresholds;
  try { thresholds = loadThresholds(); } catch (err) { fail((err as Error).message); }
  if (!readOnly) lock();
  try { openStore = new Store(); }
  catch (err) {
    if (/not a database|malformed|corrupt/i.test((err as Error).message)) fail(`${config.dbPath} is damaged. Restore it from git (GitHub Actions) or a backup, or delete it and run npm run import (the watchers on your account are reused).`);
    throw err;
  }
  return { store: openStore, api: crustdata, thresholds, log };
}

const failed = (d: Delivery) => d !== null && d !== "skipped";
function reportDigestDelivery(slack: Delivery, email: Delivery): void {
  if (hasSlack()) console.log(failed(slack) ? `✗ Slack: ${slack}` : slack === "skipped" ? "· Slack: nothing to send (already sent)" : "✓ Digest sent to Slack");
  if (hasEmail()) console.log(failed(email) ? `✗ Email: ${email}` : email === "skipped" ? "· Email: nothing to send (already sent)" : `✓ Digest emailed to ${config.digestEmailTo.join(", ")}`);
  if (failed(slack) || failed(email)) { console.log("The digest is saved. Fix the channel, then run npm run resend."); process.exitCode = 2; }
}

async function loadPortfolio() {
  try { return readPortfolioCsv(await readSource(config.portfolio)); } catch (err) { fail((err as Error).message); }
}

/** Rows in the portfolio that are not imported yet (free: no lookups), for a reminder after each check. */
async function notImported(ctx: Ctx): Promise<number> {
  try {
    const p = readPortfolioCsv(await readSource(config.portfolio));
    const stored = ctx.store.companies();
    const domains = new Set(stored.map(c => c.domain));
    const names = new Set(stored.map(c => c.name.toLowerCase()));
    // Rows already reported as unmatched (unresolved.csv) are not reminded about every day.
    const file = resolve(ROOT, "unresolved.csv");
    const known = existsSync(file) ? readPortfolioCsv(readFileSync(file, "utf8")).rows : [];
    const isKnown = (r: { domain?: string; name?: string }) => known.some(k => (r.domain && k.domain === r.domain) || (r.name && k.name?.toLowerCase() === r.name.toLowerCase()));
    return p.rows.filter(r => (r.domain ? !domains.has(r.domain) : !names.has(String(r.name).toLowerCase())) && !isKnown(r)).length;
  } catch { return 0; }
}

async function main(): Promise<void> {
  switch (command) {
    case "import": {
      const ctx = open();
      const portfolio = await loadPortfolio();
      if (!portfolio.rows.length) fail(`No companies found in ${config.portfolio}.${portfolio.skipped.length ? ` ${portfolio.skipped.map(s => `Line ${s.line}: ${s.reason}.`).join(" ")}` : ""} See portfolio.example.csv.`);
      console.log(`Reading ${portfolio.rows.length} rows from ${config.portfolio}... (matching companies is free)`);
      const plan = await planImport(ctx, portfolio).catch(err => fail(crustdata.explain(err)));
      const est = estimateImport(plan);
      for (const s of plan.skipped) console.log(`· Line ${s.line} skipped: ${s.reason}.`);
      if (plan.duplicates) console.log(`· ${plan.duplicates} duplicate row${plan.duplicates === 1 ? "" : "s"} ignored.`);
      for (const u of plan.unresolved) console.log(`· Line ${u.row.line} (${u.row.name ?? u.row.domain}): ${u.reason}${u.candidates?.length ? `: ${u.candidates.join(", ")}` : ""}.`);
      for (const n of portfolio.notes) console.log(`· ${n}`);
      const unresolvedFile = resolve(ROOT, "unresolved.csv");
      if (!dry) {
        if (plan.unresolved.length) { writeFileSync(unresolvedFile, unresolvedCsv(plan.unresolved)); console.log(`  Written to unresolved.csv: fix the website column and import again.`); }
        else if (existsSync(unresolvedFile)) unlinkSync(unresolvedFile);
      }
      console.log(`\n${plan.add.length} to add, ${plan.keep.length} already watched, ${plan.remove.length} to stop watching.`);
      if (plan.add.length) console.log(`Add: ${plan.add.map(r => `${r.name} (${r.domain})`).join(", ")}`);
      if (plan.remove.length) console.log(`Stop watching (no longer in the portfolio): ${plan.remove.map(c => c.name).join(", ")}`);
      const spend = est.total > 0;
      if (spend) {
        console.log(`\nThis will, with your Crustdata key:\n${est.lines.map(l => `  · ${l}`).join("\n")}\n  · set up or update two watchers (company changes and leader changes), checked daily. Free until they catch a change.`);
        console.log(`\nOne-time cost: up to ${est.total} credits (usually about ${est.typical}).`);
        const balance = await crustdata.getCreditBalance().catch(err => fail(crustdata.explain(err)));
        if (balance !== undefined) console.log(`Your balance: ${Math.round(balance)} credits.`);
      }
      if (dry) { console.log("\nDry run: nothing was changed."); return; }
      // Unattended (--yes on a schedule): a Sheet edited by mistake must not drop many companies, or spend a lot, unseen.
      const watched = ctx.store.companies().length;
      const removalLimit = Math.max(2, Math.floor(watched * 0.1));
      if (yes && plan.remove.length > removalLimit && !allowRemovals) {
        fail(`The portfolio has ${plan.remove.length} fewer companies than are watched (${plan.remove.slice(0, 5).map(c => c.name).join(", ")}${plan.remove.length > 5 ? ", ..." : ""}). Nothing was changed, because more than ${removalLimit} would stop being watched without a person confirming. If that is right, run npm run import by hand, or add --allow-removals.`);
      }
      if (yes && est.total > config.maxImportCredits) {
        fail(`This import could cost up to ${est.total} credits, over MAX_IMPORT_CREDITS (${config.maxImportCredits}). Nothing was changed. Run npm run import by hand to confirm, or raise MAX_IMPORT_CREDITS.`);
      }
      if ((spend || plan.remove.length) && !(await confirm("\nGo ahead?"))) { console.log("Nothing was changed."); return; }
      if (!spend && !plan.remove.length && !plan.newCsvLeaders.length) console.log("Checking the watchers (free)...");
      const result = await importPortfolio(ctx, plan).catch(err => fail(`${crustdata.explain(err)}\nWhat was done so far is saved; run npm run import again to finish (nothing is paid twice).`));
      if (result.starting.length) {
        console.log("\nStarting point:");
        for (const s of result.starting) console.log(`  ${s.name} (${s.domain}): ${s.line}; ${s.hiring}\n    leaders: ${s.leaders.length ? s.leaders.join(", ") : "none found"}${s.flag ? `\n    ${SEVERITY_LABEL[s.flag.severity]}: ${s.flag.text}` : ""}`);
      }
      for (const n of result.notes) console.log(`· ${n}`);
      if (result.removed.length) console.log(`· Stopped watching: ${result.removed.join(", ")}.`);
      const companies = ctx.store.companies();
      const leaders = ctx.store.watchedProfileUrls().length;
      const noRoute = ownersWithoutRoute(ctx.store);
      if (noRoute.length) console.log(`· Owners with no Slack channel in SLACK_ROUTES (their alerts go to the main channel): ${noRoute.join(", ")}.`);
      console.log(`\n✓ ${companies.length} compan${companies.length === 1 ? "y" : "ies"} and ${leaders} leader${leaders === 1 ? "" : "s"} watched. Watchers: company ${result.watches.company ?? "none"}, leaders ${result.watches.person ?? "none"}. Credits used: ${result.creditsUsed}.`);
      const m = estimateMonth(companies.length, leaders, leaderPrice(), companies.filter(c => c.hiringSource === "careers").length);
      console.log(`Monthly, about ${m.quiet} credits in a quiet month and ${m.busy} in a busy one:\n${m.lines.map(l => `  · ${l}`).join("\n")}`);
      console.log("\nNext: schedule npm run check daily and npm run digest weekly (docs/deploy.md). The watchers' first run is a free baseline, so alerts start from the second day.");
      return;
    }

    case "check": {
      const ctx = open();
      if (!ctx.store.companies().length) fail("No companies imported yet. Run npm run import first.");
      const result = await runCheck(ctx, { dryRun: dry, hiring: args.includes("--no-hiring") ? "skip" : args.includes("--hiring-now") ? "force" : "due" }).catch(err => fail(crustdata.explain(err)));
      for (const w of result.warnings) console.log(`! ${w}`);
      if (!result.signals.length) console.log(`Nothing new${result.readings ? ` (${result.readings} careers page${result.readings === 1 ? "" : "s"} read)` : ""}.`);
      for (const s of result.signals) console.log(`${SEVERITY_LABEL[s.severity]}: ${s.company}: ${s.text}`);
      if (result.pending) console.log("· A watcher run is still in progress; it is read on the next check.");
      const missing = await notImported(ctx);
      if (missing) console.log(`· ${missing} compan${missing === 1 ? "y is" : "ies are"} in the portfolio but not watched yet: run npm run import.`);
      console.log(`Credits: ${result.creditsUsed} for careers pages, ${result.watcherCredits} billed by the watchers.`);
      if (dry) { console.log(`Dry run: nothing saved or posted.${args.includes("--hiring-now") ? "" : " Careers pages were not read (add --hiring-now to read them; they are billed)."}`); if (result.inactive) process.exitCode = 3; return; }
      const posted = await sendAlerts(ctx.store);
      if (posted.posted) console.log(`✓ Posted ${posted.posted} update${posted.posted === 1 ? "" : "s"} to Slack.`);
      for (const w of posted.warnings) console.log(`! ${w}`);
      for (const p of posted.problems) { console.log(`✗ Slack, ${p}. They are kept and posted by the next check (or npm run resend).`); process.exitCode = 2; }
      // A watcher that stopped, or changes that were lost or not read, are said in Slack once a day, not only in a log.
      const serious = result.warnings.filter(w => SERIOUS.test(w));
      if (serious.length && hasSlack() && ctx.store.getMeta("warned_on") !== new Date().toISOString().slice(0, 10)) {
        const sent = await postToSlack({ text: `${config.fundName} portfolio monitor: ${serious.join(" ")}`.slice(0, 2900) });
        if (!sent) ctx.store.setMeta("warned_on", new Date().toISOString().slice(0, 10));
      }
      if (result.inactive) process.exitCode = 3;
      return;
    }

    case "digest": {
      const ctx = open();
      if (!ctx.store.companies().length) fail("No companies imported yet. Run npm run import first.");
      const run = await runDigest(ctx, { dryRun: dry }).catch(err => fail(crustdata.explain(err)));
      const md = digestMarkdown(run.digest);
      console.log(md);
      if (dry || !run.id) { console.log("Dry run: nothing saved or sent."); return; }
      console.log(`✓ Saved to ${writeDigestFile(md, run.digest.to)}`);
      const r = await sendDigest(ctx.store, run.id, run.digest);
      reportDigestDelivery(r.slack, r.email);
      return;
    }

    case "resend": {
      const ctx = open({ needKey: false });
      const posted = await sendAlerts(ctx.store);
      if (posted.posted) console.log(`✓ Posted ${posted.posted} pending update${posted.posted === 1 ? "" : "s"} to Slack.`);
      for (const p of posted.problems) { console.log(`✗ Slack, ${p}`); process.exitCode = 2; }
      const digests = args.includes("--all") ? ctx.store.recentDigests(1) : ctx.store.recentDigests(10).filter(d => (hasSlack() && d.wantSlack && !d.sentSlack) || (hasEmail() && d.wantEmail && !d.sentEmail)).reverse();
      if (!digests.length && !posted.posted && !posted.problems.length) console.log("Nothing to resend.");
      for (const d of digests) {
        console.log(`Digest of ${d.to.slice(0, 10)}:`);
        const r = await sendDigest(ctx.store, d.id, d.payload, { force: args.includes("--all") });
        reportDigestDelivery(r.slack, r.email);
      }
      return;
    }

    case "status": {
      const ctx = open({ needKey: false, readOnly: true });
      const { store } = ctx;
      const companies = store.companies();
      if (!companies.length) { console.log("No companies imported yet. Run npm run setup, then npm run import."); return; }
      console.log(`${config.fundName}: ${companies.length} compan${companies.length === 1 ? "y" : "ies"}\n`);
      for (const c of companies) {
        const ls = store.leaders(c.domain);
        console.log(`${c.name} (${c.domain})${c.owner ? `, owner ${c.owner}` : ""}\n  ${c.start ?? ""}\n  ${hiringLine(store, c)}${c.careersUrl ? ` (${c.careersUrl})` : ""}\n  leaders: ${ls.length ? ls.map(l => `${l.name} (${l.title})`).join(", ") : "none"}`);
      }
      const n = store.signalCounts();
      console.log(`\nSignals so far: ${n.alert} alerts, ${n.good} good news, ${n.note} notes, ${n.news} news.`);
      const when = (iso?: string) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never");
      console.log(`Last check: ${when(store.getMeta("last_check_at"))}. Last digest: ${when(store.lastDigest()?.to)}.`);
      if (configProblems().length) { console.log("Watchers: set CRUSTDATA_API_KEY to see their status."); return; }
      for (const w of store.allWatches()) {
        try {
          const info = await crustdata.getWatch(w.dataset, w.watch_id);
          console.log(`${w.dataset === "company" ? "Company" : "Leader"} watcher ${w.watch_id}: ${info.status}, last run ${info.last_run_at?.slice(0, 10) ?? "not yet"}, ${info.credits_consumed ?? 0} credits so far.`);
        } catch (err) { console.log(`${w.dataset} watcher ${w.watch_id}: ${crustdata.explain(err)}`); }
      }
      const balance = await crustdata.getCreditBalance().catch(() => undefined);
      if (balance !== undefined) console.log(`Crustdata balance: ${Math.round(balance)} credits.`);
      return;
    }

    case "refresh-leaders": {
      const ctx = open();
      const { store } = ctx;
      const target = positional[0]?.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
      const list = store.companies().filter(c => c.companyId && (!target || c.domain === target));
      if (!list.length) fail(target ? `${target} is not in the imported portfolio. Run npm run status to see the list.` : "No companies imported yet.");
      if (yes && list.length * 25 * LEADER_PRICE_WORST > config.maxImportCredits) fail(`This search could cost up to ${Math.round(list.length * 25 * LEADER_PRICE_WORST)} credits, over MAX_IMPORT_CREDITS (${config.maxImportCredits}). Run it by hand to confirm, or raise MAX_IMPORT_CREDITS.`);
      if (!(await confirm(`Search founders and C-level again at ${list.length} compan${list.length === 1 ? "y" : "ies"} (at least 1 credit a company, up to ${Math.round(list.length * 25 * LEADER_PRICE_WORST * 100) / 100} at Crustdata's listed price)? Companies whose leaders the portfolio lists are skipped.`))) return;
      const r = await refreshLeaders(ctx, list.map(c => c.domain)).catch(err => fail(crustdata.explain(err)));
      for (const s of r.signals) console.log(`${SEVERITY_LABEL[s.severity]}: ${s.company}: ${s.text}`);
      console.log(`✓ ${r.added} leader${r.added === 1 ? "" : "s"} added or watched again. Credits used: ${r.creditsUsed}.`);
      const posted = await sendAlerts(store);
      if (posted.posted) console.log(`✓ Posted ${posted.posted} update${posted.posted === 1 ? "" : "s"} to Slack.`);
      for (const p of posted.problems) { console.log(`✗ Slack, ${p}`); process.exitCode = 2; }
      return;
    }

    case "pause":
    case "resume": {
      const ctx = open();
      const watches = ctx.store.allWatches();
      if (!watches.length) fail("No watchers yet. Run npm run import first.");
      for (const w of watches) {
        await crustdata.setWatchStatus(w.dataset, w.watch_id, command === "pause" ? "paused" : "active").catch(err => fail(crustdata.explain(err)));
        console.log(`✓ ${w.dataset === "company" ? "Company" : "Leader"} watcher ${w.watch_id} ${command === "pause" ? "paused (catches nothing, costs nothing)" : "running again"}.`);
      }
      return;
    }

    case "delete-watches": {
      const ctx = open();
      const watches = ctx.store.allWatches();
      if (!watches.length) { console.log("No watchers to delete."); return; }
      if (!(await confirm(`Cancel ${watches.map(w => `the ${w.dataset === "company" ? "company" : "leader"} watcher ${w.watch_id}`).join(" and ")}? This cannot be undone (npm run import makes new ones).`))) return;
      for (const w of watches) {
        await crustdata.deleteWatch(w.dataset, w.watch_id).catch(err => fail(crustdata.explain(err)));
        ctx.store.clearWatch(w.dataset);
        console.log(`✓ Cancelled the ${w.dataset === "company" ? "company" : "leader"} watcher ${w.watch_id}.`);
      }
      return;
    }

    case "test-slack": {
      const problems = configProblems({ needKey: false });
      if (problems.length) fail(problems.join("\n"));
      if (!hasSlack()) fail("SLACK_WEBHOOK_URL is not set. Run npm run setup, or see 'Send portfolio alerts to Slack' in the README.");
      const targets: [string, string][] = [["main channel", config.slackWebhookUrl], ...Object.entries(config.slackRoutes).map(([o, u]) => [`${o}'s channel`, u] as [string, string])];
      for (const [label, url] of targets) {
        const problem = await postToSlack({ text: `${config.fundName} portfolio monitor is connected. Alerts for this channel will arrive here.` }, url);
        console.log(problem ? `✗ ${label}: ${problem}` : `✓ ${label}: test message sent`);
        if (problem) process.exitCode = 1;
      }
      return;
    }

    default:
      console.log("Commands: import, check, digest, resend, status, refresh-leaders, pause, resume, delete-watches, test-slack.\nStart with npm run setup. See the README.");
      if (command) process.exitCode = 1;
  }
}

main().catch(err => fail(crustdata.explain(err))).finally(() => { try { openStore?.close(); } catch { /* closed */ } });
