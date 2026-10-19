/**
 * Turns a Crustdata watch notification into job change events. Pure functions, no I/O, easy to test.
 *
 * Notification shape (entity watch):
 *   { metadata: { watch_id, run_id, test?, payload_delivery: { type: "inline" | "link", url? } },
 *     results: [ { changes: [ ... ], record: { crustdata_person_id, basic_profile, experience, social_handles } } ] }
 *
 * Each result is classified, because the watch fires on any new position or title edit:
 *   new_company   their main role is now at a different company
 *   title_change  new title at the same company (a promotion, or a lateral move)
 *   left_company  their role ended and no current role is listed yet
 *   added_role    a side role (advisor, board, part time) while they stay at their main company
 *   title_edit    the title only changed in case or punctuation; never alerted
 *
 * Docs: https://docs.crustdata.com/watcher-docs/person/entity#what-a-notification-looks-like
 */

import { createHash } from "node:crypto";
import { normalizeProfileUrl } from "./profile-url.js";

export type WatchResult = { changes: any[]; record: any };

export type Notification = {
  metadata: {
    watch_id: number;
    run_id?: number;
    test?: boolean;
    payload_delivery?: { type: "inline" | "link"; url?: string };
  };
  results?: WatchResult[];
};

export type ChangeKind = "new_company" | "title_change" | "left_company" | "added_role" | "title_edit";
export const ALERT_KINDS: ChangeKind[] = ["new_company", "title_change", "left_company", "added_role"];

export type JobChange = {
  /** Stable id: the same person in the same run always gets the same id, so redeliveries are ignored. */
  id: string;
  kind: ChangeKind;
  watchId: number;
  runId?: number;
  crustdataPersonId?: number;
  profileUrl?: string;
  name?: string;
  /** The role they left (new_company, left_company) or their title before (title_change). */
  previousTitle?: string;
  previousCompany?: string;
  previousTenureMonths?: number;
  /** The role they moved into, or the side role they added. */
  newTitle?: string;
  newCompany?: string;
  newCompanyDomain?: string;
  newCompanyId?: number;
  startDate?: string;
  /** For added_role and left_company: the role they still hold. */
  stillTitle?: string;
  stillCompany?: string;
  /** Account owner from your CSV, filled in when the event is handled. */
  owner?: string;
  raw: string;
};

export type Position = {
  title?: string;
  name?: string;
  start_date?: string;
  end_date?: string | null;
  is_default?: boolean;
  crustdata_company_id?: number;
  company_website_domain?: string;
  years_at_company_raw?: number;
  position_id?: number | string;
};

/** What we already knew about a person, from the CSV or an earlier alert. */
export type KnownRole = { title?: string; company?: string; companyId?: number };

/** The baseline run and test sends carry empty `changes` or `metadata.test`; neither is a job change. */
export const isBaselineOrTest = (n: Notification): boolean =>
  Boolean(n.metadata?.test) || (n.results ?? []).every(r => !r.changes?.length);

/** Records of a run when the watch uses `payload_delivery_type: "link"`: one JSON result per line. */
export function parseNdjson(text: string): WatchResult[] {
  const out: WatchResult[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { console.warn("Skipped one unreadable line in a run file."); }
  }
  return out;
}

export function toJobChanges(
  watchId: number,
  runId: number | undefined,
  results: WatchResult[],
  knownRole: (personId?: number, profileUrl?: string) => KnownRole | undefined = () => undefined,
): JobChange[] {
  const out: JobChange[] = [];
  for (const result of Array.isArray(results) ? results : []) {
    if (!Array.isArray(result?.changes) || !result.changes.length) continue;
    const record = result.record ?? {};
    const personId: number | undefined = record.crustdata_person_id;
    const rawUrl: string | undefined = record.social_handles?.professional_network_identifier?.profile_url;
    const profileUrl = rawUrl ? normalizeProfileUrl(rawUrl) : undefined;
    const personKey = personId ?? profileUrl ?? createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 16);

    const base = {
      id: `${watchId}:${runId ?? "norun"}:${personKey}`,
      watchId,
      runId,
      crustdataPersonId: personId,
      profileUrl,
      name: record.basic_profile?.name,
      raw: JSON.stringify(result),
    };
    try {
      const change = classify(result.changes.filter((c: unknown) => c && typeof c === "object"), record, knownRole(personId, profileUrl));
      if (change) out.push({ ...base, ...change });
    } catch (err) {
      console.warn(`Skipped one malformed result for person ${personKey}: ${(err as Error).message}`);
    }
  }
  return out;
}

