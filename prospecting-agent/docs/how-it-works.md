# How it works

[Back to the README](../README.md)

Every Crustdata request `npm run find` makes, with request and response shapes, in the order they happen. All requests go to `https://api.crustdata.com` with:

```
authorization: Bearer YOUR_API_KEY
content-type: application/json
x-api-version: 2025-11-01
```

Each response carries `x-credits-used`; the agent adds them up and prints the total per step. Responses below are trimmed to the fields the agent reads.

## npm run find

### 1. Validate filter values (free)

Funding stages, industries and countries are closed sets. Each value you pass is looked up first:

```http
POST /company/search/autocomplete
{ "field": "funding.last_round_type", "query": "series a", "limit": 20 }
```

```json
{ "suggestions": [{ "value": "series_a" }, { "value": "series_b" }, { "value": "series_unknown" }] }
```

A value with no exact match stops the run before any credit is spent, with the closest suggestions in the message. Seniority levels are a fixed list (`CXO`, `Owner / Partner`, `Vice President`, `Director`, ...) checked in code; `POST /person/search/autocomplete` on `experience.employment_details.current.seniority_level` returns the same list.

### 2. Ranked company search, one round per group of filters

```http
POST /company/search
{
  "search": { "query": "companies building AI sales or recruiting agents", "mode": "hybrid" },
  "filters": { "op": "and", "conditions": [
    { "field": "headcount.total", "type": "=>", "value": 20 },
    { "field": "headcount.total", "type": "=<", "value": 500 },
    { "field": "basic_info.primary_domain", "type": "not_in", "value": ["crustdata.com"] },
    { "field": "funding.last_round_type", "type": "in", "value": ["seed", "series_a", "series_b"] }
  ]},
  "fields": ["crustdata_company_id", "basic_info", "headcount", "funding", "locations", "taxonomy"],
  "limit": 100
}
```

```json
{
  "companies": [{
    "crustdata_company_id": 9000010,
    "basic_info": { "name": "Contoso Agents", "primary_domain": "contoso.example" },
    "headcount": { "total": 190, "growth_percent": { "12m": 11.8 } },
    "funding": { "last_round_type": "seed", "last_fundraise_date": "2024-12-31" },
    "locations": { "country": "USA" },
    "taxonomy": { "professional_network_industries": ["Software Development"] }
  }],
  "next_cursor": "H4sIA...",
  "total_count": null
}
```

- A new sentence (or `--explain`) runs the search in rounds: round 1 sends size, place and exclusions; round 2 adds funding; round 3 adds industry and growth. Only the groups you set create rounds. A flag change re-runs one search with all the filters, and a run whose filters did not change is refused unless you pass `--force`.
- Place filters: `locations.country in [...]` for countries, `locations.state in [...]` for US states, or `{ "field": "locations.headquarters", "type": "geo_distance", "value": { "location": "San Francisco, CA", "distance": 80, "unit": "km" } }` for a metro area. Investors: `funding.investors in ["Y Combinator"]`.
- Filters apply before ranking, so each round returns the best 100 matches of a smaller pool: some companies drop out and others move in. The log names both, and the filter each dropped company failed.
- For more than 100 companies the agent passes `next_cursor` back as `cursor`, page after page, up to 1,000. Cursors expire 20 minutes after the first page.
- `total_count` is always null for ranked search, so the log says "returned", not "matched".
- Cost per company: 0.03, plus 0.2 for each of headcount and funding filtered on, plus 0.1 taxonomy, 0.2 headcount and 0.2 funding returned (list prices).

### 3. People at the shortlist

Ten company ids per request, so one large account cannot use up a whole request's results, and your titles in an `or` of their variants (CEO also as "Chief Executive Officer"). With `--min-connections 100`, one more condition drops placeholder profiles (shown here):

```http
POST /person/search
{
  "filters": { "op": "and", "conditions": [
    { "field": "experience.employment_details.current.company_id", "type": "in",
      "value": [9000010, 9000011, "..."] },
    { "op": "or", "conditions": [
      { "field": "experience.employment_details.current.title", "type": "[.]",
        "value": "CEO" },
      { "field": "experience.employment_details.current.title", "type": "(.)",
        "value": "Head of Engineering" }
    ]},
    { "field": "professional_network.connections", "type": "=>", "value": 100 }
  ]},
  "fields": ["basic_profile", "experience", "social_handles"],
  "limit": 90
}
```

```json
{
  "profiles": [{
    "crustdata_person_id": 1000001,
    "basic_profile": { "name": "Jordan Lee", "current_title": "Co-Founder & CTO" },
    "experience": { "employment_details": { "current": [
      { "crustdata_company_id": 9000010, "name": "Contoso Agents",
        "title": "Co-Founder & CTO", "seniority_level": "CXO" }
    ]}},
    "social_handles": { "professional_network_identifier": { "profile_url": "https://..." } }
  }],
  "next_cursor": null
}
```

- You filter on `current.company_id` but read `current[].crustdata_company_id`.
- `[.]` is used for short all-caps titles (exact word, so CTO never matches CFO), `(.)` for longer ones (all words, any order).
- The search matches a title on any current role a person holds, so the code checks the title of the role at the account again and drops people whose title there matches none of yours. Advisors, investors, interns and assistants are removed the same way, by that title, not with a negation in the filter, because a negation would drop a CEO who is also an angel investor somewhere else.
- A request that comes back full (one big account used the results) is followed by one request per account that got nothing.
- Accounts where no title matched, up to 1,000 people, get a second search with `seniority_level in ["CXO", "Owner / Partner", "Vice President"]` and `"post_processing": { "exclude_profiles": [ ...profile URLs already found ] }`. `--fallback none` skips it.
- Cost per person returned: 0.03, plus 0.1 experience filtered on and 0.1 experience returned; the optional connections floor adds 0.2. The agent asks for up to three candidates per person it keeps, so it can pick the best by your title order, and every candidate is billed.

## Watching the accounts

This repo does not run watches. `npm run watch-example` writes the request bodies for a Crustdata company watcher and job watcher over the shortlist, and you create them yourself; Crustdata then delivers each change to Slack, Google Chat, email or a webhook. The requests, costs and how to pause or cancel them are in [watch-accounts.md](watch-accounts.md).
