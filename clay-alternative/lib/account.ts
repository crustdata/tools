// What this key can do and what it pays: read from the free /account endpoints, with list prices as the fallback.

import type { Client } from "./crustdata";
import { CrustdataError } from "./crustdata";
import type { Account, Prices } from "./types";

/** Crustdata list prices (docs, 2026-10). Accounts on a plan see their own prices in /account/endpoints. */
export const LIST_PRICES: Prices = { companyEnrich: 2, technographics: 2, personEnrich: 1, businessEmail: 1, personSearch: 0.03 };

const PATHS = ["/company/identify", "/company/enrich", "/person/enrich", "/person/search"];

export function accountFromEndpoints(endpoints: any[], credits: number | null): Account {
  const by = new Map<string, any>(endpoints.map(e => [e.path, e]));
  const premium = (path: string, field: string): number | undefined =>
    (by.get(path)?.premium_fields as any[] | undefined)?.find(f => f.field === field)?.credits;
  const base = (path: string): number | undefined => by.get(path)?.base_credits;
  const prices: Prices = {
    companyEnrich: base("/company/enrich") ?? LIST_PRICES.companyEnrich,
    technographics: premium("/company/enrich", "technographics") ?? LIST_PRICES.technographics,
    personEnrich: base("/person/enrich") ?? LIST_PRICES.personEnrich,
    businessEmail: premium("/person/enrich", "contact.business_emails") ?? LIST_PRICES.businessEmail,
    personSearch: base("/person/search") ?? LIST_PRICES.personSearch,
  };
  const rpm: Record<string, number> = {};
  for (const p of PATHS) { const n = by.get(p)?.effective_rate_limit_rpm; if (typeof n === "number" && n > 0) rpm[p] = n; }
  return {
    credits, prices, listPrices: LIST_PRICES, rpm,
    emailColumn: premium("/person/enrich", "contact.business_emails") !== undefined,
    emailLookup: "unknown",
  };
}

/** Reads credits and endpoint prices (two free calls). With `probeEmail`, one more free call checks that email lookup is on. */
export async function readAccount(client: Client, { probeEmail = false } = {}): Promise<Account> {
  const [credits, endpoints] = await Promise.all([client.credits().catch(() => null), client.endpoints()]);
  const account = accountFromEndpoints(endpoints, credits);
  client.setRpm(account.rpm);
  if (probeEmail) account.emailLookup = await probeEmailLookup(client);
  return account;
}

/** A business email that matches nobody costs nothing; a 403 or a 400 naming the identifier means the key cannot look emails up. */
export async function probeEmailLookup(client: Client): Promise<boolean | "unknown"> {
  try {
    await client.enrichPeople({ emails: ["probe-no-such-person-404@example.com"] }, ["basic_profile"]);
    return true;
  } catch (err) {
    if (err instanceof CrustdataError && (err.status === 403 || err.status === 400)) return false;
    return "unknown";
  }
}

/** The account read is a property of the key, not of the request: callers that serve many requests should memoise it (see lib/http.ts). */
