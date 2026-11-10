/**
 * The portfolio: a CSV file or a Google Sheet. Reads the column names CRM and spreadsheet exports use (Affinity,
 * HubSpot, Attio, Salesforce, Google Sheets), so an export usually works without editing. Pure parsing here; the one
 * network read (a Sheet link) is `readSource`.
 *
 * Columns (any order, any case): company name, website, owner (the partners whose Slack gets that company's alerts;
 * several names allowed), status (exited, acquired, written off or shut down rows are skipped), careers (the careers
 * page, when it is not at /careers or /jobs), leaders (profile URLs: when given, the leaders watched for that company).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ROOT } from "./config.js";

export type PortfolioRow = {
  /** Line in the file the row starts on (the header is line 1). */
  line: number;
  name?: string;
  domain?: string;
  /** The owners as written, joined with ", " (a cell may name several partners). */
  owner?: string;
  careers?: string;
  /** Profile URLs listed for this company, normalised. */
  leaders: string[];
};

export type Portfolio = {
  rows: PortfolioRow[];
  /** Rows that could not be used, with the reason, so the message can point at the line. */
  skipped: { line: number; reason: string }[];
  duplicates: number;
  headers: string[];
  /** Things worth saying about the file as a whole, or about a row that was kept with a caveat. */
  notes: string[];
};

export const COLUMN_ALIASES = {
  name: ["company", "company name", "name", "portfolio company", "organization", "organization name", "organisation", "organisation name", "account name", "startup", "investment", "portfolio", "associated company"],
  website: ["website", "domain", "company website", "company domain", "website url", "homepage", "company url", "url", "web", "organization website", "organization domain", "organization url", "organisation website", "domains", "websites", "company websites", "primary domain"],
  owner: ["owner", "owners", "partner", "partners", "deal lead", "lead partner", "deal owner", "board member", "investment lead", "point person", "lead", "deal team", "owner name", "relationship owner", "company owner", "hubspot owner", "account owner", "record owner"],
  status: ["status", "stage", "portfolio status", "investment status", "company status", "state"],
  careers: ["careers", "careers url", "careers page", "jobs page", "jobs url", "job board"],
  leaders: ["leaders", "founders", "leader profile urls", "founder profile urls", "profile urls", "founder profiles", "founder linkedin", "founders linkedin"],
};

/** Sites that are not a company's own website (a profile page pasted into the website column). */
const NOT_A_COMPANY_SITE = /(^|\.)(linkedin\.com|crunchbase\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|angel\.co|wellfound\.com|pitchbook\.com|google\.com|notion\.site|ycombinator\.com|github\.com|gitlab\.com|apple\.com|play\.google\.com|docsend\.com|medium\.com|substack\.com|calendly\.com|bit\.ly|linktr\.ee|youtube\.com|dropbox\.com|typeform\.com|notion\.so|airtable\.com)$/;

/** Turns a URL, "www.acme.com" or "acme.com/x" into "acme.com". Returns null when it is not a domain at all. */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.endsWith(".local") || host === "localhost" || /^\d+(\.\d+){3}$/.test(host)) return null;
  return host;
}

/**
 * One spelling per profile, so the same person is never watched twice: https://www.<host>/in/<slug>, lowercased,
 * decoded, without a mobile or country subdomain, query string, trailing slash or locale segment.
 */
export function normalizeProfileUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|[a-z]{2}\.)/, "");
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep as is */ }
    path = path.replace(/\/+$/, "").replace(/(\/in\/[^/]+)\/[a-z]{2}$/i, "$1");
    return `https://www.${host}${path.toLowerCase()}`;
  } catch {
    return trimmed;
  }
}

/** A person's profile URL (".../in/<slug>"). */
export const isProfileUrl = (s: string): boolean => /^(https?:\/\/)?([a-z0-9-]+\.)*[a-z0-9-]+\.[a-z]+\/in\/[^/\s]+/i.test(s.trim());

/** Status values that mean the fund no longer holds the company: those rows are not watched. */
export const NOT_HELD = /\b(exited|fully exited|exit|acquired|sold|written[ -]?off|write[ -]?off|shut ?down|closed[ -/]+lost|inactive|dead|defunct|reali[sz]ed|dissolved|wound down|liquidated|pass|passed|lost|declined|rejected|not interested|bankrupt|out of business)\b/i;
/** Status words that mean the fund still holds it, even next to a word above ("Not exited", "Closed Won", "Exit pending"). */
export const STILL_HELD = /\b(not|pre)[- ]+(yet )?(exit(ed)?|sold|acquired|written off|reali[sz]ed)\b|\b(exit|sale|write[- ]?off) pending\b|\bpartial(ly)?[- ]+(exit(ed)?|sold|reali[sz]ed)\b|\bclosed[- ]+won\b|^won$/i;
export const isNotHeld = (status: string): boolean => NOT_HELD.test(status) && !STILL_HELD.test(status);