type Classified = Omit<JobChange, "id" | "watchId" | "runId" | "crustdataPersonId" | "profileUrl" | "name" | "raw">;

/** Titles that are side roles rather than a main job. */
const SIDE_ROLE = /\b(advisor|adviser|advisory board|board (member|director|observer|advisor)|member of the board|board of (directors|trustees|advisors)|angel investor|mentor|volunteer$|ambassador|trustee)\b/i;

const positions = (value: unknown): Position[] => (Array.isArray(value) ? value.filter(p => p && typeof p === "object") : []);

function classify(changes: any[], record: any, known: KnownRole | undefined): Classified | undefined {
  const current = positions(record.experience?.employment_details?.current);
  const past = positions(record.experience?.employment_details?.past);
  const addedCurrent = positions(changes.find(c => c.type === "added" && String(c.field).startsWith("experience.employment_details.current"))?.new_elements);
  const addedPast = positions(changes.find(c => c.type === "added" && String(c.field).startsWith("experience.employment_details.past"))?.new_elements);
  const titleChange = changes.find(c => c.type === "changed" && c.field === "basic_profile.current_title");
  const knownPrevious: Position | undefined = known?.company ? { title: known.title, name: known.company, crustdata_company_id: known.companyId } : undefined;

  // The role that just ended: prefer the one that was their main role, not a side role ending at the same time.
  const justEnded = addedPast.find(p => sameTitle(p.title, titleChange?.from)) ?? addedPast.find(p => sameCompany(p, knownPrevious))
    ?? addedPast.find(p => p.is_default) ?? latestEnded(addedPast);

  // 1. A new current position appeared.
  if (addedCurrent.length) {
    const existing = current.filter(p => !addedCurrent.some(a => samePosition(a, p)));
    const main = mainPosition(existing);
    // The new title points at the role that is now their main one, unless their flagged main role is still current.
    const byTitle = titleChange?.to ? addedCurrent.find(p => sameTitle(p.title, titleChange.to)) : undefined;
    const added = enrich(byTitle ?? mainPosition(addedCurrent)!, current);
    // A side role (advisor, board seat) does not replace a main role that is still flagged, even if the title says so.
    const mainStillFlagged = Boolean(main?.is_default) && !(justEnded && samePosition(justEnded, main!));
    const titleWins = Boolean(byTitle) && !(mainStillFlagged && SIDE_ROLE.test(added.title ?? ""));
    const isMain = titleWins || Boolean(added.is_default) || !main || sameCompany(added, main);
    if (!isMain) return { kind: "added_role", ...newRole(added), stillTitle: main!.title, stillCompany: main!.name };

    const recent = daysBetween(added.start_date, new Date().toISOString()) <= 180;
    const endedElsewhere = justEnded && !sameCompany(justEnded, added) ? justEnded : undefined;

    // A promotion: their previous role here just ended, is still listed, or (with nothing ending elsewhere) your CSV says they work here.
    const promotedFrom = (justEnded && sameCompany(justEnded, added) ? justEnded : undefined)
      ?? existing.find(p => sameCompany(p, added))
      ?? (!endedElsewhere && knownPrevious && sameCompany(knownPrevious, added) ? knownPrevious : undefined);
    if (promotedFrom) {
      const before = promotedFrom === knownPrevious ? titleChange?.from ?? promotedFrom.title : promotedFrom.title ?? titleChange?.from;
      return { kind: sameTitle(before, added.title) ? "title_edit" : "title_change", ...newRole(added), previousTitle: before, previousCompany: added.name };
    }

    // A role at another company just ended: a move.
    if (endedElsewhere) return { kind: "new_company", ...newRole(added), ...previousRole(endedElsewhere) };

    // A role that started long ago, whose title was renamed, with no other company still listed: a promotion edited in place.
    const startedLongAgo = Boolean(added.start_date) && !recent;
    const elsewhereStillListed = existing.some(p => !sameCompany(p, added));
    const knownElsewhere = Boolean(knownPrevious && !sameCompany(knownPrevious, added));
    if (titleChange && (startedLongAgo || (!added.start_date && !knownElsewhere)) && !elsewhereStillListed) {
      return { kind: sameTitle(titleChange.from, added.title) ? "title_edit" : "title_change", ...newRole(added), previousTitle: titleChange.from, previousCompany: added.name };
    }

    // What we knew, or a role elsewhere not yet end-dated.
    const previous = (knownPrevious && !sameCompany(knownPrevious, added) ? knownPrevious : undefined) ?? mainPosition(existing.filter(p => !sameCompany(p, added)));
    if (previous) return { kind: "new_company", ...newRole(added), ...previousRole(previous) };

    if (titleChange && sameTitle(titleChange.from, added.title)) return { kind: "title_edit", ...newRole(added) };
    const lastPast = latestEnded(past.filter(p => !sameCompany(p, added)));
    // An old role added to the profile, with nothing else changing, is a profile update rather than a move.
    if (added.start_date && daysBetween(added.start_date, new Date().toISOString()) > 365 && !titleChange) return undefined;
    const nearby = lastPast && recent && daysBetween(lastPast.end_date, added.start_date) <= 120 ? lastPast : undefined;
    return { kind: "new_company", ...newRole(added), ...previousRole(nearby) };
  }

  // 2. Their main role ended recently and nothing current remains at that company (they may keep a side role).
  if (justEnded && !current.some(p => sameCompany(p, justEnded))) {
    const now = new Date().toISOString();
    const endedRecently = justEnded.end_date ? daysBetween(justEnded.end_date, now) <= 180
      : Boolean(titleChange) || (Boolean(justEnded.start_date) && daysBetween(justEnded.start_date, now) <= 5 * 365);
    const evidence = Boolean(justEnded.is_default) || sameTitle(justEnded.title, titleChange?.from) || sameCompany(justEnded, knownPrevious)
      || (!current.length && Boolean(titleChange || record.basic_profile?.current_title == null))
      || (current.length > 0 && !current.some(p => p.is_default) && !current.some(p => sameTitle(p.title, record.basic_profile?.current_title)));
    const main = mainPosition(current);
    if (endedRecently && evidence) return { kind: "left_company", ...previousRole(justEnded), stillTitle: main?.title, stillCompany: main?.name };
  }

  // 3. Only the title changed: same company.
  if (titleChange) {
    const main = mainPosition(current);
    const kind: ChangeKind = sameTitle(titleChange.from, titleChange.to) ? "title_edit" : "title_change";
    return { kind, newTitle: titleChange.to ?? main?.title, newCompany: main?.name, newCompanyDomain: main?.company_website_domain, newCompanyId: main?.crustdata_company_id, previousTitle: titleChange.from, previousCompany: main?.name };
  }

  return undefined; // a side role ended while the main role continues: not worth an alert
}

