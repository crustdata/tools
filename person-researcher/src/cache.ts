/**
 * A small file cache of paid answers, so researching the same person again within CACHE_HOURS (24 by default) costs
 * nothing, and a run cut off halfway never pays twice for the people it already did. One JSON file per answer in
 * out/.cache/, owner-only, written atomically; answers older than CACHE_HOURS are deleted at the start of each run.
 * Delete the folder, pass --refresh, or set CACHE_HOURS=0 to always fetch.
 *
 * Within one run, answers are also kept in memory, so the same person reached twice (an email and a profile URL)
 * is paid for once even with --refresh or CACHE_HOURS=0.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class Cache {
  private memo = new Map<string, unknown>();

  constructor(private dir: string, private hours: number, private bypass = false) {}

  private file(key: string) { return join(this.dir, `${createHash("sha1").update(key).digest("hex").slice(0, 20)}.json`); }

  /**
   * Deletes saved answers older than CACHE_HOURS. A run with the cache off (CACHE_HOURS=0) leaves the folder alone,
   * so a one-off run never empties the cache a scheduled run relies on. Half-written files from a run still going
   * are left for an hour.
   */
  purge(now = Date.now()): void {
    if (this.hours <= 0) return;
    let names: string[];
    try { names = readdirSync(this.dir); chmodSync(this.dir, 0o700); } catch { return; }
    for (const n of names) {
      const f = join(this.dir, n);
      try {
        const age = now - statSync(f).mtimeMs;
        if (n.endsWith(".tmp") ? age > 3_600_000 : age > this.hours * 3_600_000) rmSync(f, { force: true });
      } catch { /* gone already */ }
    }
  }

  get<T>(key: string): T | undefined {
    if (this.memo.has(key)) return this.memo.get(key) as T;
    if (this.bypass || this.hours <= 0) return undefined;
    try {
      const saved = JSON.parse(readFileSync(this.file(key), "utf8")) as { key: string; at: number; value: T };
      if (saved.key !== key || Date.now() - saved.at > this.hours * 3_600_000) return undefined;
      return saved.value;
    } catch { return undefined; }
  }

  set(key: string, value: unknown): void {
    this.memo.set(key, value);
    if (this.hours <= 0) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const f = this.file(key);
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ key, at: Date.now(), value }), { mode: 0o600 });
      renameSync(tmp, f);
    } catch { /* a cache that cannot be written only costs a refetch next time */ }
  }

  /** The value for `key`, from memory, the cache or `fetch` (then saved). `hit` says whether it was free. */
  async through<T>(key: string, fetch: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
    const saved = this.get<T>(key);
    if (saved !== undefined) return { value: saved, hit: true };
    const value = await fetch();
    this.set(key, value);
    return { value, hit: false };
  }
}
