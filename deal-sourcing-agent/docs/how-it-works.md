# How Deal Sourcing Agent works: every Crustdata API request

Every Crustdata API request Deal Sourcing Agent sends (`npm run source`), in order, with what comes back and what it costs at list price. Responses are trimmed to the fields the agent reads, with invented values. All requests send `authorization: Bearer <key>`, `content-type: application/json` and `x-api-version: 2025-11-01`; the code is in [src/crustdata.ts](../src/crustdata.ts) and the order in [src/source.ts](../src/source.ts).

```text
thesis sentence + flags
  |  src/thesis.ts: rules turn words into filters, flags win; printed with the cost first
  v
1. POST /company/search/autocomplete   stage and country values         free
2. POST /company/search                ranked search on the thesis      ~1 credit per company
3. POST /person/search                 founders, CEOs, CTOs             0.33 per person
4. POST /job/search  (limit 0)         roles posted, 90 and 30 days     free
5. POST /social_post/search (limit 0)  founders' traction, round posts  free
6. POST /social_post/search            quotes, top companies            0.5 per post
7. POST /job/search                    newest role titles               0.03 per listing
  |  src/score.ts, src/pipeline.ts: score, rank, new / still here / back / gone
  v
out/: pipeline.csv  founders.csv  pipeline.md  memos/  data.json  thesis.json  history.json
```

Steps 2 to 7 are saved to `out/.partial-<id>.json` after every company search page, every batch and every company; a resumed company search asks only for the companies it does not have yet (`crustdata_company_id not_in` the ones it has). If a run stops (out of credits, a network error), running the same command again within 24 hours resumes from there and does not pay again for anything already paid. A paid search that fails with 500, 502 or 504 is not retried, because it may already have been billed; 429 and 503 are.

## 1. Validate values: Crustdata autocomplete (free)

Stages and countries are closed sets: "Series A" matches nothing, the stored value is `series_a`. Each one is checked before a credit is spent.

```http
POST https://api.crustdata.com/company/search/autocomplete
authorization: Bearer $CRUSTDATA_API_KEY
content-type: application/json
x-api-version: 2025-11-01

{ "field": "funding.last_round_type", "query": "pre seed", "limit": 20 }
```

```json
{ "suggestions": [ { "value": "pre_seed" } ] }
```

Countries written as common ISO-3 codes (`USA`, `GBR`, `DEU`) are accepted without a call.

## 2. Crustdata company search (paid)

The thesis minus the words the parser turned into filters goes to `search.query`. Hard filters apply before ranking.

```http
POST https://api.crustdata.com/company/search
authorization: Bearer $CRUSTDATA_API_KEY
content-type: application/json
x-api-version: 2025-11-01

{
  "search": { "query": "AI infrastructure", "mode": "hybrid" },
  "filters": { "op": "and", "conditions": [
    { "field": "headcount.total", "type": "=>", "value": 2 },
    { "field": "basic_info.year_founded", "type": "=>", "value": 2024 },
    { "field": "locations.country", "type": "in", "value": ["USA"] },
    { "field": "funding.last_round_type", "type": "in", "value": ["pre_seed", "seed"] }
  ] },
  "fields": ["crustdata_company_id", "basic_info", "headcount", "funding",
             "locations", "followers"],
  "limit": 10
}
```

```json
{
  "companies": [ {
    "crustdata_company_id": 900101,
    "basic_info": {
      "name": "Relaywise", "primary_domain": "relaywise.example", "year_founded": 2024,
      "description": "Relaywise is a runtime for AI agents...",
      "professional_network_url": "https://..."
    },
    "headcount": {
      "total": 14,
      "growth_percent": { "3m": 16.7, "6m": 55.6 },
      "growth_absolute": { "3m": 2, "6m": 5 }
    },
    "funding": {
      "last_round_type": "seed", "last_fundraise_date": "2025-03-10",
      "last_round_amount_usd": 4200000, "total_investment_usd": 4700000,
      "investors": ["Lindenfield Ventures"]
    },
    "locations": { "country": "USA", "headquarters": "San Francisco, California, ..." },
    "followers": { "count": 2900, "six_months_growth_percent": 38 }
  } ],
  "next_cursor": "...",
  "total_count": null
}
```

- Up to 100 companies per page and 1,000 per search; the cursor expires 20 minutes after the first page, so pages are fetched back to back.
- Other filters the flags and the sentence add:
  - `funding.last_fundraise_date` `is_null` with `"value": null` (`--unfunded`, combined with the stages in an `or`)
  - `funding.last_fundraise_date` `=>` a date (`--raised-since`, `--raised-within`, "raised in the last 12 months")
  - `funding.investors` `in` / `not_in` (`--with-investors`, `--exclude-investors`)
  - `headcount.growth_percent.3m` (or `6m`, `12m`) `=>` (`--min-growth`, `--growth-months`)
  - `basic_info.primary_domain` `not_in` (`--exclude`)
  - places: one `or` group of `locations.country in`, `locations.state in` and `geo_distance` on `locations.headquarters` (cities), so "Bay Area or London" matches either
