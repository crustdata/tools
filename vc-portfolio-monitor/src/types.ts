/** The signal model: what the rules produce and what every output (Slack, email, markdown) renders. */

/** alert: act on it. good: good news. note: worth knowing. news: weekly digest only. */
export type Severity = "alert" | "good" | "note" | "news";

export const SEVERITY_LABEL: Record<Severity, string> = { alert: "Alert", good: "Good news", note: "Note", news: "News" };
export const SEVERITY_ORDER: Severity[] = ["alert", "good", "note", "news"];

export type SignalKind =
  | "headcount_down" | "team_down" | "headcount_up"
  | "leader_left" | "leader_stepped_back" | "leader_role" | "leader_side_role" | "ceo_changed" | "leader_returned" | "leader_joined"
  | "hiring_stopped" | "hiring_jump" | "hiring_slowed" | "hiring_started"
  | "round" | "bridge_round" | "investors" | "acquisition" | "acquired" | "status"
  | "bad_news" | "legal_news" | "funding_news" | "news";

export type Signal = {
  /** Same event, same key: a signal is stored and posted once. */
  key: string;
  domain: string;
  company: string;
  kind: SignalKind;
  severity: Severity;
  /** What happened, one line, with the numbers. */
  text: string;
  /** Why it matters, one sentence, fixed per rule (no AI model). */
  why?: string;
  url?: string;
  linkLabel?: string;
  /** ISO date of the event when known (article date, round date). */
  date?: string;
};

/** Shortens text to `max` characters on a word boundary. */
export function clip(s: string, max = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 30))}…`;
}

export const isoDate = (d: Date | string | number | undefined | null): string | undefined => {
  if (d === undefined || d === null || d === "") return undefined;
  const t = new Date(d);
  return isNaN(t.getTime()) ? undefined : t.toISOString().slice(0, 10);
};

/** Ends a sentence with a full stop unless it already ends in one (also inside a closing quote or bracket). */
export const sentence = (s: string): string => (/[.!?…]["'”)]?$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** "Oct 21, 2026" from an ISO date. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "Oct 21" from an ISO date. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
