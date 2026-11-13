# How Private Company Research Agent works: every Crustdata API call behind a due diligence memo

Every Crustdata API request Private Company Research Agent makes for one company, in order, with what it costs at list price. The examples
are trimmed answers from live runs on 2026-11-13. The code for each is in [src/crustdata.ts](../src/crustdata.ts);
the order is in `collect()` in [src/collect.ts](../src/collect.ts).

Every request sends `authorization: Bearer <key>` and `x-api-version: 2025-11-01`. Each answer's `x-credits-used`
header is what it cost; the agent adds them up per company and prints the total next to the list price.

## 1. Company Identify: domain to company (free)

```json
POST /company/identify
{ "domains": ["linear.app"] }
```

```json
[{ "matched_on": "linear.app", "match_type": "domain",
   "matches": [{ "confidence_score": 1.0, "company_data": {
     "crustdata_company_id": 633791,
     "basic_info": { "name": "Linear", "primary_domain": "linear.app",
                     "all_domains": ["linear.app"] },
     "headcount": { "total": 303 } } }] }]
```

The match is used only when its own domains include the one asked (or the one asked is a subdomain of one of them).
Otherwise the company is skipped with the name Crustdata matched, and nothing is charged. Full URLs work too
(`https://www.otter.ai/pricing` matches `otter.ai`).

## 2. Company Enrich: the record (2 credits)

```json
POST /company/enrich
{ "crustdata_company_ids": [633791],
  "fields": ["basic_info", "headcount", "funding", "followers", "web_traffic",
             "employee_reviews", "people", "news", "competitors", "seo",
             "public_launches", "taxonomy", "locations"] }
```

What the memo reads from the answer:

| Group | Fields | Memo section |
|---|---|---|
| `basic_info` | `name`, `primary_domain`, `all_domains`, `description`, `year_founded`, `employee_count_range` | Header, Snapshot, the size warning |
| `headcount` | `total`, `timeseries`, `growth_percent`, `growth_absolute` (`qoq`, `six_months`, `yoy`, `two_years`), `by_function_timeseries.CURRENT_FUNCTION`, `by_role_percent`, `by_region_absolute` | Snapshot, Team by function, Headcount, rules |
| `funding` | `milestones[]` (`date`, `round_type`, `amount_usd`, `investors`, `lead_investors`), `total_investment_usd`, `last_round_type`, `last_fundraise_date`, `investors_detailed[].type`, `acquired_by` | Snapshot, Funding |
| `people` | `founders`, `cxos`, `decision_makers`: `basic_profile.name`, `experience.employment_details.current/past[]` (`employer_name`, `employee_title`, `employee_start_date`, `employer_company_id`), `education.schools` | Founders and executives |
| `web_traffic` | `domain_traffic.<domain>`: `monthly_visitors`, `mom_pct`, `qoq_pct`, `source_*_pct`, `monthly_visitors_timeseries` | Web traffic |
| `followers` | `count`, `qoq_percent`, `six_months_growth_percent`, `yoy_percent`, `timeseries` | Followers |
| `seo` | `monthly_organic_clicks`, `monthly_paid_clicks`, `monthly_google_ads_budget`, `gained/lost_ranked_seo_keywords` | Search and ads |
| `public_launches` | `rating`, `num_upvotes`, `num_reviews`, `launches[].launched_at` (unix seconds) | Product launches |
| `employee_reviews` | `overall_rating.rating`, `overall_rating.total_count`, `senior_management_rating`, `business_outlook_rating`, `recommend_to_friend_rating` | Employee reviews |
| `competitors` | `paid_seo`, `organic_seo` (domains, some with a leading space) | Peers |
| `news` | `article_title`, `article_url`, `article_publisher_name`, `article_publish_date` | Recent news, the news rule |
| `taxonomy`, `locations` | `categories`; `city`, `state`, `country` | Header, Snapshot |

`revenue` is not requested: a private startup's revenue is not public, so the memo asks for it in the data room instead.
`technographics` (+2) and `social_posts` (+5) are not requested either. If the key cannot read a group, the API
answers 403 "Access denied to fields: ..."; the agent drops that group, asks again, and lists it under "Not available".

## 3. People Search: who left (0.23 credits per person returned)

```json
POST /person/search
{ "filters": { "op": "and", "conditions": [
    { "field": "experience.employment_details.company_id", "type": "=", "value": 633791 },
    { "field": "experience.employment_details.end_date", "type": "=>", "value": "2025-11-13" },
    { "field": "experience.employment_details.current.company_id", "type": "!=",
      "value": 633791 } ] },
  "fields": ["crustdata_person_id", "basic_profile.name", "basic_profile.current_title",
             "social_handles.professional_network_identifier.profile_url",
             "experience.employment_details"],
  "limit": 25 }
```

```json
{ "profiles": [{ "basic_profile": { "name": "..." },
    "experience": { "employment_details": {
      "past": [{ "name": "Linear", "title": "Head of Product",
                 "end_date": "2026-08-01T00:00:00",
                 "seniority_level": "Director", "crustdata_company_id": 633791 }],
      "current": [{ "name": "OpenAI", "title": "Member of Product Staff" }] } } }],
  "total_count": 9 }
```

