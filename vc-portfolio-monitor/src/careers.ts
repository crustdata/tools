/**
 * Open roles from a careers page fetched live with Crustdata Web Fetch. Counts distinct job ids linked from the page:
 * job board links (Ashby, Greenhouse, Lever, Workable, SmartRecruiters, Recruitee, Personio, Teamtailor, BambooHR,
 * Rippling, Breezy, JazzHR, Dover, Wellfound) and same-site job pages such as /careers/<slug> or /jobs/<id>.
 * Pure functions, no I/O.
 */

/** Board links: [pattern, capture group holding the job id]. */
const BOARDS: RegExp[] = [
  /jobs\.ashbyhq\.com\/[^/"'\s<>\\?#]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
  /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/[^/"'\s<>\\?#]+\/jobs\/(\d+)/gi,
  /[?&](?:amp;)?gh_jid=(\d+)/gi,
  /jobs\.(?:eu\.)?lever\.co\/[^/"'\s<>\\?#]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
  /apply\.workable\.com\/[^/"'\s<>\\?#]+\/j\/([0-9A-F]{6,})/gi,
  /jobs\.smartrecruiters\.com\/[^/"'\s<>\\?#]+\/(\d{6,})/gi,
  /[a-z0-9-]+\.recruitee\.com\/o\/([a-z0-9-]+)/gi,
  /[a-z0-9-]+\.jobs\.personio\.(?:de|com)\/job\/(\d+)/gi,
  /[a-z0-9-]+\.teamtailor\.com\/jobs\/(\d+)/gi,
  /[a-z0-9-]+\.bamboohr\.com\/(?:careers|jobs)\/(?:view\.php\?id=)?(\d+)/gi,
  /ats\.rippling\.com\/[^/"'\s<>\\?#]+\/jobs\/([0-9a-f-]{36})/gi,
  /[a-z0-9-]+\.breezy\.hr\/p\/([0-9a-z]+)/gi,
  /[a-z0-9-]+\.applytojob\.com\/apply\/([A-Za-z0-9]+)/gi,
  /app\.dover\.com\/apply\/[^/"'\s<>\\?#]+\/([0-9a-f-]{36})/gi,
  /wellfound\.com\/jobs\/(\d+)/gi,
];

/** Same-site paths that are sections of a careers site, not a job. */
const NOT_A_JOB = new Set([
  "", "apply", "benefits", "perks", "culture", "values", "team", "teams", "life", "about", "faq", "faqs", "students", "university",
  "internships", "interns", "early-careers", "open-roles", "open-positions", "openings", "positions", "roles", "all", "search",
  "departments", "department", "locations", "location", "engineering", "design", "sales", "marketing", "product", "operations",
  "remote", "hiring", "process", "interview", "interviews", "diversity", "dei", "inclusion", "privacy", "candidate-privacy",
  "us", "eu", "uk", "en", "de", "fr", "es", "general-application", "talent-network", "join", "jobs", "careers", "page", "feed", "rss",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RoleCount = { roles: number; ids: string[] };

/**
 * Distinct roles linked from a careers page. Undefined when the page is not usable (empty, a sign-in or bot check).
 * A page that loads but lists nothing counts as 0.
 */
export function countRoles(html: string | null | undefined, pageUrl: string): RoleCount | undefined {
  if (!html || html.replace(/<[^>]*>/g, "").trim().length < 40) return undefined;
  if (/<title>[^<]*(just a moment|attention required|access denied|sign in|log in|captcha)[^<]*<\/title>/i.test(html)) return undefined;
  // Links inside JSON and scripts come escaped ("https:\/\/jobs..."); unescape so one pattern reads both.
  const text = html.replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const ids = new Set<string>();
  for (const re of BOARDS) for (const m of text.matchAll(re)) ids.add(m[1].toLowerCase());
  // An Ashby board page carries its postings as data: {"id":"<uuid>","title":"...".
  for (const m of text.matchAll(/\{"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})","title":"/gi)) ids.add(m[1].toLowerCase());

  let host = "";
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ""); } catch { /* relative links only */ }
  const hrefs = text.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi);
  for (const [, href] of hrefs) {
    let path: string;
    try {
      const u = new URL(href, pageUrl || "https://example.invalid/");
      if (host && u.hostname.replace(/^www\./, "") !== host) continue;
      path = u.pathname;
    } catch { continue; }
    const m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:careers?|jobs|join-us|work-with-us|open-roles|positions)\/(?:jobs\/|positions\/|roles\/|openings\/)?([^/]+)\/?$/i.exec(path);
    if (!m) continue;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    if (NOT_A_JOB.has(slug) || /\.(png|jpe?g|svg|webp|gif|pdf|css|js)$/.test(slug)) continue;
    // A same-site link to a role that is also linked on a board carries the same id: counted once.
    ids.add(UUID.test(slug) ? slug : slug);
  }
  return { roles: ids.size, ids: [...ids].sort() };
}

/** Job board home pages a careers page links to (where the full list often lives), e.g. https://jobs.ashbyhq.com/acme */
export function boardLinks(html: string | null | undefined): string[] {
  const text = String(html ?? "").replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/");
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/(jobs\.ashbyhq\.com|(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io|jobs\.(?:eu\.)?lever\.co|apply\.workable\.com)\/([A-Za-z0-9._-]+)/g)) {
    if (/^(embed|api|js|static|assets|images?)$/i.test(m[2])) continue;
    out.add(`https://${m[1]}/${m[2]}`);
  }
  return [...out].slice(0, 3);
}

/** Where to look for a company's careers page when the portfolio does not say: /careers, then /jobs. */
export const careersCandidates = (domain: string): string[] => [`https://${domain}/careers`, `https://${domain}/jobs`];
