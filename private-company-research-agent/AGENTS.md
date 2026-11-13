# AGENTS.md

Guide for AI coding agents working on Private Company Research Agent, an open-source due diligence agent for VCs built on the Crustdata API. People should start with [README.md](README.md).

## What this is

A TypeScript command line tool with no server and no database. `npm run research -- <domain | file.csv>` resolves
each company with the Crustdata API, fetches its record, former staff, job counts and peers, and writes a diligence
memo to `out/<domain>/memo.md` and `memo.json`; a list also gets `out/<list>/comparison.md`, `comparison.csv` and
`unresolved.csv`. Paid answers are cached in `out/.cache/` for `CACHE_DAYS` (7). No AI model is used unless the user
passes `--ai` with their own key.

## Commands

```bash
npm install
npm test                                         # node:test, offline: no network, no API key
npm run typecheck                                # tsc --noEmit
npm run replay -- fixtures/fast-grower.json      # the whole run offline from saved answers
npm run research -- acme.com --dry-run           # free: the most it can cost
npm run research -- acme.com                     # needs CRUSTDATA_API_KEY; 5 to 13 credits
npm run -s research -- acme.com --json           # memo JSON on stdout (-s: no npm header)
```

## Before you run anything that calls Crustdata

- `npm run setup` is interactive. Do not run it as an agent: set `CRUSTDATA_API_KEY` in the environment or in
  `.env` (copy `.env.example`) instead.
- Run with `--dry-run` first and read the "at most N credits" line. It is free.
- Research only companies the user asked about. A run whose estimate is above `MAX_CREDITS_PER_RUN` (150) needs
  `--yes`: do not add `--yes` to spend credits the user has not agreed to.
- `--refresh` and `CACHE_DAYS=0` pay again for companies already researched this week; use them only when asked.
- Never print or commit a key, and never commit `out/` (memos name real people).

## After every change

Run `npm test` and `npm run typecheck`; both must pass. Use `npm run replay -- fixtures/struggling.json` to see most
red-flag rules end to end without a key, and `fixtures/fast-grower.json` for founder-elsewhere and leader step-backs. Add a test for every behaviour you change. Keep user-facing text free of em
and en dashes and filler words, and say "profile URL", not the name of any
social network.

## Flow

`cli.ts` parses arguments and inputs (`input.ts`), prints the estimate, checks the credit guard, takes a lock on
`OUT_DIR` (`OUT_DIR/.lock`), then for each company calls `collect()` (`collect.ts`, all API calls, through `cache.ts`), `buildMemo()`
(`memo.ts`, pure; it runs `sanitizeBundle()` from `sanitize.ts` first, so every rule can trust its input) and the
renderers (`render.ts`, pure), and writes files. `crustdata.ts` is the only file that talks to the API. One company
that fails on Crustdata's side is skipped and the run goes on; a bad key, no credits, a network failure, or three
companies failing in a row stop it. Exit codes: 0 all researched, 2 some not (see unresolved.csv), 1 nothing researched, the run stopped, or the command was wrong.

## Add a red-flag rule (checklist)

1. Push a finding in the "Findings" part of `buildMemo` in `src/memo.ts` with a new `id`, `kind: "red_flag"`, the
   text, its evidence (field and date) and a question; give the id a place in `RANK` (question order).
2. If it reads a new field: add it to `ENRICH_FIELDS` (or `PERSON_FIELDS` / `PEER_FIELDS`; the cache key changes
   with it, so old answers are not reused), type it in `src/types.ts`, and coerce it in `src/sanitize.ts`:
   `sanitizeCompany` for the company record, `searchRole`/`searchPerson` for people, `peer` for peers. Fields not
   coerced there are dropped before the rules run.
3. Add a case to `fixtures/struggling.json` (the generator is not in the repo; edit the JSON) and a test in
   `test/memo.test.ts`. A finding that names a person must use the leaver's `name`, which is already empty for
   non-leaders under `PEOPLE_DETAIL=leaders` (applied before the findings are built).
4. Update the rule list in `renderMemo` ("None found by the rules this memo checks ..."), the red-flag table in
   README.md and the list in docs/customize.md.
5. Finding ids and the memo.json shape (`schema: 1`) are read by other tools: add fields, do not rename them.

## Where things are