- `funding` also carries `contact_email` and `phone_number`. They are never copied, saved or printed.
- `hiring` is not requested: it comes back null on search. Roles come from step 4.
- `--explain` runs this search once per group of filters (the thesis plus size, age and place; plus funding; plus growth) and prints what each group dropped. It costs one search per round.
- Cost: 0.03 per company, plus 0.2 for each premium group filtered on (headcount, funding) and each returned (headcount, funding, followers): about 1.03 per company at list price.

## 3. Founders: Crustdata person search (paid)

Ten companies per request. Each person's title on the role at the company in question is checked again in code ([src/founders.ts](../src/founders.ts)); advisors, founders associates, "Head of Founder Relations" style titles and placeholder profiles are dropped, the same person under two ids is kept once, and up to three founders are kept per company, founder and CEO first.

```http
POST https://api.crustdata.com/person/search
authorization: Bearer $CRUSTDATA_API_KEY
content-type: application/json
x-api-version: 2025-11-01

{
  "filters": { "op": "and", "conditions": [
    { "field": "experience.employment_details.current.company_id",
      "type": "in", "value": [900101, 900102] },
    { "op": "or", "conditions": [
      { "field": "experience.employment_details.current.title",
        "type": "[.]", "value": "Founder" },
      { "field": "experience.employment_details.current.title",
        "type": "[.]", "value": "CEO" }
    ] }
  ] },
  "fields": ["basic_profile", "experience", "education", "social_handles"],
  "limit": 60
}
```

(Titles trimmed; the full list is `FOUNDER_TITLES` in [src/founders.ts](../src/founders.ts).)

```json
{
  "profiles": [ {
    "crustdata_person_id": 800001,
    "basic_profile": { "name": "Jane Doe", "headline": "Building Relaywise." },
    "experience": { "employment_details": {
      "current": [ { "title": "Co-Founder & CEO", "name": "Relaywise",
                     "crustdata_company_id": 900101, "start_date": "2024-02-01T00:00:00" } ],
      "past": [ { "title": "Founder", "name": "Tidewell Data", "crustdata_company_id": 700001,
                  "company_website": "https://tidewell.example",
                  "start_date": "2018-04-01T00:00:00", "end_date": "2022-06-01T00:00:00",
                  "company_headcount_latest": 35 } ]
    } },
    "education": { "schools": [ { "school": "Stanford University", "degree": "MS",
                                  "field_of_study": "Computer Science", "end_year": 2014 } ] },
    "social_handles": { "professional_network_identifier": { "profile_url": "https://..." } }
  } ],
  "next_cursor": null
}
```

- The limit is 6 per company in the batch. When a batch comes back full, companies in it with no founder found are searched one by one.
- Cost: 0.03 per person, plus 0.1 for filtering on experience, 0.1 for receiving it and 0.1 for education: 0.33 per person at list price.

## 4. Roles posted: Crustdata job search counts (free)

One request counts listings for every company in the last 90 days (and one more for 30 days). `limit: 0` with a `group_by` returns counts only and costs nothing.

```http
POST https://api.crustdata.com/job/search
authorization: Bearer $CRUSTDATA_API_KEY
content-type: application/json
x-api-version: 2025-11-01

{
  "filters": { "op": "and", "conditions": [
    { "field": "company.basic_info.company_id", "type": "in", "value": [900101, 900102] },
    { "field": "metadata.date_added", "type": "=>", "value": "2026-07-23" }
  ] },
  "limit": 0,
  "aggregations": [ { "type": "group_by", "field": "company.basic_info.company_id",
                      "agg": "count", "size": 1000 } ]
}
```

```json
{ "job_listings": [], "aggregations": [ { "buckets": [ { "key": 900101, "count": 12 } ] } ] }
```

One role is often listed on several job sites, so for each company with listings the agent then counts distinct titles (also free): the same request for one company with `"field": "job_details.title"` in the `group_by`, and the number of buckets is the number of roles. The memo shows both ("7 roles, counted once each, 12 listings across job sites"). Closed listings can stay in the index for a while, so the measure is "posted in the last N days".

## 5. Founders' posts counted: Crustdata social post search (free)

For the top companies so far (`--posts`, default 50), two counts per company: posts in the last 6 months with a traction phrase, and posts with round news (an exact round phrase such as "closed our seed", or an announcement phrase and a round phrase together, as a nested `and` group). Round posts only count from 60 days after the last round on record, so the round already in the data does not read as a new one. Authors are the founders found in step 3. The phrases are in [src/signals.ts](../src/signals.ts).

