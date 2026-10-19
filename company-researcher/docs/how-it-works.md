# How it works

Every request this repo makes to Crustdata, with the body and the fields it reads back. All requests go to `https://api.crustdata.com` with these headers:

```
authorization: Bearer <CRUSTDATA_API_KEY>
content-type: application/json
x-api-version: 2025-11-01
```

The credits each call used come back in the `x-credits-used` response header. `lib/crustdata.ts` reads it on every call.

## 1. Resolve the company: `POST /company/identify` (free)

```json
{ "domains": ["vercel.com"] }
```

or, for a name typed into the box:

```json
{ "names": ["Vercel"] }
```

The response is one entry per input with `matches[]`. Each match has `confidence_score` and `company_data.crustdata_company_id`, `company_data.basic_info.name` and `company_data.basic_info.primary_domain`. When several match, the code takes the highest confidence, then the one with a domain and the larger headcount.

## 2. Everything about it: `POST /company/enrich` (2 credits, +2, +5)

```json
{
  "crustdata_company_ids": [631347],
  "exact_match": true,
  "fields": [
    "basic_info", "headcount", "funding", "locations", "taxonomy", "revenue", "hiring", "followers",
    "web_traffic", "employee_reviews", "people", "news", "competitors", "social_profiles",
    "technographics", "social_posts"
  ]
}
```

`fields` is a whitelist. `technographics` (+2) and `social_posts` (+5) are skipped in lite mode. A group the key is not entitled to fails the whole call with a 403 or a 400 that names the group; the client drops exactly that group, retries, and the section shows "not available on this plan".

What `lib/shape.ts` reads from `matches[0].company_data`:

| Group | Fields read | Section |
|---|---|---|
| `basic_info` | `name`, `primary_domain`, `website`, `logo_permalink`, `description`, `year_founded`, `company_type`, `industries` | Profile |
| `headcount` | `total`, `growth_percent.{mom,qoq,six_months,yoy,two_years}`, `growth_absolute.{same}`, `by_role_absolute`, `by_role_percent`, `by_role_growth_yoy_pct`, `by_region_absolute`, `by_region_percent`, `timeseries[]` | Headcount |
| `funding` | `total_investment_usd`, `funding_rounds[]` (date, type, amount, lead investors), `investors`, `acquisitions`, `acquired_by` | Funding |
| `people` | `founders[]`, `cxos[]`, `decision_makers[]`, each with `basic_profile.name`, the current role's `employee_title` and `employee_start_date`, `social_handles.professional_network_identifier.profile_url` | Leadership |
| `web_traffic` | `domain_traffic.<domain>.{monthly_visitors, mom_pct, qoq_pct, source_search_pct, source_direct_pct}` | Traffic |
| `followers` | `count`, growth over 1, 3, 6 and 12 months | Traffic |
| `employee_reviews` | overall and per topic ratings, rating count, recommend and outlook percent | Employee ratings |
| `competitors` | `paid_seo`, `organic_seo` | Search competitors |
| `technographics` | technologies with categories | Tech stack |
| `news` | `article_title`, `article_url`, `article_publisher_name`, `article_publish_date` | News, and signals for the brief |
| `social_posts` | `text`, `share_url`, `date_posted`, `engagement.total_reactions`, `engagement.total_comments` | Recent posts |

## 3. Hiring: `POST /job/search` x3, in parallel (about 0.45 credits)

Postings in the last 90 days, grouped by title (no rows, free):

```json
{
  "filters": { "op": "and", "conditions": [
    { "field": "company.basic_info.company_id", "type": "=", "value": 631347 },
    { "field": "metadata.date_added", "type": "=>", "value": "2026-07-18" }
  ]},
  "aggregations": [{ "type": "group_by", "field": "job_details.title", "agg": "count", "size": 200 }],
  "limit": 0
}
```

The 90 days before that, count only (free):

```json
{
  "filters": { "op": "and", "conditions": [
    { "field": "company.basic_info.company_id", "type": "=", "value": 631347 },
    { "field": "metadata.date_added", "type": "=>", "value": "2026-04-19" },
    { "field": "metadata.date_added", "type": "<", "value": "2026-07-18" }
  ]},
  "aggregations": [{ "type": "count" }],
  "limit": 0
}
```

The newest 15 postings (0.03 credits each):

```json
{
  "filters": { "op": "and", "conditions": [{ "field": "company.basic_info.company_id", "type": "=", "value": 631347 }] },
  "sorts": [{ "field": "metadata.date_added", "order": "desc" }],
  "fields": ["crustdata_job_id", "job_details", "location", "metadata"],
  "limit": 15
}
```

Titles are sorted into role types (Engineering, Sales, Marketing, Data, Product and design, Customer success, Finance and legal, People, Operations, Other) by `roleType()` in `lib/shape.ts`. `job_details.category` is not used: it has a large "Others" bucket and differs by source.

## 4. The brief

`buildBrief()` in `lib/brief.ts` turns the shaped sections into:

- **summary**: what the company is, in one paragraph, every figure from a field
- **changes**: up to six, ranked: layoffs in the news, leadership exits, three or more new executives this year, new senior hires, fresh funding, acquisitions, big headcount and hiring swings, department growth, launches, traffic and followers
- **questions**: three, to the prospect, from the strongest changes that have one

With an AI key (`x-ai-key` header on the web, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the CLI), `lib/ai.ts` sends the same facts to the newest model the key can use and asks for the same three parts, with the same copy rules.

## 5. Caching and the demo key

Results are cached in memory per key and company for 24 hours (`CACHE_TTL_HOURS`), so a reload costs nothing, and a lite request after a full one is answered from the full result. When the server's own key pays, spending is capped per UTC day (`DAILY_CREDIT_CAP`) and per visitor IP (`DEMO_RATE_LIMIT`); see `lib/http.ts`.
