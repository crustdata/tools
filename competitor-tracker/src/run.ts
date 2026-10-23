/**
 * The two jobs the agent does: `init` (resolve competitors, record a starting point, create or reuse the three
 * Crustdata watchers) and `runDigest` (read what the watchers caught, fetch and compare the pages, search the news,
 * build one digest, save it, send it). Every Crustdata call goes through `api`, which tests replace with fixtures.
 *
 * A digest is built inside one database transaction. Nothing is marked as reported until the digest that reports it
 * is saved; a dry run rolls everything back; a stopped key (401/402) aborts before anything is saved or sent. A
 * digest that was saved but not delivered is kept and resent by `resendLast`.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, hasEmail, hasSlack } from "./config.js";
import type { Competitor, Competitors } from "./competitors.js";
import { deriveAbout, withId } from "./competitors.js";
import * as crustdata from "./crustdata.js";
import { anyKeyword, CrustdataError, jobsAtDomains, jobWatchFilters, postsByCompany, postWatchFilters, type Dataset, type Watch } from "./crustdata.js";
import { digestMarkdown, orderCompetitors } from "./digest.js";
import { sendDigestEmail } from "./email.js";
import { headcountBaselineItems, headcountItems, REFERENCE_DAYS, type CompanyRecord } from "./headcount.js";
import { hiringItems, recentJobs, RECENT_DAYS, type JobRecord } from "./hiring.js";
import { fundingBaselineItems, fundingItems, newsItems, newsQuery, type Change } from "./money.js";
import { postItems, watchKeywords, type Keywords, type PostRecord } from "./posts.js";
import { sendDigestToSlack } from "./slack.js";
import { Store, weekLabel, type StoredDigest } from "./store.js";
import type { CompetitorDigest, Digest, Item } from "./types.js";
import { emptySections, isoDate, longDate } from "./types.js";
import { customerItems, diffPages, discoverPages, launchItems, looksBlocked, mergeLinks, pageKind, parsePage, type Page } from "./website.js";

/** The Crustdata calls the runs make. The real module by default; tests pass an object of stubs. */
export type Api = Pick<typeof crustdata,
  "identifyCompanies" | "enrichCompanies" | "searchJobs" | "searchPosts" | "fetchPages" | "searchNews" |
  "createCompanyWatch" | "createJobWatch" | "createPostWatch" | "getWatch" | "listActiveWatches" | "setWatchedCompanies" |
  "deleteWatch" | "newRunRecords" | "getCreditBalance" | "setWatchStatus" | "listRuns">;

export type Deps = {
  store: Store;
  competitors: Competitors;
  keywords: Keywords;
  api?: Api;
  now?: Date;
  log?: (line: string) => void;
  /** Called when competitors.json changes (ids resolved, pages discovered). */
  saveCompetitors?: (c: Competitors) => void;
  /** Show the names of the people who posted (titles only by default). */
  showNames?: boolean;
};

const DAY = 86_400_000;
const WATCH_DATASETS: Dataset[] = ["company", "job", "social_post"];
export const NOT_CHECKED = "not checked this week (see Warnings)";
export const POSTS_OFF = "Posts are off: Social Post Search is not enabled on this Crustdata account. Ask Crustdata to enable it; every other section works.";
const notRunNote = (ds: Dataset) => `the ${WATCH_NAMES[ds]} has not run since the last digest; what it finds will be in the next one`;
const WATCH_NAMES: Record<Dataset, string> = { company: "company changes watcher", job: "hiring watcher", social_post: "posts watcher" };

/** 401 (key rejected) and 402 (out of credits) stop the whole run: a digest of failures helps nobody. */
const isFatal = (err: unknown) => err instanceof CrustdataError && (err.status === 401 || err.status === 402);
const isNotEnabled = (err: unknown) => err instanceof CrustdataError && err.status === 403;

// ---------------------------------------------------------------------------
// Cost estimates (list prices, shown before anything is spent)
// ---------------------------------------------------------------------------

export const PRICES = { page: 1, newsQuery: 1, enrich: 2, companyChange: 5, newJob: 0.5, newPost: 2, weekOnePost: 0.5, weekOneJob: 0.03 };
/** The most the first digest's direct searches can cost per competitor: 100 jobs and 25 posts. */
/** Results asked for by the catch-up search after a watcher is replaced, per competitor. */
export const CATCH_UP = { job: 30, posts: 8 };
export const FIRST_DIGEST_MAX_PER_COMPETITOR = 100 * PRICES.weekOneJob + 25 * PRICES.weekOnePost;

export function estimateInit(n: number, pagesPerCompetitor = config.pagesPerCompetitor): number {
  return n * pagesPerCompetitor * PRICES.page + n * PRICES.enrich;
}

/**
 * A quiet week, a typical busy week (a company change, 10 new jobs and 4 posts per competitor) and the ceiling the
 * watcher caps allow, in credits at list price.
 */
export function estimateWeek(n: number, pagesPerCompetitor = config.pagesPerCompetitor, maxJobs = config.maxJobsPerWeek, maxPosts = config.maxPostsPerWeek): { quiet: number; busy: number; ceiling: number } {
  const quiet = n * pagesPerCompetitor * PRICES.page + n * PRICES.newsQuery;
  const busy = quiet + n * PRICES.companyChange + n * 10 * PRICES.newJob + n * 4 * PRICES.newPost;
  const ceiling = quiet + n * PRICES.companyChange + 7 * crustdata.perDailyRun(maxJobs) * PRICES.newJob + 7 * crustdata.perDailyRun(maxPosts) * PRICES.newPost;
  return { quiet, busy, ceiling };
}

/** Competitors whose starting point (pages and company record) is not saved yet: what init will pay for. */
export const needsStartingPoint = (store: Store, c: Competitors): Competitor[] =>
  c.competitors.filter(x => !store.getMeta(`pages_discovered_${x.domain}`) || (x.crustdata_company_id && !store.getCompanyRecord(x.domain)) || !x.crustdata_company_id);

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export type InitResult = { resolved: Competitor[]; unresolved: string[]; pagesSaved: number; watches: Record<Dataset, number | undefined>; creditsUsed: number; notes: string[] };

