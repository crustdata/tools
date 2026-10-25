# AGENTS.md

Guide for AI coding agents working in this repository. People should start with [README.md](README.md).

## What this is

A TypeScript command line tool with no server and no database. `npm run research -- <people>` takes up to 100
people (profile URLs, emails, or a name and company), looks each one up with the Crustdata API, and writes a
one-page brief per person to `out/<name>.md` and `out/<name>.json` as each one finishes, plus `out/index.md` for
several people. With one person the brief is also printed; `--json` prints a JSON array. Answers are cached in
`out/.cache/` for `CACHE_HOURS` (24). No AI model is involved anywhere.

## Commands

```bash
npm install
npm test                                       # node:test, offline: no network, no API key
npm run typecheck                              # tsc --noEmit
npm run replay -- fixtures/meeting.json        # the whole run offline from saved answers
npm run research -- jane@acme.com --dry-run    # free: who, and the most it can cost
npm run research -- jane@acme.com              # needs CRUSTDATA_API_KEY; 5.5 to 6.5 credits
npm run -s research -- jane@acme.com --json    # a JSON array (-s: no npm header line)
```

## Before you run anything that calls Crustdata

- `npm run setup` is interactive (it asks for the key). Do not run it as an agent: set `CRUSTDATA_API_KEY` in the
  environment or in `.env` (copy `.env.example`) instead.
- Run with `--dry-run` first and read the "at most N credits" line. It is free.
- Research only people the user asked about. One run takes at most 100 people, and a run whose estimate is above
  `MAX_CREDITS_PER_RUN` (150) needs `--yes`: do not add `--yes` to spend credits the user has not agreed to.
- `--refresh` and `CACHE_HOURS=0` pay again for people already researched today; use them only when asked
  (`CACHE_HOURS=0` leaves the saved answers on disk alone, it just does not use them).
- Never print or commit a key, and never commit `out/` (it holds personal data).
- Do not use briefs to decide on someone's employment, credit, insurance or housing: a brief is not a consumer
  report under the US FCRA.

## After every change

Run `npm test` and `npm run typecheck`; both must pass. Use `npm run replay -- fixtures/meeting.json` to see a
change end to end without a key. Keep user-facing text free of em and en dashes, and say "profile URL", not the name
of any social network.

## Tests

| File | Covers |
|---|---|
| `test/input.test.ts` | profile URL normalising, emails in invite text, name and company forms, CSV and plain lists, line numbers |
| `test/brief.test.ts` | the "what changed" rules and their edges, duplicate roles, career grouping, dates, clipping, web link filtering, posts |
| `test/render.test.ts` | markdown escaping of external text, sections shown only with data, the index |
| `test/research.test.ts` | whole runs against `fakeFetch`: call order and bodies, cost, cache, invalid emails, plan gates (403), server errors, bad key, name picks, duplicates, contacts, flags |
| `test/regressions.test.ts` | one test per bug found in review: stopped runs keep briefs, one failure never stops the run, no double billing, row matching, rejoins, window edges, file names, JSON shape, `.env` round trip |
| `test/regressions2.test.ts` | one test per bug found in review round 2: batches already paid for are kept, awaited callbacks, stray quotes in CSV, names with credentials, denied fields expire, exit codes, cache purge with the cache off, identify misses, role edge cases, `.env` quoting |
| `test/regressions3.test.ts` | one test per bug found in review round 3: plain lists where a line's company looks like a column name, mixed-case emails from code, contacts not checked vs none found, identify batches, curly apostrophes, moves next to an advisor role, old Mac line endings, per-run credits, pacing slots |
| `test/round1.test.ts` | calendar pastes, CRM and contact exports, `SKIP_DOMAINS`, `MAX_CREDITS_PER_RUN`, exit codes, file permissions and cache purge, past-employer search, match scores, section order, link safety, retries |

## Where things are

| To change | Edit |
|---|---|
| A Crustdata request, or add an endpoint | `src/crustdata.ts`, the only file that calls Crustdata (pacing in `MIN_GAP_MS`, retries in `request`) |
| What a brief contains | `buildBrief()` and the `Brief` type in `src/brief.ts` |
| The "What changed lately" rules | `changes()` in `src/brief.ts`; add a case to `test/brief.test.ts` |
| Career grouping and dates | `career()`, `roles()`, `dateRange()`, `duration()` in `src/brief.ts` |
| The markdown layout | `renderBrief()` and `renderIndex()` in `src/render.ts` (always pass external text through `md()`) |
| Which web results are dropped | `config/ignored-sites.json` and `pickLinks()` in `src/brief.ts` |
| The web and news query | `searchPhrase()` in `src/brief.ts`; the window is `NEWS_DAYS` in `src/research.ts` |
| The order of calls, the cache keys, files | `research()`, `enrichCached()`, `BriefWriter` in `src/research.ts` (a run that stops throws `RunStopped` with the outcomes so far) |
| The news window | `NEWS_DAYS` in `src/research.ts` |
| The cost estimate | `LIST` and `estimate()` in `src/research.ts`; the cost table in `README.md` |
| Input forms and CSV columns | `classify()`, `parseNameLine()`, `parseList()`, `COLUMNS`, `headerKey()`, `skipDomains()` in `src/input.ts` |
| A flag | `parseArgs()` and `HELP` in `src/cli.ts`, the flags tables in `README.md` and `docs/reference.md` |
| Exit codes (0 done, 2 some missed, 3 stopped, 1 nothing ran) and the JSON shape | `main()` and `jsonOutcomes()` in `src/cli.ts` |
| A setting | `src/config.ts`, `.env.example` and the settings tables together |
| Offline answers | `src/fake-api.ts` and `fixtures/*.json` (`forbidden` simulates plan gates, `faults` injects errors) |

