// Checks the key and shows what it can do: credits, prices, rate limits, email access, and the cache.
//   npm run status

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { apiKey, fail, ROOT } from "./env";
import { readAccount } from "../lib/account";
import { SqliteCache } from "../lib/cache-sqlite";
import { createClient } from "../lib/crustdata";
import { fmt } from "../lib/plan";

async function main() {
  const client = createClient({ apiKey: apiKey() });
  const a = await readAccount(client, { probeEmail: true });
  console.log(`Key works. Credits remaining: ${a.credits === null ? "unknown" : fmt(a.credits)}.`);
  console.log(`Prices: company profile ${fmt(a.prices.companyEnrich)}, tech stack +${fmt(a.prices.technographics)}, person ${fmt(a.prices.personEnrich)}, work email +${fmt(a.prices.businessEmail)} (list: 2, +2, 1, +1).`);
  console.log(`Rate limits per minute: ${Object.entries(a.rpm).map(([k, v]) => `${k} ${v}`).join(", ") || "defaults"}.`);
  console.log(`Email lookup (rows identified by a work email): ${a.emailLookup === true ? "yes" : a.emailLookup === false ? "no, this key cannot look people up by email" : "unknown"}.`);
  console.log(`Work email column (contact data): ${a.emailColumn ? "yes" : "no. Contact data needs enabling on your Crustdata account; self-serve keys do not have it."}`);
  const path = resolve(ROOT, process.env.CACHE_PATH || "data/cache.sqlite");
  if (existsSync(path)) {
    const cache = new SqliteCache(path);
    const s = cache.stats();
    console.log(`Cache: ${s.entries} entries (${s.people} people, ${s.companies} company profiles), ${fmt(s.credits)} credits' worth, at ${path}.`);
    cache.close();
  } else console.log("Cache: empty (data/cache.sqlite is created on the first run).");
}

main().catch(fail);
