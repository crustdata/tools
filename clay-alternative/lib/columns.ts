// The column catalogue: every column the tool can fill, each mapped to one Crustdata call, field group and field path.
// Adding a column is one entry here and one test in test/columns.test.ts. The picker, the README table and
// `npm run columns` all render this list.

import type { Column, PickContext, Prices } from "./types";

const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const list = (v: unknown, max = 10): string | null => (Array.isArray(v) && v.length ? v.slice(0, max).map(String).join("; ") : null);
const date = (v: unknown): string | null => (typeof v === "string" && v ? v.slice(0, 10) : null);

/** "series_a" -> "Series A", "secondary_market" -> "Secondary market". */
export const roundName = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const words = s.replace(/_/g, " ").split(" ");
  return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : /^[a-z]$/.test(w) ? w.toUpperCase() : w)).join(" ");
};

/** The person's main current role: the one Crustdata marks as default, else the first current one. */
export const currentRole = (p: any): any => {
  const cur: any[] = p?.experience?.employment_details?.current ?? [];
  return cur.find(r => r?.is_default) ?? cur[0] ?? null;
};

/** The best business email: deliverable first, at the current employer first. */
export const bestEmail = (p: any): string | null => {
  const emails: any[] = p?.contact?.business_emails ?? [];
  if (!emails.length) return null;
  const role = currentRole(p);
  const score = (e: any) => (e.status === "deliverable" ? 2 : e.status === "unknown" ? 1 : 0) + (role && e.crustdata_company_id === role.crustdata_company_id ? 4 : 0);
  return [...emails].sort((a, b) => score(b) - score(a))[0]?.email ?? null;
};

const P = (group: string) => ({ kind: "person_enrich", group } as const);
const C = (group: string) => ({ kind: "company_enrich", group } as const);
const IDENTIFY = { kind: "identify" } as const;

