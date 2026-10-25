# How Person Researcher works

Every Crustdata request the agent makes, in order, with what comes back and what it costs. Shapes are as the live
API returned them on 2026-10-23. All requests go to `https://api.crustdata.com` with these headers:

```http
authorization: Bearer <CRUSTDATA_API_KEY>
content-type: application/json
x-api-version: 2025-11-01
```

The `x-credits-used` response header is the charge for that call; the agent sums it and prints the total.

## 1. Resolve each input to a profile

### A name, optionally at a company: `POST /person/search`

Only for `--name` (or a "Name, Company" line). The company is matched on the employer's website domain when it
looks like a domain, otherwise as a phrase in the employer name.

```json
{
  "filters": { "op": "and", "conditions": [
    { "field": "basic_profile.name", "type": "[.]", "value": "Jane Doe" },
    { "field": "experience.employment_details.current.company_website_domain",
      "type": "=", "value": "acme.com" }
  ] },
  "fields": ["crustdata_person_id", "basic_profile.name", "basic_profile.headline",
             "basic_profile.current_title", "basic_profile.location",
             "social_handles.professional_network_identifier.profile_url"],
  "limit": 5
}
```

Answer: `{ "profiles": [...], "total_count": 8, "next_cursor": "..." }`. One profile: the agent continues with its
profile URL. Several: it prints a numbered list and stops (`--pick n` chooses). None, with a company given: it asks
again with the company as any employer, current or past (`experience.employment_details.company_website_domain`,
or `experience.employment_details.company_name` for a name), and labels the brief "found by name and a past
company". Still none: "No one named ... found". Legal suffixes ("Acme, Inc.") are taken off a company name first.
Cost: 0.03 per profile returned, plus 0.1 per profile for the employer filter at list price (0 on plans that
include it). `[.]` is a case-insensitive phrase match: the words must appear together and in order.

### A work email: `POST /person/enrich` with `business_emails`

The lookup and the profile in one call, 1 credit per match, free when nobody matches. Up to 25 emails a call.

```json
{ "business_emails": ["jane@acme.com"], "fields": ["crustdata_person_id", "updated_at",
  "basic_profile", "professional_network", "social_handles", "experience", "education",
  "skills", "certifications", "honors"] }
```

The answer has the same shape as an enrich by profile URL (below), with `match_type: "business_email"`.
This worked on the live API on 2026-10-23 but is not in the Person Enrich docs yet. If Crustdata answers `400`,
the agent sends the emails to Person Identify instead.

### Any other email: `POST /person/identify`

Only for emails the step above did not find. Identify also matches personal emails, and names in the address at
the company that owns the domain.

```json
{ "emails": ["jane.doe.home@mail.example"] }
```

Answer: one row per email, in order: `match_status` `matched` / `not_found` / `redacted`, and for a match
`matches[0].person_data` with `crustdata_person_id`, `basic_profile` and
`social_handles.professional_network_identifier.profile_url`. The agent then enriches that profile URL. Cost: 1
credit per match; misses and redacted rows are free. `confidence_score` is `1.0` for an address on file and 0.5 to
1.0 for a match by the name in the address at the domain; below 1, the brief opens with "Check this is the right
person" and the score, and the index flags it.

One address Crustdata will not accept fails the whole call with `400` and
`{"error":{"type":"invalid_request","message":"Invalid emails: typo@nowhere.invalid"}}`. The agent takes those
addresses out, sends the rest again, and reports them as "Crustdata does not accept this address".
Identify is enabled per account; with `403` the agent reports personal emails as not found.

### A profile URL: `POST /person/enrich`

```json
{ "professional_network_profile_urls": ["<profile URL>"], "fields": ["crustdata_person_id",
  "updated_at", "basic_profile", "professional_network", "social_handles", "experience",
  "education", "skills", "certifications", "honors"] }
```

Answer (trimmed):