/**
 * Splits an owner cell that names several partners: "Priya Shah, Sam Lee", "Priya / Sam", "Priya and Sam". Email
 * addresses ("Jo Park <jo@fund.vc>") are dropped; "&" is kept as part of a name ("Smith & Co").
 */
export const splitOwners = (cell: string | undefined): string[] =>
  [...new Set((cell ?? "")
    .replace(/<[^>]*@[^>]*>|\([^)]*@[^)]*\)|\S+@\S+/g, " ")
    .split(/\s*(?:,|;|\/|\+|\band\b|\n)\s*/i)
    .map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean))];

/** The first real company website in a cell ("acme.com, acme.io", "n/a", a profile page). */
function siteIn(cell: string): { domain?: string; problem?: string } {
  const parts = cell.split(/[\s,;|]+/).filter(Boolean);
  for (const p of parts) {
    if (isProfileUrl(p) || /^(https?:\/\/)?[^/]+\/(company|in|organization|pub|school|companies)\//i.test(p)) continue;
    const d = normalizeDomain(p);
    if (d && !NOT_A_COMPANY_SITE.test(d)) return { domain: d };
  }
  const profile = parts.some(p => isProfileUrl(p) || /\/(company|organization|companies)\//i.test(p) || NOT_A_COMPANY_SITE.test(normalizeDomain(p) ?? ""));
  return { problem: profile ? "the website cell holds a profile or directory page, not the company's own site" : `"${cell.slice(0, 60)}" is not a website` };
}

export function readPortfolioCsv(text: string): Portfolio {
  const { headers, rows, lines } = parseCsv(text);
  const out: PortfolioRow[] = [];
  const skipped: Portfolio["skipped"] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const known = Object.values(COLUMN_ALIASES).flat();
  // A website column under another name ("HQ website", "Primary Domain (Affinity)"): any header with website or domain.
  const extraSite = headers.find(h => !COLUMN_ALIASES.website.includes(h) && /\b(website|domain|url)\b/.test(h) && !/careers|jobs|linkedin|profile|logo|crunchbase|twitter|deck|pitch|docsend|calendly|data ?room|memo/.test(h));
  if (headers.length && !headers.some(h => known.includes(h)) && !extraSite) {
    skipped.push({ line: 1, reason: `no column named like a company or website (found: ${headers.slice(0, 6).join(", ")}). Name one "company" or "website".` });
    return { rows: [], skipped, duplicates, headers, notes };
  }
  if (!headers.some(h => COLUMN_ALIASES.website.includes(h)) && !extraSite && rows.length) {
    notes.push(`No website column found (columns: ${headers.slice(0, 8).join(", ")}). Companies are matched by name, which can pick the wrong one; add a "website" column for a sure match.`);
  }

  rows.forEach((row, i) => {
    const pick = (field: keyof typeof COLUMN_ALIASES) => COLUMN_ALIASES[field].map(alias => row[alias]).find(v => v && v.trim())?.trim();
    const line = lines[i];
    const name = pick("name");
    const site = pick("website") ?? (extraSite ? row[extraSite]?.trim() || undefined : undefined);
    const status = pick("status");
    if (!name && !site) { if (Object.values(row).some(v => v.trim())) skipped.push({ line, reason: "no company name or website" }); return; }
    if (status && isNotHeld(status)) { skipped.push({ line, reason: `status is "${status.slice(0, 30)}" (rows marked exited, acquired, written off, shut down, pass, passed, lost or rejected are not watched)` }); return; }
    if (!site && name && /^((sub|grand )?totals?|fund [ivx\d]+|portfolio|companies|active|exited)$/i.test(name.trim())) { skipped.push({ line, reason: `"${name}" looks like a heading or total row` }); return; }
    let domain: string | undefined;
    if (site && !/^(n\/?a|none|-+|tbd|\?)$/i.test(site)) {
      const found = siteIn(site);
      if (found.domain) domain = found.domain;
      else if (name) notes.push(`Line ${line}: ${found.problem}, so ${name} is matched by name. Put its own website there for a sure match.`);
      else { skipped.push({ line, reason: found.problem! }); return; }
    } else if (name && looksLikeDomain(name)) {
      domain = normalizeDomain(name)!; // a sheet with only a "company" column of websites
    }
    if (!domain && !name) { skipped.push({ line, reason: "no company name, and the website cell is empty or n/a" }); return; }
    const key = domain ?? `name:${name!.toLowerCase().replace(/\s+/g, " ")}`;
    if (seen.has(key)) { duplicates++; return; }
    seen.add(key);
    const leaders = [...new Set((pick("leaders") ?? "").split(/[\s,;|]+/).filter(isProfileUrl).map(normalizeProfileUrl))];
    const careersRaw = pick("careers");
    const careers = careersRaw && /^https?:\/\//i.test(careersRaw) ? careersRaw : careersRaw && normalizeDomain(careersRaw) ? `https://${careersRaw.replace(/^\/+/, "")}` : undefined;
    const owners = splitOwners(pick("owner"));
    out.push({ line, name: name && !(domain && looksLikeDomain(name)) ? name : undefined, domain, owner: owners.length ? owners.join(", ") : undefined, careers, leaders });
  });
  // Say which statuses are being watched, so a pipeline export (Lead, Diligence) is noticed before it is paid for.
  const statusCol = headers.find(h => COLUMN_ALIASES.status.includes(h));
  if (statusCol && out.length) {
    const counts = new Map<string, number>();
    rows.forEach(r => { const v = r[statusCol]?.trim(); if (v && !isNotHeld(v)) counts.set(v, (counts.get(v) ?? 0) + 1); });
    if (counts.size > 1) notes.push(`Statuses watched: ${[...counts].map(([k, n]) => `${k} ${n}`).join(", ")}. Every row not skipped is watched; delete rows the fund does not hold.`);
  }
  return { rows: out, skipped, duplicates, headers, notes };
}

export const looksLikeDomain = (input: string): boolean => /\./.test(input.trim()) && !/\s/.test(input.trim()) && normalizeDomain(input) !== null;

/**
 * Small RFC 4180 reader: quoted fields, escaped quotes, newlines inside quotes, CRLF, a byte order mark. Detects comma,
 * semicolon (European Excel) or tab delimiters from the header line. `lines` holds the line each row starts on.
 */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[]; lines: number[]; delimiter: string } {
  text = text.replace(/^﻿/, "");
  const firstLine = text.slice(0, Math.max(0, text.search(/\r?\n|$/)));
  const counts = [",", ";", "\t"].map(d => [d, firstLine.split(d).length - 1] as const);
  const delimiter = counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];

  const records: { cells: string[]; line: number }[] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else { if (ch === "\n") line++; field += ch; }
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) { record.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field); records.push({ cells: record, line: recordLine });
      record = []; field = ""; line++; recordLine = line;
    } else field += ch;
  }
  if (field || record.length) { record.push(field); records.push({ cells: record, line: recordLine }); }

  const nonEmpty = records.filter(r => r.cells.some(cell => cell.trim()));
  // A title row above the real header ("Fund II portfolio, as of Oct"): the header is the first of the first 10 rows
  // with a known column name.
  const known = new Set(Object.values(COLUMN_ALIASES).flat());
  const norm = (h: string) => h.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
  const at = Math.max(0, nonEmpty.slice(0, 10).findIndex(r => r.cells.some(c => known.has(norm(c)))));
  const [header, ...body] = nonEmpty.slice(at);
  if (!header) return { headers: [], rows: [], lines: [], delimiter };
  const headers = header.cells.map(h => h.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " "));
  return {
    headers,
    rows: body.map(r => Object.fromEntries(headers.map((key, i) => [key, (r.cells[i] ?? "").trim()]))),
    lines: body.map(r => r.line),
    delimiter,
  };
}

