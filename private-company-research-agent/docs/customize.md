# Customize Private Company Research Agent

The common changes, with the file and function to edit. Run `npm test` after each change, and
`npm run replay -- fixtures/struggling.json` to see every rule end to end.

## Change a red-flag threshold

All rules are in the "Findings" part of `buildMemo` in [src/memo.ts](../src/memo.ts). Each pushes a finding with
`kind: "red_flag"` or `"signal"`, its text, its evidence and a question. Examples:

- Founder elsewhere: `RUNS_COMPANY` and `also_running` in `leaderFrom`.
- Leadership churn: 3 or more senior people in one of `FUNCTION_GROUPS`.
- Attrition: `dep.share_of_headcount_pct >= 15` and `dep.staff_total >= 5` (interns, advisors and contractors are
  not counted; `INTERN` and `NOT_STAFF` decide who is which).
- Headcount down: `a <= -3 && p <= -5` in `hcDrop`.
- Department shrinking: `r.before >= 5`, `r.change <= -2`, `r.change_pct <= -20`. Two or more of these three become
  one "team_contraction" finding.
- Traffic falling: `v >= 10_000` and `q.value <= -20` (3 months) or `six.value <= -30`.
- Long gap with a flat team: `monthsSince >= 24` and `yoy <= 5`.
- Layoff or lawsuit words in headlines: `LAYOFF_WORDS`. The headline must be about the company (`aboutCompany`).
- Question order: `RANK` (questions are capped at 10, so the order decides which are kept).

## Change who counts as a leader

`LEADER_TITLE` (titles), `LEADER_TITLE_BIG` and `BIG_COMPANY` (at 500 people and more, "head of" is not a leader),
`NOT_STAFF` (advisors, ambassadors, interns, contractors), `ASSISTANT`, `LEADER_LEVELS` (seniority levels) and
`isLeader` in [src/memo.ts](../src/memo.ts). Directors are "senior" but not leaders; to flag them too, set `leader`
from `isSenior(role)` instead of `isLeader(role, big)` in `leaverFrom`.

## Change the questions

Each finding's `question`, plus `extraQuestions` in `buildMemo` (runway since the last round, paid vs organic search,
where the team is, the best-funded peer, no hiring after a raise). Questions are capped at 10.

## Change how peers are picked

`competitorDomains` (which lists, in what order), `minPeerSize` (10 people and a tenth of the company's headcount),
the industry check (`industriesOf`) and the peers block in `collect()` in [src/collect.ts](../src/collect.ts).
`PEERS_LIMIT` sets how many. To show peers' web traffic, enrich them with `enrichCompany` instead of `peersById`
(2 credits each instead of 0.63).

## Read more or fewer former staff

`LEAVERS_LIMIT` in `.env` (25; 0 turns departures off). The leader search reads up to `SENIOR_LIMIT` (10) in
[src/collect.ts](../src/collect.ts); the estimate uses the same number. `PEOPLE_DETAIL=leaders` keeps the names of
former staff who are not leaders out of memos.

## Fetch more from Crustdata

Add a group to `ENRICH_FIELDS` in [src/crustdata.ts](../src/crustdata.ts) (for example `technographics`, +2 credits),
type what you read in [src/types.ts](../src/types.ts), and add a section in `buildMemo` and `renderMemo`. The groups a
key can read are in `GET /account/endpoints?path=/company/enrich` (free).

## Change the comparison table

`COLUMNS` and `values` in [src/render.ts](../src/render.ts) for the CSV; `renderComparisonMd` for the markdown.

## Change the AI note

Edit [prompts/analyst-note.md](../prompts/analyst-note.md): no code change needed. The model sees the memo JSON only.
Pin a model with `ANTHROPIC_MODEL` or `OPENAI_MODEL`.

## Run it on a schedule

For a weekly screen of new inbound deals, cron on your own server is simplest: `out/.cache` stays on disk, so
companies researched in the last week cost nothing again. `CACHE_DAYS=8` keeps last Monday's answers alive
until this Monday's run (with 7, they expire a few seconds before it starts).

```bash
# every Monday at 07:00; deals.csv is exported from your CRM beforehand
0 7 * * 1  cd /srv/private-company-research-agent && CACHE_DAYS=8 MAX_CREDITS_PER_RUN=300 npm run -s research -- /srv/deals.csv
```

On GitHub Actions, keep the deal list out of the repo (a secret or your own storage), keep `out/.cache` between runs,
and do not upload memos as public artifacts (they name people):

```yaml
on:
  schedule: [{ cron: "0 7 * * 1" }]
permissions: { contents: read }
jobs:
  research:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - uses: actions/cache/restore@v4
        with: { path: out/.cache, key: "pcra-${{ github.run_id }}", restore-keys: "pcra-" }
      - run: printf '%s' "$DEALS_CSV" > deals.csv
        env: { DEALS_CSV: "${{ secrets.DEALS_CSV }}" }
      # Exit 2 means some rows were not researched (normal for a CRM export): not a failed job.
      - run: npm ci && (npm run -s research -- deals.csv || [ $? -eq 2 ])
        env: { CRUSTDATA_API_KEY: "${{ secrets.CRUSTDATA_API_KEY }}", MAX_CREDITS_PER_RUN: "300", CACHE_DAYS: "8" }
      # Save the answers even when the run stopped (out of credits), so the next run resumes for free.
      - if: always()
        uses: actions/cache/save@v4
        with: { path: out/.cache, key: "pcra-${{ github.run_id }}" }
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: memos
          retention-days: 7
          path: |
            out/
            !out/.cache
```

GitHub deletes a cache that is not used for 7 days, so a weekly schedule that slips can lose `out/.cache` and pay
again; a daily or twice-weekly schedule keeps it. A weekly screen of 20 deals is about 100 to 260 credits at list price, above the default `MAX_CREDITS_PER_RUN` (150),
so the examples raise it. Exit code 2 means some rows were not researched: read `unresolved.csv`. Upload memos as
artifacts only from a private repository: in a public one (or a fork of one), anyone signed in to GitHub can
download them, and memos name people. To be told when something changes at
companies you invested in, use [VC Portfolio Monitor](https://github.com/crustdata/tools/tree/main/vc-portfolio-monitor).
