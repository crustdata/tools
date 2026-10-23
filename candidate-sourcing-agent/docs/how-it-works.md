# How Candidate Sourcing Agent works: every Crustdata API request, in order

Every Crustdata request `npm run source` sends, in order, with what comes back and what it costs at list price. Before the first paid request the run reads `GET /account/endpoints` (free) to price its estimate with your account's own rates; `--dry-run` stops there. The example is the README role: `--role "Machine learning engineer, 4+ years, PyTorch, shipped models in production, United States, at a company under 500 people" --must PyTorch --nice "Kubernetes, LLM fine-tuning" --exclude yourcompany.example`. Counts are from a live run on 2026-10-21; people in the examples are made up.

```text
role sentence + flags
  │  parseSentence (rules, src/role.ts)  title, years, place, size, past employers, schools, skills;
  │                                     words about age, gender, origin and the like taken out
  ▼
POST /person/search/autocomplete      free       stored spelling of every skill, country, state, school
  ▼
POST /person/search  (filters only)   1 result   round counts: place, then skills and years
  ▼
POST /person/search  (query + filters, mode exact, exclude_profiles = seen.csv)
  ▼                                   per result  the ranked candidates, best first, with a fit tier
POST /person/search  (id in [...] and open to new roles)
  ▼                                   per open person
scoreCandidate (rules, src/score.ts)  →  candidates.csv, shortlist.md, seen.csv
```

## 1. Check stored values (free)

Skills, countries, states and schools are stored values, and a filter on a value that is not stored matches nobody without an error. Each one is checked first:

```json
POST /person/search/autocomplete
{ "field": "skills.professional_network_skills", "query": "PyTorch", "limit": 10 }

{ "suggestions": [ { "value": "PyTorch" }, { "value": "PyTorch Lightning" }, { "value": "TensorFlow / PyTorch" } ] }
```

A `--must` skill, country or state without an exact (case-insensitive) match stops the run with these suggestions. A skill word from the sentence without a match stays in the query only and is not scored. The run says which is which. A skill stored only under longer names is found by asking for its usual spellings too ("Go" as "Golang", "Go (Golang)", "Go Programming Language", "Go (Programming Language)"), and the filter then accepts any of them.

## 2. Round counts (one result each)

To show which group of filters narrows the most, the run counts each round before the ranked search: round 1 is the place, round 2 adds skills and years, round 3 (the ranked search itself) adds the employer, school and signals. A count is a filters-only search for one result, billed for that round's filters only:

```json
POST /person/search
{
  "filters": { "op": "and", "conditions": [
    { "op": "or", "conditions": [
      { "field": "assessment.authenticity.tier", "type": "=<", "value": 8 },
      { "field": "assessment.authenticity.tier", "type": "is_null", "value": null }
    ] },
    { "field": "basic_profile.location.country", "type": "in", "value": ["United States"] },
    { "field": "skills.professional_network_skills", "type": "=", "value": "PyTorch" },
    { "field": "years_of_experience_raw", "type": "=>", "value": 4 }
  ] },
  "fields": ["crustdata_person_id"],
  "limit": 1,
  "explain": true
}

{ "profiles": [ { "crustdata_person_id": 123 } ], "total_count": 55766, "remarks": [] }
```

The first condition is always there: it leaves out profiles Crustdata rates least trusted (authenticity tier 9) and keeps profiles it has not rated. Cost: 0.03 plus the filter groups (here skills, 0.1; place and years are free). Only the lower end of a years range is a filter; the upper end only scores. When a count is 0, the same request costs nothing and `explain: true` names the culprit:

```json
{ "profiles": [], "total_count": 0, "remarks": [
  { "code": "condition_eliminates_all", "path": "filters.conditions[3]", "matches_without": 9120 }
] }
```

`conditions[3]` maps back to the filter's label and the flag that drops it, which the run prints. No ranked search runs.

## 3. The ranked search

