/**
 * Shapes. Raw* types are the parts of Crustdata responses this agent reads (checked against the live API, Oct 2026).
 * The rest is what the agent builds from them and saves in out/data.json, so memos re-render without a credit.
 */

// ---------------------------------------------------------------------------
// Raw API shapes
// ---------------------------------------------------------------------------

export type RawCompany = {
  crustdata_company_id: number;
  basic_info?: {
    name?: string; primary_domain?: string; website?: string; professional_network_url?: string;
    description?: string; year_founded?: number | null; employee_count_range?: string; company_type?: string;
  };
  headcount?: {
    total?: number | null;
    growth_percent?: Partial<Record<"1m" | "3m" | "6m" | "12m", number | null>>;
    growth_absolute?: Partial<Record<"1m" | "3m" | "6m" | "12m", number | null>>;
  } | null;
  funding?: {
    total_investment_usd?: number | null; last_round_amount_usd?: number | null; last_fundraise_date?: string | null;
    last_round_type?: string | null; investors?: string[] | null;
    // The API also returns contact_email and phone_number here. This agent never reads, saves or prints them.
  } | null;
  locations?: { country?: string; headquarters?: string; city?: string; state?: string } | null;
  followers?: { count?: number | null; six_months_growth_percent?: number | null; qoq_percent?: number | null; yoy_percent?: number | null } | null;
};

export type RawPosition = {
  title?: string; name?: string; crustdata_company_id?: number; company_website?: string;
  start_date?: string | null; end_date?: string | null; is_default?: boolean; company_headcount_latest?: number | null;
};

export type RawProfile = {
  crustdata_person_id: number;
  basic_profile?: { name?: string; headline?: string; current_title?: string; location?: { full_location?: string; country?: string } };
  experience?: { employment_details?: { current?: RawPosition[]; past?: RawPosition[] } };
  education?: { schools?: Array<{ school?: string; degree?: string; field_of_study?: string; end_year?: number | null }> };
  social_handles?: { professional_network_identifier?: { profile_url?: string | null } };
};

export type RawJob = { job_details?: { title?: string; url?: string }; metadata?: { date_added?: string } };

export type RawPost = {
  share_url?: string; date_posted?: string; text?: string;
  actor?: { name?: string; crustdata_entity_id?: number; actor_type?: string };
};

// ---------------------------------------------------------------------------
// What the agent builds
// ---------------------------------------------------------------------------

export type Role = { title: string; company: string; companyId?: number; domain?: string; start?: string; end?: string; headcount?: number };

export type Founder = {
  personId: number;
  name: string;
  /** The title held at this company (not the person's first current role). */
  title: string;
  since?: string;
  profileUrl?: string;
  headline?: string;
  location?: string;
  /** Other current roles: a second job, a board seat, an investor role. */
  alsoNow: Role[];
  past: Role[];
  schools: Array<{ school: string; degree?: string; field?: string; endYear?: number }>;
  /** Past roles titled founder, or CEO of a company of 500 people or fewer, at another company. */
  priorFounder: Role[];
  /** Entries of --founders-from this person used to work at, with the role. */
  fromList: Array<{ entry: string; role: Role }>;
  /** Entries of --schools this person studied at. */
  schoolHits: string[];
};

export type Jobs = {
  /** Roles posted in the last 30 and 90 days (null: not checked). */
  last30: number | null;
  last90: number | null;
  /** Raw listings in the last 90 days: one role is often listed on several job sites, so this is higher. */
  listings90?: number;
  newest: Array<{ title: string; date?: string; url?: string }>;
};

export type Quote = { date: string; author: string; text: string; url?: string; phrase: string; kind: "traction" | "raise" };

export type Posts = {
  /** Founders' posts in the last 6 months with a traction phrase, and with a round phrase (null: not checked). */
  traction: number | null;
  raise: number | null;
  quotes: Quote[];
  /** Why posts were not checked, when they were not. */
  skipped?: string;
  /** "rank": not checked because the company ranked below --posts (scored as none); "off": not available for any company (not scored). */
  unchecked?: "rank" | "off";
};

export type Signal = {
  key: string;
  label: string;
  /** Points earned and the most this signal can earn. A signal that does not apply is left out of the total. */
  points: number;
  max: number;
  reason: string;
};

export type Timing = { label: string; explain: string };

/** `scoredOn`: points that had data; `applies`: points that apply under this thesis. The total is out of the larger of scoredOn and 80% of applies. */
export type Score = { total: number; signals: Signal[]; notScored: string[]; timing: Timing; momentum: { signs: string[]; shrinking: boolean }; scoredOn?: number; applies?: number };

export type Company = {
  id: number;
  name: string;
  domain: string;
  website?: string;
  profileUrl?: string;
  description?: string;
  founded?: number;
  hq?: string;
  country?: string;
  headcount?: number;
  growth3m?: number;
  growth6m?: number;
  growth12m?: number;
  added6m?: number;
  added3m?: number;
  followers?: number;
  followers6m?: number;
  lastRound?: string;
  lastRoundDate?: string;
  lastRoundUsd?: number;
  totalUsd?: number;
  investors: string[];
};

export type Deal = {
  company: Company;
  founders: Founder[];
  jobs: Jobs;
  posts: Posts;
  score: Score;
  /** new: first time in this pipeline; still here: also in the last run; back: seen before, not in the last run. */
  status: "new" | "still here" | "back";
  firstSeen: string;
  /** What moved since this company was last seen ("score 61 to 74; team 9 to 14"). */
  change?: string;
  lastScore?: number;
  /** The memo's file name in memos/. */
  memo?: string;
  analysis?: { model: string; text: string };
};
