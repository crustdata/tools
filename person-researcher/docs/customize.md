# Customize Person Researcher

Each recipe names the file and function to change. Run `npm test` and `npm run typecheck` after a change, and
`npm run replay -- fixtures/meeting.json` to see it end to end without a key.

## Change the sections or their order

`renderBrief()` in `src/render.ts` writes the markdown top to bottom; move or delete a block there. The data for
each section is built in `buildBrief()` in `src/brief.ts`; add a field to the `Brief` type and fill it there. A
section with no data is skipped by an `if` around its block.

## Change the "What changed lately" rules

`changes()` in `src/brief.ts`. The window is `--days` (default 180, `DEFAULTS.days` in `src/research.ts`). Each
rule is one block (new title, added role, new company, left) and has a test in `test/brief.test.ts`. To also flag
a long tenure ("10 years at Acme"), add a block that reads `years_at_company_raw` from the main role.

## Leave out more web sites, or fewer

`config/ignored-sites.json`, the `domains` list. An entry matches the host and its subdomains (`zoominfo.com`
matches `www.zoominfo.com`) or a host plus path prefix (`crunchbase.com/person`). Results on the person's own
profile site are always left out (`pickLinks()` in `src/brief.ts`). To show more than 5 links, pass `maxLinks` to
`buildBrief()` in `src/research.ts`.

## Change the web and news queries

`searchPhrase()` in `src/brief.ts` builds `"Name" Company` (the latest past employer for someone between jobs).
The news window is `NEWS_DAYS` (90) in `src/research.ts`: change it there, and the brief's wording, the request
and the cache key follow. Results that do not mention the last name are dropped in `pickLinks()`. To add a third query (for example their name and "podcast"), add a `webSearch()` call next to
the other two and a field on the brief; it costs 1 credit a query (an empty one cost 0 on 2026-10-23).

## More or fewer posts

`--posts n` (0 to 10) per run, or `DEFAULTS.posts` in `src/research.ts`. Posts are cut to 200 characters in
`postLines()` in `src/brief.ts`. To include quote reposts, change the `post_type` condition in `recentPosts()` in
`src/crustdata.ts` to `{ "field": "post_type", "type": "in", "value": ["original", "repost_quote"] }`.

## A profile fetched live instead of from the index

Crustdata Live Enrich (`POST /person/professional_network/enrich/live`, 7 credits a profile on the account this was
built on, 10 a minute, enterprise plans or the live add-on) retrieves the profile from the web at request time and
returns the same fields. Add a function next to `enrich()` in `src/crustdata.ts` and call it in step 3 of
`research()` behind a `--fresh` flag. The endpoint is described under "Fresh data and realtime enrichment" in the
[Person Enrich reference](https://docs.crustdata.com/person-docs/enrichment/reference) and in
[Data updates](https://docs.crustdata.com/general/data-updates).

## Change what the cache keeps

`CACHE_HOURS` in `.env` (0 turns it off). Keys are built in `research()` (`search|...`, `identify|...`,
`posts|...`, `web|...`, `news|<days>|...`, `contact|<kind>|...`, `denied-fields`) and in `enrichCached()`
(`enrich|...`); the files are in `out/.cache/`.

## Send briefs to Slack, email or your CRM

The tool writes files and prints to stdout; it has no delivery code. Two ways to add it:

- **From the shell:** `npm run -s research -- jane@acme.com > brief.md`, then post the file with your own script
  (`-s` keeps npm's header line out of the file). `--json` gives a JSON array for a CRM note or another agent.
- **In code:** `research()` in `src/research.ts` takes an `onBrief` callback that is called (and awaited) once per
  finished brief. Post `renderBrief(outcome.brief)` from there to a Slack incoming webhook (escape `<`, `>` and `&`
  first) or write it to your CRM's notes API. If the callback throws, the run logs it and goes on; the brief stays
  done.

## Run it before every meeting

Read tomorrow's attendees from your calendar API, write their emails to a file, and run
`npm run research -- --file attendees.txt` once a day (cron, a GitHub Actions schedule, or your notetaker's
pre-meeting hook). Set `SKIP_DOMAINS` to your own domains and keep `MAX_CREDITS_PER_RUN` as a ceiling. An empty
file, or one with only meeting rooms and colleagues, exits 0; exit code 2 means someone was not found, needs a
pick or failed (see `index.md`); 3 means the run stopped (bad key, no credits). `MAX_CREDITS_PER_RUN` (150) fits
about 23 people by email; raise it for bigger days. Answers are cached for 24
hours, so someone in two meetings is paid for once.

## Watch a person for changes

Person Researcher is a one-off lookup. To be told when someone changes jobs, use the
[job change alert bot](https://github.com/crustdata/tools/tree/main/job-change-alert-bot), which puts the same
people on a Crustdata watcher.
