/**
 * Inputs: one domain, a list of domains, or a CSV export of inbound deals from a CRM or a spreadsheet.
 * Pure functions, no I/O, so they are tested directly.
 */

import { domainToASCII } from "node:url";

/**
 * "https://www.Acme.com/pricing", "acme.com", "jane@acme.com" and "acme.com:443" all become "acme.com".
 * International domains become their ASCII (punycode) form, so "münchen.de" and "xn--mnchen-3ya.de" are one company.
 * Undefined when there is no usable domain in the text.
 */
export function normalizeDomain(input: string): string | undefined {
  let s = String(input ?? "").normalize("NFKC").replace(/[​-‍⁠﻿]/g, "").trim().toLowerCase()
    .replace(/^["'<(\[]+|[>"')\].,;]+$/g, "");
  if (!s) return undefined;
  if (/^[^@\s/]+@[^@\s/]+$/.test(s)) s = s.split("@")[1];
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\/\//, "");
  s = s.split(/[/?#\s]/)[0].replace(/:\d+$/, "").replace(/^www\d?\./, "").replace(/\.$/, "");
  if (!s || /^\d+(\.\d+)+$/.test(s)) return undefined; // empty, or an IP address rather than a company website
  const ascii = domainToASCII(s);
  if (!ascii) return undefined;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(ascii)) return undefined;
  const tld = ascii.split(".").pop()!;
  if (tld.length < 2 || /^\d+$/.test(tld)) return undefined;
  return ascii;
}

export class CsvError extends Error {}

/**
 * Parses CSV text (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes). Records keep their line number.
 * A quote that is never closed would swallow the rest of the file, so it is an error naming its line.
 */
export function parseCsv(text: string, delimiter: string): Array<{ line: number; cells: string[] }> {
  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let quoteLine = 0;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else {
        if (c === "\n") line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell.trim() === "") { quoted = true; quoteLine = line; cell = ""; continue; }
    if (c === delimiter) { cells.push(cell); cell = ""; continue; }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cells.push(cell);
      rows.push({ line: start, cells });
      cells = []; cell = "";
      line++; start = line;
      continue;
    }
    cell += c;
  }
  if (quoted) throw new CsvError(`Line ${quoteLine} opens a quote (") that is never closed, so the rest of the file cannot be read. Fix that cell (or remove the quote) and run again.`);
  if (cell !== "" || cells.length) { cells.push(cell); rows.push({ line: start, cells }); }
  return rows.filter(r => r.cells.some(c => c.trim() !== ""));
}

/** The delimiter used most on the first line outside quotes: comma, semicolon (European Excel) or tab. */
export function sniffDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find(l => l.trim()) ?? "";
  const unquoted = first.replace(/"[^"]*"/g, "");
  const counts = [",", ";", "\t"].map(d => [d, unquoted.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

const squash = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Column names that hold a company's website or domain in common CRM and spreadsheet exports. Best first. */
const DOMAIN_HEADERS = [
  "domain", "companydomain", "companydomainname", "primarydomain", "domains", "organizationdomain", "organisationdomain",
  "website", "companywebsite", "websiteurl", "companyurl", "url", "homepage", "web", "site", "organizationwebsite",
  "accountwebsite", "companywebsiteurl", "primarywebsite", "domainname",
];
/** Columns with "url" or "website" in the name that are links to something else: never the company's site. */
const NOT_A_SITE_HEADER = /linkedin|crunchbase|pitchbook|twitter|xcom|facebook|instagram|github|deck|pitch|docsend|profile|calendar|calendly|video|loom|demo|notion|drive|doc|angel|wellfound|dealroom|tracxn|signal/;
const NAME_HEADERS = ["companyname", "company", "name", "organization", "organisation", "organizationname", "accountname", "account", "startup", "dealname", "deal"];
const EMAIL_HEADERS = ["email", "founderemail", "contactemail", "workemail", "emailaddress"];

/** Hosts that are never a startup's own website: profiles, link shorteners, data sites, document viewers. */
const ALWAYS_LINK = [
  "linkedin.com", "crunchbase.com", "pitchbook.com", "twitter.com", "x.com", "facebook.com", "instagram.com",
  "youtube.com", "youtu.be", "tiktok.com", "angel.co", "wellfound.com", "ycombinator.com", "producthunt.com",
  "docs.google.com", "drive.google.com", "sites.google.com", "goo.gl", "forms.gle", "bit.ly", "tinyurl.com",
  "dealroom.co", "tracxn.com", "f6s.com", "mailchi.mp",
];
/**
 * Companies whose links carry other people's things (a deck, a repo, a booking page): a link with a path is not the
 * company's site, but the bare domain is the company itself (gamma.app, cal.com and coda.io are startups too).
 */
const PATH_LINK = [
  "github.com", "gitlab.com", "bitbucket.org", "docsend.com", "pitch.com", "pitch.io", "slidebean.com", "gamma.app",
  "notion.so", "coda.io", "airtable.com", "typeform.com", "calendly.com", "cal.com", "loom.com", "vimeo.com", "figma.com",
  "canva.com", "dropbox.com", "box.com", "linktr.ee", "medium.com", "substack.com", "google.com",
];
/** Hosting suffixes: a subdomain there is someone's page, not a company's own domain. */
const HOSTED = [
  "notion.site", "vercel.app", "netlify.app", "webflow.io", "github.io", "herokuapp.com", "framer.website", "framer.ai",
  "wixsite.com", "squarespace.com", "super.site", "typedream.app", "carrd.co", "canva.site", "substack.com", "medium.com",
];
const under = (domain: string, h: string) => domain === h || domain.endsWith(`.${h}`);

/**
 * Why a domain is not a company website, or undefined when it can be one. `withPath` says the input was a link with a
 * path (docsend.com/view/...), which makes a PATH_LINK host a file, not the company.
 */
export function notASite(domain: string, withPath = false): string | undefined {
  const host = ALWAYS_LINK.find(h => under(domain, h)) ?? (withPath ? PATH_LINK.find(h => under(domain, h)) : undefined)
    ?? HOSTED.find(h => domain !== h && domain.endsWith(`.${h}`));
  if (host) return `${domain} is a link to a file, a profile or a hosted page (${host}), not the company's website`;
  if (isFreeMail(domain)) return `${domain} is a personal email provider, not the company's website`;
  if (/\.(edu|gov|mil)(\.[a-z]{2})?$|\.(ac|gov|edu)\.[a-z]{2}$|\.gouv\.[a-z]{2}$|^(gov|gouv)\.[a-z]{2}$/.test(domain)) return `${domain} is a university or government domain, not the company's website`;
  return undefined;
}
/** Whether a cell holds a link with a path ("https://docsend.com/view/abc", "github.com/acme"). */
export const hasPath = (cell: string) => {
  const t = cell.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/\//, "");
  return !/^[^@\s/]+@/.test(t) && /^[^/\s]+\/[^\s?#]*[^\s/?#]/.test(t);
};

export type DealRow = {
  domain: string; name?: string; line: number;
  /** Where the domain came from: the website column, or a founder's email when the row had no usable website. */
  source?: "website" | "email";
  /** Every column of the input row, by header. */
  fields?: Record<string, string>;
};
export type Skipped = { line: number; reason: string; text: string; name?: string; fields?: Record<string, string> };
export type Duplicate = { line: number; domain: string; firstLine: number };
export type DealList = { rows: DealRow[]; skipped: Skipped[]; duplicates: Duplicate[]; column?: string; headers?: string[] };

/** Excel and other binary files read as CSV give garbage; say so instead. */
export function looksBinary(buf: Uint8Array, name: string): string | undefined {
  if (/\.(xlsx|xlsm|xls|numbers|ods)$/i.test(name) || (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) {
    return `${name} is a spreadsheet file, not a CSV. Open it and save or export it as CSV (File, Save As, "CSV UTF-8"), then run again with the .csv file.`;
  }
  if (buf.subarray(0, 4096).includes(0)) return `${name} is not a text file. Pass a CSV with a website or domain column, or a text file with one domain per line.`;
  return undefined;
}

/**
 * A deal list from CSV or plain text. Finds the domain column by its header (HubSpot "Company Domain Name",
 * Salesforce "Website", Attio "Domains", Affinity "Organization Domain", a plain "domain"); with no header row, the
 * first cell that looks like a domain is used. A founder's work email is the fallback when a row has no usable
 * website. Links to decks, profiles and hosted pages, and personal email providers, are skipped with the reason.
 * Duplicates are kept once; skipped rows and duplicates carry their real line number.
 */
export function parseDeals(raw: string): DealList {
  const text = raw.replace(/^﻿/, "");
  const delimiter = sniffDelimiter(text);
  const records = parseCsv(text, delimiter);
  const out: DealList = { rows: [], skipped: [], duplicates: [] };
  if (!records.length) return out;

  const header = records[0].cells.map(squash);
  const pick = (names: string[]) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  // A first-row cell that is itself a domain (urlbox.io, mydomain.ai) is data, not a header.
  const isData = (i: number) => !!normalizeDomain(records[0].cells[i] ?? "") || /@/.test(records[0].cells[i] ?? "");
  let domainCol = pick(DOMAIN_HEADERS);
  if (domainCol < 0) domainCol = header.findIndex((h, i) => /domain|website|url/.test(h) && !NOT_A_SITE_HEADER.test(h) && !isData(i));
  const nameCol = pick(NAME_HEADERS);
  const emailCol = pick(EMAIL_HEADERS) >= 0 ? pick(EMAIL_HEADERS) : header.findIndex((h, i) => /email/.test(h) && !isData(i));
  const exactHeader = pick(DOMAIN_HEADERS) >= 0 || nameCol >= 0 || pick(EMAIL_HEADERS) >= 0;
  // No header name matched exactly and the first row holds a domain: it is data ("acme.com,Hurley Inc").
  const firstRowIsData = !exactHeader && records[0].cells.some((_, i) => isData(i));
  const hasHeader = !firstRowIsData && (domainCol >= 0 || nameCol >= 0 || emailCol >= 0 || records[0].cells.every(c => !normalizeDomain(c)));
  if (hasHeader) {
    out.column = records[0].cells[domainCol >= 0 ? domainCol : emailCol]?.trim() || undefined;
    const used = new Set<string>();
    out.headers = records[0].cells.map((h, i) => {
      // A file this tool wrote (unresolved.csv) carries input_ columns: read them under their original names.
      const base = h.trim().replace(/^input_/, "") || `column ${i + 1}`;
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
      used.add(name);
      return name;
    });
  }
  if (hasHeader && domainCol < 0 && emailCol < 0) {
    out.skipped.push({ line: 1, reason: `no website, domain or email column (columns: ${records[0].cells.map(c => c.trim()).filter(Boolean).slice(0, 8).join(", ")}). Add a column named website with each company's domain and run again`, text: records[0].cells.join(delimiter).slice(0, 120) });
    return out;
  }

  const seen = new Map<string, number>();
  for (const r of hasHeader ? records.slice(1) : records) {
    const name = hasHeader && nameCol >= 0 ? r.cells[nameCol]?.trim() || undefined : undefined;
    const raw = r.cells.join(delimiter).slice(0, 160);
    const fields = out.headers ? Object.fromEntries(out.headers.map((h, i) => [h, (r.cells[i] ?? "").trim()])) : undefined;
    let candidates: Array<{ d: string; path: boolean; from: "website" | "email" }>;
    if (hasHeader) {
      // Attio and others put several domains in one cell: the first usable one is the company's.
      const site = domainCol >= 0 ? (r.cells[domainCol] ?? "").split(/[,;|\s]+/).map(t => ({ d: normalizeDomain(t), path: hasPath(t) })).filter((x): x is { d: string; path: boolean } => !!x.d) : [];
      const mail = emailCol >= 0 ? normalizeDomain(r.cells[emailCol] ?? "") : undefined;
      candidates = [...site.map(x => ({ d: x.d, path: x.path, from: "website" as const })), ...(mail ? [{ d: mail, path: false, from: "email" as const }] : [])];
    } else {
      candidates = r.cells.map(t => ({ d: normalizeDomain(t), path: hasPath(t) })).filter((x): x is { d: string; path: boolean } => !!x.d).map(x => ({ ...x, from: "website" as const }));
    }
    const pickd = candidates.find(c => !notASite(c.d, c.path));
    if (!pickd) {
      const why = candidates.length ? candidates.map(c => `${notASite(c.d, c.path)}${c.from === "email" ? " (from the founder's email)" : ""}`).join("; ") : "no usable website or domain";
      out.skipped.push({ line: r.line, reason: why, text: raw, name, ...(fields ? { fields } : {}) });
      continue;
    }
    const domain = pickd.d;
    const first = seen.get(domain);
    if (first !== undefined) { out.duplicates.push({ line: r.line, domain, firstLine: first }); continue; }
    seen.set(domain, r.line);
    out.rows.push({ domain, name, line: r.line, source: pickd.from, ...(fields ? { fields } : {}) });
  }
  return out;
}

/** Personal email providers: a founder's gmail address says nothing about the company. */
export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.de", "gmx.net", "web.de", "t-online.de", "yandex.com", "yandex.ru", "mail.ru", "mail.com", "zoho.com",
  "qq.com", "163.com", "126.com", "fastmail.com", "hey.com", "msn.com", "ymail.com", "rediffmail.com", "naver.com",
  "daum.net", "free.fr", "orange.fr", "laposte.net", "libero.it", "seznam.cz", "wp.pl", "o2.pl", "tutanota.com",
  "hushmail.com", "inbox.com", "rocketmail.com", "protonmail.ch", "tuta.io", "tutanota.de", "duck.com", "foxmail.com",
  "posteo.de", "mailbox.org", "fastmail.fm", "zohomail.com", "aim.com", "yeah.net", "sina.com", "mail.ru", "btinternet.com", "sky.com", "virginmedia.com", "comcast.net",
  "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "shaw.ca", "rogers.com", "bigpond.com", "optusnet.com.au",
]);
/** Yahoo, Hotmail, Outlook and Live in every country (yahoo.co.uk, hotmail.fr, outlook.de ...). */
const MAIL_COUNTRIES = "fr|de|it|es|nl|be|ca|ie|in|jp|se|dk|no|fi|at|ch|pt|pl|br|mx|ar|cl|au|nz|uk|gr|cz|hu|ro|tr|ru|sg|my|ph|id|th|vn|kr|tw|hk|za|ng|ke|eg|il|sa|ae";
const FREE_MAIL_FAMILIES = new RegExp(`^(yahoo|hotmail|outlook|live|windowslive)\\.(com|(?:${MAIL_COUNTRIES})|co\\.[a-z]{2}|com\\.[a-z]{2})$`);
export const isFreeMail = (domain: string) => FREE_MAIL.has(domain) || FREE_MAIL_FAMILIES.test(domain);

/** "a.com,b.com" or "a.com b.com" from --peers. */
export const splitList = (s: string): string[] => s.split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
