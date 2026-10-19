/**
 * Local state in one SQLite file, using `node:sqlite` (built into Node 22.13+, no native build step).
 *
 *   settings      key/value: watch ids, delivery URL, last digest time
 *   people        everyone on the list, with the last role we know of and the account owner
 *   unresolved    emails that did not match a profile, and why
 *   job_changes   every change received, with Slack delivery and digest status (the outbox)
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { JobChange } from "./notification.js";
import { normalizeProfileUrl } from "./profile-url.js";

if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
// WAL and a busy timeout let `npm run import` run while the server is serving, without "database is locked".
db.exec("PRAGMA busy_timeout = 10000;");
if (config.dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS people (
    profile_url TEXT PRIMARY KEY,
    crustdata_person_id INTEGER,
    name TEXT, title TEXT, company TEXT, company_id INTEGER,
    source_input TEXT, owner TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS people_person_id ON people (crustdata_person_id);
  CREATE TABLE IF NOT EXISTS emails (email TEXT PRIMARY KEY, profile_url TEXT NOT NULL, confidence REAL);
  CREATE TABLE IF NOT EXISTS runs_seen (watch_id INTEGER NOT NULL, run_id INTEGER NOT NULL, seen_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (watch_id, run_id));
  CREATE TABLE IF NOT EXISTS unresolved (
    input TEXT PRIMARY KEY, status TEXT NOT NULL,
    name TEXT, company TEXT, owner TEXT,
    seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS job_changes (
    id TEXT PRIMARY KEY,
    watch_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    raw TEXT NOT NULL,
    alert BOOLEAN NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    slack_sent_at TEXT, slack_attempts INTEGER NOT NULL DEFAULT 0, slack_next_try_at TEXT,
    digested_at TEXT
  );
`);
// Databases created by version 1.0 have no company_id column.
for (const ddl of ["ALTER TABLE emails ADD COLUMN confidence REAL", "ALTER TABLE people ADD COLUMN company_id INTEGER", "ALTER TABLE unresolved ADD COLUMN name TEXT", "ALTER TABLE unresolved ADD COLUMN company TEXT", "ALTER TABLE unresolved ADD COLUMN owner TEXT"]) {
  try { db.exec(ddl); } catch { /* already there */ }
}

export const settings = {
  get: (key: string): string | undefined => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value,
  set: (key: string, value: string) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value),
  delete: (key: string) => db.prepare("DELETE FROM settings WHERE key = ?").run(key),
};

/** The ids of this bot's watches. Version 1.0 stored a single `watch_id`. */
export const watchIds = {
  get(): number[] {
    const list = settings.get("watch_ids");
    if (list) return JSON.parse(list);
    const single = settings.get("watch_id");
    return single ? [Number(single)] : [];
  },
  set(ids: number[]) {
    settings.set("watch_ids", JSON.stringify(ids));
    settings.delete("watch_id");
  },
};

export type Person = {
  profile_url: string;
  crustdata_person_id?: number | null;
  name?: string | null;
  title?: string | null;
  company?: string | null;
  company_id?: number | null;
  source_input?: string | null;
  owner?: string | null;
};

