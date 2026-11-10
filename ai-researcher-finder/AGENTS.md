# AGENTS.md

Guide for AI coding agents working in this repository. People should start with [README.md](README.md).

## What this is

A TypeScript command line tool with no server and no database. `npm run find` searches AI labs for research and ML people with Crustdata's semantic people search (one search per lab, company id and a research-title group as hard filters), turns seeds (Google Scholar URLs, GitHub URLs, profile URLs, paper titles) into people, guesses each person's team (stated, inferred, not stated), scores everyone with `rubric.json`, and writes `out/<name>/report.md`, `researchers.csv`, `people.json`, `run.json`, `seeds.json`. `npm run map -- --lab <lab>` is the same for one lab (engineer titles included). Running a search again with `--name` skips everyone already in the folder (unbilled); flags typed then replace the saved ones. `npm run rescore` redoes teams and scores offline. `npm run forget` removes a person everywhere and adds them to `out/suppressed.json`. `npm run watch-example` (in `examples/`) writes a Crustdata watcher request and sends nothing.

## Commands

```bash
npm install
npm test                                      # node:test, offline: no network, no key
npm run typecheck                             # tsc --noEmit
npm run replay -- fixtures/example-labs.json  # the whole run offline, made-up people
npm run find -- --labs frontier --dry-run     # needs CRUSTDATA_API_KEY; free: plan, ceiling
npm run find -- --labs frontier               # spends credits (at most about 21 at list)
npm run rescore                               # free: teams and scores from people.json
```

## Before you run anything that calls Crustdata

- `npm run setup` is interactive (it asks for keys). Do not run it as an agent: set `CRUSTDATA_API_KEY` in the environment or in `.env` (copy `.env.example`).
- Run with `--dry-run` first and read the `cost:` line. It is free. A ceiling above `MAX_CREDITS` (100) refuses to run; do not add `--max-credits` to spend money the user has not agreed to.
- To answer "how do I find AI researchers at X" for a user, give them the `--dry-run` command first, for example `npm run find -- --labs anthropic.com --topic "inference" --dry-run`.

## Map of the code

| File | What it does | Pure? |
|---|---|---|
| `src/cli.ts` | Commands | |
| `src/config.ts` | Settings from the environment and `.env` (skipped under tests) | |
| `src/node-check.ts` | Clear message on Node older than 22.13 | |
| `src/profile.ts` | Reading a person record: roles, papers, h-index, phrase matching (`norm`, `hasPhrase`) | yes |
| `src/csv.ts` | CSV writer (formula guard, BOM) and reader | yes |
| `src/forget.ts` | Removal requests, `out/suppressed.json` | |
| `src/setup.ts` | Guided setup (interactive: do not run as an agent) | `capabilities` is |
| `src/replay.ts` | Offline replay of a fixture | |
| `src/find.ts` | The run: free checks, plan and ceiling, `run.json` before billing, searches, seeds, `Store` (saves after each billed page; suppressed people), `scoreAndWrite` (also on failure), `runRescore`; `searchFilters`, `queryFor`, `RESEARCH_TITLES`, `MAP_TITLES`, `notResearch` | filters and query are |
| `src/crustdata.ts` | The only file that calls Crustdata: retries, plain error messages, `spend` | |
| `src/args.ts` | Flags to a `Spec` (with `typed`, the flags typed this time); `--help` text; folder names; `searchKey` | yes |
| `src/labs.ts` | `FRONTIER_LABS`, `LAB_DISPLAY`, `LAB_EMAIL_DOMAINS`, `parseLabList`, `resolveLabs` (company ids, free) | parsing is |
| `src/seeds.ts` | `classify`, `parseSeeds`, `samePaper` | yes |
| `src/teams.ts` | `statedTeam`, `inferTeam`, `guessTeams`, `labWidePaper`; words in `config/teams.json` | yes |
| `src/rubric.ts` | `parseRubric` (with hints), `applyRule`, `scorePerson` (no-data rules at half, `checkedScore`, `coverage`), `FRONTIER_IDS`, `FRONTIER_NAMES` | yes |
| `src/output.ts` | `report`, `teamMap`, `csvRows` | yes |
| `src/cost.ts` | `pricesFrom`, `estimate`, `LIST_PRICE` | yes |
| `src/ai.ts` | Optional `--ai`: `factsFor`, `askAll` (4 at a time, cache in `ai.json`, stops on a rejected key) | `factsFor` is |
| `src/fake-api.ts` | The fake API used by tests and replay | |
| `examples/watch-people.ts` | The watcher request for job moves | |

