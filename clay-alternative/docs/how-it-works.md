# How it works

Every Crustdata request the tool makes, in the order a run makes them, with what comes back and what it costs. List prices; your account's prices are read live from `GET /account/endpoints` and used instead. Headers on every call: `authorization: Bearer <key>`, `x-api-version: 2025-11-01`, `content-type: application/json`. The credits a response cost come back in its `x-credits-used` header; the tool sums those for the cost bar.

## 0. Reading the file (no calls)

`lib/csv.ts` reads the CSV (BOM, `,` `;` or tab, quoted cells), recognises the CRM column names (`Email Address`, `Website URL`, `Company Domain Name`, `Account Name`, `Profile URL`, `First Name` + `Last Name`, ...) and gives every row one identifier, in this order: profile URL, work email, domain, company name. A row with both a work email and a website column keeps the website as the company. Duplicates are merged, and every row keeps its real line number. `lib/normalize.ts` makes one spelling of each identifier (`https://www.Stripe.com/x` becomes `stripe.com`; profile URLs lose case, query and trailing slash). Personal email providers (`lib/personal-domains.ts`) are flagged.

`lib/plan.ts` then works out, without I/O, the unique people and companies to look up, the field groups each call needs, and the estimate.

## 1. Setup (free)

```http
GET /account/credits
GET /account/endpoints
```

`/account/credits` gives the balance shown on the page. `/account/endpoints` lists, per path, `status`, `effective_rate_limit_rpm`, `base_credits` and `premium_fields` (`[{ field, credits }]`). From it the tool reads the price of a company profile, the tech stack add-on, a person, the work email add-on, and whether `contact.business_emails` is available to this key at all (it is listed only when contact data is enabled on the account; self-serve keys do not have it).

When the file has email rows, one more free probe checks that the key can look people up by address:

```http
POST /person/enrich
{ "business_emails": ["probe-no-such-person-404@example.com"], "fields": ["basic_profile"] }
```

A `200` with `match_status: "not_found"` costs nothing and means yes; a `403` or `400` means email rows will be reported as "needs access" rather than failing mid-run.

## 2. Resolve companies (free)

```http
POST /company/identify
{ "domains": ["acme.example", "northwind.example"] }        up to 25
{ "names": ["Acme Analytics"] }                              or up to 25 names
```

```json
[{ "matched_on": "acme.example", "match_type": "domain",
   "matches": [{ "confidence_score": 1.0, "company_data": {
     "crustdata_company_id": 100001,
     "basic_info": { "name": "Acme Analytics", "primary_domain": "acme.example", "all_domains": ["acme.example"],
                     "website": "https://acme.example", "description": "...", "year_founded": 2018,
                     "employee_count_range": "201-500", "company_type": "Privately Held",
                     "industries": ["Software Development"] },
     "headcount": { "total": 240 },
     "locations": { "country": "USA", "headquarters": "San Francisco, California, United States" } } }] }]
```

0 credits, 30 calls a minute. The eleven free columns (name, domain, website, description, year founded, headcount, employee range, HQ, country, industry, type) are read from this response.

Two rules keep this honest (`pickDomainMatch`, `pickNameMatch` in `lib/run.ts`):

- A domain match is accepted only when the record's `primary_domain`, `all_domains` or website host is the domain asked for (or a parent of it). Identify returns companies hosted on a platform's domain with `confidence_score` 1.0; those are reported as "not found, closest: X".
- A name match needs a clear winner: exactly one record with that name (compared without case, punctuation or suffixes such as Inc and GmbH), or one at least three times larger by headcount than the next. Otherwise the row is "ambiguous: add a domain".

## 3. Company columns (2 credits per company)

```http
POST /company/enrich
{ "crustdata_company_ids": [100001, 100002], "fields": ["headcount", "funding", "hiring"] }   up to 25
```

`fields` holds only the groups the chosen columns need, from `basic_info`, `headcount`, `funding`, `locations`, `taxonomy`, `hiring`, `web_traffic`, `people`, `followers`, `technographics`. 2 credits per company returned, plus 2 when `technographics` is asked for and returned. 15 calls a minute. One call per unique company fills every company column for every row at that company.

