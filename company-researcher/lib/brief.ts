// The written brief on top of the research: what the company is, what changed lately, three questions to ask.
// It is built from the data alone with a template, so every number in it points at a field and it needs nothing but a
// Crustdata key. Changes are ranked by how useful they are as an opener: layoffs, leadership exits and new leaders,
// fresh funding and acquisitions first; growth numbers after.

import type { Brief, Company, Hiring, People } from "./types";
import { daysBetween, int, money, monthYear, pct, trend } from "./format";

type Facts = { company: Company; people: People; hiring: Hiring | null };

const within = (d: string | null | undefined, days: number, now: Date) => !!d && daysBetween(d, now) <= days;

// The company's own description, cut at a sentence end: one sentence, or two when the first is short.
function ownWords(s: string | null): string | null {
  if (!s) return null;
  s = s.replace(/\p{Extended_Pictographic}\uFE0F?/gu, "").replace(/\s+\|\s+/g, ". ").replace(/\s+/g, " ").trim();
  const sentences = s.match(/[^.!?]+[.!?]+(\s|$)/g)?.map(x => x.trim()) ?? [s.trim()];
  let out = sentences[0];
  if (out.length < 70 && sentences[1] && (out + " " + sentences[1]).length <= 240) out += " " + sentences[1];
  return out.length <= 240 ? out : null;
}

// Departments worth a sentence: the six largest business functions with at least 10 people.
const NOT_A_TEAM = new Set(["Entrepreneurship", "Education", "Military and Protective Services", "Community and Social Services", "Healthcare Services", "Real Estate"]);
function movers(c: Company) {
  const depts = (c.headcount?.byDepartment ?? []).filter(d => !NOT_A_TEAM.has(d.name)).slice(0, 6)
    .filter(d => d.count >= 10 && d.growth12m !== null);
  const up = [...depts].sort((a, b) => b.growth12m! - a.growth12m!)[0];
  const down = [...depts].sort((a, b) => a.growth12m! - b.growth12m!)[0];
  return { up: up && up.growth12m! >= 20 ? up : null, down: down && down.growth12m! <= -15 ? down : null };
}

type Signal = { rank: number; change: string; question?: string };

// "a Series F", "a seed round", "a post-IPO equity round"
const roundPhrase = (type: string) => /^Series [A-Z]$/.test(type) ? `a ${type}` : `a ${type.toLowerCase()}${/round$/i.test(type) ? "" : " round"}`;

