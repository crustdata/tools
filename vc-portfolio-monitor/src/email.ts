/**
 * The weekly digest by email through Resend (https://resend.com), optional. HTML is built from the digest model and
 * every outside string is escaped, so a headline or company name can never become markup or a link.
 */

import { config } from "./config.js";
import { counts, creditsLine, digestMarkdown, digestTitle, orderCompanies, orderSignals, quietLabel, startLine, summaryLine } from "./digest.js";
import type { Digest } from "./run.js";
import { SEVERITY_LABEL, sentence, type Signal } from "./types.js";

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const ACCENT = "#5644ED";
const COLORS: Record<string, string> = { alert: "#b42318", good: "#067647", note: "#475467", news: "#475467" };
const a = (url: string | undefined, label: string) => (url && /^https?:\/\//i.test(url) && url.length <= 1_000 ? ` <a href="${escapeHtml(url)}" style="color:${ACCENT}">${escapeHtml(label)}</a>` : "");

export function signalHtml(s: Signal): string {
  const why = s.why ? `<br><span style="color:#6b6b76">${escapeHtml(s.why)}</span>` : "";
  return `<li style="margin:6px 0"><strong style="color:${COLORS[s.severity]}">${SEVERITY_LABEL[s.severity]}:</strong> ${escapeHtml(sentence(s.text))}${a(s.url, s.linkLabel ?? "source")}${why}</li>`;
}

export function digestHtml(d: Digest): string {
  const companies = orderCompanies(d.companies).map(c => {
    const head = `<h2 style="font-size:16px;margin:22px 0 4px;padding-top:14px;border-top:1px solid #e5e5ea">${escapeHtml(c.name)} <span style="color:#6b6b76;font-weight:400">${escapeHtml(c.domain)}${c.owner ? `, ${escapeHtml(c.owner)}` : ""}</span></h2>`;
    const items = [...orderSignals(c.signals).map(signalHtml), ...(c.start !== undefined ? [`<li style="margin:6px 0;color:#475467">${escapeHtml(startLine(c))}</li>`] : [])];
    return `${head}<ul style="margin:4px 0 8px 18px;padding:0">${items.join("")}</ul>`;
  });
  return [
    `<div style="font-family:Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1c1c1e;max-width:720px">`,
    `<h1 style="font-size:20px;margin:0 0 6px">${escapeHtml(digestTitle(d))}</h1>`,
    `<p style="margin:0 0 8px">${escapeHtml(summaryLine(d))}${d.firstDigest ? " First digest: each company's starting point is below." : ""}</p>`,
    ...d.warnings.map(w => `<p style="margin:0 0 8px;color:#b54708"><em>${escapeHtml(w)}</em></p>`),
    ...companies,
    d.quiet.length ? `<p style="margin:18px 0 0;color:#475467">${escapeHtml(quietLabel(d))}: ${escapeHtml(d.quiet.join(", "))}.</p>` : "",
    `<p style="margin:20px 0 0;padding-top:12px;border-top:1px solid #e5e5ea;color:#6b6b76;font-size:12px">${escapeHtml(creditsLine(d))} Headcount and funding lines are Crustdata company data; hiring lines count the roles on each careers page. Data from <a href="https://crustdata.com" style="color:${ACCENT}">Crustdata</a>. Built with <a href="https://github.com/crustdata/tools/tree/main/vc-portfolio-monitor" style="color:${ACCENT}">vc-portfolio-monitor</a>.</p>`,
    `</div>`,
  ].join("\n");
}

/** Sends the digest. Resolves to null when Resend accepted it, or to the reason it did not. */
export async function sendDigestEmail(d: Digest): Promise<string | null> {
  if (!config.resendApiKey || !config.digestEmailFrom || !config.digestEmailTo.length) return "email is not configured (RESEND_API_KEY, DIGEST_EMAIL_FROM, DIGEST_EMAIL_TO)";
  const { Resend } = await import("resend");
  const resend = new Resend(config.resendApiKey);
  const n = counts(d);
  let error: { name?: string; message: string } | null = null;
  try {
    ({ error } = await resend.emails.send({
      from: config.digestEmailFrom,
      to: config.digestEmailTo,
      subject: `${digestTitle(d)}: ${n.alert} alert${n.alert === 1 ? "" : "s"}, ${n.good} good news`,
      html: digestHtml(d),
      text: digestMarkdown(d),
    }));
  } catch (err) {
    return `could not reach Resend (${(err as Error).message})`;
  }
  if (!error) return null;
  if (/domain/i.test(error.message) && /verif/i.test(error.message)) return `Resend: the sender domain is not verified. Verify ${config.digestEmailFrom.split("@")[1] ?? "your domain"} at https://resend.com/domains, or send from onboarding@resend.dev to your own address.`;
  if (/api key|unauthorized|401/i.test(`${error.name} ${error.message}`)) return "Resend rejected the API key. Check RESEND_API_KEY.";
  return `Resend: ${error.message}`;
}