export const people = {
  /** Inserts, or fills in fields on an existing row without overwriting known values with empty ones. */
  upsert: (p: Person) =>
    db.prepare(`
      INSERT INTO people (profile_url, crustdata_person_id, name, title, company, company_id, source_input, owner)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_url) DO UPDATE SET
        crustdata_person_id = COALESCE(excluded.crustdata_person_id, people.crustdata_person_id),
        name       = COALESCE(excluded.name, people.name),
        title      = COALESCE(excluded.title, people.title),
        company    = COALESCE(excluded.company, people.company),
        company_id = COALESCE(excluded.company_id, people.company_id),
        source_input = COALESCE(people.source_input, excluded.source_input),
        owner      = COALESCE(excluded.owner, people.owner)
    `).run(p.profile_url, p.crustdata_person_id ?? null, p.name ?? null, p.title ?? null, p.company ?? null, p.company_id ?? null, p.source_input ?? null, p.owner ?? null),
  /** After a change: record the person's current role. Only updates people already on the list. */
  updateRole: (profileUrl: string | undefined, personId: number | undefined, role: { title?: string; company?: string; companyId?: number }) => {
    const row = people.find(personId, profileUrl);
    if (!row) return;
    db.prepare("UPDATE people SET title = ?, company = ?, company_id = ?, crustdata_person_id = COALESCE(crustdata_person_id, ?) WHERE profile_url = ?")
      .run(role.title ?? null, role.company ?? null, role.companyId ?? null, personId ?? null, row.profile_url);
  },
  all: (): Person[] => db.prepare("SELECT * FROM people ORDER BY added_at, profile_url").all() as Person[],
  find: (personId?: number, profileUrl?: string): Person | undefined =>
    ((personId ? db.prepare("SELECT * FROM people WHERE crustdata_person_id = ?").get(personId) : undefined)
    ?? (profileUrl ? db.prepare("SELECT * FROM people WHERE profile_url = ?").get(normalizeProfileUrl(profileUrl)) : undefined)) as Person | undefined,
  /** Every email already resolved to a profile (with the match confidence), so it is never looked up and paid for twice. */
  resolvedEmails: (): Map<string, { profileUrl: string; confidence: number }> => new Map([
    ...(db.prepare("SELECT source_input AS email, profile_url FROM people WHERE source_input LIKE '%@%'").all() as { email: string; profile_url: string }[]).map(r => [r.email, { profileUrl: r.profile_url, confidence: 1 }] as const),
    ...(db.prepare("SELECT email, profile_url, confidence FROM emails").all() as { email: string; profile_url: string; confidence: number | null }[]).map(r => [r.email, { profileUrl: r.profile_url, confidence: r.confidence ?? 1 }] as const),
  ]),
  rememberEmail: (email: string, profileUrl: string, confidence = 1) =>
    db.prepare("INSERT INTO emails (email, profile_url, confidence) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET profile_url = excluded.profile_url, confidence = excluded.confidence").run(email, profileUrl, confidence),
  /** Matches made by name and company domain rather than an exact email. */
  likelyMatches: () => db.prepare("SELECT email, profile_url, confidence FROM emails WHERE confidence < 1 ORDER BY confidence").all() as { email: string; profile_url: string; confidence: number }[],
  /** Stops watching the person an email resolved to, unless another email or row still wants them. */
  removeByEmail: (email: string): void => { db.prepare("DELETE FROM people WHERE source_input = ?").run(email); },
  /** Records Crustdata's person id on a row found by profile URL, so later lookups never depend on URL spelling. */
  linkPersonId: (profileUrl: string, personId: number) => db.prepare("UPDATE people SET crustdata_person_id = ? WHERE profile_url = ? AND crustdata_person_id IS NULL").run(personId, profileUrl),
  /** Removes everyone not in `keep` (profile URLs). Returns how many were removed. */
  removeAllExcept: (keep: Set<string>): number => {
    let removed = 0;
    for (const p of people.all()) if (!keep.has(p.profile_url)) { db.prepare("DELETE FROM people WHERE profile_url = ?").run(p.profile_url); removed++; }
    return removed;
  },
  count: (): number => (db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n,
};

export const unresolved = {
  add: (input: string, status: string, row: { name?: string; company?: string; owner?: string } = {}) =>
    db.prepare(`INSERT INTO unresolved (input, status, name, company, owner) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(input) DO UPDATE SET status = excluded.status, name = COALESCE(excluded.name, unresolved.name),
        company = COALESCE(excluded.company, unresolved.company), owner = COALESCE(excluded.owner, unresolved.owner), seen_at = datetime('now')`)
      .run(input, status, row.name ?? null, row.company ?? null, row.owner ?? null),
  remove: (input: string) => db.prepare("DELETE FROM unresolved WHERE input = ?").run(input),
  /** Emails not worth sending to identify again: removed on request, or no match in the last 30 days. */
  skippable: (): Set<string> => new Set((db.prepare("SELECT input FROM unresolved WHERE status IN ('redacted', 'invalid', 'no_profile_url') OR (status = 'not_found' AND seen_at > datetime('now', '-30 days'))").all() as { input: string }[]).map(r => r.input)),
  all: () => db.prepare("SELECT input, status, name, company, owner FROM unresolved ORDER BY status, input").all() as { input: string; status: string; name: string | null; company: string | null; owner: string | null }[],
};

type ChangeRow = { id: string; kind: string; data: string; raw: string; alert: number; received_at: string; slack_attempts: number };
export type StoredChange = JobChange & { receivedAt: string; slackAttempts: number };
const fromRow = (r: ChangeRow): StoredChange => ({ ...JSON.parse(r.data), raw: r.raw, receivedAt: r.received_at, slackAttempts: r.slack_attempts });

export const jobChanges = {
  exists: (id: string): boolean => Boolean(db.prepare("SELECT 1 FROM job_changes WHERE id = ?").get(id)),
  /** Stores a batch in one transaction. Returns how many were new. `alert` is false for kinds you chose not to be told about. */
  insertMany: (changes: JobChange[], isAlert: (c: JobChange) => boolean): number => {
    const stmt = db.prepare("INSERT OR IGNORE INTO job_changes (id, watch_id, kind, data, raw, alert) VALUES (?, ?, ?, ?, ?, ?)");
    let added = 0;
    db.exec("BEGIN");
    try {
      for (const c of changes) {
        const { raw, ...data } = c;
        added += Number(stmt.run(c.id, c.watchId, c.kind, JSON.stringify(data), raw, isAlert(c) ? 1 : 0).changes);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return added;
  },
  /** The outbox: alerts not yet in Slack, due for a (re)try, received in the last 2 days. */
  dueForSlack: (limit = 20, exclude: string[] = []): StoredChange[] => (db.prepare(`
    SELECT * FROM job_changes WHERE alert = 1 AND slack_sent_at IS NULL
      AND (slack_next_try_at IS NULL OR slack_next_try_at <= datetime('now'))
      AND received_at > datetime('now', '-2 days')
      AND id NOT IN (SELECT value FROM json_each(?))
    ORDER BY received_at LIMIT ?`).all(JSON.stringify(exclude), limit) as ChangeRow[]).map(fromRow),
  markSentToSlack: (id: string) => db.prepare("UPDATE job_changes SET slack_sent_at = datetime('now') WHERE id = ?").run(id),
  markSlackFailed: (id: string, retryInSeconds: number) =>
    db.prepare("UPDATE job_changes SET slack_attempts = slack_attempts + 1, slack_next_try_at = datetime('now', ?) WHERE id = ?").run(`+${Math.round(retryInSeconds)} seconds`, id),
  notYetDigested: (): StoredChange[] => (db.prepare("SELECT * FROM job_changes WHERE alert = 1 AND digested_at IS NULL ORDER BY kind, received_at").all() as ChangeRow[]).map(fromRow),
  markDigested: (ids: string[]) => {
    const stmt = db.prepare("UPDATE job_changes SET digested_at = datetime('now') WHERE id = ?");
    db.exec("BEGIN");
    try { for (const id of ids) stmt.run(id); db.exec("COMMIT"); }
    catch (err) { db.exec("ROLLBACK"); throw err; }
  },
  count: (): number => (db.prepare("SELECT COUNT(*) AS n FROM job_changes WHERE alert = 1").get() as { n: number }).n,
  /** Alerts that crossed the 2-day retry limit in the last day without reaching Slack. */
  newlyUndelivered: (): number => (db.prepare("SELECT COUNT(*) AS n FROM job_changes WHERE alert = 1 AND slack_sent_at IS NULL AND received_at <= datetime('now', '-2 days') AND received_at > datetime('now', '-3 days')").get() as { n: number }).n,
  /** Every change received in the last `days` days, newest first. */
  since: (days: number): (StoredChange & { alerted: boolean })[] =>
    (db.prepare("SELECT * FROM job_changes WHERE received_at > datetime('now', ?) ORDER BY received_at DESC").all(`-${days} days`) as ChangeRow[]).map(r => ({ ...fromRow(r), alerted: r.alert === 1 })),
  countByKind: () => db.prepare("SELECT kind, COUNT(*) AS n FROM job_changes GROUP BY kind").all() as { kind: string; n: number }[],
  /** Deletes stored profile data for changes older than `days`. Returns how many rows were removed. */
  purgeOlderThan: (days: number): number => Number(db.prepare("DELETE FROM job_changes WHERE received_at < datetime('now', ?) AND (digested_at IS NOT NULL OR slack_sent_at IS NOT NULL OR alert = 0)").run(`-${days} days`).changes),
};

/** Watch runs already handled, so catch-up never processes a run twice. */
export const runsSeen = {
  add: (watchId: number, runId: number) => db.prepare("INSERT OR IGNORE INTO runs_seen (watch_id, run_id) VALUES (?, ?)").run(watchId, runId),
  has: (watchId: number, runId: number): boolean => Boolean(db.prepare("SELECT 1 FROM runs_seen WHERE watch_id = ? AND run_id = ?").get(watchId, runId)),
};
