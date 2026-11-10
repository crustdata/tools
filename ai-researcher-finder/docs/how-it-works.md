# How AI Researcher Finder works

Every Crustdata request AI Researcher Finder sends, in order, with what comes back and what it costs. Prices are list prices (October 2026); `npm run setup` and every run print your account's own. All requests go to `https://api.crustdata.com` with the headers `authorization: Bearer <key>` and `x-api-version: 2025-11-01`. The client is [`src/crustdata.ts`](../src/crustdata.ts). Requests are spaced to stay under each endpoint's rate limit (30 a minute for search and identify, 15 for the GitHub lookup).

## 1. Free checks

**What the key can use and its prices.** `GET /account/endpoints` lists every endpoint with its status, the fields it may return, `base_credits`, and `premium_fields` / `premium_filters` prices. The tool reads the `/person/search` prices (base, experience, education, skills, research_profiles), whether research profiles are readable, and whether `/dev_platform/enrich` is enabled ([`src/cost.ts`](../src/cost.ts)). Without research profiles, paper title seeds and `--scholar-email` are skipped with a note.

**Person Identify access.** `/person/identify` is not listed in `/account/endpoints`, so the tool asks it about a made-up Google Scholar URL. A miss is free; a 403 means it is not enabled, and Scholar and profile URL seeds are skipped with a note.

```http
POST /person/identify
{ "research_profile_urls": ["https://scholar.google.com/citations?user=AAAAAAAAAAAA"] }
```

**Labs to company ids.** `POST /company/identify` is free. Domains and names go in separate requests:

```http
POST /company/identify
{ "domains": ["openai.com", "anthropic.com", "deepmind.google"] }
```

```json
[
  { "matched_on": "anthropic.com", "matches": [ { "confidence_score": 1.0,
      "company_data": { "crustdata_company_id": 635252,
        "basic_info": { "name": "Anthropic", "primary_domain": "anthropic.com" } } } ] }
]
```

A name needs a match with `confidence_score` 0.8 or more. A lab Crustdata does not know stops the run with the fix. Why company ids: people's roles carry `crustdata_company_id`, so the filter finds the company's own staff. Live on 2026-10-28, `deepmind.google` resolved to Google DeepMind, `x.ai` to "SpaceX Super Intelligence" (shown as xAI in the report), and `meta.com` to all of Meta (over 90,000 current staff), which is why Meta is not in the `frontier` list.

**Country spelling.** With `--country`, `POST /person/search/autocomplete` on `basic_profile.location.country` (free) checks the stored spelling.

## 2. The plan and the ceiling

Before anything is billed the run prints the query, the title filter, how many people are skipped, the paper titles it will search, and the most it can cost: every step at your prices, with research records counted for everyone (they are billed only for people who have one). `--dry-run` stops here. A ceiling above `MAX_CREDITS` (default 100) stops the run unless `--max-credits` allows it. Then `run.json` is written, before the first billed request, with the planned searches marked pending; each is cleared when it finishes. Running the same search again after a failure resumes: only the pending searches run. The ceiling also counts full records still to fetch for seeds looked up on an earlier run, and seeds for people already in the folder are matched locally, free.

## 3. The role search, one per lab

```http
POST /person/search
{
  "search": { "query": "ML researchers and engineers, working on speculative decoding",
    "mode": "hybrid" },
  "mode": "exact",
  "filters": { "op": "and", "conditions": [
    { "field": "experience.employment_details.current.company_id",
      "type": "in", "value": [635252] },
    { "op": "or", "conditions": [
      { "field": "experience.employment_details.current.title",
        "type": "[.]", "value": "research scientist" },
      { "field": "experience.employment_details.current.title",
        "type": "[.]", "value": "research engineer" },
      { "field": "experience.employment_details.current.title",
        "type": "[.]", "value": "researcher" },
      { "field": "experience.employment_details.current.title",
        "type": "[.]", "value": "member of technical staff" },
      { "field": "experience.employment_details.current.title",
        "type": "[.]", "value": "machine learning" }
    ] }
  ] },
  "fields": ["fit", "basic_profile", "experience", "education", "skills", "social_handles",
    "research_profiles"],
  "post_processing": { "exclude_profiles": ["<profile URLs already in the folder>"] },
  "limit": 4
}
```

