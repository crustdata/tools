# AGENTS.md

Guide for AI coding agents working in this repository. People should start with [README.md](README.md).

## What this is

A TypeScript CLI with no server and no database. `npm run source -- --thesis "..."` turns a plain-English investment thesis into Crustdata searches, scores each company with rules, and writes `out/pipeline.csv`, `out/founders.csv`, `out/pipeline.md` and one markdown memo per company in `out/memos/`, plus `out/data.json`, `out/thesis.json` and `out/history.json` (one history per pipeline key) so memos re-render and re-runs compare for free. Memos of companies that left the pipeline move to `out/memos/gone/`. Paid work is saved to `out/.partial-<id>.json` (one per run key) after every company search page, every batch and every company (a resumed company search asks only for the rest with `crustdata_company_id not_in`), so a failed run resumes without paying twice; `--fresh` ignores it but keeps the history. No LLM is needed; `--ai` with the user's own Anthropic or OpenAI key adds an analysis section per memo. Watching for new companies or changes is done with Crustdata watchers in the Crustdata app; this repo creates no watcher.

## Commands

```bash
npm install
npm test                                            # offline tests, stubbed Crustdata, no key
npm run typecheck                                   # tsc --noEmit
npm run replay -- fixtures/seed-pipeline.json       # whole pipeline on a sample, offline
npm run source -- --thesis "..."                    # needs CRUSTDATA_API_KEY; spends credits
npm run memo -- <domain>                            # free, from out/data.json
```

Run `npm test` and `npm run typecheck` after every change. Both must pass; tests stub `fetch`, set `DSA_NO_DOTENV=1`, `CRUSTDATA_API_KEY=test-key`, `CRUSTDATA_MIN_GAP_MS=0` (no 2.1 s pacing) and `OUT_DIR` to a temp folder, and delete `WATCH_HINT` and the AI key and model variables, so the developer's shell does not change them. `npm run source` refuses to re-run an unchanged search within 20 hours unless `--force` is passed, re-scores saved data for free when only `--founders-from`, `--schools`, `--timing` (or `--ai`) changed, and needs `--yes` over 25 companies when stdin is not a terminal. Never create a Crustdata watcher from code here.

## Where things are

| To change | Edit |
|---|---|
| A Crustdata request, or add an endpoint | `src/crustdata.ts`, the only file that calls Crustdata (retries, 2.1 s pacing per search path) |
| The order of a run | `runSource` in `src/source.ts` |
| How a sentence becomes filters, a flag | `parseSentence`, `FLAGS`, `CLEARABLE` in `src/thesis.ts` (add a case to `test/thesis.test.ts`; for a new flag follow "Add a flag" under Recipes) and the flags table in `README.md` |
| The search rounds, the cost line | `buildRounds`, `fundingFilter`, `estimateCost` in `src/thesis.ts` |
| Who counts as a founder | `FOUNDER_TITLES`, `isFounderTitle`, `pickFounders` in `src/founders.ts` |
| Repeat founders, past employers, schools | `priorFounderRoles`, `employerMatches`, `schoolMatches`, `SCHOOL_ALIASES` in `src/founders.ts` |
| Weights and thresholds | `WEIGHTS` and `LEVELS` in `src/score.ts` (the README scoring table and the FAQ "How do I score and rank startups" too) |
| Timing combined with growth | `DUE_WINDOWS` (per stage) in `src/windows.ts`; `momentum` and `timingOf` in `src/score.ts` |
| What missing data does to a score | `applicablePoints` and `MIN_COVERAGE` in `src/score.ts` |
| Post phrases | `TRACTION_PHRASES`, `RAISE_PHRASES`, `RAISE_ACTIONS`, `RAISE_ROUNDS` in `src/signals.ts` (round news is an exact phrase, or an action and a round together); also sent to the API as `[.]` filters by `postFilters`/`raisePostFilters` in `src/crustdata.ts`; tests in `test/memo.test.ts` |
| Memo layout, the question to ask | `renderMemo`, `pickQuestion` in `src/memo.ts` |
| CSV columns | `PIPELINE_HEADER`, `pipelineRows`, `FOUNDERS_HEADER`, `founderRows` in `src/pipeline.ts` |
| Re-runs (new, still here, back, gone, what changed) | `buildPipeline`, `changeSince`, `updateHistory` in `src/pipeline.ts`; what counts as the same pipeline is `pipelineKey` in `src/thesis.ts` (exclusions and scoring settings do not count) |
| Relative dates in a thesis | saved relative (`foundedWithinYears`, `raisedWithinMonths`) and turned into dates per run by `resolveDates` in `src/thesis.ts` |
| Resuming a failed run | `loadPartial`, `savePartial` in `src/output.ts`; the steps and `progress` marks in `runSource` |
| The AI analysis | the prompt in `prompts/memo-analysis.md`; the call in `src/ai.ts` |
| A setting | `src/config.ts`, `.env.example` and the Configuration table in `README.md` together (test-only: `CRUSTDATA_MIN_GAP_MS` in `src/crustdata.ts` sets the search pacing; tests set it to 0) |

