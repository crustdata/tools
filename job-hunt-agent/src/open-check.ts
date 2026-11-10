/**
 * Is the job still open? For postings on Greenhouse, Lever, Ashby and SmartRecruiters, their free public job
 * board APIs answer that (no key, no Crustdata credits). Other sources say "not checked", and the report shows
 * how many days ago the job was posted instead.
 *
 * Only these four hosts are ever called, over https, with an 8 second timeout. Nothing about you is sent.
 */

export type Openness = "open" | "closed" | "not checked";

export type BoardRef =
  | { board: "greenhouse"; org: string; id: string }
  | { board: "lever"; org: string; id: string; eu?: boolean }
  | { board: "ashby"; org: string; id: string }
  | { board: "smartrecruiters"; org: string; id: string };

/** Which job board a posting URL is on, and its ids there. Pure; tested in test/logic.test.ts. */
export function boardOf(url: string | null): BoardRef | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    // boards.greenhouse.io/<org>/jobs/<id>, job-boards.greenhouse.io/<org>/jobs/<id>, or ?for=<org>&token=<id>
    const i = parts.indexOf("jobs");
    if (i >= 1 && /^\d+$/.test(parts[i + 1] ?? "")) return { board: "greenhouse", org: parts[i - 1], id: parts[i + 1] };
    const org = u.searchParams.get("for");
    const token = u.searchParams.get("token") ?? u.searchParams.get("gh_jid");
    if (org && token && /^\d+$/.test(token)) return { board: "greenhouse", org, id: token };
    return null;
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    if (parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1])) return { board: "lever", org: parts[0], id: parts[1], eu: host === "jobs.eu.lever.co" };
    return null;
  }
  if (host === "jobs.ashbyhq.com") {
    if (parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1])) return { board: "ashby", org: parts[0], id: parts[1].toLowerCase() };
    return null;
  }
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") {
    const m = /^(\d{6,})/.exec(parts[1] ?? "");
    if (parts.length >= 2 && m) return { board: "smartrecruiters", org: parts[0], id: m[1] };
    return null;
  }
  return null;
}

const safe = (s: string) => encodeURIComponent(s);

/** Ashby lists every open job per company in one call: fetched once per company per run. */
const ashbyBoards = new Map<string, Promise<Set<string> | null>>();

async function status(url: string): Promise<number | null> {
  try {
    const r = await fetch(url, { method: "GET", headers: { accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(8_000) });
    await r.body?.cancel().catch(() => {});
    return r.status;
  } catch { return null; }
}

export async function checkOpen(url: string | null): Promise<Openness> {
  const ref = boardOf(url);
  if (!ref) return "not checked";
  if (ref.board === "ashby") {
    let board = ashbyBoards.get(ref.org);
    if (!board) {
      board = (async () => {
        try {
          const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${safe(ref.org)}`, { signal: AbortSignal.timeout(8_000) });
          if (!r.ok) return null;
          const j = await r.json() as { jobs?: Array<{ id?: string; jobUrl?: string }> };
          return new Set((j.jobs ?? []).map(x => String(x.id ?? "").toLowerCase()).filter(Boolean));
        } catch { return null; }
      })();
      ashbyBoards.set(ref.org, board);
    }
    const ids = await board;
    return ids === null ? "not checked" : ids.has(ref.id) ? "open" : "closed";
  }
  const api =
    ref.board === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${safe(ref.org)}/jobs/${safe(ref.id)}`
    : ref.board === "lever" ? `https://api.${ref.eu ? "eu." : ""}lever.co/v0/postings/${safe(ref.org)}/${safe(ref.id)}`
    : `https://api.smartrecruiters.com/v1/companies/${safe(ref.org)}/postings/${safe(ref.id)}`;
  const code = await status(api);
  if (code === 200) return "open";
  if (code === 404 || code === 410) return "closed";
  return "not checked";
}
