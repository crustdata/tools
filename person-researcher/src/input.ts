/**
 * What the user typed, turned into people to research. Pure: no network, no files (the CLI reads the file and passes
 * the text in), so every case is tested.
 *
 * Accepted, one person each:
 *   <profile URL>                            with or without https://, www, a trailing slash or ?query
 *   jane@acme.com                            any email; "Jane Doe <jane@acme.com>" from a calendar invite works too
 *   Jane Doe, Acme  |  Jane Doe at acme.com  a name and a company (name or domain); --name and --company on the CLI
 * A file is a list of those, one per line, or a CSV with a header (CRM and contact exports: Email, Work Email,
 * E-mail Address, the profile URL columns CRMs use, Name, First Name + Last Name, Company, Company Domain, Website).
 * Lines with several emails (an attendee list pasted from an invite) count as several people. Calendar rooms, summary
 * lines ("4 guests") and labels ("Required:") are left out.
 */

export type Input =
  | { kind: "url"; raw: string; url: string }
  | { kind: "email"; raw: string; email: string }
  | { kind: "name"; raw: string; name: string; company?: string };

/** `benign`: left out on purpose (a meeting room, a summary line, a colleague), not a problem with the input. */
export type Skipped = { line?: number; raw: string; reason: string; benign?: boolean };

/** Most people one run takes. Runs over MAX_CREDITS_PER_RUN also need --yes. */
export const MAX_PEOPLE = 100;

const EMAIL_RE = /[^\s@<>(),;:"[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;
/** Calendar rooms and groups have addresses but are not people. */
/** Calendar rooms and groups, conferencing bridges (Teams' "Tenant key"), and no-reply senders have addresses but are not people. */
const NOT_PEOPLE = /@(resource|group)\.calendar\.google\.com$|@t\.plcm\.vc$|@(?:[a-z0-9-]+\.)*(teams\.microsoft\.com|zoom\.us|webex\.com)$|^(noreply|no-reply|donotreply|calendar-notification|notifications?)@/i;
/** Labels that calendar and mail clients put in front of attendee lists. */
const LABEL = /^\s*(?:(?:required|optional)\s+(?:attendees?|guests?)|to|cc|bcc|required|optional|attendees?|guests?|organi[sz]er|from)\s*:\s*/i;
/** Summary lines from calendar invites: "4 guests", "2 yes", "1 awaiting". */
const SUMMARY = /^\s*\d+\s+(guests?|yes|no|maybe|awaiting|attendees?|people|declined|accepted)\b/i;

/**
 * The one form every profile URL is compared and sent in: https://www.<host>/in/<slug>, no trailing slash, query or
 * fragment, the slug percent-encoded once and lowercased (except permanent ids starting "ACo"/"ACw", which are
 * case-sensitive). Returns null for anything that is not a person's profile URL.
 */
export function normalizeProfileUrl(raw: string): string | null {
  let s = raw.trim().replace(/^<|>$/g, "");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|[a-z]{2})\./, "");
  if (host !== "linkedin.com") return null;
  const m = /^\/(?:mwlite\/)?in\/([^/]+)\/?/i.exec(u.pathname);
  if (!m) return null;
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep it as written */ }
  slug = slug.trim();
  if (!/^AC[ow]/.test(slug)) slug = slug.toLowerCase();
  if (!slug) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}

/** The emails of people in a piece of text, lowercased, in order, without repeats (rooms and no-reply left out). */
export function findEmails(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = m[0].replace(/^mailto:/i, "").replace(/^'+/, "").replace(/[.']+$/, "").toLowerCase();
    if (!NOT_PEOPLE.test(e)) seen.add(e);
  }
  return [...seen];
}

