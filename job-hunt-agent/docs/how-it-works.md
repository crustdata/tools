# How the Job Hunt Agent works: every Crustdata API request, in order

Every Crustdata API request Job Hunt Agent sends, in order, with what comes back and what it costs at list
price (docs.crustdata.com/general/pricing; some plans include the premium groups, and each run prints its own
cost next to the list-price equivalent). Shapes are as
the live API returned them on 2026-10-28; names and ids below are made up. The code is in
[src/hunt.ts](../src/hunt.ts) (order) and [src/crustdata.ts](../src/crustdata.ts) (requests).

```text
CV (md, txt, pdf) --read on your machine--> skills, schools, years
   |
0. GET  /account/endpoints            your prices, for the estimate           free
1. POST /person/search/autocomplete   school spellings                        free
2. POST /job/search  (limit 0)        how many jobs match                     free
3. POST /job/search                   newest 50 jobs, descriptions, funding   0.03 a job
   |  fold duplicates, leave out agencies, score every job (src/score.ts)
4. job board APIs                     still open? best first, until 5         free
5. POST /company/search               headcount growth for those 5            0.23 a company
6. POST /person/search  x 4 a job     recruiter, manager, team                0.23 a person
                                      alumni                                  0.43 a person
7. POST /person/contact/enrich        work emails, only with --emails         1 a person matched
   |  draft one note per person (src/notes.ts)
   v
out/<run>/report.md  jobs.json  jobs.csv  jobs/<n>.md      dashboard: npm run dashboard
```

Every paid answer for a company (step 5) and every people search (step 6) is saved in `data/job-hunt.db` for
14 days (`CACHE_DAYS`): a second run, or a run cut off halfway, does not pay for them again (the job list in
step 3 is read again each run). A second job at the same company reuses its recruiters; the manager, team and
alumni searches include the job title, so a different title pays for those again. Requests to one endpoint are spaced 2.1
seconds apart (30 requests a minute per endpoint per key). The run's worst case, at the prices from step 0,
must be under `MAX_CREDITS_PER_RUN` (30) or the run asks for `--yes`; once real charges pass the worst case
by a quarter, the next paid call is not sent and the run stops. 429 waits for the window and retries; a 502 or 503 that reports 0 credits is retried; any other server
error on a paid search is not retried, because it may have been billed.

## 0. Read the CV (on your machine)

[src/cv.ts](../src/cv.ts) turns the file into text (PDF through `unpdf`, no native code) and takes out:

- **skills**: the 144 skills of [src/skills.ts](../src/skills.ts), whole words, with their other spellings;
  a skill marked "(learning)" or "(basic)" does not count;
- **schools**: lines in the education section that name a school or a bootcamp, cut before the degree, the
  year and the city;
- **years**: an explicit "8 years of experience" (unless it is about another field), or the date ranges in the
  work sections merged (overlapping jobs count once). When some jobs read as tech, product, design or data
  work, only those count; internships never count.

## 1. School spellings: Person Autocomplete (free)

```http
POST https://api.crustdata.com/person/search/autocomplete
authorization: Bearer $CRUSTDATA_API_KEY
x-api-version: 2025-11-01
content-type: application/json

{ "field": "education.schools.school", "query": "University of California, Berkeley", "limit": 10 }
```

```json
{ "suggestions": [ { "value": "University of California, Berkeley" },
                   { "value": "University of California, Los Angeles" },
                   { "value": "University of California, Berkeley, Haas School of Business" }
                 ] }
```

Suggestions that start with the school's name (or a known short form such as "UC Berkeley") are kept, so
"University of Washington" never brings in "Washington State University". A spelling that contains another
one is dropped, because the phrase filter in step 6 matches it anyway. Result:
`["University of California, Berkeley", "UC Berkeley"]`.

## 2. Count: Job Search with limit 0 (free)

```json
{
  "filters": { "op": "and", "conditions": [
    { "field": "job_details.title", "type": "(.)", "value": "software engineer" },
    { "field": "location", "type": "geo_distance",
      "value": { "location": "San Francisco", "distance": 50, "unit": "mi" } },
    { "field": "metadata.date_added", "type": "=>", "value": "2026-09-28" } ] },
  "limit": 0,
  "aggregations": [ { "type": "count" } ]
}
```