export const COLUMNS: Column[] = [
  // ---- Person: filled from POST /person/enrich (1 credit per matched person; a miss is free) ----
  { id: "person.name", label: "Name", group: "Person", source: P("basic_profile"), path: "basic_profile.name", note: "Full name", pick: p => str(p.basic_profile?.name) },
  { id: "person.title", label: "Title", group: "Person", source: P("basic_profile"), path: "basic_profile.current_title", note: "Current job title", pick: p => str(p.basic_profile?.current_title) ?? str(currentRole(p)?.title) },
  { id: "person.company", label: "Current company", group: "Person", source: P("experience"), path: "experience.employment_details.current[].name", note: "Current employer", pick: p => str(currentRole(p)?.name) },
  { id: "person.company_domain", label: "Company domain", group: "Person", source: P("experience"), path: "experience.employment_details.current[].company_website_domain", note: "Current employer's domain", pick: p => str(currentRole(p)?.company_website_domain) },
  { id: "person.headline", label: "Headline", group: "Person", source: P("basic_profile"), path: "basic_profile.headline", note: "Profile headline", pick: p => str(p.basic_profile?.headline) },
  { id: "person.location", label: "Location", group: "Person", source: P("basic_profile"), path: "basic_profile.location.raw", note: "City, region, country", pick: p => str(p.basic_profile?.location?.raw) ?? str(p.basic_profile?.location?.country) },
  { id: "person.country", label: "Country", group: "Person", source: P("basic_profile"), path: "basic_profile.location.country", note: "Country", pick: p => str(p.basic_profile?.location?.country) },
  { id: "person.seniority", label: "Seniority", group: "Person", source: P("experience"), path: "experience.employment_details.current[].seniority_level", note: "CXO, Vice President, Director, ...", pick: p => str(currentRole(p)?.seniority_level) },
  { id: "person.department", label: "Department", group: "Person", source: P("basic_profile"), path: "basic_profile.normalized_title.department", note: "Department of the current title", pick: p => str(p.basic_profile?.normalized_title?.department) },
  { id: "person.start_date", label: "Started current role", group: "Person", source: P("experience"), path: "experience.employment_details.current[].start_date", note: "When the current role began", pick: p => date(currentRole(p)?.start_date) },
  { id: "person.years_experience", label: "Years of experience", group: "Person", source: P("experience"), path: "experience.years_of_experience_raw", note: "Years of work experience", pick: p => num(p.experience?.years_of_experience_raw) },
  { id: "person.past_employers", label: "Past employers", group: "Person", source: P("experience"), path: "experience.employment_details.past[].name", note: "Up to 8, newest first", pick: p => list([...new Set(((p.experience?.employment_details?.past ?? []) as any[]).map(r => r?.name).filter(Boolean))], 8) },
  { id: "person.education", label: "Education", group: "Person", source: P("education"), path: "education.schools[].school", note: "School and degree", pick: p => list(((p.education?.schools ?? []) as any[]).map(s => [s?.school, [s?.degree, s?.field_of_study].filter(Boolean).join(", ")].filter(Boolean).join(": ")).filter(Boolean), 5) },
  { id: "person.skills", label: "Skills", group: "Person", source: P("skills"), path: "skills.professional_network_skills", note: "Up to 15 listed skills", pick: p => list(p.skills?.professional_network_skills, 15) },
  { id: "person.profile_url", label: "Profile URL", group: "Person", source: P("social_handles"), path: "social_handles.professional_network_identifier.profile_url", note: "Public profile URL", pick: p => str(p.social_handles?.professional_network_identifier?.profile_url) },
  { id: "person.email", label: "Work email", group: "Person", source: { kind: "person_premium", field: "contact.business_emails" }, path: "contact.business_emails[].email", note: "Deliverable address at the current employer", pick: p => bestEmail(p) },

  // ---- Company, free: filled from POST /company/identify (0 credits) ----
  { id: "company.name", label: "Company name", group: "Company", source: IDENTIFY, path: "basic_info.name", note: "Free", pick: c => str(c.basic_info?.name) },
  { id: "company.domain", label: "Domain", group: "Company", source: IDENTIFY, path: "basic_info.primary_domain", note: "Free", pick: c => str(c.basic_info?.primary_domain) },
  { id: "company.website", label: "Website", group: "Company", source: IDENTIFY, path: "basic_info.website", note: "Free", pick: c => str(c.basic_info?.website) },
  { id: "company.description", label: "Description", group: "Company", source: IDENTIFY, path: "basic_info.description", note: "Free", pick: c => str(c.basic_info?.description) },
  { id: "company.year_founded", label: "Year founded", group: "Company", source: IDENTIFY, path: "basic_info.year_founded", note: "Free", pick: c => num(c.basic_info?.year_founded) },
  { id: "company.headcount", label: "Headcount", group: "Company", source: IDENTIFY, path: "headcount.total", note: "Free", pick: c => num(c.headcount?.total) },
  { id: "company.employee_range", label: "Employee range", group: "Company", source: IDENTIFY, path: "basic_info.employee_count_range", note: "Free", pick: c => str(c.basic_info?.employee_count_range) },
  { id: "company.hq", label: "Headquarters", group: "Company", source: IDENTIFY, path: "locations.headquarters", note: "Free", pick: c => str(c.locations?.headquarters) },
  { id: "company.country", label: "Country", group: "Company", source: IDENTIFY, path: "locations.country", note: "ISO 3 code", pick: c => str(c.locations?.country) },
  { id: "company.industry", label: "Industry", group: "Company", source: IDENTIFY, path: "basic_info.industries", note: "Free", pick: c => list(c.basic_info?.industries, 3) },
  { id: "company.type", label: "Company type", group: "Company", source: IDENTIFY, path: "basic_info.company_type", note: "Privately Held, Public Company, ...", pick: c => str(c.basic_info?.company_type) },

  // ---- Company, paid: filled from POST /company/enrich (2 credits per company, once per domain, whatever the columns) ----
  { id: "company.headcount_growth_3m", label: "Headcount growth 3m %", group: "Company", source: C("headcount"), path: "headcount.growth_percent.qoq", note: "Quarter on quarter", pick: c => pct(c.headcount?.growth_percent?.qoq) },
  { id: "company.headcount_growth_6m", label: "Headcount growth 6m %", group: "Company", source: C("headcount"), path: "headcount.growth_percent.six_months", note: "Six months", pick: c => pct(c.headcount?.growth_percent?.six_months) },
  { id: "company.headcount_growth_12m", label: "Headcount growth 12m %", group: "Company", source: C("headcount"), path: "headcount.growth_percent.yoy", note: "Year on year", pick: c => pct(c.headcount?.growth_percent?.yoy) },
  { id: "company.headcount_by_department", label: "Headcount by department", group: "Company", source: C("headcount"), path: "headcount.by_role_absolute", note: "Top 6 departments", pick: c => { const d = c.headcount?.by_role_absolute; if (!d || typeof d !== "object") return null; const top = Object.entries(d as Record<string, number>).filter(([, n]) => typeof n === "number").sort((a, b) => b[1] - a[1]).slice(0, 6); return top.length ? top.map(([k, n]) => `${k} ${n}`).join("; ") : null; } },
  { id: "company.funding_total", label: "Total funding USD", group: "Company", source: C("funding"), path: "funding.total_investment_usd", note: "All rounds", pick: c => num(c.funding?.total_investment_usd) },
  { id: "company.last_round_type", label: "Last round", group: "Company", source: C("funding"), path: "funding.last_round_type", note: "Seed, Series A, ...", pick: c => roundName(c.funding?.last_round_type) },
  { id: "company.last_round_date", label: "Last round date", group: "Company", source: C("funding"), path: "funding.last_fundraise_date", note: "YYYY-MM-DD", pick: c => date(c.funding?.last_fundraise_date) },
  { id: "company.last_round_amount", label: "Last round USD", group: "Company", source: C("funding"), path: "funding.last_round_amount_usd", note: "Amount of the last round", pick: c => num(c.funding?.last_round_amount_usd) },
  { id: "company.investors", label: "Investors", group: "Company", source: C("funding"), path: "funding.investors", note: "Up to 10", pick: c => list(c.funding?.investors, 10) },
  { id: "company.open_roles", label: "Open roles", group: "Company", source: C("hiring"), path: "hiring.openings_count", note: "Open job postings", pick: c => num(c.hiring?.openings_count) },
  { id: "company.hiring_growth_12m", label: "Open roles growth 12m %", group: "Company", source: C("hiring"), path: "hiring.openings_growth_percent.yoy", note: "Year on year", pick: c => { const v = c.hiring?.openings_growth_percent?.yoy; return typeof v === "number" ? pct(v * 100) : null; } },
  { id: "company.hiring_titles", label: "Recent job titles", group: "Company", source: C("hiring"), path: "hiring.recent_openings[].title", note: "Up to 8 recent openings", pick: c => list(((c.hiring?.recent_openings ?? []) as any[]).map(o => o?.title).filter(Boolean), 8) },
  { id: "company.web_traffic", label: "Monthly web visitors", group: "Company", source: C("web_traffic"), path: "web_traffic.domain_traffic[domain].monthly_visitors", note: "Estimated monthly visitors", pick: (c, ctx) => { const t = c.web_traffic?.domain_traffic; if (!t || typeof t !== "object") return null; const entry = (ctx.domain && t[ctx.domain]) ?? (c.basic_info?.primary_domain && t[c.basic_info.primary_domain]) ?? Object.values(t)[0]; return num((entry as any)?.monthly_visitors); } },
  { id: "company.categories", label: "Categories", group: "Company", source: C("taxonomy"), path: "taxonomy.categories", note: "Up to 8 market categories", pick: c => list(c.taxonomy?.categories, 8) },
  { id: "company.founders", label: "Founders", group: "Company", source: C("people"), path: "people.founders[].basic_profile.name", note: "Up to 5", pick: c => list(((c.people?.founders ?? []) as any[]).map(p => p?.basic_profile?.name).filter(Boolean), 5) },
  { id: "company.executives", label: "Executives", group: "Company", source: C("people"), path: "people.cxos[].basic_profile", note: "Up to 6, name and title", pick: c => list(((c.people?.cxos ?? []) as any[]).map(p => p?.basic_profile?.name ? `${p.basic_profile.name} (${p.basic_profile.current_title ?? "CXO"})` : null).filter(Boolean), 6) },
  { id: "company.tech_stack", label: "Tech stack", group: "Company", source: { kind: "company_premium", group: "technographics" }, path: "technographics.top_technologies", note: "+2 credits per company", pick: c => list(c.technographics?.top_technologies, 15) },
];

