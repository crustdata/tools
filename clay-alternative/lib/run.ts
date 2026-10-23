// Executes a plan: people and companies in parallel, cache first, 25 per call, events after every batch.
//
//   people:     POST /person/enrich by profile URL and by business email -> person columns, and the employer's domain
//               for rows that have no company of their own (profile URL rows, personal email rows)
//   companies:  POST /company/identify (free) -> id and the free columns; POST /company/enrich -> the paid columns
//   then:       the employers found through people go through the company steps too
//
// Nothing here guesses: a cell is filled only from a matched record, and its source is the endpoint and field path.

import { BATCH, CrustdataError, type Client, type PersonResult } from "./crustdata";
import { covers, enrichKey, identifyKey, personKey } from "./cache";
import { outcome } from "./export";
import { currentRole, sourceLabel } from "./columns";
import { hostOf, nameKey, normalizeDomain, normalizeProfileUrl } from "./normalize";
import type { RunEvent, Summary } from "./events";
import { PLATFORM_HOSTS } from "./personal-domains";
import type { Account, Cache, CacheEntry, Cell, CellStatus, Column, CostSummary, Plan, RowStatus } from "./types";

export type RunOptions = {
  client: Client;
  cache: Cache;
  account: Account;
  emit: (e: RunEvent) => void;
  signal?: AbortSignal;
  /** Stop before the next paid call once this many credits have been spent in this run. People and companies run side by side, so the cap can be passed by one batch of each (at most 25 people and 25 companies). */
  maxCredits?: number;
  /** Ignore the cache and call Crustdata again. */
  refresh?: boolean;
  /** Treat cached records older than this as misses (the CLI's --max-age). */
  maxAgeDays?: number;
  pricing?: "shown" | "hidden";
  /** Read credits remaining at the end (one free call). */
  readRemaining?: boolean;
  now?: () => Date;
};

export type RunResult = {
  cells: Map<number, Record<string, Cell>>;
  status: Map<number, RowStatus>;
  cost: CostSummary;
  summary: Summary;
  droppedGroups: string[];
};

export class BudgetError extends Error {}

type IdentifyData = { id: number | null; record: any; confidence?: number; note?: string };

