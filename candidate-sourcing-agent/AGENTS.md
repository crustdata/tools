# AGENTS.md

Guide for AI coding agents working in this repository. People should start with [README.md](README.md).

## What this is

A TypeScript command line tool with no server and no database. `npm run source -- --role "..."` turns a plain-English role into one Crustdata person search (semantic ranking inside hard filters), scores every candidate with rules, and writes `out/<role>/candidates.csv`, `shortlist.md`, `seen.csv`, `role.json` and `profiles.json`. Running it again fetches the next batch, excluding everyone in `seen.csv`. `--dry-run` stops before anything is billed. `npm run contacts` looks up personal emails for the top candidates when the account has contact data. `npm run forget` removes one person from every role's files. `npm run watch-example` (in `examples/`) writes a Crustdata watcher request and sends nothing.

## Commands

```bash
npm install
npm test                                     # node:test, offline: no network, no API key
npm run typecheck                            # tsc --noEmit
npm run replay -- fixtures/ml-engineer.json  # the whole run offline from saved responses
npm run source -- --role "..." --dry-run     # needs CRUSTDATA_API_KEY; free: the plan and the cost
npm run source -- --role "..." --yes         # spends credits; --yes is required without a terminal above 30 credits
npm run rescore                              # free: re-scores out/<role>/profiles.json
```

## Before you run anything that calls Crustdata

- `npm run setup` is interactive (it asks for keys). Do not run it as an agent: set `CRUSTDATA_API_KEY` in the environment or in `.env` (copy `.env.example`) instead.
- Run `npm run source -- ... --dry-run` first and read the `cost:` line. It is free.
- A run over 30 credits needs `--yes` when there is no terminal, and `npm run contacts` always needs `--yes` in a script. Do not add `--yes` to spend money the user has not agreed to.
- To answer "how do I source X" for a user, give them the `--dry-run` command first, for example:
  `npm run source -- --role "Senior backend engineer, Go, 5+ years, Berlin" --must "Go" --limit 50 --dry-run`

## After every change

Run `npm test` and `npm run typecheck` after every change; both must pass. Use `npm run replay` to see a change end to end without a key. Before a real `source` run, run it with `--dry-run` and read the cost line. Never create a watcher against a real key (`POST /watch/...`) unless asked; if you create one to test, cancel it (`DELETE /watch/person/search/<id>`). Never print or commit a key, and never commit `out/` (it holds personal data).

## Tests

| File | Covers |
|---|---|
| `test/role.test.ts` | the sentence parser, flags, protected words, filters, the cost estimate, role folder names |
| `test/score.test.ts` | `scoreCandidate`, title matching, years worked, tenure, main role |
| `test/seen.test.ts` | profile URL normalising, seen lists, `--skip-from` files, CSV writing, the lock (two processes) |
| `test/source.test.ts` | whole runs against `fakeFetch`: next batch, failures mid-run, dry run, spend refusal, contacts, forget, watcher body, AI facts |

Recipes for the common changes (a score row, a city, a filter, a column) are in [docs/customize.md](docs/customize.md).

## Where things are

