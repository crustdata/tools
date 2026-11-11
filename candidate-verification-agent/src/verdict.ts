/**
 * What a check found for one person, how it is ranked for review, and how it is said in plain words. Pure: no I/O.
 */

import type { Citation, Coverage, MatchResult, PersonData, VerifyRecord } from "./crustdata.js";
import { dateConflicts } from "./dates.js";

/** The seven verdicts the full check returns (the quick screen uses five of them), plus "not_checked". */
export const VERDICTS = {
  clearly_fabricated: { order: 1, label: "Evidence contradicts the current role", short: "Contradicted" },
  probably_fabricated: { order: 2, label: "No evidence where some was expected", short: "Probably fabricated" },
  reclassified_employment: { order: 3, label: "Real link to the company, but not the role listed", short: "Different role" },
  non_person: { order: 4, label: "Not a person's profile", short: "Not a person" },
  cannot_verify: { order: 6, label: "No usable evidence either way", short: "Cannot verify" },
  not_checked: { order: 7, label: "Not checked", short: "Not checked" },
  probably_genuine: { order: 8, label: "Evidence supports the current role", short: "Probably genuine" },
  clearly_genuine: { order: 9, label: "Independent sources confirm the current role", short: "Confirmed" },
} as const;
export type Verdict = keyof typeof VERDICTS;

/**
 * The quick screen's verdict is Crustdata's score for the whole profile, not a check of the current role with
 * evidence, so it is worded as a score.
 */
export const QUICK_LABELS: Partial<Record<Verdict, string>> = {
  clearly_fabricated: "Profile score: high risk (no reasons given)",
  probably_fabricated: "Profile score: some risk (no reasons given)",
  cannot_verify: "Profile score: no signal",
  probably_genuine: "Profile score: low risk",
  clearly_genuine: "Profile score: very low risk",
};

/**
 * Questions for the screen, never evidence: a date conflict (part-time study is often not labelled), a name that
 * differs from your file, or a high-risk, some-risk or no-signal quick-screen score (no reasons, no sources). They move a candidate up to "Ask
 * in the first call" at most, never into "Review first".
 */
const QUESTION_ORDER = 6;
/** A low score from the quick screen: above the other questions, below every finding of the full check. */
const QUICK_LOW_ORDER = 5;
/** A low-risk score from the quick screen. */
const QUICK_GOOD_ORDER = 10;

/** The review sections, in order. Orders 1 and 2 are evidence from the full check; nothing else goes there. */
export const SECTIONS = [
  { title: "Review first", from: 1, to: 2, about: "The full check found evidence against the current role, or none where some was expected" },
  { title: "Clarify in the screen", from: 3, to: 4, about: "A real link to the company but not the role listed, or a profile that is not a person" },
  { title: "Ask in the first call", from: 5, to: 6, about: "No usable evidence, a quick-screen score of high risk, some risk or no signal, dates that overlap study, or a name that differs from your file: questions, not red flags" },
  { title: "Not checked", from: 7, to: 7, about: "No verdict (not charged), or a row with nothing to check" },
  { title: "Holds up", from: 8, to: 9, about: "The full check found evidence for the current role. This does not show that the applicant owns the profile" },
  { title: "Low-risk profile score", from: 10, to: 10, about: "A low-risk score for the whole profile from the quick screen. It does not check the current role or show that the applicant owns the profile" },
] as const;
export const sectionOf = (order: number) => SECTIONS.find(s => order >= s.from && order <= s.to) ?? SECTIONS[3];

/** Plain words for the flags the check returns. */
export const FLAG_TEXT: Record<string, string> = {
  past_roles_unverified: "Older roles could not be checked; this does not lower the verdict",
  posts_unavailable: "No recent posts came back, so the coworker check could not run",
};

/** A flag with no entry in FLAG_TEXT, in words. */
function flagWords(f: string): string {
  if (/timeline|overlap|date/i.test(f)) return "Dates on the profile overlap study; ask about it in the screen (part-time study is often not labelled on a profile)";
  return f.replace(/_/g, " ");
}

export type Person = { name?: string; title?: string; company?: string; location?: string; personId?: number };

