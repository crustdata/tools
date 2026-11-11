/**
 * Profile URLs: finding them in a cell and writing every one the same way, so the same person is never checked
 * (or billed) twice because one export wrote "http://linkedin.com/in/Jane-Doe/" and another
 * "https://www.linkedin.com/in/jane-doe?trk=x".
 */

/** A person profile URL anywhere in a piece of text: host, then /in/<slug> (or the old /pub/<slug>/...). */
const PROFILE_URL = /(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/(?:in|pub)\/(?:[^\s,;"'<>|()\]]|\([^\s,;"'<>|()\]]*\))+/gi;

/**
 * One spelling per profile: https://www.linkedin.com/in/<slug>, lowercased, decoded (so "jos%C3%A9" and "josé"
 * match), without "m." or country subdomains, a trailing slash, a query string, a fragment or a trailing locale
 * segment such as "/en". Returns undefined for anything that is not a person profile (a company page, a post).
 */
export function normalizeProfileUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^<|>$/g, "");
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`); } catch { return undefined; }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|[a-z]{2,3}\.)/, "");
  if (host !== "linkedin.com") return undefined;
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep as is */ }
  path = path.replace(/\/+$/, "");
  // A URL copied from a profile's subpage (/details/experience, /overlay/contact-info, a locale) keeps only the slug.
  const m = /^\/in\/([^/]+)(?:\/.*)?$/i.exec(path);
  // Member id slugs (ACoAA..., ACwAA...) are case-sensitive; every other slug is not.
  if (m) return `https://www.linkedin.com/in/${/^AC[ow]AA/.test(m[1]) ? m[1] : m[1].toLowerCase()}`;
  path = path.toLowerCase();
  // The old public profile format: /pub/<name>/<a>/<b>/<c>
  // (/pub/dir/... is the public name search, not a person.)
  const pub = !path.startsWith("/pub/dir/") && /^\/pub\/[^/]+(?:\/[^/]+){0,3}$/.exec(path);
  if (pub) return `https://www.linkedin.com${path}`;
  return undefined;
}

/** Every distinct person profile URL in a cell (Lever's Links column holds several links in one cell). */
export function findProfileUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(PROFILE_URL)) {
    const url = normalizeProfileUrl(m[0].replace(/[.,;:]+$/, ""));
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** The slug, for messages: "jane-doe". */
export const profileSlug = (url: string): string => url.replace(/^.*\/(?:in|pub)\//, "").replace(/\/.*$/, "");