```json
[{ "matched_on": "100001", "match_type": "crustdata_company_id",
   "matches": [{ "confidence_score": 1.0, "company_data": {
     "crustdata_company_id": 100001,
     "headcount": { "total": 240, "growth_percent": { "mom": -1.3, "qoq": -1.4, "six_months": 10.2, "yoy": 21.7, "two_years": 51.1 },
                    "by_role_absolute": { "Engineering": 120, "Sales": 40, ... } },
     "funding": { "total_investment_usd": 48000000, "last_round_type": "series_b", "last_round_amount_usd": 30000000,
                  "last_fundraise_date": "2025-06-12", "investors": ["Example Ventures", ...], "num_funding_rounds": 3 },
     "hiring": { "openings_count": 14, "openings_growth_percent": { "mom": 0.1, "qoq": 0.25, "yoy": 0.4 },
                 "recent_openings": [{ "title": "Senior Backend Engineer", ... }] },
     "web_traffic": { "domain_traffic": { "acme.example": { "monthly_visitors": 240000, ... } } },
     "taxonomy": { "categories": ["B2B", "SaaS"], ... },
     "people": { "founders": [{ "basic_profile": { "name": "Jane Doe", "current_title": "Co-Founder & CEO" } }], "cxos": [...] },
     "technographics": { "top_technologies": ["Python", "PostgreSQL", "React"], ... } } }] }]
```

Two facts worth knowing: growth keys are `mom, qoq, six_months, yoy, two_years`, and `hiring.openings_growth_percent` values are fractions (0.4 is 40%), which the column converts. A group the key cannot read fails the call with `400 Invalid fields: x`; the client drops the group, retries, and the affected cells say "needs access".

## 4. Person columns by profile URL (1 credit per match)

```http
POST /person/enrich
{ "professional_network_profile_urls": ["https://www.linkedin.com/in/example-jane-doe"],
  "fields": ["basic_profile", "experience", "education", "skills", "social_handles"] }     up to 25
```

```json
[{ "matched_on": "https://www.linkedin.com/in/example-jane-doe", "match_type": "professional_network_profile_url",
   "match_status": "matched",
   "matches": [{ "confidence_score": 1.0, "person_data": {
     "crustdata_person_id": 900001,
     "basic_profile": { "name": "Jane Doe", "current_title": "Co-Founder & CEO", "headline": "...",
                        "location": { "city": "San Francisco", "country": "United States", "raw": "San Francisco, United States" },
                        "normalized_title": { "department": "Executive Leadership", ... } },
     "experience": { "years_of_experience_raw": 7.5,
                     "employment_details": { "current": [{ "name": "Acme Analytics", "title": "Co-Founder & CEO", "is_default": true,
                                                            "company_website_domain": "acme.example", "crustdata_company_id": 100001,
                                                            "start_date": "2023-03-01T00:00:00+00:00", "seniority_level": "CXO" }],
                                             "past": [{ "name": "Northwind Robotics", ... }] } },
     "education": { "schools": [{ "school": "Example University", "degree": "MS", "field_of_study": "Computer Science" }] },
     "skills": { "professional_network_skills": ["Python", "Leadership"] },
     "social_handles": { "professional_network_identifier": { "profile_url": "https://www.linkedin.com/in/example-jane-doe" } } } }] },
 { "matched_on": "https://www.linkedin.com/in/example-nobody-404", "match_type": "professional_network_profile_url",
   "match_status": "not_found", "matches": [] }]
```

Results are matched to inputs by `matched_on`, normalised the same way as the input, never by position. `match_status` is `matched`, `not_found` or `redacted` (the person asked Crustdata to remove their data; nothing is billed, and retrying does not change it). Only `matched` costs: 1 credit. Experience, education and skills are in the base price. 15 calls a minute, 25 per call.

The current role (`is_default`, else the first current one) gives the person's company columns and, for rows with no company of their own, the `company_website_domain` that then goes through steps 2 and 3.