export async function runPlan(p: Plan, o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const now = o.now ?? (() => new Date());
  const pricing = o.pricing ?? "shown";
  const cells = new Map<number, Record<string, Cell>>();
  const status = new Map<number, RowStatus>();
  const personColumns = p.columns.filter(c => c.group === "Person");
  const identifyColumns = p.columns.filter(c => c.source.kind === "identify");
  const enrichColumns = p.columns.filter(c => c.source.kind === "company_enrich" || c.source.kind === "company_premium");
  const companyColumns = [...identifyColumns, ...enrichColumns];
  const emailBlocked = p.columns.some(c => c.source.kind === "person_premium") && !o.account.emailColumn;
  let cachedCredits = 0;
  const droppedGroups = new Set<string>();

  const cost = (): CostSummary => ({ credits: o.client.spend.credits, byEndpoint: { ...o.client.spend.byEndpoint }, cached: round(cachedCredits), calls: o.client.spend.calls });
  const emitCost = () => o.emit({ type: "cost", cost: cost() });
  const checkBudget = () => {
    if (o.signal?.aborted) throw new Error("Stopped.");
    if (o.maxCredits !== undefined && o.client.spend.credits >= o.maxCredits) throw new BudgetError(pricing === "hidden" ? "Stopped at this deployment's credit cap for one run. Paste your own key to run the rest." : `Stopped at the credit cap for this run (${o.maxCredits} credits). Raise MAX_CREDITS_PER_RUN or run again: results so far are cached.`);
  };

  // Which rows each identifier serves.
  const rowsByUrl = new Map<string, number[]>(), rowsByEmail = new Map<string, number[]>();
  const rowsByDomain = new Map<string, number[]>(), rowsByName = new Map<string, number[]>();
  const add = <K,>(m: Map<K, number[]>, k: K, i: number) => { const l = m.get(k); if (l) { if (!l.includes(i)) l.push(i); } else m.set(k, [i]); };
  p.rows.forEach((row, i) => {
    if (!row.id) return;
    if (row.id.kind === "profile_url" && p.people.urls.includes(row.id.value)) add(rowsByUrl, row.id.value, i);
    if (row.id.kind === "email" && p.people.emails.includes(row.id.value)) add(rowsByEmail, row.id.value, i);
    if (row.id.kind === "domain") add(rowsByDomain, row.id.value, i);
    if (row.id.kind === "company_name") add(rowsByName, row.id.value, i);
    if (row.companyId) add(rowsByDomain, row.companyId.value, i);
    else if (row.id.kind === "email" && !row.id.personal && p.needsIdentify) add(rowsByDomain, row.id.value.slice(row.id.value.indexOf("@") + 1), i);
  });

  const mergeCells = (i: number, patch: Record<string, Cell>, st?: Partial<RowStatus>) => {
    const cur = cells.get(i) ?? {};
    Object.assign(cur, patch);
    cells.set(i, cur);
    const s = status.get(i) ?? {};
    if (st) Object.assign(s, st);
    status.set(i, s);
    o.emit({ type: "cells", row: i, cells: patch, status: s });
  };

  const fill = (columns: Column[], record: any, st: CellStatus, note?: string, confidence?: number, domain?: string, at?: string): Record<string, Cell> => {
    const out: Record<string, Cell> = {};
    for (const c of columns) {
      if (c.source.kind === "person_premium" && emailBlocked) { out[c.id] = { value: null, status: "needs_access", note: "Contact data needs enabling on your Crustdata account; self-serve keys do not have it." }; continue; }
      if (st !== "matched" || !record) { out[c.id] = { value: null, status: st, note }; continue; }
      let value: string | number | null = null;
      try { value = c.pick(record, { domain }); } catch { value = null; }
      out[c.id] = { value, status: "matched", source: sourceLabel(c), confidence, note: value === null ? "No value in the record" : note, at: at?.slice(0, 10) };
    }
    return out;
  };

  o.emit({ type: "start", rows: p.rows.length, columns: p.columns.map(c => c.id), estimate: p.estimate, warnings: p.warnings, problems: p.problems, pricing });
  if (p.people.urls.length + p.people.emails.length) o.emit({ type: "progress", phase: "people", done: 0, total: p.people.urls.length + p.people.emails.length });
  if (p.companies.domains.length + p.companies.names.length) o.emit({ type: "progress", phase: "companies", done: 0, total: p.companies.domains.length + p.companies.names.length });

  // Rows that cannot be enriched at all, and person columns on rows that only name a company.
  p.rows.forEach((row, i) => {
    if (!row.id) {
      const st: CellStatus = row.problem?.startsWith("Not a") ? "invalid" : "no_identifier";
      mergeCells(i, fill(p.columns, null, st, row.problem), { person: st, company: st, note: row.problem });
    } else if ((row.id.kind === "domain" || row.id.kind === "company_name") && personColumns.length) {
      mergeCells(i, fill(personColumns, null, "no_identifier", "No email or profile URL in this row"), { person: "no_identifier" });
    }
  });

  const counts: Summary = { rows: p.rows.length, matched: 0, partial: 0, unresolved: 0, people: { matched: 0, not_found: 0, redacted: 0, invalid: 0, ambiguous: 0 }, companies: { matched: 0, not_found: 0, ambiguous: 0 } };
  const later = new Map<string, number[]>(); // employer domains found through people -> rows
  const pendingCompany = new Map<number, string | undefined>(); // work-email rows whose domain found nothing, waiting for the profile's employer
  const companyKeys = new Map<string, CellStatus>(); // one final status per company identifier, for the summary
  let peopleDone = 0, companiesDone = 0, companiesTotal = p.companies.domains.length + p.companies.names.length;

  // ---------------------------------------------------------------- people
  async function people() {
    const total = p.people.urls.length + p.people.emails.length;
    if (!total) return;
    if (p.people.emails.length && o.account.emailLookup === false) {
      for (const [email, rows] of rowsByEmail) {
        for (const i of rows) mergeCells(i, fill(personColumns, null, "needs_access", "Email lookup is not enabled for this key"), { person: "needs_access" });
        peopleDone++;
        void email;
      }
      if (!p.people.urls.length) return;
    }
    const jobs: Array<{ kind: "url" | "email"; values: string[] }> = [];
    for (let i = 0; i < p.people.urls.length; i += BATCH) jobs.push({ kind: "url", values: p.people.urls.slice(i, i + BATCH) });
    if (o.account.emailLookup !== false) for (let i = 0; i < p.people.emails.length; i += BATCH) jobs.push({ kind: "email", values: p.people.emails.slice(i, i + BATCH) });
    for (const job of jobs) {
      const need: string[] = [];
      for (const v of job.values) {
        const hit = o.refresh ? undefined : await o.cache.get(personKey(job.kind, v));
        if (covers(hit, p.personFields, o.maxAgeDays)) { cachedCredits += hit.credits; await handlePerson(job.kind, v, hit); } else need.push(v);
      }
      if (need.length) {
        checkBudget();
        const r = await o.client.enrichPeople(job.kind === "url" ? { urls: need } : { emails: need }, p.personFields);
        for (const g of r.dropped) droppedGroups.add(g);
        // Results are matched to inputs by identifier only, never by position: a swapped row would poison the cache.
        const byKey = new Map<string, PersonResult>();
        const keyOf = (x: string) => (job.kind === "url" ? normalizeProfileUrl(x) ?? x.trim().toLowerCase() : x.trim().toLowerCase());
        for (const res of r.results) byKey.set(keyOf(String(res.matched_on ?? "")), res);
        for (const v of need) {
          const res = byKey.get(keyOf(v));
          const raw = res?.match_status ?? (res ? (res.matches?.length ? "matched" : "not_found") : "error");
          const st: CellStatus = raw === "matched" || raw === "not_found" || raw === "redacted" || raw === "invalid" ? raw : "error";
          const m = res?.matches?.[0];
          const data = st === "matched" && m ? m.person_data : null;
          const credits = st === "matched" ? o.account.prices.personEnrich + (p.personFields.includes("contact.business_emails") && data?.contact?.business_emails?.length ? o.account.prices.businessEmail : 0) : 0;
          const entry: CacheEntry = { data: data ? { record: data, confidence: m?.confidence_score, note: st === "error" ? `Crustdata returned ${res ? `status ${raw}` : "no result"} for this identifier` : undefined } : null, status: st, credits, at: now().toISOString(), fields: p.personFields };
          if (st === "error") entry.data = { record: null, note: res ? `Crustdata returned status ${raw}` : "Crustdata returned no result for this identifier" };
          // An error is not cached: the next run should try again.
          if (st !== "error") await o.cache.set(personKey(job.kind, v), entry);
          await handlePerson(job.kind, v, entry);
        }
        emitCost();
      }
      o.emit({ type: "progress", phase: "people", done: peopleDone, total });
    }
  }

  async function handlePerson(kind: "url" | "email", value: string, entry: CacheEntry) {
    peopleDone++;
    const rows = (kind === "url" ? rowsByUrl : rowsByEmail).get(value) ?? [];
    const st = entry.status as CellStatus;
    const data = entry.data as { record: any; confidence?: number; note?: string } | null;
    if (st in counts.people) counts.people[st as keyof Summary["people"]]++;
    const note = st === "not_found" ? "No person with this identifier in Crustdata" : st === "redacted" ? "Removed at the person's request" : st === "invalid" ? "Crustdata rejected this identifier" : st === "error" ? data?.note ?? "Crustdata returned no result" : undefined;
    for (const i of rows) {
      const row = p.rows[i];
      const patch = fill(personColumns, data?.record, st, note, data?.confidence, undefined, entry.at);
      const rs: Partial<RowStatus> = { person: st, confidence: data?.confidence };
      // A row with no company of its own gets the person's current employer.
      const employer = st === "matched" ? normalizeDomain(currentRole(data?.record)?.company_website_domain ?? "") : null;
      if (employer && companyColumns.length) rs.employerDomain = employer;
      const needsEmployer = companyColumns.length && !row.companyId && (row.id!.kind === "profile_url" || (row.id!.kind === "email" && row.id!.personal));
      if (needsEmployer) {
        if (employer) add(later, employer, i);
        else Object.assign(patch, fill(companyColumns, null, "not_found", st === "matched" ? "The profile lists no employer domain" : "No person matched, so no employer to look up")), rs.company = "not_found";
      }
      if (row.id!.kind === "email" && row.id!.personal && !row.companyId) rs.note = "Personal email: the company comes from the profile, not the address";
      mergeCells(i, patch, rs);
    }
  }

  // ---------------------------------------------------------------- companies
  async function companies(domains: string[], names: string[], rowsFor: (kind: "domain" | "name", v: string) => number[], pass: 1 | 2 = 1) {
    const ids = new Map<number, number[]>(); // company id -> rows waiting for enrich
    const resolved: Array<{ kind: "domain" | "name"; value: string; data: IdentifyData; status: CellStatus }> = [];
    const jobs: Array<{ kind: "domain" | "name"; values: string[] }> = [];
    for (let i = 0; i < domains.length; i += BATCH) jobs.push({ kind: "domain", values: domains.slice(i, i + BATCH) });
    for (let i = 0; i < names.length; i += BATCH) jobs.push({ kind: "name", values: names.slice(i, i + BATCH) });
    for (const job of jobs) {
      const need: string[] = [];
      const got = new Map<string, CacheEntry>();
      for (const v of job.values) {
        const hit = o.refresh ? undefined : await o.cache.get(identifyKey(job.kind, v));
        if (covers(hit, [], o.maxAgeDays)) got.set(v, hit); else need.push(v);
      }
      if (need.length) {
        if (o.signal?.aborted) throw new Error("Stopped.");
        const results = (await o.client.identifyCompanies(job.kind === "domain" ? { domains: need } : { names: need })).filter(r => r && typeof r === "object");
        const byKey = new Map(results.map(r => [String(r.matched_on ?? "").toLowerCase(), r]));
        need.forEach((v, idx) => {
          const res = byKey.get(v.toLowerCase()) ?? (results.length === need.length ? results[idx] : undefined);
          const picked = job.kind === "domain" ? pickDomainMatch(res?.matches ?? [], v) : pickNameMatch(res?.matches ?? [], v);
          got.set(v, { data: picked.data, status: picked.status, credits: 0, at: now().toISOString() });
        });
        for (const [v, e] of got) if (need.includes(v)) await o.cache.set(identifyKey(job.kind, v), e);
      }
      for (const v of job.values) {
        const e = got.get(v)!;
        const data = e.data as IdentifyData;
        const st = e.status as CellStatus;
        resolved.push({ kind: job.kind, value: v, data, status: st });
        companyKeys.set(`${job.kind}:${v.toLowerCase()}`, st);
        const rows = rowsFor(job.kind, v);
        for (const i of rows) {
          const row = p.rows[i];
          // A work email whose domain found no company may still get one from the person's profile: leave it open for the fallback.
          if (pass === 1 && st !== "matched" && job.kind === "domain" && row.id?.kind === "email" && !row.id.personal && !row.companyId) { pendingCompany.set(i, data.note); continue; }
          const patch = fill(identifyColumns, data.record, st, data.note, data.confidence, job.kind === "domain" ? v : undefined, e.at);
          if (st !== "matched" || !p.needsCompanyEnrich) Object.assign(patch, fill(enrichColumns, null, st === "matched" ? "not_found" : st, data.note));
          mergeCells(i, patch, { company: st, confidence: data.confidence ?? status.get(i)?.confidence, note: data.note ?? status.get(i)?.note });
        }
        if (st === "matched" && data.id !== null && p.needsCompanyEnrich) for (const i of rows) add(ids, data.id, i);
        if (!p.needsCompanyEnrich || st !== "matched") companiesDone++;
      }
      o.emit({ type: "progress", phase: "companies", done: companiesDone, total: companiesTotal });
    }
    if (!p.needsCompanyEnrich) return;
    const list = [...ids.keys()];
    for (let b = 0; b < list.length; b += BATCH) {
      const batch = list.slice(b, b + BATCH);
      const need: number[] = [];
      for (const id of batch) {
        const hit = o.refresh ? undefined : await o.cache.get(enrichKey(id));
        if (covers(hit, p.companyFields, o.maxAgeDays)) { cachedCredits += hit.credits; applyEnrich(id, hit, ids.get(id)!); } else need.push(id);
      }
      if (need.length) {
        checkBudget();
        const r = await o.client.enrichCompanies(need, p.companyFields);
        for (const g of r.dropped) droppedGroups.add(g);
        const byId = new Map(r.results.filter(x => x && typeof x === "object").map(x => [String(x.matched_on ?? ""), x]));
        for (const id of need) {
          const res = byId.get(String(id));
          const m = res?.matches?.[0];
          const data = m?.company_data ?? null;
          const credits = data ? o.account.prices.companyEnrich + (p.companyFields.includes("technographics") && data.technographics ? o.account.prices.technographics : 0) : 0;
          const entry: CacheEntry = { data, status: data ? "matched" : "not_found", credits, at: now().toISOString(), fields: p.companyFields.filter(f => !r.dropped.includes(f)) };
          // A record that is absent only because every asked group was dropped is not a miss: do not remember it.
          if (data || !r.dropped.length) await o.cache.set(enrichKey(id), entry);
          applyEnrich(id, entry, ids.get(id)!);
        }
        emitCost();
      }
      o.emit({ type: "progress", phase: "companies", done: companiesDone, total: companiesTotal });
    }
  }

  function applyEnrich(id: number, entry: CacheEntry, rows: number[]) {
    companiesDone++;
    const data = entry.data as any;
    for (const i of rows) {
      const row = p.rows[i];
      const domain = row.companyId?.value ?? (row.id?.kind === "domain" ? row.id.value : row.id?.kind === "email" && !row.id.personal ? row.id.value.slice(row.id.value.indexOf("@") + 1) : status.get(i)?.employerDomain);
      const patch = fill(enrichColumns, data, data ? "matched" : "not_found", data ? undefined : "The company profile could not be read", status.get(i)?.confidence, domain, entry.at);
      for (const c of enrichColumns) {
        const g = c.source.kind === "company_enrich" || c.source.kind === "company_premium" ? c.source.group : "";
        if (droppedGroups.has(g)) patch[c.id] = { value: null, status: "needs_access", note: `The ${g} group is not enabled for this key` };
      }
      mergeCells(i, patch);
    }
    void id;
  }

  // ---------------------------------------------------------------- run
  const stop = (err: unknown) => {
    const fatal = !(err instanceof BudgetError) && !(err instanceof CrustdataError && err.status !== 401 && err.status !== 402);
    o.emit({ type: "error", message: (err as Error).message, fatal: fatal && !(err instanceof BudgetError) });
    if (!(err instanceof BudgetError)) throw err;
  };
  try {
    const settled = await Promise.allSettled([
      people(),
      companies(p.companies.domains, p.companies.names, (kind, v) => (kind === "domain" ? rowsByDomain : rowsByName).get(v) ?? []),
    ]);
    const failed = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
    if (failed) throw failed.reason;
    // A work email whose domain is not the company's own (a second domain, a brand) falls back to the employer on the profile.
    // Rows whose person was never looked up (no person columns ticked) get one lookup now, only for the employer.
    const lazy = o.account.emailLookup === false ? [] : [...pendingCompany.keys()].filter(i => status.get(i)?.person === undefined && p.rows[i].id?.kind === "email").map(i => p.rows[i].id!.value);
    for (let b = 0; b < lazy.length; b += BATCH) {
      const batch = [...new Set(lazy.slice(b, b + BATCH))];
      const fields = ["basic_profile", "experience"];
      const need: string[] = [];
      const got = new Map<string, CacheEntry>();
      for (const v of batch) { const hit = o.refresh ? undefined : await o.cache.get(personKey("email", v)); if (covers(hit, fields, o.maxAgeDays)) { got.set(v, hit); cachedCredits += hit.credits; } else need.push(v); }
      if (need.length) {
        checkBudget();
        const r = await o.client.enrichPeople({ emails: need }, fields);
        const byKey = new Map(r.results.filter(x => x && typeof x === "object").map(x => [String(x.matched_on ?? "").toLowerCase(), x]));
        for (const v of need) {
          const res = byKey.get(v.toLowerCase());
          const m = res?.matches?.[0];
          const raw = res?.match_status ?? (res ? (res.matches?.length ? "matched" : "not_found") : "error");
          const st: CellStatus = raw === "matched" && m ? "matched" : raw === "not_found" || raw === "redacted" || raw === "invalid" ? raw : "error";
          const entry: CacheEntry = { data: m ? { record: m.person_data, confidence: m.confidence_score } : null, status: st, credits: st === "matched" ? o.account.prices.personEnrich : 0, at: now().toISOString(), fields };
          if (st !== "error") await o.cache.set(personKey("email", v), entry);
          got.set(v, entry);
        }
        emitCost();
      }
      for (const [i] of pendingCompany) {
        const row = p.rows[i];
        const e = row.id?.kind === "email" ? got.get(row.id.value) : undefined;
        if (!e) continue;
        const s = status.get(i) ?? {};
        const employer = e.status === "matched" ? normalizeDomain(currentRole((e.data as any)?.record)?.company_website_domain ?? "") : null;
        if (employer) s.employerDomain = employer;
        status.set(i, s);
      }
    }
    for (const [i, note] of pendingCompany) {
      const row = p.rows[i], s = status.get(i);
      const employer = s?.employerDomain;
      if (employer && employer !== row.id!.value.slice(row.id!.value.indexOf("@") + 1)) {
        add(later, employer, i);
        // The email's domain is resolved after all, through the profile: it is not a miss in the summary.
        companyKeys.delete(`domain:${row.id!.value.slice(row.id!.value.indexOf("@") + 1)}`);
        if (s) s.note = `No company for the email domain; using the employer on the profile (${employer})`;
      } else {
        const why = o.account.emailLookup === false && s?.person === undefined ? `${note ?? "No company for the email domain"}; this key cannot read the profile to find the employer` : note ?? "No company for the email domain";
        mergeCells(i, fill(companyColumns, null, "not_found", why), { company: "not_found", note: why });
      }
    }
    if (later.size) {
      companiesTotal += later.size;
      await companies([...later.keys()], [], (_k, v) => later.get(v) ?? [], 2);
    }
  } catch (err) {
    stop(err);
    // Cells the run never reached are marked, so no row reads as matched on the strength of a free lookup alone.
    p.rows.forEach((row, i) => {
      if (!row.id) return;
      const have = cells.get(i) ?? {};
      const missing = p.columns.filter(c => !have[c.id]);
      if (!missing.length) return;
      const s = status.get(i) ?? {};
      if (missing.some(c => c.group === "Person")) s.person = "error";
      if (missing.some(c => c.group === "Company")) s.company = "error";
      mergeCells(i, fill(missing, null, "error", "Not run: the run stopped before this call"), s);
    });
  }

  for (const st of companyKeys.values()) { if (st === "matched") counts.companies.matched++; else if (st === "ambiguous") counts.companies.ambiguous++; else counts.companies.not_found++; }
  // One rule for every count (lib/export.ts): a row is matched when every entity it has an identifier for matched.
  const hasPerson = personColumns.length > 0, hasCompany = companyColumns.length > 0;
  for (let i = 0; i < p.rows.length; i++) {
    const o = outcome(p.rows[i], status.get(i), hasPerson, hasCompany);
    if (o === "matched") counts.matched++; else if (o === "partial") counts.partial++; else counts.unresolved++;
  }
  const remaining = o.readRemaining ? await o.client.credits().catch(() => null) : null;
  const result: RunResult = { cells, status, cost: cost(), summary: counts, droppedGroups: [...droppedGroups] };
  if (droppedGroups.size) o.emit({ type: "note", message: `Not enabled for this key, left empty: ${[...droppedGroups].join(", ")}.` });
  o.emit({ type: "done", cost: result.cost, remaining, summary: counts, elapsedMs: Date.now() - started });
  return result;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The match whose own domain is the one asked for. Identify can return companies hosted on a platform domain, with full confidence. */
export function pickDomainMatch(matches: Array<{ confidence_score: number; company_data: any }>, domain: string): { data: IdentifyData; status: CellStatus } {
  const d = domain.toLowerCase();
  const own = (c: any): string[] => [c?.basic_info?.primary_domain, ...(Array.isArray(c?.basic_info?.all_domains) ? c.basic_info.all_domains : []), hostOf(c?.basic_info?.website)]
    .filter((x): x is string => typeof x === "string" && x.length > 0).map(x => x.toLowerCase().replace(/^www\./, ""));
  // A subdomain of the company's own domain counts (shop.acme.example); a platform host or a public suffix never does.
  const parentOk = (x: string) => x.split(".").length >= 2 && !PLATFORM_HOSTS.has(x) && !/^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(x) && x.includes(".") && x.split(".")[0].length > 2;
  const hit = matches.find(m => own(m.company_data).includes(d)) ?? matches.find(m => own(m.company_data).some(x => parentOk(x) && d.endsWith(`.${x}`)));
  if (hit) return { data: { id: hit.company_data?.crustdata_company_id ?? null, record: hit.company_data, confidence: hit.confidence_score }, status: "matched" };
  const near = matches[0]?.company_data?.basic_info;
  return { data: { id: null, record: null, note: near ? `No company with the domain ${domain}; closest: ${near.name}${near.primary_domain ? ` (${near.primary_domain})` : ""}` : `No company with the domain ${domain}` }, status: "not_found" };
}

/** A name is accepted only with a clear winner: one company with that exact name, or one much larger than the others. */
export function pickNameMatch(matches: Array<{ confidence_score: number; company_data: any }>, name: string): { data: IdentifyData; status: CellStatus } {
  const k = nameKey(name);
  const exact = matches.filter(m => nameKey(m.company_data?.basic_info?.name ?? "") === k);
  const accept = (m: { confidence_score: number; company_data: any }, note?: string) => ({ data: { id: m.company_data?.crustdata_company_id ?? null, record: m.company_data, confidence: m.confidence_score, note }, status: "matched" as CellStatus });
  if (exact.length === 1) return accept(exact[0]);
  if (exact.length > 1) {
    const size = (m: any) => Number(m.company_data?.headcount?.total ?? 0);
    const sorted = [...exact].sort((a, b) => size(b) - size(a));
    if (size(sorted[0]) >= 10 && size(sorted[0]) >= 3 * Math.max(size(sorted[1]), 1)) return accept(sorted[0], `Largest of ${exact.length} companies named ${name}`);
    return { data: { id: null, record: null, note: `${exact.length} companies are named ${name}; add a domain to pick one` }, status: "ambiguous" };
  }
  if (matches.length >= 1) return { data: { id: null, record: null, note: `No company named exactly ${name}; closest: ${matches.slice(0, 3).map(m => m.company_data?.basic_info?.name).filter(Boolean).join(", ")}` }, status: "ambiguous" };
  return { data: { id: null, record: null, note: `No company named ${name}` }, status: "not_found" };
}
