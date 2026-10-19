# AGENTS.md

Guide for AI coding agents working in this repository. People should start with [README.md](README.md).

## What this is

A TypeScript CLI with no server. `npm run find` turns a plain-English ICP into Crustdata company and person searches and writes `out/accounts.csv`, `out/people.csv` and `out/icp.json`. `npm run watch-example` (in `examples/`) writes the Crustdata watcher request for that shortlist and prints the curl; it sends nothing. Watching is done by Crustdata: the user creates the watcher, and Crustdata delivers changes to Slack, Google Chat, email or a webhook.

## Commands

```bash
npm install
npm test                                            # unit tests, no network, no API key needed
npm run typecheck                                   # tsc --noEmit
npm run find -- --icp "..."                         # needs CRUSTDATA_API_KEY; spends credits
npm run watch-example -- --slack <url>              # after find; no key, sends nothing
```

Run `npm test` and `npm run typecheck` after every change. Both must pass. Never create a watcher against a real key (`POST /watch/...`) unless asked: watchers bill until cancelled. `npm run find` refuses to re-run an unchanged search unless `--force` is passed, and runs the staged rounds only for a new sentence or with `--explain`.

## Where things are

| To change | Edit |
|---|---|
| A Crustdata request, or add an endpoint | `src/crustdata.ts`, the only file in `src/` that calls Crustdata |
| How a sentence becomes filters | `parseSentence` in `src/icp.ts` (pure; add a case to `test/icp.test.ts`) |
| A flag | `FLAGS` and `CLEARABLE` in `src/icp.ts`, the flags table in `README.md` |
| Where the CSVs and the saved ICP go | `OUT_DIR`, `icpPath` in `src/config.ts` |
| The search rounds | `buildRounds` and `whyDropped` in `src/icp.ts`; the log in `src/find.ts` |
| Who counts as a buyer, and their order | `peopleFilters`, `titleVariants`, `titleIndex`, `isSideRole`, `personRank` in `src/icp.ts` (the connections floor is the optional `minConnections`) |
| What a sentence can say, and the notes it prints | the `SIZES`, stage, `COUNTRY_NAMES`, `US_STATES` and `METROS` tables and `sentenceWarnings` in `src/icp.ts` |
| The cost estimate printed before a run | `estimateCost` in `src/icp.ts` |
| The watcher request (what is tracked, channels, caps) | `companyWatchBody`, `jobWatchBody` in `examples/watch-accounts.ts`; `docs/watch-accounts.md` |
| A setting | `src/config.ts`, `.env.example` and the Configuration table in `README.md` together |
| A CLI command | `src/cli.ts`, then add an npm script in `package.json` |

## Facts about the Crustdata API this code relies on

- Base URL `https://api.crustdata.com`. Every request sends `authorization: Bearer <key>` and `x-api-version: 2025-11-01`.
- Autocomplete is `POST /company/search/autocomplete` and `POST /person/search/autocomplete`, free. Categorical filter values are closed sets; a wrong value returns zero rows without an error.
- Filter operators: `=`, `!=`, `<`, `=<`, `>`, `=>`, `in`, `not_in`, `(.)` (all words, typo tolerant), `[.]` (exact phrase). Never `>=` or `<=`.
- Ranked company search (`search: { query, mode: "hybrid" }`) returns at most 100 per page and 1,000 in total; `total_count` is always null; cursors expire 20 minutes after the first page; `sorts` is not allowed.
- Person search: filter on `experience.employment_details.current.company_id`, read it back at `current[].crustdata_company_id`. The profile URL is at `social_handles.professional_network_identifier.profile_url`. Requesting `professional_network.followers` fails the whole call with 403. A title filter (and a negation) tests every current role a person holds, which is why the title of the role at the account is checked again in code and side roles are dropped there. The result limit is per request, not per company, so requests go out ten companies at a time and a full request is followed by one request per empty company.
- Company search place filters: `locations.country` (ISO-3 or full name), `locations.state` (full US state name), and `geo_distance` on `locations.headquarters` with `{ location, distance, unit }`. `funding.investors in [...]` takes exact investor names; autocomplete does not return them. `funding.last_round_type` includes `private_equity`. `technographics.technologies.name in [...]` is filter-only (1 credit per result at list price); its autocomplete field is `technology`.
- Search pricing: 0.03 per result, plus premium groups (headcount, funding, taxonomy, experience, connections) for each one filtered on or returned. `GET /account/usage/events/{x-request-id}` itemises what a request was billed for. `GET /account/endpoints` has the account's own rates.
- Watchers (used only in `examples/` and docs): the company watcher is an entity watch at `POST /watch/company` (`entities`, `config`, `notifications` can be PATCHed, `track` and `fields` cannot; a config PATCH must repeat `trigger`; 5 credits per changed company). Job and post watchers are discovery watches at `/watch/job/search` and `/watch/social_post/search`, filters fixed at creation, 0.5 credits per new job, 2 per new post. `notifications` takes `slack` (`webhook_url`), `google_chat` (`url`), `email` (`to`) or `webhook` (`url`). `POST /watch/company/test` with `{ track, fields, deliver: false }` previews a company watcher for free without creating it.
- A post watcher can filter on the author's current employer with the person field `experience.employment_details.current.company_id` (joined through the author). Post search cannot.
- `/company/search` returns `locations.country` as an ISO-3 code ("USA"), although the docs say full name. Company `news` can include roundups and namesakes, so a news alert from the watcher is not always about the account.

Docs: https://docs.crustdata.com (append `.md` to any docs URL for markdown, or start at https://docs.crustdata.com/llms.txt).

## Conventions

- Node 22.13+, ESM, TypeScript run with `tsx`. No build step. Relative imports use the `.js` suffix.
- No native dependencies and no database. Tests are `node:test`.
- Keep pure logic (`parseSentence`, `buildRounds`, `titleIndex`, `csvCell`, `parseCsv`, `companyWatchBody`, `jobWatchBody`) free of I/O so it stays testable.
- Never log or commit secrets. Configuration lives only in environment variables.
- User-facing text has no em or en dashes. Say "profile URL", not the name of any social network.