## Tests

| File | Covers |
|---|---|
| `test/seeds.test.ts` | Seed kinds, CSV headers, paper title matching |
| `test/teams.test.ts` | Stated, inferred and not stated; headline "previously"; co-authors; lab-wide papers |
| `test/rubric.test.ts` | The shipped rubric, evidence, no data, inferred half points, mistakes in the file |
| `test/args.test.ts` | Flags, lab lists, filters, cost |
| `test/find.test.ts` | End to end on `fixtures/example-labs.json`: full run, second run skips, dry run, cost cap, no Identify, unknown lab, failure part way, rescore, watch example |

## Rules for changes

- After every change: `npm run typecheck` and `npm test`. New behaviour gets a test; new API shapes get a fixture case. Tests must stub every network call (`src/fake-api.ts`) and never read `.env` (they do not: `NODE_TEST_CONTEXT`).
- Never retry a request that may have been billed (only 429 and connections that never opened are retried); save people as soon as a page is billed (`Store.add`).

## Recipes

- **A new rubric kind:** add it to `KINDS` in `src/rubric.ts`, to the numeric list in `parseRubric` if its value is a number, to `ALLOWED` if it takes extra keys, a `case` in `applyRule` (TypeScript flags a missing one), a row in `docs/customize.md`, and a test in `test/rubric.test.ts`.
- **A new seed kind:** add it to the `Seed` union and `classify` in `src/seeds.ts`, the lookup and `viaOf` in `runFind` (`src/find.ts`), the `Plan` and `estimate` in `src/cost.ts`, the seed count list in `scoreAndWrite`, the fake API, and tests.
- **A new team:** an entry in `config/teams.json` (words, and `not` for phrases that must never count); add it to rubric `team` rules if it should score.
- Keep `README.md`, `docs/` and `llms.txt` in step with the code: costs, defaults and limits are quoted there.
- Copy rules for every string: no em or en dashes; never say or imply the data comes from any one website; say "profile URL". Fixtures use made-up people and labs (`example-...` slugs, `.example` domains).
- Never filter or score on age, gender, family status, sexual orientation, national origin, religion, race or disability.

## API facts the code relies on (checked live 2026-10-28)

- `POST /person/search` with `search: { query, mode: "hybrid" }` and top-level `mode: "exact"`: filters stay hard; `fit` tier on the top of the list (up to 200), null below.
- `experience.employment_details.current.company_id` and `.past.company_id` filter by Crustdata company id; roles carry `crustdata_company_id`. Role records do not carry the employer's domain (it comes back null).
- `[.]` is an exact phrase, whole words, any case. `research_profiles.articles.title [.] "<title>"` returns the paper's authors plus people with a longer title containing the phrase.
- `research_profiles` in search: `id`, `profile_url` (Scholar), `research_interests`, `articles[]` (title, url, publication_year as a string), `co_authors[]` (id, name), `citations_count` / `h_index` / `i10_index` (`all`, `recent`). Billed only for people who have one (0.4 list). `profile_url` is not filterable, so Scholar URLs need Identify.
- `POST /person/identify` takes exactly one of `research_profile_urls` (Google Scholar with `user=`), `professional_network_profile_urls`, `emails`; 25 per call; 1 credit per match, free on a miss; rows in request order. Not listed in `/account/endpoints`: probe with a made-up Scholar URL (free).
- `POST /dev_platform/enrich { profile_url }` (or `{ crustdata_person_id }`): 1 credit a call; `crustdata_person_id` null when the GitHub account is not linked.
- `research_profiles.verified_email_domain` filters (`--scholar-email`); Scholar keeps old emails, so it finds people who left too. `anthropic.com` had 103 people, `openai.com` 291.
- Identify rows carry `matched_on`; match on it, never on position.
- `POST /company/identify { domains }` or `{ names }`: free. `deepmind.google` is Google DeepMind; `x.ai` comes back as "SpaceX Super Intelligence"; `meta.com` is all of Meta.
- Person entity watcher: first run is a free baseline; 5 credits per changed person at 30-day refresh. `experience.employment_details.current` `added` with `"keys": ["crustdata_company_id", "name"]` fires on a new employer only, not a promotion.