export const DEFAULT_COLUMNS = [
  "person.name", "person.title", "person.company", "person.location",
  "company.name", "company.headcount", "company.industry", "company.hq", "company.funding_total", "company.last_round_type",
];

/** The default ticks for a file: person columns only when a row has a person identifier, company columns when any row can reach a company. */
export function defaultsFor(counts: { email: number; personal_email: number; profile_url: number; domain: number; company_name: number }, available?: Set<string>): string[] {
  const people = counts.email + counts.personal_email + counts.profile_url > 0;
  const companies = people || counts.domain + counts.company_name > 0;
  return DEFAULT_COLUMNS.filter(id => (!available || available.has(id)) && (id.startsWith("person.") ? people : companies));
}

const byId = new Map(COLUMNS.map(c => [c.id, c]));

export const column = (id: string): Column | undefined => byId.get(id);

/** Resolves ids, failing with the closest names for anything unknown. */
export function resolveColumns(ids: string[]): { columns: Column[]; unknown: Array<{ id: string; closest: string[] }> } {
  const columns: Column[] = [];
  const unknown: Array<{ id: string; closest: string[] }> = [];
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (!id) continue;
    const c = byId.get(id) ?? COLUMNS.find(x => x.label.toLowerCase() === id);
    if (c) { if (!columns.includes(c)) columns.push(c); continue; }
    unknown.push({ id: raw, closest: closest(id) });
  }
  return { columns, unknown };
}

