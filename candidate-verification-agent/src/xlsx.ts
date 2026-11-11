/**
 * A small reader for Excel .xlsx files (every sheet; `readTable` picks one), with no dependencies: an .xlsx file is a zip of XML
 * files, read here with node:zlib. Several ATS exports (Greenhouse among them) download as .xlsx, so recruiters do
 * not have to convert anything. Cell hyperlinks are kept: a cell that shows "Profile" but links to a profile URL
 * comes back with the URL in it.
 */

import { inflateRawSync } from "node:zlib";

const MAX_UNZIPPED = 100 * 1024 * 1024;

/** The files inside a zip, by name. Only the ones `want` accepts are inflated. */
export function unzip(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  // End of central directory: the last record with this signature, within the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged zip directory");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("damaged zip entry");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    const out = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED }) : undefined;
    if (!out) throw new Error(`unsupported zip compression (${method})`);
    total += out.length;
    if (total > MAX_UNZIPPED) throw new Error("the spreadsheet is larger than 100 MB unpacked");
    files.set(name, out);
  }
  return files;
}

export const decodeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });

/** The text of every <t> inside a piece of XML (rich text is split into runs). */
/** The text of every <t> inside a piece of XML (rich text is split into runs); phonetic guides (<rPh>) are left out. */
const texts = (xml: string): string => [...xml.replace(/<(?:\w+:)?rPh[\s>][\s\S]*?<\/(?:\w+:)?rPh>/g, "").matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => decodeXml(m[1])).join("");

/** Column letters to a 0-based index: A = 0, Z = 25, AA = 26. */
export const columnIndex = (letters: string): number => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** An attribute's value, in double or single quotes. */
const attr = (tag: string, name: string): string | undefined => { const m = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag); return m ? m[1] ?? m[2] : undefined; };

export type Sheet = { name: string; rows: Array<{ cells: string[]; line: number }> };

/** Every sheet of an .xlsx file, in the workbook's order, as rows of cells with their Excel row numbers. */
export function readXlsxSheets(buf: Buffer): Sheet[] {
  const files = unzip(buf, n => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml|worksheets\/_rels\/[^/]+\.rels)$/.test(n));
  const str = (name: string) => files.get(name)?.toString("utf8");
  const workbook = str("xl/workbook.xml") ?? "";
  const rels = [...(str("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<(?:\w+:)?Relationship\s[^>]*>/g)].map(m => m[0]);
  const shared = [...(str("xl/sharedStrings.xml") ?? "").matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(m => texts(m[1]));
  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\s[^>]*>/g)) {
    const rid = /\sr:id=["']([^"']+)["']/.exec(m[0])?.[1];
    const target = rid ? rels.find(t => attr(t, "Id") === rid) : undefined;
    let path = target ? attr(target, "Target") : undefined;
    if (path) path = path.startsWith("/") ? path.slice(1) : `xl/${path.replace(/^\.\//, "")}`;
    if (path && files.has(path)) sheets.push({ name: decodeXml(attr(m[0], "name") ?? `Sheet ${sheets.length + 1}`), rows: readSheet(files, path, shared) });
  }
  if (!sheets.length) {
    const first = [...files.keys()].filter(n => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()[0];
    if (!first) throw new Error("no worksheet found");
    sheets.push({ name: "Sheet1", rows: readSheet(files, first, shared) });
  }
  return sheets;
}

/** The first sheet only. */
export const readXlsx = (buf: Buffer): Array<{ cells: string[]; line: number }> => readXlsxSheets(buf)[0].rows;

function readSheet(files: Map<string, Buffer>, sheetPath: string, shared: string[]): Array<{ cells: string[]; line: number }> {
  const str = (name: string) => files.get(name)?.toString("utf8");
  const sheet = str(sheetPath) ?? "";

  // Hyperlinks: cell reference to link target.
  const links = new Map<string, string>();
  const sheetRels = str(sheetPath.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels")) ?? "";
  const relTargets = new Map([...sheetRels.matchAll(/<(?:\w+:)?Relationship\s[^>]*>/g)].map(m => [attr(m[0], "Id") ?? "", decodeXml(attr(m[0], "Target") ?? "")]));
  for (const m of sheet.matchAll(/<(?:\w+:)?hyperlink\s[^>]*>/g)) {
    const ref = attr(m[0], "ref"), id = /\sr:id=["']([^"']+)["']/.exec(m[0])?.[1];
    const href = id ? relTargets.get(id) : undefined;
    if (ref && href) links.set(ref.split(":")[0].toUpperCase(), href);
  }

  const rows: Array<{ cells: string[]; line: number }> = [];
  let lastLine = 0;
  for (const rowMatch of sheet.matchAll(/<(?:\w+:)?row(\s[^>]*["'])?>([\s\S]*?)<\/(?:\w+:)?row>|<(?:\w+:)?row(?:\s[^>]*)?\/>/g)) {
    const line = Number(attr(rowMatch[1] ?? "", "r")) || lastLine + 1;
    lastLine = line;
    const row: string[] = [];
    let next = 0;
    for (const c of (rowMatch[2] ?? "").matchAll(/<(?:\w+:)?c(\s[^>]*?)?(\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const tag = c[1] ?? "";
      const ref = attr(tag, "r");
      const col = ref ? columnIndex(/^[A-Z]+/i.exec(ref)?.[0] ?? "A") : next;
      const type = attr(tag, "t");
      const inner = c[3] ?? "";
      const v = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = texts(inner);
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
      else value = v !== undefined ? decodeXml(v) : "";
      const href = ref ? links.get(ref.toUpperCase()) : undefined;
      if (href && !value.includes(href)) value = value ? `${value} ${href}` : href;
      while (row.length < col) row.push("");
      row[col] = value;
      next = col + 1;
    }
    if (row.some(cell => cell.trim() !== "")) rows.push({ cells: row, line });
  }
  return rows;
}