- `search.query` ranks people by meaning (title, skills, company history, education, summary); `mode: "exact"` keeps every filter hard, so `total_count` is the number of people who match the filters. Without it, the default `managed` mode lets the query add people and the count is much larger. Semantic search is in beta at Crustdata.
- `[.]` is an exact phrase, case-insensitive, whole words: "researcher" matches "Senior Researcher", not "Research". The full list is `RESEARCH_TITLES` in [`src/find.ts`](../src/find.ts); a bare "research" is left out because it also matches "Research Program Manager". `map` adds "engineer", "tech lead" and "technical lead" (`MAP_TITLES`). `--any-title` drops the group. With `--past-labs` and no `--labs`, the group is off too: people who left often found companies or teach.
- After the search, people whose title is a UX, recruiting, program management, sales or similar role, with no research role named first (`notResearch`), are dropped and counted; they were billed, and their profile URLs go in `dropped.json` so later runs skip them.
- `--past-labs` adds `experience.employment_details.past.company_id in [...]`; with `--labs` too, both must hold.
- `--limit` is shared across the labs (25 over 8 labs: 4 for the first, 3 for the rest); `--per-lab` sets each. A lab with fewer matches returns fewer.
- People already in the folder, and people removed at their request (`out/suppressed.json`), go in `post_processing.exclude_profiles`: they are not returned and not billed. The list is read again before each lab's search, so a person at two searched labs is billed once. `--fresh` sends the removed and dropped people, plus everyone found earlier in the same run.
- Pages of up to 1,000 follow `next_cursor`. A person repeated across pages is kept once. People are saved to `people.json` as each page is billed.

Response, trimmed to what the tool reads:

```json
{
  "profiles": [ {
    "crustdata_person_id": 70001,
    "fit": "strong",
    "basic_profile": { "name": "Jane Doe", "headline": "...",
      "current_title": "Member of Technical Staff",
      "location": { "full_location": "San Francisco, California, United States" } },
    "experience": { "employment_details": {
      "current": [ { "title": "Member of Technical Staff", "name": "Example Labs",
        "crustdata_company_id": 9001, "start_date": "2024-03-01",
        "description": "Inference: speculative decoding and KV cache efficiency" } ],
      "past": [ { "title": "Research Engineer", "name": "Example Cloud",
        "start_date": "2021-06-01", "end_date": "2024-02-01" } ] } },
    "skills": { "professional_network_skills": ["PyTorch", "CUDA"] },
    "social_handles": { "professional_network_identifier": { "profile_url": "https://..." } },
    "research_profiles": [ {
      "id": "EXJANE00AAAJ",
      "profile_url": "https://scholar.google.com/citations?user=EXJANE00AAAJ",
      "research_interests": ["Machine Learning", "Efficient Inference"],
      "articles": [ { "title": "Speculative decoding for example models",
        "publication_year": "2025", "url": "..." } ],
      "co_authors": [ { "id": "EXSAM000AAAJ", "name": "Sam Example" } ],
      "citations_count": { "all": 2310, "recent": 1386, "recent_since_year": 2021 },
      "h_index": { "all": 8, "recent": 4 },
      "metadata": { "last_scraped_source": "2026-08-09T20:25:34+00:00" }
    } ]
  } ],
  "next_cursor": null,
  "total_count": 1843
}
```

`fit` is given to the top of the ranked list (up to 200 people) and is null below it. `research_profiles` is an array, best match first; the tool reads the first. Search returns a smaller copy of each research profile than Person Enrich: articles carry only title, url and year; co-authors only id and name. A research profile the key may not read fails the whole request with `Access denied to fields: research_profiles`; the tool drops the group, says so once, and asks again.

Cost per person at list price: 0.03 base, 0.3 for experience, education and skills returned, 0.1 for the experience filter, 0.4 for a research profile when the person has one: at most 0.83.

**`--scholar-email N`** adds, per lab, a search for up to N people whose Google Scholar profile has an email at the lab's domain (and `deepmind.com` for Google DeepMind), whatever their work history says. Scholar keeps old emails, so this finds both people whose professional profile is out of date and people who have left. At most 1.13 per person (the research filter instead of the experience filter).

```http
POST /person/search
{ "filters": { "op": "and", "conditions": [
    { "field": "research_profiles.verified_email_domain", "type": "in",
      "value": ["anthropic.com"] } ] },
  "post_processing": { "exclude_profiles": ["<profile URLs already in the folder>"] },
  "fields": ["fit", "basic_profile", "experience", "education", "skills", "social_handles",
    "research_profiles"],
  "limit": 10 }
```

## 4. Seeds: starting from the work

[`src/seeds.ts`](../src/seeds.ts) sorts each cell of a `--from` file (and each `--scholar`, `--github`, `--paper`, `--profile`) into a kind. Lookups are saved in `seeds.json`; a later run reuses them for free.

**Google Scholar profile URLs and profile URLs**, 25 per request, 30 requests a minute, 1 credit per match, free when not found:

