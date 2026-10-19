/**
 * Daily digest by email through Resend (https://resend.com). Optional: sent only when RESEND_API_KEY,
 * DIGEST_EMAIL_FROM and DIGEST_EMAIL_TO are all set. HTML plus a plain-text part, 600px wide, one block per person.
 */

import { Resend } from "resend";
import { config } from "./config.js";
import { duration, headline, monthYear, type JobChange } from "./notification.js";

const escapeHtml = (s?: string) => (s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const role = (title?: string, company?: string) => [title, company].filter(Boolean).join(" at ");

/** The detail line under each headline, plain text. */
export function detailLine(e: JobChange): string {
  const tenure = duration(e.previousTenureMonths);
  switch (e.kind) {
    case "new_company": return [e.newTitle && `${e.newTitle}${monthYear(e.startDate) ? `, since ${monthYear(e.startDate)}` : ""}`, e.previousCompany && `Was ${role(e.previousTitle, e.previousCompany)}${tenure ? ` for ${tenure}` : ""}`].filter(Boolean).join(". ");
    case "title_change": return `${e.previousTitle ?? "Previous title"} → ${e.newTitle ?? "new title"}`;
    case "left_company": return `Was ${e.previousTitle ?? "there"}${tenure ? ` for ${tenure}` : ""}. ${e.stillCompany ? `Still ${role(e.stillTitle, e.stillCompany)}.` : "No new role listed yet."}`;
    case "added_role": return e.stillCompany ? `${e.newTitle ?? "New role"}. Still ${role(e.stillTitle, e.stillCompany)}.` : e.newTitle ?? "";
    default: return "";
  }
}

export function digestHtml(changes: JobChange[], periodLabel: string): string {
  const rows = changes.map(e => {
    const name = e.profileUrl ? `<a href="${escapeHtml(e.profileUrl)}" style="color:#4f46e5;text-decoration:none">${escapeHtml(e.name ?? "Someone on your list")}</a>` : escapeHtml(e.name ?? "Someone on your list");
    const rest = escapeHtml(headline(e).slice((e.name ?? "Someone on your list").length));
    const owner = e.owner ? `<div style="color:#6b7280;font-size:13px;margin-top:2px">Owner: ${escapeHtml(e.owner)}</div>` : "";
    return `<tr><td style="padding:14px 0;border-bottom:1px solid #e5e7eb">
      <div style="font-size:15px;font-weight:600;color:#111827">${name}${rest}</div>
      <div style="font-size:14px;color:#374151;margin-top:4px">${escapeHtml(detailLine(e))}</div>${owner}
    </td></tr>`;
  }).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:24px 0;background:#f9fafb;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px">
  <tr><td style="padding:24px 28px 8px">
    <div style="font-size:20px;font-weight:700;color:#111827">${changes.length} job change${changes.length === 1 ? "" : "s"} on your list</div>
    <div style="font-size:14px;color:#6b7280;margin-top:4px">${escapeHtml(periodLabel)}</div>
  </td></tr>
  <tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
  <tr><td style="padding:16px 28px 24px;font-size:12px;color:#9ca3af">Sent by Job Change Alert Bot. Data from <a href="https://crustdata.com" style="color:#9ca3af">Crustdata</a>.</td></tr>
</table>
</body></html>`;
}

export function digestText(changes: JobChange[], periodLabel: string): string {
  return [
    `${changes.length} job change${changes.length === 1 ? "" : "s"} on your list, ${periodLabel}`,
    "",
    ...changes.map(e => [`- ${headline(e)}`, `  ${detailLine(e)}`, e.owner ? `  Owner: ${e.owner}` : "", e.profileUrl ? `  ${e.profileUrl}` : ""].filter(Boolean).join("\n")),
    "",
    "Sent by Job Change Alert Bot. Data from Crustdata.",
  ].join("\n");
}

export const emailConfigured = (): boolean => Boolean(config.resendApiKey && config.digestEmailFrom && config.digestEmailTo.length);

export async function sendDigestEmail(changes: JobChange[], periodLabel: string): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    const { error } = await new Resend(config.resendApiKey).emails.send({
      from: config.digestEmailFrom,
      to: config.digestEmailTo,
      subject: `${changes.length} job change${changes.length === 1 ? "" : "s"} on your list, ${periodLabel}`,
      html: digestHtml(changes, periodLabel),
      text: digestText(changes, periodLabel),
    });
    if (error) console.error("Resend error:", error.message ?? error);
    return !error;
  } catch (err) {
    console.error("Resend error:", (err as Error).message);
    return false;
  }
}