## Facts about the Crustdata API this code relies on (checked live, Oct 2026)

- Base URL `https://api.crustdata.com`; headers `authorization: Bearer <key>` and `x-api-version: 2025-11-01`. `x-credits-used` reports the cost of each call. Paid searches are retried only on 429 and 503 (a 500, 502 or 504 may already have been billed); other calls also on 5xx.
- Filter operators: `=`, `!=`, `<`, `=<`, `>`, `=>`, `in`, `not_in`, `is_null` (with `"value": null`), `(.)` (all words, typo tolerant), `[.]` (exact phrase), and `geo_distance` on `locations.headquarters` with `{ location, distance, unit }`. Never `>=` or `<=`.
- Ranked company search (`search: { query, mode: "hybrid" }`): at most 100 per page and 1,000 in total; `total_count` is always null; cursors expire 20 minutes after the first page. Identical hybrid searches can return different sets (1 in 6 in an Oct 2026 check; lexical and semantic were stable), so re-run diffs (new / gone) can move without a real change.
- `funding.last_round_type` is a closed set (`pre_seed`, `seed`, `series_a`, ...); validate with `/company/search/autocomplete` (free). `funding.last_fundraise_date is_null` finds companies with no disclosed round. `basic_info.year_founded` filters with `=>` and `=<`. `headcount.growth_percent.3m` (and `6m`, `12m`) is filterable. Filter `locations.country` with ISO-3 codes or full names; live responses in Oct 2026 returned ISO-3 ("USA") although the docs say the full name, so do not depend on either form.
- `funding` also returns `contact_email` and `phone_number`. This code never copies them (`toCompany` in `src/pipeline.ts`); a test checks no output contains them.
- `hiring` requested on `/company/search` comes back null, and a null group is not billed. Roles come from `/job/search`: `limit: 0` with `aggregations: [{ type: "group_by", field: "company.basic_info.company_id" }]` is free; listings repeat across job sites, so distinct titles are counted with a per-company `group_by` on `job_details.title` (free). Listings cost 0.03 each.
- Person search returns people whose current roles match the filters; this code checks the title on the role at the company in question again (`pickFounders`), because people hold several current roles (a big-company job, a venture partner seat) and a person can come back under two ids.
- `/social_post/search`: `limit: 0` returns `total_count` for 0 credits; posts are 0.5 each. Filter authors by `actor.actor_type = "person"` and `actor.crustdata_entity_id in [person ids]`. Post search is enabled per account: a key without it gets 403 (`permission_error`), and the run skips that signal for every company; a 403 about credits stops the run like a 402. Company page posts match revenue words as marketing, so only founders' posts are searched. Round phrases must name the round ("closed our seed"): "closed our" alone matched contract wins.
- Search pricing at list price: company 0.03 per result plus 0.2 per premium group filtered on and 0.2 per group returned (headcount, funding, followers, hiring), 0.1 for taxonomy; person 0.03, plus 0.1 to filter on experience, 0.1 to receive it and 0.1 for education (0.33 per founder as this code searches). `GET /account/endpoints` has the account's own rates.
- Watchers (docs only, never called here): a company discovery watch (`POST /watch/company/search`) re-runs filters only, no ranked query; 2 credits per new company after a free baseline sample of 5. A company entity watch (`POST /watch/company`) tracks fields such as `funding.last_round_type changed`, `headcount.total changed`, `hiring.openings_count changed`, `news added`; 5 credits per changed company.

