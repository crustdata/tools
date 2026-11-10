/**
 * State between runs, in one SQLite file (`node:sqlite`, no native build): the portfolio as imported, the leaders,
 * the headcount reference records, careers page readings, the watch ids, which watch runs were read, every signal
 * (stored once, by key) and every digest. `:memory:` for tests and `npm run replay`.
 *
 * A check or digest writes inside one transaction (`begin` ... `commit`): a dry run, a crash or a rejected key rolls
 * it back, so nothing is marked as read unless the signals it produced were saved.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import type { Dataset } from "./crustdata.js";
import type { Leader, LeaderRole } from "./leaders.js";
import type { Point, Reading } from "./signals.js";
import type { Severity, Signal } from "./types.js";

export type Company = {
  domain: string;
  name: string;
  companyId?: number;
  owner?: string;
  careersUrl?: string;
  /** The careers page as the portfolio gives it (the page actually read may be the job board it links to). */
  careersInput?: string;
  /** Where open roles are counted: the careers page, the job index, or nowhere. */
  hiringSource: "careers" | "index" | "none";
  addedAt: string;
  /** The starting point line from import (headcount, last round). */
  start?: string;
};

export type StoredSignal = Signal & { id: number; createdAt: string; posted: boolean; digestId?: number };

export type StoredDigest = { id: number; createdAt: string; from: string; to: string; markdown: string; payload: any; sentSlack: boolean; sentEmail: boolean; wantSlack: boolean; wantEmail: boolean };

/** The part of a company record the department rule compares: the total and each department's latest month. */
export function compactRecord(record: any): unknown {
  const h = record?.headcount;
  if (!h) return record ?? null;
  const fns: Record<string, unknown[]> = {};
  for (const [fn, points] of Object.entries(h.by_function_timeseries?.CURRENT_FUNCTION ?? {})) {
    const valid = (Array.isArray(points) ? points : []).filter((p: any) => p && typeof p.date === "string").sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
    if (valid.length) fns[fn] = [valid.at(-1)];
  }
  return { crustdata_company_id: record.crustdata_company_id, headcount: { total: h.total ?? null, by_function_timeseries: { CURRENT_FUNCTION: fns } } };
}

