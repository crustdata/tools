# AGENTS.md

Guide for AI coding agents working in this repository. People should start with [README.md](README.md).

## What this is

VC Portfolio Monitor is a TypeScript command that watches the companies a venture fund owns and posts alerts to Slack
(per partner channel) and a weekly digest to Slack and email: headcount drops and team shrinkage, founder and C-level
departures, hiring stopping or jumping, new rounds, acquisitions, layoff or shutdown news. Crustdata (a B2B company and
people data API: 60M+ companies, 1B+ people) does the watching: two pull-only entity watchers created with the user's
key (companies, leaders), plus Web Fetch for careers pages. This repo reads the portfolio (CSV or Google Sheet),
resolves it, finds leaders and careers pages, manages the watchers, reads their finished runs daily, applies written
thresholds, stores each event once and delivers it. There is no server and no LLM.

## Commands

```bash
npm install
npm test                                  # every test, no network, no API key
npm run typecheck                         # tsc --noEmit
npm run replay -- fixtures/busy-week.json # offline, fixture API, sends nothing
npm run setup                             # interactive; writes .env
npm run import -- --dry-run               # free: matches the portfolio, shows the cost, changes nothing
npm run import                            # paid: starting point, leaders, careers pages, watchers (asks; -- --yes)
npm run check -- --dry-run                # free: reads the watchers; saves, posts and spends nothing (add --hiring-now to read careers pages, billed)
```

Run `npm test` and `npm run typecheck` after every change. Both must pass. Never run a real `import` or `check`
without the user's go: they spend credits, and `import` creates watchers on the user's account. If you create
watchers while testing, delete them with `npm run delete-watches`. Tests never read `.env` (`NODE_TEST_CONTEXT`);
set `VPM_NO_DOTENV=1` to make a run ignore it.

## Where things are

| To change | Edit |
|---|---|
| A Crustdata request, or add an endpoint | `src/crustdata.ts`, the only file that calls Crustdata (pacing in `MIN_GAP_MS`, retries in `request`) |
| What the watchers fire on | `COMPANY_TRACK`, `PERSON_TRACK`, `PERSON_FIELDS` in `src/crustdata.ts` (fixed once created; `npm run import` replaces a watcher whose track differs, reading the old one once more before deleting it) |
| Thresholds | `config/thresholds.json`; defaults and validation in `src/thresholds.ts` |
| Headcount, funding, news, hiring rules and "why it matters" | `isDrop`, `headcountSignals`, `teamSignals`, `startingPoint`, `fundingSignals` (`pricedRank`), `newsSignals` (`BAD`, `DOWN`, `LEGAL`, `MONEY`), `hiringSignals`, `leaderSignal`, `WHY` in `src/signals.ts` |
| Who is a leader; what a profile change means | `leaderRole`, `pickLeaders`, `leaderEvent`, `STEPPED_BACK`, `NOT_A_LEADER` in `src/leaders.ts` |
| Finding new leaders over time | `refreshLeaders` in `src/run.ts`, `leaderJoinedSignal` in `src/signals.ts` |
| Counting open roles | `countRoles`, `boardLinks`, `BOARDS`, `NOT_A_JOB` in `src/careers.ts` |
| Reading the portfolio | `readPortfolioCsv`, `COLUMN_ALIASES`, `sheetCsvUrl`, `readSource` in `src/portfolio.ts` |
| Import: matching, cost estimate, applying | `planImport`, `pickByName`, `estimateImport`, `importPortfolio`, `sizeMismatch` in `src/run.ts` |
| Reusing and updating watchers | `ensureWatches` in `src/run.ts` |
| The daily run | `runCheck`, `companySignals` (each rule in its own `rule(...)`), `personSignals`, `readHiring` in `src/run.ts` (one transaction) |
| The weekly digest | `runDigest`, `buildDigest`, `digestWarnings` in `src/run.ts`; markdown in `src/digest.ts` |
| Slack routing and layout | `routesFor`, `alertMessages`, `digestMessages` in `src/slack.ts`; posting, per-message progress and the dead-route fallback in `sendAlerts` in `src/deliver.ts` |
| Email | `src/email.ts` (built from the `Digest` model, every outside string escaped) |
| State schema | `src/store.ts` (`CREATE TABLE IF NOT EXISTS`, and `upgrade()` for databases made by an earlier version) |
| A setting | `src/config.ts`, `.env.example`, `examples/github-actions.yml`, `src/setup.ts` and the Configuration table in `README.md` together |
| A command | `src/cli.ts`, an npm script in `package.json`, and the Commands table in `README.md` |
| Offline samples | `fixtures/*.json` (shape at the top of `src/fixture-api.ts`) |

## Signal keys

Every `Signal` has a `key`; `store.addSignal` keeps one signal per key, and that is what stops an event being posted
twice. A key must name the company's domain (two portfolio companies in one story each get it) and what makes the
event distinct (the article URL, the round date, the person and the day, the reading date). Never drop the domain,
and never key on something that repeats for different events. The repeat window `repeat_after_days` only holds back
hiring jumps, slowdowns and restarts (in `readHiring`), never anything else.

## Facts about the Crustdata API this code relies on (checked live, October 2026)

- Base URL `https://api.crustdata.com`; headers `authorization: Bearer <key>` and `x-api-version: 2025-11-01`;
  `x-credits-used` reports each call's cost. `GET /account/credits` is free.
- `POST /company/identify` is free; by domain one match, by name up to 25, often tied at confidence 1.
- `POST /person/search` fields are `basic_profile.*` (not `basic_info.*`); the profile URL is
  `social_handles.professional_network_identifier.profile_url`; filter by `experience.employment_details.current.company_id`
  but select `experience.employment_details.current.crustdata_company_id`. Filter leaves use `type`, not `op`.
- `POST /watch/person` takes `professional_network_profile_urls` or `business_emails`, not person ids.
- `funding.total_funding_usd` is not a trackable field; `funding.last_fundraise_date`, `funding.last_round_amount_usd`
  and `basic_info.status` are.
- Watch run summaries carry `records_download.url` (signed NDJSON; the docs describe `payload_delivery.url`, read
  first); the first run is a baseline with `changes: []`. Only `new_records_count === 0` means nothing to read.
- `keys` on an `added` track: accepted on `news` (`article_url`) and the person's `experience.employment_details`;
  rejected on `funding.acquisitions`. Flat entries match on either one; use nested entries for a composite identity
  (`[["crustdata_company_id", "title"], ["name", "title"]]`). `ensureWatches` replaces a watcher whose track differs.
- Web Fetch results can come back in another order: match by `url`.
- The job postings index lags for many startups (newest postings months old in Oct 2026), so hiring is read from
  careers pages; the index is a fallback only with 3+ postings in 60 days.
- Some company records count people from same-name companies (a 11-50 company showed 11,373 people);
  `sizeMismatch` warns.

## Writing style for anything user-facing

No em or en dashes: use commas, colons, full stops or brackets. Write "profile URL" for a link to a person's profile,
and never say where Crustdata gets its data. Figures: "60M+ companies", "1B+ people". Prices in credits, never in
dollars (a round size in an example is fine). Match the plain style of the other folders in crustdata/tools.
Fixtures use made-up companies and people with obviously fake profile slugs.
