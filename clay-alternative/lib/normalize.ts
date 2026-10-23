// Identifier normalisation, applied on every read and every cache key, so "Stripe.com/", "www.stripe.com" and
// "https://stripe.com" are one company, and one profile URL has one spelling.

import { isPersonalDomain } from "./personal-domains";
import type { Identifier } from "./types";

const PROFILE_HOST = "linkedin.com";

/** A host name as the API wants it: lower case, punycode for non-ASCII labels, no trailing dot. Null when it is not a host. */
function cleanHost(raw: string): string | null {
  let h = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!h || /[\s/?#@:]/.test(h)) return null;
  if (!/^[\x21-\x7e]+$/.test(h)) {
    try { h = new URL(`https://${h}`).hostname; } catch { return null; }
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || h.length > 253) return null;
  if (h.split(".").some(l => l.startsWith("-") || l.endsWith("-") || l.length > 63)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
  return h;
}

/** "Jane Doe <Jane@Acme.Example>" -> "jane@acme.example". Null when it is not one address. */
export function normalizeEmail(raw: string): string | null {
  let e = raw.trim();
  const angled = e.match(/<([^<>\s]+)>\s*$/);
  if (angled) e = angled[1];
  e = e.replace(/^mailto:/i, "").trim();
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  const local = e.slice(0, at), host = cleanHost(e.slice(at + 1));
  if (!host || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || local.length > 64) return null;
  const out = `${local.toLowerCase()}@${host}`;
  return out.length > 254 ? null : out;
}

export const emailDomain = (email: string): string => email.slice(email.indexOf("@") + 1);

/** "https://www.Stripe.com/pricing?x=1" -> "stripe.com". Returns null for anything that is not a host name. */
export function normalizeDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\/\//, "");
  d = d.split(/[/?#]/)[0].split("@").pop() ?? "";
  d = d.replace(/:\d+$/, "").replace(/^www\./, "");
  return cleanHost(d);
}

/** "https://www.stripe.com/x" -> "stripe.com"; null when not a URL. */
export const hostOf = (url: unknown): string | null => (typeof url === "string" && url ? normalizeDomain(url) : null);

/** A profile URL in one spelling: https host, lower case, the slug only, no query, no trailing slash, decoded once. */
export function normalizeProfileUrl(raw: string): string | null {
  let u = raw.trim();
  if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `https://${u}`;
  let url: URL;
  try { url = new URL(u); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== PROFILE_HOST && !host.endsWith(`.${PROFILE_HOST}`)) return null;
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep as is */ }
  const m = path.match(/^\/in\/([^/]+)/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  if (/\s/.test(slug) || slug.length > 200) return null;
  return `https://www.${PROFILE_HOST}/in/${slug}`;
}

export const looksLikeProfileUrl = (raw: string): boolean => new RegExp(`${PROFILE_HOST.replace(".", "\\.")}/in/`, "i").test(raw);
export const looksLikeEmail = (raw: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim()) || /<[^<>\s]+@[^<>\s]+>\s*$/.test(raw.trim());
export const looksLikeDomain = (raw: string): boolean => normalizeDomain(raw) !== null && !/\s/.test(raw.trim());

/** Company names: trimmed, inner spaces collapsed. The API matches names loosely; the planner compares exactly. */
export const normalizeName = (raw: string): string => raw.trim().replace(/\s+/g, " ");

const SUFFIXES = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "gmbh", "ag", "sa", "bv", "plc", "pty", "pvt", "srl", "sas", "oy", "ab", "kk", "llp", "lp"]);

/** The key two names are compared on: lower case, punctuation dropped, legal suffixes dropped from the end only. */
export function nameKey(name: string): string {
  const words = name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words[0] === "the" && words.length > 1) words.shift();
  return words.join(" ");
}

export function emailIdentifier(raw: string): Identifier | null {
  const value = normalizeEmail(raw);
  if (!value) return null;
  return { kind: "email", value, personal: isPersonalDomain(emailDomain(value)) };
}

/** Reads one pasted line as whatever it looks like: a profile URL, an email, a domain, or a company name. */
export function identifierFromText(raw: string): Identifier | null {
  const t = raw.trim();
  if (!t) return null;
  if (looksLikeProfileUrl(t)) { const v = normalizeProfileUrl(t); return v ? { kind: "profile_url", value: v } : null; }
  if (looksLikeEmail(t)) return emailIdentifier(t);
  if (looksLikeDomain(t)) return { kind: "domain", value: normalizeDomain(t)! };
  return { kind: "company_name", value: normalizeName(t) };
}
