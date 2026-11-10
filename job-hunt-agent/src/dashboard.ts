/**
 * The local dashboard: `npm run dashboard`, then open http://localhost:3480.
 *
 * Reads the runs in out/ (no Crustdata calls, no credits) and shows the jobs best first: fit and why, the company's
 * trend, the people to talk to with a draft note each and a Copy button, and your status per job (saved, applied,
 * ...), kept in data/job-hunt.db. If the Claude Code skill wrote an evaluation for a job (out/<run>/ai/<job id>.md),
 * it is shown too. Listens on 127.0.0.1 only: nothing is reachable from other machines.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { fundingLine, trendLine } from "./company.js";
import { fmtCredits } from "./crustdata.js";
import type { JobResult, Run } from "./hunt.js";
import { KIND_LABEL, type Kind } from "./people.js";
import { openLine, postedLine, safeUrl, skippedWeak } from "./render.js";
import { STATUSES, type Status, type Store } from "./store.js";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Run and job ids: letters in any script, digits, "_", ".", "-"; never "." or ".." alone. */
const RUN_ID = /^(?!\.{1,2}$)[\p{L}\p{N}_.-]{1,120}$/u;
const JOB_ID = /^(?!\.{1,2}$)[\p{L}\p{N}_.-]{1,120}$/u;

export function listRuns(outDir: string): Array<{ id: string; at: number }> {
  let names: string[];
  try { names = readdirSync(outDir); } catch { return []; }
  return names
    .filter(n => RUN_ID.test(n) && existsSync(join(outDir, n, "jobs.json")))
    .map(n => ({ id: n, at: statSync(join(outDir, n, "jobs.json")).mtimeMs }))
    .sort((a, b) => b.at - a.at);
}

export function readRun(outDir: string, id: string): Run | null {
  if (!RUN_ID.test(id)) return null;
  try { return JSON.parse(readFileSync(join(outDir, id, "jobs.json"), "utf8")) as Run; } catch { return null; }
}

/** The Claude Code skill's evaluation for a job, when it wrote one. */
export function readAi(outDir: string, runId: string, jobId: string): string | null {
  if (!RUN_ID.test(runId) || !JOB_ID.test(jobId)) return null;
  try { return readFileSync(join(outDir, runId, "ai", `${jobId}.md`), "utf8"); } catch { return null; }
}

/** Markdown from the AI file, escaped first, then a few safe styles: headings, bullets, bold, quotes, links. */
export function miniMarkdown(text: string): string {
  const lines = esc(text).split("\n");
  const html: string[] = [];
  let list = false;
  const inline = (s: string) => s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  for (const l of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(l);
    if (bullet) { if (!list) { html.push("<ul>"); list = true; } html.push(`<li>${inline(bullet[1])}</li>`); continue; }
    if (list) { html.push("</ul>"); list = false; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) html.push(`<h4>${inline(h[2])}</h4>`);
    else if (/^&gt;\s?/.test(l)) html.push(`<blockquote>${inline(l.replace(/^&gt;\s?/, ""))}</blockquote>`);
    else if (l.trim()) html.push(`<p>${inline(l)}</p>`);
  }
  if (list) html.push("</ul>");
  return html.join("\n");
}

const STATUS_LABEL: Record<Status, string> = { new: "New", saved: "Saved", applied: "Applied", interviewing: "Interviewing", offer: "Offer", skipped: "Skipped", rejected: "Rejected" };
const ORDER: Kind[] = ["recruiter", "manager", "team", "alumni"];

function scoreClass(n: number) { return n >= 70 ? "strong" : n >= 50 ? "possible" : "weak"; }

