# How VC Portfolio Monitor works

Every Crustdata request, in order, with what it costs at list prices. All requests go to `https://api.crustdata.com`
with `authorization: Bearer $CRUSTDATA_API_KEY` and `x-api-version: 2025-11-01`; the `x-credits-used` response
header reports the cost of each one. They live in one file, [src/crustdata.ts](../src/crustdata.ts).

## 1. `npm run import`

### Resolve each company (free)

```http
POST /company/identify
{ "domains": ["linear.app", "resend.com"] }
```

Each input comes back with `matches[]`, best first; `matches[0].company_data.crustdata_company_id` is the id used from
here on. Rows with only a name are sent as `{ "names": [...] }`. A name can match up to 25 companies, several at full
confidence ("Linear" matched three in our test), so a name is only taken when exactly one company is the best match
(or exactly one of the best has that exact name). Anything else goes to `unresolved.csv` with the top 3 websites.

### The starting point (2 credits per company)

```http
POST /company/enrich
{ "crustdata_company_ids": [633791], "fields": ["basic_info", "headcount", "funding", "news"] }
```

Read from the record: `headcount.total`, `headcount.growth_absolute.six_months` and
`headcount.growth_percent.six_months` (the 6-month change, for the starting point and its alert),
`headcount.by_function_timeseries.CURRENT_FUNCTION` (monthly headcount per department), `funding.last_round_type`,
`funding.last_round_amount_usd`, `funding.last_fundraise_date`, and `basic_info.employee_count_range` (to warn when the
headcount is far above the size range). The record is stored as the headcount reference.

### Founders and C-level (0.03 credits per person found in our live runs; up to 12 people)

```http
POST /person/search
{
  "filters": { "op": "and", "conditions": [
    { "field": "experience.employment_details.current.company_id", "type": "in", "value": [633791] },
    { "op": "or", "conditions": [
      { "field": "experience.employment_details.current.title", "type": "[.]", "value": "founder" },
      { "field": "experience.employment_details.current.title", "type": "[.]", "value": "chief" },
      { "field": "experience.employment_details.current.title", "type": "[.]", "value": "CEO" }
    ] } ] },
  "fields": ["basic_profile.name", "basic_profile.current_title",
             "social_handles.professional_network_identifier.profile_url",
             "experience.employment_details.current.title",
             "experience.employment_details.current.crustdata_company_id",
             "experience.employment_details.current.start_date"],
  "limit": 12
}
```

(The real request also has CTO, COO, CFO, CPO, CRO, CMO, president, and founder and CEO words in German, French and
Spanish.) Linear returned 6 people for 0.18 credits, including a Chief of Staff and an Executive Assistant to the CEO;
`leaderRole` in `src/leaders.ts` keeps the 4 real leaders. Note `basic_profile.*`, not `basic_info.*`, for people.
Crustdata's pricing page lists experience as a premium field group (0.1 to filter on, 0.1 to return), which would make
this 0.23 per person; our account was billed 0.03. Check `x-credits-used` on yours.

`npm run refresh-leaders` (monthly in the workflow) runs the same search again: new leaders are watched and reported,
leaders recorded as gone who are found again are watched again.

Leaders listed by profile URL in the portfolio are read with `POST /person/enrich`
`{ "professional_network_profile_urls": [...], "fields": ["basic_profile", "experience"] }` (1 credit each, 25 per
request), to get their name and title at the company.

### Careers page (1 credit per page)

```http
POST /web/enrich/live
{ "urls": ["https://linear.app/careers"] }
```

Up to 10 URLs per request; each result has `url`, `success`, `http_status` and `content` (the page HTML). The response
order may differ from the request order, so results are matched by `url`, never by position. Tried in order:
the `careers` column, `/careers`, `/jobs`; when the page shows fewer than 3 roles and links to a job board
(`jobs.ashbyhq.com/<org>`, Greenhouse, Lever, Workable), the board too. `countRoles` in `src/careers.ts` counts
distinct job ids in board links and same-site job pages, and reads an Ashby board's embedded postings. Linear's page
gave 32 and Supabase's 64, the same as their own job boards.

When no careers page lists roles, the job postings index is tried, free:

```http
POST /job/search
{ "filters": { "op": "and", "conditions": [
    { "field": "company.basic_info.company_id", "type": "in", "value": [633791, 809934] },
    { "field": "metadata.date_added", "type": "=>", "value": "2026-08-29" } ] },
  "limit": 0,
  "aggregations": [{ "type": "group_by", "field": "company.basic_info.company_id", "agg": "count", "size": 2 }] }
```

It is used for a company only when it has 3 or more postings in the last 60 days: in October 2026 the index was fresh
overall (2 million postings added in a week) but many startups' newest postings were months old.

### The two watchers (free to create; billed per change)

