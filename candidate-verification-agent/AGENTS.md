# AGENTS.md

Guide for AI coding agents working in this folder. People should start with [README.md](README.md).

## What this is

A TypeScript command line tool with no server and no database. `npm run verify -- <file>` reads a candidate list (CSV or .xlsx from an ATS), finds each candidate's profile URL (looking up emails with Person Identify when there is none), reads each profile with Person Enrich, sends the profiles to Crustdata's Batch Person Verification in jobs of 10 (at most 5 at once), and writes `out/<list>/verified.csv` (the input file with new columns, doubtful first), `report.md`, `unresolved.csv` and `results.json`. Without the verification add-on it runs the quick screen: the `assessment.authenticity` verdict from Person Enrich plus a date check. Progress is saved in `out/<list>/state.json` after every step, and results in `out/checked.json` for reuse across lists.

## Commands

```bash
npm install
npm test                                       # node:test, offline: no network, no API key
npm run typecheck                              # tsc --noEmit
npm run replay -- fixtures/mixed-list.json     # offline: full check, every verdict
npm run replay -- fixtures/quick-screen.json   # offline: no add-on, Greenhouse .xlsx
npm run verify -- <file> --dry-run             # needs the key; free: plan and most it costs
npm run verify -- <file> --limit 3 --yes       # spends credits
```

## Before you run anything that calls Crustdata

- `npm run setup` is interactive. Do not run it as an agent: set `CRUSTDATA_API_KEY` in the environment or in `.env` (copy `.env.example`).
- Run `--dry-run` first and read the `Total:` line. It is free (one call to `/account/endpoints`).
- A run that may spend more than `CONFIRM_ABOVE_CREDITS` (50) needs `--yes` without a terminal. Do not add `--yes` to spend credits the user has not agreed to. The full check is 10 credits per verdict.
- Never put a real person in a fixture, an example or a doc. Use made-up names, `example-` profile slugs and `.example` domains.

## After every change

Run `npm test` and `npm run typecheck`; both must pass. Run both replays to see the change end to end. Add a test for every behaviour change. Never commit `out/` or `.env` (personal data, keys).

## Tests

| File | Covers |
|---|---|
| `test/input.test.ts` | profile URL normalising and finding, the CSV reader, each ATS export in `examples/`, wrong files |
| `test/verdict.test.ts` | the date check, review order and sorting, full and quick results, the results file parser, download URL checks, capabilities |
| `test/run.test.ts` | whole runs against `fakeFetch`: full check, reuse across lists, dry run, quick screen, missing access, resume of running jobs, failed jobs, 73 people in 8 jobs, every billing path (lost answers before and after the job exists, a colleague's job, a crash mid-submit, other lists' running jobs, an unreadable state file), spend guards, plain errors, Slack, forget, purge, email and name matching, flags |
| `test/misc.test.ts` | `.env` writing, CSV formula safety, Slack URL check and limits, the reuse rule, forget on report.md |

## Where things are

