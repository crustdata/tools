# Customize Candidate Verification Agent

The common changes, with the exact place to make them. Run `npm test` and `npm run typecheck` after each one,
and `npm run replay -- fixtures/mixed-list.json` to see it end to end.

## Read another ATS's export

Add its column names (lowercase) to `COLUMN_ALIASES` in `src/input.ts`: `profileUrl`, `email`, `name`,
`firstName`, `lastName` or `job`. A profile URL anywhere in a row is found even without this; aliases make the
choice of column explicit and pick up the right email and name. Put a sample with made-up people in
`examples/` and add a case to the loop in `test/input.test.ts`.

## Change the review order

`VERDICTS` in `src/verdict.ts` sets each verdict's `order` (1 is reviewed first) and label; `SECTIONS` groups the
orders into the report's groups (Review first 1 to 2, Clarify in the screen 3 to 4, Ask in the first call 5 to 6,
Not checked 7, Holds up 8 to 9, Low-risk profile score 10). `reviewOrder` keeps quick-screen scores out of Review first (`QUICK_LOW_ORDER`) and
moves date conflicts and name differences to `QUESTION_ORDER` (6) at most. Update the group table in `README.md` with it.

## Add or rename a column

`ADDED_COLUMNS` and `resultCells` in `src/output.ts`, kept in the same order. Your own columns always come
first, unchanged; a clash gets a `cv_` prefix (`addedHeader`).

## Tighten or loosen the date check

`src/dates.ts`: `FULL_TIME_DEGREE` (degrees that count), `NOT_FULL_TIME_DEGREE` (ones that never do),
`STUDENT_FRIENDLY_JOB` (jobs that never count) and the six-month threshold in `dateConflicts`. Every rule has a
case in `test/verdict.test.ts`. Keep it careful: a wrong flag puts a real person at the top of the list.

## Change the Slack message

`summaryMessage` in `src/slack.ts`. Escape anything from a profile or a file with `esc`, keep each section
under 3,000 characters and the message under 50 blocks (`test/misc.test.ts` checks both).

## Post to Microsoft Teams or email instead

`postToSlack` in `src/slack.ts` is the only delivery code. Write a function that takes the same rows (or
`report.md`) and call it next to `postToSlack` at the end of `runVerify` in `src/verify.ts`.

## Change what the AI writes

`LINE_SYSTEM` and `REPORT_SYSTEM` in `src/ai.ts`; `factsFor` is everything the model sees about a person.
Keep names and profile URLs out of it. Set `ANTHROPIC_MODEL` to use another model.

## Get results by webhook instead of polling

`POST /batch/person/verify` also takes `webhook_url`: Crustdata posts to it with the download link when the
job finishes. That needs a public https server; this tool polls instead so it runs on a laptop. To switch, add
`webhook_url` in `submitVerify` (`src/crustdata.ts`) and read the posted link where `runJobs` reads
`download_url`.

## Check a list every week

Put the export in a folder only the hiring team can read and run `npm run verify -- <file> --yes` from cron or a
scheduled CI job. Add `--yes` only together with `MAX_CREDITS_PER_RUN` in `.env`, so a larger file than usual
stops instead of spending. People checked in the last `REUSE_VERDICTS_DAYS` days are free, so only new candidates
are charged. Add `npm run purge -- --older-than 90` to the same schedule to keep a retention period (it keeps a list
whose job is still running, so purge never makes the next run pay again).