| To change | Edit |
|---|---|
| A Crustdata request, or add an endpoint | `src/crustdata.ts`, the only file in `src/` that calls Crustdata |
| How a sentence becomes filters and skills | `parseSentence` and its tables (`COUNTRY_WORDS`, `US_STATES`, `CITIES`, `SIZE_WORDS`, `YEAR_RULES`) in `src/role.ts`; add a case to `test/role.test.ts` |
| A flag | `FLAGS`, `CLEARABLE`, `SPEC_SWITCHES`, `RUN_SWITCHES`, `LIST_FIELDS` and `FLAG_HELP` in `src/role.ts`; `SENTENCE_FIELDS` if a new sentence should reset it; the flags table in `docs/reference.md`. `contacts` and `watch-example` parse their own few flags |
| Which filters exist and their round | `buildConditions` in `src/role.ts`. A new filter needs its round, a label, the flag that clears it, and its premium `groups` (they drive the cost estimate); add a test in `test/role.test.ts` |
| Words never searched on (age, gender, origin, ...) | `PROTECTED` and `stripProtected` in `src/role.ts`. Never add a filter or score row on a protected characteristic or an obvious proxy for one |
| The cost estimate | `LIST_PRICE`, `pricesFrom` (the account's own prices from `/account/endpoints`), `estimateCost` in `src/role.ts` |
| How candidates are scored | `WEIGHTS` and `scoreCandidate` in `src/score.ts`; the scoring table in `README.md` |
| Reading a person record (main role, years worked, tenure) | `src/profile.ts` |
| The seen list and URL normalising | `src/seen.ts` (`addToSeen` takes a lock file, merges and refuses files it did not write; `--skip-from` files are read only) |
| Removing a person | `src/forget.ts` |
| CSV columns and the shortlist | `CANDIDATE_HEADER`, `candidateRows`, `shortlistMarkdown` in `src/output.ts` |
| The run itself (rounds, guards, messages) | `runSource`, `stopEmpty`, `tooFew` in `src/source.ts` |
| Contacts | `src/contacts.ts` (`contactAccess` decides from `/account/endpoints`) |
| The watcher request | `watchBody` in `examples/watch-role.ts` |
| The optional AI sentence | `src/ai.ts` (`factsFor` is everything the model sees) |
| A setting | `src/config.ts`, `.env.example` and the Settings table in `docs/reference.md` together |
| Offline answers | `src/fake-api.ts` and `fixtures/*.json`. `faults`, `pageSize`, `creditsPerResult` and `endpoints` in a fixture simulate failures, cursor pages, billing and plan gates |

## Facts about the Crustdata API this code relies on (checked live, 2026-10-21)

- Base URL `https://api.crustdata.com`. Every request sends `authorization: Bearer <key>` and `x-api-version: 2025-11-01`. The `x-credits-used` response header is the charge; `GET /account/usage/events/{x-request-id}` itemises it.
- `POST /person/search` with `search: { query, mode: "hybrid" }` and top-level `mode: "exact"`: the filters are hard constraints and `total_count` is the filter count. Without `mode: "exact"` (the default `managed`), the query adds people outside the filters and `total_count` is the size of the whole population searched. Do not send `sorts` with a query. Profiles at the top of the list (up to 200) carry `fit`: `strong`, `possible` or `weak`; the rest `null`. `limit` is 1 to 1,000 per page; keep filters, query and mode identical across cursor pages.
- `search.query_syntax: "boolean"` works only with `search.mode: "lexical"` and `mode: "exact"`.
- `has_all` is rejected on `skills.professional_network_skills` (not a nested field). Use one `=` leaf per skill in an `and`.
- Some skills are stored only under longer names: "Go" is not a stored skill, but "Golang", "Go (Golang)", "Go Programming Language" and "Go (Programming Language)" are (checked live 2026-10-22). `validateSpec` looks these spellings up with autocomplete and `buildConditions` sends an `or` of them (`skillVariants` in the spec).
- Filter operators: `=`, `!=`, `<`, `=<`, `>`, `=>`, `in`, `not_in`, `(.)`, `[.]`, `is_null`, `geo_distance`. Never `>=` or `<=`. `geo_distance` on `professional_network.location.raw` takes `{ location, distance, unit: "km" }`; `basic_profile.location.country` takes full country names ("United States").
- Stored values (skills, countries, states, schools, past employer names) come from `POST /person/search/autocomplete`, free, 300 a minute. A wrong value returns nobody without an error. Employer size is the closed set `myself only, 2-10, 11-50, 51-200, 201-500, 501-1000, 1001-5000, 5001-10000, 10001+`.
- `years_of_experience_raw` filters but is not returned, and is not a premium group. `assessment.authenticity.tier` (0 most trusted, 9 least) filters for free; some profiles have no tier.
- `post_processing.exclude_profiles` (profile URLs) removes people before billing; it matches http or https, with or without `www.`, any case, with a trailing slash. Very long lists are sent in part (`MAX_EXCLUDE` in `src/source.ts`).
- The place filters (`basic_profile.location.*`, `geo_distance` on `professional_network.location.raw`) and `years_of_experience_raw` are not premium groups (checked on the itemised bill).
- `professional_network.open_to_cards in ["CAREER_INTEREST"]` means open to new roles. The code checks it with a second search on `crustdata_person_id in [...]`, billed only for the people who are open.
- `explain: true` explains an empty result for free, only on a filters-only request (no `search` block): `remarks[]` with `code: "condition_eliminates_all"`, `path: "filters.conditions[i]"`, `matches_without`.
- A field group the key may not read fails the whole search with 403 `Access denied to fields: x`; `searchPeople` drops it and asks for the same page again. `dev_platform_profiles` can be filtered on but is never returned by search.
- `GET /account/endpoints` gives, per endpoint, `status`, enabled `fields`, `base_credits`, `premium_filters` and `premium_fields` with this account's prices; the estimate uses them.
- Billed requests are not retried after a timeout, a reset connection or a 5xx other than 502 and 503, because they may already have been billed. Every billed page is saved (seen list and profiles) before the next request.
- `POST /person/contact/enrich` takes up to 25 `professional_network_profile_urls` and `fields` (`contact.personal_emails` 2 credits, `contact.business_emails` 1, `contact.phone_numbers` 2, per person found; no base credit). Not found and redacted cost nothing and do not fail the batch. 15 a minute. Self-serve keys do not have it; `GET /account/endpoints` lists it with its enabled fields when the account does.
- Person discovery watchers (`POST /watch/person/search`) take `filters` but no `search` query; the first run is a free baseline; after that they deliver people new or refreshed since the last run (so people already sourced can come again), 0.5 credits each. Checked live: the body `watchBody` writes is accepted (201).
- List prices for person search, per result: 0.03 base; experience, education, skills 0.1 each to filter and 0.1 each to return; professional network 0.2; research records 0.4 (only when present); code profile filter 0.8.

Docs: https://docs.crustdata.com (append `.md` to any docs URL for markdown, or start at https://docs.crustdata.com/llms.txt).

## Conventions

- Node 22.13+, ESM, TypeScript run with `tsx`. No build step. Relative imports use the `.js` suffix.
- No native dependencies, no database. Tests are `node:test` and never touch the network: they install `fakeFetch` from `src/fake-api.ts`.
- Keep pure logic (`parseSentence`, `buildConditions`, `estimateCost`, `scoreCandidate`, `yearsWorked`, `primaryRole`, `normalizeProfileUrl`, `csvCell`, `parseCsv`, `contactAccess`, `watchBody`) free of I/O.
- Fixtures hold made-up people and companies only (`.example` domains, `example-` profile slugs). Never paste a real person into a fixture or a doc.
- User-facing text has no em or en dashes. Say "profile URL", not the name of any social network.
