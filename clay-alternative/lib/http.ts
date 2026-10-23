// Request helpers for the API routes: the visitor's key, the deployment's policy, the caps, memoised account reads,
// per-key caches and error responses. Everything here is per server process: on a serverless host each instance
// starts empty, so the caps and limits are advisory there (docs/deploy.md says so).

import { createHash } from "node:crypto";
import { readAccount } from "./account";
import { MemoryCache } from "./cache";
import { createClient, CrustdataError } from "./crustdata";
import type { Account } from "./types";

export class InputError extends Error {}
export class KeyRequiredError extends Error {}
export class BudgetError extends Error {}
export class RateLimitError extends Error {}
export class TooLargeError extends Error {}

/** The visitor's own key, from the x-crustdata-key header, or undefined for the deployment's key. */
export function userKey(req: Request): string | undefined {
  const k = req.headers.get("x-crustdata-key")?.trim();
  if (!k) return undefined;
  if (k.length > 512 || !/^[\x21-\x7e]+$/.test(k)) throw new InputError("That does not look like an API key.");
  return k;
}

export type Policy = {
  serverKey: boolean;
  showCredits: boolean;
  maxRows: number;
  maxCreditsPerRun?: number;
  dailyCap?: number;
  cacheTtlHours: number;
};

export function policy(): Policy {
  const num = (v: string | undefined) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? n : undefined; };
  return {
    serverKey: !!process.env.CRUSTDATA_API_KEY && process.env.ALLOW_SERVER_KEY !== "false",
    showCredits: process.env.SHOW_CREDITS !== "false",
    maxRows: num(process.env.MAX_ROWS_PER_RUN) ?? 500,
    maxCreditsPerRun: num(process.env.MAX_CREDITS_PER_RUN),
    dailyCap: num(process.env.DAILY_CREDIT_CAP),
    cacheTtlHours: process.env.CACHE_TTL_HOURS === undefined || process.env.CACHE_TTL_HOURS === "" ? 24 : Math.max(0, Number(process.env.CACHE_TTL_HOURS) || 0),
  };
}

/** Which key a request runs on. A visitor's key always wins; otherwise the deployment's, when allowed. */
export function resolveKey(req: Request): { key: string; own: boolean } {
  const own = userKey(req);
  if (own) return { key: own, own: true };
  const p = policy();
  if (!p.serverKey) throw new KeyRequiredError("Paste your Crustdata API key to run this. Get one at https://app.crustdata.com.");
  return { key: process.env.CRUSTDATA_API_KEY!, own: false };
}

/** Credits are shown when the deployment allows it, or always when the visitor brought their own key. */
export const pricingFor = (own: boolean): "shown" | "hidden" => (own || policy().showCredits ? "shown" : "hidden");

/** A short, non-reversible id for a key: for cache and memo maps, never logged. */
export const keyId = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 24);

// ---- the account read is a property of the key: memoised for 10 minutes, probe included ----
const accounts = new Map<string, { at: number; value: Promise<Account>; probed: boolean }>();
const ACCOUNT_TTL = 10 * 60_000;
export async function accountFor(key: string, { probeEmail = false } = {}): Promise<Account> {
  const id = keyId(key);
  const hit = accounts.get(id);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL && (hit.probed || !probeEmail)) return hit.value;
  const client = createClient({ apiKey: key, retries429: 0 });
  const value = readAccount(client, { probeEmail }).catch(err => { accounts.delete(id); throw err; });
  accounts.set(id, { at: Date.now(), value, probed: probeEmail });
  if (accounts.size > 200) accounts.delete(accounts.keys().next().value as string);
  return value;
}

// ---- one result cache per key, so one visitor's key never serves another's rows ----
const caches = new Map<string, MemoryCache>();
export function cacheFor(key: string): MemoryCache {
  const id = keyId(key);
  let c = caches.get(id);
  if (!c) {
    const p = policy();
    c = new MemoryCache(p.cacheTtlHours === 0 ? 1 : 20_000, p.cacheTtlHours * 3_600_000);
    caches.set(id, c);
    if (caches.size > 50) caches.delete(caches.keys().next().value as string);
  }
  return c;
}

// ---- daily cap on the deployment's key (per server instance, in memory) ----
const spent = { day: "", credits: 0 };
const today = () => new Date().toISOString().slice(0, 10);
export function dailySpent(): number { return spent.day === today() ? spent.credits : 0; }
export function recordSpend(credits: number) { if (spent.day !== today()) { spent.day = today(); spent.credits = 0; } spent.credits += credits; }
export function checkDailyCap(estimate: number) {
  const cap = policy().dailyCap;
  if (cap !== undefined && dailySpent() + estimate > cap) throw new BudgetError(policy().showCredits ? `This deployment's daily credit cap (${cap}) would be exceeded. Paste your own Crustdata API key to run it anyway.` : "This deployment's daily credit cap would be exceeded. Paste your own Crustdata API key to run it anyway.");
}

// ---- a small per-address limit on anonymous requests ----
// The address is the last hop in x-forwarded-for (the one the platform's proxy appended), so a client cannot pick its own bucket.
export function clientAddress(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) { const hops = xff.split(",").map(s => s.trim()).filter(Boolean); if (hops.length) return hops[hops.length - 1]; }
  return req.headers.get("x-real-ip")?.trim() || "local";
}
const hits = new Map<string, number[]>();
export function rateLimit(req: Request, bucket: string, limit: number, windowMs: number) {
  const key = `${bucket}:${clientAddress(req)}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter(t => now - t < windowMs);
  if (recent.length >= limit) throw new RateLimitError("Too many requests from this address. Wait a few minutes, or paste your own Crustdata API key.");
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
}

/** Reads a JSON body of at most `max` bytes, whatever the transfer encoding. */
export async function readJson(req: Request, max: number): Promise<unknown> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > max) throw new TooLargeError(`The request is too big (${Math.round(length / 1_048_576)} MB; the limit is ${Math.round(max / 1_048_576)} MB). Use the CLI for big files.`);
  if (!req.body) throw new InputError("The request has no body.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new TooLargeError(`The request is too big (over ${Math.round(max / 1_048_576)} MB). Use the CLI for big files.`); }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  return JSON.parse(text);
}

export function fail(err: unknown): Response {
  const message = (err as Error)?.message ?? "Something went wrong";
  const out = (status: number, msg = message, needsKey = false) => Response.json({ error: msg, needsKey: needsKey || undefined }, { status });
  if (err instanceof InputError || err instanceof SyntaxError) return out(400, err instanceof SyntaxError ? "The request body is not valid JSON." : message);
  if (err instanceof TooLargeError) return out(413);
  if (err instanceof KeyRequiredError) return out(401, message, true);
  if (err instanceof BudgetError) return out(402, message, true);
  if (err instanceof RateLimitError) return out(429);
  if (err instanceof CrustdataError) {
    if (err.status === 401) return out(401, message, true);
    if (err.status === 402) return out(402, message, true);
    if (err.status === 403 || err.status === 429) return out(err.status);
    console.error(message);
    return out(502, "Crustdata did not respond. Try again in a minute.");
  }
  console.error(message);
  return out(500, "Something went wrong on the server. Try again in a minute.");
}
