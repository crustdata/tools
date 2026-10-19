# Watch your accounts with Crustdata

[Back to the README](../README.md)

Once `npm run find` has written `out/accounts.csv`, a Crustdata watcher can tell you when those accounts raise a round, grow or shrink, open roles, make the news, or post a job that signals a need. Crustdata runs the watcher and posts each change straight to a Slack channel, Google Chat, email or your own webhook. There is no server to run and nothing in this repo keeps running: you set the watcher up once, with Crustdata.

Crustdata's guides: [Company Entity Watcher](https://docs.crustdata.com/watcher-docs/company/entity), [Job Watcher](https://docs.crustdata.com/watcher-docs/job/watch), [Social Post Watcher](https://docs.crustdata.com/watcher-docs/social-post/discovery), [delivery channels](https://docs.crustdata.com/watcher-docs/company/entity#delivery-channels).

## 1. Get the request for your shortlist

```bash
npm run watch-example -- --slack https://hooks.slack.com/services/... --job-keywords "FinOps, revenue operations"
```

- It reads the `crustdata id` column of `out/accounts.csv`. Delete rows there first to leave accounts out.
- `--slack` takes a Slack [incoming webhook](https://api.slack.com/messaging/webhooks) URL; `--email a@you.com,b@you.com` sends to email instead, or as well. Without either, the file has a placeholder to replace.
- `--job-keywords` adds a job watcher for those phrases in a job title or description.
- It writes `out/watch-company.json` (and `out/watch-jobs.json`), prints the curl for each, and sends nothing.

## 2. Create the watcher yourself

Either run the printed curl:

```bash
curl -X POST https://api.crustdata.com/watch/company \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" -H "content-type: application/json" -H "x-api-version: 2025-11-01" \
  --data @out/watch-company.json
```

or set it up in the Crustdata dashboard at [app.crustdata.com/watch](https://app.crustdata.com/watch) with the company ids from `out/accounts.csv`. The response is the watcher, with its `id`; keep it to pause or cancel later.

A new watcher first sends a free baseline sample, so you see what a message looks like right away. To check the channel without waiting, `POST /watch/company/{id}/test` with an empty body sends a sample for free.

## What the requests contain

Company watcher, over the shortlist:

```json
{
  "entities": { "crustdata_company_ids": [9000010, 9000011] },
  "track": { "op": "or", "conditions": [
    { "field": "headcount.total", "type": "changed" },
    { "field": "funding.last_round_type", "type": "changed" },
    { "field": "hiring.openings_count", "type": "changed" },
    { "field": "news", "type": "added" }
  ]},
  "fields": ["basic_info", "headcount", "funding", "hiring", "news"],
  "config": { "trigger": { "type": "interval", "every_hours": 24 }, "max_results_per_run": 300 },
  "notifications": [{ "type": "slack", "webhook_url": "https://hooks.slack.com/services/..." }]
}
```

Job watcher, at `POST /watch/job/search`:

```json
{
  "filters": { "op": "and", "conditions": [
    { "field": "company.basic_info.company_id", "type": "in", "value": [9000010, 9000011] },
    { "op": "or", "conditions": [
      { "field": "job_details.title", "type": "[.]", "value": "FinOps" },
      { "field": "content.description", "type": "[.]", "value": "FinOps" }
    ]}
  ]},
  "fields": ["job_details", "company.basic_info", "location", "metadata"],
  "sorts": [{ "field": "metadata.date_added", "order": "desc" }],
  "config": { "trigger": { "type": "interval", "every_hours": 24 }, "max_results_per_run": 100 },
  "notifications": [{ "type": "email", "to": ["you@company.com"] }]
}
```

Notes:

- `notifications` takes one or more channels: `{ "type": "slack", "webhook_url": ... }`, `{ "type": "google_chat", "url": ... }`, `{ "type": "email", "to": [...] }` or `{ "type": "webhook", "url": ... }`.
- `track` and `fields` of a company watcher are fixed once it exists; the company list, `config` and `notifications` can be changed with `PATCH /watch/company/{id}` (a `config` PATCH must repeat `trigger`).
- Job watcher filters are fixed at creation. For a new shortlist or new keywords, create a new one and cancel the old.
- `[.]` matches the exact phrase, so "data enrichment" needs both words together.
- Drop the `headcount.total` line if every hire and exit is more than you want; it is the signal that fires most often.

To also hear when people at the accounts post about your topic, a [Social Post Watcher](https://docs.crustdata.com/watcher-docs/social-post/discovery) can filter on the author's current employer with the person field `experience.employment_details.current.company_id in [...]`, together with `{ "field": "text", "type": "[.]", "value": "month-end close" }`. 2 credits per new post.

## What it costs

Billed by Crustdata, per record delivered:

| Watcher | Cost at list price |
|---|---|
| Company | 5 credits per account that changed on a run |
| Job | 0.5 credits per new job post |
| Social post | 2 credits per new post |

A quiet day costs nothing. `max_results_per_run` caps what one run can deliver, so the example files cap a day at 300 x 5 + 100 x 0.5 = 1,550 credits at list price (less for a shorter list; `npm run watch-example` prints yours). Expect most accounts to fire the headcount signal about once a month, and a handful of job posts a day for specific keywords.

How fresh it is: the watchers check every 24 hours (`every_hours`); company profiles are refreshed on a roughly 30-day cycle, so a headcount or funding change can reach you days or weeks after it happened. New job posts arrive on the first check after Crustdata indexes them.

## Pause, cancel, list

Same headers as above, against `https://api.crustdata.com`:

```http
GET    /watch/company                               your company watchers, with credits used so far
PATCH  /watch/company/{id}   { "status": "paused" }  pause ("active" resumes)
DELETE /watch/company/{id}                          cancel for good
```

For a job watcher the paths are `/watch/job/search` and `/watch/job/search/{id}`. Past runs and what they delivered: `GET /watch/company/{id}/runs`.