| To change | Edit |
|---|---|
| A Crustdata request, or add an endpoint | `src/crustdata.ts`, the only file in `src/` that calls Crustdata |
| The run (steps, messages, guards) | `runVerify` in `src/verify.ts`; the job scheduler is `runJobs` |
| Flags | `parseFlags` and `HELP` in `src/verify.ts`; the options table in `docs/reference.md` |
| Column names an export uses | `COLUMN_ALIASES` in `src/input.ts` (lowercase, spaces squeezed); `NOT_CANDIDATE` lists columns about other people (referrer, owner, recruiter) that are never read for the candidate; `withHeader` finds the header row; add a sample to `examples/` and a case to `test/input.test.ts` |
| Reading .xlsx | `src/xlsx.ts` (every sheet, shared strings, inline strings, hyperlinks); `readTable` in `src/input.ts` picks the sheet with the most profile-URL rows, or `--sheet` |
| Profile URL rules | `normalizeProfileUrl`, `findProfileUrls` in `src/profile-url.ts` |
| Verdict labels, review order and groups | `VERDICTS`, `QUICK_LABELS`, `SECTIONS`, `reviewOrder`, `sortForReview` in `src/verdict.ts`; the group table in `README.md`. Quick-screen scores, date conflicts and name differences must never reach Review first (orders 1 and 2) |
| Name checks | `namesDiffer` in `src/verdict.ts`; used for profile names (`nameMismatch`) and email matches in `src/verify.ts` |
| Removing data | `runForget` (profile URL or email; rebuilds report.md from results.json) and `runPurge` in `src/forget.ts` |
| Spend guards | `CONFIRM_ABOVE_CREDITS`, `MAX_CREDITS_PER_RUN` (`config.maxCredits`) in `src/verify.ts`; the npm option guard is `NPM_SWALLOWED` in `parseFlags` |
| The one-line summary and reasons | `summaryLine`, `reasonsText`, `FLAG_TEXT` in `src/verdict.ts` |
| The date check | `dateConflicts` and its word lists in `src/dates.ts`; cases in `test/verdict.test.ts` |
| Output columns and the report | `ADDED_COLUMNS`, `resultCells`, `verifiedCsv`, `reportMarkdown` in `src/output.ts` |
| The Slack message | `summaryMessage` in `src/slack.ts` |
| The optional AI step | `src/ai.ts` (`factsFor` is everything the model sees) |
| A setting | `src/config.ts`, `.env.example` and the Configuration table in `README.md` together |
| Offline answers | `src/fake-api.ts` and `fixtures/*.json` (`access`, `polls`, `failJobs`, `faults` simulate plan gates, slow jobs and failures) |

## Facts about the Crustdata API this code relies on (checked live, 2026-11-11)

- Base URL `https://api.crustdata.com`, headers `authorization: Bearer <key>` and `x-api-version: 2025-11-01` (not needed on `GET /batch/{id}` and `GET /batch/`). The `x-credits-used` response header is the charge for that request.
- `POST /batch/person/verify` with `{ professional_network_profile_urls: [...] }`, up to 10. Answers at once `{ batch_id, status: "pending", status_url }` with 0 credits; verdicts are billed (10 each) when the job finishes, so they never show in `x-credits-used`. Without the add-on: 403 `permission_error`, 0 credits, and `/account/endpoints` lists it `"status": "disabled"`. An empty list is 400 "Exactly one identifier must be provided: professional_network_profile_urls or business_emails".
- At most 5 active batch jobs per account (a sixth submit is 429) and 5 submissions a minute. A failed job is not charged.
- `GET /batch/{id}`: `pending`, `processing`, then `completed` with `result_count`, `entities_fulfilled`, `download_url` (presigned S3 on `crustdata-batch-api-data.s3.amazonaws.com`, valid 5 days; a new one on every poll) or `failed` with `error_message`. With `result_count: 0` the link may 404: do not download.
- Results file: gzipped JSON lines `{ original_identifier, internal_id, data }`. People with no verdict are left out (and free). `data`: `verdict` (7 values), `confidence`, `reasoning`, `flags`, `coverage { social_ran, posts_fetched, posts_checked, engagers_seen, engagers_resolved, coworker_hits, timeline_flags, flags }`, `citations [{ url, title, cited_text }]`. Checked live on 2026-11-11: a job of 3 profile URLs finished in under 2 minutes, 2 verdicts in the file (the third, a profile that does not exist, was left out and not billed), `confidence` 0.75 and 0.60 for `probably_genuine`, `flags` empty, `coverage` with every count, `citations` with `url`, `title`, `cited_text`. The `reasoning` text is long (a paragraph) and can mention older roles and namesakes.
- `POST /person/enrich`: 25 profile URLs per call, 15 calls a minute, 1 credit per person found, not found free. `fields: ["assessment"]` returns `assessment.authenticity { verdict, tier }` (tier 0 most trusted to 9) at no extra cost; a key without that field permission gets 403 "Access denied to fields: assessment". Education has `start_year`/`end_year` only; positions have ISO `start_date`/`end_date` and an often empty `employment_type`.
- `POST /person/identify` `{ emails }`: 25 per call, 30 a minute, 1 credit per match, free on a miss, personal emails accepted. One malformed address fails the whole call with 400 `Invalid emails: ...`; the client drops those and sends the rest again.

