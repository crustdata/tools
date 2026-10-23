# AGENTS.md

Guide for AI coding agents working in this folder. People should start with [README.md](README.md).

## What this is

An open-source CSV enrichment tool (a self-hosted alternative to Clay and fire-enrich) in TypeScript, Next.js App Router. A CSV of work emails, company domains or profile URLs goes in; person and company columns come out, filled from three Crustdata endpoints: `/company/identify` (free), `/company/enrich` and `/person/enrich`, plus `/person/search` for find-people. One engine in `lib/` serves the web page, the JSON API (`/api/enrich`) and the CLI (`scripts/enrich.ts`). No LLM, no database, no accounts.

## Commands

```bash
npm install
npm test                                    # offline tests on fixtures; no key, no network
npm run typecheck                           # tsc --noEmit
npm run replay -- fixtures/emails.json      # the engine against a fake Crustdata, prints the table
npm run enrich -- leads.csv --dry-run       # needs CRUSTDATA_API_KEY; the plan and the estimate, no calls
npm run dev                                 # web app on port 3218
```

Run `npm test` and `npm run typecheck` after every change. Both must pass.

## Where things are

| To change | Edit |
|---|---|
| A column (add one, rename, change its field) | `lib/columns.ts`: one entry in `COLUMNS`, then a line in `test/columns.test.ts` and the README table |
| How a row's identifier is read (CRM header names, pasted lists) | `lib/csv.ts` (`COLUMN_ALIASES`, `readCsv`, `readList`) |
| Normalisation of emails, domains, profile URLs, names | `lib/normalize.ts`; the personal email providers in `lib/personal-domains.ts` |
| Which calls a run makes and the estimate | `lib/plan.ts` (pure; fixtures in `test/plan.test.ts`) |
| The run itself: batches, cache, events, the employer fallback (with its lazy person lookup), name and domain matching | `lib/run.ts` (`pickDomainMatch`, `pickNameMatch`); platform hosts in `lib/personal-domains.ts` |
| The row rule (matched, partly, unresolved) shared by the summary, the bar and the files | `lib/export.ts` (`outcome`, `rowStatusText`) |
| Memoised account reads, per-key caches, caps, the address limit | `lib/http.ts` |
| A Crustdata request, retries, rate limits, malformed-email recovery | `lib/crustdata.ts`, the only file that calls Crustdata |
| Prices, rate limits and access read from the account | `lib/account.ts` |
| The cache | `lib/cache.ts` (memory, web) and `lib/cache-sqlite.ts` (CLI) |
| The exported CSVs | `lib/export.ts` |
| The events the page, the CLI and replay share | `lib/events.ts` |
| Keys from headers, caps, pricing policy, error responses | `lib/http.ts` |
| The API routes | `app/api/enrich`, `app/api/columns`, `app/api/check` |
| The page and its three states | `app/page.tsx`; pieces in `components/` |
| The sample buttons' stored results | `public/samples/*.csv` and `results.json`, regenerated with `npm run samples` (needs a key) |
| A setting | the code, `.env.example` and the Configuration table in `README.md` together |

## Rules for copy (UI strings, README, comments shown to people)

- No em dashes or en dashes. Use a comma, a colon, a full stop or parentheses.
- Never use the words "honestly", "noise" or "stale".
- Never name a social network as the source of the data. Write "profile URL". (A CSV header alias may contain the network's name so CRM exports import.)
- Crustdata figures: 1B+ profiles, 60M+ companies. No prices in dollars; credits are fine.
- Fixtures and samples: invented people and `example` domains in fixtures; the sample CSVs hold real public companies and five Crustdata founders and team members who are already public; never add a colleague's address without asking.

## Facts about the Crustdata API this code relies on (verified live 2026-10-21)

- Base URL `https://api.crustdata.com`; headers `authorization: Bearer <key>` and `x-api-version: 2025-11-01`. Credits used come back in `x-credits-used`.
- `/company/identify` is free, takes `domains` or `names` (25 per call, 30 a minute) and returns `crustdata_company_id`, `basic_info` (name, primary_domain, all_domains, website, description, year_founded, employee_count_range, industries), `headcount.total` and `locations`. Those fields are the free columns.
- A domain lookup can return companies hosted on a platform domain with `confidence_score` 1.0. `pickDomainMatch` accepts a match only when its own domains include the one asked for, or the asked domain is a subdomain of the record's own domain (never of a platform host or a public suffix).
- A name lookup returns many namesakes at 1.0. `pickNameMatch` accepts one exact name (compared without case, punctuation or a trailing legal suffix), or the largest when it is at least three times the next; otherwise `ambiguous`. A result with no exact name is never accepted.
- `/company/enrich` `{ crustdata_company_ids, fields }`: 2 credits per company, `technographics` +2 when returned. A group the key cannot read fails the whole call with 400 `Invalid fields: x`; the client drops it and retries. Growth keys are `mom, qoq, six_months, yoy, two_years`. `hiring.openings_growth_percent` values are fractions (0.4 = 40%).
- `/person/enrich` takes `professional_network_profile_urls` or `business_emails` (25 per call, 15 a minute): 1 credit per `matched`, `not_found` and `redacted` are free. Personal addresses can match too. One malformed address fails the whole batch with 400 `Invalid business emails: a, b`; the client pulls those out and retries. Results are matched to inputs by `matched_on`, never by position; a 5xx on a paid call is not retried (it may have been billed).
- `contact.business_emails` is a premium field on `/person/enrich` (+1 per person with an email) listed in `/account/endpoints` only when contact data is enabled on the account; self-serve keys do not have it.
- `/account/endpoints` carries `base_credits`, `premium_fields` and `effective_rate_limit_rpm` per path; the planner prices from it and falls back to list prices.