/** Sets up what is missing. Safe to run again: competitors and watchers already set up are not paid for twice. */
export async function init(deps: Deps): Promise<InitResult> {
  const { store, competitors } = deps;
  const api = deps.api ?? crustdata;
  const log = deps.log ?? (() => {});
  const before = crustdata.creditsUsed.total;
  const notes: string[] = [];

  // 1. Resolve every competitor to a Crustdata company (free).
  const missing = competitors.competitors.filter(c => !c.crustdata_company_id);
  if (missing.length) {
    const found = await api.identifyCompanies(missing.map(c => c.domain), "domains");
    for (const c of missing) {
      const hit = found.find(f => f.input === c.domain && f.id);
      if (hit) { c.crustdata_company_id = hit.id; if (c.name === c.domain && hit.name) c.name = hit.name; if (!c.about) c.about = deriveAbout(hit.description); }
    }
    const stillMissing = missing.filter(c => !c.crustdata_company_id);
    if (stillMissing.length) {
      const byName = await api.identifyCompanies(stillMissing.map(c => c.name), "names");
      for (const c of stillMissing) {
        const hit = byName.find(f => f.input === c.name && f.id && f.domain && f.domain.toLowerCase() === c.domain);
        if (hit) c.crustdata_company_id = hit.id;
      }
    }
    deps.saveCompetitors?.(competitors);
  }
  for (const c of competitors.competitors) if (!c.about) c.about = "software";
  const unresolved = competitors.competitors.filter(c => !c.crustdata_company_id).map(c => c.domain);
  for (const d of unresolved) log(`  ${d}: not in Crustdata's company index yet; website and news sections only.`);

  // 2. The starting point of every page (1 credit per page), for competitors that do not have one yet.
  let pagesSaved = 0;
  for (const c of competitors.competitors) {
    if (store.getMeta(`pages_discovered_${c.domain}`) && store.pagesFor(c.domain).length) continue;
    const home = `https://${c.domain}/`;
    const chosen = (c.pages ?? []).filter(p => pageKind(p) !== "home");
    const [homePage] = await fetchAndParse(api, c, [home], log);
    const blocked = homePage ? looksBlocked(homePage) : null;
    if (!homePage || blocked) {
      log(`  ${c.domain}: homepage ${blocked ? `not usable (${blocked})` : "could not be fetched"}; the next digest tries again.`);
      c.pages = c.pages?.length ? c.pages : [home];
      continue;
    }
    store.savePage(homePage);
    pagesSaved++;
    if (store.lastDigest()) addNewDomain(store, c.domain); // added after the first digest: give it a 7-day view
    c.pages = chosen.length ? [home, ...chosen].slice(0, 10) : discoverPages(homePage, config.pagesPerCompetitor);
    store.setMeta(`pages_discovered_${c.domain}`, (deps.now ?? new Date()).toISOString());
    const rest = c.pages.filter(p => p !== home).slice(0, config.pagesPerCompetitor - 1);
    for (const p of await fetchAndParse(api, c, rest, log)) { if (!looksBlocked(p)) { store.savePage(p); pagesSaved++; } }
  }
  deps.saveCompetitors?.(competitors);

  // 3. One company record per competitor (2 credits each): the reference for headcount and funding.
  const ids = withId(competitors.competitors);
  const needRecord = ids.filter(c => !store.getCompanyRecord(c.domain));
  if (needRecord.length) {
    const records = await api.enrichCompanies(needRecord.map(c => c.crustdata_company_id));
    for (const c of needRecord) {
      const r = records[c.crustdata_company_id];
      if (r) store.saveCompanyRecord(c.domain, r, (deps.now ?? new Date()).toISOString());
    }
  }

  // 4. The three watchers, with the user's key and no delivery channel: the digest reads their runs.
  const watches = await ensureWatches(deps, api, log, notes);
  store.setMeta("initialized_at", (deps.now ?? new Date()).toISOString());
  return { resolved: ids, unresolved, pagesSaved, watches, creditsUsed: crustdata.creditsUsed.total - before, notes };
}

/** What each watch should look like for the current competitors, keywords and caps. */
function desiredWatches(competitors: Competitors, keywords: Keywords) {
  const ids = withId(competitors.competitors);
  return {
    company: { ids: ids.map(c => c.crustdata_company_id).sort((a, b) => a - b) },
    job: { filters: jobWatchFilters(competitors.competitors.map(c => c.domain).sort()), max: config.maxJobsPerWeek },
    social_post: { filters: postWatchFilters(ids.map(c => ({ id: c.crustdata_company_id, name: c.name })).sort((a, b) => a.id - b.id), watchKeywords(keywords)), max: config.maxPostsPerWeek },
  };
}

/** JSON with object keys sorted, for comparing a watch definition with what the API echoes back. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Competitors the watchers do not cover yet (added to competitors.json after the last npm run init), per watcher,
 * read from the definition saved when each watcher was set up. Free: no API call.
 */
export function uncoveredDomains(store: Store, competitors: Competitors, keywords: Keywords): Map<Dataset, Set<string>> {
  const out = new Map<Dataset, Set<string>>();
  const desired = desiredWatches(competitors, keywords);
  for (const ds of WATCH_DATASETS) {
    const saved = store.getMeta(`watch_signature_${ds}`);
    if (!store.getWatchId(ds) || !saved || saved === canonical(desired[ds])) continue;
    const missing = new Set<string>();
    for (const c of withId(competitors.competitors)) {
      const inside = ds === "company" ? (JSON.parse(saved).ids ?? []).includes(c.crustdata_company_id)
        : ds === "job" ? saved.includes(JSON.stringify(c.domain))
        : saved.includes(`"value":${c.crustdata_company_id}}`);
      if (!inside) missing.add(c.domain);
    }
    if (missing.size) out.set(ds, missing);
  }
  return out;
}

