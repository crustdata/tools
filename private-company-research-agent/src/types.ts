/**
 * The shapes this agent reads, as the live Crustdata API returned them on 2026-11-13. Only the fields used are
 * typed; everything is optional because any section can be missing for a given company.
 */

export type Point = { date?: string | null; employee_count?: number | null };

/** One role in the `people` section of Company Enrich (a different shape from /person/search). */
export type EnrichRole = {
  employer_name?: string | null;
  employer_company_id?: Array<string | number> | null;
  employer_website?: string[] | null;
  employee_title?: string | null;
  employee_start_date?: string | null;
  employee_end_date?: string | null;
};

export type EnrichPerson = {
  crustdata_person_id?: number | null;
  updated_at?: string | null;
  basic_profile?: { name?: string | null; current_title?: string | null; headline?: string | null; location?: { raw?: string | null } | string | null } | null;
  social_handles?: { professional_network_identifier?: { profile_url?: string | null } | null } | null;
  experience?: { employment_details?: { current?: EnrichRole[] | null; past?: EnrichRole[] | null } | null } | null;
  education?: { schools?: Array<{ school?: string | null; degree?: string | null; field_of_study?: string | null; end_year?: number | null }> | null } | null;
};

export type DomainTraffic = {
  domain?: string | null;
  monthly_visitors?: number | null;
  mom_pct?: number | null;
  qoq_pct?: number | null;
  source_search_pct?: number | null;
  source_direct_pct?: number | null;
  source_social_pct?: number | null;
  source_paid_referral_pct?: number | null;
  source_referral_pct?: number | null;
  monthly_visitors_timeseries?: Array<{ date?: string | null; monthly_visitors?: number | null }> | null;
};

export type Milestone = {
  date?: string | null;
  funding_date?: string | null;
  amount_usd?: number | null;
  round_type?: string | null;
  investors?: string | null;
  lead_investors?: string | null;
};

export type NewsItem = {
  article_url?: string | null;
  article_title?: string | null;
  article_publisher_name?: string | null;
  article_publish_date?: string | null;
  confidence_score?: number | null;
};

export type CompanyData = {
  crustdata_company_id?: number;
  basic_info?: {
    name?: string | null;
    primary_domain?: string | null;
    all_domains?: string[] | null;
    website?: string | null;
    professional_network_url?: string | null;
    description?: string | null;
    company_type?: string | null;
    status?: string | null;
    year_founded?: number | null;
    employee_count_range?: string | null;
    industries?: string[] | null;
  } | null;
  headcount?: {
    total?: number | null;
    largest_headcount_country?: string | null;
    timeseries?: Point[] | null;
    growth_percent?: Partial<Record<"mom" | "qoq" | "six_months" | "yoy" | "two_years", number | null>> | null;
    growth_absolute?: Partial<Record<"mom" | "qoq" | "six_months" | "yoy" | "two_years", number | null>> | null;
    by_role_absolute?: Record<string, number> | null;
    by_role_percent?: Record<string, number> | null;
    by_role_growth_6m_pct?: Record<string, number> | null;
    by_region_absolute?: Record<string, number> | null;
    by_function_timeseries?: { CURRENT_FUNCTION?: Record<string, Point[]> | null } | null;
  } | null;
  funding?: {
    total_investment_usd?: number | null;
    last_round_amount_usd?: number | null;
    last_fundraise_date?: string | null;
    last_round_type?: string | null;
    num_funding_rounds?: number | null;
    milestones?: Milestone[] | null;
    investors_detailed?: Array<{ name?: string | null; type?: string | null; categories?: string[] | null }> | null;
    acquired_by?: unknown[] | null;
  } | null;
  followers?: {
    count?: number | null;
    qoq_percent?: number | null;
    six_months_growth_percent?: number | null;
    yoy_percent?: number | null;
    timeseries?: Array<{ date?: string | null; follower_count?: number | null }> | null;
  } | null;
  web_traffic?: { domain_traffic?: Record<string, DomainTraffic> | null } | null;
  seo?: {
    total_organic_results?: number | null;
    monthly_google_ads_budget?: number | null;
    monthly_paid_clicks?: number | null;
    monthly_organic_clicks?: number | null;
    gained_ranked_seo_keywords?: number | null;
    lost_ranked_seo_keywords?: number | null;
  } | null;
  competitors?: { paid_seo?: string[] | null; organic_seo?: string[] | null } | null;
  employee_reviews?: {
    overall_rating?: { rating?: number | null; total_count?: number | null } | null;
    senior_management_rating?: number | null;
    business_outlook_rating?: number | null;
    recommend_to_friend_rating?: number | null;
  } | null;
  people?: { founders?: EnrichPerson[] | null; cxos?: EnrichPerson[] | null; decision_makers?: EnrichPerson[] | null } | null;
  news?: NewsItem[] | null;
  public_launches?: {
    producthunt_url?: string | null;
    rating?: number | null;
    num_upvotes?: number | null;
    num_reviews?: number | null;
    launches?: Array<{ name?: string | null; launched_at?: string | number | null; num_upvotes?: number | null; day_rank?: number | null }> | null;
  } | null;
  taxonomy?: { categories?: string[] | null; professional_network_industry?: string | null } | null;
  locations?: { city?: string | null; state?: string | null; country?: string | null; headquarters?: string | null } | null;
};

