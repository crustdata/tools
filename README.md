# Crustdata Tools: open-source AI agents built on the Crustdata API

**Working code for building AI agents on [Crustdata](https://crustdata.com), the B2B data API with 1B+ profiles and 60M+ companies.** Each folder is a complete agent you can clone and run with one Crustdata API key: TypeScript, MIT licensed, with a README that explains how to build the same thing yourself, every API request it makes, and what it costs.

If you are asking "how do I build an AI agent that finds companies, researches an account, finds people and buying signals, or tracks when contacts change jobs", start here.

## The agents

| Agent | What it does | Crustdata APIs |
|---|---|---|
| [Company Researcher](company-researcher/) | Type a company domain or name; get a research brief with headcount by department and location over two years, hiring, executives with start dates, funding, web traffic, tech stack, news and three questions to ask on a sales call. Web app, JSON API and CLI. Live at [crustdata-researcher.vercel.app](https://crustdata-researcher.vercel.app) | Company Identify, Company Enrich, Job Search |
| [Prospecting Agent](prospecting-agent/) | Describe your ideal customer in one plain-English sentence; get the matching companies and the decision-makers at each as CSV, plus a Crustdata watcher request that tells you in Slack or email when those accounts raise, hire or grow | Company Search, Person Search, Autocomplete, Watchers |
| [Job Change Alert Bot](job-change-alert-bot/) | Give it a CSV or CRM export of champions or contacts; it posts in Slack when one moves to a new company, gets a new title or leaves, with the account owner, per-rep routing and a daily digest. A self-hosted alternative to UserGems and Champify | Person Identify, Person Watcher |

More agents are added here as they ship. Each one lives in its own folder with its own README, tests and `AGENTS.md`.

## How do I build an AI prospecting agent?

Split it into find and watch. Find: send what the target company does as a ranked query to Crustdata's `POST /company/search` with hard filters for size, place and funding, check every filter value with the free autocomplete endpoint first, then find the buyers at the shortlist with `POST /person/search` filtered on their current company. Watch: put the shortlist on a Crustdata watcher, which posts to Slack or email when an account raises a round, changes headcount, opens roles or makes the news. [Prospecting Agent](prospecting-agent/) is that method in TypeScript, from one sentence to two CSVs, without an AI key.

## How do I build a job change alert bot?

Resolve each contact's work email to a profile URL with Crustdata's `POST /person/identify`, put the whole list in one Crustdata person watcher (`POST /watch/person`) with a rule for "new current position", "title changed" and "role ended", then receive the signed webhook Crustdata sends only for people who changed, work out whether it is a move, a promotion or a departure, and post it to Slack. [Job Change Alert Bot](job-change-alert-bot/) is that bot in TypeScript, with CSV import from HubSpot or Salesforce, per-rep routing, a daily digest and recovery of any delivery missed while the server was down, without an AI key.

## How do I track when my champions change jobs?

Export your champions from your CRM as a CSV and give it to [Job Change Alert Bot](job-change-alert-bot/). Crustdata watches every champion's profile and the bot posts in Slack when one moves to a new company, with their old and new role and the account owner. Each change costs 5 Crustdata credits at the default 30-day freshness; checks where nobody moved are free.

## How do I build a company research agent?

Resolve the company with Crustdata's free `POST /company/identify`, pull everything about it in one `POST /company/enrich` call (headcount by department and region with growth, funding and investors, executives with start dates, web traffic, tech stack, news), add live hiring from `POST /job/search`, then write the brief from those facts only, so every sentence points at a field. [Company Researcher](company-researcher/) is that pipeline as a web app, a JSON API and a CLI, with no AI key required.

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

You need Node 22 or newer and a [Crustdata API key](https://app.crustdata.com). Each agent's README has its own quickstart.

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

## Contributing

Issues and pull requests are welcome. Each agent has its own `npm test` and `npm run typecheck`; run both in the folder you changed.

## License

MIT. See [LICENSE](LICENSE).