export type Result = {
  profileUrl: string;
  /** full = batch verification; quick = the profile's built-in authenticity verdict; none = no verdict. */
  check: "full" | "quick" | "none";
  checkedAt: string;
  verdict: Verdict;
  /** The verdict string as Crustdata sent it, when it is not one of the known ones. */
  rawVerdict?: string;
  confidence?: number;
  /** Quick screen only: Crustdata's trust tier, 0 (most trusted) to 9. */
  tier?: number;
  reasoning?: string;
  flags: string[];
  coverage?: Coverage;
  citations: Citation[];
  /** Quick screen only: the date check (job overlapping study). */
  dateConflicts: string[];
  person?: Person;
  /** Why there is no verdict, when there is none. */
  note?: string;
  /** Optional AI summary (with --ai). */
  aiSummary?: string;
  /** Set when the name in your file differs from the name on the profile. */
  nameMismatch?: string;
};

export const asVerdict = (v: string | null | undefined): Verdict | undefined => (v && v in VERDICTS ? (v as Verdict) : undefined);

/** Name, current role, company and location from an enrich answer. */
export function personFrom(data: PersonData | undefined): Person | undefined {
  if (!data) return undefined;
  const current = data.experience?.employment_details?.current ?? [];
  const main = current.find(p => p.is_default) ?? current[0];
  return {
    name: data.basic_profile?.name ?? undefined,
    title: main?.title ?? data.basic_profile?.current_title ?? undefined,
    company: main?.name ?? undefined,
    location: data.basic_profile?.location?.full_location ?? data.basic_profile?.location?.raw ?? undefined,
    personId: data.crustdata_person_id,
  };
}

/** The best match from an enrich answer: the first matched person. */
export const enrichedPerson = (r: MatchResult | undefined): PersonData | undefined =>
  r?.match_status === "matched" ? r.matches?.[0]?.person_data : undefined;

/** A result from the quick screen: the built-in authenticity verdict plus the date check. */
export function quickResult(profileUrl: string, enriched: PersonData | undefined, now = Date.now()): Result {
  const base = { profileUrl, checkedAt: new Date(now).toISOString(), flags: [], citations: [] };
  if (!enriched) return { ...base, check: "none", verdict: "not_checked", dateConflicts: [], note: "Crustdata has no profile at this URL (check the URL; nothing was charged)" };
  const auth = enriched.assessment?.authenticity;
  const verdict = asVerdict(auth?.verdict);
  const conflicts = dateConflicts(enriched, now).map(c => c.text);
  return {
    ...base,
    check: verdict ? "quick" : "none",
    verdict: verdict ?? "not_checked",
    rawVerdict: auth?.verdict && !verdict ? auth.verdict : undefined,
    tier: typeof auth?.tier === "number" ? auth.tier : undefined,
    dateConflicts: conflicts,
    person: personFrom(enriched),
    note: verdict ? undefined : enriched.assessment ? "The profile has no authenticity score yet" : "This key cannot read the profile score (the assessment field); only the date check ran",
  };
}

/** A result from the full check. `enriched` adds name and role; a missing record means no verdict (free). */
export function fullResult(profileUrl: string, record: VerifyRecord | undefined, enriched: PersonData | undefined, now = Date.now()): Result {
  const person = personFrom(enriched);
  const base = { profileUrl, checkedAt: new Date(now).toISOString(), citations: [], flags: [], dateConflicts: [], person };
  const data = record?.data;
  if (!data) return { ...base, check: "none", verdict: "not_checked", note: "The full check returned no verdict for this profile (not charged). It may be private, removed, or not resolvable" };
  const verdict = asVerdict(data.verdict);
  return {
    ...base,
    check: "full",
    verdict: verdict ?? "not_checked",
    rawVerdict: verdict ? undefined : data.verdict,
    confidence: typeof data.confidence === "number" ? data.confidence : undefined,
    reasoning: typeof data.reasoning === "string" ? data.reasoning : undefined,
    flags: [...new Set([...(Array.isArray(data.flags) ? data.flags : []), ...(Array.isArray(data.coverage?.flags) ? data.coverage!.flags! : [])].filter(f => typeof f === "string"))],
    coverage: data.coverage,
    // One entry per source (the check can cite the same page twice).
    citations: (Array.isArray(data.citations) ? data.citations : []).filter((c, i, all) => c && typeof c.url === "string" && all.findIndex(o => o?.url === c.url) === i),
  };
}