const PRONOUNS = /\s*\((she|he|they|ze|xe)\/[a-z]+(\/[a-z]+)?\)\s*/gi;
const HONORIFIC = /^(dr|mr|mrs|ms|mx|miss|prof|sir)\.?\s+/i;
const CREDENTIALS = /,?\s+\b(phd|ph\.d\.|mba|md|m\.d\.|jr|sr|ii|iii|iv|cpa|esq|pe|pmp|cfa)\b\.?/gi;

/** A person's name: letters, two to six words, no digits or brackets. */
export function looksLikeName(s: string): boolean {
  const t = s.trim();
  const words = t.split(/\s+/).length;
  return /\p{L}/u.test(t) && words >= 2 && words <= 6 && !/\d/.test(t) && !/[()[\]{}<>@/\\|:]/.test(t) && t.length <= 80;
}

/** "Doe, Jane" or "van der Berg, Jan" to first-last order (only for a cell known to hold a name; clean it first). */
export const firstLast = (s: string): string => {
  const m = /^\s*([^,]+?)\s*,\s*([^,]+?)\s*$/.exec(s);
  return m ? `${m[2]} ${m[1]}` : s.trim();
};

/** Pronouns, titles and credentials taken off a name. */
export const cleanName = (s: string): string =>
  s.replace(PRONOUNS, " ").replace(HONORIFIC, "").replace(CREDENTIALS, "").replace(/\s+/g, " ").trim();

/** "Jane Doe, Acme", "Jane Doe at Acme", "Jane Doe @ acme.com", "Jane Doe (Acme)" or a bare name. */
/** Words that start invite and footer lines ("Join on your computer", "Click here"), never a person's name. */
const NOT_A_NAME_START = /^(join|click|dial|find|learn|more|view|reply|meeting|invitation|for|tap|call|weekly|daily|monthly|sync|notes?|agenda)\b/i;

export function parseNameLine(raw: string): { name: string; company?: string } | null {
  const s = cleanName(raw.replace(LABEL, "").replace(/\s*\((?:guest|organi[sz]er|optional|required|external)\)\s*$/i, ""));
  if (NOT_A_NAME_START.test(s)) return null;
  if (!s || /^(https?:\/\/|www\.)/i.test(s)) return null;
  const m = /^(.+?)\s*(?:,|\s@\s|\sat\s|\()\s*(.+?)\)?$/i.exec(s);
  const name = (m ? m[1] : s).trim();
  const company = m ? m[2].trim() : undefined;
  if (!looksLikeName(name)) return null;
  return company ? { name, company } : { name };
}

/**
 * One argument or one line. Several emails on one line come back as several inputs. In a file (`inFile`), a name
 * needs a company: a bare name matches too many people to research a list unattended.
 */
export function classify(raw: string, inFile = false): { inputs: Input[]; reason?: string; benign?: boolean } {
  const s = raw.replace(LABEL, "").trim();
  if (!s) return { inputs: [], reason: "empty" };
  if (SUMMARY.test(s)) return { inputs: [], reason: "a calendar summary line, not a person", benign: true };
  if (/linkedin\.com\//i.test(s) || /^https?:\/\//i.test(s)) {
    const url = normalizeProfileUrl(s);
    return url ? { inputs: [{ kind: "url", raw: s, url }] } : { inputs: [], reason: "not a person's profile URL (expected a /in/ address)" };
  }
  const emails = findEmails(s);
  if (emails.length) {
    const found: Input[] = emails.map(email => ({ kind: "email" as const, raw: email, email }));
    // "Bob Smith <bob@x.com>; Alice Wong, Globex": the parts with no email are classified too.
    if (s.includes(";")) for (const part of s.split(";")) if (!findEmails(part).length && !part.match(EMAIL_RE)) found.push(...classify(part, inFile).inputs);
    return { inputs: found };
  }
  if (s.match(EMAIL_RE)) return { inputs: [], reason: "a calendar room or a no-reply address, not a person", benign: true };
  if (s.includes("@") && !/\s@\s/.test(s)) return { inputs: [], reason: "looks like an email but is not a valid address" };
  // "Bob Smith; Alice Wong" from an invite: several names on one line.
  if (s.includes(";")) {
    const parts = s.split(";").map(p => classify(p, inFile));
    const inputs = parts.flatMap(p => p.inputs);
    return inputs.length ? { inputs } : { inputs: [], reason: parts.find(p => p.reason)?.reason ?? "not understood" };
  }
  const named = parseNameLine(s);
  if (!named) return { inputs: [], reason: "not a profile URL, an email, or a first and last name" };
  if (inFile && !named.company) {
    const capitalised = named.name.split(" ").every(w => /^\p{Lu}/u.test(w));
    return { inputs: [], reason: capitalised ? "a name with no company matches too many people; add it as \"Jane Doe, acme.com\"" : "not a profile URL, an email, or \"Name, Company\"" };
  }
  return { inputs: [{ kind: "name", raw: named.company ? `${named.name}, ${named.company}` : named.name, ...named }] };
}