```json
POST /person/search
{
  "search": { "query": "Machine learning engineer, 4+ years, PyTorch, shipped models in production, United States, at a company under 500 people", "mode": "hybrid" },
  "mode": "exact",
  "filters": { "op": "and", "conditions": [
    { "op": "or", "conditions": [ "... authenticity, as above ..." ] },
    { "field": "basic_profile.location.country", "type": "in", "value": ["United States"] },
    { "field": "skills.professional_network_skills", "type": "=", "value": "PyTorch" },
    { "field": "years_of_experience_raw", "type": "=>", "value": 4 },
    { "field": "experience.employment_details.current.company_headcount_range", "type": "in", "value": ["2-10", "11-50", "51-200", "201-500"] },
    { "field": "experience.employment_details.current.company_website_domain", "type": "not_in", "value": ["yourcompany.example"] }
  ] },
  "fields": ["fit", "basic_profile", "experience", "education", "skills", "social_handles"],
  "limit": 20,
  "post_processing": { "exclude_profiles": ["<profile URL of example-jane-doe>", "..."] }
}
```

- `search.mode: "hybrid"` ranks by keywords and meaning over the whole profile. `--keywords` sends `mode: "lexical"` with `query_syntax: "boolean"` instead.
- Top-level `mode: "exact"` makes the filters hard: every person returned meets all of them, and `total_count` (15,934 on the live run) is the number who do, minus those excluded.
- `exclude_profiles` is `seen.csv`. Those people are not returned and not billed. On the live second run `total_count` dropped by exactly the 20 people seen in the first.
- No `sorts`: the results are already in relevance order.

The answer, one profile shown, trimmed:

```json
{
  "profiles": [
    {
      "crustdata_person_id": 9001,
      "fit": "strong",
      "basic_profile": { "name": "Jane Doe", "headline": "Senior ML Engineer, recommender systems in production",
        "location": { "full_location": "San Francisco, California, United States" } },
      "experience": { "employment_details": {
        "current": [ { "title": "Senior Machine Learning Engineer", "name": "Example Labs", "is_default": true,
          "start_date": "2023-03-01T00:00:00", "company_headcount_latest": 120, "company_headcount_range": "51-200",
          "company_website": "https://www.examplelabs.example/" } ],
        "past": [ { "title": "Machine Learning Engineer", "name": "Example AI", "start_date": "2019-06-01T00:00:00", "end_date": "2023-02-01T00:00:00" } ]
      } },
      "education": { "schools": [ { "school": "Example State University", "degree": "Master of Science" } ] },
      "skills": { "professional_network_skills": ["PyTorch", "Machine Learning", "Kubernetes", "Python"] },
      "social_handles": { "professional_network_identifier": { "profile_url": "<profile URL of example-jane-doe>" } }
    }
  ],
  "next_cursor": "H4sIA...",
  "total_count": 15934,
  "total_count_relation": "eq"
}
```

Cost per candidate at list price: 0.03, plus 0.1 for each data group filtered on (experience for the employer size and exclusion, skills for `--must`), plus 0.1 each for experience, education and skills returned: 0.53. Twenty candidates: 10.6. On plans that include the data groups, the ranked search is 0.6 (0.03 per candidate); the whole run, with the two round counts and the open-to-new-roles check, measured 0.69 on 2026-10-21.

Each page is written to `seen.csv` and `profiles.json` as soon as it comes back, so a failure on a later page or step never loses (and re-bills) people already paid for. Then two guards run locally, page by page: anyone in `seen.csv` under another URL form, and anyone holding any current role at an `--exclude` company (the API filter tests the roles one at a time, so a person with a second current role there can still come back). Both are billed, so both go into `seen.csv`.

If a key cannot read a group (some plans do not return `skills`, research records are enabled on request), the search answers 403 `Access denied to fields: skills`; the run drops that group, says so once and asks for the same page again.

When the ranked search returns nobody, one more filters-only count tells the cases apart: free when nobody matches (and `explain` names the filter), one counted result when everyone who matches was seen before.

## 4. Open to new roles