/** Review order: 1 is reviewed first. See SECTIONS. */
export function reviewOrder(r: Result): number {
  // A verdict this version does not know was still billed: show it near the top, to be read.
  if (r.rawVerdict && r.check === "full") return QUICK_LOW_ORDER;
  let order: number = VERDICTS[r.verdict].order;
  // The quick screen's score has no reasons or sources: it never puts anyone in "Review first".
  // "No evidence where some was expected" while the coworker check could not run: part of the expected evidence was
  // never looked at, so it is a question for the screen, not Review first.
  if (r.check === "full" && r.verdict === "probably_fabricated" && (r.flags.includes("posts_unavailable") || r.coverage?.social_ran === false)) order = 3;
  if (r.check === "quick" && order <= 2) order = QUICK_LOW_ORDER;
  if (r.check === "quick" && order <= 4) order = QUESTION_ORDER;
  // A low-risk quick score is not evidence for the role: it gets its own group, after the full check's "Holds up".
  if (r.check === "quick" && order >= 8) order = QUICK_GOOD_ORDER;
  if (r.dateConflicts.length) order = Math.min(order, QUESTION_ORDER);
  // A name that differs may mean the verdict is about someone else (a typo in the URL, a borrowed profile): the
  // question comes first, whatever the verdict says.
  if (r.nameMismatch) order = QUESTION_ORDER;
  return order;
}

/**
 * Sorts results for review: by review order, then the original file order. Confidence is not used: Crustdata
 * documents it as a fixed band per verdict, not as a ranking inside one.
 */
export function sortForReview<T extends { result: Result; line: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => reviewOrder(a.result) - reviewOrder(b.result) || a.line - b.line);
}

const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "mx", "prof", "sir", "phd", "md", "mba", "jr", "sr", "ii", "iii", "iv", "esq"]);

/** Name words: "Last, First" turned around, accents and case folded, titles and suffixes dropped. */
function nameWords(name: string): string[] {
  const parts = name.split(",");
  const ordered = parts.length === 2 && parts[1].trim() ? `${parts[1]} ${parts[0]}` : name;
  return ordered.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/).filter(w => w && !TITLES.has(w));
}
const latinOnly = (s: string) => !/[^\p{Script=Latin}\p{N}\s\p{P}\p{M}]/u.test(s.normalize("NFKD"));

/**
 * Pure: whether the name in your file and the name on the profile look like different people. Word order does not
 * matter ("Wang Xiaoming" and "Xiaoming Wang" agree), nor do accents, case, titles, suffixes, "Last, First", hyphens
 * or spaces inside a name ("Al-Rashid" and "Alrashid" agree). The names must share a word of two or more letters,
 * and every other word of the shorter name must match a word of the other by its first letter (so an initial
 * matches: "Rahul K" and "Rahul Kumar" agree; "Sam Kumar" and "Sam Testcase" do not). Names written in different
 * alphabets are not compared. An empty side is no mismatch.
 */
export function namesDiffer(fileName: string | undefined, profileName: string | undefined): boolean {
  if (!fileName?.trim() || !profileName?.trim()) return false;
  if (latinOnly(fileName) !== latinOnly(profileName)) return false;
  const a = nameWords(fileName), b = nameWords(profileName);
  if (!a.length || !b.length) return false;
  // Words and joined neighbours ("al" + "rashid" = "alrashid"), each remembering which words it covers.
  const forms = (w: string[]) => [...w.map((x, i) => ({ text: x, covers: [i] })), ...w.slice(1).map((x, i) => ({ text: w[i] + x, covers: [i, i + 1] }))];
  const fa = forms(a), fb = forms(b);
  const usedA = new Set<number>(), usedB = new Set<number>();
  for (const x of fa) {
    if (x.text.length < 2 || x.covers.some(i => usedA.has(i))) continue;
    const y = fb.find(f => f.text === x.text && !f.covers.some(i => usedB.has(i)));
    if (y) { x.covers.forEach(i => usedA.add(i)); y.covers.forEach(i => usedB.add(i)); }
  }
  if (!usedA.size) return true;
  const restA = a.filter((_, i) => !usedA.has(i)), restB = b.filter((_, i) => !usedB.has(i));
  const [short, long] = a.length <= b.length ? [restA, [...restB]] : [restB, [...restA]];
  for (const w of short) {
    const k = long.findIndex(x => x[0] === w[0]);
    if (k === -1) return true;
    long.splice(k, 1);
  }
  return false;
}

/** The note for a name that differs: worded as a question, since it is often a nickname, a new name or a spelling. */
export const nameNote = (profileName: string, fileName: string, line: number): string =>
  `The name on the profile ("${profileName}") is not the name in your file ("${fileName}"). This can be a nickname, a name change, another spelling or alphabet, or the wrong profile: confirm the profile URL in line ${line} before reading this verdict`;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const firstSentence = (s: string) => /^.*?[.!?](?=\s|$)/.exec(s.trim())?.[0] ?? s.trim();

