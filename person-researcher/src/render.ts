/**
 * A Brief to markdown (one person) and an index (several people). Pure. Sections run in the order you need them
 * before a call: who they are, what changed, what they said lately, the news, then the company and the history. The
 * footer says how the person was found and which Crustdata endpoint produced each section.
 */

import type { Brief } from "./brief.js";

/**
 * Markdown-safe inline text: external strings (names, titles, post text) cannot open links, emphasis, code or HTML,
 * and cannot start a heading or a list.
 */
export const md = (s: string): string =>
  s.replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>~])/g, "\\$1").replace(/^(\s*)([#>+-]|\d+\.)(\s)/, "$1\\$2$3");

/** A link only for http(s) addresses; anything else (javascript:, data:) is shown as plain text. */
export const link = (text: string, url: string): string =>
  /^https?:\/\//i.test(url) ? `[${md(text)}](${url.replace(/[()\s<>]/g, c => encodeURIComponent(c))})` : md(text);

const num = (n: number) => n.toLocaleString("en-US");

export function renderBrief(b: Brief): string {
  const p = b.person;
  const out: string[] = [];
  out.push(`# ${md(p.name)}`);
  const role = [p.title, p.company].filter(Boolean).map(s => md(s!)).join(" at ");
  if (role) out.push("", `**${role}**${p.location ? ` · ${md(p.location)}` : ""}`);
  else if (p.location) out.push("", md(p.location));
  if (b.check) out.push("", `> Check this is the right person: ${md(b.check)}. Open the profile link before the call.`);

  out.push("", "## Who they are", "");
  const facts: string[] = [];
  if (p.headline) facts.push(`- Headline: ${md(p.headline)}`);
  if (p.about) facts.push(`- About: ${md(p.about)}`);
  if (p.openTo?.length) facts.push(`- Open to: ${p.openTo.map(md).join(", ")}`);
  if (p.department) facts.push(`- Function: ${md(p.department)}`);
  if (p.experience) facts.push(`- Experience: ${md(p.experience)}`);
  const reach = [p.followers ? `${num(p.followers)} followers` : "", p.connections ? `${num(p.connections)}${p.connections === 500 ? "+" : ""} connections` : ""].filter(Boolean).join(", ");
  if (reach) facts.push(`- Audience: ${reach}`);
  if (p.languages?.length) facts.push(`- Languages: ${p.languages.map(md).join(", ")}`);
  const links = [p.profileUrl ? link("Profile", p.profileUrl) : "", p.xUrl ? link("X", p.xUrl) : "", p.devUrl ? link("Code", p.devUrl) : ""].filter(Boolean);
  if (links.length) facts.push(`- Links: ${links.join(" · ")}`);
  out.push(...(facts.length ? facts : ["Only the name is on this profile."]));

  out.push("", "## What changed lately", "");
  if (b.changes.length) out.push(...b.changes.map(c => `- ${md(c.text)}`));
  else if (b.quiet) out.push(md(b.quiet));
  if (p.refreshed && b.changes.length) out.push("", `Profile refreshed on ${p.refreshed}.`);

  if (b.posts) {
    out.push("", "## Recent posts", "");
    if (b.posts.total !== null && b.posts.total > 0) out.push(`${num(b.posts.total)} posts by them in the index${b.posts.shown.length ? `, newest ${b.posts.shown.length} below` : ""}.`, "");
    for (const x of b.posts.shown) {
      const eng = [x.reactions ? `${num(x.reactions)} reactions` : "", x.comments ? `${num(x.comments)} comments` : "", x.shares ? `${num(x.shares)} shares` : ""].filter(Boolean).join(", ");
      out.push(`- **${x.date}**: ${md(x.text)}${eng ? ` (${eng})` : ""}${x.url ? ` ${link("Open", x.url)}` : ""}`);
    }
    if (b.posts.note) out.push(...(b.posts.shown.length ? [""] : []), md(b.posts.note));
  }

  if (b.news || b.web) {
    out.push("", "## In the news and on the web", "");
    const days = b.newsDays ?? 90;
    if (b.news) {
      if (b.news.length) out.push(`News, last ${days} days:`, "", ...b.news.map(l => `- ${link(l.title, l.url)}${l.snippet ? `: ${md(l.snippet)}` : ""}`));
      else out.push(`No news articles naming them in the last ${days} days.`);
    }
    if (b.web?.length) out.push(...(b.news ? [""] : []), "On the web:", "", ...b.web.map(l => `- ${link(l.title, l.url)}`));
    else if (b.web) out.push(...(b.news ? [""] : []), "No web pages about them found (their profile and contact-lookup sites are left out).");
  }

  if (b.company) {
    const c = b.company;
    out.push("", `## About ${md(c.name)}`, "");
    out.push(...[
      c.domain ? `- Website: ${link(c.domain, `https://${c.domain}`)}` : "",
      c.headcount ? `- Headcount: ${md(c.headcount)}` : "",
      c.industry ? `- Industry: ${md(c.industry)}` : "",
      c.status ? `- Status: ${md(c.status)}` : "",
      c.about ? `- About: ${md(c.about)}` : "",
    ].filter(Boolean));
  }

  if (b.career.length) {
    out.push("", "## Career", "");
    for (const g of b.career) {
      out.push(`**${md(g.company)}**${g.current ? " (current)" : ""}${g.span ? ` · ${g.span}` : ""}`, "");
      for (const r of g.roles) {
        const extra = r.details.length ? ` · ${r.details.map(md).join(" · ")}` : "";
        out.push(`- ${md(r.title)}${r.dates ? `, ${r.dates}` : ""}${extra}`);
        if (r.description) out.push(`  ${md(r.description)}`);
      }
      out.push("");
    }
    out.pop();
  }

  if (b.education.length) {
    out.push("", "## Education", "");
    out.push(...b.education.map(e => `- ${md(e.school)}${e.detail ? `, ${md(e.detail)}` : ""}`));
  }

  const extras: string[] = [];
  if (b.skills.length) extras.push(`- Skills: ${b.skills.map(md).join(", ")}`);
  if (b.certifications.length) extras.push(`- Certifications: ${b.certifications.map(md).join("; ")}`);
  if (b.honors.length) extras.push(`- Honors: ${b.honors.map(md).join("; ")}`);
  if (extras.length) out.push("", "## Skills, certifications, honors", "", ...extras);

  if (b.contact) {
    const c = b.contact;
    out.push("", "## Contact", "");
    const rows = [
      c.business.length ? `- Work email: ${c.business.map(md).join(", ")}` : "",
      c.personal.length ? `- Personal email: ${c.personal.map(md).join(", ")}` : "",
      c.phones.length ? `- Phone: ${c.phones.map(md).join(", ")}` : "",
    ].filter(Boolean);
    out.push(...(rows.length ? rows : ["No contact details found (not charged)."]));
  }

  if (b.notes.length) out.push("", ...b.notes.map(n => `> ${md(n)}`));

  out.push("", "---", "", `Found by ${md(b.matchedBy)}: ${md(b.input)}${p.refreshed ? `. Profile refreshed on ${p.refreshed}` : ""}.`, "", sourceLine(b));
  return out.join("\n") + "\n";
}

/** Which Crustdata endpoint produced each part of the brief. */
export function sourceLine(b: Brief): string {
  const parts = ["profile, career, education and company from Crustdata Person Enrich (`/person/enrich`)"];
  if (b.posts) parts.push("posts from Social Post Search (`/social_post/search`)");
  if (b.news || b.web) parts.push("news and web from Web Search (`/web/search/live`)");
  if (b.contact) parts.push("contact details from Contact Enrich (`/person/contact/enrich`)");
  return `Sources: ${parts.join("; ")}. Made with [person-researcher](https://github.com/crustdata/tools/tree/main/person-researcher).`;
}

export type IndexRow = { input: string; status: "done" | "not_found" | "pick" | "skipped" | "failed"; name?: string; title?: string; file?: string; note?: string; changed?: string; check?: boolean };

/** The index for a run with several people. */
export function renderIndex(rows: IndexRow[], credits: string, when: string, stopped?: string): string {
  const out = [`# Research briefs, ${when}`, "", `${rows.filter(r => r.status === "done").length} of ${rows.length} people researched. Credits used: ${credits}.`, ""];
  if (stopped) out.push(`> The run stopped early: ${md(stopped)}`, "");
  for (const r of rows) {
    // r.file is a name this tool wrote (letters, digits, dashes), so it is safe as a relative link.
    if (r.status === "done") out.push(`- ${r.file ? `[${md(r.name ?? r.input)}](${encodeURI(r.file)})` : md(r.name ?? r.input)}${r.title ? `, ${md(r.title)}` : ""}${r.changed ? `. ${md(r.changed)}` : ""}${r.check ? " (check it is the right person, see the brief)" : ""}`);
    else out.push(`- ${md(r.input)}: ${md(r.note ?? r.status)}`);
  }
  out.push("", "For a company's headcount growth, funding and hiring, see the company researcher: https://github.com/crustdata/tools/tree/main/company-researcher");
  return out.join("\n") + "\n";
}
