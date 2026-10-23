# How Competitor Tracker works

Every Crustdata request the agent makes, in order, with what comes back and what it costs at list price. Response
bodies are trimmed to the fields the code reads. All requests send `authorization: Bearer $CRUSTDATA_API_KEY` and
`x-api-version: 2025-11-01`; the `x-credits-used` response header reports the cost of each call.

## `npm run init`: the starting point and the watchers

### 1. Resolve each competitor (free)

```http
POST https://api.crustdata.com/company/identify
{ "domains": ["attio.com", "folk.app", "twenty.com"] }
```

```json
[
  { "matched_on": "attio.com",
    "matches": [{ "confidence_score": 1.0, "company_data": {
      "crustdata_company_id": 664000,
      "basic_info": { "name": "Attio", "primary_domain": "attio.com",
                      "employee_count_range": "51-200",
                      "description": "Attio is the agentic CRM that ..." } } }] }
]
```

The id goes into `competitors.json`. The description gives the "what they make" word used to match news (`deriveAbout`
in `src/competitors.ts`). A domain with no match keeps the website and news sections only.

### 2. Fetch the homepage, then the pages it links to (1 credit per page)

```http
POST https://api.crustdata.com/web/enrich/live
{ "urls": ["https://attio.com/"] }
```

```json
[{ "success": true, "url": "https://attio.com/", "title": "Attio: The CRM for agentic revenue",
   "content": "<html lang=\"en\">... full HTML ...</html>", "http_status": 200 }]
```

`parsePage` (`src/website.ts`) keeps the visible text (one block per line, without navigation, scripts, styles and hidden
elements; header and footer text is kept), every link, and the alt text of images in logo sections. `discoverPages` picks pricing, changelog,
customers, blog, integrations and docs pages from the homepage links, in that order, skipping translations and legal
pages, up to `PAGES_PER_COMPETITOR` including the homepage (so at the default 6 the docs page is left out). They are
fetched in one more request (up to 10 URLs per request, 10 requests a minute). For attio.com it picked `/pricing`,
`/changelog`, `/customers`, `/blog` and `/apps`.

### 3. One company record per competitor (2 credits each)

```http
POST https://api.crustdata.com/company/enrich
{ "crustdata_company_ids": [664000],
  "fields": ["basic_info", "headcount", "funding", "news", "hiring"] }
```

```json
[{ "matches": [{ "company_data": {
  "crustdata_company_id": 664000,
  "headcount": {
    "total": 206,
    "growth_percent": { "mom": 3.0, "qoq": 8.42, "six_months": 19.08, "yoy": 54.89 },
    "by_function_timeseries": { "CURRENT_FUNCTION": {
      "Engineering": [
        { "date": "2026-07-01 00:00:00", "employee_count": 60 },
        { "date": "2026-08-01 00:00:00", "employee_count": 61 } ] } } },
  "funding": { "last_round_type": "series_b", "last_round_amount_usd": 52020932,
               "last_fundraise_date": "2025-08-26",
               "acquisitions": [
                 { "acquiree_company_name": "Inconvo", "announced_on_date": "2026-07-08" } ] },
  "news": [{ "article_title": "...", "article_url": "https://...",
             "article_publish_date": "2026-09-22",
             "article_publisher_name": "..." }] } }] }]
```

Stored as the baseline for headcount and funding.

### 4. Three watchers, pull-only (free to create; first runs are free baselines)

The job and post watchers run daily and the company watcher weekly, all preferring 06:00 UTC, so a digest on Monday at
08:00 UTC reads fresh runs. Job and post watchers bill per item caught, not per run, so daily runs cost the same; the
company watcher bills per company that changed in a run, so a weekly run folds several changes into one charge. The
weekly caps (`MAX_JOBS_PER_WEEK`, `MAX_POSTS_PER_WEEK`) are spread over the seven daily runs; items over a run's cap
arrive on a later run.

Company changes, over every competitor:

```http
POST https://api.crustdata.com/watch/company
{
  "entities": { "crustdata_company_ids": [664000, 674650, 1001865] },
  "track": { "op": "or", "conditions": [
    { "field": "headcount.total", "type": "changed" },
    { "field": "news", "type": "added" },
    { "field": "funding.last_round_type", "type": "changed" },
    { "field": "funding.acquisitions", "type": "added" },
    { "field": "funding.investors", "type": "added" } ] },
  "fields": ["basic_info", "headcount", "funding", "news", "hiring"],
  "config": {
    "trigger": { "type": "interval", "every_hours": 168 },
    "preferred_hour": 6,
    "max_results_per_run": 3 },
  "notifications": []
}
```

