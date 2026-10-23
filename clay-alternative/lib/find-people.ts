// "Find people at these accounts": the people at a company by title, through POST /person/search filtered on the
// current employer's Crustdata id. Used by `npm run find-people`. Titles are matched again in code, because the
// search matches any current role and a side role elsewhere can bring someone in.

import type { Client } from "./crustdata";
import { pickDomainMatch } from "./run";

export type FoundPerson = { name: string; title: string; seniority: string; location: string; profileUrl: string; company: string; domain: string; matchedTitle: string };

const SIDE_ROLE = /\b(advisor|adviser|investor|intern|board member|assistant to)\b/i;

/** "VP, Engineering", "Vice President (Engineering)" and "VP - Engineering" all read as "vp engineering". */
export const plainTitle = (t: string) => t.toLowerCase().replace(/\bvice president\b/g, "vp").replace(/[,/|()\-]+/g, " ").replace(/\s+/g, " ").trim();

export function titleMatches(title: string, wanted: string[]): string | null {
  const t = plainTitle(title);
  for (const w of wanted) {
    const k = plainTitle(w);
    if (!k) continue;
    const re = new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}([^a-z]|$)`);
    if (re.test(t)) return w;
  }
  return null;
}

export const titleFilters = (titles: string[]) => ({
  op: "or",
  conditions: titles.map(t => ({ field: "experience.employment_details.current.title", type: /^[A-Z&]{2,5}$/.test(t.trim()) ? "[.]" : "(.)", value: t.trim() })),
});

export async function findPeople(client: Client, domain: string, titles: string[], limit = 5): Promise<{ company: { id: number; name: string } | null; people: FoundPerson[]; credits: number }> {
  const before = client.spend.credits;
  const [res] = await client.identifyCompanies({ domains: [domain] });
  const picked = pickDomainMatch(res?.matches ?? [], domain);
  if (picked.status !== "matched" || picked.data.id === null) return { company: null, people: [], credits: 0 };
  const company = { id: picked.data.id, name: picked.data.record?.basic_info?.name ?? domain };
  const filters: any = { op: "and", conditions: [{ field: "experience.employment_details.current.company_id", type: "in", value: [company.id] }] };
  if (titles.length) filters.conditions.push(titleFilters(titles));
  const { profiles } = await client.searchPeople({ filters, fields: ["basic_profile", "experience", "social_handles"], limit: Math.min(100, Math.max(limit * 3, limit)) });
  const people: FoundPerson[] = [];
  for (const p of profiles) {
    const roles: any[] = p.experience?.employment_details?.current ?? [];
    const role = roles.find(r => r?.crustdata_company_id === company.id) ?? roles[0];
    const title: string = role?.title ?? p.basic_profile?.current_title ?? "";
    if (!title || SIDE_ROLE.test(title)) continue;
    const matched = titles.length ? titleMatches(title, titles) : "any";
    if (!matched) continue;
    people.push({ name: p.basic_profile?.name ?? "", title, seniority: role?.seniority_level ?? "", location: p.basic_profile?.location?.raw ?? "", profileUrl: p.social_handles?.professional_network_identifier?.profile_url ?? "", company: company.name, domain, matchedTitle: matched });
    if (people.length >= limit) break;
  }
  // Your first title first, then the next, so "VP Sales, Head of Marketing" lists VPs before Heads.
  if (titles.length) people.sort((a, b) => titles.indexOf(a.matchedTitle) - titles.indexOf(b.matchedTitle));
  return { company, people, credits: Math.round((client.spend.credits - before) * 1000) / 1000 };
}