/** Which watchers npm run init would replace (filters are fixed once created), and what their catch-up search costs. */
export function watchersToReplace(store: Store, competitors: Competitors, keywords: Keywords): { datasets: Dataset[]; catchUpCredits: number } {
  const desired = desiredWatches(competitors, keywords);
  const datasets = (["job", "social_post"] as const).filter(ds => store.getWatchId(ds) && store.getMeta(`watch_signature_${ds}`) !== canonical(desired[ds]));
  const perCompetitor = datasets.reduce((sum, ds) => sum + (ds === "job" ? CATCH_UP.job * PRICES.weekOneJob : CATCH_UP.posts * PRICES.weekOnePost), 0);
  return { datasets: [...datasets], catchUpCredits: Math.round(perCompetitor * withId(competitors.competitors).length * 10) / 10 };
}

/** Does an existing watch on the account already do exactly this job (so it can be reused instead of duplicated)? */
function matches(ds: Dataset, w: Watch, desired: ReturnType<typeof desiredWatches>): boolean {
  if ((w as any).notifications?.length) return false; // a watch that posts somewhere was made for something else
  if (ds === "company") {
    const have = [...(w.entities?.crustdata_company_ids ?? [])].sort((a, b) => a - b);
    return canonical(have) === canonical(desired.company.ids) && canonical(w.track) === canonical(crustdata.COMPANY_TRACK);
  }
  return canonical(w.filters) === canonical(ds === "job" ? desired.job.filters : desired.social_post.filters);
}

/**
 * Makes the account hold exactly the three watches this list needs: keeps ones that match, updates the company
 * watch's list in place, replaces job and post watches whose filters changed (filters are fixed once created), reuses
 * a matching watch already on the account (made by another copy of this tool), and creates the rest. Each watch's
 * definition is saved right after it is created, so a failure halfway never recreates the ones that worked.
 */
export async function ensureWatches(deps: Deps, api: Api, log: (s: string) => void, notes: string[] = []): Promise<Record<Dataset, number | undefined>> {
  const { store, competitors, keywords } = deps;
  const out: Record<Dataset, number | undefined> = { company: undefined, job: undefined, social_post: undefined };
  if (!withId(competitors.competitors).length) return out;
  const desired = desiredWatches(competitors, keywords);

  for (const ds of WATCH_DATASETS) {
    const signature = canonical(desired[ds]);
    const existingId = store.getWatchId(ds);
    let existing: Watch | undefined;
    if (existingId) {
      try { existing = await api.getWatch(ds, existingId); } catch (err) { if (!(err instanceof CrustdataError && err.status === 404)) throw err; }
      if (!existing || /^cancel/.test(existing.status)) { log(`  ${WATCH_NAMES[ds]} ${existingId} no longer exists; setting up a new one.`); store.clearWatch(ds); existing = undefined; }
      else if (existing.status === "paused") notes.push(`The ${WATCH_NAMES[ds]} (${existing.id}) is paused; npm run resume turns it back on.`);
    }
    if (existing) {
      if (ds === "company") {
        const have = [...(existing.entities?.crustdata_company_ids ?? [])].sort((a, b) => a - b);
        if (canonical(have) !== canonical(desired.company.ids)) { await api.setWatchedCompanies(existing.id, desired.company.ids); log(`  ${WATCH_NAMES[ds]} ${existing.id}: list updated (${desired.company.ids.length} companies).`); }
        store.setMeta(`watch_signature_${ds}`, signature);
        out[ds] = existing.id;
        continue;
      }
      if (store.getMeta(`watch_signature_${ds}`) === signature) { out[ds] = existing.id; continue; }
      // Filters are fixed once created, so the watcher is replaced. The old one is paused (it bills nothing more) and
      // retired: the next digest reads what it caught before the switch, then deletes it, and runs a short catch-up
      // search so nothing posted between its last run and the new watcher's start is missed.
      await api.setWatchStatus(ds, existing.id, "paused").catch(err => notes.push(`Could not pause the old ${WATCH_NAMES[ds]} ${existing!.id} (${crustdata.explain(err)}); the next digest deletes it.`));
      retireWatch(store, ds, existing.id);
      store.clearWatch(ds);
      store.setMeta(`gap_since_${ds}`, existing.last_run_at ?? (deps.now ?? new Date()).toISOString());
      log(`  ${WATCH_NAMES[ds]} ${existing.id} replaced (the competitor list or post words changed, and filters are fixed once created); the next digest reads what it caught, then deletes it.`);
    }

    // Reuse a matching watch already on the account, for example one made by init on a laptop before moving to CI.
    let adopted: Watch | undefined;
    const retired = new Set(retiredWatches(store, ds));
    try { adopted = (await api.listActiveWatches(ds)).find(w => (w.status ?? "active") === "active" && !retired.has(w.id) && matches(ds, w, desired)); } catch { adopted = undefined; }
    if (adopted) {
      // What it caught before it was adopted belongs to whoever ran it then: mark those runs as read.
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const { runs, next_cursor } = await api.listRuns(ds, adopted.id, 20, cursor);
        for (const r of runs ?? []) if (crustdata.FINISHED.has(r.status)) store.markRunSeen(ds, r.id);
        if (!next_cursor) break;
        cursor = next_cursor;
      }
      store.setWatchId(ds, adopted.id);
      store.setMeta(`watch_signature_${ds}`, signature);
      store.setMeta(`disabled_${ds}`, "");
      out[ds] = adopted.id;
      log(`  ${WATCH_NAMES[ds]} ${adopted.id} already exists on your account; using it.`);
      continue;
    }

    let created: Watch;
    try {
      created =
        ds === "company" ? await api.createCompanyWatch(desired.company.ids)
        : ds === "job" ? await api.createJobWatch(competitors.competitors.map(c => c.domain).sort(), config.maxJobsPerWeek)
        : await api.createPostWatch(withId(competitors.competitors).map(c => ({ id: c.crustdata_company_id, name: c.name })).sort((a, b) => a.id - b.id), watchKeywords(keywords), config.maxPostsPerWeek);
    } catch (err) {
      if (!isNotEnabled(err)) throw err;
      const message = `${ds === "social_post" ? "Social post search" : "This watcher"} is not enabled on your Crustdata account, so ${ds === "social_post" ? "Posts are" : `the ${WATCH_NAMES[ds]} is`} skipped. Ask Crustdata to enable it, then run npm run init.`;
      store.setMeta(`disabled_${ds}`, message);
      notes.push(message);
      continue;
    }
    store.setWatchId(ds, created.id);
    store.setMeta(`watch_signature_${ds}`, signature);
    store.setMeta(`disabled_${ds}`, "");
    out[ds] = created.id;
    log(`  ${WATCH_NAMES[ds]} ${created.id} created (${created.credits?.per_notification ?? "?"} credits per item it catches, checks ${ds === "company" ? "weekly" : "daily"}).`);
  }
  return out;
}

