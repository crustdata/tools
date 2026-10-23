# AGENTS.md

Guide for AI coding agents working in this repository. People should start with [README.md](README.md).

## What this is

Competitor Tracker is a TypeScript command that sends one weekly digest of what a list of competitors did: launches,
money and news, customers, hiring, headcount and posts. Crustdata (a B2B company and people data API: 60M+ companies,
1B+ people) does the watching: three pull-only watchers (company changes, new jobs, announcement posts) set up with
the user's key, plus Web Fetch for competitor pages and Web Search for news. This repo resolves the competitors, saves
a starting point, manages the watchers, reads their finished runs once a week, compares pages with last week, applies
written rules about what matters, saves the digest, and sends it to Slack, email and a markdown file. There is no
server and no LLM.

## Commands

```bash
npm install
npm test                                  # every test, no network, no API key
npm run typecheck                         # tsc --noEmit
npm run replay -- fixtures/busy-week.json # offline, fixture API, sends nothing
npm run setup                             # interactive; writes .env and competitors.json
npm run init                              # paid: starting point + watchers (asks; -- --yes)
npm run digest -- --dry-run               # paid: builds a digest, saves and sends nothing
```

Run `npm test` and `npm run typecheck` after every change. Both must pass. Never run `init` or a real `digest`
without the user's go: they spend credits, and `init` creates watchers on the user's account. A dry run still pays
for the pages and searches it makes, but leaves no trace in the state. If you create watchers while testing, delete
them with `npm run delete-watches`.

## Where things are

| To change | Edit |
|---|---|
| A Crustdata request, or add an endpoint | `src/crustdata.ts`, the only file that calls Crustdata (pacing in `MIN_GAP_MS`, retries in `request`) |
| What the company watcher fires on | `COMPANY_TRACK` in `src/crustdata.ts` (fixed once created: `npm run delete-watches`, then `npm run init`) |
| The job and post watcher filters | `jobWatchFilters` and `postWatchFilters` in `src/crustdata.ts`; `init` replaces the watchers when they change |
| Which posts the post watcher delivers, and which are kept | `config/post-keywords.json`; the classifier is `classifyPost` in `src/posts.ts` |
| Page parsing, comparison, launch and customer rules | `visibleText`, `normalizeUrl`, `diffPages`, `comparePrices`, `launchItems`, `customerItems`, `looksBlocked` in `src/website.ts` |
| Which pages are tracked | `discoverPages` and `PAGE_KINDS` in `src/website.ts`; per competitor, `pages` in `competitors.json` |
| Hiring rules | `hiringItems` and `RECENT_DAYS` in `src/hiring.ts` |
| Headcount thresholds | `TOTAL_THRESHOLD`, `FUNCTION_THRESHOLD`, `MIN_FUNCTION_SIZE`, `REFERENCE_DAYS` in `src/headcount.ts` |
| Funding and news rules | `fundingItems`, `fundingBaselineItems`, `newsItems`, `newsQuery` in `src/money.ts`; `dedupeHeadlines` in `src/run.ts` |
| Setting up and reusing watchers | `init` and `ensureWatches` (with `matches`) in `src/run.ts` |
| The order of calls in a weekly run, and state | `runDigest` and `buildDigest` in `src/run.ts` (one transaction per digest) |
| Sending, and resending a failed send | `deliver`, `resendPending`, `undeliveredAll` (every owed digest), `resendLast`, `undelivered` (`--all`) in `src/run.ts` |
| A new section | `SECTIONS` and `SECTION_TITLES` in `src/types.ts`, `QUIET` in `src/digest.ts`, step 5 of `buildDigest`, a fixture case and a `test/run.test.ts` assertion. Walkthrough in `docs/customize.md` |
| Digest wording and layout | `src/digest.ts` (markdown), `src/slack.ts`, `src/email.ts` (built from the `Digest` model, not the markdown) |
| Cost estimates shown to the user | `PRICES`, `estimateInit`, `estimateWeek`, `FIRST_DIGEST_MAX_PER_COMPETITOR` in `src/run.ts`, and the cost table in `README.md` |
| State schema | `src/store.ts` (`CREATE TABLE IF NOT EXISTS`) |
| A setting | `src/config.ts`, `.env.example`, `examples/github-actions-weekly.yml` and the Configuration table in `README.md` together |
| A command | `src/cli.ts`, an npm script in `package.json`, and the Commands table in `README.md` |
| Offline samples | `fixtures/*.json` (shape documented at the top of `src/fixture-api.ts`) |

## Facts about the Crustdata API this code relies on (checked live, October 2026)

- Base URL `https://api.crustdata.com`. Every request sends `authorization: Bearer <key>` and
  `x-api-version: 2025-11-01`. `x-credits-used` reports the cost of each call. `GET /account/credits` is free.
- `POST /company/identify` `{ "domains": [...] }` is free and returns
  `[{ matched_on, matches: [{ company_data: { crustdata_company_id, basic_info } }] }]`.