```json
POST /person/search
{
  "filters": { "op": "and", "conditions": [
    { "field": "crustdata_person_id", "type": "in", "value": [9001, 9002, 9003] },
    { "field": "professional_network.open_to_cards", "type": "in", "value": ["CAREER_INTEREST"] }
  ] },
  "fields": ["crustdata_person_id"],
  "limit": 20
}

{ "profiles": [ { "crustdata_person_id": 9001 } ], "total_count": 1 }
```

Billed only for the people who are open (0.03 plus the professional network filter, 0.2): 1 to 4 people in 20 on the live runs. Returning that data group for everyone instead would add 0.2 to every candidate. With `--open-only` this step is skipped, because the filter is in the ranked search.

## 5. Score and write

`scoreCandidate` in `src/score.ts` turns each record into a score and its reasons (see [How does candidate scoring work?](../README.md#how-does-candidate-scoring-work)). All candidates found for the role so far are kept in `out/<role>/profiles.json` and scored again on every run, so `candidates.csv` is always the full, current ranking; `shortlist.md` shows the top of this run's new people. `role.json` keeps the spec for the next run, and `seen.csv` gets every profile URL returned.

Each person in `shortlist.md` reads like this (from the offline replay, made-up people; the lines are indented here so the sample is not read as headings of this page):

```text
  ## 1. Jane Doe (score 100)

  Senior Machine Learning Engineer at Example Labs, San Francisco, California, United States

  Before: Example AI (Machine Learning Engineer, 2019 to 2023); Megacorp Example (Machine Learning Intern, 2018)

  Education: Master of Science, Computer Science, Example State University

  - strong fit for the role
  - has PyTorch
  - nice to have: Kubernetes
  - current title Senior Machine Learning Engineer
  - 7 yrs worked (asked 4+)
  - 3.6 yrs in current role
  - company of 120 people
  - open to new roles
```


## Contacts (`npm run contacts`)

```json
GET /account/endpoints
[ { "path": "/person/contact/enrich", "status": "enabled",
    "fields": { "enabled": ["contact.personal_emails", "contact.business_emails", "contact.phone_numbers"] } }, "..." ]
```

Free. Without `/person/contact/enrich` (or `/person/enrich` with contact fields) enabled, the command stops: contact data needs enabling on your Crustdata account; self-serve keys do not have it.

```json
POST /person/contact/enrich
{ "professional_network_profile_urls": ["<profile URL of example-jane-doe>", "..."], "fields": ["contact.personal_emails"] }

[
  { "matched_on": "<profile URL of example-jane-doe>", "match_status": "matched",
    "matches": [ { "person_data": { "contact": { "personal_emails": [ { "email": "jane.doe@example.com", "status": "deliverable" } ] } } } ] },
  { "matched_on": "<profile URL of example-sam-example>", "match_status": "not_found", "matches": [] }
]
```

25 URLs per request, 15 requests a minute, and `contacts.csv` is written after every batch. 2 credits per person found for personal emails (1 for work emails, 2 for phones), nothing for `not_found` or `redacted`.

## The watcher (`npm run watch-example`)

Nothing is sent. The file it writes is the body for:

```json
POST /watch/person/search
{
  "filters": { "op": "and", "conditions": [ "... the role's filters ...",
    { "field": "experience.employment_details.current.title", "type": "(.)", "value": "Machine learning engineer" } ] },
  "fields": ["basic_profile", "experience.employment_details.current", "skills", "social_handles"],
  "config": { "trigger": { "type": "interval", "every_hours": 168 }, "max_results_per_run": 50 },
  "notifications": [ { "type": "slack", "webhook_url": "https://hooks.slack.com/services/..." } ]
}
```

Watchers take filters only, no plain-English query, so the role title is added as a filter, at any level and with its abbreviation ("machine learning engineer" or "ML engineer"). Checked live: Crustdata accepts this body (201, watcher cancelled straight after). A watcher delivers people whose profiles are new to the filters or changed since its last run, without the seen list or the score. First run free, then 0.5 credits per person delivered.