/** Competitors added since the last digest: the next digest searches their last 7 days. */
export const newDomains = (store: Store): string[] => { try { return JSON.parse(store.getMeta("new_domains") || "[]"); } catch { return []; } };
function addNewDomain(store: Store, domain: string): void { store.setMeta("new_domains", JSON.stringify([...new Set([...newDomains(store), domain])])); }

/** Watchers replaced by init, waiting to be read one last time and deleted. */
export const retiredWatches = (store: Store, ds: Dataset): number[] => { try { return JSON.parse(store.getMeta(`retired_${ds}`) || "[]"); } catch { return []; } };
function retireWatch(store: Store, ds: Dataset, id: number): void {
  store.setMeta(`retired_${ds}`, JSON.stringify([...new Set([...retiredWatches(store, ds), id])]));
}

async function fetchAndParse(api: Api, c: Competitor, urls: string[], log: (s: string) => void): Promise<Page[]> {
  if (!urls.length) return [];
  const fetched = await api.fetchPages(urls);
  const out: Page[] = [];
  for (const f of fetched) {
    if (!f.success || !f.content) { log(`  ${c.domain}: could not fetch ${f.url}${f.http_status ? ` (${f.http_status})` : ""}`); continue; }
    out.push(parsePage(f.url, c.domain, f.content, f.title));
  }
  return out;
}

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

export type Delivery = string | null | "skipped";
export type DigestResult = { digest: Digest; markdown: string; id?: number; file?: string; slack: Delivery; email: Delivery };

export async function runDigest(deps: Deps, { send = true, writeFile = true, dryRun = false } = {}): Promise<DigestResult> {
  const { store } = deps;
  const api = deps.api ?? crustdata;
  // A rejected key or an empty account stops here, before anything is saved, sent or marked as reported.
  await api.getCreditBalance();
  store.begin();
  let built: { digest: Digest; markdown: string; competitorsChanged: boolean; retiredDone: { ds: Dataset; id: number }[] };
  try {
    built = await buildDigest(deps, api);
  } catch (err) {
    store.rollback();
    throw err;
  }
  const now = deps.now ?? new Date();
  if (dryRun) {
    store.rollback();
    return { digest: built.digest, markdown: built.markdown, slack: "skipped", email: "skipped" };
  }
  const id = store.saveDigest(built.digest, built.markdown, now.toISOString(), { slack: hasSlack(), email: hasEmail() });
  store.commit();
  // Pages found during this digest (for a competitor whose homepage failed at init) are written only now.
  if (built.competitorsChanged) {
    try { deps.saveCompetitors?.(deps.competitors); }
    catch (err) { (deps.log ?? console.log)(`  Could not update competitors.json (${(err as Error).message}); the pages found will be looked for again next time.`); for (const c of deps.competitors.competitors) store.deleteMeta(`pages_discovered_${c.domain}`); }
  }

  // Replaced watchers read one last time in this digest are deleted now (outside the transaction, after save). One
  // whose read failed stays retired and is read again next time.
  for (const ds of WATCH_DATASETS) {
    const done = new Set(built.retiredDone.filter(r => r.ds === ds).map(r => r.id));
    const left: number[] = [];
    for (const old of retiredWatches(store, ds)) {
      if (!done.has(old)) { left.push(old); continue; }
      try { await api.deleteWatch(ds, old); } catch { left.push(old); }
    }
    store.setMeta(`retired_${ds}`, JSON.stringify(left));
  }

  let file: string | undefined;
  if (writeFile) file = writeDigestFile(built.markdown, now);
  const sent = send ? await deliver(store, id, built.digest, { slack: true, email: true }) : { slack: "skipped" as Delivery, email: "skipped" as Delivery };
  return { digest: built.digest, markdown: built.markdown, id, file, ...sent };
}

/** digests/2026-10-26.md, or 2026-10-26-2.md for a second digest the same day. */
function writeDigestFile(markdown: string, now: Date): string {
  mkdirSync(config.digestDir, { recursive: true });
  const day = isoDate(now)!;
  let file = resolve(config.digestDir, `${day}.md`);
  for (let i = 2; existsSync(file); i++) file = resolve(config.digestDir, `${day}-${i}.md`);
  writeFileSync(file, markdown);
  return file;
}

/** Sends a saved digest to the configured channels it has not reached yet, and records each success. */
export async function deliver(store: Store, id: number, digest: Digest, want: { slack: boolean; email: boolean }): Promise<{ slack: Delivery; email: Delivery }> {
  let slack: Delivery = "skipped";
  let email: Delivery = "skipped";
  if (want.slack && hasSlack()) {
    slack = await sendDigestToSlack(digest, store.slackDelivered(id), n => store.setSlackDelivered(id, n));
    if (!slack) store.markDigestSent(id, "slack");
  }
  if (want.email && hasEmail()) { email = await sendDigestEmail(digest); if (!email) store.markDigestSent(id, "email"); }
  return { slack, email };
}