function closest(id: string): string[] {
  const needle = id.replace(/[^a-z]/g, "");
  return COLUMNS.map(c => ({ id: c.id, score: similarity(needle, c.id.replace(/[^a-z]/g, "")) }))
    .sort((a, b) => b.score - a.score).slice(0, 3).map(x => x.id);
}

/** Dice coefficient on letter bigrams: cheap, good enough to suggest "company.headcount" for "headcount". */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (b.includes(a) || a.includes(b)) return 1;
  const grams = (s: string) => { const g = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) ?? 0) + 1); } return g; };
  const ga = grams(a), gb = grams(b);
  let hit = 0;
  for (const [k, n] of ga) hit += Math.min(n, gb.get(k) ?? 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

/** The person enrich field groups a column set needs, and the company enrich groups. */
export function fieldsFor(columns: Column[]): { person: string[]; company: string[]; identify: boolean; personEnrich: boolean; companyEnrich: boolean; email: boolean; tech: boolean } {
  const person = new Set<string>(), company = new Set<string>();
  let identify = false, email = false, tech = false;
  for (const c of columns) {
    const s = c.source;
    if (s.kind === "identify") identify = true;
    else if (s.kind === "company_enrich") company.add(s.group);
    else if (s.kind === "company_premium") { company.add(s.group); tech = true; }
    else if (s.kind === "person_enrich") person.add(s.group);
    else if (s.kind === "person_premium") { person.add(s.field); email = true; }
  }
  // Every person call reads the basic profile and experience too: they name the match and the employer at no extra cost.
  if (person.size) { person.add("basic_profile"); person.add("experience"); }
  return { person: [...person].sort(), company: [...company].sort(), identify, personEnrich: person.size > 0, companyEnrich: company.size > 0, email, tech };
}

export const endpointFor = (c: Column): string =>
  c.source.kind === "identify" ? "POST /company/identify" : c.source.kind.startsWith("company") ? "POST /company/enrich" : "POST /person/enrich";

export const sourceLabel = (c: Column): string => `${endpointFor(c)} ${c.path}`;

/** The cost of a column per row, for the picker and the CLI table. */
export function costOf(c: Column, p: Prices, emailColumn: boolean): { each: number; per: "row" | "person" | "company"; text: string } {
  switch (c.source.kind) {
    case "identify": return { each: 0, per: "company", text: "Free" };
    case "company_enrich": return { each: p.companyEnrich, per: "company", text: `${p.companyEnrich} per company` };
    case "company_premium": return { each: p.technographics, per: "company", text: `+${p.technographics} per company` };
    case "person_enrich": return { each: p.personEnrich, per: "person", text: `${p.personEnrich} per person` };
    case "person_premium": return emailColumn ? { each: p.businessEmail, per: "person", text: `+${p.businessEmail} per person` } : { each: p.businessEmail, per: "person", text: "Needs contact access" };
  }
}

export const _test = { str, num, pct, list, date, similarity, closest };
export type { PickContext };
