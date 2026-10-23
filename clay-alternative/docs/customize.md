# Customize

The common changes, with the exact file and function names.

## Add a column

Every column is one entry in `COLUMNS` in `lib/columns.ts`:

```ts
{ id: "company.followers", label: "Followers", group: "Company",
  source: { kind: "company_enrich", group: "followers" },     // which call and field group it needs
  path: "followers.count",                                      // shown on hover and in docs
  note: "Followers on the company page",
  pick: c => num(c.followers?.count) }                          // reads the value; null when absent
```

- `source.kind` is one of `identify` (free, from `/company/identify`), `company_enrich` (2 credits per company, once whatever the columns), `company_premium` (technographics, +2), `person_enrich` (1 per matched person) or `person_premium` (`contact.business_emails`, +1, needs contact access).
- `pick` must never guess: return `null` when the record has no value.
- Add one line to `test/columns.test.ts` so the fixture record proves the path, and a row to the README's column table. `npm run columns` and the picker read the catalogue, so they update themselves.

The field groups and paths are listed in the Crustdata docs: [company enrich reference](https://docs.crustdata.com/company-docs/enrichment/reference) and [person enrich reference](https://docs.crustdata.com/person-docs/enrichment/reference). `GET /account/endpoints` lists which your key can read.

## Change the default ticks

`DEFAULT_COLUMNS` in `lib/columns.ts`. `defaultsFor()` drops person columns when a file has no person identifiers.

## Recognise another CRM's column names

`COLUMN_ALIASES` in `lib/csv.ts`. Headers are compared without case, spaces or punctuation, and a header containing an alias as a whole word also matches ("Primary Work Email").

## Change what counts as a personal email

`lib/personal-domains.ts`.

## Change how names are matched

`pickNameMatch` in `lib/run.ts` accepts one exact name, or the largest company when it is at least three times the next. Loosen or tighten it there; the fixture in `fixtures/responses.json` has the ambiguous case.

## Offer phone numbers

`contact.phone_numbers` is a premium field on `/person/enrich` (2 credits per person, needs contact access). Add a column with `source: { kind: "person_premium", field: "contact.phone_numbers" }` after widening that type in `lib/types.ts`, price it in `lib/account.ts` from `premium_fields`, and gate it like the email column in `lib/plan.ts`.

## Files above 2,000 rows: the batch endpoints

The synchronous path does 25 identifiers per call at 15 calls a minute, so 2,000 person rows take about six minutes and the CLI resumes from its cache if interrupted. For bigger files Crustdata's batch endpoints take up to 10,000 identifiers per job and return a file: [batch company enrich](https://docs.crustdata.com/company-docs/enrichment/batch) and [batch person enrich](https://docs.crustdata.com/person-docs/enrichment/batch-enrich). To switch: submit the job from `lib/run.ts` instead of looping `enrichCompanies` / `enrichPeople`, poll its `status_url`, download the result, then feed each record through the same `fill()` so the columns and the cache stay the same.

## Add a second data provider

The provider surface is the `Client` type in `lib/crustdata.ts` (`identifyCompanies`, `enrichCompanies`, `enrichPeople`). A second provider would implement the same three functions and the runner would try it where Crustdata returned `not_found`. Keep the `source` on each cell honest: name the provider and the field.

## Run it somewhere without a browser

Everything the page does, the CLI does: `npm run enrich -- file.csv --columns ...`. The JSON API is the same engine over HTTP: `POST /api/enrich` with `{ rows, columns }` streams NDJSON events (see `lib/events.ts`).
