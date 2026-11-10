/**
 * Leaders: who counts (founders and C-level) and what a change on their profile means. Pure functions, no I/O.
 *
 * The person search returns anyone whose title contains "chief", "founder", "CEO"... so "Chief of Staff", "Executive
 * Assistant to the CEO" and "Founding Engineer" come back too. `leaderRole` keeps the real leaders only.
 */

import type { FoundPerson } from "./crustdata.js";

export type LeaderRole = "founder" | "ceo" | "c_level" | "president";

const NOT_A_LEADER = /\b(chief of staff|assistant|associate|office of the|to the (ceo|cto|coo|cfo|founders?|chief)|deputy|intern|in residence|eir|founding (engineer|designer|member|team|product|account|ae|sdr|recruiter|marketer|ops|operations|scientist|researcher|pm)|founders?'?s? (office|associate|fellow))\b/i;
/** "former CEO", "ex-Stripe": a past role named inside a title, removed before the title is read. */
const PAST_PHRASE = /(\b(former|formerly|previously)\s+|\bex-\s*|\bex\s+)[\w&.@-]+(\s+(at|of|@)\s+[\w&.-]+)?/gi;
/** Side roles: a "Chief Advisor" or "Board Member, former CEO" is not running the company. Founders stay founders. */
const SIDE_TITLE = /\b(advisor|adviser|board|investor|mentor|volunteer)\b/i;
const FOUNDER = /\b(co-?\s?founder|founder|co-?fondateur|fondateur|fondatrice|co-?fundador|fundador|fundadora|mitgründer|gründer|gründerin|founding partner)\b|创始人|联合创始人/i;
const CEO = /\b(CEO|PDG|geschäftsführer|geschäftsführerin|directeur général|directrice générale|director general|directora general)\b|\bchief executive\b|首席执行官/i;
const C_LEVEL_WORDS = /\bchief\b[\w\s&,/-]{0,40}?\bofficer\b/i;
const C_LEVEL_ABBR = /\b(CTO|COO|CFO|CPO|CRO|CMO|CIO|CISO|CSO|CCO|CDO|CHRO|CAIO|CBO|CXO)\b/;
const PRESIDENT = /\bpresident\b/i;
const VICE = /\b(vice[- ]?president|vp|svp|evp|avp)\b/i;

/** The leader role a title stands for, or undefined when it is not a founder or C-level title. */
export function leaderRole(title: string | undefined | null): LeaderRole | undefined {
  const t = String(title ?? "").replace(PAST_PHRASE, " ").trim();
  if (!t || NOT_A_LEADER.test(t)) return undefined;
  if (FOUNDER.test(t)) return "founder";
  if (SIDE_TITLE.test(t)) return undefined;
  if (CEO.test(t)) return "ceo";
  if (C_LEVEL_WORDS.test(t) || C_LEVEL_ABBR.test(t)) return "c_level";
  if (PRESIDENT.test(t) && !VICE.test(t)) return "president";
  return undefined;
}

const RANK: Record<LeaderRole, number> = { founder: 0, ceo: 1, c_level: 2, president: 3 };

/** The leaders to watch at one company: founders first, then the CEO, other C-level, presidents. Capped at `max`. */
export function pickLeaders(people: FoundPerson[], max: number): (FoundPerson & { role: LeaderRole })[] {
  const seen = new Set<string>();
  return people
    .flatMap(p => { const role = leaderRole(p.title); return role && p.profileUrl ? [{ ...p, role }] : []; })
    .filter(p => { const k = p.profileUrl!.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => RANK[a.role] - RANK[b.role] || String(a.startDate ?? "9").localeCompare(String(b.startDate ?? "9")))
    .slice(0, max);
}

export type Leader = {
  profileUrl: string;
  personId?: number;
  name: string;
  title: string;
  role: LeaderRole;
  domain: string;
  company: string;
  companyId?: number;
};

export type Position = {
  title?: string;
  name?: string;
  start_date?: string | null;
  end_date?: string | null;
  is_default?: boolean;
  crustdata_company_id?: number;
  company_website_domain?: string;
};

export type LeaderEvent =
  /** No current role at the company any more. `newTitle`/`newCompany`: their main role now, when one is listed. */
  | { kind: "left"; newTitle?: string; newCompany?: string; endDate?: string }
  /** The CEO is still at the company but no longer CEO (chair, president, another title): usually a new CEO. */
  | { kind: "ceo_changed"; newTitle: string; elsewhereTitle?: string; elsewhereCompany?: string }
  /** A leader recorded as gone lists a current role at the company again. */
  | { kind: "returned"; newTitle?: string }
  /** Still listed at the company, but as an advisor, board member or similar. */
  | { kind: "stepped_back"; newTitle: string }
  /** A new title at the same company (promotion, new remit). */
  | { kind: "role"; newTitle: string }
  /** Still at the company, but now lists a new main role somewhere else. */
  | { kind: "side_role"; newTitle?: string; newCompany?: string };

/** Advisor, board and similar titles: a leader moving into one has stepped back from running the company. */
export const STEPPED_BACK = /\b(advisor|adviser|advisory|board (member|director|observer)|member of the board|emeritus|part[- ]time|consultant|venture partner|investor|chair|chairman|chairwoman|chairperson)\b/i;
const SIDE_ROLE = /\b(advisor|adviser|advisory|board|angel investor|investor|mentor|volunteer|ambassador|trustee|scout|venture partner|lp)\b/i;

const norm = (s?: string | null) => String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\b(inc|llc|ltd|gmbh|co|corp|corporation|limited|hq)\b/g, "").replace(/\s+/g, " ").trim();
/** A title as a sorted set of words: "CEO & Co-Founder" and "Co-founder and CEO" are the same title. */
const C_SUITE: [RegExp, string][] = [[/chief executive officer/g, "ceo"], [/chief technology officer/g, "cto"], [/chief operating officer/g, "coo"], [/chief financial officer/g, "cfo"], [/chief product officer/g, "cpo"], [/chief revenue officer/g, "cro"], [/chief marketing officer/g, "cmo"]];
const normTitle = (s?: string | null) => [...new Set(C_SUITE.reduce((t, [re, abbr]) => t.replace(re, abbr), String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")).replace(/\bco founder\b/g, "cofounder").split(" ").filter(w => w && !["and", "the", "of", "at"].includes(w)))].sort().join(" ");
const host = (s?: string) => String(s ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

export const sameTitle = (a?: string | null, b?: string | null): boolean => normTitle(a) === normTitle(b);
const isCeoTitle = (t?: string | null) => CEO.test(String(t ?? ""));

export function atCompany(p: Position, l: Leader): boolean {
  if (l.companyId && p.crustdata_company_id) return p.crustdata_company_id === l.companyId;
  if (p.company_website_domain && host(p.company_website_domain) === l.domain) return true;
  if (!p.name) return false;
  // A role with no company id yet: same name, or a renamed company that keeps the name ("Acme" to "Acme AI").
  const a = norm(p.name), b = norm(l.company);
  return a === b || (b.length >= 3 && (a.startsWith(`${b} `) || b.startsWith(`${a} `)));
}

const positions = (v: unknown): Position[] => (Array.isArray(v) ? v.filter(p => p && typeof p === "object") : []);

/** A "current" position whose end date has passed. */
const ended = (p: Position, now: Date) => Boolean(p.end_date) && new Date(p.end_date!).getTime() < now.getTime();

/** Their main role: the flagged one, else the most recent start that is not a side role. */
function mainOf(list: Position[]): Position | undefined {
  return list.find(p => p.is_default) ?? [...list].filter(p => !SIDE_ROLE.test(p.title ?? "")).sort((a, b) => String(b.start_date ?? "").localeCompare(String(a.start_date ?? "")))[0] ?? list[0];
}

/**
 * What a person watch record says about a leader of a portfolio company. Undefined when nothing that matters changed
 * (a profile edit, a title spelled differently, a side role) or the record is unreadable.
 */
export function leaderEvent(record: any, leader: Leader & { status?: string; addedAt?: string }, now = new Date()): LeaderEvent | undefined {
  const exp = record?.experience?.employment_details;
  // Current roles must be a list: a record without one is half loaded, not a departure.
  if (!exp || !Array.isArray(exp.current)) return undefined;
  const current = positions(exp.current).filter(p => !ended(p, now));
  const past = [...positions(exp.past), ...positions(exp.current).filter(p => ended(p, now))];
  const here = current.filter(p => atCompany(p, leader));

  if (leader.status === "left") return here.length ? { kind: "returned", newTitle: (here.find(p => p.is_default) ?? here[0]).title } : undefined;

  if (!here.length) {
    // A role elsewhere counts as evidence only if it is new: it started after this leader was first watched (with a
    // month of slack). Serial founders and angels keep old roles listed as current; those prove nothing.
    const since = leader.addedAt ? new Date(new Date(leader.addedAt).getTime() - 31 * 86_400_000).toISOString().slice(0, 10) : undefined;
    // Their main role (flagged), or a role that started after they were first watched, counts; an old side job does not.
    // With a start date, it must have started after they were first watched; with none, only their main role counts.
    const newRoles = current.filter(p => !SIDE_ROLE.test(p.title ?? "") && (since !== undefined && p.start_date ? p.start_date.slice(0, 10) >= since : Boolean(p.is_default)));
    const elsewhere = mainOf(newRoles) ?? undefined;
    const endedHere = past.filter(p => atCompany(p, leader) && p.end_date).sort((a, b) => String(b.end_date ?? "").localeCompare(String(a.end_date ?? "")))[0];
    // Crustdata notes a person's current roles can go missing for one run and come back. Only call it a departure
    // with evidence: the role at the company now has an end date, or they list a new main role somewhere else.
    if (!endedHere && !elsewhere) return undefined;
    return { kind: "left", newTitle: elsewhere?.title, newCompany: elsewhere?.name, endDate: endedHere?.end_date ?? undefined };
  }

  const mine = here.find(p => p.is_default) ?? here.find(p => !STEPPED_BACK.test(p.title ?? "")) ?? here[0];
  const title = mine.title ?? "";
  // The CEO is still here but no longer CEO: that usually means a new CEO.
  if (title && isCeoTitle(leader.title) && !here.some(p => isCeoTitle(p.title))) {
    const away = current.find(p => !atCompany(p, leader) && !SIDE_ROLE.test(p.title ?? "") && (p.is_default || isCeoTitle(p.title)));
    return { kind: "ceo_changed", newTitle: title, elsewhereTitle: away?.title, elsewhereCompany: away?.name };
  }
  if (title && STEPPED_BACK.test(title) && !STEPPED_BACK.test(leader.title) && !here.some(p => !STEPPED_BACK.test(p.title ?? ""))) return { kind: "stepped_back", newTitle: title };
  if (title && !sameTitle(title, leader.title) && !here.some(p => sameTitle(p.title, leader.title))) return { kind: "role", newTitle: title };

  // Still here with the same title. A new main role elsewhere (not an advisor seat) is worth a note.
  const other = current.filter(p => !atCompany(p, leader) && !SIDE_ROLE.test(p.title ?? ""));
  const newMain = other.find(p => p.is_default) && !mine.is_default ? other.find(p => p.is_default) : undefined;
  if (newMain) return { kind: "side_role", newTitle: newMain.title, newCompany: newMain.name };
  return undefined;
}
