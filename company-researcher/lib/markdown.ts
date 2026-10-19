// Renders a research result as markdown. The CLI prints this; the UI's "Export as markdown" button downloads it.

import type { Research } from "./types";
import { compact, credits, int, money, monthYear, pct } from "./format";

const esc = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
const notOnPlan = (r: Research, group: string) => {
  const u = r.unavailable.find(x => x.startsWith(group));
  if (!u) return "_No data._";
  return u.includes("lite mode") ? `_Skipped in lite mode (\`${group}\`)._` : `_Not available on this plan (\`${group}\`)._`;
};

export function toMarkdown(r: Research): string {
  const c = r.company, p = r.people, h = c.headcount, f = c.funding, j = r.hiring;
  const out: string[] = [];
  const line = (s = "") => out.push(s);

  line(`# ${c.name} (${c.domain})`);
  line();
  line(`Research brief from the Crustdata API, data fetched ${r.fetchedAt.slice(0, 10)}. Every figure below comes from one \`/company/enrich\` call and three \`/job/search\` calls.`);
  line();

  // ---- brief ----
  line("## Brief");
  line();
  if (r.brief.ai) {
    line(r.brief.ai.text);
    line();
    line(`_Written by ${r.brief.ai.model} from the data below._`);
  } else {
    line(r.brief.summary);
    line();
    line("**What changed lately**");
    line();
    for (const s of r.brief.changes) line(`- ${s}`);
    line();
    line("**Three questions to ask**");
    line();
    r.brief.questions.forEach((q, i) => line(`${i + 1}. ${q}`));
  }
  line();

  // ---- headcount ----
  line("## Headcount");
  line();
  if (!h) line(notOnPlan(r, "headcount"));
  else {
    line(`${int(h.total)} people${h.asOf ? ` as of ${h.asOf}` : ""}.`);
    line();
    line("| Period | Change | People added or lost |");
    line("|---|---|---|");
    const periods: Array<[string, keyof typeof h.growthPercent]> = [["1 month", "m1"], ["3 months", "m3"], ["6 months", "m6"], ["12 months", "m12"], ["24 months", "m24"]];
    for (const [label, k] of periods) {
      const a = h.growthAbsolute[k];
      line(`| ${label} | ${pct(h.growthPercent[k])} | ${a === null ? "n/a" : (a > 0 ? "+" : "") + int(a)} |`);
    }
    line();
    if (h.byDepartment.length) {
      line("**By department**");
      line();
      line("| Department | People | Share | 12 month change |");
      line("|---|---|---|---|");
      for (const d of h.byDepartment.slice(0, 10)) line(`| ${d.name} | ${int(d.count)} | ${d.share === null ? "n/a" : Math.round(d.share) + "%"} | ${pct(d.growth12m)} |`);
      line();
    }
    if (h.byCountry.length || h.byMetro.length) {
      line("**By location**");
      line();
      if (h.byCountry.length) line(`- Countries: ${h.byCountry.slice(0, 6).map(x => `${x.name} ${int(x.count)}`).join(", ")}`);
      if (h.byMetro.length) line(`- Metro areas: ${h.byMetro.slice(0, 6).map(x => `${x.name} ${int(x.count)}`).join(", ")}`);
      line();
    }
  }

  // ---- hiring ----
  line("## Hiring");
  line();
  if (!j) line("_Job search was unavailable for this run._");
  else {
    const vs = j.postingsPrev90d !== null ? ` (${int(j.postingsPrev90d)} in the 90 days before${j.changePercent !== null ? `, ${pct(j.changePercent)}` : ""})` : "";
    line(`${int(j.postingsLast90d)} job postings in the last 90 days${vs}.`);
    line();
    if (j.byRoleType.length) {
      line(`By role type (read from posting titles): ${j.byRoleType.map(b => `${b.type} ${int(b.count)}`).join(", ")}.`);
      line();
    }
    if (j.newest.length) {
      line("**Newest postings**");
      line();
      line("| Posted | Title | Location |");
      line("|---|---|---|");
      for (const x of j.newest.slice(0, 10)) line(`| ${x.date ?? ""} | ${esc(x.title)} | ${esc(x.location ?? "")}${x.workplace ? ` (${x.workplace})` : ""} |`);
      line();
    }
  }

  // ---- leadership ----
  line("## Leadership");
  line();
  const people = (title: string, list: typeof p.founders, max: number) => {
    if (!list.length) return;
    line(`**${title}**`);
    line();
    for (const x of list.slice(0, max)) line(`- ${x.name}, ${x.title}${x.startDate ? ` (since ${x.startDate.slice(0, 7)})` : ""}`);
    line();
  };
  if (!p.founders.length && !p.executives.length && !p.decisionMakers.length) line(`${notOnPlan(r, "people")}\n`);
  people("Founders", p.founders, 6);
  people("Executives", p.executives, 10);
  people("Other decision makers", p.decisionMakers.filter(d => !p.executives.includes(d)), 8);
  if (p.startDatesKnown) {
    line(p.recentJoins.length
      ? `Started in the last 90 days: ${p.recentJoins.map(x => `${x.name} (${x.title}, ${monthYear(x.startDate)})`).join("; ")}.`
      : "No one on this list started in the last 90 days.");
    line();
  }

  // ---- funding ----
  line("## Funding");
  line();
  if (!f) line(notOnPlan(r, "funding"));
  else {
    if (f.totalUsd) line(`Total raised ${money(f.totalUsd)}${f.roundCount ? ` across ${f.roundCount} rounds` : ""}${f.secondaryUsd ? `, not counting ${money(f.secondaryUsd)} in secondary sales` : ""}.`);
    if (f.lastRound?.type) line(`Last round: ${f.lastRound.type}${f.lastRound.amountUsd ? `, ${money(f.lastRound.amountUsd)}` : ""}${f.lastRound.date ? `, ${f.lastRound.date}` : ""}.`);
    line();
    if (f.rounds.length) {
      line("| Date | Round | Amount | Lead investors |");
      line("|---|---|---|---|");
      for (const x of f.rounds) line(`| ${x.date ?? ""} | ${x.type ?? ""} | ${x.amountUsd ? money(x.amountUsd) : "undisclosed"} | ${esc(x.leadInvestors.join(", "))} |`);
      line();
    }
    if (f.investors.length) line(`Investors: ${f.investors.slice(0, 15).join(", ")}${f.investors.length > 15 ? ` and ${f.investors.length - 15} more` : ""}.\n`);
    if (f.acquisitions.length) line(`Acquisitions: ${f.acquisitions.map(a => `${a.name}${a.date ? ` (${a.date.slice(0, 7)})` : ""}`).join(", ")}.\n`);
    if (f.acquiredBy.length) line(`Acquired by: ${f.acquiredBy.join(", ")}.\n`);
  }

  // ---- traffic and audience ----
  line("## Web traffic and audience");
  line();
  if (c.webTraffic?.length) {
    line("| Domain | Monthly visits | 1 month | 3 months | From search |");
    line("|---|---|---|---|---|");
    for (const t of c.webTraffic) line(`| ${t.domain} | ${compact(t.monthlyVisitors)} | ${pct(t.mom)} | ${pct(t.qoq)} | ${t.searchShare === null ? "n/a" : Math.round(t.searchShare) + "%"} |`);
    line();
  } else line(`Web traffic: ${notOnPlan(r, "web_traffic")}\n`);
  if (c.followers) line(`Followers: ${int(c.followers.count)} (${pct(c.followers.m1)} in 1 month, ${pct(c.followers.m3)} in 3 months, ${pct(c.followers.m12)} in 12 months).\n`);

  // ---- tech stack ----
  line("## Tech stack");
  line();
  if (c.techStack?.byCategory.length) {
    line(`${int(c.techStack.total)} technologies detected from the website and job postings. The main ones by category:`);
    line();
    for (const g of c.techStack.byCategory) line(`- **${g.category}**: ${g.names.join(", ")}`);
    line();
  } else line(`${notOnPlan(r, "technographics")}\n`);

  // ---- employee ratings ----
  line("## Employee ratings");
  line();
  const er = c.employeeRatings;
  if (er) {
    const parts = [
      er.culture !== null && `culture ${er.culture}`, er.workLife !== null && `work life balance ${er.workLife}`,
      er.careerGrowth !== null && `career growth ${er.careerGrowth}`, er.management !== null && `senior management ${er.management}`,
      er.compensation !== null && `pay and benefits ${er.compensation}`,
    ].filter(Boolean);
    const basis = er.ratingsCount ? ` from ${int(er.ratingsCount)} ${er.ratingsCount === 1 ? "rating" : "ratings"}` : "";
    if (er.lowSample) line(`${er.overall?.toFixed(1)} out of 5${basis}. Too few ratings to read much into.`);
    else line(`${er.overall?.toFixed(1)} out of 5${basis}.${parts.length ? ` Scores: ${parts.join(", ")}.` : ""}${er.recommendPercent !== null ? ` ${er.recommendPercent}% would recommend it to a friend.` : ""}`);
    line();
  } else line(`${notOnPlan(r, "employee_reviews")}\n`);

  // ---- competitors ----
  line("## Search competitors");
  line();
  if (c.competitors) {
    if (c.competitors.paidSearch.length) line(`- Bid on the same search ads: ${c.competitors.paidSearch.join(", ")}`);
    if (c.competitors.organicSearch.length) line(`- Rank for the same searches: ${c.competitors.organicSearch.join(", ")}`);
    line();
  } else line(`${notOnPlan(r, "competitors")}\n`);

  // ---- news and posts ----
  line("## Recent news (last 90 days)");
  line();
  if (c.news.length) {
    for (const n of c.news.slice(0, 6)) line(`- ${n.date ?? ""} [${esc(n.title)}](${n.url})${n.publisher ? `, ${n.publisher}` : ""}`);
    line();
  } else line(`${r.unavailable.some(u => u.startsWith("news")) ? notOnPlan(r, "news") : "_No articles in the last 90 days._"}\n`);

  line("## Recent posts by the company");
  line();
  if (c.posts.length) {
    for (const x of c.posts.slice(0, 5)) {
      const text = x.text.length > 160 ? x.text.slice(0, 157).replace(/\s+\S*$/, "") + "..." : x.text;
      line(`- ${x.date ?? ""}: ${esc(text)}${x.reactions ? ` (${int(x.reactions)} reactions)` : ""}`);
    }
    line();
  } else line(`${notOnPlan(r, "social_posts")}\n`);

  // ---- footer ----
  line("---");
  line();
  const cr = r.credits;
  line(`Credits used: ${credits(cr.total)}${cr.cached ? " (served from cache)" : ` (identify ${credits(cr.identify)}, enrich ${credits(cr.enrich)}, job search ${credits(cr.jobs)})`}.`);
  line();
  line("Built on [Crustdata](https://crustdata.com). API docs: [docs.crustdata.com](https://docs.crustdata.com).");
  return out.join("\n") + "\n";
}