```json
{ "job_listings": [], "total_count": 3366, "aggregations": [ { "type": "count", "value": 3366 } ] }
```

`(.)` matches every word in any order ("Software Engineer, Payments", "Engineer, Software"). Several titles go
in an `or` group. `--remote` swaps the place for `workplace_type = "Remote"` and `location.country` (the US
as `in ["United States", "United States of America", "USA"]`); `--also-remote` puts both in an `or`.
`--dry-run` stops here.

## 3. Read the jobs: Job Search (0.03 a job)

The same filters, `sorts: [{ "field": "metadata.date_added", "order": "desc" }]`, `limit` up to 100 a page
(`--scan`, default 50), and only the fields the score needs (Job Search has no premium groups):

```json
{ "job_listings": [ {
    "crustdata_job_id": 7100001,
    "job_details": {
      "title": "Senior Software Engineer, Platform", "category": "Engineering",
      "url": "https://boards.greenhouse.io/northwind/jobs/7000001", "source": "greenhouse",
      "workplace_type": "On-site", "employment_type": "full_time" },
    "location": { "raw": "San Francisco, California, United States", "city": "San Francisco",
                  "state": "California", "country": "United States" },
    "metadata": { "date_added": "2026-10-27T09:00:00" },
    "content": { "description": "Requirements\n- Go, Kubernetes, PostgreSQL and Kafka ..." },
    "company": {
      "basic_info": { "crustdata_company_id": 900101, "name": "Northwind Robotics",
                      "primary_domain": "northwind.example",
                      "industries": ["Software Development"] },
      "headcount": { "total": 240 },
      "funding": { "last_fundraise_date": "2026-08-12T00:00:00", "last_round_type": "series_b",
                   "total_investment_usd": 61000000 } } } ],
  "next_cursor": "..." }
```

Then, with no calls ([src/jobs.ts](../src/jobs.ts), [src/score.ts](../src/score.ts)):

- the same role at the same company on several sites becomes one row (by Crustdata company id and the title
  without places; a listing with no company record joins the same role at a company with the same name; the
  kept listing has a company record and is the easiest to check; `aliases` keeps every id, so your status
  follows the role);
- staffing agencies are left out (industry "Staffing and Recruiting", or a name like "... Recruitment");
- every job is scored. Company growth is not known yet, so this first score counts recent funding only.

