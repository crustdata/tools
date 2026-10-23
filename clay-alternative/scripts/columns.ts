// Prints the column catalogue with the cost per row. With a key, prices come from your account; without, list prices.
//   npm run columns

import { apiKey, table } from "./env";
import { LIST_PRICES, readAccount } from "../lib/account";
import { COLUMNS, DEFAULT_COLUMNS, costOf, endpointFor } from "../lib/columns";
import { createClient } from "../lib/crustdata";
import { fmt } from "../lib/plan";

async function main() {
  let prices = LIST_PRICES, emailColumn = true, source = "list prices";
  if (process.env.CRUSTDATA_API_KEY) {
    try {
      const a = await readAccount(createClient({ apiKey: apiKey() }));
      prices = a.prices; emailColumn = a.emailColumn; source = "your account's prices";
    } catch (err) { console.error(`Could not read your account (${(err as Error).message}); showing list prices.`); }
  }
  const rows = [["Column", "Label", "Group", "Cost per row", "Source"]];
  for (const c of COLUMNS) rows.push([c.id, c.label, c.group, costOf(c, prices, emailColumn).text, `${endpointFor(c)} ${c.path}`]);
  console.log(table(rows));
  console.log(`\nCredits at ${source}. Default columns: ${DEFAULT_COLUMNS.join(", ")}.`);
  console.log("Company enrich is one call per company whatever the columns; misses, identify and cache hits are free.");
}

main();
