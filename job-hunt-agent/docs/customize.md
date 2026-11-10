# Customize the job hunt agent

The common changes, with the file and the function. Run `npm test && npm run typecheck` after each.

## Change how jobs are scored

[src/score.ts](../src/score.ts): `WEIGHTS` (skills 50, title 12, level 8, place 10, growth 6, funding 4,
freshness 10) and `PENALTY` (no sponsorship 25, clearance 15, citizens only 15, years 10). The labels (70 and
50) are at the end of `scoreJob`. To weigh a skill more, give it two entries in the CV skills, or change the
`total` line in `scoreJob`.

## Add skills, or other spellings of one

[src/skills.ts](../src/skills.ts): add a line to `RAW`, the name first, then spellings as regular expression
snippets (`["Kubernetes", "kubernetes", "k8s"]`). A skill that is also an ordinary word ("Go", "Swift") needs a
stricter pattern in `STRICT`. Skills that are practices rather than tools go in `PRACTICES`, so notes do not
say "building with Distributed systems". Skills only you know you have: `"skills"` in profile.json.

## Change the draft notes

[src/notes.ts](../src/notes.ts): `TEMPLATES`, one per kind (recruiter, manager, team, alumni). Placeholders:
`{first}`, `{role}`, `{company}`, `{experience}` (" I've been working with Go and Kubernetes."), `{school}`.
Notes are about 200 characters and never over 300 (`NOTE_LIMIT`), short enough for any message box. Keep
the rule in `experienceLine`: a note never claims more than the CV shows. For notes written for each
person, use the Claude Code skill (`.claude/skills/job-hunt`).

## Change who is searched, and how many

[src/people.ts](../src/people.ts): `searchesFor` builds the four searches (query, limit, filter). The numbers
shown per kind are `WANT` in [src/hunt.ts](../src/hunt.ts) (2, 1, 3, 3); jobs under `MIN_SCORE_FOR_PEOPLE` (50)
are skipped unless `--all`. Who is marked to write to first: `chooseFirst`. Manager queries by
team are in `MANAGER_QUERY`; what a title must say to count is `RECRUITING`, `MANAGING` and `NOT_STAFF`. To
look for people in the job's state instead of its country, change `countryFilter` to filter
`basic_profile.location.state`. Every person is 0.23 credits at list price (0.43 for alumni).

## Keep or leave out agencies and companies

[src/jobs.ts](../src/jobs.ts): `STAFFING` (by industry) and `AGENCY_NAME` (by name). `--include-agencies`
keeps them for one run. Companies you never want: `"skipCompanies"` in profile.json (name or website) or
`--skip-company`. Title words: `"skipTitleWords"` or `--skip-title intern`.

## School names the agent misses

[src/hunt.ts](../src/hunt.ts): `schoolAliases` adds short forms (UC, IIT, MIT, CMU and a few more). Add yours
to `KNOWN_SCHOOLS`. Or put every spelling in profile.json: `"schools": ["Georgia Institute of Technology", "Georgia Tech"]`.

## Check more job boards

[src/open-check.ts](../src/open-check.ts): `boardOf` reads the board and ids from a URL, `checkOpen` asks the
board. Add a branch for another board with a public API; keep to https and the fixed host.

## Run it every morning

The agent marks jobs it has shown before (`seen` in the report and the dashboard), so a daily run shows what
is new. With cron on macOS or Linux (`crontab -e`), 8:00 every weekday; set PATH to the folder
`dirname "$(which node)"` prints (it differs with Homebrew and nvm):

```text
PATH=/path/to/node/bin:/usr/bin:/bin
0 8 * * 1-5 cd /path/to/tools/job-hunt-agent && mkdir -p out && npm run hunt >> out/cron.log 2>&1
```

A daily run re-reads the newest 50 jobs (1.5 credits), including ones it read before, and pays for people
only for companies and searches not seen in the last 14 days. Lower `--scan`, or `--days 2`, to spend less.

## Use the results somewhere else

`out/<run>/jobs.json` has everything (shape in [reference.md](reference.md)); `jobs.csv` opens in any
spreadsheet. `npm run --silent hunt -- --json` prints the same JSON for another program.