```http
POST /person/identify
{ "research_profile_urls": ["https://scholar.google.com/citations?user=EXKOFI00AAAJ"] }
```

```json
[ { "matched_on": "https://scholar.google.com/citations?user=EXKOFI00AAAJ",
    "match_type": "research_profile_url", "match_status": "matched",
    "matches": [ { "confidence_score": 1.0, "person_data": { "crustdata_person_id": 70012,
      "basic_profile": { "name": "Kofi Example" }, "social_handles": { "...": "..." } } } ] } ]
```

Each answer is matched to its URL by `matched_on`, batch by batch, so a short answer can never move a row onto the wrong person; a URL with no answer is not saved and is asked again next run. `match_status` is `matched`, `not_found` or `redacted` (the person asked Crustdata to remove their data; nothing is stored). Only Google Scholar URLs with a `user` parameter are accepted; the tool keeps just that id. Profile URLs go the same way under `professional_network_profile_urls`.

**GitHub profile URLs**, one per request, 15 requests a minute, 1 credit a call (enterprise plans):

```http
POST /dev_platform/enrich
{ "profile_url": "https://github.com/example-ravi" }
```

```json
{ "crustdata_person_id": 70013,
  "dev_platform_profiles": [ { "profile_url": "https://github.com/example-ravi",
    "name": "...", "account_type": "User",
    "confidence_score": 0.99, "all_topics": ["..."] } ] }
```

When Crustdata has not linked the account to a person, `crustdata_person_id` is null (and the call still costs 1 credit); the run reports the name GitHub shows. Repository links are refused before any call.

**Paper titles**, one search per title, up to `--per-paper` people (default 20):

```http
POST /person/search
{
  "filters": { "op": "and", "conditions": [
    { "field": "research_profiles.articles.title", "type": "[.]",
      "value": "Speculative decoding for example models" }
  ] },
  "fields": ["fit", "basic_profile", "experience", "education", "skills", "social_handles",
    "research_profiles"],
  "limit": 20
}
```

Authors already in the folder are matched locally for free and sent in `post_processing.exclude_profiles`, so they are not billed again. The phrase match also returns people with a different paper that contains the same words. The tool keeps a person only when one of their article titles is the title asked for, or that title followed only by a year, a one-letter tag or a venue (", 2023", "(2017)", "[J]", "arXiv preprint"), and says how many it left out (they were billed). Cost at list price: up to 1.13 per person (0.3 more than a lab search: 0.4 for the research filter, and no experience filter).

**Full records.** People found by Identify or GitHub get their full record in one more search, by id (0.73 at most per person at list price):

```http
POST /person/search
{ "filters": { "op": "and", "conditions": [
    { "field": "crustdata_person_id", "type": "in", "value": [70012, 70013] } ] },
  "fields": ["fit", "basic_profile", "experience", "education", "skills", "social_handles",
    "research_profiles"] }
```

## 5. Teams, scores, files

No more Crustdata requests. [`src/teams.ts`](../src/teams.ts) guesses each team (stated, inferred, not stated), [`src/rubric.ts`](../src/rubric.ts) scores everyone with `rubric.json` (a rule with no data counts at `no_data_share` of its points, a quarter by default, and `coverage` says how much was checked), and [`src/output.ts`](../src/output.ts) writes `report.md` and `researchers.csv`. Everyone ever found for the folder is scored and mapped on every run, not only the new people. `npm run rescore` does this step alone. If a run fails part way, this step still runs on what was saved and the report notes where it stopped.

With `--ai`, one Anthropic Messages API request per person, four at a time: the model in `ANTHROPIC_MODEL`, structured JSON output (one answer per `ask` line: yes, partly, no or unclear, with the fact it rests on), low effort, and Anthropic's server-side fallback if the model declines. Answers are kept in `ai.json`, keyed on the person, the facts sent and the questions. A rejected key stops all requests at once; more than 500 people needs `--max-ai`. What is sent is in [`src/ai.ts`](../src/ai.ts) (`factsFor`): titles, employers, role descriptions, headline, paper titles, research interests, h-index, citations, skills. Never the name, profile URL, Scholar URL or location.

## Errors

Every failure ends with a plain next step: 401 (copy the key again, run `npm run setup`), 402 (top up), 403 (ask Crustdata to enable the endpoint), 429 (retried twice after `x-ratelimit-reset` seconds, then "wait a minute"), 5xx (everything found before it is saved and in the report; run again). A billed request (search, identify, GitHub lookup) is retried only after a 429 or a connection that never opened; a timeout or any 5xx may have been billed, so it is not retried and nothing is billed twice.
