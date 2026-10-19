// Optional: with ANTHROPIC_API_KEY set, Claude reads the ICP sentence and fills the same fields the flags set.
// The result is printed for confirmation before any search runs, and every value still goes through autocomplete.
// Without a key, the rule-based parser in icp.ts does this job.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { NO_UPPER_BOUND, normalizeDate, type IcpSpec } from "./icp.js";

const TOOL: Anthropic.Beta.BetaTool = {
  name: "set_icp_filters",
  description: "Record the search query and hard filters for a company search, read from an ideal customer profile.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What the target companies do, in a short phrase for semantic search. No size, place or funding words." },
      size_min: { type: "integer", description: "Minimum employees, if stated." },
      size_max: { type: "integer", description: "Maximum employees, if stated." },
      countries: { type: "array", items: { type: "string" }, description: "HQ countries as ISO-3 codes, for example USA, GBR, IND." },
      raised: { type: "array", items: { type: "string", enum: ["angel", "pre_seed", "seed", "series_a", "series_b", "series_c", "series_d", "series_e", "series_f", "series_g", "series_h", "series_i", "series_j"] }, description: "Last funding round types. Expand ranges: seed to Series B is seed, series_a, series_b." },
      since: { type: "string", description: "Earliest last-raise date, YYYY-MM-DD, if a recency is stated." },
      industries: { type: "array", items: { type: "string" }, description: "Industry labels like 'Software Development' or 'Financial Services', only if the profile names an industry." },
      growth: { type: "number", description: "Minimum 12-month headcount growth percent, if stated." },
      titles: { type: "array", items: { type: "string" }, description: "Buyer job titles, most important first, if stated or clearly implied (for example 'sells to finance teams' implies CFO, VP Finance, Head of FP&A)." },
      seniority: { type: "array", items: { type: "string", enum: ["CXO", "Vice President", "Director", "Owner / Partner", "Experienced Manager", "Senior"] } },
    },
    required: ["query"],
  },
};

export async function specFromSentence(sentence: string, today = new Date()): Promise<Partial<IcpSpec>> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.beta.messages.create({
    model: config.anthropicModel,
    max_tokens: 4096,
    output_config: { effort: "low" },
    // Server-side fallback: if the model declines, Anthropic reruns the request on a recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: `You turn an ideal customer profile into company search filters. Today is ${today.toISOString().slice(0, 10)}. Fill only what the profile states or clearly implies; leave everything else out. Always call set_icp_filters.`,
    tools: [TOOL],
    // "auto" plus the instruction, because newer models refuse a forced tool_choice.
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: sentence }],
  });
  const block = response.content.find(c => c.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Claude did not return filters. Pass them as flags instead, or unset ANTHROPIC_API_KEY to use the built-in parser.");
  const f = block.input as Record<string, any>;
  const spec: Partial<IcpSpec> = { query: f.query };
  if (f.size_min !== undefined || f.size_max !== undefined) spec.size = [f.size_min ?? 1, f.size_max ?? NO_UPPER_BOUND];
  if (f.countries?.length) spec.countries = f.countries;
  if (f.raised?.length) spec.raised = f.raised;
  if (f.since) { try { spec.since = normalizeDate(f.since); } catch { /* not a usable date; left out */ } }
  if (f.industries?.length) spec.industries = f.industries;
  if (typeof f.growth === "number") spec.growth = f.growth;
  if (f.titles?.length) spec.titles = f.titles;
  if (f.seniority?.length) spec.seniority = f.seniority;
  return spec;
}