/** Did a channel that was set up when this digest was made miss it? (A channel added later is not owed old digests.) */
const owed = (d: StoredDigest) => (hasSlack() && d.wantSlack && !d.sentSlack) || (hasEmail() && d.wantEmail && !d.sentEmail);

/** The digests a set-up channel has not received yet, oldest first (the last 8 weeks at most). */
export function undeliveredAll(store: Store): StoredDigest[] {
  return store.recentDigests(8).filter(owed).reverse();
}
/** The newest digest a set-up channel has not received, if any. */
export function undelivered(store: Store): StoredDigest | undefined {
  return undeliveredAll(store).at(-1);
}

/** Sends every digest a channel missed, oldest first. Stops at the first failure so the order is kept. */
export async function resendPending(store: Store): Promise<{ digest?: StoredDigest; slack: Delivery; email: Delivery; count: number }> {
  let last: { digest?: StoredDigest; slack: Delivery; email: Delivery } = { slack: "skipped", email: "skipped" };
  let count = 0;
  for (const d of undeliveredAll(store)) {
    const sent = await deliver(store, d.id, d.digest, { slack: d.wantSlack && !d.sentSlack, email: d.wantEmail && !d.sentEmail });
    last = { digest: d, ...sent };
    count++;
    if ((sent.slack && sent.slack !== "skipped") || (sent.email && sent.email !== "skipped")) break;
  }
  return { ...last, count };
}

/** Sends the last digest again: to the channels that missed it, or to every channel with `all`. */
export async function resendLast(store: Store, { all = false } = {}): Promise<{ digest?: StoredDigest; slack: Delivery; email: Delivery }> {
  const last = store.lastDigest();
  if (!last) return { slack: "skipped", email: "skipped" };
  if (all) store.setSlackDelivered(last.id, 0); // --all sends every message again
  const sent = await deliver(store, last.id, last.digest, { slack: all || (last.wantSlack && !last.sentSlack), email: all || (last.wantEmail && !last.sentEmail) });
  return { digest: last, ...sent };
}