| To change | Edit |
|---|---|
| Which Crustdata fields are fetched | `ENRICH_FIELDS` in `src/crustdata.ts`; the shapes read are in `src/types.ts` |
| Red-flag and signal rules, thresholds | the "Findings" part of `buildMemo` in `src/memo.ts` |
| Who counts as a leader | `LEADER_TITLE`, `LEADER_TITLE_BIG`, `BIG_COMPANY` (500), `NOT_STAFF`, `ASSISTANT`, `LEADER_LEVELS`, `isLeader` in `src/memo.ts` |
| Interns and contractors among leavers | `INTERN`, `NOT_STAFF`, `categoryOf` in `src/memo.ts` |
| Founder-call questions | the `question` of each finding, and `extraQuestions` in `buildMemo` |
| How peers are picked | `competitorDomains`, `minPeerSize`, `industriesOf` and the peers block in `collect()` in `src/collect.ts` |
| Leaders read per company | `SENIOR_LIMIT` in `src/collect.ts` (the estimate uses it too) |
| What counts as a company website | `ALWAYS_LINK`, `PATH_LINK`, `HOSTED`, `NOT_A_SITE_HEADER`, `FREE_MAIL`, `notASite` in `src/input.ts` |
| What the estimate treats as saved | `estimate` in `src/cli.ts` with `keysFor` in `src/collect.ts` (one key per answer collect() reuses) |
| Memo layout | `renderMemo` in `src/render.ts` |
| Comparison columns | `COLUMNS` and `values` in `src/render.ts` |
| Prices used for estimates | `LIST` in `src/collect.ts` |
| Cache keys | `cacheKey` and `CACHE_VERSION` in `src/collect.ts` (bump the version when an answer's meaning changes) |
| CSV column names recognised | `DOMAIN_HEADERS`, `NAME_HEADERS`, `EMAIL_HEADERS` in `src/input.ts` |
| The AI note | `prompts/analyst-note.md` (instructions) and `src/ai.ts` |

## API facts the code relies on (checked live 2026-11-13)

- Base `https://api.crustdata.com`, headers `authorization: Bearer <key>` and `x-api-version: 2025-11-01`. The
  `x-credits-used` response header is the charge. Company Enrich allows 15 calls a minute; the searches 30.
- `/company/identify` is free and takes full URLs. It can return a company that only links to the domain, so the
  match is kept only when its own `primary_domain`, `all_domains` or `website` include the domain asked.
- `/company/enrich` costs 2 credits with the 13 groups requested. `people.*` entries use a different shape from
  `/person/search`: `employer_name`, `employee_title`, `employee_start_date`, `employer_company_id[]`.
- `competitors.paid_seo` and `organic_seo` items can start with a space and include unrelated sites.
- `headcount.by_function_timeseries` runs about three months behind `headcount.timeseries`.
- `basic_info.employee_count_range` can be far below `headcount.total` (Granola: "11-50" vs 161).
- `/person/search`: `experience.employment_details.past.end_date` is not a filter field; use the all-roles path
  `experience.employment_details.end_date` in the same `and` as `experience.employment_details.company_id` (same
  role). `experience.employment_details.current.company_id != id` drops people still there. List price 0.23 per
  person returned when experience is filtered and returned. The `Strategic` and `Owner / Partner` seniority levels
  tag account reps and talent partners, so they do not make someone a leader.
- `/job/search` with `limit: 0` and `aggregations` is free. Some postings have no `metadata.date_added`.
- `/company/search` has no `web_traffic`; growth keys there are `1m, 3m, 6m, 12m` (enrich uses `qoq, six_months,
  yoy`). Filtering on `crustdata_company_id in [...]` works.
- `public_launches.launches[].launched_at` is unix seconds.
- `/company/identify` returns `basic_info.industries` (free): peers must share one with the company.
- `funding.total_investment_usd` can include secondary sales (Linear: $233M on record, $134M in primary rounds);
  `funding.last_round_type` can be `secondary_market`. The memo uses primary rounds from `funding.milestones`.
- `news[].confidence_score` is Crustdata's confidence the article is about the company; same-name headlines
  (Linear TV) come back at 0.8 to 0.85.

## Tests

| File | Covers |
|---|---|
| `test/input.test.ts` | domains from URLs and emails, IDN and zero-width characters, CSV parsing, unclosed quotes, delimiters, CRM exports, links that are not websites, personal email providers, kept input columns, Excel files |
| `test/memo.test.ts` | every rule on the three fixtures, leaders by company size, step-backs vs promotions, founders elsewhere, founded before, interns and contractors, peers by industry and size, news matching, secondary sales, missing data, odd API shapes, PEOPLE_DETAIL, job index, helpers |
| `test/cli.test.ts` | whole runs against `fakeFetch`: files and permissions, cache and resume without paying twice, one failing company skipped, three in a row stop, dry run, credit guard, npm swallowing flags, the out-folder lock, list names, old unresolved files, plain errors, `--json`, `--ai` without a key, denied field groups, escaping, import without running |