## 5. Person columns by work email (1 credit per match)

```http
POST /person/enrich
{ "business_emails": ["jane@acme.example", "nobody@acme.example"], "fields": [...] }      up to 25
```

Same response shape with `match_type: "business_email"`; a miss is `match_status: "not_found"` with `x-credits-used: 0`. Personal addresses (gmail and the like) can match too. One malformed address fails the whole batch with `400 Invalid business emails: a, b`, so the client pulls the named addresses out, reports them as invalid with their line numbers, and retries the rest (again if the API names more).

The company for an email row comes from the address's domain (step 2). When that domain resolves to nothing (a brand domain, a `.co` beside the `.com`), the run falls back to the employer domain on the profile and says so in the row's note; if no person columns were ticked, that row gets one person lookup (1 credit if matched) just to read the employer. The company cells stay pending until then, so a row never shows "not found" and then fills in.

## 6. Work email column (+1 credit per person with an email, needs contact access)

Ticking `Work email` adds `"contact.business_emails"` to the `fields` of the same person call:

```json
"contact": { "business_emails": [{ "email": "jane@acme.example", "status": "deliverable", "crustdata_company_id": 100001 }] }
```

+1 credit per person for whom an email comes back. The column picks the deliverable address at the current employer. The field is offered only when `/account/endpoints` lists it under `premium_fields` for `/person/enrich`; otherwise the picker shows "needs contact access", the API leaves the column empty with that status, and the CLI refuses the column with the same sentence. Contact data needs enabling on your Crustdata account; self-serve keys do not have it.

## 7. Find people at accounts (about 0.03 credits per result)

```http
POST /person/search
{ "filters": { "op": "and", "conditions": [
    { "field": "experience.employment_details.current.company_id", "type": "in", "value": [100001] },
    { "op": "or", "conditions": [
      { "field": "experience.employment_details.current.title", "type": "(.)", "value": "VP Sales" },
      { "field": "experience.employment_details.current.title", "type": "(.)", "value": "Head of Marketing" } ] } ] },
  "fields": ["basic_profile", "experience", "social_handles"], "limit": 15 }
```

0.03 credits per search result at list price (the search asks for three times `--limit` so the title check has candidates; experience and the other groups returned here were priced 0 on the account this was built with, and list price may add premium groups). The titles are checked again in code against the role at that company, because the search matches any current role; advisors, investors and interns are dropped.

## 8. The cache

Every result is saved under one key: `person:url:<url>`, `person:email:<email>`, `company:identify:domain:<domain>`, `company:identify:name:<name>`, `company:enrich:<id>`, with the field groups it was fetched with, the credits it cost and the fetch time. A cached record answers a request when it holds every group the request needs and is younger than `--max-age` days (CLI, default 30); misses always answer. The CLI keeps this in `data/cache.sqlite` (saved after every batch, so an interrupted run resumes); the web app keeps one in memory per key for `CACHE_TTL_HOURS`. Each cell carries the fetch date (hover on the page).

## 9. Rate limits and retries

Calls are paced under each path's `effective_rate_limit_rpm` (defaults: identify 30, enrich 15, person enrich 15, search 30). A `429` waits for `x-ratelimit-reset` seconds and retries. A `5xx` or a network failure on a free call retries twice with backoff; on a paid call neither is retried, because a gateway error can arrive after the backend billed the batch, and the row says "Crustdata did not respond" instead. People and companies run side by side, so a file of 500 emails at 200 domains takes about 20 person calls and 8 company calls, around two minutes.

## 10. Events

The runner emits one stream of events (`lib/events.ts`) that the page renders, the CLI prints and `npm run replay` plays back: `start` (rows, columns, estimate, warnings, problems), `cells` (one row's new cells, each with `value`, `status` and `source`), `progress`, `cost` (the running sum of `x-credits-used` and what the cache saved), `note`, `error` (with `fatal`), `done` (summary, cost, credits left, elapsed). `POST /api/enrich` streams them as NDJSON lines.