/** The `verdict` column: quick-screen rows get score names, so a filter on clearly_fabricated never picks up a bare score. */
export const QUICK_CODES: Partial<Record<Verdict, string>> = {
  clearly_fabricated: "quick_high_risk", probably_fabricated: "quick_some_risk", cannot_verify: "quick_no_signal",
  probably_genuine: "quick_low_risk", clearly_genuine: "quick_very_low_risk",
};
export const verdictCode = (r: Result): string => r.rawVerdict ?? ((r.check === "quick" && QUICK_CODES[r.verdict]) || r.verdict);

/** The label for a verdict, worded for the quick screen when `quick`. */
export const labelFor = (v: Verdict, quick: boolean): string => (quick && QUICK_LABELS[v]) || VERDICTS[v].label;

/** The verdict in words, with the date conflict or name difference when there is one. */
export function verdictLabel(r: Result): string {
  const label: string = r.rawVerdict ? `New verdict "${r.rawVerdict}": read the reasoning` : (r.check === "quick" && QUICK_LABELS[r.verdict]) || VERDICTS[r.verdict].label;
  return [label, r.dateConflicts.length && "dates overlap study", r.nameMismatch && "name differs from your file"].filter(Boolean).join("; ");
}

/** Plain words for every flag. "No posts" only matters where the coworker check could have changed the verdict. */
export const flagTexts = (r: Result): string[] => r.flags
  .filter(f => f !== "posts_unavailable" || ["cannot_verify", "probably_fabricated", "probably_genuine"].includes(r.verdict))
  .map(f => (f === "posts_unavailable" && r.verdict === "cannot_verify" ? `${FLAG_TEXT[f]} (read "cannot verify" as unchecked, not suspicious)` : FLAG_TEXT[f] ?? flagWords(f)));

/** One line per candidate, without AI: the verdict, the strongest reason, and what the check could see. */
export function summaryLine(r: Result): string {
  if (r.check === "none") return clip(`${verdictLabel(r)}. ${r.note ?? ""}${r.dateConflicts.length ? `. ${r.dateConflicts[0]}` : ""}.`.replace(/\.\.$/, "."), 400);
  const parts: string[] = [verdictLabel(r)];
  if (r.check === "full") {
    if (r.reasoning) parts.push(clip(firstSentence(r.reasoning), 240));
    const hits = r.coverage?.coworker_hits;
    if (typeof hits === "number" && r.coverage?.social_ran) parts.push(hits ? `${hits} people at the claimed employer engaged with recent posts` : "No coworker engagement found (this alone is not a warning sign)");
    if (r.flags.includes("posts_unavailable") && r.verdict === "cannot_verify") parts.push("No recent posts came back, so treat this as unchecked");
    if (r.flags.includes("past_roles_unverified")) parts.push("Older roles not checked (does not lower the verdict)");
  } else {
    parts.push(`Quick screen, a score for the whole profile with no reasons or sources${r.tier !== undefined ? `; trust tier ${r.tier} of 9 (0 is most trusted)` : ""}`);
    if (r.dateConflicts.length) parts.push(`${r.dateConflicts[0]} (a question for the screen: part-time study is often not labelled)`);
  }
  if (r.nameMismatch) parts.push(r.nameMismatch);
  return clip(parts.map(p => p.replace(/\.$/, "")).join(". ") + ".", 600);
}

/** Every reason, for the reasons column. */
export function reasonsText(r: Result): string {
  const parts = [
    r.reasoning,
    ...r.dateConflicts.map(c => `Dates: ${c} (a question for the screen: part-time study is often not labelled).`),
    r.nameMismatch && `${r.nameMismatch}.`,
    r.check === "quick" ? "Quick screen: Crustdata's authenticity score for the whole profile, with no reasons or sources; it does not check the current role. Do not use it alone to doubt or clear anyone. The full check (verification add-on) gives reasons and sources." : undefined,
    r.note && `${r.note}.`,
  ].filter(Boolean) as string[];
  return clip(parts.join(" "), 3000);
}

/** The cited sources, as "title (url)". */
export const sourcesText = (r: Result): string =>
  r.citations.map(c => (c.title ? `${clip(c.title, 120)} (${c.url})` : c.url)).join(" | ");
