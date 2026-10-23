/**
 * npm run contacts -- --top 25: emails for the top candidates of a role, only when you ask and only on accounts with
 * contact data turned on. Personal email by default (2 credits a person found); --work-email (1) and --phone (2) are
 * extra. People not found cost nothing. People already looked up for the same kinds are skipped.
 *
 * Contact data needs enabling on your Crustdata account; self-serve keys do not have it. This reads the free
 * GET /account/endpoints first and stops with that sentence when the key cannot use it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { accountEndpoints, enrichContacts, fmtCredits, spend, type ContactField, type ContactResult, type Endpoint } from "./crustdata.js";
import { parseCsv, writeCsv } from "./csv.js";
import { loadStore, scoreAll } from "./output.js";
import { nameOf, profileUrl } from "./profile.js";
import { lastRole, loadRole, roleDir, slugify } from "./role.js";
import { allowSpend } from "./source.js";
import { normalizeProfileUrl } from "./seen.js";

export const NO_CONTACT_ACCESS = "Contact data needs enabling on your Crustdata account; self-serve keys do not have it. Ask Crustdata to turn it on (your account manager, or https://crustdata.com/demo), then run this again.";

/** List prices per person found. /person/enrich adds 1 base credit per person; /person/contact/enrich has none. */
export const CONTACT_PRICE: Record<ContactField, number> = { "contact.personal_emails": 2, "contact.business_emails": 1, "contact.phone_numbers": 2 };
const LABEL: Record<ContactField, string> = { "contact.personal_emails": "personal email", "contact.business_emails": "work email", "contact.phone_numbers": "phone" };

export type ContactPath = "/person/contact/enrich" | "/person/enrich";

/** Which endpoint this key can use for these contact kinds, from /account/endpoints. Pure, so it is tested. */
export function contactAccess(endpoints: Endpoint[], fields: ContactField[]): ContactPath | undefined {
  const can = (path: string) => {
    const e = endpoints.find(x => x.path === path);
    const enabled = new Set(e?.fields?.enabled ?? []);
    return e?.status === "enabled" && fields.every(f => enabled.has(f));
  };
  if (can("/person/contact/enrich")) return "/person/contact/enrich";
  if (can("/person/enrich")) return "/person/enrich";
  return undefined;
}

type Flags = { name?: string; top: number; fields: ContactField[]; yes: boolean };

function parseContactFlags(argv: string[]): Flags {
  const f: Flags = { top: 25, fields: ["contact.personal_emails"], yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--work-email") f.fields.push("contact.business_emails");
    else if (a === "--phone") f.fields.push("contact.phone_numbers");
    else if (a === "--no-personal-email") f.fields = f.fields.filter(x => x !== "contact.personal_emails");
    else if (a === "--top" || a.startsWith("--top=")) {
      const v = a.includes("=") ? a.split("=")[1] : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error(`--top takes a whole number from 1 to 500, got "${v}"`);
      f.top = n;
    } else if (a === "--name" || a.startsWith("--name=")) f.name = slugify((a.includes("=") ? a.split("=")[1] : argv[++i]) ?? "") || (() => { throw new Error("--name needs a role name, for example --name machine-learning-engineer-united-states"); })();
    else throw new Error(`Unknown flag ${a}. Flags: --top N, --name <role>, --work-email, --phone, --no-personal-email, --yes`);
  }
  f.fields = [...new Set(f.fields)];
  if (!f.fields.length) throw new Error("Nothing to look up: --no-personal-email needs --work-email or --phone.");
  return f;
}

const CONTACT_HEADER = ["rank", "score", "name", "profile URL", "personal email", "work email", "phone", "result", "looked up", "kinds asked"];

/** Rows of the existing contacts.csv, by normalised profile URL. */
function loadContacts(file: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!existsSync(file)) return out;
  for (const row of parseCsv(readFileSync(file, "utf8")).slice(1)) {
    const key = normalizeProfileUrl(row[3]);
    if (key) out.set(key, row);
  }
  return out;
}