// ---------------------------------------------------------------------------
// Files: plain lists and CSV exports
// ---------------------------------------------------------------------------

const COLUMNS = {
  url: ["profile url", "profile", "linkedin", "linkedin url", "linkedin profile", "linkedin profile url", "person linkedin url", "professional network url", "url"],
  email: ["email", "work email", "business email", "email address", "primary email", "attendee email", "attendee", "email 1 value", "email 1", "email1", "contact email", "work email address"],
  name: ["name", "full name", "person", "contact name", "contact", "attendee name", "display name"],
  first: ["first name", "firstname", "first", "given name", "contact first", "contact first name"],
  last: ["last name", "lastname", "last", "surname", "family name", "contact last", "contact last name"],
  domain: ["company domain", "domain", "website", "company website", "website url", "company url", "account website", "email domain"],
  company: ["company", "company name", "account", "account name", "organization", "organisation", "organization name", "organization 1 name", "employer", "org"],
};
type Column = keyof typeof COLUMNS;

/** "E-mail Address" and "Email (Work)" read as "email address" and "email". */
export const headerKey = (c: string): string =>
  c.toLowerCase().replace(/e-mail/g, "email").replace(/\(.*?\)/g, " ").replace(/[_*\-.:]+/g, " ").replace(/\s+/g, " ").trim();

/** Splits one CSV record, honouring quotes ("Doe, Jane", "line one\nline two"). */
export function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && !cur.trim()) quoted = true; // a quote opens a cell only at its start (27" stays literal)
    else if (c === sep) { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Records of a CSV, where a quoted cell may hold line breaks; each keeps the line it starts on. */
export function csvRecords(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let cur = "", quoted = false, line = 1, start = 1, atStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // A quote opens a cell only at its start ("" inside is a literal quote), so a stray inch mark
    // (Acme 27" Displays) never swallows the rows after it.
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '""'; i++; continue; }
        quoted = false;
      }
    } else if (c === '"' && atStart) quoted = true;
    if (c === "\n") {
      line++;
      if (!quoted) { out.push({ line: start, text: cur.replace(/\r$/, "") }); cur = ""; start = line; atStart = true; continue; }
    }
    cur += c;
    atStart = c === "," || c === ";" || c === "\t" || (atStart && c === " ");
  }
  if (cur) out.push({ line: start, text: cur.replace(/\r$/, "") });
  return out;
}

function headerMap(cells: string[]): Partial<Record<Column, number>> | null {
  const norm = cells.map(headerKey);
  const map: Partial<Record<Column, number>> = {};
  for (const [key, names] of Object.entries(COLUMNS) as Array<[Column, string[]]>) {
    const i = norm.findIndex((c, j) => names.includes(c) && !Object.values(map).includes(j));
    if (i >= 0) map[key] = i;
  }
  return map.url !== undefined || map.email !== undefined || map.name !== undefined || map.first !== undefined ? map : null;
}

