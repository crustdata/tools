# Customize Candidate Sourcing Agent

The common changes, with the file and the function to edit. Run `npm test` and `npm run typecheck` after each, and `npm run replay -- fixtures/ml-engineer.json` to see the result offline.

## Rank candidates differently

Change a number in `WEIGHTS` at the top of `src/score.ts`, then:

```bash
npm run rescore        # free: scores the saved candidates again with the new weights
```

Examples:

- Care more about the title than Crustdata's fit tier: raise `title.max` and `title.exact` to 25, lower `fit.max` and `fit.strong` to 15.
- Never penalise someone who just started: set `tenure.under6` to 7.
- Do not let rows you care about less move the rank: lower their `max`, or set it to 0.
- Do not reward "open to new roles": set `open.bonus` to 0.

Never add a row on age, gender, origin, family status, religion, race or disability, or on an obvious proxy for one (graduation year, a maximum on experience). `PROTECTED` in `src/role.ts` lists the words taken out of the role sentence; keep it that way.

A new row (for example "has a master's degree") is one block in `scoreCandidate`: add points, add the row's maximum to `max`, push a reason. Add a case to `test/score.test.ts`.

## Teach the sentence parser a word

All in `src/role.ts`, as tables:

- A city: add it to `CITIES` with the place string and a radius in km. Crustdata resolves the place name for `geo_distance`; check it with one `--near "Place"` run.
- A country or region: `COUNTRY_WORDS`. Values are the full names Crustdata stores (they are checked with autocomplete).
- A company size word ("unicorn", "SMB"): `SIZE_WORDS`, with the bands from `bandsFor(min, max)`.
- Phrases that start a skill list: `SKILL_LEAD`.

Add a sentence to `test/role.test.ts` for each change. Anything the parser gets wrong for one search can also be fixed with a flag, without code.

## Make the title a filter, or add a filter

`--title-strict` already makes the title a filter. For a new filter, add a `Condition` in `buildConditions` (`src/role.ts`) with its round, label, the flag that clears it, the filter, and the premium data groups it touches (so `estimateCost` stays right). Field names and operators are in the [Person Search reference](https://docs.crustdata.com/person-docs/search/reference); categorical values must come from autocomplete.

## A do-not-poach list

Put one website domain per line in a file (acme.example, not a company name) and pass it. A line that is not a domain stops the run with the line named, so nothing on the list is ever dropped without you knowing:

```bash
npm run source -- --exclude do-not-poach.txt
```

People with any current role at those companies are left out (by the search, then again locally).

## Share a seen list, or skip people already in your ATS

```bash
npm run source -- --seen out/team-seen.csv          # one list shared by several roles
npm run source -- --skip-from ats-export.csv        # also skip everyone in this file
```

`--seen` is a list this tool writes; the role remembers it, and each run merges with the file just before writing, so two sourcers can share it. `--skip-from` reads any CSV and picks up every cell that is a profile URL, so an ATS export works as it is; it is never changed. A file that is not a seen list made by this tool is refused by `--seen`, so an export cannot be overwritten.

## Change the columns or the shortlist

- `candidates.csv`: `CANDIDATE_HEADER` and `candidateRows` in `src/output.ts`.
- `shortlist.md`: `shortlistMarkdown` in `src/output.ts`; `--top 15` changes how many people it shows.

## Import into an ATS

`candidates.csv` has a `profile URL` and a `name` column, which most ATS imports map directly. Imports that want a first and last name and an email: split the name column in the spreadsheet, and add the emails from `contacts.csv` (same `profile URL` column). For a direct sync (Greenhouse, Ashby, Lever), add a command next to `src/contacts.ts` that reads `scoreAll(...)` for the role and posts the top N; that is a welcome pull request.

## Change the AI sentence

`SYSTEM` and `factsFor` in `src/ai.ts`. `factsFor` is everything the model sees about a person; keep it to facts from the record. The model is `ANTHROPIC_MODEL` (default `claude-opus-5-5`) or `OPENAI_MODEL`.

## Keep sourcing on a schedule

Run `npm run source -- --name <role> --yes` weekly (cron, a CI schedule): each run returns the next ranked batch without anyone already seen. Or create a Crustdata watcher (`npm run watch-example`, see the README), which delivers people whose profiles newly match or changed, without ranking, scoring or the seen list.