function jobRow(r: JobResult, i: number, runId: string, selected: boolean, status: Status): string {
  const trend = r.momentum.trend === "unknown" ? "" : `<span class="tag ${r.momentum.trend}">${esc(r.momentum.trend)}${r.momentum.growth6m !== null ? ` ${r.momentum.growth6m > 0 ? "+" : ""}${Math.round(r.momentum.growth6m)}%` : ""}</span>`;
  return `<a class="row${selected ? " sel" : ""}" href="/?run=${encodeURIComponent(runId)}&job=${encodeURIComponent(r.job.id)}">
  <span class="rank">${i + 1}</span>
  <span class="score ${scoreClass(r.fit.score)}">${r.fit.score}</span>
  <span class="what"><span class="t">${esc(r.job.title)}</span><span class="c">${esc(r.job.company.name)}${r.daysAgo !== null ? ` · ${r.daysAgo === 0 ? "today" : `${r.daysAgo}d`}` : ""}</span></span>
  <span class="meta">${trend}${status !== "new" ? `<span class="tag st">${esc(STATUS_LABEL[status])}</span>` : r.isNew ? "" : `<span class="tag seen">seen</span>`}</span>
</a>`;
}

function person(p: JobResult["people"][number], idx: string): string {
  const url = safeUrl(p.profileUrl);
  const extra = [p.school ? `${p.school}${p.schoolYear ? ` ${p.schoolYear}` : ""}` : null, p.location].filter(Boolean).map(esc).join(" · ");
  return `<div class="person">
  <div class="who"><div>${p.first ? `<div class="firsttag">Write to first</div>` : ""}<div class="name">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a>` : esc(p.name)}</div><div class="role">${esc(p.title)}</div>${extra ? `<div class="sub">${extra}</div>` : ""}${p.email ? `<div class="sub mono">${esc(p.email)}</div>` : ""}</div></div>
  ${p.alsoFor ? `<div class="note"><p class="muted">Also listed for job ${p.alsoFor} at this company: write once, about both roles.</p></div>` : `<div class="note"><p id="n${idx}">${esc(p.note)}</p><button class="copy" data-copy="n${idx}" type="button">Copy note</button></div>`}