async function buildDigest(deps: Deps, api: Api): Promise<{ digest: Digest; markdown: string; competitorsChanged: boolean; retiredDone: { ds: Dataset; id: number }[] }> {
  const { store, competitors, keywords } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? new Date();
  const before = crustdata.creditsUsed.total;
  const warnings: string[] = [];
  const stopOrWarn = (what: string, err: unknown) => { if (isFatal(err)) throw err; warnings.push(`${what} (${crustdata.explain(err)})`); };

  const last = store.lastDigest();
  const firstRun = !last;
  const since = last ? new Date(last.createdAt) : new Date(now.getTime() - 7 * DAY);
  const sinceDate = isoDate(since)!;
  const weeks = Math.max(1, Math.round((now.getTime() - since.getTime()) / (7 * DAY)));
  const week = weekLabel(now);
  const initialized = Boolean(store.getMeta("initialized_at"));
  if (!initialized) warnings.push("npm run init has not been run, so there are no watchers: hiring, headcount, posts and funding come from direct searches this week.");

  const results = new Map<string, CompetitorDigest>();
  for (const c of competitors.competitors) results.set(c.domain, { name: c.name, domain: c.domain, sections: emptySections() });
  const byId = new Map<number, Competitor>(withId(competitors.competitors).map(c => [c.crustdata_company_id, c]));
  const byName = new Map<string, Competitor>(competitors.competitors.map(c => [c.name.toLowerCase(), c]));
  let competitorsChanged = false;

  // 1. Website: fetch, compare with the stored snapshot, store the new one (links kept as a union over weeks).
  for (const c of competitors.competitors) {
    const r = results.get(c.domain)!;
    const urls = (c.pages?.length ? c.pages : [`https://${c.domain}/`]).slice(0, config.pagesPerCompetitor);
    let pages: Page[] = [];
    const failed: string[] = [];
    try { pages = await fetchAndParse(api, c, urls, line => { log(line); failed.push(line.trim()); }); }
    catch (err) { stopOrWarn(`${c.domain}: pages not fetched`, err); }
    warnings.push(...failed);
    let compared = 0;
    const notes: string[] = [];
    for (const p of pages) {
      const prev = store.getPage(p.url);
      const blocked = looksBlocked(p, prev);
      if (blocked) {
        // A currency switch or a much shorter page two runs in a row is the page's new normal: keep it as the
        // reference from now on (a bot check never is).
        const skipKey = `skipped_${p.url}`;
        const acceptable = /^prices came back|^the page came back mostly empty/.test(blocked);
        if (acceptable && store.getMeta(skipKey)) {
          store.deleteMeta(skipKey);
          store.savePage({ ...p, links: mergeLinks(p.links, prev?.links), logos: [...new Set([...p.logos, ...(prev?.logos ?? [])])].slice(0, 500) });
          notes.push(/^prices/.test(blocked) ? `${p.url} now shows prices in another currency; compared again from next week` : `${p.url} is now much shorter than it was (a redesign?); compared again from next week`);
        } else {
          if (acceptable) store.setMeta(skipKey, now.toISOString());
          notes.push(`not compared this week: ${p.url} (${blocked})`);
        }
        continue;
      }
      if (store.getMeta(`skipped_${p.url}`)) store.deleteMeta(`skipped_${p.url}`);
      if (prev) {
        compared++;
        const diff = diffPages(prev, p);
        if (diff.tooBig) notes.push(`skipped ${p.url}: too large to compare line by line`);
        r.sections.launches.items.push(...launchItems(diff, p));
        r.sections.customers.items.push(...customerItems(diff, p));
      }
      store.savePage({ ...p, links: mergeLinks(p.links, prev?.links), logos: [...new Set([...p.logos, ...(prev?.logos ?? [])])].slice(0, 500) });
      // Pages for a competitor whose homepage failed at init are found now, and compared from next week.
      if (pageKind(p.url) === "home" && !store.getMeta(`pages_discovered_${c.domain}`)) {
        const chosen = (c.pages ?? []).filter(u => pageKind(u) !== "home");
        c.pages = chosen.length ? [p.url, ...chosen] : discoverPages(p, config.pagesPerCompetitor);
        store.setMeta(`pages_discovered_${c.domain}`, now.toISOString());
        competitorsChanged = true;
      }
    }
    const missingPages = urls.length - pages.length;
    if (!pages.length) {
      r.sections.launches.note = r.sections.customers.note = NOT_CHECKED;
    } else {
      if (missingPages > 0) {
        const pricingMissing = urls.some(u => pageKind(u) === "pricing" && !pages.some(p => p.url === u));
        notes.push(pricingMissing ? "the pricing page could not be fetched this week" : `${missingPages} of ${urls.length} pages could not be fetched this week`);
      }
      if (!compared && !notes.length) r.sections.launches.note = r.sections.customers.note = "starting point saved; changes show from next week";
    }
    if (notes.length && !r.sections.launches.note) r.sections.launches.note = notes.join("; ");
  }

  // 2. News since the last digest (1 credit per competitor).
  for (const c of competitors.competitors) {
    const r = results.get(c.domain)!;
    try {
      const found = await api.searchNews(newsQuery(c), since);
      r.sections.money.items.push(...store.firstTime("news", newsItems(found, c), i => i.url ?? i.text));
    } catch (err) {
      stopOrWarn(`${c.domain}: news search failed`, err);
      r.sections.money.note = NOT_CHECKED;
    }
  }

  // 3. What the watchers caught since the last digest, oldest run first.
  const jobsByDomain = new Map<string, JobRecord[]>();
  const postsByDomain = new Map<string, PostRecord[]>();
  const companyChanges = new Map<string, { changes: Change[]; record: CompanyRecord }>();
  const unchecked = new Set<Dataset>();
  /** Replaced watchers read successfully (or already gone): safe to delete once the digest is saved. */
  const retiredDone: { ds: Dataset; id: number }[] = [];
  /** Watchers that have not run since the last digest: their sections say so instead of "nothing new". */
  const notRunYet = new Set<Dataset>();
  let watcherCredits = 0;
  for (const ds of WATCH_DATASETS) {
    const id = store.getWatchId(ds);
    if (!id) {
      const disabled = store.getMeta(`disabled_${ds}`);
      if (disabled) unchecked.add(ds);
      else if (initialized && withId(competitors.competitors).length) { warnings.push(`The ${WATCH_NAMES[ds]} is missing. Run npm run init to set it up.`); unchecked.add(ds); }
    } else {
      // Is it on, and has it run since the last digest? (free)
      try {
        const w = await api.getWatch(ds, id);
        if (w.status && w.status !== "active") {
          const why = w.status === "paused" ? "it is paused (npm run resume turns it back on)" : w.status === "suspended" ? "Crustdata suspended it, most often for a low credit balance (top up at https://app.crustdata.com)" : `its status is ${w.status}`;
          warnings.push(`The ${WATCH_NAMES[ds]} is not running: ${why}.`);
          unchecked.add(ds);
        } else if (last && (!w.last_run_at || new Date(w.last_run_at) < new Date(last.createdAt)) && new Date(w.created_at ?? 0) < new Date(last.createdAt)) {
          notRunYet.add(ds);
        }
      } catch (err) { if (isFatal(err)) throw err; /* a 404 is reported when the runs are read */ }
    }
    // The current watcher, plus any replaced one still waiting to be read one last time.
    for (const watchId of [...(id ? [id] : []), ...retiredWatches(store, ds)]) {
      const current = watchId === id;
      let runs: crustdata.RunList = [];
      try { runs = await api.newRunRecords(ds, watchId, store.seenRunIds(ds)); }
      catch (err) {
        if (err instanceof CrustdataError && err.status === 404) {
          if (!current) retiredDone.push({ ds, id: watchId });
          if (current) {
            warnings.push(`The ${WATCH_NAMES[ds]} was deleted in your Crustdata account; this week's ${ds === "company" ? "headcount and funding were not checked" : `${ds === "job" ? "hiring comes" : "posts come"} from a direct search instead`}. Run npm run init to set it up again.`);
            store.clearWatch(ds);
            unchecked.add(ds);
          }
        } else { stopOrWarn(`The ${WATCH_NAMES[ds]} could not be read`, err); unchecked.add(ds); }
        continue;
      }
      // A replaced watcher is deleted only once nothing is left to read: a run still in progress waits for next week.
      if (!current && !runs.pending) retiredDone.push({ ds, id: watchId });
      if (runs.some(r => r.run.status === "SUCCESS")) {
        notRunYet.delete(ds);
        // The post watcher delivers, so post search works on this account after all.
        if (ds === "social_post" && current) store.deleteMeta("disabled_social_post");
      }
      for (const { run, records, baseline } of runs) {
      watcherCredits += Number(run.credits_deducted ?? 0);
      if (run.status === "FAILED" || run.status === "SKIPPED") {
        const reason = (run as any).failure_reason ? ` (Crustdata: ${String((run as any).failure_reason).replace(/_/g, " ").toLowerCase()})` : "";
        warnings.push(`A run of the ${WATCH_NAMES[ds]} on ${longDate(run.started_at)} did not complete${reason}; what it would have caught may be missing.${/credit/i.test(reason) ? " Top up at https://app.crustdata.com." : ""}`);
        unchecked.add(ds);
      }
      if (!baseline) {
        for (const rec of records) {
          if (!rec || typeof rec !== "object") continue; // a blank or broken line in the download
          if (ds === "company") {
            const record: CompanyRecord = rec.record ?? rec;
            const c = record.crustdata_company_id ? byId.get(record.crustdata_company_id) : undefined;
            if (!c) continue;
            const prev = companyChanges.get(c.domain);
            companyChanges.set(c.domain, { changes: [...(prev?.changes ?? []), ...((rec.changes ?? []) as Change[])], record }); // newest record wins
          } else if (ds === "job") {
            const job = rec as JobRecord;
            const c = (job.company?.basic_info?.crustdata_company_id && byId.get(job.company.basic_info.crustdata_company_id)) || competitors.competitors.find(x => x.domain === (job.company?.basic_info?.primary_domain ?? "").toLowerCase());
            if (c) jobsByDomain.set(c.domain, [...(jobsByDomain.get(c.domain) ?? []), job]);
          } else {
            const post = rec as PostRecord;
            const c = (post.actor?.actor_type === "company" && post.actor.crustdata_entity_id && byId.get(post.actor.crustdata_entity_id)) || (post.actor?.company_name ? byName.get(post.actor.company_name.toLowerCase()) : undefined);
            if (c) postsByDomain.set(c.domain, [...(postsByDomain.get(c.domain) ?? []), post]);
          }
        }
      }
      store.markRunSeen(ds, run.id);
      }
    }
  }

  // 4. Direct searches. The last 7 days on the first digest, for a competitor added since the last digest, or when a
  // watcher is missing. After a watcher was replaced, only the short gap since the old one last ran (about a day),
  // because the new watcher's free first run records everything that existed when it was made.
  const fresh = new Set(newDomains(store));
  // A competitor added with npm run add but not yet passed to npm run init is not in the watchers: search it directly.
  const uncovered = uncoveredDomains(store, competitors, keywords);
  const notWatched = [...new Set([...uncovered.values()].flatMap(set => [...set]))];
  if (notWatched.length) warnings.push(`Not in the watchers yet: ${notWatched.join(", ")}. Run npm run init so the watchers cover ${notWatched.length === 1 ? "it" : "them"}; until then hiring and posts come from a direct search of the last 7 days, and headcount is not checked.`);
  const gapSince = (ds: Dataset) => store.getMeta(`gap_since_${ds}`) || "";
  const failedSearch = new Map<string, Set<Dataset>>();
  const markFailed = (domain: string, ds: Dataset) => failedSearch.set(domain, new Set([...(failedSearch.get(domain) ?? []), ds]));
  for (const c of withId(competitors.competitors)) {
    for (const ds of ["job", "social_post"] as const) {
      if (store.getMeta(`disabled_${ds}`)) continue;
      const full = firstRun || !store.getWatchId(ds) || fresh.has(c.domain) || uncovered.get(ds)?.has(c.domain);
      const gap = gapSince(ds);
      if (!full && !gap) continue;
      const from = full ? since : new Date(Math.min(new Date(gap).getTime() || now.getTime(), now.getTime() - DAY));
      try {
        if (ds === "job") {
          const res = await api.searchJobs({ op: "and", conditions: [jobsAtDomains([c.domain]), { field: "metadata.date_added", type: "=>", value: from.toISOString().slice(0, 19) }] }, { limit: full ? 100 : CATCH_UP.job, sorts: [{ field: "metadata.date_added", order: "desc" }] });
          jobsByDomain.set(c.domain, [...(jobsByDomain.get(c.domain) ?? []), ...(res.job_listings ?? [])]);
        } else {
          // The gap since the old watcher last ran, in whole days (at most 30); a day or less is "now-24h".
          const days = Math.min(30, Math.ceil((now.getTime() - from.getTime()) / DAY));
          const window = full ? "now-7d" : days <= 1 ? "now-24h" : `now-${days}d`;
          const res = await api.searchPosts({ op: "and", conditions: [{ field: "date_posted", type: "=>", value: window }, postsByCompany({ id: c.crustdata_company_id, name: c.name }), anyKeyword(watchKeywords(keywords))] }, { limit: full ? 25 : CATCH_UP.posts, sorts: [{ field: "date_posted", order: "desc" }] });
          postsByDomain.set(c.domain, [...(postsByDomain.get(c.domain) ?? []), ...(res.posts ?? [])]);
        }
        if (!store.getWatchId(ds)) unchecked.delete(ds);
      } catch (err) {
        if (ds === "social_post" && isNotEnabled(err) && !store.getWatchId("social_post")) { store.setMeta("disabled_social_post", POSTS_OFF); unchecked.add("social_post"); }
        else { stopOrWarn(`${c.domain}: ${ds === "job" ? "job" : "post"} search failed`, err); markFailed(c.domain, ds); }
      }
    }
  }

  // 5. Per competitor: hiring, headcount, money, posts.
  for (const c of competitors.competitors) {
    const r = results.get(c.domain)!;
    const stored = store.getCompanyRecord(c.domain);
    if (!c.crustdata_company_id) {
      r.sections.hiring.note = r.sections.headcount.note = r.sections.posts.note = "not in Crustdata's company index yet";
      continue;
    }

    // Hiring: recent postings, plus a free count of listings posted in the last 30 days.
    let recentNow: number | null = null;
    try {
      const since30 = new Date(now.getTime() - RECENT_DAYS * DAY).toISOString().slice(0, 19);
      recentNow = (await api.searchJobs({ op: "and", conditions: [jobsAtDomains([c.domain]), { field: "metadata.date_added", type: "=>", value: since30 }] }, { limit: 0 })).total_count ?? null;
    } catch (err) { if (isFatal(err)) throw err; recentNow = null; }
    const history = store.weeklyJobs(c.domain);
    const recentBefore = history.find(h => h.week !== week && h.recentJobs !== null)?.recentJobs ?? null;
    const newJobs = store.firstTime("job", recentJobs(jobsByDomain.get(c.domain) ?? [], now), j => String(j.crustdata_job_id ?? j.job_details?.url ?? ""));
    r.sections.hiring.items.push(...hiringItems({ newJobs, places: competitors.cities, history, currentWeek: week, weeks, recentNow, recentBefore }));
    store.addWeeklyJobs(c.domain, week, newJobs.length, recentNow);
    if ((unchecked.has("job") || failedSearch.get(c.domain)?.has("job")) && !r.sections.hiring.items.length) r.sections.hiring.note = NOT_CHECKED;
    else if (notRunYet.has("job") && !r.sections.hiring.items.length) r.sections.hiring.note = notRunNote("job");

    // Headcount and money. The reference record stays until a move is reported or it is about a month old.
    const change = companyChanges.get(c.domain);
    if (change) {
      const items = headcountItems(stored?.record, change.record, stored?.recordedAt, now.toISOString());
      r.sections.headcount.items.push(...items);
      const age = stored ? now.getTime() - new Date(stored.recordedAt).getTime() : Infinity;
      if (items.length || age >= REFERENCE_DAYS * DAY) store.saveCompanyRecord(c.domain, change.record, now.toISOString());
      r.sections.money.items.push(...store.firstTime("money", fundingItems(change.changes, change.record, sinceDate), i => (i.url ? `${i.text}|${i.url}` : i.text)));
    } else if (firstRun && stored) {
      r.sections.headcount.items.push(...headcountBaselineItems(stored.record));
      r.sections.money.items.push(...store.firstTime("money", fundingBaselineItems(stored.record, sinceDate), i => (i.url ? `${i.text}|${i.url}` : i.text)));
    }
    if ((unchecked.has("company") || uncovered.get("company")?.has(c.domain)) && !r.sections.headcount.items.length) r.sections.headcount.note = NOT_CHECKED;
    if (unchecked.has("company") && !r.sections.money.items.length && !r.sections.money.note) r.sections.money.note = "news searched; Crustdata funding data not checked this week (see Warnings)";
    else if (notRunYet.has("company") && !r.sections.headcount.items.length) r.sections.headcount.note = notRunNote("company");

    // Posts.
    const posts = store.firstTime("post", postsByDomain.get(c.domain) ?? [], p => p.share_url ?? p.backend_urn ?? p.entity_urn ?? "");
    r.sections.posts.items.push(...postItems(posts, keywords, { companyName: c.name, showNames: deps.showNames }));
    if (store.getMeta("disabled_social_post") && !r.sections.posts.items.length) r.sections.posts = { items: [], note: "off on this Crustdata account (see the note at the top)", accountWide: true };
    else if ((unchecked.has("social_post") || failedSearch.get(c.domain)?.has("social_post")) && !r.sections.posts.items.length) r.sections.posts.note = NOT_CHECKED;
    else if (notRunYet.has("social_post") && !r.sections.posts.items.length) r.sections.posts.note = notRunNote("social_post");
  }

  for (const r of results.values()) {
    // The same story from another outlet next week is not news again: headlines are remembered across digests.
    r.sections.money.items = dedupeHeadlines(r.sections.money.items).filter(i => {
      const key = headlineKey(i.text);
      if (!key) return true;
      if (store.seenSince("headline", key, new Date(now.getTime() - 45 * DAY).toISOString())) return false;
      store.markSeen("headline", key, now.toISOString());
      return true;
    });
  }
  for (const ds of WATCH_DATASETS) store.deleteMeta(`gap_since_${ds}`);
  store.deleteMeta("new_domains");
  const notices: string[] = [];
  if (store.getMeta("disabled_social_post")) notices.push(POSTS_OFF);

  const digest: Digest = {
    week,
    from: sinceDate,
    to: isoDate(now)!,
    firstRun,
    competitors: orderCompetitors([...results.values()]),
    creditsUsed: crustdata.creditsUsed.total - before,
    watcherCredits,
    warnings,
    notices,
  };
  return { digest, markdown: digestMarkdown(digest), competitorsChanged, retiredDone };
}