- `POST /company/enrich` `{ crustdata_company_ids, fields }` costs 2 credits per company.
  `headcount.by_function_timeseries.CURRENT_FUNCTION.<function>` is a list of `{ date, employee_count }`;
  `headcount.growth_percent` has `mom`, `qoq`, `six_months`, `yoy`; `funding` has `last_round_type`,
  `last_round_amount_usd`, `last_fundraise_date`, `acquisitions[]`, `investors[]`; `news[]` has `article_title`,
  `article_url`, `article_publish_date`, `article_publisher_name`. Company records refresh every 1 to 30 days.
- `POST /web/enrich/live` (Web Fetch) `{ urls: [up to 10] }`, 1 credit per page, 10 requests a minute, returns a list
  of `{ success, url, title, content (full HTML), http_status }`.
- `POST /web/search/live` (Web Search) `{ query, sources: ["news"], start_date (unix seconds) }`, 1 credit per query,
  returns `results[]` of `{ title, url, snippet }` with no date.
- `POST /job/search` with `limit: 0` returns `total_count` for free. Aggregations cannot group by `location.city`, but
  it is filterable. Job records carry `crustdata_job_id`, `job_details.{title, category, url}`,
  `location.{city, state, country, raw}`, `metadata.date_added`, `company.basic_info.{primary_domain,
  crustdata_company_id}`. Closed listings do not always leave the index straight away.
- `POST /social_post/search`: 0.5 credits per post returned, enabled per account on request (403 otherwise). Select a
  company page by `actor.crustdata_entity_id` with `actor.actor_type = company`, staff by `actor.company_name` with
  `actor.actor_type = person`. `text` takes `[.]` (case-insensitive contains). `date_posted =>` takes windows such as
  `now-7d` and `now-3M`.
- Watchers: company entity `POST /watch/company` (5 credits per changed company; fires on any change to a tracked
  field), job `POST /watch/job/search` (0.5 per new job; `metadata.date_added => now-30d` is accepted as a rolling
  window), post `POST /watch/social_post/search` (2 per new post). All accept `notifications: []` (pull-only). The
  first run is a free baseline sample of up to 5 records. Discovery watch filters are fixed once created; the company
  watch's `entities` and `config` can be PATCHed. List and manage discovery watches at `/watch/{dataset}/search`
  (`?status=active`), entity watches at `/watch/company`; read runs of every kind at `/watch/{dataset}/{id}/runs`
  (newest first; `status` is `RUNNING`, `SUCCESS`, `FAILED` or `SKIPPED`) and `.../runs/{run_id}/summary`, whose
  `records_download.url` is a signed NDJSON file on `crustdata-batch-api-data.s3.amazonaws.com`. Company records
  arrive as `{ changes, record }`; job and post records arrive as plain records.
- Indexed jobs and posts lag: jobs refresh every 1 to 30 days and posts every 1 to 45. For a small company the newest
  indexed post can be weeks old. The digest prints each post's date and each hiring line's posting dates.

Docs: https://docs.crustdata.com (append `.md` to any page for markdown, or start at
https://docs.crustdata.com/llms.txt).

## Conventions

- Node 22.13+, ESM, TypeScript run with `tsx`. No build step. Relative imports use the `.js` suffix. Entry points
  import `./node-check.js` first.
- No native dependencies. State is `node:sqlite` in WAL mode. A digest is built inside one transaction (`begin`,
  `commit`, `rollback` in `src/store.ts`): nothing is marked as reported unless the digest that reports it is saved.
  Keep every new state write inside `buildDigest` so a dry run or a crash rolls it back; side effects outside the
  database (writing `competitors.json`, deleting replaced watchers) happen in `runDigest` only after `commit()`.
  Every command that changes state takes the lock file next to the database (`lock` in `src/cli.ts`).
- Watchers are never deleted before their runs are read: a replaced job or post watcher is paused and listed under
  `retired_<dataset>` in `meta`, read by the next digest, then deleted. `runs_seen` is never cleared (run ids are
  unique). The store is closed at the end
  of every command, so the one `.sqlite` file can be committed (GitHub Actions does).
- Pure logic (`website.ts`, `hiring.ts`, `headcount.ts`, `money.ts`, `posts.ts`, `digest.ts`) has no I/O. `run.ts`
  takes an `api` object, so tests pass `fixtureApi(fixture)` from `src/fixture-api.ts` instead of the network.
- A 401 or 402 stops the run (`isFatal` in `src/run.ts`); any other failure of one call becomes a warning and the
  section says "not checked this week", never "nothing new".
- Tests are `node:test`, never read `.env`, and never touch the network. Each new rule gets a unit test; each new kind
  of input gets a fixture and a case in `test/run.test.ts`.
- Escape everything taken from a page, post or record: `esc` in `src/slack.ts`, `mdEscape` in `src/digest.ts`,
  `escapeHtml` in `src/email.ts`. The email never parses markdown from outside text.
- Never log or commit secrets. Configuration lives only in environment variables and `competitors.json`.
- User-facing text has no em or en dashes. Never name a social network as a data source or link to a person's page as a source; say "posts" and "people".
  Staff are shown by job title; names only with `SHOW_POSTER_NAMES`.