```json
[{
  "matched_on": "<profile URL>",
  "match_type": "professional_network_profile_url",
  "match_status": "matched",
  "matches": [{ "confidence_score": 1.0, "person_data": {
    "crustdata_person_id": 1068035,
    "updated_at": "2026-10-23T00:03:28Z",
    "basic_profile": { "name": "...", "headline": "...", "current_title": "Co-Founder & CEO",
      "location": { "raw": "San Francisco, California, United States" },
      "normalized_title": { "department": "Executive Leadership", "confident": true } },
    "professional_network": { "followers": 24299, "connections": 5874 },
    "experience": { "years_of_experience": "More than 10 years",
      "employment_details": {
        "current": [{ "title": "Co-Founder & CEO", "name": "Crustdata (YC F24)",
          "start_date": "2024-01-01T00:00:00+00:00", "end_date": null, "is_default": true,
          "seniority_level": "CXO", "crustdata_company_id": 6036032,
          "company_website_domain": "crustdata.com", "company_headcount_latest": 47,
          "company_headcount_range": "11-50", "company_description": "..." }],
        "past": [{ "title": "Product", "name": "Serve Robotics",
          "start_date": "2022-01-01T00:00:00+00:00",
          "end_date": "2024-02-01T00:00:00+00:00", "employment_type": "Full-time" }]
      } },
    "education": { "schools": [{ "school": "IIIT Hyderabad", "degree": "B.Tech.",
      "field_of_study": "Computer Science", "start_year": null, "end_year": null }] },
    "skills": { "professional_network_skills": ["Machine Learning", "Python"] }
  } }]
}]
```

Cost: 1 credit per match (every section above is in the base profile); `not_found` is free. A profile is about 26
KB. Role dates are at month precision. Not-found profile URLs come back as
`{ "match_status": "not_found", "matches": [] }` with `200`.

If the key may not read a field group, the call fails with `403` and `Access denied to fields: x`; the agent drops
that group and sends the call again.

## 2. Contacts (only with `--contact`): `POST /person/contact/enrich`

```json
{ "professional_network_profile_urls": ["<profile URL>"],
  "fields": ["contact.business_emails"] }
```

Answer: the same row shape, with `person_data.contact.business_emails: [{ "email": "...", "status":
"deliverable" }]` (also `personal_emails`, `phone_numbers`). Statuses are `deliverable`, `catch_all`, `invalid`
or `unknown`; the brief shows every one except `deliverable`. Cost per person found: 1 for work emails, 2 for
personal emails, 2 for phones; no base credit, so asking for contacts never pays for the profile twice. Each kind
is cached per person, so adding `personal` later does not buy the work emails again. Enabled per account
(enterprise plans); other keys get `403`, and the briefs go without contacts.

## 3. Posts: `POST /social_post/search`

```json
{
  "filters": { "op": "and", "conditions": [
    { "field": "actor.crustdata_entity_id", "type": "=", "value": 1068035 },
    { "field": "actor.actor_type", "type": "=", "value": "person" },
    { "field": "post_type", "type": "=", "value": "original" }
  ] },
  "sorts": [{ "field": "date_posted", "order": "desc" }],
  "fields": ["share_url", "text", "post_type", "date_posted", "engagement"],
  "limit": 5
}
```

Answer: `{ "posts": [{ "share_url": "...", "text": "...", "post_type": "original",
"date_posted": "2026-08-04T20:26:35Z", "engagement": { "total_reactions": 17, "total_comments": 4,
"num_shares": 0, "reactions_by_type": { "LIKE": 16, "INTEREST": 1 } } }], "total_count": 87 }`.

Cost: 0.5 per post returned. With `limit: 0` (`--posts 0`) only `total_count` comes back, free.

