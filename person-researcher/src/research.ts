/**
 * The run: inputs in, briefs out. Resolves each input to a person, makes the Crustdata calls in order, builds and
 * writes the briefs. All the rules live in `brief.ts` (pure); this file is the order of calls, the cache and files.
 *
 * Calls per person, in order (list price):
 *   profile URL         /person/enrich by URL                                      1
 *   work email          /person/enrich by business_emails                          1
 *     not found         /person/identify (personal emails, name at the domain)     1, then enrich by URL 1
 *   name (+ company)    /person/search, up to 5 people (one match continues)       0.03 each, + 0.1 each with a company
 *     none at company   /person/search again on past employers                     same
 *   then                /social_post/search, newest posts they wrote               0.5 per post (5 by default)
 *                       /web/search/live, web results for "name" company          1
 *                       /web/search/live, news from the last NEWS_DAYS days        1 (0 seen when empty)
 *   --contact           /person/contact/enrich                                     1 work, 2 personal, 2 phone
 * Every miss is free. Answers are cached for CACHE_HOURS, so a repeat costs nothing.
 *
 * One person's failure (a 500, a plan gate, odd data) only affects that person. A bad key (401) or an empty account
 * (402) stops the run with RunStopped, which carries everything finished so far, so nothing paid for is lost.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildBrief, searchPhrase, type Brief } from "./brief.js";
import { Cache } from "./cache.js";
import { ROOT, config } from "./config.js";
import {
  BRIEF_FIELDS, CONTACT_FIELDS, CrustdataError, enrich, enrichContacts, fmtCredits, identifyEmails,
  meter, recentPosts, searchByName, spend, webSearch, type Candidate, type ContactKind, type MatchRow, type PersonData,
  type Post, type WebResult,
} from "./crustdata.js";
import { normalizeProfileUrl, type Input } from "./input.js";
import { renderBrief, renderIndex, type IndexRow } from "./render.js";

export type Options = {
  days: number;          // window for "what changed lately"
  posts: number;         // posts to show, 0 to 10 (0 still shows the free post count)
  noPosts: boolean;      // skip the post search entirely
  web: boolean;          // web and news searches
  contact: ContactKind[];
  pick?: number;         // which of several name matches to research
  refresh: boolean;      // ignore the cache
  now: Date;
};

/** The news window, in days. */
export const NEWS_DAYS = 90;

/** Defaults. `now` is read each time, so a long-lived process never works with its start-up date. */
export const DEFAULTS: Options = {
  days: 180, posts: 5, noPosts: false, web: true, contact: [], refresh: false,
  get now() { return fixedNow ?? new Date(); },
  set now(d: Date) { fixedNow = d; },
};
let fixedNow: Date | undefined;

/** List prices, used for the "at most" estimate. */
export const LIST = { enrich: 1, identify: 1, searchPerPerson: 0.03, searchCompanyFilter: 0.1, post: 0.5, web: 1 };

/** The most a run can cost at list price, before anything is cached or missed. */
export function estimate(inputs: Input[], o: Options): number {
  const perPerson = (o.noPosts ? 0 : o.posts * LIST.post) + (o.web ? 2 * LIST.web : 0) + o.contact.reduce((s, k) => s + CONTACT_FIELDS[k].credits, 0);
  return inputs.reduce((s, x) => {
    // A name search returns up to 5 people (the second, past-employer search only runs when the first found nobody,
    // which is free); an email may need Person Identify first.
    const find = x.kind === "name" ? 5 * (LIST.searchPerPerson + (x.company ? LIST.searchCompanyFilter : 0)) : x.kind === "email" ? LIST.identify : 0;
    return s + find + LIST.enrich + perPerson;
  }, 0);
}

export type Outcome = { input: Input; status: IndexRow["status"]; brief?: Brief; note?: string; candidates?: Candidate[] };

/** Credits the last research() call used (for its index), separate from the process total in `spend`. */
export const lastRun = { credits: 0 };

/** Thrown when the whole run must stop (bad key, no credits). Carries everything finished before it. */
export class RunStopped extends Error {
  constructor(message: string, public outcomes: Outcome[], public credits: number) { super(message); }
}

