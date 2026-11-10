/**
 * Draft notes, one per person, about 200 characters and never over 300, so they fit any message box.
 * Templates only: no AI. The agent never sends anything; you read, edit and send. With Claude Code, the job-hunt
 * skill writes notes from your CV and the posting instead (see .claude/skills/job-hunt).
 *
 * A note never claims more than the CV shows: it names skills the posting asks for that your CV has, and a number
 * of years only when you set "yearsExperience" yourself in profile.json. An alumni note names your own school.
 *
 * Change the wording in TEMPLATES. Placeholders: {first} {role} {company} {experience} {school}.
 */

import type { Job } from "./jobs.js";
import { PRACTICES } from "./skills.js";
import type { Kind, Person } from "./people.js";

export const NOTE_LIMIT = 300;

export const TEMPLATES: Record<Kind, string> = {
  recruiter: "Hi {first}, I'm applying for the {role} role at {company}.{experience} Who is the best person to talk to about it? Thank you!",
  manager: "Hi {first}, I saw the {role} opening at {company}.{experience} I'd value a few minutes to hear what the team needs most. Thank you.",
  team: "Hi {first}, I'm looking at the {role} role at {company}. Would you share what the team is like? A few minutes would help a lot. Thank you.",
  alumni: "Hi {first}, I see we both went to {school}. I'm applying for the {role} role at {company} and would love to hear how you find it there. Open to a quick chat?",
};

/** First name, without a title: "Dr. Priya Patel" to "Priya". */
export const first = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(w => /\p{L}/u.test(w) && !/^(dr|mr|mrs|ms|mx|prof|sir|dame)\.?$/i.test(w));
  return (words[0] ?? "").replace(/[^\p{L}'-]/gu, "") || "there";
};

/** "University of California, Berkeley" to "UC Berkeley" style short names people use in notes. */
export function shortSchool(s: string): string {
  const m = /^University of California,\s*(.+)$/i.exec(s);
  if (m) return `UC ${m[1].replace(/\s*[-,].*$/, "")}`;
  return s.replace(/\s*[-\u2013,]\s*(School|College|Faculty|Graduate|Department) of .*$/i, "").replace(/\s+-\s+.*$/, "").trim();
}

/** " I've been working with Go and Kubernetes." Years only when you set them yourself; nothing when no skill matches. */
export function experienceLine(handYears: number | null, skills: string[]): string {
  const s = skills.filter(x => !PRACTICES.has(x)).slice(0, 2);
  const yrs = handYears !== null && handYears >= 1 ? `${Math.round(handYears)} year${Math.round(handYears) === 1 ? "" : "s"} of experience in this kind of work` : null;
  if (yrs && s.length) return ` I have ${yrs}, including ${s.join(" and ")}.`;
  if (s.length) return ` I've been working with ${s.join(" and ")}.`;
  if (yrs) return ` I have ${yrs}.`;
  return "";
}

/** The role as people say it: "Senior / Staff Software Engineer, Product (Backend-Focused)" to "Senior / Staff Software Engineer". */
export function shortRole(title: string): string {
  let t = title
    .replace(/\s*\((?:[^)]*\b(?:remote|hybrid|on-?site|onsite|contract|full[- ]time|part[- ]time|[A-Z]{2}|USA?|US only)\b[^)]*)\)\s*/gi, " ")
    .replace(/\s+[-\u2013\u2014|]\s+.*$/, "")
    .replace(/\s+/g, " ").trim();
  if (t.length > 50) t = t.replace(/\s*\(.*?\)\s*/g, " ").replace(/,\s.*$/, "").replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}...` : t || title;
}

export type Me = { handYears: number | null; matched: string[]; school: string | null };

export function draftNote(p: Person, job: Job, me: Me): string {
  // Functions as replacements, so a "$" in a name is never read as a pattern.
  const fill = (tpl: string, role: string) => tpl
    .replace("{first}", () => first(p.name))
    .replace("{role}", () => role)
    .replace("{company}", () => job.company.name)
    .replace("{experience}", () => experienceLine(me.handYears, me.matched))
    .replace("{school}", () => shortSchool(me.school ?? p.school ?? "school"));
  let note = fill(TEMPLATES[p.kind], shortRole(job.title));
  if (note.length > NOTE_LIMIT) note = fill(TEMPLATES[p.kind], shortRole(job.title).split(/\s+/).slice(-2).join(" "));
  if (note.length > NOTE_LIMIT) note = `${note.slice(0, NOTE_LIMIT - 3).trimEnd()}...`;
  return note;
}
