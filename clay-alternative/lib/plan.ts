// The planner: pure, no I/O. Rows and columns in; the unique people and companies to look up, the field groups each
// call needs, and the credit estimate out. Fully tested on fixtures.

import { fieldsFor } from "./columns";
import { emailDomain } from "./normalize";
import type { Account, Column, Estimate, EstimateLine, InputRow, Plan, Prices } from "./types";

export const MAX_ROWS_DEFAULT = 500;

export function plan(rows: InputRow[], columns: Column[], account: Account): Plan {
  const f = fieldsFor(columns);
  const anyCompany = f.identify || f.companyEnrich;
  const anyPerson = f.personEnrich;
  const urls = new Set<string>(), emails = new Set<string>(), domains = new Set<string>(), names = new Set<string>();
  let companiesFromPeople = 0;
  const problems: Array<{ line: number; reason: string }> = [];
  const warnings: string[] = [];

  for (const row of rows) {
    if (!row.id) { problems.push({ line: row.line, reason: row.problem ?? "No identifier" }); continue; }
    const id = row.id;
    if (id.kind === "profile_url") {
      if (anyPerson || anyCompany) urls.add(id.value);
      if (anyCompany && !row.companyId) companiesFromPeople++;
    } else if (id.kind === "email") {
      if (anyPerson || (anyCompany && id.personal && !row.companyId)) emails.add(id.value);
      if (anyCompany) {
        if (row.companyId) domains.add(row.companyId.value);
        else if (!id.personal) domains.add(emailDomain(id.value));
        else companiesFromPeople++;
      }
    } else if (id.kind === "domain") {
      if (anyCompany) domains.add(id.value);
    } else if (id.kind === "company_name") {
      if (anyCompany) names.add(id.value);
    }
    if (row.companyId && anyCompany) domains.add(row.companyId.value);
  }

  if (anyPerson && !urls.size && !emails.size && usableRows(rows) > 0) warnings.push("Person columns are ticked, but no row has an email or a profile URL, so they will stay empty.");
  else if (anyPerson) {
    const named = rows.filter(r => r.personNameOnly).length;
    if (named) warnings.push(`${named} ${named === 1 ? "row names" : "rows name"} a person but ${named === 1 ? "has" : "have"} no email or profile URL; matching by name alone is not in this version, so their person columns stay empty.`);
  }
  const emailColumnBlocked = f.email && !account.emailColumn;
  if (emailColumnBlocked) warnings.push("The Work email column needs contact data enabled on your Crustdata account; self-serve keys do not have it. It is left empty in this run.");
  if (emails.size && account.emailLookup === false) warnings.push("Your key cannot look people up by email address, so email rows get no person columns. Add profile URLs, or contact Crustdata to enable email lookup.");
  const personFields = f.person.filter(g => !(emailColumnBlocked && g === "contact.business_emails"));

  const people = urls.size + emails.size;
  const lazyEmails = new Set(rows.filter(r => r.id?.kind === "email" && !r.id.personal && !r.companyId).map(r => r.id!.value)).size;
  const companies = domains.size + names.size;
  const usable = rows.length - problems.length;
  const wantEmail = f.email && !emailColumnBlocked;
  const lines = (p: Prices): EstimateLine[] => {
    const out: EstimateLine[] = [];
    if (anyPerson && people) out.push({ label: "person lookups", count: people, each: p.personEnrich, credits: people * p.personEnrich });
    if (wantEmail && people) out.push({ label: "work emails", count: people, each: p.businessEmail, credits: people * p.businessEmail });
    if (f.companyEnrich && companies + companiesFromPeople) {
      const n = companies + companiesFromPeople;
      out.push({ label: "company profiles", count: n, each: p.companyEnrich, credits: n * p.companyEnrich });
      if (f.tech) out.push({ label: "tech stacks", count: n, each: p.technographics, credits: n * p.technographics });
    }
    if (!anyPerson && people) out.push({ label: "person lookups (to find the employer)", count: people, each: p.personEnrich, credits: people * p.personEnrich });
    if (!anyPerson && anyCompany && lazyEmails) out.push({ label: "person lookups, only for work emails whose domain is not the company's own (worst case)", count: lazyEmails, each: p.personEnrich, credits: lazyEmails * p.personEnrich });
    return out;
  };
  const own = lines(account.prices), list = lines(account.listPrices);
  const sum = (l: EstimateLine[]) => Math.round(l.reduce((a, x) => a + x.credits, 0) * 100) / 100;
  const notes: string[] = [];
  if (f.companyEnrich && companiesFromPeople) notes.push(`${companiesFromPeople} ${companiesFromPeople === 1 ? "row is" : "rows are"} counted as one company each until the profile names the employer; the real number is usually lower`);
  if (anyCompany && lazyEmails) notes.push(`a work email whose domain is not the company's own ${f.companyEnrich ? "adds one company profile on top, " : "is resolved "}through the person's profile${anyPerson ? "" : " (one person lookup each, counted above as the worst case)"}`);
  const estimate: Estimate = {
    rows: rows.length, usable, people, companies, companiesFromPeople,
    credits: sum(own), listCredits: sum(list), lines: own, listLines: list,
    note: notes.length ? notes.join("; ").replace(/^./, c => c.toUpperCase()) + "." : "",
  };
  return {
    columns, rows,
    people: { urls: [...urls], emails: [...emails] },
    companies: { domains: [...domains], names: [...names] },
    personFields,
    companyFields: f.company,
    needsPersonEnrich: anyPerson || ((urls.size + emails.size) > 0 && anyCompany),
    needsCompanyEnrich: f.companyEnrich,
    needsIdentify: anyCompany,
    estimate, problems, warnings,
  };
}

const usableRows = (rows: InputRow[]) => rows.filter(r => r.id).length;

/** One line for the page and the CLI: "312 rows, 140 companies, 300 people: up to 740 credits". */
export function describeEstimate(e: Estimate, pricing: "shown" | "hidden"): string {
  const skipped = e.rows - e.usable;
  const parts = [`${e.rows} ${e.rows === 1 ? "row" : "rows"}${skipped ? ` (${skipped} without an identifier)` : ""}`];
  if (e.companies + e.companiesFromPeople) parts.push(`${e.companies + e.companiesFromPeople} ${e.companies + e.companiesFromPeople === 1 ? "company" : "companies"}`);
  if (e.people) parts.push(`${e.people} ${e.people === 1 ? "person" : "people"}`);
  const head = parts.join(", ");
  if (pricing === "hidden") return head;
  if (!e.credits) return `${head}: free`;
  const list = e.listCredits !== e.credits ? ` at your prices (${fmt(e.listCredits)} at list price)` : "";
  return `${head}: up to ${fmt(e.credits)} credits${list}`;
}

export const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