/** A role from /person/search (the person API shape). */
export type SearchRole = {
  name?: string | null;
  title?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  seniority_level?: string | null;
  crustdata_company_id?: number | null;
};

export type SearchPerson = {
  crustdata_person_id?: number;
  basic_profile?: { name?: string | null; current_title?: string | null } | null;
  social_handles?: { professional_network_identifier?: { profile_url?: string | null } | null } | null;
  experience?: { employment_details?: { current?: SearchRole[] | null; past?: SearchRole[] | null } | null } | null;
};

export type PeopleResult = { total: number; people: SearchPerson[]; since?: string };

export type JobCounts = {
  total: number;
  titles: Array<{ title: string; count: number }>;
  categories: Array<{ category: string; count: number }>;
  /**
   * When none were added in the window: the newest posting on record for this company (date may be missing: some
   * listings carry no metadata.date_added and never match a date filter) and how many it has in all. Null: none at all.
   */
  newest?: { date?: string; title: string; on_record: number } | null;
};

/** A peer as /company/search returns it. */
export type PeerData = {
  crustdata_company_id?: number;
  basic_info?: { name?: string | null; primary_domain?: string | null; year_founded?: number | null; company_type?: string | null } | null;
  headcount?: { total?: number | null; growth_percent?: Record<string, number | null> | null; growth_absolute?: Record<string, number | null> | null } | null;
  funding?: { total_investment_usd?: number | null; last_round_amount_usd?: number | null; last_fundraise_date?: string | null; last_round_type?: string | null } | null;
  followers?: { count?: number | null } | null;
};

/** Everything fetched for one company: the input to the memo (kept in out/.cache, not in memo.json). */
export type Bundle = {
  asked: string;
  fetched_at: string;
  company: CompanyData;
  /** Leavers in the last 12 months, people no longer at the company. Undefined when not fetched. */
  departures?: PeopleResult;
  /** Senior roles at the company that ended in the last 12 months, people who stayed included. */
  senior_ends?: PeopleResult;
  jobs?: JobCounts & { since?: string };
  peers?: { source: "auto" | "user"; asked: string[]; found: PeerData[]; missing: string[]; dropped: Array<{ domain: string; reason: "small" | "large" | "unrelated" }>; industry_checked?: boolean };
  /** --no-peers or PEERS_LIMIT=0. */
  peers_skipped?: boolean;
  /** The company's industries from identify, used to check peers. */
  industries?: string[];
  /** Sections that could not be fetched, with the reason (403 on this key, a failure). */
  unavailable: Record<string, string>;
  /** Credits the calls for this company reported (0 when every answer came from the saved cache). */
  credits: number;
  /** What a fresh run for this company costs at list price: 2 + 0.23 per person returned + 0.63 per peer returned. */
  list_credits: number;
};
