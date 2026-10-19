// The shape of one research result. The JSON endpoint returns exactly this; the CLI and the UI render it.
// SCHEMA_VERSION changes when a field is renamed or removed (adding a field does not change it).

export const SCHEMA_VERSION = "1";

export type Growth = { m1: number | null; m3: number | null; m6: number | null; m12: number | null; m24: number | null };

export type Headcount = {
  total: number | null;
  asOf: string | null;
  growthPercent: Growth;
  growthAbsolute: Growth;
  // Set when the one month change is so large it is more likely a data correction than real hiring or layoffs.
  monthlyJumpWarning: boolean;
  byDepartment: Array<{ name: string; count: number; share: number | null; growth12m: number | null }>;
  byCountry: Array<{ name: string; count: number; share: number | null }>;
  byMetro: Array<{ name: string; count: number; share: number | null }>;
  monthly: Array<{ date: string; count: number }>;
  // Monthly headcount for the largest departments (headcount.by_function_timeseries.CURRENT_FUNCTION). Months can be
  // missing; the last point is today's count from by_role_absolute so the chart and the table agree.
  departmentsMonthly: Array<{ name: string; points: Array<{ date: string; count: number }> }>;
};

export type FundingRound = { date: string | null; type: string | null; amountUsd: number | null; leadInvestors: string[]; secondary: boolean };

export type Funding = {
  totalUsd: number | null;       // money raised: total_investment_usd minus disclosed secondary sales
  secondaryUsd: number | null;   // disclosed secondary sales (existing shares changing hands), not money raised
  roundCount: number;            // primary rounds only
  lastRound: FundingRound | null;
  rounds: FundingRound[];
  investors: string[];
  acquisitions: Array<{ name: string; date: string | null }>;
  acquiredBy: string[];
};

export type Ownership = "public" | "acquired" | "private";

export type Person = {
  name: string;
  title: string;
  startDate: string | null;
  location: string | null;
  profileUrl: string | null;
};

export type People = {
  founders: Person[];
  executives: Person[];
  decisionMakers: Person[];
  recentJoins: Person[];              // started in the last 90 days
  executiveStarts12m: number;         // C-level starts in the last 12 months (turnover signal)
  startDatesKnown: boolean;
};

export type Hiring = {
  postingsLast90d: number | null;
  postingsPrev90d: number | null;
  changePercent: number | null;
  // Role type, read from posting titles (AE, SDR and RevOps count as Sales), not the source's category field.
  byRoleType: Array<{ type: string; count: number }>;
  salesRoles: number | null;
  newest: Array<{ title: string; roleType: string; location: string | null; workplace: string | null; date: string | null; url: string | null }>;
  window: { from90: string; from180: string };
};

export type NewsSignal = { kind: "layoffs" | "exec_exit" | "funding" | "acquisition" | "launch"; title: string; date: string | null; url: string };

export type Company = {
  id: number;
  name: string;
  domain: string;
  website: string | null;
  logoUrl: string | null;
  description: string | null;
  founded: number | null;
  companyType: string | null;
  ownership: Ownership;
  industry: string | null;
  categories: string[];
  headquarters: string | null;
  employeeRange: string | null;
  headcount: Headcount | null;
  funding: Funding | null;
  webTraffic: Array<{ domain: string; monthlyVisitors: number; mom: number | null; qoq: number | null; searchShare: number | null; directShare: number | null }> | null;
  followers: { count: number; m1: number | null; m3: number | null; m6: number | null; m12: number | null } | null;
  techStack: { total: number; byCategory: Array<{ category: string; names: string[] }> } | null;
  employeeRatings: {
    overall: number | null;
    reviews: number | null;          // total reviews the source reports
    ratingsCount: number | null;     // ratings behind the overall score (sum of the 1 to 5 star buckets)
    lowSample: boolean;              // under 10 ratings behind the score: read with care
    culture: number | null; workLife: number | null; careerGrowth: number | null; management: number | null; compensation: number | null;
    recommendPercent: number | null; outlookPercent: number | null;
  } | null;
  // Companies bidding on the same search ads (paid) or ranking for the same search terms (organic).
  competitors: { paidSearch: string[]; organicSearch: string[] } | null;
  news: Array<{ title: string; url: string; publisher: string | null; date: string | null }>;
  newsLast90d: number;               // articles in the last 90 days that name the company
  newsSignals: NewsSignal[];
  posts: Array<{ date: string | null; text: string; url: string | null; reactions: number | null; comments: number | null }>;
};

export type Credits = { identify: number; enrich: number; jobs: number; total: number; cached: boolean };

export type SectionError = { section: "hiring" | "brief"; status: number | null; message: string };

export type CompanySection = {
  domain: string;
  fetchedAt: string;
  company: Company;
  people: People;
  unavailable: string[];
  credits: Credits;
};

export type HiringSection = { domain: string; fetchedAt: string; hiring: Hiring; credits: Credits };

export type AiBrief = { provider: "anthropic" | "openai"; model: string; text: string };

export type Brief = {
  summary: string;
  lead?: string;     // the first one or two sentences of the summary: what the company is, in its own words
  changes: string[];
  questions: string[];
  ai?: AiBrief;      // when the visitor brought an AI key: the model's brief, written from the same data
  aiError?: string;  // when the AI step failed; the template brief above is shown instead
};

export type Research = {
  schemaVersion: string;
  domain: string;
  generatedAt: string;
  fetchedAt: string;   // when the Crustdata data was fetched (results are cached for up to 24 hours)
  company: Company;
  people: People;
  hiring: Hiring | null;
  brief: Brief;
  unavailable: string[];
  errors: SectionError[];
  credits: Credits;
};