Docs: https://docs.crustdata.com (append `.md` to any docs URL for markdown, or start at https://docs.crustdata.com/llms.txt).

## Billing invariants (do not break these)

A verification job is billed when it finishes, 10 credits per verdict. A second job for the same people pays twice.

- **`save()` copies the job loop's lists into state first** (`sync` in `runVerify`): `runJobs` replaces `progress.pending` and `progress.jobs` as it goes, so writing `state` without copying would save an old list and a stopped run would pay twice.
- **Record intent before sending.** `runJobs` saves every submission in `state.pending` before calling `submitVerify`, and swaps it for the job id when the answer comes. A run that dies mid-submit leaves the record.
- **Never resend an unclear submission in the same run.** No answer, a timeout, or a 5xx (502 and 503 included, since a gateway error can come after the job was made) holds the batch and the rest of the list. Only 429 is safe to resend at once.
- **The next run asks Crustdata first.** `resolveLostSubmit` reads `GET /batch/` and adopts a job only when its results name only our people; it waits while a same-size job is still running or the list cannot be read, and resends only when no such job exists (or the only ones billed nothing).
- **One person, one running job per output folder.** `jobsOnThisMachine` reads every list under `OUT_DIR` before anything is spent and finds people already running in another list's job, by profile URL and by Crustdata person id (another URL spelling); they are not sent again. Two copies of the tool with different `OUT_DIR`s do not see each other.
- **A list's own progress is kept at least 30 days** whatever `REUSE_VERDICTS_DAYS` says (that setting is reuse across lists), so resuming never pays twice.
- **Short results:** records are counted, not lines; a damaged line keeps the job unread. After 3 runs and 2 days the readable part is used and the rest is reported with the batch id.
- **404s** count only within one run, two minutes apart, with no good answer between.
- **A finished job that cannot be read, or whose file has fewer records than `result_count`, is kept and read again later, never resubmitted and never marked "no verdict".**
- **Adopting a job after a lost answer** needs results that name only our people and either a verdict for every one of them or a creation time within 5 minutes of the submission by Crustdata's clock (`clock.serverOffset`, from each answer's Date header); while any matching job still runs, nothing is adopted.
- **`forget` never edits a running job or a pending submission**: it lists the person in `state.forgotten`, their record is dropped when the job is read (and they leave the job then), a failed job's retry leaves them out, and a one-way fingerprint in `out/forgotten.json` keeps any file that still lists them from checking them again. **`purge` keeps lists with running jobs** unless `--force`. **`--refresh`** clears verdicts but keeps finished job ids, so an old job is never taken for a new one.
- A held submission sent again goes only to the people this run is for (`--limit`).
- **Never replace a state file you cannot read** (`loadState` refuses): it holds paid job ids.
- To test a billing path, use `faults` in a fixture: `{ path: "/batch/person/verify", call: 1, status: 500 }` loses the answer before the job exists; add `after: true` to create the job and then lose the answer; `otherJobs` puts someone else's jobs on the account. `--ai` cost (Anthropic) is not in the credit estimate.

## Conventions

- Node 22.13+, ESM, TypeScript run with `tsx`. No build step. Relative imports use the `.js` suffix.
- No native dependencies, no database. Tests never touch the network: they install `fakeFetch` and a virtual clock (`clock` in `src/crustdata.ts`).
- Keep pure logic free of I/O: `readCandidates`, `parseCsv`, `readXlsx`, `normalizeProfileUrl`, `dateConflicts`, `quickResult`, `fullResult`, `reviewOrder`, `sortForReview`, `summaryLine`, `verifiedCsv`, `reportMarkdown`, `summaryMessage`, `resolveIdentify`, `capabilities`, `parseResults`.
- Never use a profile URL or email from a column about someone else (`NOT_CANDIDATE`), and never use an email match whose profile name differs from the name in the file.
- User-facing text has no em or en dashes. Say "profile URL", not the name of any social network. A verdict is evidence for review, never a decision: do not add wording or features that reject candidates automatically.
