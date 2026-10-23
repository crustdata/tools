/**
 * Email through Resend (https://resend.com), optional. The HTML is built from the digest model, not from the markdown:
 * every piece of text that came from a page, post or record is HTML-escaped, and the only links are the ones the
 * agent itself attaches to an item, so text on a competitor's page can never turn into a link or markup.
 */

import { config } from "./config.js";
import { FIRST_RUN_NOTE, QUIET, creditsLine, digestMarkdown, digestTitle, isQuiet, itemCount, orderItems } from "./digest.js";
import type { CompetitorDigest, Digest, Item } from "./types.js";
import { SECTIONS, SECTION_TITLES, capitalise, sentence, shortDate } from "./types.js";

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const ACCENT = "#5644ED";
const a = (url: string | undefined, label: string) =>
  url && /^https?:\/\//i.test(url) && url.length <= 1_000 ? ` <a href="${escapeHtml(url)}" style="color:${ACCENT}">${escapeHtml(label)}</a>` : "";

export function itemHtml(i: Item): string {
  const date = shortDate(i.date, i.text);
  const what = sentence(`${i.text}${date ? ` (${date})` : ""}`);
  const why = i.why ? ` <span style="color:#6b6b76">${escapeHtml(sentence(capitalise(i.why)))}</span>` : "";
  return `<li style="margin:3px 0">${escapeHtml(what)}${why}${a(i.url, i.linkLabel ?? "source")}</li>`;
}

function competitorHtml(c: CompetitorDigest): string {
  const head = `<h2 style="font-size:16px;margin:22px 0 6px;padding-top:14px;border-top:1px solid #e5e5ea">${escapeHtml(c.name)} <span style="color:#6b6b76;font-weight:400">(${escapeHtml(c.domain)})</span></h2>`;
  if (isQuiet(c)) return `${head}<p style="margin:4px 0">Nothing new in any section this week.</p>`;
  const sections = SECTIONS.map(s => {
    const r = c.sections[s];
    const items = orderItems(r.items);
    if (!items.length) return `<p style="margin:8px 0 4px"><strong>${SECTION_TITLES[s]}:</strong> ${escapeHtml(sentence(capitalise(r.note ?? QUIET[s])))}</p>`;
    const note = r.note ? `<li style="margin:3px 0;color:#6b6b76"><em>${escapeHtml(r.note)}</em></li>` : "";
    return `<p style="margin:10px 0 2px"><strong>${SECTION_TITLES[s]}</strong></p><ul style="margin:2px 0 8px 18px;padding:0">${items.map(itemHtml).join("")}${note}</ul>`;
  });
  return head + sections.join("");
}

/** The digest as a self-contained HTML email body. */
export function digestHtml(d: Digest): string {
  const n = itemCount(d);
  const warnings = d.warnings.length ? `<p style="margin:16px 0 4px"><strong>Warnings</strong></p><ul style="margin:2px 0 8px 18px;padding:0">${d.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : "";
  return [
    `<div style="font-family:Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1c1c1e;max-width:720px">`,
    `<h1 style="font-size:20px;margin:0 0 6px">${escapeHtml(digestTitle(d))}</h1>`,
    `<p style="margin:0 0 8px">${d.competitors.length} competitor${d.competitors.length === 1 ? "" : "s"}, ${n} item${n === 1 ? "" : "s"}.${d.firstRun ? ` ${escapeHtml(FIRST_RUN_NOTE)}` : ""}</p>`,
    ...(d.notices ?? []).map(x => `<p style="margin:0 0 8px;color:#6b6b76"><em>${escapeHtml(x)}</em></p>`),
    ...d.competitors.map(competitorHtml),
    warnings,
    `<p style="margin:20px 0 0;padding-top:12px;border-top:1px solid #e5e5ea;color:#6b6b76;font-size:12px">${escapeHtml(creditsLine(d))} Headcount lines, and funding lines without a link, are Crustdata company data. Data from <a href="https://crustdata.com" style="color:${ACCENT}">Crustdata</a>. Built with <a href="https://github.com/crustdata/tools/tree/main/competitor-tracker" style="color:${ACCENT}">competitor-tracker</a>.</p>`,
    `</div>`,
  ].join("\n");
}

/** Sends the digest. Resolves to null when Resend accepted it, or to the reason it did not. */
export async function sendDigestEmail(d: Digest): Promise<string | null> {
  if (!config.resendApiKey || !config.digestEmailFrom || !config.digestEmailTo.length) return "email is not configured (RESEND_API_KEY, DIGEST_EMAIL_FROM, DIGEST_EMAIL_TO)";
  const { Resend } = await import("resend");
  const resend = new Resend(config.resendApiKey);
  const n = itemCount(d);
  let error: { name?: string; message: string } | null = null;
  try {
    ({ error } = await resend.emails.send({
      from: config.digestEmailFrom,
      to: config.digestEmailTo,
      subject: `${digestTitle(d)}: ${n} item${n === 1 ? "" : "s"} across ${d.competitors.length} competitor${d.competitors.length === 1 ? "" : "s"}`,
      html: digestHtml(d),
      text: digestMarkdown(d),
    }));
  } catch (err) {
    return `could not reach Resend (${(err as Error).message})`;
  }
  if (!error) return null;
  if (/domain/i.test(error.message) && /verif/i.test(error.message)) return `Resend: the sender domain is not verified. Verify ${config.digestEmailFrom.split("@")[1] ?? "your domain"} at https://resend.com/domains or send from onboarding@resend.dev to yourself.`;
  if (/api key|unauthorized|401/i.test(`${error.name} ${error.message}`)) return "Resend rejected the API key. Check RESEND_API_KEY.";
  return `Resend: ${error.message}`;
}