export function buildBrief({ company: c, people, hiring }: Facts, now = new Date()): Brief {
  const h = c.headcount;
  const f = c.funding;
  const asOf = h?.asOf ? ` as of ${monthYear(h.asOf)}` : "";

  // ---- what it is ----
  const what: string[] = [];
  const own = ownWords(c.description);
  const kind = c.industry ? `a ${c.industry.toLowerCase()} company` : "a company";
  const where = c.headquarters ? ` based in ${c.headquarters.split(",")[0]}` : "";
  const ownMentionsFounding = !!own && /\bfounded\b/i.test(own);
  const status = c.ownership === "public" ? ", publicly traded" : c.ownership === "acquired" && f?.acquiredBy.length ? `, owned by ${f.acquiredBy[0]}` : "";
  what.push(`${c.name} (${c.domain}) is ${kind}${where}${c.founded && !ownMentionsFounding ? `, founded ${c.founded}` : ""}${status}.`);
  if (own) what.push(`In its own words: "${own}"`);
  if (h?.total) {
    const g = h.growthPercent;
    what.push(`${int(h.total)} people${asOf}, ${trend(g.m12)} in 12 months${g.m24 !== null ? ` and ${trend(g.m24)} in 24 months` : ""}.`);
    const depts = (h.byDepartment ?? []).filter(d => d.share !== null && !NOT_A_TEAM.has(d.name)).slice(0, 2);
    if (depts.length) what.push(`${depts[0].name} is ${Math.round(depts[0].share!)}% of staff${depts[1] ? `, ${depts[1].name} ${Math.round(depts[1].share!)}%` : ""}.`);
  }
  if (hiring?.postingsLast90d !== null && hiring?.postingsLast90d !== undefined) {
    const vs = hiring.changePercent !== null ? `, ${trend(hiring.changePercent)} on the 90 days before` : "";
    what.push(`${int(hiring.postingsLast90d)} job postings in the last 90 days${vs}.`);
  }
  // Public and acquired companies are not described by an old venture round.
  if (c.ownership === "private" && f?.lastRound?.type) {
    const when = f.lastRound.date ? ` in ${monthYear(f.lastRound.date)}` : "";
    const amt = f.lastRound.amountUsd ? ` (${money(f.lastRound.amountUsd)})` : "";
    what.push(`Last raised ${roundPhrase(f.lastRound.type)}${amt}${when}${f.totalUsd ? `. Total raised ${money(f.totalUsd)}` : ""}.`);
  }

  // ---- signals, ranked ----
  const signals: Signal[] = [];
  const news = (kind: string) => c.newsSignals.find(s => s.kind === kind);
  const layoffs = news("layoffs");
  if (layoffs) signals.push({ rank: 0, change: `In the news: "${layoffs.title}" (${monthYear(layoffs.date)}).`, question: "How is the team changing after the recent cuts, and what is still a priority?" });
  const exit = news("exec_exit");
  if (exit) signals.push({ rank: 1, change: `Leadership change in the news: "${exit.title}" (${monthYear(exit.date)}).`, question: "With the leadership change, which plans are moving and which are on hold?" });
  if (people.executiveStarts12m >= 3) {
    signals.push({ rank: 2, change: `${people.executiveStarts12m} executives started in the last 12 months.`, question: `${people.executiveStarts12m} of your executives are new this year. Which decisions is the new team revisiting?` });
  }
  const join = people.recentJoins.find(p => /\b(chief|ceo|cto|cfo|coo|cmo|cpo|cro|vp|vice president|head|president)\b/i.test(p.title)) ?? people.recentJoins[0];
  for (const p of people.recentJoins.slice(0, 3)) {
    signals.push({ rank: p === join ? 3 : 6, change: `${p.name} started as ${p.title} in ${monthYear(p.startDate)}.`,
      question: p === join ? `${p.name} joined as ${p.title} in ${monthYear(p.startDate)}. What are they changing first?` : undefined });
  }
  if (c.ownership === "private" && f?.lastRound?.date && within(f.lastRound.date, 365, now)) {
    const lead = f.lastRound.leadInvestors.length ? `, led by ${f.lastRound.leadInvestors.slice(0, 2).join(", ")}` : "";
    signals.push({ rank: 3, change: `Raised ${roundPhrase(f.lastRound.type!)}${f.lastRound.amountUsd ? ` of ${money(f.lastRound.amountUsd)}` : ""} in ${monthYear(f.lastRound.date)}${lead}.`,
      question: `You raised ${roundPhrase(f.lastRound.type!)} in ${monthYear(f.lastRound.date)}. Where is that money going first?` });
  } else if (news("funding")) {
    const s = news("funding")!;
    signals.push({ rank: 4, change: `Funding in the news: "${s.title}" (${monthYear(s.date)}).` });
  }
  const acq = (f?.acquisitions ?? []).filter(a => within(a.date, 365, now));
  if (acq.length) signals.push({ rank: 4, change: `Acquired ${acq.slice(0, 3).map(a => `${a.name} (${monthYear(a.date)})`).join(", ")}.`, question: `You acquired ${acq[0].name}. How does it fit into the product now?` });

  // A one month swing this large is more often a data correction than reality, so it is not used as a signal.
  if (h?.total && h.growthPercent.m12 !== null && !h.monthlyJumpWarning) {
    const from = h.growthAbsolute.m12 !== null ? ` (from ${int(h.total - h.growthAbsolute.m12)} to ${int(h.total)})` : "";
    const g12 = h.growthPercent.m12;
    signals.push({ rank: Math.abs(g12) >= 20 ? 5 : 8, change: `Headcount ${trend(h.growthPercent.m3)} in 3 months and ${trend(g12)} in 12 months${from}.`,
      question: g12 <= -5 ? `Your headcount is ${trend(g12)} over 12 months. Which teams are the priority now?` : undefined });
  }
  const mv = movers(c);
  if (mv.up) signals.push({ rank: 6, change: `${mv.up.name} grew ${pct(mv.up.growth12m, false)} in 12 months, now ${int(mv.up.count)} people.`,
    question: `Your ${mv.up.name.toLowerCase()} team grew ${pct(mv.up.growth12m, false)} in a year. What is it being asked to deliver?` });
  if (mv.down) signals.push({ rank: 6, change: `${mv.down.name} shrank ${pct(mv.down.growth12m, false)} in 12 months, now ${int(mv.down.count)} people.` });
  if (hiring?.postingsLast90d) {
    const top = hiring.byRoleType.find(b => b.type !== "Other");
    const prev = hiring.postingsPrev90d !== null ? `, against ${int(hiring.postingsPrev90d)} in the 90 days before` : "";
    const ch = hiring.changePercent;
    signals.push({ rank: ch !== null && Math.abs(ch) >= 30 ? 5 : 7,
      change: `${int(hiring.postingsLast90d)} job postings in the last 90 days${prev}${top ? `. Most are ${top.type.toLowerCase()} roles (${int(top.count)})` : ""}.`,
      question: ch === null ? undefined : ch <= -30 ? `Your job postings are ${trend(ch)} on the previous 90 days. Is hiring paused, or are the roles filled?`
        : ch >= 30 ? `Your job postings are ${trend(ch)} on the previous 90 days. Which roles are hardest to fill?` : undefined });
  }
  const launch = news("launch");
  if (launch) signals.push({ rank: 7, change: `Launch in the news: "${launch.title}" (${monthYear(launch.date)}).` });
  const site = c.webTraffic?.find(t => t.domain === c.domain) ?? c.webTraffic?.[0];
  if (site && site.mom !== null) signals.push({ rank: 9, change: `${site.domain} had ${int(site.monthlyVisitors)} visits last month, ${trend(site.mom)} on the month before.`,
    question: site.mom <= -15 ? `Visits to ${site.domain} fell ${pct(site.mom, false)} last month. Seasonal, or a change in how buyers find you?` : undefined });
  if (c.followers?.m3 !== null && c.followers?.m3 !== undefined) signals.push({ rank: 10, change: `Followers ${trend(c.followers.m3)} in 3 months, ${int(c.followers.count)} now.` });

  const ranked = signals.sort((a, b) => a.rank - b.rank);
  const changes = ranked.map(s => s.change).slice(0, 6);

  // ---- three questions, all to the prospect, from the strongest signals ----
  const q = ranked.map(s => s.question).filter((x): x is string => !!x).slice(0, 3);
  const fallbacks = [
    "What is your team's top priority for the next two quarters?",
    "Which tools or vendors are you reviewing this year?",
    "Who else is involved when you decide to buy something like this?",
  ];
  for (const fb of fallbacks) if (q.length < 3) q.push(fb);

  return { summary: what.join(" "), lead: what.slice(0, own ? 2 : 1).join(" "), changes, questions: q };
}
