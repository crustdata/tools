/**
 * State between weekly runs, in one SQLite file (`node:sqlite`, no native build). Holds the last text of every page,
 * the reference company record, weekly job counts, the watch ids, which watch runs were already read, which items
 * were already reported, and every digest with what was sent where. `:memory:` for tests and `npm run replay`.
 *
 * A digest run writes inside one transaction (`begin` ... `commit`). A dry run, a crash or a stopped key rolls it
 * back, so nothing is marked as reported unless the digest that reports it was saved. `BEGIN IMMEDIATE` also stops a
 * second run from starting while one is writing.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import type { Dataset } from "./crustdata.js";
import type { Digest } from "./types.js";
import type { Page } from "./website.js";

export type PageSnapshot = Page;

/** New postings counted in one ISO week, and listings posted in the last 30 days at that time. */
export type WeeklyJobs = { domain: string; week: string; newJobs: number; recentJobs: number | null };

export type StoredDigest = { id: number; createdAt: string; digest: Digest; markdown: string; sentSlack: boolean; sentEmail: boolean; wantSlack: boolean; wantEmail: boolean };

export class Store {
  private db: DatabaseSync;
  private inTransaction = false;

  constructor(path = config.dbPath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watches (dataset TEXT PRIMARY KEY, watch_id INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs_seen (dataset TEXT NOT NULL, run_id INTEGER NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (dataset, run_id));
      CREATE TABLE IF NOT EXISTS pages (
        url TEXT PRIMARY KEY, domain TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
        links TEXT NOT NULL, logos TEXT NOT NULL, fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS company_records (domain TEXT PRIMARY KEY, record TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS weekly_jobs (domain TEXT NOT NULL, week TEXT NOT NULL, new_jobs INTEGER NOT NULL, recent_jobs INTEGER, PRIMARY KEY (domain, week));
      CREATE TABLE IF NOT EXISTS seen (kind TEXT NOT NULL, key TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (kind, key));
      CREATE TABLE IF NOT EXISTS digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, markdown TEXT NOT NULL, payload TEXT NOT NULL,
        sent_slack INTEGER NOT NULL DEFAULT 0, sent_email INTEGER NOT NULL DEFAULT 0,
        want_slack INTEGER NOT NULL DEFAULT 0, want_email INTEGER NOT NULL DEFAULT 0,
        slack_delivered INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Databases made by an earlier version: add the columns this one reads.
    const cols = new Set((this.db.prepare("PRAGMA table_info(digests)").all() as { name: string }[]).map(c => c.name));
    for (const [col, def] of [["want_slack", "INTEGER NOT NULL DEFAULT 0"], ["want_email", "INTEGER NOT NULL DEFAULT 0"], ["slack_delivered", "INTEGER NOT NULL DEFAULT 0"]]) {
      if (!cols.has(col)) this.db.exec(`ALTER TABLE digests ADD COLUMN ${col} ${def}`);
    }
  }

  close(): void {
    if (this.inTransaction) this.rollback();
    this.db.close();
  }

  // transactions
  /** Starts the run's transaction. Throws a plain message when another run holds the database. */
  begin(): void {
    try { this.db.exec("BEGIN IMMEDIATE"); }
    catch (err) {
      if (/locked|busy/i.test((err as Error).message)) throw new Error("Another competitor-tracker run is using the database. Wait for it to finish and run again.");
      throw err;
    }
    this.inTransaction = true;
  }
  /** Commits, then folds the write-ahead log into the main file, so the one .sqlite file holds everything (CI commits it). */
  commit(): void {
    if (!this.inTransaction) return;
    this.db.exec("COMMIT");
    this.inTransaction = false;
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* another reader; closing checkpoints too */ }
  }
  rollback(): void { if (this.inTransaction) { this.db.exec("ROLLBACK"); this.inTransaction = false; } }

  // meta
  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }
  deleteMeta(key: string): void { this.db.prepare("DELETE FROM meta WHERE key = ?").run(key); }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // watches
  getWatchId(ds: Dataset): number | undefined {
    const row = this.db.prepare("SELECT watch_id FROM watches WHERE dataset = ?").get(ds) as { watch_id: number } | undefined;
    return row?.watch_id;
  }
  setWatchId(ds: Dataset, id: number): void {
    this.db.prepare("INSERT INTO watches (dataset, watch_id, created_at) VALUES (?, ?, ?) ON CONFLICT(dataset) DO UPDATE SET watch_id = excluded.watch_id, created_at = excluded.created_at").run(ds, id, new Date().toISOString());
  }
  clearWatch(ds: Dataset): void {
    this.db.prepare("DELETE FROM watches WHERE dataset = ?").run(ds);
    // runs_seen is kept: run ids never repeat, and a replaced watcher's runs must stay marked as read.
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(`watch_signature_${ds}`);
  }
  allWatches(): { dataset: Dataset; watch_id: number; created_at: string }[] {
    return this.db.prepare("SELECT dataset, watch_id, created_at FROM watches ORDER BY dataset").all() as any[];
  }

  seenRunIds(ds: Dataset): Set<number> {
    return new Set((this.db.prepare("SELECT run_id FROM runs_seen WHERE dataset = ?").all(ds) as { run_id: number }[]).map(r => r.run_id));
  }
  markRunSeen(ds: Dataset, runId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO runs_seen (dataset, run_id, seen_at) VALUES (?, ?, ?)").run(ds, runId, new Date().toISOString());
  }

  // pages
  getPage(url: string): PageSnapshot | undefined {
    const r = this.db.prepare("SELECT * FROM pages WHERE url = ?").get(url) as any;
    return r ? { url: r.url, domain: r.domain, title: r.title, text: r.text, links: JSON.parse(r.links), logos: JSON.parse(r.logos), fetchedAt: r.fetched_at } : undefined;
  }
  pagesFor(domain: string): PageSnapshot[] {
    return (this.db.prepare("SELECT url FROM pages WHERE domain = ?").all(domain) as { url: string }[]).map(r => this.getPage(r.url)!);
  }
  savePage(p: PageSnapshot): void {
    this.db.prepare(`INSERT INTO pages (url, domain, title, text, links, logos, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET domain = excluded.domain, title = excluded.title, text = excluded.text, links = excluded.links, logos = excluded.logos, fetched_at = excluded.fetched_at`)
      .run(p.url, p.domain, p.title, p.text, JSON.stringify(p.links), JSON.stringify(p.logos), p.fetchedAt);
  }
  deletePagesFor(domain: string): void { this.db.prepare("DELETE FROM pages WHERE domain = ?").run(domain); }

  // company records
  getCompanyRecord(domain: string): { record: any; recordedAt: string } | undefined {
    const r = this.db.prepare("SELECT record, recorded_at FROM company_records WHERE domain = ?").get(domain) as any;
    return r ? { record: JSON.parse(r.record), recordedAt: r.recorded_at } : undefined;
  }
  saveCompanyRecord(domain: string, record: unknown, recordedAt = new Date().toISOString()): void {
    this.db.prepare("INSERT INTO company_records (domain, record, recorded_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET record = excluded.record, recorded_at = excluded.recorded_at")
      .run(domain, JSON.stringify(record), recordedAt);
  }
  deleteCompanyRecord(domain: string): void { this.db.prepare("DELETE FROM company_records WHERE domain = ?").run(domain); }

  // weekly job counts
  /** Adds this run's new postings to the week's count (a second run in the same week adds, never overwrites). */
  addWeeklyJobs(domain: string, week: string, newJobs: number, recentJobs: number | null): void {
    this.db.prepare(`INSERT INTO weekly_jobs (domain, week, new_jobs, recent_jobs) VALUES (?, ?, ?, ?)
      ON CONFLICT(domain, week) DO UPDATE SET new_jobs = new_jobs + excluded.new_jobs, recent_jobs = COALESCE(excluded.recent_jobs, recent_jobs)`)
      .run(domain, week, newJobs, recentJobs);
  }
  weeklyJobs(domain: string, limit = 12): WeeklyJobs[] {
    return (this.db.prepare("SELECT domain, week, new_jobs, recent_jobs FROM weekly_jobs WHERE domain = ? ORDER BY week DESC LIMIT ?").all(domain, limit) as any[])
      .map(r => ({ domain: r.domain, week: r.week, newJobs: r.new_jobs, recentJobs: r.recent_jobs }));
  }

  // seen items (news URLs, post ids, job ids)
  isSeen(kind: string, key: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM seen WHERE kind = ? AND key = ?").get(kind, key));
  }
  markSeen(kind: string, key: string, at = new Date().toISOString()): void {
    this.db.prepare("INSERT INTO seen (kind, key, seen_at) VALUES (?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET seen_at = excluded.seen_at").run(kind, key, at);
  }
  /** Seen on or after `since` (older entries are forgotten, for memories that should expire). */
  seenSince(kind: string, key: string, since: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM seen WHERE kind = ? AND key = ? AND seen_at >= ?").get(kind, key, since));
  }
  /** Keeps only items not reported before, and marks them (inside the run's transaction). */
  firstTime<T>(kind: string, items: T[], key: (t: T) => string): T[] {
    const out: T[] = [];
    for (const it of items) {
      const k = key(it);
      if (!k || this.isSeen(kind, k)) continue;
      this.markSeen(kind, k);
      out.push(it);
    }
    return out;
  }

  // digests
  /** Saves a digest with the channels set up at that moment (the ones `resend` may owe it to). */
  saveDigest(digest: Digest, markdown: string, createdAt = new Date().toISOString(), want: { slack: boolean; email: boolean } = { slack: false, email: false }): number {
    const r = this.db.prepare("INSERT INTO digests (created_at, markdown, payload, want_slack, want_email) VALUES (?, ?, ?, ?, ?)").run(createdAt, markdown, JSON.stringify(digest), want.slack ? 1 : 0, want.email ? 1 : 0);
    return Number(r.lastInsertRowid);
  }
  /** How many of a digest's Slack messages went out (a resend continues from there). */
  slackDelivered(id: number): number {
    return (this.db.prepare("SELECT slack_delivered n FROM digests WHERE id = ?").get(id) as { n: number } | undefined)?.n ?? 0;
  }
  setSlackDelivered(id: number, n: number): void { this.db.prepare("UPDATE digests SET slack_delivered = ? WHERE id = ?").run(n, id); }
  markDigestSent(id: number, channel: "slack" | "email"): void {
    this.db.prepare(`UPDATE digests SET sent_${channel} = 1 WHERE id = ?`).run(id);
  }
  private toStored(r: any): StoredDigest {
    return { id: r.id, createdAt: r.created_at, digest: JSON.parse(r.payload), markdown: r.markdown, sentSlack: Boolean(r.sent_slack), sentEmail: Boolean(r.sent_email), wantSlack: Boolean(r.want_slack), wantEmail: Boolean(r.want_email) };
  }
  recentDigests(limit: number): StoredDigest[] {
    return (this.db.prepare("SELECT * FROM digests ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(r => this.toStored(r));
  }
  lastDigest(): StoredDigest | undefined {
    const r = this.db.prepare("SELECT * FROM digests ORDER BY id DESC LIMIT 1").get() as any;
    return r ? this.toStored(r) : undefined;
  }
  counts(): Record<string, number> {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { pages: n("SELECT COUNT(*) n FROM pages"), companies: n("SELECT COUNT(*) n FROM company_records"), digests: n("SELECT COUNT(*) n FROM digests"), seen: n("SELECT COUNT(*) n FROM seen") };
  }
}

/** ISO week label used to group hiring counts, e.g. 2026-W43. */
export function weekLabel(d = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