```http
POST https://api.crustdata.com/social_post/search
authorization: Bearer $CRUSTDATA_API_KEY
content-type: application/json
x-api-version: 2025-11-01

{
  "filters": { "op": "and", "conditions": [
    { "field": "actor.actor_type", "type": "=", "value": "person" },
    { "field": "actor.crustdata_entity_id", "type": "in", "value": [800001, 800002] },
    { "field": "date_posted", "type": "=>", "value": "2026-04-21" },
    { "op": "or", "conditions": [
      { "field": "text", "type": "[.]", "value": "MRR" },
      { "field": "text", "type": "[.]", "value": "paying customers" }
    ] }
  ] },
  "limit": 0
}
```

```json
{ "posts": [], "next_cursor": null, "total_count": 2 }
```

- `limit: 0` costs nothing.
- Companies below the top `--posts` are scored as having no traction posts (with the reason in the memo), so a company that was not checked never outranks one that was. A count that fails for one company is left out of that company's score.
- Post search is enabled per Crustdata account. A key without it gets `403`; the run then skips this signal for every company and asks no more. A `403` about credits stops the run like a `402`.
- Company page posts are not searched: in a live check they used the same words as product marketing.

## 6. Founders' posts quoted: Crustdata social post search (paid)

For the top companies with matching posts (`--quotes`, default 5), the 2 newest matching posts, so the memo can quote the sentence, date and link.

```http
POST https://api.crustdata.com/social_post/search
authorization: Bearer $CRUSTDATA_API_KEY
content-type: application/json
x-api-version: 2025-11-01

{
  "filters": { "...": "same as step 5, with both phrase lists" },
  "fields": ["share_url", "date_posted", "text", "actor"],
  "sorts": [ { "field": "date_posted", "order": "desc" } ],
  "limit": 2
}
```

```json
{ "posts": [ { "date_posted": "2026-09-28T10:00:00Z",
               "text": "...we're at $85K MRR, up 30% month over month...",
               "share_url": "https://...", "actor": { "name": "Jane Doe" } } ] }
```

Cost: 0.5 per post returned.

## 7. Newest role titles: Crustdata job search (paid)

For the top companies that posted roles (`--jobs`, default 20), the 10 newest listings, kept once per title, 5 shown in the memo.

```http
POST https://api.crustdata.com/job/search
authorization: Bearer $CRUSTDATA_API_KEY
content-type: application/json
x-api-version: 2025-11-01

{
  "filters": { "field": "company.basic_info.company_id", "type": "=", "value": 900101 },
  "sorts": [ { "field": "metadata.date_added", "order": "desc" } ],
  "fields": ["job_details.title", "job_details.url", "metadata.date_added"],
  "limit": 10
}
```

```json
{ "job_listings": [ { "job_details": { "title": "Founding Solutions Engineer",
                                       "url": "https://..." },
                      "metadata": { "date_added": "2026-10-14T09:00:00" } } ] }
```

Cost: 0.03 per listing returned.

## Scoring, ranking and re-runs (no requests)

- [src/score.ts](../src/score.ts) scores each company from the fields above. The weights, the timing rules (a window per stage, 12 to 24 months after a seed, that only earns points with recent growth), the missing-data rule and every reason text are there; the README has the table.
- [src/pipeline.ts](../src/pipeline.ts) ranks by score (search order breaks ties) and compares with `out/history.json`, which keeps one history per pipeline (thesis and filters; exclusions and scoring settings do not count). A company in the last run of the same pipeline is "still here", one seen in an earlier run but not the last is "back", others are "new", and each carries what changed (score, timing label, team size, a new round). Companies of the last run that are not in this one are listed as "gone" in `pipeline.md`, and their memos move to `memos/gone/`.
- Relative dates in a thesis ("founded in the last 2 years") are saved relative and turned into dates on each run.
- [src/memo.ts](../src/memo.ts) writes the memos from `out/data.json` only, so `npm run memo -- <domain>` costs nothing.

## Optional: the AI analysis

With `--ai` and `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, each memo's saved facts (as JSON) go to the provider with the instructions in [prompts/memo-analysis.md](../prompts/memo-analysis.md), and the answer becomes the memo's "Analysis" section, with raw HTML and non-https links removed. The model is the newest general model the key lists (`GET /v1/models`, free), unless `ANTHROPIC_MODEL` or `OPENAI_MODEL` pins one. Nothing is sent to an AI provider without `--ai`.

## Watching (Crustdata, not this repo)

The two watchers in the README are created in the Crustdata app at [app.crustdata.com/watch](https://app.crustdata.com/watch). For reference:

- A company discovery watch (`POST /watch/company/search`) runs filters only, with no ranked query. Free baseline sample of up to 5, then 2 credits per new company.
- A company entity watch (`POST /watch/company`) takes a list of companies and a `track` tree such as `funding.last_round_type changed`, `headcount.total changed`, `hiring.openings_count changed`, `news added`. Free baseline, then 5 credits per changed company.

See the [Company Discovery Watcher](https://docs.crustdata.com/watcher-docs/company/discovery) and [Company Entity Watcher](https://docs.crustdata.com/watcher-docs/company/entity) docs.