New jobs at any competitor, posted in the last 30 days (a rolling window: listings that reach the index months after
they were posted are left out):

```http
POST https://api.crustdata.com/watch/job/search
{
  "filters": { "op": "and", "conditions": [
    { "field": "company.basic_info.primary_domain", "type": "in",
      "value": ["attio.com", "folk.app", "twenty.com"] },
    { "field": "metadata.date_added", "type": "=>", "value": "now-30d" } ] },
  "config": {
    "trigger": { "type": "interval", "every_hours": 24 },
    "preferred_hour": 6,
    "max_results_per_run": 72 },
  "notifications": []
}
```

Announcement posts from the last 3 months by each company page (by Crustdata id) or anyone who works there (by
employer name), containing one of the words in `config/post-keywords.json`:

```http
POST https://api.crustdata.com/watch/social_post/search
{
  "filters": { "op": "and", "conditions": [
    { "field": "date_posted", "type": "=>", "value": "now-3M" },
    { "op": "or", "conditions": [
      { "op": "or", "conditions": [
        { "op": "and", "conditions": [
          { "field": "actor.actor_type", "type": "=", "value": "company" },
          { "field": "actor.crustdata_entity_id", "type": "=", "value": 664000 } ] },
        { "op": "and", "conditions": [
          { "field": "actor.actor_type", "type": "=", "value": "person" },
          { "field": "actor.company_name", "type": "=", "value": "Attio" } ] } ] }
    ] },
    { "op": "or", "conditions": [
      { "field": "text", "type": "[.]", "value": "introducing" }, "..." ] } ] },
  "config": {
    "trigger": { "type": "interval", "every_hours": 24 },
    "preferred_hour": 6,
    "max_results_per_run": 29 },
  "notifications": []
}
```

Each create returns the watch, including what it bills:

```json
{ "id": 54633, "kind": "discovery", "dataset": "job", "status": "active",
  "config": { "trigger": { "type": "interval", "every_hours": 24 }, "preferred_hour": 6,
              "max_results_per_run": 72, "refresh_frequency_days": 30 },
  "notifications": [], "created_at": "2026-10-22T21:45:43.244478Z",
  "credits": { "per_notification": 0.5 } }
```

Before creating, `init` lists the active watchers of that kind on the account (`GET /watch/company`,
`GET /watch/job/search`, `GET /watch/social_post/search`, free) and reuses one whose definition matches exactly and
that delivers nowhere, so a second copy of the tracker never doubles the bill. The runs a reused watcher finished
before it was adopted are marked as read, so the first digest is not filled with old items. Each id is saved in
`data/tracker.sqlite` right after it is created. Creates are never retried automatically, so a timeout cannot leave
two billed watchers. Watcher filters are fixed once created: when the competitor list or the post words change,
`init` and `remove` pause the job and post watchers and create new ones (`add` leaves that to the next `init`), and
PATCH the company watcher's list in place. The paused ones are read one last time by the next digest, which also runs
a short catch-up search for the gap since the old watcher last ran (about a day), and are then deleted. A 403 on the post watcher (Social Post Search not enabled on the account) is noted and the rest carries on.

## `npm run digest`: the weekly run

The whole build runs inside one SQLite transaction, and a lock file next to the database stops a second command from
changing the state at the same time. It starts with a free `GET /account/credits`: a rejected key (401) or an empty
account (402) stops the run before anything is saved, sent or marked as reported. A dry run (`-- --dry-run`) rolls
the transaction back, so it leaves no trace (it still pays for the pages and searches it makes).

### 1. Pages again (1 credit per page)

The same `POST /web/enrich/live` for every tracked page. `diffPages` compares the new visible text with the stored
version, block by block: new and removed blocks, new same-site links, new logos, and price lines whose figures moved
(matched under the plan name above them). `launchItems` and `customerItems` turn a comparison into digest lines. A page
that fails is reported as a warning and compared next week.

### 2. News since the last digest (1 credit per competitor)

```http
POST https://api.crustdata.com/web/search/live
{ "query": "\"Attio\" CRM", "sources": ["news"], "start_date": 1792540800 }
```

```json
{ "success": true, "results": [
  { "source": "news",
    "title": "Attio goes agent-native: SQL access and event data",
    "url": "https://app.dealroom.co/news/note/...",
    "snippet": "Key takeaways from a Scaling Europe interview with Attio Founder..." } ] }
```

`newsItems` keeps a result that names the competitor's website, or the competitor with what they make, or (for a
capitalised name) the competitor next to a business word such as founder, raises or API. Listing pages, the
competitor's own site and repeats are dropped.

### 3. What each watcher caught