```http
POST /watch/company
{
  "entities": { "crustdata_company_ids": [633791, 809934] },
  "track": { "op": "or", "conditions": [
    { "field": "headcount.total", "type": "changed" },
    { "field": "news", "type": "added", "keys": ["article_url"] },
    { "field": "funding.last_round_type", "type": "changed" },
    { "field": "funding.last_fundraise_date", "type": "changed" },
    { "field": "funding.investors", "type": "added" },
    { "field": "funding.acquisitions", "type": "added" },
    { "field": "funding.acquired_by", "type": "added" },
    { "field": "basic_info.status", "type": "changed" } ] },
  "fields": ["basic_info", "headcount", "funding", "news"],
  "config": { "trigger": { "type": "interval", "every_hours": 24 }, "preferred_hour": 6,
              "max_results_per_run": 2, "payload_delivery_type": "link" },
  "notifications": []
}
```

```http
POST /watch/person
{
  "entities": { "professional_network_profile_urls": ["..."] },
  "track": { "op": "or", "conditions": [
    { "field": "experience.employment_details.past", "type": "added",
      "keys": [["crustdata_company_id", "title"], ["name", "title"]] },
    { "field": "experience.employment_details.current", "type": "added",
      "keys": [["crustdata_company_id", "title"], ["name", "title"]] },
    { "field": "basic_profile.current_title", "type": "changed" } ] },
  "fields": ["basic_profile", "experience", "social_handles"],
  "config": { "trigger": { "type": "interval", "every_hours": 24 }, "preferred_hour": 6,
              "max_results_per_run": 33, "refresh_frequency_days": 30, "payload_delivery_type": "link" },
  "notifications": []
}
```

Facts checked live (October 2026): the person watch takes `professional_network_profile_urls` (the live error also
names `business_emails`), not person ids. `funding.last_fundraise_date`, `funding.last_round_amount_usd` and
`basic_info.status` are trackable; `funding.total_funding_usd` is not (the docs list `funding.total_investment_usd`).
`keys` work on `news` and on the person's `experience.employment_details` tracks, so a reposted article or a re-listed
role is not billed again; they are rejected on `funding.acquisitions`. Flat entries are matched as "either one" (the
docs: "an element is already known if either one matches"), so the person tracks use nested, composite entries:
company and title together, with name and title when the company id is missing. A watcher made by an earlier version
with a different track is replaced (track is fixed at creation). `max_results_per_run` is set to the number of
companies or leaders (up to 10,000 with link delivery), so a run never drops changes over a cap.

Creates are never retried (a retry could make a second watch). Before creating, `GET /watch/{company|person}?status=active`
(free) is checked for a watch doing exactly this job (same track with keys, same fields, same list, no delivery
channel). A reused watch gets this tool's config by PATCH, and its earlier runs are marked as read. When the
portfolio changes, `PATCH /watch/{dataset}/{id}` with the new `entities` and the whole `config` block updates it in
place.

Cost: the first run of each watch is a free baseline (it returns up to 5 sample records with `changes: []`). After
that, 5 credits per company that changed in a run, and 5 per leader at 30-day freshness (10, 20, 50, 150 at 14, 7, 3,
1 days). A run that catches nothing costs nothing.

## 2. `npm run check` (daily)

For each watch: `GET /watch/{dataset}/{id}` (status: paused, suspended or cancelled becomes a warning), then

```http
GET /watch/company/56000/runs?limit=20
GET /watch/company/56000/runs/472051/summary
```

The summary's `records_download.url` (or `payload_delivery.url`, which the docs describe; both are read) is a signed
NDJSON file on `crustdata-batch-api-data.s3.amazonaws.com`, one
`{ "changes": [...], "record": {...} }` per line. A company change looks like:

```json
{ "changes": [{ "field": "headcount.total", "type": "changed", "from": 48, "to": 41 },
              { "field": "news", "type": "added", "new_elements": [{ "article_title": "...", "article_url": "...",
                "article_publish_date": "2026-10-23", "article_publisher_name": "..." }] }],
  "record": { "crustdata_company_id": 101, "basic_info": {...}, "headcount": {...}, "funding": {...} } }
```

A leader change carries the person's whole `experience.employment_details.current` and `past`; `leaderEvent` in
`src/leaders.ts` works out whether they left (only with evidence: an end date at the company, or a new main job
elsewhere), the CEO changed, they stepped back or changed title, or came back. Each run is read once and marked read
in the same transaction as the events it produced. Runs still in progress are read next time; a run whose file cannot
be read is tried again on the next 2 checks, then given up with a warning. A run that found more changes than it
delivered is reported.

When careers pages are due (every `HIRING_CHECK_DAYS` after the last reading or attempt), one `POST /web/enrich/live`
per 10 companies (1 credit each) and one free `POST /job/search` for companies counted from the index. A failure there
is a warning; the watchers' alerts still go out.

## 3. `npm run digest` (weekly)

No paid calls: two free `GET /watch/{dataset}/{id}` status checks, then every event since the last digest from the
local database, grouped by company. The footer adds up what this tool spent (from `x-credits-used`) and what the
watchers billed (`credits_deducted` on each run read).
