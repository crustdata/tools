# Prospecting Agent: an open-source AI prospecting agent on the Crustdata API

_Part of [crustdata/tools](https://github.com/crustdata/tools), open-source agents built on the Crustdata API._

**Prospecting Agent turns one plain-English description of your ideal customer into the matching companies and the decision-makers at them, as CSV, and writes the Crustdata watcher request that tells you in Slack or email when those accounts raise, hire or grow.** It runs on the [Crustdata](https://crustdata.com) API with one key (1B+ profiles, 60M+ companies). TypeScript, MIT licensed, no AI key and no server needed.

## What it does

- **Find accounts.** One sentence ("B2B SaaS selling to finance teams, 50 to 500 people, US, raised Series A or B") becomes a ranked Crustdata company search with hard filters, and a log of what each filter kept and dropped.
- **Find the buyers.** Up to three people per account, matched on the role they hold at that account, in the order of the titles you give. Names, titles and profile URLs; no emails or phone numbers (those are a separate Crustdata call).
- **Watch the accounts (optional, done by Crustdata).** `npm run watch-example` writes the request for a Crustdata watcher over your shortlist: funding rounds, headcount moves, open roles, news, and job posts with your keywords. You create the watcher yourself with one curl or in the Crustdata dashboard, and Crustdata posts each change to Slack, Google Chat or email. Nothing of this repo keeps running.

## Quickstart

You need Node 22.13 or newer and a [Crustdata API key](https://app.crustdata.com). That is enough to find accounts:

```bash
git clone https://github.com/crustdata/tools
cd tools/prospecting-agent
npm install
cp .env.example .env        # set CRUSTDATA_API_KEY
npm run find -- --limit 10 --per-company 1 \
  --icp "B2B SaaS selling to finance teams, 50 to 500 people, US, raised Series A or B" \
  --titles "CFO, VP Finance, Head of FP&A" --exclude yourcompany.com
```

Write what the company does, not what it has or needs: "companies with a sales team" finds companies that sell sales services; "B2B SaaS selling to HR teams, 100 to 1000 people" finds buyers.

Start with `--limit 10`: the run costs about 2 credits on plans that include the extra data fields (up to about 25 at list price) and you can read the whole list. Drop the limit (default 100 accounts, 3 people each) once the list looks right; that run is about 15 credits on plans that include the extra data fields and up to about 240 at list price, so check your plan first. The sentence is read by rules, not by an AI, so it says what it understood, and what the run can cost, before searching:

```
ICP filters:
  query:       B2B SaaS selling to finance teams
  size:        50 to 500 people
  country:     USA
  raised:      series_a, series_b
  titles:      CFO, VP Finance, Head of FP&A
  accounts:    up to 10, 1 person each
  cost:        up to 20 company results and about 30 person results: about 1.5 credits on plans
               that include the extra data fields, up to 24 at list price (2 rounds; the people search runs once)
```

Not happy with the list? Change one thing and run again: `npm run find -- --growth 20` re-runs the saved search with one more filter, `--since none` removes one, and a new `--icp` sentence keeps your titles and exclusions. Re-running the same search is refused unless you pass `--force`; `--explain` re-runs it in rounds and costs the same as a new sentence. Everything is saved in `out/icp.json`, next to the CSVs.

That is the whole tool if a list is all you need. Watching the accounts is optional.

### Watching the accounts (with Crustdata)

Crustdata watchers re-check your accounts on a schedule and post what changed straight to a Slack channel, Google Chat or email. There is no server to run and nothing to host: you set the watcher up once with Crustdata, and Crustdata does the rest. This repo gives you the request for your shortlist:

```bash
npm run watch-example -- --slack https://hooks.slack.com/services/... \
  --job-keywords "FinOps, revenue operations"
```

It reads `out/accounts.csv` (delete rows there first to leave accounts out), writes `out/watch-company.json` and `out/watch-jobs.json`, and prints the curl that creates each watcher. It sends nothing and bills nothing. Then set it up yourself, either way:

- run the printed curl with your `CRUSTDATA_API_KEY`, or
- create the watcher in the Crustdata dashboard at [app.crustdata.com/watch](https://app.crustdata.com/watch).

Step by step, with what each watcher costs and how to pause or cancel it: [docs/watch-accounts.md](docs/watch-accounts.md). Crustdata's own guides: [Company Entity Watcher](https://docs.crustdata.com/watcher-docs/company/entity), [Job Watcher](https://docs.crustdata.com/watcher-docs/job/watch), [Social Post Watcher](https://docs.crustdata.com/watcher-docs/social-post/discovery).

## Example run

An excerpt of what `npm run find` prints for "companies building AI sales or recruiting agents, 20 to 500 people, raised seed to Series B" with founder and engineering titles (company names changed; a new sentence runs the filters in rounds so you can see what each one does):

```
Round 1: the sentence plus size and place
  filters: "companies building AI sales or recruiting agents" + 20 to 500 people
  returned 100, ranked by relevance (limit 100)
Round 2: plus funding
  filters: ... + last round seed/series_a/series_b
  returned 100, ranked by relevance (limit 100)
  dropped 76 from the round before, for example:
    - Litware AI (last round pre_seed)
    - Adatum Labs (last round unknown)
  caught 76 new ones the tighter filters let rank higher: Proseware, Woodgrove, ...
  top 10:
    company         domain             people  last round  raised      country
    Contoso Agents  contoso.example    190     seed        2024-12-31  USA
    Proseware       proseware.example  26      seed        2024-07-10  USA
    Woodgrove       woodgrove.example  24      seed        2025-08-18  USA
    ...
People, round 1: titles CEO, CTO, Co-founder, ...
  found people at 97 of 100 accounts
People, round 2: CXO, Owner / Partner, Vice President at the 3 accounts round 1 left empty
  filled 2 of 3
  271 people returned and billed, 233 kept (up to 3 per account)

Done. 100 accounts, 233 people at 99 of them, 14.13 credits in total.
  out/accounts.csv
  out/people.csv
  out/icp.json
```

## How do I build an AI prospecting agent?

An AI prospecting agent has two halves: find and watch. Find turns an ideal customer profile into a ranked company search with hard filters on Crustdata's `POST /company/search`, then finds the buyers at those companies with `POST /person/search`. Watch puts the shortlist on a Crustdata watcher, which posts to Slack or email when an account raises, grows or hires for the problem you solve. The four steps below are the whole method; this repository is the first three in TypeScript, plus the request for the fourth.

1. **Turn the ICP into a ranked search with hard filters.** Send what the company does as `search.query` with `mode: "hybrid"` to [`POST /company/search`](https://docs.crustdata.com/company-docs/search/introduction), and put size, place and funding in `filters`. Filters apply before ranking, so "20 to 500 people" never depends on a model understanding it.
2. **Validate every categorical value first.** Funding stages, industries, countries and seniority are closed sets: `Series A` matches nothing, the stored value is `series_a`. [Autocomplete](https://docs.crustdata.com/company-docs/autocomplete/introduction) is free and returns the exact stored values.
3. **Find the buyers at the shortlist.** [`POST /person/search`](https://docs.crustdata.com/person-docs/search/introduction) with `experience.employment_details.current.company_id in [...]` plus title keywords, then check the title of the role at that company, because the search matches any current role a person holds.
4. **Watch the accounts with Crustdata.** A [Company Entity Watcher](https://docs.crustdata.com/watcher-docs/company/entity) over the ids for funding, headcount, open roles and news, and a [Job Watcher](https://docs.crustdata.com/watcher-docs/job/watch) for the roles that signal a need. Crustdata runs them and delivers only what is new to Slack, Google Chat, email or a webhook; `npm run watch-example` writes the request.

The search request at the heart of it:

```bash
curl -X POST https://api.crustdata.com/company/search \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "search": { "query": "companies building AI sales or recruiting agents", "mode": "hybrid" },
    "filters": { "op": "and", "conditions": [
      { "field": "headcount.total", "type": "=>", "value": 20 },
      { "field": "headcount.total", "type": "=<", "value": 500 },
      { "field": "funding.last_round_type", "type": "in",
        "value": ["seed", "series_a", "series_b"] }
    ]},
    "fields": ["crustdata_company_id", "basic_info", "headcount", "funding",
               "locations", "taxonomy"],
    "limit": 100
  }'
```

## How it works

```
"companies building AI sales or recruiting agents, 20 to 500 people, raised seed to Series B"
   |  npm run find
   v
parse the sentence into filters      rules plus flags (or Claude, if ANTHROPIC_API_KEY is set)
POST /company/search/autocomplete    check every funding stage, industry and country (free)
POST /company/search                 ranked { query, mode: "hybrid" } plus the hard filters
                                     (a new sentence runs it in rounds, one filter group each)
POST /person/search                  current.company_id in [10 ids] and your titles, per call;
                                     then the most senior people where no title matched
   |-- out/accounts.csv, out/people.csv, out/icp.json
   |  npm run watch-example  (optional; sends nothing)
   v
out/watch-company.json               entity watcher: headcount.total, funding.last_round_type,
                                     hiring.openings_count changed; news added
out/watch-jobs.json                  new job posts at the accounts with your keywords
   |  you create them: the printed curl, or app.crustdata.com/watch
   v
Crustdata re-checks every 24h and posts only what changed to your Slack, Google Chat or email
```

How fresh the signals are: the example watchers re-check every 24 hours, and company profiles are refreshed on a roughly 30-day cycle, so a headcount or funding change can reach you days or weeks after it happens. New job posts arrive on the first daily check after Crustdata indexes them.

## What the sentence can say

The parser lifts these out of the sentence and turns them into filters; everything else ranks companies by description.

| In the sentence | Becomes |
|---|---|
| "20 to 500 people", "under 200 employees", "1,000+ employees", "SMB", "mid-market", "enterprise companies" | size |
| "seed to Series B", "Series A or B", "Series A-funded", "PE-backed" | funding stage |
| "raised ... in the last 18 months", "raised since 2025" | raise recency |
| "YC", "Y Combinator-backed" | investor |
| "US", "UK", "Germany", "Europe", "LATAM", "APAC", "Nordics", "DACH" and about 50 country names | HQ country |
| "Texas", "New York" and the other US states | HQ state |
| "Bay Area", "NYC", "London", "Berlin", "Bangalore" and a few other metro areas | HQ within 50 to 80 km |
| "uses HubSpot", "built on Shopify", "running on AWS" | tools in use (technographics; 1 extra credit per company result at list price) |

Without a size in the sentence, companies under 10 people are left out; `--size none` includes them. The parser prints a note for things it cannot filter on, so you see it before paying: "hiring", revenue, "customers of", a likely typo in a filter word ("Seris A"), a sentence that describes what a company has or needs rather than what it does, and place names it does not know. Any of these can be set or cleared with a flag.

## The flags

`npm run find` takes these. Any flag except `--icp`, `--limit` and `--per-company` takes `none` to clear it.

| Flag | Example | Becomes |
|---|---|---|
| `--icp` | `"B2B SaaS selling to finance teams"` | `search.query`, after the parser lifts out the filters above |
| `--size` | `50-500` | `headcount.total => 50` and `=< 500` |
| `--country` | `USA,GBR` or `Germany` | `locations.country in [...]` |
| `--state` | `Texas,California` | `locations.state in [...]` |
| `--raised` | `series_a,series_b` | `funding.last_round_type in [...]`, checked with autocomplete |
| `--since` | `2025-04` | `funding.last_fundraise_date => 2025-04-01` |
| `--investor` | `"Y Combinator"` | `funding.investors in [...]`, exact investor names |
| `--tech` | `HubSpot,Shopify` | `technographics.technologies.name in [...]`, checked with autocomplete; 1 extra credit per company result at list price |
| `--industry` | `"Software Development"` | `basic_info.industries in [...]`, checked with autocomplete |
| `--growth` | `20` | `headcount.growth_percent.12m > 20` |
| `--exclude` | `you.com,customer.com` | `basic_info.primary_domain not_in [...]` |
| `--titles` | `"CFO, VP Finance"` | the title of the role at the account, in priority order; CEO also matches Chief Executive Officer, VP also matches Vice President |
| `--seniority` | `"CXO,Vice President"` | `current.seniority_level in [...]`; with `--titles`, both must hold |
| `--fallback` | `none` | no "most senior people" search for accounts where no title matched |
| `--limit` | `100` | accounts in the shortlist, up to 1,000 (default 100) |
| `--per-company` | `3` | people kept per account (default 3); two to three candidates are billed per person kept |
| `--min-connections` | `100` | only people with at least this many connections; off by default, adds 0.2 credits per person at list price |
| `--explain` | | re-run the saved search in rounds, one search per filter group plus the people search, and show what each filter caught and dropped (a new sentence does this on its own) |
| `--force` | | run again even though nothing changed |
| `--fresh` | | ignore the saved `out/icp.json` and start over |
| `--yes` | | skip the confirmation after Claude reads the sentence |

`npm run watch-example` takes `--slack <incoming webhook URL>`, `--email a@you.com,b@you.com` and `--job-keywords "RevOps, Salesforce admin"`.

## Commands

| Command | What it does |
|---|---|
| `npm run find -- --icp "..."` | Build the shortlist and the people list; write `out/accounts.csv`, `out/people.csv` and `out/icp.json` |
| `npm run watch-example` | Optional. Write the Crustdata watcher request for the accounts in `out/accounts.csv` and print the curl. Sends nothing |
| `npm test` | Unit tests for the parser, the people rules, the CSVs and the watcher request |
| `npm run typecheck` | `tsc --noEmit` |

## Configuration

Copy `.env.example` to `.env`.

| Variable | Default | What it does |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Crustdata API key. The only one you need |
| `OUT_DIR` | `./out` | Where `find` writes its CSVs and `icp.json` (one folder per client) |
| `ANTHROPIC_API_KEY` | | Optional. Claude reads the ICP sentence instead of the rules; `ANTHROPIC_MODEL` picks the model |

## The CSVs

`out/accounts.csv`: name, domain, headcount, growth 12m %, last round, last raise date, country, industries, crustdata id, why matched (its rank and the filters).

`out/people.csv`: name, title, company, seniority, matched, profile URL, crustdata id. Up to `--per-company` people per account, ordered by your title list and then seniority. The `matched` column says which of your titles the role at that account matched, or `fallback (most senior)` for accounts where none did (`--fallback none` skips those); filter on it in your spreadsheet. Advisors, investors, interns, assistants and placeholder profiles with no real name are left out. Expect two to three people billed per person kept. Contact details are not included; add them with Crustdata [contact enrichment](https://docs.crustdata.com/person-docs/contact/batch) if you need them.

## Cost

The short version:

| Run | Credits |
|---|---|
| `--limit 10 --per-company 1` | about 2 on a plan that includes the extra data fields, up to about 25 at list price |
| default (100 accounts, 3 people each) | about 15 on a plan that includes the extra data fields, up to about 240 at list price |
| each day of watching (billed by Crustdata's watcher) | nothing on a quiet day; 5 per account that changed, 0.5 per new job post |

Check which plan you are on at [app.crustdata.com](https://app.crustdata.com) before the first default run; `GET /account/endpoints` lists your own search rates.

The long version. Search is billed per result, and every run prints its own estimate before it starts. Extra data fields (headcount, funding, industries for companies; job history and the optional connections count for people) each add to the price of every result they are filtered on or returned with; at list price a company result costs about 0.5 to 1.0 credits (plus 1 with `--tech`) and a person about 0.23. A new sentence runs the filters in rounds (one search per filter group); a flag change runs one search. Person search asks for three candidates per person it keeps, so it can pick the best, and every candidate is billed. The estimate printed before a run assumes all of them come back, so it is a ceiling: the measured default run billed about half of its estimate.

Measured from Crustdata's itemised billing for a run with two rounds of 100 companies and 301 people returned: 295 credits at list price with `--min-connections` on, 235 without it, and 15 on a plan that includes the extra fields.

Watching has a known ceiling: `max_results_per_run` in each watcher caps one day's deliveries (300 company changes and 100 job posts in the example, so at most 1,550 credits a day at list price, less for a shorter list; `npm run watch-example` prints yours). A typical day is far below it: expect most accounts to fire the headcount signal about once a month (5 credits each; drop the `headcount.total` line from `out/watch-company.json` to turn it off) and a handful of job posts a day for specific keywords.

## How it compares

Prospecting Agent covers list building and account signals, the two steps most sales data tools charge for first. It is a command-line tool plus Crustdata's own watchers, not a workspace.

| | Prospecting Agent | Table tools such as Clay | Databases such as Apollo | Signal tools such as UserGems |
|---|---|---|---|---|
| ICP in plain English | Yes, one sentence to ranked filters | Templates and formulas | Filter forms | Not the focus |
| Account list | CSV from `POST /company/search` | Table | Export | From your CRM |
| Decision-makers | CSV from `POST /person/search` | Table | Export | Job-change tracking |
| Hiring, funding, headcount signals | Crustdata watchers to Slack or email | Through integrations | Alerts | Core feature |
| Spreadsheet UI, waterfall enrichment | No | Yes | Partly | No |
| Source and license | MIT, yours to change | Proprietary | Proprietary | Proprietary |
| Pricing model | Crustdata credits per result and per changed record | Seats plus credits | Seats | Seats |

## FAQ

### How do I build an agentic prospecting tool?

Split it into find and watch. Find: turn the ICP into a ranked company search with hard filters on Crustdata's `POST /company/search`, validate each filter value first, then search for the buyers at the shortlist with `POST /person/search`. Watch: put the shortlist on a Crustdata watcher, which posts changes to Slack or email. This repo does the find half end to end and writes the watcher request for the second.

### How do I build my own sourcing tool with an API?

Use a people and company data API instead of scraping. With Crustdata, `POST /company/search` returns the target accounts, `POST /person/search` filtered on `experience.employment_details.current.company_id` returns the people at them, the free autocomplete endpoint keeps every filter value valid, and `post_processing.exclude_profiles` skips people you already have. Prospecting Agent does exactly this for buyers; swap the `--titles` list for the roles you hire and the same code sources candidates.

### How do I find companies matching my ICP with natural language?

Send the description as `search.query` with `mode: "hybrid"` to Crustdata's `POST /company/search`, and put the hard constraints (headcount, country, funding stage, raise date) in `filters`. Hybrid mode ranks companies by keyword and by meaning, and filters apply before ranking, so a constraint like "20 to 500 people" never depends on a model reading it correctly. Prospecting Agent's parser splits one sentence into those two parts without an AI key, and refines in rounds so you see what each filter caught and dropped.

### How do I track hiring and funding signals for my target accounts?

Create a Crustdata Company Entity Watch (`POST /watch/company`) over the account ids and track `funding.last_round_type`, `headcount.total`, `hiring.openings_count` and `news`. Add a Job Watch (`POST /watch/job/search`) filtered to the same ids and your keywords, so you hear when an account posts the role your product serves. Crustdata checks on the schedule you set and posts only what changed to Slack, Google Chat, email or a webhook; you pay only for changed records. `npm run watch-example` in this repo writes both requests for your shortlist; you create them with curl or at [app.crustdata.com/watch](https://app.crustdata.com/watch).

### Is there an open source Clay alternative for account lists and signals?

For the list and the signals, yes. Prospecting Agent is MIT licensed and builds the account list and the contact list from one plain-English sentence on the Crustdata API, and writes the Crustdata watcher request that sends hiring, funding and headcount signals for those accounts to Slack or email. It has no spreadsheet UI and no waterfall enrichment: output is two CSVs, and you change the code rather than a template. Contact details come from Crustdata's contact enrichment endpoint if you need them.

### Is this an open-source AI SDR agent?

It is the research half of one. An AI SDR agent needs three things: a list of accounts that fit, the people to talk to at each, and a reason to reach out this week. Prospecting Agent produces the first two from the Crustdata API (`/company/search`, `/person/search`) as CSV, and the third comes from a Crustdata watcher on the same accounts. It does not send email or sequence outreach; plug `out/people.csv` into the sequencer you already use.

### How do I stop it, or stop paying?

`npm run find` only costs credits when you run it. A watcher you created keeps running at Crustdata until you pause or cancel it: `PATCH /watch/company/{id}` with `{"status": "paused"}`, or `DELETE` the same path to cancel (for a job watcher, `/watch/job/search/{id}`). `GET /watch/company` lists your watchers. Details in [docs/watch-accounts.md](docs/watch-accounts.md).

### Why did a company I expected not show up?

Run with `--explain`: the log lists examples of dropped companies with the filter each failed. If the company never appeared, describe what it does differently in `--icp`, or raise `--limit`. Companies under 10 people are left out unless you pass `--size`.

### Do I need an OpenAI or Anthropic key?

No. Everything runs on the Crustdata key. Claude is an optional add-on that reads the ICP sentence for you.

## Customize

- **Teach the parser a phrase.** `parseSentence` in `src/icp.ts` is a few small tables (sizes, stages, places) with unit tests in `test/icp.test.ts`.
- **Change who counts as a buyer.** `--titles`, `--seniority`, and `titleVariants` / `isSideRole` in `src/icp.ts`.
- **Watch other company changes.** Add a line to `track` in `out/watch-company.json` (or in `companyWatchBody` in `examples/watch-accounts.ts`), for example `{ "field": "funding.investors", "type": "added" }`, before you create the watcher. See [docs/watch-accounts.md](docs/watch-accounts.md).
- **Read the API calls in detail.** [docs/how-it-works.md](docs/how-it-works.md) has every request and response; [docs/customize.md](docs/customize.md) has the rest.

## Security

The API key is read from `.env` and sent only to `api.crustdata.com`. `out/people.csv` holds names and profile URLs, so keep it where that is fine. A Slack webhook URL lets anyone who has it post to that channel; keep `out/watch-company.json` out of version control (the whole `out/` folder is in `.gitignore`). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Project structure

```
src/
  cli.ts           find, watch-example
  find.ts          npm run find: the search, its log, people, CSVs
  icp.ts           flags, sentence parser, autocomplete checks, people rules (pure, tested)
  llm.ts           optional: Claude reads the sentence
  crustdata.ts     every Crustdata API call, with retries
  csv.ts           CSV writer and reader
  config.ts        environment variables
examples/
  watch-accounts.ts  npm run watch-example: the watcher request for your shortlist
test/              node:test unit tests
docs/              how it works, customizing, watching the accounts with Crustdata
```

## Contributing

Issues and pull requests are welcome. Run `npm test` and `npm run typecheck` before opening one; [AGENTS.md](AGENTS.md) explains where things live, for people and for coding agents.

## Built on Crustdata

[Crustdata](https://crustdata.com) is the public data layer for AI and humans: 1B+ profiles and 60M+ companies, searchable and watchable through one API. Full docs at [docs.crustdata.com](https://docs.crustdata.com).

| Endpoint | Used for |
|---|---|
| [`POST /company/search`](https://docs.crustdata.com/company-docs/search/introduction) | the ranked ICP search, with hard filters |
| [`POST /company/search/autocomplete`](https://docs.crustdata.com/company-docs/autocomplete/introduction) | checking filter values before any credit is spent |
| [`POST /person/search`](https://docs.crustdata.com/person-docs/search/introduction) | the decision-makers at each account |
| [`POST /watch/company`](https://docs.crustdata.com/watcher-docs/company/entity) | the example watcher: funding, headcount, open roles and news at the accounts (you create it) |
| [`POST /watch/job/search`](https://docs.crustdata.com/watcher-docs/job/watch) | the example watcher: new job posts at the accounts (you create it) |

## License

MIT. See [LICENSE](LICENSE).