`post_type = original` matters: without it, other people's reposts of this person's posts come back too (those rows
carry this person as `actor` and the reposter as `reposter`), each billed as a post. The index trails the live
feed: on 2026-10-23 the newest indexed post for the example was 11 weeks old, so the brief prints each post's date
and a note when the newest is over 30 days old. Person Enrich can also return `social_posts` (the 10 newest, a flat
5 credits); it reads the same index, so the agent uses the search, which lets you pick the count.

## 4. Web and news: `POST /web/search/live`

Two calls per person, with the quoted name and the current employer (tags such as "(YC F24)" removed):

```json
{ "query": "\"Abhilash Chowdhary\" Crustdata", "sources": ["web"] }
{ "query": "\"Abhilash Chowdhary\" Crustdata", "sources": ["news"], "start_date": 1784991600 }
```

`start_date` is a unix time in seconds (`NEWS_DAYS`, 90, days ago). Answer: `{ "success": true, "results": [{ "source": "web",
"title": "...", "url": "...", "snippet": "...", "position": 1 }], "metadata": { "total_results": 9 } }`. Results
carry no date. Cost: the docs say 1 credit per query. On 2026-10-23 one query with both sources cost 2, and a query
that found nothing cost 0, so the agent sends one call per source; budget 1 each.

The agent drops results on the person's own profile site, results from the sites in
`config/ignored-sites.json` (contact-lookup and people-directory pages), results whose title, snippet and address
do not contain the person's last name (likely someone else), and repeats, and keeps 5. A person with no current
role is searched with their latest past employer.

## 5. The brief

`buildBrief()` in `src/brief.ts` turns the answers into a brief: who they are (with their own About text), what
changed (rules in `changes()`), posts, news and web links, the company from the main current role, the career
grouped by company, education, skills. `renderBrief()` in
`src/render.ts` writes markdown, escaping every external string so a name cannot add a link or a heading.

## Pacing, retries and the cache

- Each batch of 25 (enrich, identify, contacts) is saved before the next is sent, so a failure later in a big list
  never loses or re-bills the people already done. Contacts that were not checked (not enabled, or a failed
  batch) are noted in the brief, never shown as "none found".
- Emails are lowercased and profile URLs normalised before any lookup, so inputs from code match the cache.
- Calls to each endpoint are spaced under its published limit: Person Enrich and Contact Enrich 15 a minute,
  People Search, Person Identify and Social Post Search 30, Web Search 10.
- `429` and connections that never opened are retried twice, waiting for `retry-after` or `x-ratelimit-reset`.
  `502` and `503` are retried only when the answer carries `x-credits-used: 0` (a proxy error with no header is
  not retried). Other errors on these billed calls are not retried,
  because they may have been billed. A `200` that is not JSON is an error, never "not found".
- `401` (bad key) and `402` (no credits) stop the run; briefs finished before it are already written. Anything
  else costs one person, or one section of one brief, noted in it.
- Every answer is saved in `out/.cache/` (owner-only files, written atomically) for `CACHE_HOURS` (24), keyed by
  the request: enrich hits and misses, identify matches and misses, name searches, posts, web, news and contacts
  (per kind). A person found by work email is also saved under their profile URL. Entries older than
  `CACHE_HOURS` are deleted at the start of each run. Within a run every answer is also kept in memory, so the
  same person reached twice is paid for once even with `--refresh`.
- Field groups the key could not read (`403 Access denied to fields`) are remembered in the cache for `CACHE_HOURS`
  and left out of the next run's requests; `--refresh` asks for them again.
- A `403` that says the account is out of credits stops the run like a `402`.

## Free calls used by setup

- `GET /account/credits`: `{ "account": { "credits": 1234.5 } }`
- `GET /account/endpoints`: per endpoint `status`, `base_credits`, `premium_fields`. Setup reads which of
  `/person/enrich`, `/person/search`, `/social_post/search`, `/web/search/live` and `/person/contact/enrich` are
  enabled.
- `POST /person/identify` with an address that matches nobody: free, and `403` means identify is not enabled
  (it is not listed in `/account/endpoints`).