</div>`;
}

function detail(r: JobResult, run: Run, ai: string | null, status: Status, note: string): string {
  const j = r.job;
  const url = safeUrl(j.url);
  const parts = r.fit.parts;
  const bar = (label: string, v: number, max: number) => `<div class="bar"><span>${label}</span><div class="track"><i style="width:${Math.max(0, Math.min(100, (v / max) * 100))}%"></i></div><b>${v}<small>/${max}</small></b></div>`;
  const where = [j.location, j.workplace, j.employmentType?.replace(/_/g, " ")].filter(Boolean).map(esc).join(" · ");
  // The group with the person to write to first comes first.
  const firstKind = r.people.find(p => p.first)?.kind;
  const order = firstKind ? [firstKind, ...ORDER.filter(k => k !== firstKind)] : ORDER;
  const people = order.map(k => {
    const g = r.people.filter(p => p.kind === k);
    if (!g.length) return "";
    return `<section class="card"><h3>${esc(KIND_LABEL[k])}</h3>${g.map((p, i) => person(p, `${k}${i}`)).join("")}</section>`;
  }).join("");
  const noAlumni = run.me.schools.length && !r.people.some(p => p.kind === "alumni") && !skippedWeak(r) && r.job.company.id !== null ? `<p class="muted">No alumni from ${esc(run.me.schools.join(" or "))} found at ${esc(j.company.name)}.</p>` : "";
  return `<div class="head">
  <div><h1>${esc(j.title)}</h1><div class="co">${esc(j.company.name)}${where ? ` · ${where}` : ""}</div></div>
  <div class="actions">
    ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open posting</a>` : ""}
    <select id="status" data-job="${esc(j.id)}" aria-label="Your status for this job">${STATUSES.map(s => `<option value="${s}"${s === status ? " selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select>
  </div>
</div>
<div class="grid">
  <section class="card fit">
    <div class="big ${scoreClass(r.fit.score)}">${r.fit.score}<small>/100</small></div>
    <div class="label">${esc(r.fit.label)}</div>
    ${bar("Skills", parts.skills, 50)}${bar("Title and level", parts.title, 20)}${bar("Place", parts.place, 10)}${bar("Company", parts.company, 10)}${bar("Freshness", parts.freshness, 10)}
    ${parts.penalties ? `<div class="pen">Flags -${parts.penalties}</div>` : ""}
  </section>
  <section class="card">
    <h3>Why</h3>
    <ul>${r.fit.reasons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    ${r.fit.matched.length ? `<div class="chips"><span class="k">You have</span>${r.fit.matched.map(s => `<span class="chip">${esc(s)}</span>`).join("")}</div>` : ""}
    ${r.fit.missing.length ? `<div class="chips"><span class="k">Not on your CV</span>${r.fit.missing.map(s => `<span class="chip off">${esc(s)}</span>`).join("")}</div>` : ""}
    ${r.fit.flags.length ? `<div class="flags">${r.fit.flags.map(f => `<div>${esc(f)}</div>`).join("")}</div>` : ""}
  </section>
  <section class="card">
    <h3>Company</h3>
    <p>${esc(trendLine(r.momentum))}</p>
    ${fundingLine(r.momentum) ? `<p>Last round: ${esc(fundingLine(r.momentum))}</p>` : `<p class="muted">No funding on record.</p>`}
    <p class="muted">${esc(cap(postedLine(r)))}. ${esc(cap(openLine(r)))}.</p>
  </section>
</div>
${ai ? `<section class="card ai"><h3>Claude's evaluation</h3><div class="md">${miniMarkdown(ai)}</div></section>` : ""}
<h2>Who to talk to</h2>
${r.people.length ? `<p class="muted">Write to one person at a company first, and wait a week before writing to a second. Every note is a draft: make it yours.</p>` : ""}
${people || `<p class="muted">${skippedWeak(r) ? "A weak fit: people were not looked up, to save credits (run with --all to include weak fits)." : r.job.company.id === null ? "No company record, so no people search." : "Nobody found at this company for these searches."}</p>`}
${noAlumni}
<section class="card"><h3>Your notes</h3><textarea id="mynote" rows="3" placeholder="Anything to remember about this job">${esc(note)}</textarea><button id="savenote" class="btn" type="button">Save note</button></section>
<p class="foot">Drafts only. Nothing is sent from here: copy a note, edit it, and send it yourself.</p>`;
}

const CSS = `
:root{--bg:#f6f6f8;--card:#fff;--ink:#16161d;--mute:#6b6b78;--line:#e6e6ec;--accent:#5644ED;--good:#127a4a;--mid:#8a5a00;--bad:#b42318}
*{box-sizing:border-box}html{scrollbar-width:thin;scrollbar-color:#c4c4cc transparent}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#c4c4cc;border-radius:8px}::-webkit-scrollbar-track{background:transparent}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}
header{display:flex;align-items:center;gap:16px;padding:14px 24px;background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
header .brand{font-weight:650;letter-spacing:-.01em}header .sum{color:var(--mute);font-size:13px;flex:1}
select,textarea{font:inherit;border:1px solid var(--line);border-radius:10px;padding:7px 10px;background:#fff;color:var(--ink)}
.wrap{display:grid;grid-template-columns:minmax(300px,380px) 1fr;height:calc(100vh - 57px)}
.list{overflow-y:scroll;border-right:1px solid var(--line);background:#fff;padding:8px}
.row{display:grid;grid-template-columns:22px 40px 1fr auto;gap:10px;align-items:center;padding:10px 10px;border-radius:12px;text-decoration:none}
.row:hover{background:#f3f3f6}.row.sel{background:#eeeef3}
.rank{color:var(--mute);font-size:12px;text-align:right}
.score{font-weight:650;font-variant-numeric:tabular-nums;text-align:center;border-radius:8px;padding:3px 0;font-size:13px}
.score.strong,.big.strong{color:var(--good)}.score.possible,.big.possible{color:var(--mid)}.score.weak,.big.weak{color:var(--bad)}
.score.strong{background:#e7f5ee}.score.possible{background:#fbf1de}.score.weak{background:#fde9e7}
.what{display:flex;flex-direction:column;min-width:0}.what .t{font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.what .c{color:var(--mute);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{display:flex;gap:4px;flex-direction:column;align-items:flex-end}
.tag{font-size:11.5px;padding:2px 7px;border-radius:999px;background:#f0f0f4;color:#3d3d48;white-space:nowrap}
.tag.growing{background:#e7f5ee;color:var(--good)}.tag.shrinking{background:#fde9e7;color:var(--bad)}.tag.st{background:#16161d;color:#fff}.tag.seen{color:var(--mute)}
main{overflow-y:scroll;padding:24px 32px 48px}
.head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px}
h1{font-size:22px;letter-spacing:-.02em;margin:0 0 4px;line-height:1.25}.co{color:var(--mute)}
h2{font-size:15px;margin:28px 0 10px}h3{font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:0 0 10px;font-weight:600}
.actions{display:flex;gap:8px;align-items:center;flex-shrink:0}
.btn{display:inline-block;border:1px solid var(--ink);background:var(--ink);color:#fff;border-radius:10px;padding:7px 12px;text-decoration:none;font:inherit;font-weight:550;cursor:pointer}
.grid{display:grid;grid-template-columns:290px 1fr 1fr;gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:0 1px 2px rgba(16,16,24,.04);margin-bottom:12px}
.card p{margin:0 0 8px}.card ul{margin:0;padding-left:18px}.card li{margin:2px 0}
.big{font-size:40px;font-weight:700;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}.big small{font-size:14px;color:var(--mute);font-weight:500}
.label{font-weight:600;margin:6px 0 12px}
.bar{display:grid;grid-template-columns:98px 1fr 46px;gap:8px;align-items:center;font-size:12.5px;margin:5px 0}.bar span{color:var(--mute)}.bar b{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}.bar b small{color:var(--mute);font-weight:400}
.track{height:6px;background:#efeff3;border-radius:6px;overflow:hidden}.track i{display:block;height:100%;background:var(--ink);border-radius:6px}
.pen{margin-top:8px;color:var(--bad);font-size:12.5px;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px}.chips .k{font-size:12px;color:var(--mute);margin-right:2px}
.chip{font-size:12px;padding:2px 8px;border-radius:999px;background:#f0f0f4}.chip.off{background:#fff;border:1px dashed #cfcfd8;color:#4a4a55}
.flags{margin-top:12px;border-radius:10px;background:#fff6ed;color:#7a3e00;padding:8px 10px;font-size:13px}
.person{display:grid;grid-template-columns:minmax(200px,280px) 1fr;gap:16px;padding:12px 0;border-top:1px solid #f0f0f4}.person:first-of-type{border-top:0;padding-top:0}
.firsttag{display:inline-block;font-size:11.5px;font-weight:600;color:#fff;background:var(--ink);border-radius:999px;padding:1px 8px;margin-bottom:4px}
.name{font-weight:600}.name a{text-decoration:none;border-bottom:1px solid #cfcfd8}.name a:hover{border-color:var(--ink)}
.role{color:#3d3d48}.sub{color:var(--mute);font-size:12.5px}.mono{font-family:ui-monospace,Menlo,monospace}
.note{display:flex;gap:10px;align-items:flex-start;background:#f7f7fa;border-radius:12px;padding:10px 12px}.note p{margin:0;flex:1;color:#2b2b35}
.copy{border:1px solid var(--line);background:#fff;border-radius:8px;padding:4px 9px;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}.copy.done{background:var(--ink);color:#fff;border-color:var(--ink)}
.muted{color:var(--mute)}.foot{color:var(--mute);font-size:12.5px;margin-top:24px}
textarea{width:100%;margin-bottom:8px;resize:vertical}
.md h4{margin:12px 0 4px;font-size:14px}.md p{margin:0 0 6px}.md blockquote{margin:6px 0;padding:8px 12px;background:#f7f7fa;border-radius:10px}
.empty{max-width:560px;margin:80px auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:28px}
.empty code{background:#f0f0f4;padding:2px 6px;border-radius:6px}
@media (max-width:900px){.wrap{grid-template-columns:1fr;height:auto}.list{max-height:40vh}.grid{grid-template-columns:1fr}.person{grid-template-columns:1fr}}
`;

const JS = `
document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{
  const t=document.getElementById(b.dataset.copy).textContent;
  try{await navigator.clipboard.writeText(t);}catch(e){const r=document.createRange();r.selectNodeContents(document.getElementById(b.dataset.copy));const s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('copy');}
  b.textContent='Copied';b.classList.add('done');setTimeout(()=>{b.textContent='Copy note';b.classList.remove('done')},1500);
}));
const st=document.getElementById('status');
async function save(body){const r=await fetch('/api/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)alert('Could not save: '+(await r.text()));return r.ok}
if(st){st.addEventListener('change',async()=>{if(await save({jobId:st.dataset.job,status:st.value}))location.reload()});}
const sn=document.getElementById('savenote');
if(sn){sn.addEventListener('click',async()=>{if(await save({jobId:st.dataset.job,status:st.value,note:document.getElementById('mynote').value})){sn.textContent='Saved';setTimeout(()=>sn.textContent='Save note',1500)}});}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}<script>${JS}</script></body></html>`;
}

export function dashboardApp(store: Store, outDir: string): Hono {
  const app = new Hono();

  // Only answer to localhost names, so a web page that points its own domain at 127.0.0.1 cannot read your runs.
  // No framing, and the page may only talk to itself.
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return c.text("Open the dashboard at http://localhost", 403);
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
  });

  app.get("/health", c => c.json({ ok: true, runs: listRuns(outDir).length }));

  app.get("/api/runs", c => c.json(listRuns(outDir)));

  app.get("/api/runs/:id", c => {
    const run = readRun(outDir, c.req.param("id"));
    if (!run) return c.json({ error: "No such run" }, 404);
    const statuses = Object.fromEntries(store.statuses());
    return c.json({ ...run, statuses });
  });

  app.post("/api/status", async c => {
    // Only this page may change a status: a request from another website carries its own Origin.
    const origin = c.req.header("origin");
    const host = c.req.header("host");
    // Browsers send Origin (or Sec-Fetch-Site) on every POST; a request with neither is not from this page.
    let sameSite = !origin && c.req.header("sec-fetch-site") === "same-origin";
    try { if (origin) sameSite = new URL(origin).origin === `http://${host}`; } catch { sameSite = false; }
    if (!sameSite) return c.text("Not allowed from another site", 403);
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.text("Send JSON", 415);
    if (Number(c.req.header("content-length") ?? 0) > 16_384) return c.text("Too large", 413);
    let body: { jobId?: unknown; status?: unknown; note?: unknown };
    const raw = await c.req.text();
    if (raw.length > 16_384) return c.text("Too large", 413);
    try { body = JSON.parse(raw); } catch { return c.text("Send JSON", 400); }
    const jobId = typeof body.jobId === "string" && JOB_ID.test(body.jobId) ? body.jobId : null;
    const status = typeof body.status === "string" && (STATUSES as readonly string[]).includes(body.status) ? body.status as Status : null;
    const note = typeof body.note === "string" ? body.note.slice(0, 4000) : undefined;
    if (!jobId || !status) return c.text(`jobId and a status (${STATUSES.join(", ")}) are needed`, 400);
    store.setStatus(jobId, status, note);
    return c.json({ ok: true });
  });

  app.get("/", c => {
    const runs = listRuns(outDir);
    if (!runs.length) {
      return c.html(page("Job hunt", `<div class="empty"><h1>No runs yet</h1><p>Run a search first, then reload this page:</p><p><code>npm run hunt -- --title "software engineer" --location "San Francisco"</code></p><p class="muted">Or try it on one job: <code>npm run job -- &lt;posting URL&gt;</code></p><p class="muted">Just looking? <code>npm run replay -- fixtures/hunt-sf.json</code> shows a sample report in the terminal, with no key.</p></div>`));
    }
    const wanted = c.req.query("run");
    const runId = wanted && runs.some(r => r.id === wanted) ? wanted : runs[0].id;
    const run = readRun(outDir, runId);
    if (!run || !Array.isArray(run.jobs)) return c.html(page("Job hunt", `<div class="empty"><h1>Could not read ${esc(runId)}</h1><p>Its jobs.json is missing or broken. Run the search again.</p></div>`), 500);
    const statuses = store.statuses();
    const jobId = c.req.query("job");
    const sel = run.jobs.find(r => r.job.id === jobId) ?? run.jobs[0];
    // A status set on one listing of a role follows it to the listing kept in later runs.
    const entry = (r: JobResult) => [r.job.id, ...(r.job.aliases ?? [])].map(id => statuses.get(id)).filter(Boolean)
      .sort((a, b) => String(b!.updatedAt).localeCompare(String(a!.updatedAt)))[0];
    const st = (r: JobResult) => entry(r)?.status ?? "new";
    const s = run.search;
    const where = run.kind === "job" ? "one job" : s.remote === "only" ? `remote, ${s.country}` : `${s.location}${s.remote === "also" ? " + remote" : ""}`;
    const header = `<header><span class="brand">Job hunt</span>
  <span class="sum">${run.kind === "hunt" ? `${esc(s.titles.join(" or "))} · ${esc(where)} · ` : ""}${run.jobs.length} job${run.jobs.length === 1 ? "" : "s"} · ${esc(fmtCredits(run.credits))} credits · ${esc(new Date(run.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }))}</span>
  <select aria-label="Run" onchange="location.href='/?run='+encodeURIComponent(this.value)">${runs.map(r => `<option value="${esc(r.id)}"${r.id === runId ? " selected" : ""}>${esc(r.id)}</option>`).join("")}</select>
</header>`;
    const list = `<nav class="list" aria-label="Jobs">${run.jobs.map((r, i) => jobRow(r, i, runId, r === sel, st(r))).join("")}</nav>`;
    const main = sel
      ? `<main>${detail(sel, run, readAi(outDir, runId, sel.job.id), st(sel), entry(sel)?.note ?? "")}</main>`
      : `<main><p class="muted">This run found no jobs.</p></main>`;
    return c.html(page(sel ? `${sel.job.title} at ${sel.job.company.name}` : "Job hunt", `${header}<div class="wrap">${list}${main}</div>`));
  });

  return app;
}

// Started directly: serve on 127.0.0.1.
if (process.argv[1] && /dashboard\.ts$/.test(process.argv[1])) {
  await import("./node-check.js");
  const { config } = await import("./config.js");
  const { serve } = await import("@hono/node-server");
  const { Store } = await import("./store.js");
  const store = new Store(config.dbPath);
  const port = config.dashboardPort;
  const server = serve({ fetch: dashboardApp(store, config.outDir).fetch, port, hostname: "127.0.0.1" }, () => {
    console.log(`Dashboard: http://localhost:${port}  (reads ${config.outDir}; Ctrl+C to stop)`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${port} is busy. Set DASHBOARD_PORT=3481 in .env (or stop what uses ${port}) and run again.` : `Could not start the dashboard: ${err.message}`);
    process.exit(1);
  });
}
