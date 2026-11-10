/**
 * Labs: which companies a search is about. A lab is given by its website domain (openai.com) or its name
 * ("Google DeepMind"), or by the word "frontier" for the built-in list below. Each one is turned into a Crustdata
 * company id with the free /company/identify call, because people's roles carry the company id: filtering on it
 * finds the company's own staff, where a website filter can also catch look-alike companies.
 */

import { identifyCompanies } from "./crustdata.js";

/**
 * The built-in "frontier" list: labs that train their own large models. They are named here only as search targets.
 * Edit this list to change what --labs frontier means. Meta is left out on purpose: its company id covers all of
 * Meta (over 90,000 current staff), so a search there is mostly people outside its AI labs. Add meta.com yourself
 * with --labs when you want it.
 */
export const FRONTIER_LABS = [
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "x.ai",
  "mistral.ai",
  "thinkingmachines.ai",
  "ssi.inc",
  "reflection.ai",
];

/**
 * Display names for labs whose Crustdata company name reads differently (x.ai is listed as "SpaceX Super
 * Intelligence"), and extra email domains their researchers' Google Scholar profiles use (--scholar-email).
 */
export const LAB_DISPLAY: Record<string, string> = { "x.ai": "xAI", "mistral.ai": "Mistral AI", "reflection.ai": "Reflection AI" };
export const LAB_EMAIL_DOMAINS: Record<string, string[]> = { "deepmind.google": ["deepmind.com"] };

export type Lab = { input: string; id: number; name: string; domain?: string; crustdataName?: string };

/** "frontier, https://www.Cohere.com/, Google DeepMind" to ["openai.com", ..., "cohere.com", "Google DeepMind"]. */
export function parseLabList(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(/[,;\n]/)) {
    const item = raw.trim();
    if (!item) continue;
    if (/^frontier$/i.test(item)) { out.push(...FRONTIER_LABS); continue; }
    out.push(asDomain(item) ?? item);
  }
  return [...new Map(out.map(v => [v.toLowerCase(), v])).values()];
}

/** A website or URL to its bare domain; undefined for a name ("Google DeepMind"). */
export function asDomain(item: string): string | undefined {
  const s = item.trim().toLowerCase();
  if (/\s/.test(s)) return undefined;
  const m = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/:?#].*)?$/.exec(s);
  return m ? m[1] : undefined;
}

/**
 * Each lab to a Crustdata company (free). A name with no confident match, or a domain Crustdata does not know, comes
 * back in `missing`, so the run can stop with a clear message instead of silently searching fewer labs.
 */
export async function resolveLabs(inputs: string[]): Promise<{ labs: Lab[]; missing: string[] }> {
  const domains = inputs.filter(i => asDomain(i));
  const names = inputs.filter(i => !asDomain(i));
  const labs: Lab[] = [], missing: string[] = [];
  for (const [kind, list] of [["domains", domains], ["names", names]] as const) {
    const rows = await identifyCompanies(kind, list);
    list.forEach((input, i) => {
      const row = rows.find(r => r.matched_on?.toLowerCase() === input.toLowerCase()) ?? (rows.length === list.length && !rows[i]?.matched_on ? rows[i] : undefined);
      const best = row?.matches?.[0];
      const id = best?.company_data?.crustdata_company_id;
      // A name can match a small company with the same words; only a confident match counts.
      if (!id || (kind === "names" && (best?.confidence_score ?? 0) < 0.8)) { missing.push(input); return; }
      const crustdataName = best?.company_data?.basic_info?.name ?? input;
      const domain = kind === "domains" ? input : best?.company_data?.basic_info?.primary_domain ?? undefined;
      labs.push({ input, id, name: (domain && LAB_DISPLAY[domain]) || crustdataName, domain, crustdataName });
    });
  }
  // The same company given twice (a domain and its name) is searched once.
  return { labs: [...new Map(labs.map(l => [l.id, l])).values()], missing };
}