/** Days between two dates, or Infinity when either is missing. */
function daysBetween(a?: string | null, b?: string | null): number {
  const x = Date.parse(a ?? ""), y = Date.parse(b ?? "");
  return isNaN(x) || isNaN(y) ? Infinity : Math.abs(y - x) / 86_400_000;
}

const newRole = (p: Position) => ({
  newTitle: p.title,
  newCompany: p.name,
  newCompanyDomain: p.company_website_domain,
  newCompanyId: p.crustdata_company_id,
  startDate: p.start_date ?? undefined,
});

const previousRole = (p?: Position) => ({
  previousTitle: p?.title,
  previousCompany: p?.name,
  previousTenureMonths: tenureMonths(p),
});

/** The role marked as the person's main one, else the most recently started. */
function mainPosition(positions: Position[]): Position | undefined {
  return positions.find(p => p.is_default) ?? latestStarted(positions);
}

function latestStarted(positions: Position[]): Position | undefined {
  return [...positions].sort((a, b) => String(b.start_date ?? "").localeCompare(String(a.start_date ?? "")))[0];
}

function latestEnded(positions: Position[]): Position | undefined {
  return [...positions].sort((a, b) =>
    String(b.end_date ?? "").localeCompare(String(a.end_date ?? "")) || String(b.start_date ?? "").localeCompare(String(a.start_date ?? "")))[0];
}