type Log = (msg: string) => void;

function ignoreSites(): string[] {
  try {
    const j = JSON.parse(readFileSync(resolve(ROOT, "config/ignored-sites.json"), "utf8"));
    return Array.isArray(j?.domains) ? j.domains.map((d: unknown) => String(d).toLowerCase()) : [];
  } catch { return []; }
}

const matched = (row: MatchRow | undefined): PersonData | undefined =>
  row?.match_status === "matched" ? row.matches?.[0]?.person_data : undefined;
const score = (row: MatchRow | undefined): number | undefined => {
  const n = Number(row?.matches?.[0]?.confidence_score);
  return Number.isFinite(n) ? n : undefined;
};
const profileUrlOf = (p: PersonData | Candidate | undefined): string | undefined => {
  const u = p?.social_handles?.professional_network_identifier?.profile_url;
  return u ? normalizeProfileUrl(u) ?? u : undefined;
};

/** A bad key or an empty account stops the whole run; anything else only costs one person or one section. */
const stopsRun = (err: unknown) => err instanceof CrustdataError && (err.status === 401 || err.status === 402 || (err.status === 403 && /insufficient credits|out of credits/i.test(err.apiMessage)));
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const candidateLine = (c: Candidate, i: number) => {
  const b = c.basic_profile ?? {};
  const where = b.location?.raw || b.location?.full_location || "";
  return `  ${i + 1}. ${b.name ?? "?"}${b.headline ? `, ${b.headline}` : b.current_title ? `, ${b.current_title}` : ""}${where ? ` (${where})` : ""}  ${profileUrlOf(c) ?? ""}`;
};

/**
 * Researches every input and returns one outcome per input, in order. `onBrief` is called as each brief is finished
 * (the CLI writes the file there). Throws RunStopped only for a bad key or an empty account.
 */
export async function research(inputs: Input[], o: Options, log: Log, onBrief: (o: Outcome) => void | Promise<void> = () => {}): Promise<Outcome[] & { credits: number }> {
  const run = { credits: 0, denied: new Set<string>() };
  // Inputs from code (a calendar API) may carry emails as typed: one form for every lookup and cache key.
  const norm = inputs.map(x => x.kind === "email" ? { ...x, email: x.email.trim().toLowerCase() } : x.kind === "url" ? { ...x, url: normalizeProfileUrl(x.url) ?? x.url } : x);
  const outcomes = await meter.run(run, () => researchRun(norm, o, log, onBrief, run));
  // The credits this call used, on the result itself, so concurrent calls never mix them up.
  return Object.assign(outcomes, { credits: run.credits });
}