// ---------------------------------------------------------------------------
// Watch management used by the CLI
// ---------------------------------------------------------------------------

export async function deleteAllWatches(store: Store, api: Pick<Api, "deleteWatch"> = crustdata, log: (s: string) => void = () => {}): Promise<number> {
  let n = 0;
  for (const ds of WATCH_DATASETS) {
    for (const old of retiredWatches(store, ds)) { await api.deleteWatch(ds, old); log(`  replaced ${WATCH_NAMES[ds]} ${old} deleted.`); n++; }
    store.deleteMeta(`retired_${ds}`);
  }
  for (const w of store.allWatches()) {
    await api.deleteWatch(w.dataset, w.watch_id);
    store.clearWatch(w.dataset);
    log(`  ${WATCH_NAMES[w.dataset]} ${w.watch_id} deleted.`);
    n++;
  }
  return n;
}

/**
 * Two articles about the same event share their first words; keep the first (watch items come before web search).
 * Press about a round or an acquisition that already has its own line is dropped, and so is a repeated link.
 */
export function dedupeHeadlines(items: Item[]): Item[] {
  const seen = new Set<string>();
  const urls = new Set<string>();
  const raised = items.some(i => i.text.startsWith("Raised "));
  const acquired = items.some(i => i.text.startsWith("Acquired "));
  return items.filter(i => {
    if (i.text.startsWith("In the news") && raised && /\b(raises?|raised|funding|series [a-e]|seed round)\b/i.test(i.text)) return false;
    if (i.text.startsWith("In the news") && acquired && /\b(acquires?|acquired|acquisition|buys)\b/i.test(i.text)) return false;
    if (i.url && urls.has(i.url)) return false;
    if (i.url) urls.add(i.url);
    const key = headlineKey(i.text, 5); // within one digest, the same first five words are the same story
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The first words of a quoted news headline (8 for the memory across weeks, 5 inside one digest); "" for other lines. */
export function headlineKey(text: string, words = 8): string {
  if (!text.startsWith("In the news")) return "";
  const quoted = /"([^"]+)"/.exec(text)?.[1];
  return quoted ? quoted.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter(Boolean).slice(0, words).join(" ") : "";
}