/**
 * A file's text to inputs. Skipped rows keep their real line number so they can be fixed. Repeats of the same person
 * (same profile URL, email, or name and company) are dropped. `warnings` explains choices the user should know about.
 */
export function parseList(text: string): { inputs: Input[]; skipped: Skipped[]; warnings: string[] } {
  // Old Mac line endings (Excel's "CSV (Macintosh)") are carriage returns only.
  const body = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const inputs: Input[] = [];
  const skipped: Skipped[] = [];
  const warnings: string[] = [];
  const records = csvRecords(body).filter(r => r.text.trim() && !r.text.trim().startsWith("#"));
  if (!records.length) return { inputs, skipped, warnings };
  const sepOf = (t: string) => [",", ";", "\t"].map(x => [x, splitCsvLine(t, x).length] as const).sort((p, q) => q[1] - p[1])[0][0];

  // Generic column words, matched as whole cells, so "Sam Lee, Mailchimp" is still read as a person.
  const columnWord = /^(contact|work|primary|attendee|business|personal|full|display|company|account)?\s*(e?mail|mail|e mail|email address|name|person|company|company name|url|profile|first|first name|last|last name|account|account name|organi[sz]ation|title|job title|phone|notes?|website|domain|owner)$/i;
  const known = (c: string) => Object.values(COLUMNS).some(n => n.includes(headerKey(c))) || columnWord.test(headerKey(c));
  // The header is the first of the first 10 rows that names a column this tool reads, comes before any row with an
  // email or a profile URL, and is a single cell or has at least two column names ("Alex Kim, LinkedIn" in a plain
  // list is a person). Rows above it are a report's title and filters.
  const firstPerson = records.findIndex(r => findEmails(r.text).length > 0 || /linkedin\.com\/in\//i.test(r.text));
  const isHeader = (t: string) => {
    const cells = splitCsvLine(t, sepOf(t)).filter(Boolean);
    return headerMap(cells) !== null && (cells.length === 1 || cells.filter(known).length >= 2);
  };
  const h = records.slice(0, 10).findIndex((r, k) => (firstPerson < 0 || k < firstPerson) && isHeader(r.text));
  if (h < 0) {
    const head = records[0].text;
    const cells = splitCsvLine(head, sepOf(head));
    if (cells.length > 1 && !findEmails(head).length && cells.some(c => columnWord.test(headerKey(c)))) {
      warnings.push(`Line ${records[0].line} looks like a header but has no column this tool reads (${cells.join(", ")}). Name the columns Email, Profile URL, or Name and Company.`);
      records.shift();
    }
    // A plain list: every line on its own. A name line followed by an email line (a calendar guest list) is not
    // reported, since the email on the next line is researched.
    const lines = records.flatMap(r => r.text.split(/\r?\n/).map(t => ({ line: r.line, t }))).filter(x => x.t.trim() && !x.t.trim().startsWith("#"));
    lines.forEach((x, k) => {
      const r = classify(x.t, true);
      if (r.inputs.length) { inputs.push(...r.inputs); return; }
      const nextHasEmail = k + 1 < lines.length && findEmails(lines[k + 1].t).length > 0;
      if (nextHasEmail && parseNameLine(x.t)) return;
      skipped.push({ line: x.line, raw: x.t.trim(), reason: r.reason ?? "not understood", ...(r.benign ? { benign: true } : {}) });
    });
    return { inputs: dedupe(inputs), skipped, warnings };
  }

  const sep = sepOf(records[h].text);
  const headCells = splitCsvLine(records[h].text, sep);
  const map = headerMap(headCells)!;
  for (const r of records.slice(0, h)) skipped.push({ line: r.line, raw: r.text.trim(), reason: "above the header row: a report title, not a person", benign: true });
  if (map.email === undefined && map.url === undefined) {
    warnings.push(`No email or profile URL column found (columns: ${headCells.join(", ")}), so people are looked up by name and company, which is less exact.`);
  }

  for (const rec of records.slice(h + 1)) {
    const line = rec.text;
    const cells = splitCsvLine(line, sep);
    if (cells.every(c => !c)) continue;
    const raw0 = line.replace(/\s*\n\s*/g, " ").trim();
    if (headCells.length >= 3 && cells.filter(Boolean).length === 1 && !findEmails(line).length && !/linkedin\.com\/in\//i.test(line) && !looksLikeName(cells.find(Boolean)!)) {
      skipped.push({ line: rec.line, raw: raw0, reason: "looks like a report title or total, not a person", benign: true });
      continue;
    }
    const cell = (k: Column) => (map[k] !== undefined ? cells[map[k]!] ?? "" : "").trim();
    const url = cell("url") ? normalizeProfileUrl(cell("url")) : null;
    // With no email column, an email anywhere in the row ("Jane Doe <jane@acme.com>" under "Contact") still counts.
    const email = findEmails(cell("email"))[0] ?? (map.email === undefined ? findEmails(line)[0] : undefined);
    const name = cell("name") ? firstLast(cleanName(cell("name"))) : cleanName([cell("first"), cell("last")].filter(Boolean).join(" "));
    // A website or domain column matches the employer exactly; a company name only as a phrase.
    const site = cell("domain") || (cell("url") && !url && !/linkedin\.com/i.test(cell("url")) ? cell("url") : "");
    const company = siteDomain(site) ?? cell("company");
    const raw = url ?? email ?? [name, company].filter(Boolean).join(", ");
    if (url) inputs.push({ kind: "url", raw, url });
    else if (email) inputs.push({ kind: "email", raw, email });
    else if (name && looksLikeName(name) && company) inputs.push({ kind: "name", raw, name, company });
    else if (name && looksLikeName(name)) skipped.push({ line: rec.line, raw: raw0, reason: "a name with no company or email matches too many people; add the company" });
    else if (cell("url") && /linkedin\.com/i.test(cell("url"))) skipped.push({ line: rec.line, raw: raw0, reason: "the profile URL is not a person's profile (/in/)" });
    else skipped.push({ line: rec.line, raw: raw0, reason: "no profile URL, email, or first and last name in this row" });
  }
  return { inputs: dedupe(inputs), skipped, warnings };
}

/** "https://www.acme.com/about" or "acme.com" to "acme.com"; anything else to undefined. */
export function siteDomain(s: string): string | undefined {
  const m = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#].*)?$/i.exec(s.trim());
  return m ? m[1].toLowerCase() : undefined;
}

export const inputKey = (x: Input): string =>
  x.kind === "url" ? x.url : x.kind === "email" ? x.email : `${x.name.toLowerCase()}|${(x.company ?? "").toLowerCase()}`;

export function dedupe(inputs: Input[]): Input[] {
  const seen = new Set<string>();
  return inputs.filter(x => (seen.has(inputKey(x)) ? false : (seen.add(inputKey(x)), true)));
}

/**
 * Leaves out your own company's people: emails at these domains (and their subdomains), and names whose company is
 * one of them. SKIP_DOMAINS in .env or --skip-domain on the command line.
 */
export function skipDomains(inputs: Input[], domains: string[]): { kept: Input[]; skipped: Skipped[] } {
  const list = domains.map(d => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  if (!list.length) return { kept: inputs, skipped: [] };
  const hit = (d: string | undefined) => !!d && list.some(x => d === x || d.endsWith(`.${x}`));
  const kept: Input[] = [], skipped: Skipped[] = [];
  for (const x of inputs) {
    const domain = x.kind === "email" ? x.email.split("@")[1] : x.kind === "name" ? siteDomain(x.company ?? "") : undefined;
    if (hit(domain)) skipped.push({ raw: x.raw, reason: `at ${domain}, one of your own domains; not charged`, benign: true });
    else kept.push(x);
  }
  return { kept, skipped };
}