Docs: https://docs.crustdata.com (append `.md` to any docs URL for markdown, or start at https://docs.crustdata.com/llms.txt).

## Recipes for coding agents

- **Tests per module.** `thesis.ts` in `test/thesis.test.ts`; `founders.ts` in `test/founders.test.ts`; `signals.ts` (`matchPhrase`, `toQuote`) and CSV rows in `test/memo.test.ts`; `score.ts` and `windows.ts` in `test/score.test.ts`; `pipeline.ts` (`buildPipeline`, `rescore`, exclusions) in `test/pipeline.test.ts`; `runSource` end to end in `test/source.test.ts`. Tests use `today = 2026-10-21`; each fixture has its own `today`.
- **`test/source.test.ts`** runs in order on one shared `OUT_DIR`, and later tests depend on earlier runs. Add a new test at the end, give it its own `--out join(dir, "name")`, and restore `process.env.OUT_DIR = dir` in `finally` (`--out` overwrites `process.env.OUT_DIR`). The fetch stub is `respond()` at the top of the file.
- **Add a flag.** A value flag: a `ThesisSpec` field and a `FLAGS` entry. An on/off flag: `SWITCHES` and its branch in `parseFlags`. Then `CLEARABLE` (if `none` should clear it), `DEFAULTS`, `describeSpec`, `validateSpec`, the README flags table and a case in `test/thesis.test.ts`. A search filter: `buildRounds` (or `fundingFilter`/`placeFilter`), `whyDropped`, and `costOf` if it filters on a paid group. Set from the sentence too: `SENTENCE_FIELDS`. Score only: `SCORING_FIELDS`, `ScoreSpec` and `scoreDeal` in `src/score.ts`, and the message in `rescoreSaved` (`src/source.ts`). Changes neither the search nor the pipeline (output, counts): add it to the ignore list in `pipelineKey`, or a change resets the history. A filter after the search: `buildPipeline` and `rescore` (`src/pipeline.ts`), the `canRescore` check in `runSource` if loosening it needs companies that were never saved, and the count in `source.ts` and `runReplay` (`commands.ts`).
- **Numbers repeated in docs** (grep them when you change one): `WEIGHTS` (README table and FAQ), `DUE_WINDOWS` (README in three places, `docs/how-it-works.md`, `docs/customize.md`, comments in `score.ts`), `MAX_FOUNDERS` (README sample output), `LEVELS` (README table, `docs/customize.md`), costs (README, `costOf`).
- **CSV.** `pipelineRows`/`founderRows` return raw values; `writeCsv` runs every cell through `csvCell`, so do not escape twice. The `profile URL` column in `pipeline.csv` is the company's; name a new column after whose URL it is. Add columns at the end of a group, do not reorder them: users map columns in their CRM.
- **Post phrases** of 2 to 4 capital letters (MRR, ARR) match only in capitals locally; other phrases match in any case. The API's `[.]` match is case-insensitive, so keep phrases specific.
- **See the effect** of a scoring change with `npm run replay -- fixtures/seed-pipeline.json` before and after (outputs in `out/replay/<fixture>/`).
- **Screenshots** in `assets/` are taken by hand; if a change alters what they show, say so.

## Conventions

- Node 22.13+, ESM, TypeScript run with `tsx`. No build step. Relative imports use the `.js` suffix. No runtime dependency other than `tsx`; the AI call is plain `fetch`.
- Pure logic (`founders.ts`, `signals.ts`, `score.ts`, `windows.ts`, `pipeline.ts`, `memo.ts`, and `thesis.ts` except `loadThesis`, `saveThesis` and `validateSpec`) has no I/O, so `npm run replay` and the tests run the same code as a live run.
- Fixtures use invented companies, people and domains (`.example`). Never put real people or customers in fixtures, docs or examples.
- No contact data in any output. Never log or commit keys.
- Every string from the API goes into markdown through `md()` or `link()` (src/memo.ts), and into CSV through `csvCell` (src/csv.ts); AI output goes through `cleanAnalysis`. A test checks injection in memos.
- A signal that cannot apply to any company is left out of the total (`notScored`); a signal that was skipped for one company because of its rank is scored as zero, so ranks stay consistent.
- User-facing text has no em or en dashes (use a comma, a colon or a full stop). Say "profile URL", not the name of any social network.
