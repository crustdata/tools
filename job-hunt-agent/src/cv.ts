/**
 * Your CV, read on your machine: markdown, plain text or PDF. The text never leaves your computer; only the
 * search (titles, place, school names) goes to Crustdata.
 *
 * From the text it takes three things the fit score and the alumni search use: the skills it names (see
 * skills.ts), the schools in the education section, and the years of work experience. Anything it gets wrong
 * can be set by hand in profile.json ("schools", "yearsExperience", "skills").
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { canonicalSkill, findSkills, SKILLS } from "./skills.js";

const SKILL_NAMES = new Set(SKILLS.map(s => s.name));

export type CvFacts = { text: string; skills: string[]; schools: string[]; years: number | null; learning?: string[] };

/** Reads a CV file to plain text, with a plain next step for files it cannot read. */
export async function readCvText(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if ([".docx", ".doc", ".pages", ".odt", ".rtf"].includes(ext)) {
    throw new Error(`${path} is a ${ext.slice(1)} file. Save it as PDF (File > Save as / Export > PDF) or paste the text into cv.md, then run again.`);
  }
  let buf: Buffer;
  try { buf = await readFile(path); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === "ENOENT"
      ? `No CV at ${path}. Put your CV in this folder as cv.md or cv.pdf, or pass --cv <path>. examples/cv-example.md shows the format.`
      : `Could not read ${path} (${code ?? (err as Error).message}).`);
  }
  if (buf.length > 10 * 1024 * 1024) throw new Error(`${path} is over 10 MB, too big for a CV. Export it again as a text PDF, or paste the text into cv.md.`);
  if (ext === ".pdf" || buf.subarray(0, 5).toString("latin1") === "%PDF-") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
      if (pdf.numPages > 20) throw new Error("too many pages");
      const { text } = await extractText(pdf, { mergePages: true });
      const out = String(text ?? "").trim();
      if (out.length < 40) throw new Error("no text");
      return out;
    } catch (err) {
      if ((err as { name?: string })?.name === "PasswordException") throw new Error(`${path} is password-protected. Save a copy without a password, or paste the text into cv.md.`);
      if ((err as Error)?.message === "too many pages") throw new Error(`${path} has more than 20 pages, which is not a CV. Point --cv at your CV.`);
      throw new Error(`Could not read text from ${path}. If it is a scanned image, export your CV again as a text PDF, or paste the text into cv.md.`);
    }
  }
  if (buf.subarray(0, 4).toString("latin1") === "PK\u0003\u0004") {
    throw new Error(`${path} looks like a Word or zip file. Save it as PDF or paste the text into cv.md, then run again.`);
  }
  return buf.toString("utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

// ---------------------------------------------------------------------------
// Pure parsing, tested in test/parsing.test.ts
// ---------------------------------------------------------------------------

const HEADING = /^\s*(?:#{1,6}\s*)?([A-Za-z][A-Za-z &/]{2,40}?)\s*:?\s*$/;
const SECTION_WORDS = /\b(education|academic|experience|employment|work|career|history|positions|skills|projects|publications|awards|certifications|summary|profile|about|interests|languages|volunteering|leadership|activities|honors|training)\b/i;
/** Headings of the sections that hold jobs: "Experience", "Relevant Experience", "Career History", "Work". */
const WORK_HEADING = /\b(experience|employment|work|career|history|positions)\b/i;
const EDU_HEADING = /\b(education|academic|training)\b/i;

/** The CV split into sections by heading ("Experience", "## Education", "EDUCATION:"). */
export function sections(text: string): Array<{ name: string; lines: string[] }> {
  const out: Array<{ name: string; lines: string[] }> = [{ name: "", lines: [] }];
  for (const line of text.split("\n")) {
    const m = HEADING.exec(line);
    if (m && SECTION_WORDS.test(m[1].trim()) && m[1].trim().split(/\s+/).length <= 4) out.push({ name: m[1].trim().toLowerCase(), lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}

/** Bootcamps count as schools: their alumni are a warm network too. */
const BOOTCAMPS = "Hack Reactor|General Assembly|Flatiron School|Codesmith|Lambda School|BloomTech|Rithm School|Launch School|Le Wagon|Coding Dojo|Tech Elevator|App Academy|Turing School|Nucamp|Springboard|Fullstack Academy|Galvanize|Ironhack|Makers Academy|Recurse Center";
const SCHOOL_WORD = new RegExp(`\\b(university|universit[äéà]t?|universidad|universidade|universit[àé]|college|institute|polytechnic|politecnico|[ée]cole|hochschule|academy|school of|business school|law school|bootcamp|IIT|NIT|BITS|MIT|UCLA|UC [A-Z][a-z]+|Caltech|ETH|${BOOTCAMPS})\\b`, "i");
const DEGREE = /\b(B\.?\s?S\.?c?|B\.?\s?A\.?|B\.?\s?E\.?|B\.?\s?Tech|M\.?\s?S\.?c?|M\.?\s?A\.?|M\.?\s?Eng|M\.?\s?Tech|MBA|Ph\.?\s?D|Bachelor|Master|Doctor|Associate|Diploma|Minor|Major|GPA|Class of|Graduated|Exchange|Immersive|Certificate|Software Engineering|Web Development|Full[- ]?Stack|Program)\b/i;
/** University systems whose campus after the comma is part of the name; for any other school a city is cut. */
const CAMPUS_SYSTEMS = /^(University of (California|Texas|Wisconsin|Illinois|Massachusetts|Colorado|North Carolina|Maryland|Hawaii|Minnesota|Missouri|Nebraska|Michigan|Tennessee|Alabama|Arkansas|Pittsburgh)|State University of New York|City University of New York|Indian Institute of Technology|National Institute of Technology|Birla Institute of Technology and Science)$/i;

/** "University of California, Berkeley | B.S. Computer Science, 2020" to "University of California, Berkeley". */
export function schoolFromLine(line: string): string | null {
  // "Indian Institute of Technology (IIT) Bombay": a bracketed short form is not where the name ends.
  let s = line.replace(/^[\s#*\-•·>|]+/, "").replace(/\*\*|__|`/g, "").replace(/\s*\((?:[A-Z]{2,6})\)\s*/g, " ").trim();
  if (!SCHOOL_WORD.test(s)) return null;
  // Separators end the name; the piece kept is the first that names a school ("B.A. Education | Michigan").
  const DEGREE_FIRST = /^(?:[BM]\.?\s?[A-Z]\.?|Ph\.?\s?D|Bachelor|Master|Doctor|Associate|Diploma|Minor|Major)\b/i;
  const pieces = s.split(/\s+[\u2014\u2013|·•]\s+|\s+-\s+|\t|\s{3,}|\(|\[/).filter(x => SCHOOL_WORD.test(x));
  s = pieces.find(x => !DEGREE_FIRST.test(x.trim())) ?? pieces[0] ?? "";
  // "B.S. Computer Science, University of Washington, 2020": start at the part that names the school; then a
  // comma followed by a degree, a year or a place ends the name.
  const all = s.trim().split(/,\s*/);
  // "B.S. Computer Science from University of Texas at Austin": the school starts after "from" or "at".
  for (let k = 0; k < all.length; k++) {
    const cut = /^(?:.*?\b(?:from|at)\s+(?:the\s+)?)(.+)$/i.exec(all[k]);
    if (DEGREE_FIRST.test(all[k].trim()) && cut && SCHOOL_WORD.test(cut[1])) all[k] = cut[1].replace(/\s+at\s+(?=[A-Z])/, " at ");
  }
  const at = all.findIndex(x => SCHOOL_WORD.test(x) && !DEGREE_FIRST.test(x.trim()));
  if (at < 0) return null;
  const parts = all.slice(at);
  let name = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (DEGREE.test(p) || /\d{4}/.test(p) || /^[A-Z]{2}$/.test(p.trim())) break;
    // "University of California, Berkeley": a short capitalised place after a comma belongs to the name.
    if (i === 1 && /^[A-Z][\p{L}.' -]{1,30}$/u.test(p) && CAMPUS_SYSTEMS.test(name)) { name = `${name}, ${p}`; continue; }
    break;
  }
  // A year or a range of years after the name ("University of Washington 2019-2023") is not part of it.
  name = name.replace(/\s*\(?\b(19|20)\d{2}\b.*$/, "").replace(DEGREE, "").replace(/[\s,;:\u2013\u2014-]+$/, "").trim();
  if (name.length < 3 || name.length > 90 || !SCHOOL_WORD.test(name)) return null;
  return name;
}

/** Schools named in the education section; if there is no such section, any line that names a school. */
export function findSchools(text: string): string[] {
  const secs = sections(text);
  const edu = secs.filter(s => EDU_HEADING.test(s.name) && !WORK_HEADING.test(s.name));
  const lines = edu.length ? edu.flatMap(s => s.lines) : text.split("\n").filter(l => !/\b(intern|engineer|developer|manager)\b/i.test(l));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const s = schoolFromLine(l);
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  }
  return out.slice(0, 4);
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const POINT = `(?:(${MONTH})\\.?\\s+|(\\d{1,2})[/.])?((?:19|20)\\d{2})`;
/** "Jun '23" to "Jun 2023", "2023/06" to "06/2023", so one pattern reads them all. */
export function normaliseDates(text: string): string {
  return text
    // "Jun '98" is 1998; "Jun '23" is 2023.
    .replace(new RegExp(`\\b(${MONTH})\\.?\\s+['\u2019](\\d{2})\\b`, "gi"), (_m, mon, yy) => `${mon} ${Number(yy) > (new Date().getUTCFullYear() % 100) + 1 ? 19 : 20}${yy}`)
    .replace(/\b((?:19|20)\d{2})[/-](0?[1-9]|1[0-2])\b(?![/-]\d)/g, (_m, y, mo) => `${mo}/${y}`);
}

const RANGE = new RegExp(`${POINT}\\s*(?:-|\u2013|\u2014|to|until)\\s*(?:${POINT}|(present|current|now|today|ongoing))`, "gi");

const HAS_RANGE = new RegExp(RANGE.source, "i");

/** Month index (years * 12 + month) of one end of a range. */
function monthOf(mon: string | undefined, num: string | undefined, year: string, end: boolean): number {
  const y = Number(year);
  let m = end ? 11 : 0;
  if (mon) m = MONTHS[mon.slice(0, 4).toLowerCase().replace(/^sept$/, "sept")] ?? MONTHS[mon.slice(0, 3).toLowerCase()] ?? m;
  else if (num && Number(num) >= 1 && Number(num) <= 12) m = Number(num) - 1;
  return y * 12 + m;
}

/** Lines that read as tech, product, design or data work: when the CV has some, only those count as years. */
const TECH_ROLE = /engineer|developer|programmer|software|\bdata\b|analyst|scientist|designer|product (?:manager|designer|owner|lead)|devops|\bsre\b|architect|\bqa\b|test (?:engineer|automation)|technical|machine learning|\bml\b|\bai\b|security engineer|infosec|web (?:developer|designer)|mobile|cloud|full[- ]?stack|front[- ]?end|back[- ]?end|platform|infrastructure|\bapis?\b|coding|programming|computer science/i;

/** Job titles that are tech, product, design or data work on their own. */
const TECH_TITLE = /engineer|developer|programmer|software|scientist|analyst|architect|devops|\bsre\b|designer|product (?:manager|owner|designer)/i;

/** "IT" as a word in capitals ("IT Support"), not "it". */
const isTech = (s: string): boolean => TECH_ROLE.test(s) || /\bIT\b/.test(s);

/** Jobs that are another career even when the title mentions data or web ("Teacher & Data Lead"). */
const NON_TECH = /\b(teach(?:er|ing)|tutor|counsel(?:or|ing)|coach|nurse|barista|cashier|server|waiter|waitress|retail|sales associate|paralegal|chef|cook)\b/i;

/**
 * Years of work experience:
 *   - an explicit "6 years of experience" wins, unless it is about another field ("8 years of experience in hospitality");
 *   - otherwise the date ranges in the work sections are merged (overlapping jobs count once) and added up;
 *   - when some jobs read as tech, product, design or data work, only those count, so a career changer's earlier
 *     years do not make them "senior". Internships never count.
 * Null when the CV has no dates at all. Set "yearsExperience" in profile.json to override.
 */
export function yearsOfExperience(raw: string, now = new Date()): number | null {
  const text = normaliseDates(raw);
  // A stated total ("6 years of experience", "8 years of experience in software") wins. A claim about one tool
  // ("2 years of experience with Kubernetes") only raises the total from the dates, never lowers it. A claim
  // about another career ("7 years of experience teaching") does not count.
  let toolClaim = 0;
  for (const said of text.matchAll(/(\d{1,2})\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:professional\s+|industry\s+|work\s+|hands-on\s+)?experience([^.\n]{0,60})/gi)) {
    const about = said[2];
    if (!about.trim() || (isTech(about) && !findSkills(about).length)) return Number(said[1]);
    if (findSkills(about).length) toolClaim = Math.max(toolClaim, Number(said[1]));
  }
  const fromDates = yearsFromDates(text, now);
  return toolClaim ? Math.max(toolClaim, fromDates ?? 0) : fromDates;
}

/** Years from the date ranges of the work sections (see yearsOfExperience). */
function yearsFromDates(text: string, now: Date): number | null {
  const secs = sections(text);
  const named = secs.filter(s => WORK_HEADING.test(s.name) && !EDU_HEADING.test(s.name));
  const work = named.length ? named : secs.filter(s => !EDU_HEADING.test(s.name) && !/projects|publications|awards|certifications|volunteering|activities|honors/.test(s.name));
  const nowM = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const spans: Array<{ span: [number, number]; tech: boolean; other: boolean }> = [];
  for (const s of work) {
    const lines = s.lines;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(RANGE)) {
        // The title is on the date's line; when the line is only a date, on the line above it (the line below
        // only when the one above is empty, since below is often the next job's title).
        const rest = line.replace(m[0], " ").replace(/[^\p{L}]+/gu, " ").trim();
        // The line above belongs to this job unless it has its own dates; "Barista / Starbucks Coffee, 2015 -
        // 2018" keeps "Barista" with its company line.
        const above = (lines[i - 1] ?? "").trim();
        const aboveIsThisJob = above && !HAS_RANGE.test(above);
        const context = aboveIsThisJob ? `${above} ${line}` : rest.split(" ").length >= 2 ? line : `${line} ${lines[i + 1] ?? ""}`;
        if (/\bintern(ship)?\b|\bco-?op\b/i.test(line) || (/\bintern(ship)?\b/i.test(lines[i - 1] ?? "") && !HAS_RANGE.test(lines[i - 1] ?? ""))) continue;
        const start = monthOf(m[1], m[2], m[3], false);
        const end = m[7] ? nowM : m[6] ? monthOf(m[4], m[5], m[6], true) : NaN;
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start && end <= nowM + 1 && start > 1960 * 12) {
          // A tech job title ("Software Engineer, Retail Platform", "Data Engineer at Coach") is tech whatever
          // else the line says; a weaker tech word ("Teacher & Data Lead") does not beat another career.
          const tech = TECH_TITLE.test(context) || (isTech(context) && !NON_TECH.test(context));
          spans.push({ span: [start, Math.min(end, nowM)], tech, other: !tech && NON_TECH.test(context) });
        }
      }
    });
  }
  // Tech jobs when there are any; otherwise every job that is not plainly another career (teaching, retail).
  const use = spans.some(x => x.tech) ? spans.filter(x => x.tech).map(x => x.span) : spans.filter(x => !x.other).map(x => x.span);
  if (!use.length) return null;
  use.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = use[0];
  for (const [s, e] of use.slice(1)) {
    if (s <= ce + 1) ce = Math.max(ce, e);
    else { total += ce - cs + 1; [cs, ce] = [s, e]; }
  }
  total += ce - cs + 1;
  return Math.round((total / 12) * 10) / 10;
}

/** "Go (learning)", "Rust (basic)": skills the CV says it is only starting do not count as matches. */
export function withoutLearning(text: string): string {
  // Only the skill right before the bracket: "Python / TypeScript / Go (basic)" keeps Python and TypeScript;
  // a skill of two or three words ("React Native", "Ruby on Rails") is dropped whole.
  return text.replace(/((?:[\p{L}\p{N}.+#]+\s){0,2}[\p{L}\p{N}.+#]+)\s*\((?:learning|basic|beginner|familiar(?:ity)?|exposure|some|currently learning)\)/giu, (_m, words: string) => {
    const w = words.split(/\s+/);
    for (let n = Math.min(3, w.length); n >= 2; n--) {
      if (SKILL_NAMES.has(canonicalSkill(w.slice(-n).join(" ")))) return ` ${w.slice(0, -n).join(" ")} `;
    }
    return ` ${w.slice(0, -1).join(" ")} `;
  });
}

export function parseCv(text: string): CvFacts {
  const skills = findSkills(withoutLearning(text));
  // Skills the CV says it is still learning: shown as such when a posting asks for them.
  const learning = findSkills(text).filter(s => !skills.includes(s));
  return { text, skills, schools: findSchools(text), years: yearsOfExperience(text), learning };
}