## Facts about the Crustdata API this code relies on (checked live, 2026-10-23)

- Base URL `https://api.crustdata.com`. Every request sends `authorization: Bearer <key>` and
  `x-api-version: 2025-11-01`. The `x-credits-used` response header is the charge.
- `POST /person/enrich` takes `professional_network_profile_urls` or `business_emails` (up to 25) and `fields`.
  (`business_emails` worked live on 2026-10-23 but is not in the enrich docs; a 400 sends the emails to identify.)
  The answer is a top-level array, one row per identifier in request order: `matched_on`, `match_type`,
  `match_status` (`matched`, `not_found`, `redacted`), `matches[0].person_data`. 1 credit per match; misses free;
  15 calls a minute. All of `basic_profile`, `professional_network`, `social_handles`, `experience`, `education`,
  `skills`, `certifications`, `honors` are in the base credit. Paid extras: `social_posts` 5, `dev_platform_profiles`
  1, contact fields 1 / 2 / 2.
- Role dates are ISO timestamps at month precision (`2024-01-01T00:00:00+00:00`); `end_date` is null on current
  roles. Profiles sometimes list one role twice under two `position_id`s. Each role carries the employer's
  `crustdata_company_id`, `company_website_domain`, `company_headcount_latest`, `company_headcount_range`,
  `company_industries` and `company_description` (sentences sometimes joined with no space).
- `POST /person/identify` `{ "emails": [...] }`: same row shape with a smaller `person_data` (id, basic profile,
  social handles). 1 credit per match, misses free, 30 a minute. `confidence_score` is 1 for an address on file and
  0.5 to 1 for a match by the name in the address at the domain (the brief then warns). One address it refuses fails the whole call
  with 400 `Invalid emails: a, b` (it refused an `example.org` address). Enabled per account and not listed in
  `/account/endpoints`: probe with an address that matches nobody (free); 403 means not enabled.
- `POST /person/search`: `basic_profile.name [.] "<name>"`; employer by
  `experience.employment_details.current.company_website_domain = "acme.com"` (bare domain, exact) or
  `experience.employment_details.current.name [.] "<name>"`; any employer, current or past:
  `experience.employment_details.company_website_domain` / `experience.employment_details.company_name`.
  Answer `{ profiles, total_count, next_cursor }`. 0.03
  per profile returned, plus premium filter groups (experience 0.1 at list price). A common name returned 8 people.
- `POST /social_post/search`: filter `actor.crustdata_entity_id = <person id>`, `actor.actor_type = person`,
  `post_type = original`; sort `date_posted desc`. Rows with `post_type: repost_without_thoughts` carry the original
  author as `actor` and the reposter as `reposter`, so without the `post_type` filter other people's reposts of the
  person's posts come back (and are billed). 0.5 per post; `limit: 0` returns `total_count` for free. The index
  lagged 11 weeks for an active poster. The live per-person post endpoints are enterprise-only.
- `POST /web/search/live` `{ query, sources: ["web"] }` or `["news"]` with `start_date` (unix seconds): 1 credit per
  source per query, 0 when no results. Results are `{ source, title, url, snippet, position }`, no date.
  10 calls a minute.
- `POST /person/contact/enrich` takes `professional_network_profile_urls` and `fields` (`contact.business_emails`,
  `contact.personal_emails`, `contact.phone_numbers`); billed per type found, no base credit; 15 a minute;
  self-serve keys get 403. Email `status` is `deliverable`, `catch_all`, `invalid` or `unknown`.
- A field group the key may not read fails enrich with 403 `Access denied to fields: x` (or 400 `Invalid fields`);
  `enrich()` drops the group and sends again, and `research()` remembers it in the cache (`denied-fields`).
  Certifications and honors need field permission on many keys; Social Post Search is off by default.
- Billed POSTs are retried only on 429, on 502/503 that report 0 credits, and on connections that never opened.
- `GET /account/endpoints` lists per endpoint `status`, `base_credits` and `premium_fields`. `/batch/person/verify`
  (work history verification, 10 credits a verdict) was disabled on the build account, so the tool does not call it.

Docs: https://docs.crustdata.com (append `.md` to any docs URL for markdown, or start at
https://docs.crustdata.com/llms.txt).

## Conventions

- Node 22.13+, ESM, TypeScript run with `tsx`. No build step. Relative imports use the `.js` suffix.
- Keep pure logic free of I/O: `src/brief.ts`, `src/render.ts` and `src/input.ts` take values and return values
  (the time is passed in as `now`). Network calls live in `src/crustdata.ts`, files in `src/research.ts`,
  `src/cache.ts` and `src/cli.ts`.
- Tests never touch the network: they install `fakeFetch` from `src/fake-api.ts` and turn off pacing.
- Fixtures hold made-up people and companies only (`.example` domains, `example-` profile slugs). Never paste a
  real person into a fixture or a test.
