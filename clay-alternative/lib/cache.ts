// The cache keeps every result so a second run, or a run resumed after an interruption, never pays twice.
// Keys: person:url:<url>, person:email:<email>, company:identify:domain:<domain>, company:identify:name:<name>,
// company:enrich:<id>. The CLI uses the SQLite cache in lib/cache-sqlite.ts; the API route uses this in-memory one.

import type { Cache, CacheEntry } from "./types";

export class MemoryCache implements Cache {
  private map = new Map<string, CacheEntry>();
  /** `ttlMs` drops entries older than that on read; 0 keeps them for the life of the process. */
  constructor(private max = 50_000, private ttlMs = 0) {}
  async get(key: string) {
    const e = this.map.get(key);
    if (e && this.ttlMs && Date.now() - Date.parse(e.at) > this.ttlMs) { this.map.delete(key); return undefined; }
    return e;
  }
  async set(key: string, entry: CacheEntry) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, entry);
  }
  get size() { return this.map.size; }
}

export const personKey = (kind: "url" | "email", value: string) => `person:${kind}:${value}`;
export const identifyKey = (kind: "domain" | "name", value: string) => `company:identify:${kind}:${value.toLowerCase()}`;
export const enrichKey = (companyId: number) => `company:enrich:${companyId}`;

/** A cached record answers a request when it was fetched with every field group the request needs and is young enough (misses always answer). */
export function covers(entry: CacheEntry | undefined, fields: string[], maxAgeDays?: number, now = Date.now()): entry is CacheEntry {
  if (!entry) return false;
  if (maxAgeDays !== undefined && maxAgeDays > 0 && now - Date.parse(entry.at) > maxAgeDays * 86_400_000) return false;
  if (entry.status !== "matched") return true;
  const have = new Set(entry.fields ?? []);
  return fields.every(f => have.has(f));
}