The first two conditions in one `and` group match the same role (a role at this company that ended in the last 12
months). The third drops people who still have a current role there, so promotions do not count as departures.
`total_count` is the number of leavers; `LEAVERS_LIMIT` (25) caps how many are read. List price per person: 0.03
base + 0.1 for filtering on experience + 0.1 for returning it.

## 4. People Search: leaders who stepped back (0.23 credits per person returned)

The same search without the third condition and with
`{ "field": "experience.employment_details.seniority_level", "type": "in", "value": ["CXO", "Vice President", "Director", "Owner / Partner"] }`,
`limit` 10. It catches a CTO who became an advisor (their CTO role ended; they still have a role at the company).
Leaders found here with no current role are added to the departures if step 3 did not reach them.

## 5. Job Search: hiring (free)

```json
POST /job/search
{ "filters": { "op": "and", "conditions": [
    { "field": "company.basic_info.company_id", "type": "=", "value": 633791 },
    { "field": "metadata.date_added", "type": "=>", "value": "2026-08-15" } ] },
  "limit": 0,
  "aggregations": [
    { "type": "group_by", "field": "job_details.title", "agg": "count", "size": 200 },
    { "type": "group_by", "field": "job_details.category", "agg": "count", "size": 50 } ] }
```

With `limit: 0` only counts come back, at no cost. When the count is 0, one more call with `limit: 1`, no date
filter and `sorts: [{ "field": "metadata.date_added", "order": "desc" }]` (0.03 credits) reads how many postings are
on record and the newest one. Some postings carry no `metadata.date_added` (all 18 of Linear's did not), so they never
match a date window: the memo says so instead of reporting a hiring freeze.

## 6. Peers: identify, then Company Search (0.63 credits per peer)

The competitor domains from step 2 (or `--peers`) go through Company Identify one by one (free; the answer includes
`headcount.total` and `basic_info.industries`). An automatic peer is kept only with at least 10 people, at least a
tenth of the company's headcount, at most 20 times it, and an industry in common with the company (Linear's lists
include a linear-motion hardware maker; a peer with no industry on record is left out). Then one call reads them all:

```json
POST /company/search
{ "filters": { "field": "crustdata_company_id", "type": "in", "value": [639108, 641735] },
  "fields": ["crustdata_company_id", "basic_info.name", "basic_info.primary_domain",
             "headcount.total", "headcount.growth_percent", "headcount.growth_absolute",
             "funding.total_investment_usd", "funding.last_round_amount_usd",
             "funding.last_fundraise_date", "funding.last_round_type", "followers.count"],
  "limit": 2 }
```

```json
{ "companies": [{ "basic_info": { "name": "Fireflies.ai", "primary_domain": "fireflies.ai" },
    "headcount": { "total": 140, "growth_percent": { "6m": 12.9, "12m": 17.6 } },
    "funding": { "total_investment_usd": 19000000.0, "last_round_type": "secondary_market" },
    "followers": { "count": 50218 } }], "total_count": 2 }
```

Company Search has no web traffic, so the peer table has none. List price: 0.03 per company plus 0.2 each for the
headcount, funding and followers groups returned.

## Totals

| Run | List price | Charged (our plan) |
|---|---|---|
| Linear (9 leavers, 1 leader search hit, 1 peer, job index lookup) | 4.96 | 2.36 |
| Modal (25 leavers, 1 leader search hit, 4 peers) | 10.5 | 2.9 |
| Synthesia (25 leavers, 10 leader search hits, 4 peers) | 12.57 | 3.26 |
| Most with defaults (25 + 10 people, 5 peers, job index lookup) | 13.23 | |

Your plan's prices are at [app.crustdata.com/endpoints](https://app.crustdata.com/endpoints).

## Saved answers

Every answer is saved in `out/.cache` for `CACHE_DAYS` (7) under a key built from what was asked (the endpoint, the
company id, the fields and filters, the month of the date window, and `CACHE_VERSION`). A re-run, or a list that was
cut off, reuses them for free; a change to the fields or filters is fetched fresh. The estimate checks the same keys,
so a company counts as free only when every answer is saved (a new month re-reads former staff, and is priced). Only one run at a time may use an
`OUT_DIR` (a lock file, `OUT_DIR/.lock`). An answer without a company record is not saved, so it is asked again.

## Retries and limits

Calls are spaced under each endpoint's per-minute limit (Company Enrich 15, the rest 30). A 429 is retried after the
`retry-after` or `x-ratelimit-reset` wait, up to twice. A 502 or 503 on a paid call is retried only when the answer
says `x-credits-used: 0`; a timeout on a paid call is not retried, because it may have been billed. A bad key (401),
no credits (402, or a 403 that says so) or a network failure stops the run, and so do three companies failing in a
row; everything researched before it is saved, and the next run reuses it for free. An error on the company record skips
that company and the run goes on; an error on one section (former staff, jobs, peers) leaves only that section out,
with the reason under "Not available". Enrich
answering 404 means Crustdata has no full record for the company yet.
