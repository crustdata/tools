/**
 * Local state in one SQLite file (data/job-hunt.db), using `node:sqlite` (built into Node 22.13+, no native build).
 *
 *   cache    paid answers (a company's trend, the people at a company for one search), reused for CACHE_DAYS
 *   seen     every job a run has shown you, so the next run can mark what is new
 *   tracker  your status per job (saved, applied, interviewing, skipped) and a note, set in the dashboard
 *
 * The CLI and the dashboard can use it at the same time (WAL and a busy timeout).
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STATUSES = ["new", "saved", "applied", "interviewing", "offer", "skipped", "rejected"] as const;
export type Status = typeof STATUSES[number];

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    // Your statuses and notes are yours alone: owner-only, whatever the umask.
    if (path !== ":memory:") for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) try { chmodSync(f, 0o600); } catch { /* not ours to change */ }
    this.db.exec("PRAGMA busy_timeout = 10000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (
        job_id TEXT PRIMARY KEY, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, run TEXT NOT NULL,
        company TEXT, title TEXT, url TEXT
      );
      CREATE TABLE IF NOT EXISTS tracker (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
    `);
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  // Cache -------------------------------------------------------------------

  /** A saved answer younger than `days`, or undefined. */
  cached<T>(key: string, days: number, now = Date.now()): T | undefined {
    if (days <= 0) return undefined;
    const row = this.db.prepare("SELECT value, at FROM cache WHERE key = ?").get(key) as { value: string; at: number } | undefined;
    if (!row || now - row.at > days * 86_400_000) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return undefined; }
  }

  save(key: string, value: unknown, now = Date.now()): void {
    this.db.prepare("INSERT INTO cache (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at").run(key, JSON.stringify(value), now);
  }

  /** Deletes answers older than `days` (kept when the cache is off, so a one-off run never empties it). */
  purge(days: number, now = Date.now()): void {
    if (days > 0) this.db.prepare("DELETE FROM cache WHERE at < ?").run(now - days * 86_400_000);
  }

  // Seen jobs -----------------------------------------------------------------

  /** The ids among `ids` a previous run already showed. */
  seenBefore(ids: string[]): Set<string> {
    const out = new Set<string>();
    const q = this.db.prepare("SELECT 1 FROM seen WHERE job_id = ?");
    for (const id of ids) if (q.get(id)) out.add(id);
    return out;
  }

  markSeen(jobs: Array<{ id: string; company: string; title: string; url: string | null }>, run: string, now = new Date().toISOString()): void {
    const q = this.db.prepare(`INSERT INTO seen (job_id, first_seen, last_seen, run, company, title, url) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET last_seen = excluded.last_seen`);
    this.db.exec("BEGIN");
    try {
      for (const j of jobs) q.run(j.id, now, now, run, j.company, j.title, j.url);
      this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  // Tracker -------------------------------------------------------------------

  statuses(): Map<string, { status: Status; note: string; updatedAt: string }> {
    const rows = this.db.prepare("SELECT job_id, status, note, updated_at FROM tracker").all() as Array<{ job_id: string; status: Status; note: string; updated_at: string }>;
    return new Map(rows.map(r => [r.job_id, { status: r.status, note: r.note, updatedAt: r.updated_at }]));
  }

  setStatus(jobId: string, status: Status, note?: string, now = new Date().toISOString()): void {
    if (!STATUSES.includes(status)) throw new Error(`Unknown status ${status}`);
    this.db.prepare(`INSERT INTO tracker (job_id, status, note, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, note = COALESCE(?, tracker.note), updated_at = excluded.updated_at`)
      .run(jobId, status, note ?? "", now, note ?? null);
  }
}