/** Leaders recorded as gone stay on the watch this long, so a return (or a profile glitch undone) is seen. */
export const LEFT_WATCH_DAYS = 60;

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
      CREATE TABLE IF NOT EXISTS runs_seen (dataset TEXT NOT NULL, run_id INTEGER NOT NULL, credits REAL NOT NULL DEFAULT 0, seen_at TEXT NOT NULL, PRIMARY KEY (dataset, run_id));
      CREATE TABLE IF NOT EXISTS companies (
        domain TEXT PRIMARY KEY, name TEXT NOT NULL, company_id INTEGER, owner TEXT, careers_url TEXT,
        hiring_source TEXT NOT NULL DEFAULT 'none', added_at TEXT NOT NULL, start TEXT, careers_input TEXT
      );
      CREATE TABLE IF NOT EXISTS company_refs (domain TEXT PRIMARY KEY, record TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leaders (
        profile_url TEXT NOT NULL, domain TEXT NOT NULL, person_id INTEGER, name TEXT NOT NULL, title TEXT NOT NULL,
        role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'search', added_at TEXT NOT NULL,
        left_at TEXT, PRIMARY KEY (profile_url, domain)
      );
      CREATE TABLE IF NOT EXISTS headcount_points (domain TEXT NOT NULL, at TEXT NOT NULL, total INTEGER NOT NULL, PRIMARY KEY (domain, at));
      CREATE TABLE IF NOT EXISTS hiring_readings (domain TEXT NOT NULL, read_at TEXT NOT NULL, roles INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY (domain, read_at));
      CREATE TABLE IF NOT EXISTS posted_routes (signal_id INTEGER NOT NULL, route TEXT NOT NULL, PRIMARY KEY (signal_id, route));
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, domain TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL, posted INTEGER NOT NULL DEFAULT 0, digest_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, own REAL NOT NULL, watchers REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL,
        markdown TEXT NOT NULL, payload TEXT NOT NULL, sent_slack INTEGER NOT NULL DEFAULT 0, sent_email INTEGER NOT NULL DEFAULT 0,
        want_slack INTEGER NOT NULL DEFAULT 0, want_email INTEGER NOT NULL DEFAULT 0, slack_delivered INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.upgrade();
  }

  /** Databases made by an earlier version: add the columns this one reads. */
  private upgrade(): void {
    const cols = new Set((this.db.prepare("PRAGMA table_info(leaders)").all() as { name: string }[]).map(c => c.name));
    if (!cols.has("left_at")) this.db.exec("ALTER TABLE leaders ADD COLUMN left_at TEXT");
    const ccols = new Set((this.db.prepare("PRAGMA table_info(companies)").all() as { name: string }[]).map(c => c.name));
    if (!ccols.has("careers_input")) this.db.exec("ALTER TABLE companies ADD COLUMN careers_input TEXT");
    // Headcount readings came later than reference records: seed them once from the references an older version kept.
    if (!this.getMeta("points_seeded")) {
      this.db.exec("INSERT OR IGNORE INTO headcount_points (domain, at, total) SELECT domain, recorded_at, CAST(json_extract(record, '$.headcount.total') AS INTEGER) FROM company_refs WHERE json_extract(record, '$.headcount.total') IS NOT NULL");
      this.setMeta("points_seeded", new Date().toISOString());
    }
  }

  close(): void {
    if (this.inTransaction) this.rollback();
    this.db.close();
  }

  /** Starts the run's transaction. Throws a plain message when another run holds the database. */
  begin(): void {
    try { this.db.exec("BEGIN IMMEDIATE"); }
    catch (err) {
      if (/locked|busy/i.test((err as Error).message)) throw new Error("Another vc-portfolio-monitor run is using the database. Wait for it to finish and run again.");
      throw err;
    }
    this.inTransaction = true;
  }
  /** Commits, then folds the write-ahead log into the main file, so the one .sqlite file holds everything. */
  commit(): void {
    if (!this.inTransaction) return;
    this.db.exec("COMMIT");
    this.inTransaction = false;
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* another reader; closing checkpoints too */ }
  }
  rollback(): void { if (this.inTransaction) { this.db.exec("ROLLBACK"); this.inTransaction = false; } }

  // meta
  getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  deleteMeta(key: string): void { this.db.prepare("DELETE FROM meta WHERE key = ?").run(key); }

  // watches
  getWatchId(ds: Dataset): number | undefined {
    return (this.db.prepare("SELECT watch_id FROM watches WHERE dataset = ?").get(ds) as { watch_id: number } | undefined)?.watch_id;
  }
  setWatchId(ds: Dataset, id: number): void {
    this.db.prepare("INSERT INTO watches (dataset, watch_id, created_at) VALUES (?, ?, ?) ON CONFLICT(dataset) DO UPDATE SET watch_id = excluded.watch_id, created_at = excluded.created_at").run(ds, id, new Date().toISOString());
  }
  clearWatch(ds: Dataset): void { this.db.prepare("DELETE FROM watches WHERE dataset = ?").run(ds); }
  allWatches(): { dataset: Dataset; watch_id: number }[] {
    return this.db.prepare("SELECT dataset, watch_id FROM watches ORDER BY dataset").all() as any[];
  }
  seenRunIds(ds: Dataset): Set<number> {
    return new Set((this.db.prepare("SELECT run_id FROM runs_seen WHERE dataset = ?").all(ds) as { run_id: number }[]).map(r => r.run_id));
  }
  markRunSeen(ds: Dataset, runId: number, credits = 0): void {
    this.db.prepare("INSERT OR IGNORE INTO runs_seen (dataset, run_id, credits, seen_at) VALUES (?, ?, ?, ?)").run(ds, runId, credits, new Date().toISOString());
  }

  // companies
  private toCompany(r: any): Company {
    return { domain: r.domain, name: r.name, companyId: r.company_id ?? undefined, owner: r.owner ?? undefined, careersUrl: r.careers_url ?? undefined, careersInput: r.careers_input ?? undefined, hiringSource: r.hiring_source, addedAt: r.added_at, start: r.start ?? undefined };
  }
  companies(): Company[] { return (this.db.prepare("SELECT * FROM companies ORDER BY name COLLATE NOCASE").all() as any[]).map(r => this.toCompany(r)); }
  company(domain: string): Company | undefined {
    const r = this.db.prepare("SELECT * FROM companies WHERE domain = ?").get(domain);
    return r ? this.toCompany(r) : undefined;
  }
  companyById(id: number): Company | undefined {
    const r = this.db.prepare("SELECT * FROM companies WHERE company_id = ?").get(id);
    return r ? this.toCompany(r) : undefined;
  }
  saveCompany(c: Company): void {
    this.db.prepare(`INSERT INTO companies (domain, name, company_id, owner, careers_url, hiring_source, added_at, start, careers_input) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET name = excluded.name, company_id = excluded.company_id, owner = excluded.owner, careers_url = excluded.careers_url,
      hiring_source = excluded.hiring_source, start = COALESCE(excluded.start, start), careers_input = excluded.careers_input`)
      .run(c.domain, c.name, c.companyId ?? null, c.owner ?? null, c.careersUrl ?? null, c.hiringSource, c.addedAt, c.start ?? null, c.careersInput ?? null);
  }
  /** Removes a company and everything kept about it (its signals stay, so past digests still read right). */
  removeCompany(domain: string): void {
    for (const t of ["companies", "company_refs", "leaders", "hiring_readings", "headcount_points"]) this.db.prepare(`DELETE FROM ${t} WHERE domain = ?`).run(domain);
    // Added back later, it is looked up again from scratch.
    for (const k of ["leaders_searched", "careers_checked", "careers_len", "careers_tried", "careers_short", "hc_alert_at"]) this.db.prepare("DELETE FROM meta WHERE key = ?").run(`${k}:${domain}`);
  }

  // headcount reference
  getRef(domain: string): { record: any; recordedAt: string } | undefined {
    const r = this.db.prepare("SELECT record, recorded_at FROM company_refs WHERE domain = ?").get(domain) as any;
    return r ? { record: JSON.parse(r.record), recordedAt: r.recorded_at } : undefined;
  }
  /** Keeps only what the rules read (headcount total and the latest month per department), so the file stays small. */
  saveRef(domain: string, record: unknown, recordedAt = new Date().toISOString()): void {
    record = compactRecord(record);
    this.db.prepare("INSERT INTO company_refs (domain, record, recorded_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET record = excluded.record, recorded_at = excluded.recorded_at").run(domain, JSON.stringify(record), recordedAt);
  }

  // headcount readings
  addPoint(domain: string, at: string, total: number): void {
    this.db.prepare("INSERT INTO headcount_points (domain, at, total) VALUES (?, ?, ?) ON CONFLICT(domain, at) DO UPDATE SET total = excluded.total").run(domain, at, total);
  }
  /**
   * Readings at or after `since`, oldest first. With `prior`, and no reading in the window, the last reading before it:
   * a company whose headcount sat still for months still has something to compare a drop with.
   */
  points(domain: string, since: string, { prior = false } = {}): Point[] {
    const inside = (this.db.prepare("SELECT at, total FROM headcount_points WHERE domain = ? AND at >= ? ORDER BY at").all(domain, since) as any[]).map(r => ({ at: r.at, total: r.total }));
    if (!prior || inside.length) return inside;
    const before = this.db.prepare("SELECT at, total FROM headcount_points WHERE domain = ? AND at < ? ORDER BY at DESC LIMIT 1").get(domain, since) as any;
    return before ? [{ at: before.at, total: before.total }] : inside;
  }

  // leaders
  private toLeader(r: any): Leader & { status: string; source: string; leftAt?: string; addedAt?: string } {
    const c = this.company(r.domain);
    return { profileUrl: r.profile_url, personId: r.person_id ?? undefined, name: r.name, title: r.title, role: r.role as LeaderRole, domain: r.domain, company: c?.name ?? r.domain, companyId: c?.companyId, status: r.status, source: r.source, leftAt: r.left_at ?? undefined, addedAt: r.added_at };
  }
  leaders(domain?: string, { all = false } = {}): (Leader & { status: string; source: string; leftAt?: string; addedAt?: string })[] {
    const rows = (domain
      ? this.db.prepare(`SELECT * FROM leaders WHERE domain = ? ${all ? "" : "AND status = 'active'"} ORDER BY name`).all(domain)
      : this.db.prepare(`SELECT * FROM leaders ${all ? "" : "WHERE status = 'active'"} ORDER BY domain, name`).all()) as any[];
    return rows.map(r => this.toLeader(r));
  }
  /**
   * The leader rows a person watch record belongs to (one person can lead two portfolio companies): active ones, and
   * ones recorded as gone in the last LEFT_WATCH_DAYS (still watched, to catch a return).
   */
  leadersFor(personId: number | undefined, profileUrl: string | undefined, now = new Date()): (Leader & { status: string; source: string; leftAt?: string; addedAt?: string })[] {
    const since = new Date(now.getTime() - LEFT_WATCH_DAYS * 86_400_000).toISOString();
    const rows = this.db.prepare("SELECT * FROM leaders WHERE (status = 'active' OR (status = 'left' AND left_at >= ?)) AND ((? IS NOT NULL AND person_id = ?) OR (? IS NOT NULL AND profile_url = ?))").all(since, personId ?? null, personId ?? null, profileUrl ?? null, profileUrl ?? null) as any[];
    return rows.map(r => this.toLeader(r));
  }
  saveLeader(l: Leader, source: "search" | "csv" = "search"): void {
    this.db.prepare(`INSERT INTO leaders (profile_url, domain, person_id, name, title, role, status, source, added_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(profile_url, domain) DO UPDATE SET person_id = COALESCE(excluded.person_id, person_id), name = excluded.name, title = excluded.title, role = excluded.role, status = 'active'`)
      .run(l.profileUrl, l.domain, l.personId ?? null, l.name, l.title, l.role, source, new Date().toISOString());
  }
  setLeaderTitle(profileUrl: string, domain: string, title: string): void { this.db.prepare("UPDATE leaders SET title = ? WHERE profile_url = ? AND domain = ?").run(title, profileUrl, domain); }
  setLeaderStatus(profileUrl: string, domain: string, status: "active" | "left" | "removed", at = new Date().toISOString()): void {
    this.db.prepare("UPDATE leaders SET status = ?, left_at = CASE WHEN ? = 'left' THEN ? ELSE NULL END WHERE profile_url = ? AND domain = ?").run(status, status, at, profileUrl, domain);
  }
  /** Every profile URL the person watch should hold: active leaders, and leaders gone in the last LEFT_WATCH_DAYS. */
  watchedProfileUrls(now = new Date()): string[] {
    const since = new Date(now.getTime() - LEFT_WATCH_DAYS * 86_400_000).toISOString();
    return (this.db.prepare("SELECT DISTINCT profile_url FROM leaders WHERE status = 'active' OR (status = 'left' AND left_at >= ?) ORDER BY profile_url").all(since) as { profile_url: string }[]).map(r => r.profile_url);
  }

  // hiring readings
  addReading(domain: string, at: string, roles: number, source: string): void {
    this.db.prepare("INSERT INTO hiring_readings (domain, read_at, roles, source) VALUES (?, ?, ?, ?) ON CONFLICT(domain, read_at) DO UPDATE SET roles = excluded.roles, source = excluded.source").run(domain, at, roles, source);
  }
  /** Readings in the last `days` (by time, not count, so a daily or a monthly schedule both see about 10 weeks). */
  readings(domain: string, days = 70, now = new Date()): Reading[] {
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    return (this.db.prepare("SELECT read_at, roles FROM hiring_readings WHERE domain = ? AND read_at >= ? ORDER BY read_at").all(domain, since) as any[]).map(r => ({ at: r.read_at, roles: r.roles }));
  }
  lastReading(domain: string): Reading | undefined {
    const r = this.db.prepare("SELECT read_at, roles FROM hiring_readings WHERE domain = ? ORDER BY read_at DESC LIMIT 1").get(domain) as any;
    return r ? { at: r.read_at, roles: r.roles } : undefined;
  }
  clearReadings(domain: string): void {
    this.db.prepare("DELETE FROM hiring_readings WHERE domain = ?").run(domain);
    for (const k of ["careers_len", "careers_tried", "careers_short"]) this.db.prepare("DELETE FROM meta WHERE key = ?").run(`${k}:${domain}`);
  }
  lastReadingAt(domain: string): string | undefined {
    return (this.db.prepare("SELECT MAX(read_at) at FROM hiring_readings WHERE domain = ?").get(domain) as { at: string | null }).at ?? undefined;
  }

  // signals
  /** Saves a signal unless one with the same key exists. Returns true when it is new. */
  addSignal(s: Signal, at = new Date().toISOString()): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO signals (key, domain, kind, severity, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(s.key, s.domain, s.kind, s.severity, JSON.stringify(s), at);
    return Number(r.changes) > 0;
  }
  /** When this company last got a signal whose key starts with `prefix`. */
  lastSignalAtKey(domain: string, prefix: string): string | undefined {
    return (this.db.prepare("SELECT MAX(created_at) at FROM signals WHERE domain = ? AND key LIKE ?").get(domain, `${prefix}%`) as { at: string | null }).at ?? undefined;
  }
  /** The latest signal of these kinds for a company. */
  lastSignalOf(domain: string, kinds: string[]): (Signal & { createdAt: string }) | undefined {
    const r = this.db.prepare(`SELECT payload, created_at FROM signals WHERE domain = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY created_at DESC, id DESC LIMIT 1`).get(domain, ...kinds) as any;
    return r ? { ...JSON.parse(r.payload), createdAt: r.created_at } : undefined;
  }
  /** When this company last got a signal of this kind (for the repeat window). */
  lastSignalAt(domain: string, kind: string): string | undefined {
    return (this.db.prepare("SELECT MAX(created_at) at FROM signals WHERE domain = ? AND kind = ?").get(domain, kind) as { at: string | null }).at ?? undefined;
  }
  private toSignal(r: any): StoredSignal {
    return { ...JSON.parse(r.payload), id: r.id, createdAt: r.created_at, posted: Boolean(r.posted), digestId: r.digest_id ?? undefined };
  }
  /** Signals waiting for the instant Slack post (everything but digest-only news). */
  unposted(): StoredSignal[] {
    return (this.db.prepare("SELECT * FROM signals WHERE posted = 0 AND severity != 'news' ORDER BY id").all() as any[]).map(r => this.toSignal(r));
  }
  /** Channels (a hash of the webhook) that already accepted a signal, so a retry skips them. */
  postedRoutes(id: number): Set<string> {
    return new Set((this.db.prepare("SELECT route FROM posted_routes WHERE signal_id = ?").all(id) as { route: string }[]).map(r => r.route));
  }
  markRoutePosted(id: number, route: string): void { this.db.prepare("INSERT OR IGNORE INTO posted_routes (signal_id, route) VALUES (?, ?)").run(id, route); }
  setLeaderSource(profileUrl: string, domain: string, source: "search" | "csv"): void { this.db.prepare("UPDATE leaders SET source = ? WHERE profile_url = ? AND domain = ?").run(source, profileUrl, domain); }
  markPosted(ids: number[]): void {
    const st = this.db.prepare("UPDATE signals SET posted = 1 WHERE id = ?");
    for (const id of ids) st.run(id);
  }
  /** Signals not in a digest yet. */
  undigested(): StoredSignal[] {
    return (this.db.prepare("SELECT * FROM signals WHERE digest_id IS NULL ORDER BY id").all() as any[]).map(r => this.toSignal(r));
  }
  assignDigest(ids: number[], digestId: number): void {
    const st = this.db.prepare("UPDATE signals SET digest_id = ? WHERE id = ?");
    for (const id of ids) st.run(digestId, id);
  }
  recentSignals(limit = 20): StoredSignal[] {
    return (this.db.prepare("SELECT * FROM signals ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(r => this.toSignal(r));
  }
  signalCounts(): Record<Severity, number> {
    const out: Record<string, number> = { alert: 0, good: 0, note: 0, news: 0 };
    for (const r of this.db.prepare("SELECT severity, COUNT(*) n FROM signals GROUP BY severity").all() as any[]) out[r.severity] = r.n;
    return out as Record<Severity, number>;
  }

  // credits
  addSpend(own: number, watchers: number, at = new Date().toISOString()): void {
    if (own || watchers) this.db.prepare("INSERT INTO spend (at, own, watchers) VALUES (?, ?, ?)").run(at, own, watchers);
  }
  spendSince(since: string): { own: number; watchers: number } {
    const r = this.db.prepare("SELECT COALESCE(SUM(own), 0) own, COALESCE(SUM(watchers), 0) watchers FROM spend WHERE at > ?").get(since) as any;
    return { own: r.own, watchers: r.watchers };
  }

  // digests
  saveDigest(d: { from: string; to: string; markdown: string; payload: unknown; want: { slack: boolean; email: boolean } }, createdAt = new Date().toISOString()): number {
    const r = this.db.prepare("INSERT INTO digests (created_at, period_from, period_to, markdown, payload, want_slack, want_email) VALUES (?, ?, ?, ?, ?, ?, ?)").run(createdAt, d.from, d.to, d.markdown, JSON.stringify(d.payload), d.want.slack ? 1 : 0, d.want.email ? 1 : 0);
    return Number(r.lastInsertRowid);
  }
  private toDigest(r: any): StoredDigest {
    return { id: r.id, createdAt: r.created_at, from: r.period_from, to: r.period_to, markdown: r.markdown, payload: JSON.parse(r.payload), sentSlack: Boolean(r.sent_slack), sentEmail: Boolean(r.sent_email), wantSlack: Boolean(r.want_slack), wantEmail: Boolean(r.want_email) };
  }
  lastDigest(): StoredDigest | undefined {
    const r = this.db.prepare("SELECT * FROM digests ORDER BY id DESC LIMIT 1").get();
    return r ? this.toDigest(r) : undefined;
  }
  recentDigests(limit: number): StoredDigest[] { return (this.db.prepare("SELECT * FROM digests ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(r => this.toDigest(r)); }
  markDigestSent(id: number, channel: "slack" | "email"): void { this.db.prepare(`UPDATE digests SET sent_${channel} = 1 WHERE id = ?`).run(id); }
  slackDelivered(id: number): number { return (this.db.prepare("SELECT slack_delivered n FROM digests WHERE id = ?").get(id) as { n: number } | undefined)?.n ?? 0; }
  setSlackDelivered(id: number, n: number): void { this.db.prepare("UPDATE digests SET slack_delivered = ? WHERE id = ?").run(n, id); }

  counts(): Record<string, number> {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { companies: n("SELECT COUNT(*) n FROM companies"), leaders: n("SELECT COUNT(*) n FROM leaders WHERE status = 'active'"), signals: n("SELECT COUNT(*) n FROM signals"), digests: n("SELECT COUNT(*) n FROM digests") };
  }
}
