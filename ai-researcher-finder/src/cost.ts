/**
 * What a run can cost, before anything is billed. Prices come from the account (GET /account/endpoints, free) and
 * fall back to Crustdata's list prices. Pure, so it is tested.
 *
 * Person search bills per person returned: a base price, plus each premium data group the request filters on or
 * returns. A returned group that is empty for a person (most people have no research profile) is not billed, so
 * the estimate is a ceiling. Identify bills 1 credit per match (free on a miss); the GitHub lookup bills 1 a call.
 */

import type { Endpoint } from "./crustdata.js";

export type Group = "experience" | "education" | "skills" | "research_profiles";
export type Prices = {
  base: number;
  field: Record<Group, number>;
  filter: Record<"experience" | "research_profiles", number>;
  identify: number;
  github: number;
  source: "account" | "list";
};

/** List prices (docs.crustdata.com/general/pricing, October 2026). */
export const LIST_PRICE: Prices = {
  base: 0.03,
  field: { experience: 0.1, education: 0.1, skills: 0.1, research_profiles: 0.4 },
  filter: { experience: 0.1, research_profiles: 0.4 },
  identify: 1,
  github: 1,
  source: "list",
};

export function pricesFrom(endpoints: Endpoint[]): Prices {
  const search = endpoints.find(e => e.path === "/person/search");
  if (!search) return LIST_PRICE;
  const get = (list: Array<{ field: string; credits: number }> | undefined, name: string, fallback: number) => {
    const hit = list?.find(x => x.field === name);
    return hit && Number.isFinite(hit.credits) ? hit.credits : fallback;
  };
  const dev = endpoints.find(e => e.path === "/dev_platform/enrich");
  return {
    base: typeof search.base_credits === "number" ? search.base_credits : LIST_PRICE.base,
    field: {
      experience: get(search.premium_fields, "experience", LIST_PRICE.field.experience),
      education: get(search.premium_fields, "education", LIST_PRICE.field.education),
      skills: get(search.premium_fields, "skills", LIST_PRICE.field.skills),
      research_profiles: get(search.premium_fields, "research_profiles", LIST_PRICE.field.research_profiles),
    },
    filter: {
      experience: get(search.premium_filters, "experience", LIST_PRICE.filter.experience),
      research_profiles: get(search.premium_filters, "research_profiles", LIST_PRICE.filter.research_profiles),
    },
    identify: LIST_PRICE.identify,
    github: typeof dev?.base_credits === "number" ? dev.base_credits : LIST_PRICE.github,
    source: "account",
  };
}

/** One person returned with every group the score reads, filtered on these groups. Ceiling: research billed for all. */
export function perPerson(prices: Prices, filters: Array<"experience" | "research_profiles">, research = true): number {
  const fields = prices.field.experience + prices.field.education + prices.field.skills + (research ? prices.field.research_profiles : 0);
  return prices.base + fields + filters.reduce((s, g) => s + prices.filter[g], 0);
}

export type Plan = {
  /** People found by earlier seed lookups whose full record is still to fetch. */
  records?: number;
  searches: Array<{ label: string; people: number; filters: Array<"experience" | "research_profiles"> }>;
  scholar: number;
  profiles: number;
  github: number;
  papers: number;
  perPaper: number;
};

export type Estimate = { ceiling: number; lines: string[] };

const r2 = (n: number) => Math.round(n * 100) / 100;

export function estimate(plan: Plan, prices: Prices, research = true): Estimate {
  const lines: string[] = [];
  let total = 0;
  for (const s of plan.searches) {
    const each = perPerson(prices, s.filters, research);
    total += s.people * each;
    lines.push(`${s.label}: up to ${s.people} ${s.people === 1 ? "person" : "people"} x ${r2(each)} = ${r2(s.people * each)}`);
  }
  const byId = perPerson(prices, [], research);
  const resolve = (n: number, label: string, per: number) => {
    if (!n) return;
    total += n * (per + byId);
    lines.push(`${label}: ${n} x (${per} to find + ${r2(byId)} for the record) = ${r2(n * (per + byId))}`);
  };
  if (plan.records) {
    total += plan.records * byId;
    lines.push(`Records for seeds looked up before: ${plan.records} x ${r2(byId)} = ${r2(plan.records * byId)}`);
  }
  resolve(plan.scholar, "Google Scholar profiles", prices.identify);
  resolve(plan.profiles, "Profile URLs", prices.identify);
  resolve(plan.github, "GitHub profiles", prices.github);
  if (plan.papers) {
    const each = perPerson(prices, ["research_profiles"], research);
    total += plan.papers * plan.perPaper * each;
    lines.push(`Paper titles: ${plan.papers} x up to ${plan.perPaper} authors x ${r2(each)} = ${r2(plan.papers * plan.perPaper * each)}`);
  }
  return { ceiling: r2(total), lines };
}
