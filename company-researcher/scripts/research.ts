// Research a company from the terminal and print the brief as markdown.
//
//   npx tsx scripts/research.ts stripe.com           markdown to stdout
//   npx tsx scripts/research.ts stripe.com --json    the full structured result
//   npx tsx scripts/research.ts stripe.com --lite    skip tech stack and recent posts (2.45 credits instead of 9.45)
//   npx tsx scripts/research.ts --check              which data groups your key can read
//
// Needs only CRUSTDATA_API_KEY (from the environment or .env). Set ANTHROPIC_API_KEY or OPENAI_API_KEY as well and
// the model writes the brief from the data; without one, the brief is the template.

import { existsSync } from "node:fs";
import { research } from "../lib/research";
import { toMarkdown } from "../lib/markdown";
import { enrichEntitlements } from "../lib/crustdata";

if (existsSync(".env")) process.loadEnvFile(".env");

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const domain = args.find(a => !a.startsWith("--"));

async function main() {
  if (flags.has("--check")) {
    const e = await enrichEntitlements();
    console.log(`/company/enrich: ${e.status ?? "unknown"}, rate limit ${e.rateLimitRpm ?? "?"} requests a minute`);
    for (const g of e.groups) console.log(`  ${g.enabled ? "yes" : "no "}  ${g.group}`);
    const missing = e.groups.filter(g => !g.enabled).map(g => g.group);
    console.log(missing.length ? `\nSections for ${missing.join(", ")} will show as not available on this plan.` : "\nYour key can read every section.");
    return;
  }
  if (!domain) {
    console.error("Usage: npx tsx scripts/research.ts <domain> [--json] [--lite]\n       npx tsx scripts/research.ts --check");
    process.exit(1);
  }
  const aiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || undefined;
  const r = await research(domain, { lite: flags.has("--lite") || undefined, aiKey });
  if (r.brief.aiError) console.error(`AI brief skipped: ${r.brief.aiError}`);
  process.stdout.write(flags.has("--json") ? JSON.stringify(r, null, 2) + "\n" : toMarkdown(r));
}

main().catch(err => {
  console.error((err as Error).message);
  process.exit(1);
});