async function researchRun(inputs: Input[], o: Options, log: Log, onBrief: (o: Outcome) => void | Promise<void>, run: { credits: number; denied: Set<string> }): Promise<Outcome[]> {
  const cache = new Cache(join(config.outDir, ".cache"), config.cacheHours, o.refresh);
  cache.purge();
  const sites = ignoreSites();
  const outcomes: Outcome[] = inputs.map(input => ({ input, status: "failed", note: "Not reached." }));
  const people: Array<{ i: number; person: PersonData; by: string; score?: number; check?: string }> = [];
  const fieldsKey = BRIEF_FIELDS.join(",");
  const now = o.now;
  // Field groups this key could not read on an earlier run (within CACHE_HOURS) are not asked for again; --refresh
  // asks again, so a field Crustdata has since enabled comes back.
  const deniedBefore = o.refresh ? [] : cache.get<string[]>("denied-fields") ?? [];
  deniedBefore.forEach(f => run.denied.add(f));

  try {
    // 1. Names to profile URLs. One match continues; several stop with a numbered list (or --pick n).
    const byUrl: Array<{ i: number; url: string; by: string; score?: number; check?: string }> = [];
    let searchOff = false;
    for (const [i, x] of inputs.entries()) {
      if (x.kind === "url") byUrl.push({ i, url: x.url, by: "profile URL" });
      if (x.kind !== "name") continue;
      if (searchOff) { outcomes[i] = { input: x, status: "failed", note: "Name lookup (/person/search) is not enabled on this key; use their profile URL or email." }; continue; }
      try {
        log(`Looking up ${x.name}${x.company ? ` at ${x.company}` : ""}...`);
        const key = `search|${x.name.toLowerCase()}|${(x.company ?? "").toLowerCase()}`;
        let { value: found } = await cache.through(key, () => searchByName(x.name, x.company));
        let by = `name${x.company ? " and company" : ""}`;
        if (!found.people.length && x.company) {
          // Their CRM row may be older than their move: try the company as a past employer.
          found = (await cache.through(`${key}|any`, () => searchByName(x.name, x.company, 5, "any"))).value;
          by = "name and a past company";
        }
        const pickable = found.people.filter(c => profileUrlOf(c));
        const picked = pickable.length > 1 && o.pick && inputs.length === 1 ? pickable[o.pick - 1] : undefined;
        const chosen = pickable.length === 1 ? pickable[0] : picked;
        const check = picked ? `this is match ${o.pick} of ${found.total > pickable.length ? found.total.toLocaleString("en-US") : pickable.length} people named "${x.name}"` : undefined;
        if (chosen) byUrl.push({ i, url: profileUrlOf(chosen)!, by: picked ? `${by} (match ${o.pick})` : by, check });
        else if (!pickable.length) {
          outcomes[i] = { input: x, status: "not_found", note: `No one named "${x.name}"${x.company ? ` at ${x.company} (now or before)` : ""} found (not charged).${x.company ? " Check the spelling, or use the company's website domain (acme.com)." : " Add the company."}` };
        } else {
          const all = found.total > pickable.length ? `${found.total.toLocaleString("en-US")} people match "${x.name}"; the top ${pickable.length} are below.` : `${pickable.length} people match "${x.name}".`;
          const next = o.pick && pickable.length < o.pick ? ` --pick ${o.pick} is more than the ${pickable.length} listed.`
            : inputs.length === 1 ? ` Pick one: npm run research -- --name "${x.name}"${x.company ? ` --company "${x.company}"` : ""} --pick 1${x.company ? "" : " (or add --company acme.com)"}.`
            : ` Add their company to this line ("${x.name}, acme.com") or use one of these profile URLs.`;
          outcomes[i] = { input: x, status: "pick", candidates: pickable, note: `${all}${next}` };
        }
      } catch (err) {
        if (stopsRun(err)) throw err;
        if (err instanceof CrustdataError && err.status === 403) searchOff = true;
        outcomes[i] = { input: x, status: "failed", note: err instanceof CrustdataError && err.status === 403 ? "Name lookup (/person/search) is not enabled on this key; use their profile URL or email." : `Name lookup failed: ${why(err)}` };
      }
    }

    // 2. Emails: a work email straight to enrich (1 credit); the misses go to identify, which also knows personal
    //    emails and matches names at the company's domain.
    const emails = inputs.map((x, i) => ({ x, i })).filter(e => e.x.kind === "email") as Array<{ x: Extract<Input, { kind: "email" }>; i: number }>;
    if (emails.length) {
      log(`Looking up ${emails.length} email${emails.length > 1 ? "s" : ""}...`);
      const { rows, error } = await enrichCached(cache, "business_email", emails.map(e => e.x.email), fieldsKey, log);
      // A 400 means Crustdata did not take work emails on /person/enrich (it is not in its docs): identify does the
      // rest. Any other failure fails only the emails that have no answer yet (answers already paid for are kept).
      const unsupported = error instanceof CrustdataError && error.status === 400;
      const misses = emails.filter(e => {
        const row = rows.get(e.x.email);
        const person = matched(row);
        if (person) { people.push({ i: e.i, person, by: "work email" }); return false; }
        if (!row && error && !unsupported) { outcomes[e.i] = { input: e.x, status: "failed", note: `Email lookup failed: ${why(error)}` }; return false; }
        return true;
      });
      if (misses.length) {
        try {
          const todo = [...new Set(misses.filter(e => cache.get<MatchRow>(`identify|${e.x.email}`) === undefined).map(e => e.x.email))];
          const invalid: string[] = [];
          // One batch of 25 at a time, each saved before the next, so a failure later never re-bills earlier ones.
          let batchError: unknown;
          for (let k = 0; k < todo.length; k += 25) {
            const batch = todo.slice(k, k + 25);
            let got: Awaited<ReturnType<typeof identifyEmails>>;
            try { got = await identifyEmails(batch); }
            catch (err) {
              // A failure on a later batch keeps the matches already paid for; 403 (not enabled) is handled below.
              if (stopsRun(err) || k === 0) throw err;
              batchError = err;
              break;
            }
            invalid.push(...got.invalid);
            const byEmail = new Map(got.rows.map(r => [String(r.matched_on ?? "").trim().toLowerCase(), r]));
            for (const email of batch) {
              const r = byEmail.get(email);
              // Misses are saved too: asking again is free but costs a paced call. Refused addresses are not.
              if (r && r.match_status !== "redacted") cache.set(`identify|${email}`, r);
              else if (!r && !got.invalid.includes(email)) cache.set(`identify|${email}`, { matched_on: email, match_status: "not_found", matches: [] });
            }
          }
          for (const e of misses) {
            const row = cache.get<MatchRow>(`identify|${e.x.email}`);
            const url = profileUrlOf(matched(row));
            if (url) byUrl.push({ i: e.i, url, by: "email", score: score(row) });
            else if (!row && batchError) outcomes[e.i] = { input: e.x, status: "failed", note: `Email lookup failed: ${why(batchError)}` };
            else outcomes[e.i] = { input: e.x, status: "not_found", note: invalid.includes(e.x.email) ? "Crustdata does not accept this address (check the spelling and the domain)." : "No one found for this email (not charged). Try their profile URL, or --name with --company." };
          }
        } catch (err) {
          if (stopsRun(err)) throw err;
          const off = err instanceof CrustdataError && err.status === 403;
          for (const e of misses) outcomes[e.i] = off
            ? { input: e.x, status: "not_found", note: "No one found for this email (not charged). Personal emails and addresses Crustdata has not seen need Person Identify (/person/identify), which is not enabled on this key." }
            : { input: e.x, status: "failed", note: `Email lookup failed: ${why(err)}` };
        }
      }
    }

    // 3. Profile URLs (typed, from a name, or from an email) to profiles. Each URL is sent once.
    if (byUrl.length) {
      const unique = new Set(byUrl.map(u => u.url)).size;
      log(`Enriching ${unique} profile${unique > 1 ? "s" : ""}...`);
      const { rows, error } = await enrichCached(cache, "profile_url", byUrl.map(u => u.url), fieldsKey, log);
      for (const u of byUrl) {
        const row = rows.get(u.url);
        const person = matched(row);
        if (person) people.push({ i: u.i, person, by: u.by, score: u.score, check: u.check });
        else if (!row && error) outcomes[u.i] = { input: inputs[u.i], status: "failed", note: `Profile lookup failed: ${why(error)}` };
        else outcomes[u.i] = { input: inputs[u.i], status: "not_found", note: inputs[u.i].kind === "url" ? "No profile found at this URL (not charged). Check it opens in a browser." : "Crustdata has no full profile for this match (not charged). Try another match or their profile URL." };
      }
    }

    // The same person reached twice (an email and a profile URL in one list) gets one brief, and is paid for once.
    const firstFor = new Map<string, number>();
    for (const p of [...people].sort((a, b) => a.i - b.i)) {
      const id = String(p.person.crustdata_person_id ?? profileUrlOf(p.person) ?? "");
      if (!id) continue;
      if (firstFor.has(id)) {
        outcomes[p.i] = { input: inputs[p.i], status: "skipped", note: `Same person as "${inputs[firstFor.get(id)!].raw}".` };
        people.splice(people.indexOf(p), 1);
      } else firstFor.set(id, p.i);
    }
    people.sort((a, b) => a.i - b.i);

    // 4. Contacts for everyone found (only with --contact), cached per person and per kind.
    const contacts = new Map<string, Record<string, unknown>>();
    // Only people whose every requested kind got an answer (now or from the cache) get a Contact section; the rest get
    // a note, so "no contact details found" is never said for a lookup that did not happen.
    const answered = new Set<string>();
    let contactProblem: string | undefined;
    if (o.contact.length && people.length) {
      try {
        log(`Looking up contact details (${o.contact.join(", ")})...`);
        const urls = [...new Set(people.map(p => profileUrlOf(p.person)).filter((u): u is string => !!u))];
        const groups = new Map<string, string[]>();
        for (const url of urls) {
          const have: Record<string, unknown> = {};
          const need: ContactKind[] = [];
          for (const k of o.contact) {
            const saved = cache.get<unknown[]>(`contact|${k}|${url}`);
            if (saved === undefined) need.push(k);
            else have[CONTACT_FIELDS[k].field.split(".")[1]] = saved;
          }
          contacts.set(url, have);
          if (need.length) groups.set(need.join(","), [...(groups.get(need.join(",")) ?? []), url]);
          else answered.add(url);
        }
        // One call per set of missing kinds (usually one call in all).
        for (const [kinds, all] of groups) for (let k = 0; k < all.length; k += 25) {
          const group = all.slice(k, k + 25);
          for (const row of await enrichContacts(group, kinds.split(",") as ContactKind[])) {
            const url = normalizeProfileUrl(String(row.matched_on ?? "")) ?? String(row.matched_on ?? "");
            const c = (matched(row)?.contact ?? {}) as Record<string, unknown>;
            for (const k of kinds.split(",") as ContactKind[]) {
              const field = CONTACT_FIELDS[k].field.split(".")[1];
              const value = Array.isArray(c[field]) ? c[field] : [];
              cache.set(`contact|${k}|${url}`, value);
              contacts.set(url, { ...(contacts.get(url) ?? {}), [field]: value });
            }
          }
          // A person the answer did not mention was looked up and nothing was found (not charged).
          for (const url of group) {
            for (const k of kinds.split(",") as ContactKind[]) {
              const field = CONTACT_FIELDS[k].field.split(".")[1];
              if (!(field in (contacts.get(url) ?? {}))) { cache.set(`contact|${k}|${url}`, []); contacts.set(url, { ...(contacts.get(url) ?? {}), [field]: [] }); }
            }
            answered.add(url);
          }
        }
      } catch (err) {
        if (stopsRun(err)) throw err;
        const gated = err instanceof CrustdataError && (err.status === 403 || err.status === 400);
        contactProblem = gated ? "contact data is not enabled on this key" : `the lookup failed (${why(err)})`;
        log(gated ? "Contact data is not enabled on this key, so the briefs go without it (contact data needs enabling on your Crustdata account; self-serve keys do not have it)."
          : `Contact lookup failed, so the briefs go without contacts: ${why(err)}`);
      }
    }

    // 5. Posts, web and news per person, then the brief. A failure here costs that section of that brief.
    const off = { posts: false, web: false };
    const since = Math.floor(now.getTime() / 1000) - NEWS_DAYS * 86_400;
    for (const [n, { i, person, by, score: matchScore, check }] of people.entries()) {
      try {
        log(`[${n + 1}/${people.length}] ${person.basic_profile?.name ?? "this person"}`);
        const notes: string[] = [];
        let posts: { items: Post[]; total: number | null } | undefined;
        let news: WebResult[] | undefined, web: WebResult[] | undefined;
        const id = Number(person.crustdata_person_id);
        if (!o.noPosts && off.posts) notes.push("Posts not checked: Social Post Search (/social_post/search) is not enabled on this key.");
        if (!o.noPosts && id && !off.posts) {
          try {
            const { value } = await cache.through(`posts|${id}|${o.posts}`, () => recentPosts(id, o.posts));
            posts = { items: value.posts, total: value.total };
          } catch (err) {
            if (stopsRun(err)) throw err;
            if (err instanceof CrustdataError && err.status === 403) { off.posts = true; notes.push("Posts not checked: Social Post Search (/social_post/search) is not enabled on this key."); log("Post search (/social_post/search) is not enabled on this key, so briefs go without posts. Ask Crustdata to enable it."); }
            else notes.push(`Posts are missing: ${why(err)}`);
          }
        }
        const phrase = searchPhrase(person);
        if (o.web && phrase && !off.web) {
          for (const kind of ["web", "news"] as const) {
            if (off.web) break;
            try {
              const value = kind === "web"
                ? (await cache.through(`web|${phrase}`, () => webSearch(phrase, "web"))).value
                : (await cache.through(`news|${NEWS_DAYS}|${phrase}`, () => webSearch(phrase, "news", since))).value;
              if (kind === "web") web = value; else news = value;
            } catch (err) {
              if (stopsRun(err)) throw err;
              if (err instanceof CrustdataError && err.status === 403) { off.web = true; log("Web Search (/web/search/live) is not enabled on this key, so briefs go without news and web results."); }
              else notes.push(`${kind === "web" ? "Web results are" : "News is"} missing: ${why(err)}`);
            }
          }
        }
        const url = profileUrlOf(person);
        const gotContacts = o.contact.length > 0 && !!url && answered.has(url);
        if (o.contact.length && !gotContacts) notes.push(`Contact details not checked: ${contactProblem ?? "the lookup did not run"}.`);
        const withContact: PersonData = gotContacts ? { ...person, contact: contacts.get(url!) as PersonData["contact"] } : person;
        const brief = buildBrief({ input: inputs[i].raw, matchedBy: by, matchScore, check, newsDays: NEWS_DAYS, person: withContact, now, days: o.days, posts, news, web, ignoreSites: sites });
        brief.notes.push(...notes);
        outcomes[i] = { input: inputs[i], status: "done", brief };
      } catch (err) {
        if (stopsRun(err)) throw err;
        outcomes[i] = { input: inputs[i], status: "failed", note: `Could not build this brief: ${why(err)}` };
        continue;
      }
      // Saving or sending a finished brief is the caller's: its failure is reported, never turned into a failed brief.
      try { await onBrief(outcomes[i]); } catch (err) { log(`Could not save or send the brief for ${inputs[i].raw}: ${why(err)}`); }
    }
  } catch (err) {
    if (stopsRun(err)) {
      for (const x of outcomes) if (x.note === "Not reached.") x.note = `Not reached: the run stopped (${why(err)})`;
      throw new RunStopped(why(err), outcomes, run.credits);
    }
    throw err;
  } finally {
    lastRun.credits = run.credits;
    const denied = [...run.denied];
    if (o.refresh || denied.some(f => !deniedBefore.includes(f))) cache.set("denied-fields", denied);
  }
  return outcomes;
}

