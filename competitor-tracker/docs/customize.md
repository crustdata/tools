# Customize Competitor Tracker

Every rule is a small pure function with a test next to it. Change the function, run `npm test`, then
`npm run replay -- fixtures/busy-week.json` to see the effect offline.

## Make headcount more or less sensitive

`src/headcount.ts`:

```ts
export const TOTAL_THRESHOLD = 0.05;    // total headcount move to report (5%)
export const FUNCTION_THRESHOLD = 0.2;  // one department's move to report (20%)
export const MIN_FUNCTION_SIZE = 5;     // ignore departments smaller than this
export const REFERENCE_DAYS = 28;       // compare against a record about this old
```

## Keep different posts

`config/post-keywords.json` has five lists. The first four (`announce`, `customers`, `numbers`, `money`) are sent to
the Crustdata post watcher, so only posts containing one of those words are delivered and billed (2 credits each,
including posts the rules then drop, so keep the words specific). `skip` drops a post when the quoted sentence
contains one (webinars, hiring posts, personal news). `numbers` posts are kept only when they contain a figure, and a
staff post only when it speaks for the company (`classifyPost` in `src/posts.ts`).

After editing the file, run `npm run init`: it notices the words changed and replaces the post watcher.

## Watch other pages

Edit `pages` for a competitor in `competitors.json`. The first `PAGES_PER_COMPETITOR` pages are fetched each week.
A page added this way is compared from the following week. To change how pages are found for new competitors, edit
`PAGE_KINDS` and `discoverPages` in `src/website.ts`.

## Change what counts as a launch or a customer

`launchItems` and `customerItems` in `src/website.ts` receive the comparison of one page (`PageDiff`: added and removed
text blocks, new links, new logos, price changes) and return digest lines. For example, to report every new blog post
rather than only those with launch wording, change the `blog` case to use `entries` without the `LAUNCH_WORDS` filter.

## Add a seventh section

Example: G2-style review counts, or a tech stack change from the company record.

1. Add the key to `SECTIONS` and `SECTION_TITLES` in `src/types.ts`, and a quiet line to `QUIET` in `src/digest.ts`
   (typecheck fails until every `Record<Section, ...>` has it). The markdown, Slack and email outputs pick it up.
2. Write a pure function that returns `Item[]` (see `src/headcount.ts` for the shape), with a test.
3. Call it in step 5 of `buildDigest` in `src/run.ts` (the per-competitor loop) and push its items into
   `r.sections.<key>.items`. If it needs data from the
   company record, add the field group to `COMPANY_FIELDS` in `src/crustdata.ts` (the company watcher's `fields` are
   fixed once created, so run `npm run delete-watches` then `npm run init`).
4. Add the case to a fixture and an assertion in `test/run.test.ts`.

## Send the digest somewhere else

`runDigest` returns the `Digest` object and the markdown. Add a sender in `deliver` in `src/run.ts`, next to Slack and
email (Teams, Discord, a Notion page, a Google Doc): it gets the same structured `Digest`, and a sent flag in the
`digests` table (`src/store.ts`) lets `npm run resend` retry it.

## Run it more often

The job and post watchers check daily (`DAILY` in `src/crustdata.ts`) and the company watcher weekly (`WEEKLY`). Job and
post watchers bill per item caught, so checking more often costs the same; the company watcher bills per company that
changed in each run, so running it more often can cost more. None of this refreshes the underlying data faster
(company records refresh every 1 to 30 days, jobs 1 to 30, posts 1 to 45). Existing watchers keep their schedule until
they are recreated (`npm run delete-watches`, then `npm run init`). Pages and news are read whenever `npm run digest`
runs.