First a free `GET /watch/{dataset}/{id}` for each watcher: one that is paused or suspended (Crustdata suspends a watch
most often for a low balance) is a warning and its sections say "not checked"; one that has not run since the last
digest is named in its sections ("has not run since the last digest") instead of being reported as quiet.

```http
GET https://api.crustdata.com/watch/job/54633/runs?limit=20
```

```json
{ "runs": [{ "id": 439380, "started_at": "2026-10-22T21:45:43.385436Z", "status": "SUCCESS",
             "new_records_count": 5, "credits_deducted": 0 }], "next_cursor": null }
```

Runs come back newest first; the agent reads them oldest first, so the newest company record wins. Only finished
runs are read: `SUCCESS`, `FAILED` and `SKIPPED` (both noted as a warning with Crustdata's reason, for example
insufficient credits, and the section marked "not checked"). A run that is still `RUNNING` is left for the
next digest instead of being marked as read. The watch's first run (its free baseline sample, the lowest run id) is
marked as read without reporting anything. For each other successful run with new records:

```http
GET https://api.crustdata.com/watch/job/54633/runs/439380/summary
```

```json
{ "id": 439380,
  "records_download": {
    "url": "https://crustdata-batch-api-data.s3.amazonaws.com/watcher/download/..." } }
```

The file is downloaded only over https from Crustdata's own storage host, with no redirects and a 50 MB limit. It
holds one record per line. Company watcher lines are `{ "changes": [...], "record": {...} }`, for example
`{ "field": "headcount.total", "type": "changed", "from": 200, "to": 215 }` or
`{ "field": "news", "type": "added", "new_elements": [...] }`. Job and post watcher lines are plain records:

```json
{ "crustdata_job_id": 1000,
  "job_details": { "title": "Account Executive", "category": "Sales", "url": "https://..." },
  "location": { "city": "London", "country": "United Kingdom" },
  "metadata": { "date_added": "2026-10-20T10:00:00" },
  "company": { "basic_info": {
    "primary_domain": "attio.com", "crustdata_company_id": 664000 } } }
```

```json
{ "actor": { "actor_type": "person", "name": "...", "title": "CEO", "company_name": "Attio" },
  "text": "...", "date_posted": "2026-10-23T09:00:00Z",
  "share_url": "https://...", "reposter": null }
```

Each run's `credits_deducted` is added to the digest's cost line. A watcher deleted in the dashboard (404) is a
warning, and the next `npm run init` sets it up again.

### 4. Recent listings (free)

```http
POST https://api.crustdata.com/job/search
{ "filters": { "op": "and", "conditions": [
    { "field": "company.basic_info.primary_domain", "type": "=", "value": "attio.com" },
    { "field": "metadata.date_added", "type": "=>", "value": "2026-09-26T08:00:00" } ] },
  "limit": 0 }
```

```json
{ "job_listings": [], "total_count": 12 }
```

The number of listings posted in the last 30 days, compared with the count at the previous digest. A drop of 40% or
more is reported as fewer new listings. (A total count of every listing on file is not used: closed listings do not
always leave the index straight away.)

### 5. Direct searches: the first digest, new competitors, and after a watcher is replaced

Watchers only report what is new after they were created, so the first digest, and the first digest after a
competitor is added, also run two direct searches per competitor (only the new one, in the second case):
`POST /job/search` filtered on `metadata.date_added` (0.03 credits per job returned, up to 100) and
`POST /social_post/search` with `date_posted => now-7d` and the announcement words (0.5 credits per post, up to 25).
After a job or post watcher was replaced, the next digest searches only the gap since the old one last ran (jobs from
that time, up to 30; posts from the same span in whole days, `now-24h` for a day or less and at most 30 days, up to 8), because the new watcher's free first run records
everything that existed when it was made.

### 6. Judge, save, send

`hiringItems`, `headcountItems`, `fundingItems`, `postItems` and `dedupeHeadlines` apply the rules in the README. The
digest is saved with everything it marks as reported, and the transaction is committed. Then `digestMarkdown` writes
`digests/YYYY-MM-DD.md`, `sendDigestToSlack` posts it (one message when it fits Slack's limits) and
`sendDigestEmail` sends it through Resend. Each channel is marked sent only after it accepts; `npm run resend` (and
the next `npm run digest`) sends every saved digest of the last 8 weeks to any channel that missed it, oldest first.

## Cost, worked

Three competitors, 6 pages each, a week where one company changed, 15 new jobs and 2 announcement posts appeared:
18 pages + 3 news searches + 5 (company change) + 7.5 (jobs) + 4 (posts) = 37.5 credits.