/**
 * Enrich with the cache in front: cached people cost nothing, each identifier is sent once, the rest go in batches
 * of 25. Rows are matched back by the identifier Crustdata echoes; by position only when it echoes something else
 * and the row count matches, and never onto an identifier already matched.
 */
async function enrichCached(cache: Cache, by: "profile_url" | "business_email", ids: string[], fieldsKey: string, log: Log): Promise<{ rows: Map<string, MatchRow>; error?: unknown }> {
  const rows = new Map<string, MatchRow>();
  const todo: string[] = [];
  for (const id of new Set(ids)) {
    const saved = cache.get<MatchRow>(`enrich|${by}|${id}|${fieldsKey}`);
    if (saved) rows.set(id, saved); else todo.push(id);
  }
  // One batch of 25 at a time, each saved before the next is sent: a failure later never loses (or re-bills) the
  // people already paid for. A bad key or an empty account stops the run; any other failure is returned.
  for (let k = 0; k < todo.length; k += 25) {
    const batch = todo.slice(k, k + 25);
    let got: MatchRow[];
    try { got = await enrich(by, batch, BRIEF_FIELDS, log); }
    catch (err) { if (stopsRun(err)) throw err; return { rows, error: err }; }
    const keyOf = (row: MatchRow) => {
      const echoed = String(row.matched_on ?? "");
      const id = by === "profile_url" ? normalizeProfileUrl(echoed) ?? echoed : echoed.toLowerCase();
      return batch.includes(id) ? id : undefined;
    };
    const keyed = got.map(keyOf);
    got.forEach((row, n) => {
      const id = keyed[n] ?? (got.length === batch.length && !keyed.includes(batch[n]) ? batch[n] : undefined);
      if (!id || rows.has(id)) return;
      rows.set(id, row);
      // A miss is cached too (it was free, but asking again costs a paced call); redacted rows never are.
      if (row.match_status === "not_found") cache.set(`enrich|${by}|${id}|${fieldsKey}`, row);
      if (row.match_status !== "matched") return;
      cache.set(`enrich|${by}|${id}|${fieldsKey}`, row);
      // Saved under the profile URL too, so the same person by URL (or a name) later is free.
      const url = profileUrlOf(row.matches?.[0]?.person_data);
      if (url && by === "business_email") cache.set(`enrich|profile_url|${url}|${fieldsKey}`, row);
    });
  }
  return { rows };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const RESERVED = new Set(["index", "con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

/** A file name from a person's name: letters (any script, with their accents), digits and dashes. */
export const slug = (s: string): string => {
  const out = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").normalize("NFC").toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").slice(0, 60).replace(/^-+|-+$/g, "") || "person";
  return RESERVED.has(out) ? `${out}-person` : out;
};

/**
 * Writes briefs as they finish (owner-only), then the index. A file already in the folder for a different person
 * with the same name is kept: the new brief gets the person's Crustdata id in its name.
 */
export class BriefWriter {
  private used = new Set<string>();
  readonly files: string[] = [];
  readonly fileFor = new Map<Outcome, string>();

  constructor(private dir: string) {}

  write(o: Outcome): void {
    if (!o.brief) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const id = o.brief.person.id;
    let base = slug(o.brief.person.name);
    const taken = (b: string) => {
      if (this.used.has(b)) return true;
      const json = join(this.dir, `${b}.json`);
      if (!existsSync(json)) return false;
      try { return JSON.parse(readFileSync(json, "utf8"))?.person?.id !== id; } catch { return true; }
    };
    if (taken(base) && id) base = `${base}-${id}`;
    for (let n = 2; taken(base); n++) base = `${slug(o.brief.person.name)}-${n}`;
    this.used.add(base);
    for (const [ext, text] of [[".md", renderBrief(o.brief)], [".json", JSON.stringify(o.brief, null, 2) + "\n"]] as const) {
      const f = join(this.dir, `${base}${ext}`);
      writeFileSync(f, text, { mode: 0o600 });
      chmodSync(f, 0o600);
    }
    this.files.push(join(this.dir, `${base}.md`));
    this.fileFor.set(o, `${base}.md`);
  }

  /** Index rows for every outcome, and index.md when there was more than one person. */
  finish(outcomes: Outcome[], credits: number, now: Date, stopped?: string): IndexRow[] {
    const rows: IndexRow[] = outcomes.map(o => {
      if (o.status !== "done" || !o.brief) {
        const list = o.candidates?.length ? ` Matches: ${o.candidates.map((c, i) => `${i + 1}. ${c.basic_profile?.name ?? "?"}${c.basic_profile?.headline ? `, ${c.basic_profile.headline}` : ""} ${profileUrlOf(c) ?? ""}`.trim()).join("; ")}` : "";
        return { input: o.input.raw, status: o.status, note: `${o.note ?? o.status}${list}` };
      }
      const b = o.brief;
      return { input: o.input.raw, status: "done", name: b.person.name, title: [b.person.title, b.person.company].filter(Boolean).join(" at "), file: this.fileFor.get(o), ...(b.changes[0] ? { changed: b.changes[0].text } : {}), ...(b.check ? { check: true } : {}) };
    });
    // An index only when there is something to read: a run where nobody was researched keeps the last good one.
    if (outcomes.length > 1 && outcomes.some(o => o.status === "done")) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const f = join(this.dir, "index.md");
      writeFileSync(f, renderIndex(rows, fmtCredits(credits), now.toISOString().slice(0, 10), stopped), { mode: 0o600 });
      chmodSync(f, 0o600);
      this.files.push(f);
    }
    return rows;
  }
}

/** Writes every brief and the index in one go (for code that calls research() and wants files). */
export function writeFiles(outcomes: Outcome[], dir: string, now: Date, credits = (outcomes as Outcome[] & { credits?: number }).credits ?? lastRun.credits): { rows: IndexRow[]; files: string[] } {
  const w = new BriefWriter(dir);
  for (const o of outcomes) w.write(o);
  return { rows: w.finish(outcomes, credits, now), files: w.files };
}