/** The CSV export link for a Google Sheet link, or null when it is not one. Keeps the tab (gid) the link points at. */
export function sheetCsvUrl(link: string): string | null {
  let u: URL;
  try { u = new URL(link.trim()); } catch { return null; }
  if (u.hostname !== "docs.google.com" || !u.pathname.startsWith("/spreadsheets/")) return null;
  // Links from a browser signed in to several Google accounts carry /u/<n>/.
  u.pathname = u.pathname.replace(/^\/spreadsheets\/u\/\d+\//, "/spreadsheets/");
  const published = /^\/spreadsheets\/d\/e\/([\w-]+)/.exec(u.pathname);
  const gid = /(?:^|[#&?])gid=(\d+)/.exec(`${u.search}${u.hash}`)?.[1];
  if (published) return `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?output=csv${gid ? `&gid=${gid}` : ""}`;
  const id = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname)?.[1];
  return id ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}` : null;
}

export const SHEET_SHARING_STEPS = 'In Google Sheets: File > Share > Publish to web, pick the tab with your portfolio and "Comma-separated values (.csv)", click Publish and copy the link (only that tab can be read). A link shared as "Anyone with the link" also works, but exposes every tab.';

/** Where a Sheet's CSV may come from after Google's redirect. */
const SHEET_HOSTS = /^(docs\.google\.com|[a-z0-9-]+\.googleusercontent\.com)$/;
export const MAX_PORTFOLIO_BYTES = 5_000_000;

/** Reads the portfolio text from a file path or a Google Sheet link. Plain messages for every way it can fail. */
export async function readSource(source: string, fetchFn: typeof fetch = fetch): Promise<string> {
  // Paths pasted with quotes, a "~" or shell escapes.
  const s = source.trim().replace(/^(['"])(.*)\1$/, "$2").replace(/\\ /g, " ").replace(/^~(?=\/|$)/, homedir());
  if (/^https?:\/\/drive\.google\.com\//i.test(s)) throw new Error("That is a Google Drive file, not a Google Sheet. Open it, choose File > Save as Google Sheets, and use the new Sheet's link.");
  if (/^https?:\/\//i.test(s)) {
    const csvUrl = sheetCsvUrl(s);
    if (!csvUrl) {
      if (!/^https:\/\//i.test(s)) throw new Error("The portfolio link must start with https://");
      if (!/\.csv(\?|$)/i.test(new URL(s).pathname + new URL(s).search)) throw new Error("PORTFOLIO must be a CSV file, a Google Sheet link, or an https link to a .csv file.");
    }
    let res: Response;
    // A Sheet export redirects to Google's content host (checked below); any other CSV link must not redirect at all.
    try { res = await fetchFn(csvUrl ?? s, { redirect: csvUrl ? "follow" : "error", signal: AbortSignal.timeout(30_000) }); }
    catch (err) { throw new Error(`Could not read the portfolio link (${(err as Error).message}).`); }
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 401 || res.status === 403 || (res.ok && /html/i.test(type))) throw new Error(`The Sheet is not shared, so it cannot be read without signing in. ${SHEET_SHARING_STEPS}`);
    if (res.status === 404) throw new Error("No Sheet at that link. Copy the link again from the browser's address bar.");
    if (!res.ok) throw new Error(`Reading the portfolio link failed (${res.status}).`);
    // A Sheet link may only end up on Google's own hosts.
    if (csvUrl && res.url) { try { if (!SHEET_HOSTS.test(new URL(res.url).hostname)) throw new Error("The Sheet link redirected somewhere other than Google; copy the link again."); } catch (err) { if ((err as Error).message.startsWith("The Sheet")) throw err; } }
    const { readCapped } = await import("./crustdata.js");
    return readCapped(res, MAX_PORTFOLIO_BYTES, "The portfolio is over 5 MB; keep only the company columns.");
  }
  const file = resolve(ROOT, s);
  if (!existsSync(file)) throw new Error(`No portfolio file at ${s}. Copy portfolio.example.csv to portfolio.csv, or set PORTFOLIO to a Google Sheet link (npm run setup).`);
  if (statSync(file).isDirectory()) throw new Error(`${s} is a folder. Point PORTFOLIO at the CSV file inside it.`);
  if (statSync(file).size > MAX_PORTFOLIO_BYTES) throw new Error("The portfolio is over 5 MB; keep only the company columns.");
  if (/\.(xlsx|xls|numbers|ods)$/i.test(file)) throw new Error(`${s} is a spreadsheet file, not CSV. Save it as CSV (File > Download > CSV in Google Sheets; File > Save As > CSV in Excel).`);
  const buf = readFileSync(file);
  if (buf[0] === 0x50 && buf[1] === 0x4b) throw new Error(`${s} is a spreadsheet file renamed to .csv. Save it as CSV from the spreadsheet app.`);
  return buf.toString("utf8");
}

/** Rows the import could not match, as a CSV the user can fix and import again. */
export function unresolvedCsv(rows: { row: PortfolioRow; reason: string; candidates?: string[] }[]): string {
  const q = (s = "") => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["company,website,owner,reason,candidates"];
  for (const { row, reason, candidates } of rows) lines.push([row.name, row.domain, row.owner, reason, (candidates ?? []).join(" ")].map(q).join(","));
  return lines.join("\n") + "\n";
}

export const DEFAULT_PORTFOLIO = resolve(ROOT, "portfolio.csv");