One posting by URL (`npm run job`) is the same request with
`{ "field": "job_details.url", "type": "=", "value": "<URL>" }` and `limit: 1`; the URL is tried as pasted,
then cleaned (tracking parameters dropped, a `currentJobId=` search link turned into the posting's address).
Not found costs nothing.

## 4. Still open? The job boards (free)

Best score first, four at a time, until 5 (`--top`) are open or cannot be checked:

| Posting on | Asked | Closed when |
|---|---|---|
| Greenhouse | `GET https://boards-api.greenhouse.io/v1/boards/<org>/jobs/<id>` | 404 |
| Lever | `GET https://api.lever.co/v0/postings/<org>/<id>` | 404 |
| Ashby | `GET https://api.ashbyhq.com/posting-api/job-board/<org>` (once per company) | the id is not in the list |
| SmartRecruiters | `GET https://api.smartrecruiters.com/v1/companies/<org>/postings/<id>` | 404 |

Anything else is "not checked". Jobs with no company record (some job board listings) come after all the
others, because no people can be found for them.

## 5. Headcount growth: Company Search (0.23 a company)

Only the `headcount` group (0.2 on top of the 0.03 base): the last round, its date and the total raised
already came with the job rows.

```json
{ "filters": { "field": "crustdata_company_id", "type": "in", "value": [900101, 900102] },
  "fields": ["crustdata_company_id", "basic_info.name", "basic_info.primary_domain",
             "headcount"],
  "limit": 2 }
```

```json
{ "companies": [ {
    "crustdata_company_id": 900101,
    "headcount": { "total": 240,
                   "growth_percent": { "1m": 3.0, "3m": 9.0, "6m": 24.0, "12m": 51.0 } } } ] }
```

Growing at +5% or more over 6 months, shrinking at -5% or less. The jobs are scored again with this, and jobs
under 50 get no people search unless `--all`.

## 6. People: People Search (0.23 a person, 0.43 for alumni)

Up to four searches per job at its company (seven when some are asked again outside the country), each ranked
by a short query, with the filters kept exact:

| Who | Query | Extra filter | Asked for | Kept when |
|---|---|---|---|---|
| Recruiter | "technical recruiter hiring software engineers" (engineering), "recruiter hiring for <role>" | job's country | 2 | title says recruit, talent or sourcing |
| Hiring manager | "engineering manager" plus the job title, "director of product or group product manager" plus the title, ... | job's country | 2 | title says manager, head, director or lead, in the job's line of work, not recruiting |
| Team | the job title without level words ("Backend Engineer") | job's country | 3 | in the job's line of work; not a recruiter, intern, advisor or contractor |
| Alumni | the job title | school spellings | 3 | a school on the profile matches as whole words |

Every person costs the 0.03 base plus 0.1 for filtering on `experience` (the company) and 0.1 for returning
it (their title at this company); alumni add 0.1 + 0.1 for `education`, and only the alumni search asks for it.

```json
{
  "search": { "query": "technical recruiter hiring software engineers", "mode": "hybrid" },
  "mode": "exact",
  "filters": { "op": "and", "conditions": [
    { "field": "experience.employment_details.current.company_id", "type": "=",
      "value": 900101 },
    { "field": "basic_profile.location.country", "type": "in",
      "value": ["United States", "United States of America"] } ] },
  "fields": ["crustdata_person_id", "fit", "basic_profile.name",
             "basic_profile.location.full_location",
             "experience.employment_details.current.title",
             "experience.employment_details.current.crustdata_company_id",
             "experience.employment_details.current.start_date",
             "social_handles.professional_network_identifier.profile_url"],
  "limit": 2
}
```

```json
{ "profiles": [ {
    "crustdata_person_id": 500001, "fit": "strong",
    "basic_profile": { "name": "Avery Example",
      "location": { "full_location": "San Francisco, California, United States" } },
    "experience": { "employment_details": { "current": [
      { "title": "Senior Technical Recruiter", "crustdata_company_id": 900101,
        "start_date": "2024-02-01T00:00:00" } ] } },
    "social_handles": { "professional_network_identifier": {
      "profile_url": "https://www.linkedin.com/in/example-avery-example" } } } ],
  "total_count": 12 }
```

Without the top-level `"mode": "exact"`, the ranked query also brings in people from other companies. People
can hold several current roles; the one at this company is used, and a person whose only role there is
advisor, investor or contractor is skipped. When the country search keeps nobody (a startup whose team is
abroad), it is asked again without the country. Nearest to the job's city first; nobody appears twice.
Answers that are not lists of objects are skipped before they are cached. One person per job is marked to write
to first, one per company in a run (an alum in the job's line of work, else the recruiter, the manager, any alum,
the team); someone already listed under a better job at the same company is marked to write to once, about both.

## 7. Work emails: Contact Enrich (only with --emails)

```json
{ "professional_network_profile_urls": ["https://www.linkedin.com/in/example-avery-example"],
  "fields": ["contact.business_emails"] }
```

Only for the recruiters and the hiring manager. 1 credit per person matched. An address is kept only when its
`crustdata_company_id` or its domain is the hiring company's (lists can include former employers, which are
still billed). A key without contact data gets a 403, and the run says so and carries on.

## 8. Notes and files (free)

[src/notes.ts](../src/notes.ts) fills one template per kind of person (most under 200 characters, never over
300). A note names skills the posting asks for that your CV has, claims years only when you set
`yearsExperience` yourself, and an alumni note names your own school. With Claude Code,
the job-hunt skill writes `out/<run>/ai/<job id>.md` with a verdict and personal notes, and the dashboard shows
it. Nothing is ever sent.
