/**
 * One spelling per profile, so the same person is never watched or matched twice: https://www.<host>/in/<slug>
 * Lowercased, decoded (so "jos%C3%A9" and "josé" match), without "m." or country subdomains, a trailing slash,
 * a query string or a trailing locale segment such as "/en".
 */
export function normalizeProfileUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|[a-z]{2}\.)/, "");
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep as is */ }
    path = path.replace(/\/+$/, "").replace(/(\/in\/[^/]+)\/[a-z]{2}$/i, "$1");
    return `https://www.${host}${path.toLowerCase()}`;
  } catch {
    return trimmed;
  }
}
