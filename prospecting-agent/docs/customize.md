# Customize

[Back to the README](../README.md)

## Describe the ICP differently

The sentence is split into a search query and hard filters by `parseSentence` in `src/icp.ts`. It reads:

| Phrase | Becomes |
|---|---|
| "20 to 500 people", "under 200 employees", "1,000+ employees", "over 1.5k people", "SMB", "mid-market", "enterprise companies" | `--size` |
| "seed to Series B", "Series A or B", "Series A-C", "series c+", "Series A-funded", "PE-backed" | `--raised` |
| "raised ... in the last 18 months", "raised since 2025" (only in a clause about funding) | `--since` |
| "YC", "Y Combinator-backed" | `--investor` |
| "uses HubSpot", "built on Shopify", "running on AWS" | `--tech` |
| "US", "U.S.", "UK", "North America", "Europe", "LATAM", "APAC", "Nordics", "DACH", "Germany", ... (anywhere in the sentence) | `--country` |
| "Texas", "New York" and the other US states | `--state` |
| "Bay Area", "Silicon Valley", "NYC", "London", "Berlin", "Bangalore" and a few more | HQ within 50 to 80 km |

Everything else becomes the query. The parser prints a note for things it cannot filter on (tools a company uses, "hiring", revenue, "customers of", unknown place names) so you can decide before paying. If it reads something you did not mean ("selling to US hospitals" sets an HQ filter of USA), clear it with a flag: `--country none`. To read more phrasings, add a row to the `SIZES`, stage, `COUNTRY_NAMES`, `US_STATES` or `METROS` tables and a case to `test/icp.test.ts`.

With `ANTHROPIC_API_KEY` set, Claude fills the same fields instead (`src/llm.ts`), and you confirm them before any search.

## Filter on the tools a company uses

"uses HubSpot" in the sentence, or `--tech HubSpot,Shopify`, filters on `technographics.technologies.name` (filter-only, 1 extra credit per company result at list price, free on plans that include it). Names are checked with `POST /company/search/autocomplete` on the field `technology`, so `--tech hubspot` is corrected to the stored `HubSpot` and an unknown name stops the run with close values.

## Change who counts as a buyer

- `--titles` in priority order. Each title matches the role at the account (the search matches any current role, and the code re-checks the one that counts); the order decides who is kept when an account has more than `--per-company` matches. C-level titles and "VP" have their long forms built in (`titleVariants` in `src/icp.ts`).
- `--seniority` narrows to levels such as `CXO,Vice President`. With `--titles`, both must hold.
- `isSideRole` in `src/icp.ts` lists the roles that never count (advisor, investor, intern, board member, assistant to).
- `FALLBACK_SENIORITY` sets who fills accounts where no title matched, `FALLBACK_MAX_SIZE` the largest company that gets that treatment, and `--fallback none` turns it off.

## Watch other company changes

The watcher request from `npm run watch-example` is plain JSON (`out/watch-company.json`, built by `companyWatchBody` in `examples/watch-accounts.ts`). Edit its `track` tree before you create the watcher. Any field in the [company profile](https://docs.crustdata.com/company-docs/enrichment/reference) can be tracked: `changed` for single values, `added` for lists.

| Signal | Leaf |
|---|---|
| New investor | `{ "field": "funding.investors", "type": "added" }` |
| Acquisition | `{ "field": "funding.acquisitions", "type": "added" }` |
| Rebrand | `{ "field": "basic_info.name", "type": "changed" }` |
| HQ moved | `{ "field": "locations.country", "type": "changed" }` |

`track` cannot be changed on a watcher that exists: create a new one and cancel the old.

## Change the job watcher

`jobWatchBody` in `examples/watch-accounts.ts` builds the filters. A job watcher can also filter on fields of the posting company that ride on the job record, for example only roles at companies with at least 200 people:

```json
{ "field": "company.headcount.total", "type": "=>", "value": 200 }
```

Try every new condition with `POST /job/search` first: a value that matches nothing is accepted and then never fires, and a field the job index does not carry is rejected with `Unsupported columns`. More in [watch-accounts.md](watch-accounts.md).
