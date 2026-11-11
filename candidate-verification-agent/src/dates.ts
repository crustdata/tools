/**
 * The date check used by the quick screen: a full-time job that overlaps full-time study by more than six months.
 * (The full check runs the same test on Crustdata's side and reports it in its own flags, so this one is not used
 * there.)
 *
 * It is careful on purpose, because a wrong flag sends a real person to the top of the review list:
 * - Only degrees that are usually full-time count: bachelor's and master's. MBAs (often part-time), executive, part-time, online,
 *   evening and weekend programmes, PhDs, certificates and accelerators do not.
 * - A school needs both a start and an end year. Study runs from 1 September of the start year to 1 June of the
 *   end year.
 * - Jobs that students hold alongside study do not count: internships, part-time, teaching or research
 *   assistant, freelance, contract, volunteer, founder, advisor and the like, or an employment type other than
 *   full-time when one is given.
 * - A job needs a start date. A job with no end date runs to today.
 */

import type { PersonData, Position, School } from "./crustdata.js";

const FULL_TIME_DEGREE = /(?<![\p{L}\p{N}])(bachelor|master|b\.?\s?s\.?c?|b\.?\s?a|b\.?\s?e(ng)?|b\.?\s?tech|m\.?\s?s\.?c?|m\.?\s?a|m\.?\s?eng|m\.?\s?tech|bba|llb|llm|undergraduate|licenciatura|laurea|diplom)(?![\p{L}\p{N}])/iu;
const NOT_FULL_TIME_DEGREE = /(?<![\p{L}\p{N}])(mba|business administration|executive|part[- ]?time|online|evening|weekend|distance|certificate|certification|diploma in|course|bootcamp|batch|nanodegree|exchange|summer|phd|ph\.d|doctor|doctorate|high school|secondary|alternance|apprentissage|dual|berufsbegleitend|work[- ]study|co-?op|cooperative|sandwich|apprenticeship|duales?|dual\p{L}*|fernstudium|teilzeit|abendstudium|semipresencial|a distancia)(?![\p{L}\p{N}])/iu;
const STUDENT_FRIENDLY_JOB = /(?<![\p{L}\p{N}])(intern|internship|trainee|apprentic[\p{L}\p{N}_]*|part[- ]?time|student|working student|teaching|research assistant|graduate assistant|t\.?a\.?|r\.?a\.?|tutor|freelanc[\p{L}\p{N}_]*|contract[\p{L}\p{N}_]*|consultant|volunteer|ambassador|founder|co-?founder|owner|co-?op|fellow|fellowship|board|advisor|adviser|mentor|self[- ]?employed|scholar|campus|seasonal|temporary|werkstudent[\p{L}\p{N}_]*|praktik[\p{L}\p{N}_]*|stagiaire|stage|becari[oa]|estagi[\p{L}\p{N}_]*|pr[aá]cticas|tirocin[\p{L}\p{N}_]*|associate|sales associate|cashier|barista|server|waiter|waitress|crew|lab assistant|lab|instructor|demonstrator|resident assistant|grader|peer|alternan[\p{L}\p{N}_]*|apprenti[\p{L}\p{N}_]*|hilfskraft|studentische[\p{L}\p{N}_]*|stagiair[\p{L}\p{N}_]*|pasant[\p{L}\p{N}_]*|stagist[\p{L}\p{N}_]*|auszubildend[\p{L}\p{N}_]*|azubi|doktorand[\p{L}\p{N}_]*|phd|doctoral|実習\p{L}*|实习\p{L}*|インターン\p{L}*|work[- ]?study|hiwi|bolsista|monitor|asistente de investigaci[oó]n|assistente de pesquisa|medio tiempo|meio per[ií]odo|teilzeit)(?![\p{L}\p{N}])/iu;

const MONTH = 30.44 * 24 * 3600 * 1000;

export type DateConflict = { job: string; school: string; months: number; text: string };

const year = (iso?: string | null): number | undefined => (iso && /^\d{4}/.test(iso) ? Number(iso.slice(0, 4)) : undefined);

function fullTimeStudy(s: School): { from: number; to: number } | undefined {
  const degree = `${s.degree ?? ""} ${s.field_of_study ?? ""}`;
  if (!s.start_year || !s.end_year || s.end_year < s.start_year) return undefined;
  if (!FULL_TIME_DEGREE.test(s.degree ?? "") || NOT_FULL_TIME_DEGREE.test(degree)) return undefined;
  const from = Date.UTC(s.start_year, 8, 1);
  const to = Date.UTC(s.end_year, 5, 1);
  return to > from ? { from, to } : undefined;
}

function fullTimeJob(p: Position, now: number, current: boolean): { from: number; to: number } | undefined {
  if (!p.start_date) return undefined;
  // A past job with no end date has an unknown length: never assume it ran to today.
  if (!current && !p.end_date) return undefined;
  if (STUDENT_FRIENDLY_JOB.test(p.title ?? "")) return undefined;
  if (p.employment_type && !/full/i.test(p.employment_type)) return undefined;
  const from = Date.parse(p.start_date);
  const to = p.end_date ? Date.parse(p.end_date) : now;
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : undefined;
}

const span = (from?: number, to?: number | string) => (from ? `${from} to ${to ?? "now"}` : "");

/** Pure: every full-time job that overlaps full-time study by more than six months. */
export function dateConflicts(person: PersonData, now = Date.now()): DateConflict[] {
  const jobs = [
    ...(person.experience?.employment_details?.current ?? []).map(p => ({ p, current: true })),
    ...(person.experience?.employment_details?.past ?? []).map(p => ({ p, current: false })),
  ];
  const schools = person.education?.schools ?? [];
  const out: DateConflict[] = [];
  for (const s of schools) {
    const study = fullTimeStudy(s);
    if (!study) continue;
    for (const { p, current } of jobs) {
      const job = fullTimeJob(p, now, current);
      if (!job) continue;
      const months = Math.floor((Math.min(job.to, study.to) - Math.max(job.from, study.from)) / MONTH);
      if (months <= 6) continue;
      const jobLabel = [p.title, p.name && `at ${p.name}`].filter(Boolean).join(" ") || "A job";
      const schoolLabel = [s.degree, s.school && `at ${s.school}`].filter(Boolean).join(" ") || "a degree";
      out.push({
        job: jobLabel,
        school: schoolLabel,
        months,
        text: `${jobLabel} (${span(year(p.start_date), year(p.end_date))}) overlaps ${schoolLabel} (${span(s.start_year ?? undefined, s.end_year ?? undefined)}) by about ${months} months`,
      });
    }
  }
  return out.sort((a, b) => b.months - a.months);
}
