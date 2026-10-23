// SQLite cache for the CLI (node:sqlite, built into Node 22.13+). One row per key; saved after every batch.
// Imported only by scripts/, so the web build never needs node:sqlite.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Cache, CacheEntry } from "./types";

export class SqliteCache implements Cache {
  private db: DatabaseSync;
  constructor(path = "data/cache.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL, credits REAL NOT NULL, at TEXT NOT NULL, fields TEXT
    )`);
  }
  async get(key: string): Promise<CacheEntry | undefined> {
    const row = this.db.prepare("SELECT data, status, credits, at, fields FROM cache WHERE key = ?").get(key) as any;
    if (!row) return undefined;
    return { data: JSON.parse(row.data), status: row.status, credits: row.credits, at: row.at, fields: row.fields ? JSON.parse(row.fields) : undefined };
  }
  async set(key: string, e: CacheEntry): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO cache (key, data, status, credits, at, fields) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, JSON.stringify(e.data ?? null), e.status, e.credits, e.at, e.fields ? JSON.stringify(e.fields) : null);
  }
  stats(): { entries: number; credits: number; people: number; companies: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(credits), 0) AS c FROM cache").get() as any;
    const people = (this.db.prepare("SELECT COUNT(*) AS n FROM cache WHERE key LIKE 'person:%'").get() as any).n;
    const companies = (this.db.prepare("SELECT COUNT(*) AS n FROM cache WHERE key LIKE 'company:enrich:%'").get() as any).n;
    return { entries: r.n, credits: r.c, people, companies };
  }
  clear() { this.db.exec("DELETE FROM cache"); }
  close() { this.db.close(); }
}
