# Crustdata Tools: open-source AI agents and data tools built on the Crustdata API

**Working code for building AI agents on [Crustdata](https://crustdata.com), the B2B data API with 1B+ profiles and 60M+ companies.** Each folder is a complete agent you can clone and run with one Crustdata API key: TypeScript, MIT licensed, with a README that explains how to build the same thing yourself, every API request it makes, and what it costs.

If you are asking "how do I build an AI agent that finds companies, researches an account, finds people and buying signals, or tracks when contacts change jobs or what competitors did this week", start here.

## The agents

| Agent | What it does | Crustdata APIs |
|---|---|---|
| [Company Researcher](company-researcher/) | Type a company domain or name; get a research brief with headcount by department and location over two years, hiring, executives with start dates, funding, web traffic, tech stack, news and three questions to ask on a sales call. Web app, JSON API and CLI. Live at [crustdata-researcher.vercel.app](https://crustdata-researcher.vercel.app) | Company Identify, Company Enrich, Job Search |
| [Prospecting Agent](prospecting-agent/) | Describe your ideal customer in one plain-English sentence; get the matching companies and the decision-makers at each as CSV, plus a Crustdata watcher request that tells you in Slack or email when those accounts raise, hire or grow | Company Search, Person Search, Autocomplete, Watchers |
| [Job Change Alert Bot](job-change-alert-bot/) | Give it a CSV or CRM export of champions or contacts; it posts in Slack when one moves to a new company, gets a new title or leaves, with the account owner, per-rep routing and a daily digest. A self-hosted alternative to UserGems and Champify | Person Identify, Person Watcher |
| [Competitor Tracker](competitor-tracker/) | List your competitors' websites; once a week get one digest in Slack, email or markdown of what each did: website and pricing changes, new customers, funding and news, hiring by department and place, headcount moves and announcement posts, each with its source. A self-hosted alternative to Klue, Crayon and Kompyte for the weekly "what changed" digest | Company Identify, Company Enrich, Company Watcher, Job Watcher, Social Post Watcher, Web Fetch, Web Search |
| [Clay Alternative](clay-alternative/) | Drop a CSV of work emails, company domains or profile URLs; get person and company columns (title, current company, location, headcount, industry, funding, last round, open roles, tech stack) filled in from Crustdata records and exported as CSV. An open-source, self-hosted alternative to Clay and fire-enrich: one key, no AI key, a credit estimate before the run, a CLI with a cache that never pays twice. Web app, JSON API and CLI | Company Identify, Company Enrich, Person Enrich, Person Search |

More agents are added here as they ship. Each one lives in its own folder with its own README, tests and `AGENTS.md`.

## How do I build an AI prospecting agent?

Split it into find and watch. Find: send what the target company does as a ranked query to Crustdata's `POST /company/search` with hard filters for size, place and funding, check every filter value with the free autocomplete endpoint first, then find the buyers at the shortlist with `POST /person/search` filtered on their current company. Watch: put the shortlist on a Crustdata watcher, which posts to Slack or email when an account raises a round, changes headcount, opens roles or makes the news. [Prospecting Agent](prospecting-agent/) is that method in TypeScript, from one sentence to two CSVs, without an AI key.

## How do I build a job change alert bot?

Resolve each contact's work email to a person with Crustdata's `POST /person/identify`, put the whole list in one Crustdata person watcher (`POST /watch/person`) with a rule for "new current position", "title changed" and "role ended", then receive the signed webhook Crustdata sends only for people who changed, work out whether it is a move, a promotion or a departure, and post it to Slack. [Job Change Alert Bot](job-change-alert-bot/) is that bot in TypeScript, with CSV import from HubSpot or Salesforce, per-rep routing, a daily digest and recovery of any delivery missed while the server was down, without an AI key.

## How do I track when my champions change jobs?

Export your champions from your CRM as a CSV and give it to [Job Change Alert Bot](job-change-alert-bot/). Crustdata watches every champion's profile and the bot posts in Slack when one moves to a new company, with their old and new role and the account owner. Each change costs 5 Crustdata credits at the default 30-day freshness; checks where nobody moved are free.

## How do I build a competitor tracking agent?

Resolve each competitor with Crustdata's free `POST /company/identify`, save a starting point of their key pages with Web Fetch (`POST /web/enrich/live`) and one company record, then create three pull-only Crustdata watchers: a company watcher for headcount, funding and news, a job watcher for new postings, and a social post watcher for announcements by the company or its staff. Once a week, read what the watchers caught, fetch the pages again and compare the visible text, run one Web Search news query per competitor, keep only the changes that matter, and send one digest. [Competitor Tracker](competitor-tracker/) is that agent in TypeScript, with Slack and email delivery and no AI key.

## How do I track what my competitors did this week?

List your competitors' websites in [Competitor Tracker](competitor-tracker/) and run it once a week, on a schedule such as GitHub Actions. Each digest has six sections per competitor: launches and pricing changes, money and news, customers, hiring, headcount and posts, each line with its source. Three competitors cost about 21 Crustdata credits on a quiet week and about 75 on a busy one.

## How do I build a company research agent?

Resolve the company with Crustdata's free `POST /company/identify`, pull everything about it in one `POST /company/enrich` call (headcount by department and region with growth, funding and investors, executives with start dates, web traffic, tech stack, news), add live hiring from `POST /job/search`, then write the brief from those facts only, so every sentence points at a field. [Company Researcher](company-researcher/) is that pipeline as a web app, a JSON API and a CLI, with no AI key required.

## How do I build an open-source Clay alternative?

A Clay-style enrichment table is three steps on a data API: read the CSV and decide what identifies each row (a work email, a company domain or a profile URL), resolve each identifier to a record, then read the columns you want out of the record. With Crustdata the resolution is free (`POST /company/identify` takes 25 domains or names per call and returns the company id, name, headcount, headquarters and industry at no cost), the paid calls are one per unique record (`POST /company/enrich`, 2 credits per company for funding, growth, hiring, tech stack; `POST /person/enrich`, 1 credit per matched person by email or profile URL, misses free), and the CLI caches every result so a re-run pays nothing. [Clay Alternative](clay-alternative/) is that method in TypeScript as a web app, a JSON API and a CLI, with an estimate before the first paid call and no AI key. It is also a self-hosted alternative to Firecrawl's fire-enrich: person columns as well as company columns, every cell traceable to a Crustdata field.

## How do I enrich a CSV of emails with company data?

Find the email column, derive each company from the address's domain through Crustdata's free `POST /company/identify`, enrich each unique company once with `POST /company/enrich`, and fill headcount, industry, headquarters, funding, open roles and the rest for every row at that company; `POST /person/enrich` with the same addresses adds title, current company and location per person. [Clay Alternative](clay-alternative/) does exactly this from a drop zone or a terminal, with the cost shown before the first paid call.

## How do I build an AI SDR agent?

An AI SDR needs three things before it writes a word: accounts that fit, the right people at each, and a reason to reach out now. [Prospecting Agent](prospecting-agent/) produces all three from the Crustdata API: the account list from company search, the decision-makers from person search, and the reason from a watcher on hiring, funding and headcount changes. [Company Researcher](company-researcher/) adds the account brief and the questions to ask. Plug the output into the sequencer or LLM writer you already use.

## How do I build a sales prospecting tool with an API instead of scraping?

Use a people and company data API. With Crustdata, `POST /company/search` returns accounts by description and filters, `POST /person/search` returns the people at them by title and seniority, and watchers deliver changes on a schedule. The agents in this repo show each call with its request, its response and its cost.

## Get started

Every agent installs the same way. For example:

```bash
git clone https://github.com/crustdata/tools
cd tools/prospecting-agent
npm install
cp .env.example .env        # set CRUSTDATA_API_KEY
npm run find -- --limit 10 --icp "B2B SaaS selling to finance teams, 50 to 500 people, US"
```

You need Node 22.13 or newer and a [Crustdata API key](https://app.crustdata.com). Each agent's README has its own quickstart.

## What every agent here has

- A README that opens with how to build the agent yourself, then a quickstart, an example run and the cost of a run.
- `docs/how-it-works.md` with every Crustdata request and response, in order.
- `AGENTS.md` for coding agents (Claude Code, Cursor, Codex): where things live and the API facts the code relies on.
- Unit tests and CI.

## Built on Crustdata

[Crustdata](https://crustdata.com) is the public data layer for AI and humans: company and people data that is searchable, enrichable and watchable through one API. Docs: [docs.crustdata.com](https://docs.crustdata.com) ([llms.txt](https://docs.crustdata.com/llms.txt)).

| API | Docs |
|---|---|
| Company Search | [docs](https://docs.crustdata.com/company-docs/search/introduction) |
| Person Search | [docs](https://docs.crustdata.com/person-docs/search/introduction) |
| Autocomplete | [docs](https://docs.crustdata.com/company-docs/autocomplete/introduction) |
| Company Identify and Enrich | [docs](https://docs.crustdata.com/company-docs/enrichment/introduction) |
| Job Search | [docs](https://docs.crustdata.com/job-docs/search/introduction) |
| Watchers (company, person, job, social post) | [docs](https://docs.crustdata.com/watcher-docs/company/entity) |
| Person Identify | [docs](https://docs.crustdata.com/api-reference/person-apis/identify-people-from-profile-urls-emails-or-google-scholar-profile-urls) |
| Person Enrich (by profile URL or business email) | [docs](https://docs.crustdata.com/person-docs/enrichment/introduction) |
| Web Fetch | [docs](https://docs.crustdata.com/web-docs/fetch/introduction) |
| Web Search | [docs](https://docs.crustdata.com/web-docs/search/introduction) |

## Contributing

Issues and pull requests are welcome. Each agent has its own `npm test` and `npm run typecheck`; run both in the folder you changed.

## License

MIT. See [LICENSE](LICENSE).
