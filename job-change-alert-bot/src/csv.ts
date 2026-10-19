/**
 * Reads the people list. Accepts the column names that CRM and spreadsheet exports use by default,
 * so a HubSpot, Salesforce, Attio or Google Sheets export usually works without editing.
 */

export type PersonRow = {
  email?: string;
  profileUrl?: string;
  name?: string;
  company?: string;
  title?: string;
  owner?: string;
};

export type PeopleCsv = {
  people: PersonRow[];
  /** 1-based line numbers (header is line 1) of rows with neither an email nor a profile URL. */
  skippedLines: number[];
  /** Rows that repeated an email or profile URL already seen. */
  duplicates: number;
  headers: string[];
};

export const COLUMN_ALIASES = {
  email: ["email", "work email", "business email", "email address", "email addresses", "primary email", "e-mail"],
  profileUrl: ["profile_url", "profile url", "profile", "linkedin", "linkedin url", "linkedin_url", "linkedin profile", "linkedin profile url", "url"],
  name: ["name", "full name", "contact name"],
  firstName: ["first name", "firstname", "first_name", "given name"],
  lastName: ["last name", "lastname", "last_name", "surname", "family name"],
  company: ["company", "company name", "associated company", "primary associated company", "account", "account name", "account.name", "employer", "organization"],
  title: ["title", "job title", "job_title", "position"],
  owner: ["owner", "contact owner", "account owner", "owner email", "owner name", "owner.name", "contact owner name", "rep"],
};

export function readPeopleCsv(text: string): PeopleCsv {
  const { headers, rows, lines } = parseCsv(text);
  const people: PersonRow[] = [];
  const skippedLines: number[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  rows.forEach((row, i) => {
    const pick = (field: keyof typeof COLUMN_ALIASES) => COLUMN_ALIASES[field].map(alias => row[alias]).find(Boolean);
    const email = pick("email")?.trim().toLowerCase();
    const profileUrl = pick("profileUrl");
    if (!email && !profileUrl) { skippedLines.push(lines[i]); return; }
    const key = profileUrl?.toLowerCase().replace(/\/+$/, "") ?? email!;
    if (seen.has(key)) { duplicates++; return; }
    seen.add(key);
    const fullName = pick("name") ?? ([pick("firstName"), pick("lastName")].filter(Boolean).join(" ") || undefined);
    people.push({ email, profileUrl, name: fullName, company: pick("company"), title: pick("title"), owner: pick("owner") });
  });

  return { people, skippedLines, duplicates, headers };
}

/**
 * Small RFC 4180 reader: quoted fields, escaped quotes, newlines inside quotes, CRLF, a byte order mark.
 * Detects comma, semicolon (European Excel) or tab delimiters from the header line. `lines` holds the line number
 * each row starts on, so messages can point at the right line.
 */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[]; lines: number[]; delimiter: string } {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
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
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { record.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field); records.push({ cells: record, line: recordLine });
      record = []; field = ""; line++; recordLine = line;
    } else field += ch;
  }
  if (field || record.length) { record.push(field); records.push({ cells: record, line: recordLine }); }

  const [header, ...body] = records.filter(r => r.cells.some(cell => cell.trim()));
  if (!header) return { headers: [], rows: [], lines: [], delimiter };
  const headers = header.cells.map(h => h.trim().replace(/^\uFEFF/, "").toLowerCase());
  return {
    headers,
    rows: body.map(r => Object.fromEntries(headers.map((key, i) => [key, (r.cells[i] ?? "").trim()]))),
    lines: body.map(r => r.line),
    delimiter,
  };
}
