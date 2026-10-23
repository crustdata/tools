# Customize Deal Sourcing Agent

The common changes to Deal Sourcing Agent, with the exact place to make them. Run `npm test` and `npm run typecheck` after each one; `npm run replay -- fixtures/seed-pipeline.json` shows the effect offline.

## Change the scoring weights in Deal Sourcing Agent

`WEIGHTS` in [src/score.ts](../src/score.ts) is one table that adds up to 100 (a test checks it, and that founders weigh more than growth). For a growth-first fund, for example:

```ts
export const WEIGHTS = {
  repeatFounder: 8, foundersFrom: 8, schools: 4,
  headcount6m: 18, headcount3m: 10, followers6m: 7,
  hiring: 20, traction: 12, fit: 5, timing: 8,
};
```

Then change the test in `test/score.test.ts` that checks the order, and the scoring table in the README. Where each signal earns full points (`+50%` team growth, 6 roles, ...) is `LEVELS` in the same file.

## Change what "due to raise" means

`DUE_WINDOWS` in [src/windows.ts](../src/windows.ts): the window is 6 to 15 months after a pre-seed or angel round, 12 to 24 after a seed and 18 to 30 after a Series A or later, with half points just before and after (`half`). `timingOf` applies it. Rounds that `dueWindow` does not map (grant, debt, convertible note, crowdfunding, private equity, post-IPO, undisclosed) are not timed; a round date with no type is timed as a seed. When you move `full`, move `half` with it. The numbers are repeated in README.md (the sample output, "decide a startup is due to raise" and the FAQ "about to raise"), docs/how-it-works.md and the comments in src/score.ts and src/windows.ts; test/score.test.ts uses fixed dates against 2026-10-21 that sit on the window edges. What counts as a sign of growth is `LEVELS.growthSign` (team +10% in 6 months with at least 2 people added, 2 roles posted in 90 days, followers +15% with at least 100 added, 1 founder traction post); a team down 10% or more cancels one sign. Full growth points also need people actually added (`headcount6mFullAdded`, `headcount3mFullAdded`, `followers6mFullAdded`), so a tiny team's large percentage does not count alone.

## Add a signal

1. Get the data: add the field group to `COMPANY_FIELDS` in [src/crustdata.ts](../src/crustdata.ts) (each premium group costs per company), or a new call next to `jobCounts`.
2. Carry it on `Company` in [src/types.ts](../src/types.ts) and fill it in `toCompany` in [src/pipeline.ts](../src/pipeline.ts).
3. Add a weight to `WEIGHTS` (and take the points from another signal so the total stays 100), then an `add("yourSignal", ...)` line in `scoreDeal` with a reason, and add its weight to `applicablePoints` when it applies to every company (that is what the missing-data rule, `MIN_COVERAGE`, measures against). If the data can be missing for every company (a feature not on the account), leave the signal out (push to `notScored`); if it is only skipped for some companies (outside a top N), score it as zero with a reason, so a skipped company never outranks a checked one.
4. Show it in the memo's snapshot in `renderMemo` ([src/memo.ts](../src/memo.ts)) and, if useful, a column in `PIPELINE_HEADER`.

Example: web traffic or news are company enrichment groups (`POST /company/enrich`, 2 to 4 credits per company), so they fit best for the top companies only, the way role titles are fetched in `runSource`.

## Edit the post phrases

`TRACTION_PHRASES`, `RAISE_PHRASES`, `RAISE_ACTIONS` and `RAISE_ROUNDS` in [src/signals.ts](../src/signals.ts) (round news is an exact phrase, or an action and a round in the same post). Matching is an exact phrase, whole words only, in any case, except phrases of 2 to 4 capital letters (MRR, ARR), which must be in capitals. Keep phrases specific: plain words such as "growth" matched founders writing about their market, and "closed our" or "we raised" matched "closed our first enterprise customer" and "we raised the bar", so round phrases name the round. Round phrases come first, so a post that says "we closed our seed and hit $20K MRR" counts as round news.

## Edit the AI analysis

The instructions are plain text in [prompts/memo-analysis.md](../prompts/memo-analysis.md): change the structure, the length or what to look for, save, and run `npm run memo -- <domain> --ai` to see one memo. The model gets the memo's saved facts as JSON and nothing else.

## Change what counts as a repeat founder

`priorFounderRoles` and `NOT_A_COMPANY` in [src/founders.ts](../src/founders.ts): a founder title held a year or more, or CEO of a company with 2 to 500 people today, at another company; clubs, student groups, newsletters, freelancing and consulting are left out.

## Change who counts as a founder

`FOUNDER_TITLES` (what the search asks for) and `isFounderTitle` (what is kept) in [src/founders.ts](../src/founders.ts). To add Chief Product Officers, add `"CPO"` and `"Chief Product Officer"` to `FOUNDER_TITLES` and a pattern to `isFounderTitle`. `MAX_FOUNDERS` is how many are kept per company.

## Add school short names

`SCHOOL_ALIASES` in [src/founders.ts](../src/founders.ts) maps what people type (`mit`, `cmu`, `iit`) to how schools are stored ("Massachusetts Institute of Technology").

## Add the company's own posts

Only founders' posts are searched, because company page posts use revenue words as marketing. To add them anyway, add a company variant of `postFilters` in [src/crustdata.ts](../src/crustdata.ts) (it hardcodes `actor.actor_type = "person"`), call `countPosts` with it in `countFounderPosts` ([src/source.ts](../src/source.ts)), and give it its own signal rather than mixing it into founders' traction. The post stub in `test/source.test.ts` maps person ids only, so extend it. Fetching posts costs 0.5 credits each; counting is free.

## Send the pipeline to a CRM

Not built in. `out/pipeline.csv` and `out/founders.csv` import into most CRMs as they are. A sync to Affinity, Attio or HubSpot would read `out/data.json` (every field of every deal) and is a good first pull request.

## Watch the pipeline

Done with Crustdata watchers in the Crustdata app, not in code: see "How do I watch" in the [README](../README.md#how-do-i-watch-for-new-companies-that-match-my-thesis).
