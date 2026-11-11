# Candidate Verification Agent reference: options, output files and columns

## npm run verify -- &lt;file&gt; [options]

| Option | What it does |
|---|---|
| `--dry-run` | Prints what would be checked and the most it can cost. One free call; nothing written |
| `--quick` | The quick screen only: Crustdata's profile score and the date check, 1 credit per candidate |
| `--full` | The full check only; stops if the key does not have the verification add-on |
| `--limit <n>` | Check only the first n candidates of the file |
| `--ai` | Claude-written summary per candidate and an overview in report.md (needs `ANTHROPIC_API_KEY`) |
| `--refresh` | Check everyone again, even people with a recent verdict (costs again) |
| `--name <name>` | Folder name under `out/` (default: the file name) |
| `--sheet <name>` | The sheet to read in an Excel file (default: the one with the most candidate rows) |
| `--wait <minutes>` | How long to wait for running jobs before saving and stopping (default 30) |
| `--no-slack` | Skip Slack for this run |
| `--yes` | Do not ask before spending; needed above `CONFIRM_ABOVE_CREDITS` without a terminal |

Without `--quick` or `--full`, the full check runs when the key has it and the quick screen otherwise.

## Output files (out/&lt;list&gt;/)

| File | What is in it |
|---|---|
| `verified.csv` | Your file, every column kept, plus the columns below; every row, doubtful first; rows that could not be checked are kept as "Not checked", and a row that repeats a candidate gets the same verdict. Written with your file's separator |
| `report.md` | Counts, then every candidate grouped as Review first, Clarify in the screen, Ask in the first call, Not checked, Holds up, Low-risk profile score, with reasons and sources |
| `unresolved.csv` | Rows that could not be checked: line number, reason, the row |
| `results.json` | Every result in full (reasoning, flags, coverage, sources), with the row it belongs to; `forget` rebuilds the report from it |
| `state.json` | Progress: email lookups, profile details, job ids. Lets a stopped run continue without paying twice |

`out/checked.json` holds every result by profile URL, reused for `REUSE_VERDICTS_DAYS`. `out/runs.csv` logs each run: when, who (the computer's user name), which file, the check, candidates and credits.

## Columns added to verified.csv

| Column | Meaning |
|---|---|
| `review_rank` | 1 to n: the order to review in |
| `review_group` | The group: Review first, Clarify in the screen, Ask in the first call, Not checked, Holds up, Low-risk profile score |
| `verdict` | Crustdata's verdict (full check), `not_checked`, or for quick-screen rows a score name: `quick_high_risk`, `quick_some_risk`, `quick_no_signal`, `quick_low_risk`, `quick_very_low_risk` (a score, not a finding) |
| `verdict_label` | The verdict in words, plus "dates overlap study" or "name differs from your file" when found |
| `confidence` | 0 to 1, full check only; a fixed band per verdict, so compare only within one verdict |
| `trust_tier` | 0 (most trusted) to 9, quick screen only |
| `summary` | One line: the verdict, the main reason, what the check could see (or the AI summary with `--ai`) |
| `reasons` | The full reasoning, date conflicts, notes |
| `flags` | Flags in plain words (`past_roles_unverified`, `posts_unavailable`, ...) |
| `sources` | "title (url)" for each source, separated by " \| " |
| `check_type` | `full`, `quick` or `none` |
| `checked_name`, `checked_title`, `checked_company` | Who was checked, from the profile |
| `profile_url_checked` | The profile URL used, normalised |
| `checked_at` | Date of the check (an older date means a reused verdict) |

A column of yours with the same name makes ours `cv_<name>`.

## Messages and what to do

| Message | What to do |
|---|---|
| "rejected the API key (401)" | Copy the key again from app.crustdata.com, run `npm run setup` |
| "out of credits (402)" | Top up, run the same command again: finished work is kept |
| "does not have the full check" | The add-on is off: ask Crustdata, or use the quick screen |
| "cannot look up emails" | Add profile URLs to those rows, or ask Crustdata to enable Person Identify |
| "still in running jobs" | Run the same command again later; the jobs are collected, not resubmitted |
| "To avoid paying twice ... held" | A submission's answer was lost. Run again in a few minutes: the agent checks with Crustdata before sending anyone again |
| "already in a running job of another list" | Run that list again to collect the verdicts, then this one (it reuses them for free) |
| "from another version of this tool or was edited" | The list's state.json holds paid job ids; move it away only if no job is running for that list |
| "old Excel .xls file" | Save as .xlsx or CSV |
| "Another run is using out/" | Wait for the other run, or stop it |
| "npm took an option meant for this tool" | Put `--` before your file: `npm run verify -- file.csv --dry-run` |
| "above MAX_CREDITS_PER_RUN" | Use `--limit`, split the file, or raise the limit |
| "not a public profile URL" | The row has a recruiting or sales tool link; paste the public profile URL (with /in/) |
| "is not the name in your file" | The profile checked has another name than your file: check the URL in that row (often a nickname, a new name or another alphabet) |
| "same profile URL under another name" | Two applicants gave the same profile URL: check whose it is |
| "Removed with npm run forget" | The person was forgotten; delete the row, or `npm run forget -- --undo <profile URL>` |

## Other commands

| Command | What it does |
|---|---|
| `npm run setup` | Checks your Crustdata key and what it can use, Slack and AI keys; writes `.env` |
| `npm run test-slack` | Sends a test message to `SLACK_WEBHOOK_URL` |
| `npm run forget -- <profile URL or email>` | Removes one person from every file under `out/` and rebuilds report.md; keeps a one-way fingerprint so they are skipped if a file still lists them (`--undo` to allow again) |
| `npm run purge -- --older-than <days>` | Deletes list folders last run before that, and older cached results; keeps lists with running jobs unless `--force` |
| `npm run replay -- fixtures/<name>.json [--keep]` | A whole run offline; `--keep` keeps the files |