const emails = (list: Array<{ email?: string; status?: string }> | undefined) =>
  (list ?? []).filter(e => e.email).map(e => (e.status && e.status !== "deliverable" ? `${e.email} (${e.status})` : e.email!)).join("; ");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function runContacts(argv: string[]): Promise<void> {
  const flags = parseContactFlags(argv);
  const name = flags.name ?? lastRole();
  const saved = name ? loadRole(name) : undefined;
  if (!name || !saved) throw new Error("No saved role yet. Run npm run source first, then npm run contacts -- --top 25.");
  const dir = roleDir(name);
  const rows = scoreAll(saved.spec, loadStore(dir)).slice(0, flags.top);
  if (!rows.length) throw new Error(`No candidates saved for ${name}. Run npm run source first.`);

  const path = contactAccess(await accountEndpoints(), flags.fields);
  if (!path) { console.error(NO_CONTACT_ACCESS); process.exitCode = 1; return; }

  const file = join(dir, "contacts.csv");
  const done = loadContacts(file);
  const asked = (row: string[] | undefined) => new Set((row?.[9] ?? "").split(/;\s*/).filter(Boolean));
  const noUrl = rows.filter(r => !normalizeProfileUrl(r.url || profileUrl(r.person)));
  if (noUrl.length) console.log(`  ${noUrl.length} of the top ${rows.length} have no profile URL, so they cannot be looked up and are skipped.`);
  const todo = rows.filter(r => normalizeProfileUrl(r.url || profileUrl(r.person))).filter(r => {
    const prev = asked(done.get(normalizeProfileUrl(r.url || profileUrl(r.person))));
    return !flags.fields.every(f => prev.has(LABEL[f]));
  });
  // Per person, only the kinds not looked up before are asked for (and paid for).
  const needed = (r: (typeof todo)[number]) => { const prev = asked(done.get(normalizeProfileUrl(r.url || profileUrl(r.person)))); return flags.fields.filter(f => !prev.has(LABEL[f])); };
  const costOf = (r: (typeof todo)[number]) => needed(r).reduce((s, f) => s + CONTACT_PRICE[f], 0) + (path === "/person/enrich" ? 1 : 0);
  const maxCost = todo.reduce((s, r) => s + costOf(r), 0);
  console.log(`Contacts for the top ${rows.length === 1 ? "candidate" : `${rows.length} candidates`} of ${name}: ${flags.fields.map(f => LABEL[f]).join(", ")}.`);
  if (rows.length > todo.length) console.log(`  ${rows.length - todo.length} already looked up for these kinds are skipped.`);
  if (!todo.length) { console.log("Nothing new to look up."); return; }
  const most = Math.max(...todo.map(costOf));
  const credits = (n: number) => `${fmtCredits(n)} ${n === 1 ? "credit" : "credits"}`;
  console.log(`  cost: up to ${credits(most)} a person found, at most ${credits(maxCost)} for ${todo.length} ${todo.length === 1 ? "person" : "people"} (kinds already looked up are not asked again; people not found are free).`);
  // Contacts always cost something, so a script must say --yes; in a terminal anything over a few credits asks.
  if (!flags.yes && !process.stdin.isTTY) {
    console.log(`Not run: this lookup can cost up to ${fmtCredits(maxCost)} credits. Add --yes to run it without a terminal (a script or a coding agent).`);
    process.exitCode = 1;
    return;
  }
  if (!flags.yes && !(await allowSpend(maxCost, false, "this lookup", 0))) return;

  const results = new Map<string, ContactResult>();
  const today = new Date().toISOString().slice(0, 10);
  let found = 0, written = 0;
  const allRows = scoreAll(saved.spec, loadStore(dir));
  // Written after every batch of 25, so a failure on a later batch never loses (and re-bills) the ones already paid for.
  const save = () => {
    const ordered = allRows.map(r => done.get(normalizeProfileUrl(r.url || profileUrl(r.person)))).filter((x): x is string[] => !!x);
    writeCsv(file, CONTACT_HEADER, ordered.map((row, i) => [i + 1, ...row.slice(1)]));
  };
  // One request per batch of up to 25 people who need the same kinds.
  const groups = new Map<string, typeof todo>();
  for (const r of todo) { const k = needed(r).join(","); groups.set(k, [...(groups.get(k) ?? []), r]); }
  let requests = 0;
  for (const [kinds, people] of groups) {
    for (let i = 0; i < people.length; i += 25) {
      if (requests++) await sleep(4_100); // 15 requests a minute
      const chunk = people.slice(i, i + 25);
      const urls = chunk.map(r => r.url || profileUrl(r.person));
      const answers = await enrichContacts(path, urls, kinds.split(",") as ContactField[]);
      answers.forEach((res, j) => {
        // Matched by the URL Crustdata echoes; by position in the request when it echoes another form.
        const key = normalizeProfileUrl(res.matched_on);
        results.set(key && urls.some(u => normalizeProfileUrl(u) === key) ? key : normalizeProfileUrl(urls[j]), res);
      });
      for (const r of chunk) record(r, kinds.split(",") as ContactField[]);
      save();
      written += chunk.length;
    }
  }
  function record(r: (typeof todo)[number], kindsAsked: ContactField[]) {
    const url = r.url || profileUrl(r.person);
    const res = results.get(normalizeProfileUrl(url));
    const c = res?.matches?.[0]?.person_data?.contact;
    const personal = emails(c?.personal_emails), work = emails(c?.business_emails), phone = (c?.phone_numbers ?? []).join("; ");
    const prev = done.get(normalizeProfileUrl(url));
    const result = res?.match_status === "redacted" ? "removed at the person's request" : !res || res.match_status === "not_found" ? "profile not found" : personal || work || phone || prev?.[4] || prev?.[5] || prev?.[6] ? "found" : "no contact data";
    if (personal || work || phone) found++;
    const kinds = new Set([...asked(prev), ...kindsAsked.map(f => LABEL[f])]);
    done.set(normalizeProfileUrl(url), ["", String(r.scored.score), nameOf(r.person), url, personal || prev?.[4] || "", work || prev?.[5] || "", phone || prev?.[6] || "", result, today, [...kinds].join("; ")]);
  }
  console.log(`\nDone. Contact data for ${found} of ${written} ${written === 1 ? "person" : "people"}, ${fmtCredits(spend.credits)} credits.\n  ${relative(process.cwd(), file)}`);
}