/** The change carries a short position; the record carries the full one (domain, company id). */
function enrich(p: Position, current: Position[]): Position {
  const full = current.find(c => (p.position_id !== undefined && c.position_id === p.position_id) || (c.title === p.title && c.name === p.name));
  return { ...full, ...p, ...(full ? { crustdata_company_id: full.crustdata_company_id ?? p.crustdata_company_id, company_website_domain: full.company_website_domain ?? p.company_website_domain } : {}) };
}

function samePosition(a: Position, b: Position): boolean {
  if (a.position_id !== undefined && b.position_id !== undefined) return a.position_id === b.position_id;
  return a.title === b.title && a.name === b.name;
}

/** Legal suffixes are only dropped as the last word: "Acme Inc" matches "Acme", but "Square Co" is not "Square Co Labs". */
const COMPANY_SUFFIX = /\s+(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|gmbh|plc|sa|ag|bv|com)$/;
function normalizeCompany(name?: string): string {
  let n = (name ?? "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim().replace(/^the\s+/, "");
  for (let prev = ""; prev !== n; ) { prev = n; n = n.replace(COMPANY_SUFFIX, "").trim(); }
  return n.replace(/\s+/g, "");
}

export function sameCompany(a?: Position, b?: Position): boolean {
  if (!a || !b) return false;
  if (a.crustdata_company_id && b.crustdata_company_id) return a.crustdata_company_id === b.crustdata_company_id;
  const x = normalizeCompany(a.name), y = normalizeCompany(b.name);
  return Boolean(x) && x === y;
}

/** "VP Sales" and "VP, sales" are the same title; "VP Sales" and "SVP Sales" are not. */
export function sameTitle(a?: string, b?: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (!a || !b) return false;
  const x = norm(a), y = norm(b);
  return x.length > 0 && x === y;
}

function tenureMonths(p?: Position): number | undefined {
  if (!p) return undefined;
  if (p.start_date && p.end_date) {
    const s = new Date(p.start_date), e = new Date(p.end_date);
    if (!isNaN(+s) && !isNaN(+e) && e >= s) return (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  }
  return p.years_at_company_raw ? Math.round(p.years_at_company_raw * 12) : undefined;
}

// ---------------------------------------------------------------------------
// Wording shared by Slack and email
// ---------------------------------------------------------------------------

/** "VP of Sales at Northwind" from a title and a company, either of which may be missing. */
export const roleLabel = (title?: string, company?: string): string => [title, company].filter(Boolean).join(" at ");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-01T00:00:00+00:00" to "Oct 2026". */
export function monthYear(date?: string): string | undefined {
  const m = /^(\d{4})-(\d{2})/.exec(date ?? "");
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : undefined;
}

/** 43 to "3 years 7 months". */
export function duration(months?: number): string | undefined {
  if (months === undefined || months < 1) return undefined;
  const y = Math.floor(months / 12), m = months % 12;
  return [y && `${y} year${y === 1 ? "" : "s"}`, m && `${m} month${m === 1 ? "" : "s"}`].filter(Boolean).join(" ");
}

/** One-line headline per kind, used by Slack and email. Plain text. */
export function headline(e: JobChange): string {
  const who = e.name ?? "Someone on your list";
  switch (e.kind) {
    case "new_company": return `${who} moved to ${e.newCompany ?? "a new company"}`;
    case "title_change": return `${who} has a new title at ${e.newCompany ?? "their company"}`;
    case "left_company": return `${who} left ${e.previousCompany ?? "their company"}`;
    case "added_role": return `${who} added a role at ${e.newCompany ?? "another company"}`;
    case "title_edit": return `${who} edited their title`;
  }
}
