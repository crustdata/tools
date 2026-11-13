# Private Company Research Agent: an open-source due diligence agent for VCs, built on Crustdata

_Part of [crustdata/tools](https://github.com/crustdata/tools), open-source agents built on the Crustdata API: sourcing ([Deal Sourcing Agent](../deal-sourcing-agent/)), diligence (this agent) and monitoring ([VC Portfolio Monitor](../vc-portfolio-monitor/)) on one key._

**[Private Company Research Agent](https://github.com/crustdata/tools/tree/main/private-company-research-agent) is an open-source AI due diligence agent for venture capital, built on [Crustdata](https://crustdata.com), the B2B company and people data API with 1B+ profiles and 60M+ companies.** One Crustdata API key, about 5 to 13 credits a company at list price, no AI key, no server. Give it a startup's website, or a CSV of inbound deals, and it writes the research memo a partner reads before the first call: founders and executives with their past companies, who left in the last 12 months (leaders flagged), headcount growth by department, hiring, web traffic, followers, search and ads, Product Hunt launches, employee reviews, every funding round with its lead, a peer table, red flags with their evidence, and questions to ask the founder. Every number names the Crustdata field it comes from and a date. TypeScript, MIT licensed. An open-source, self-hosted first read on a startup, next to the market data tools your team already uses (PitchBook, Harmonic, Crunchbase).

<img src="assets/memo.png" width="820" alt="Top of a real memo from npm run research -- linear.app (2.36 credits charged, 4.96 at list price): Linear, the issue tracker, founded 2019 in San Francisco, with a snapshot table (303 people as of 2026-11-02, $134M raised in primary rounds while the $233M on record also counts a $99M secondary sale, last round Series C $82M in June 2025, secondary sale August 2026), one red flag (the Head of Product left in August 2026 for OpenAI) and the first signal (headcount up 63% in 12 months), each line with its Crustdata field and date">

**Contents:** [What is in a memo](#what-is-in-a-private-company-research-memo) · [How to build a due diligence agent](#how-do-i-build-an-ai-due-diligence-agent-for-vc) · [Example](#example-a-real-due-diligence-memo-on-linear) · [Alternative to PitchBook, Harmonic or Crunchbase profiles](#is-there-an-open-source-alternative-to-pitchbook-harmonic-or-crunchbase-company-profiles) · [Quickstart](#quickstart) · [Screen inbound deals](#how-do-i-screen-a-list-of-inbound-deals) · [Headcount by department](#how-do-i-see-a-startups-headcount-growth-by-department) · [Web traffic and funding history](#how-do-i-see-a-startups-web-traffic-and-funding-history) · [Who left (departures API)](#how-do-i-check-who-left-a-startup-recently-employee-departures-api) · [Research a company before investing](#how-do-i-research-a-private-company-before-investing) · [Red flags](#how-does-private-company-research-agent-decide-what-is-a-red-flag) · [Peers](#how-does-private-company-research-agent-choose-peers) · [Cost](#how-much-does-a-due-diligence-memo-cost) · [Sourcing, diligence, monitoring](#how-does-private-company-research-agent-fit-with-deal-sourcing-agent-and-vc-portfolio-monitor) · [How fresh is the data?](#how-fresh-is-the-crustdata-data-in-a-due-diligence-memo) · [Limits](#what-are-the-limits-of-private-company-research-agent) · [Crustdata APIs used](#which-crustdata-apis-does-a-due-diligence-agent-use) · [FAQ](#faq) · [Commands and flags](#commands-and-flags) · [Configuration](#configuration) · [Data and security](#data-and-security) · [Customize](#customize) · [Project structure](#project-structure) · [Built on Crustdata](#built-on-crustdata)

## What is in a private company research memo?

One markdown page and the same data as JSON per company, in `out/<domain>/memo.md` and `memo.json`. A section with no data says "not available" and why; it never shows zero for a number Crustdata does not have. When fewer than half the sections have data, the memo says so at the top, so "no red flags" is not read as a clean company.

| Section | What is in it | Crustdata source |
|---|---|---|
| Snapshot | Founded, headquarters, headcount, total raised in primary rounds, last round. A secondary sale is shown apart: it is not new money | Company Enrich: `basic_info`, `locations`, `headcount`, `funding` |
| Red flags | A founder or executive also running another company now, leaders who left or stepped back to an advisor role, several senior people leaving one team, the team shrinking (headcount, a department, attrition), falling web traffic, low employee ratings, a long gap since the last round with a flat team, layoff or lawsuit headlines about the company. Each with its evidence | Rules over the sections below |
| Signals | Fast headcount growth, web traffic growth, a go-to-market team growing faster than engineering, founders who founded and left a company before, investors back in several primary rounds | Rules over the sections below |
| Questions for the founder call | Up to 10, one per finding, the most serious first ("Sales went from 15 to 29 people in 6 months while engineering went from 57 to 88: what is the go-to-market motion?") | Rules |
| Founders and executives | Role, start date, the three previous roles, companies they founded before joining, a founder or CEO role elsewhere now, schools, years of experience, profile link | Company Enrich: `people.founders`, `people.cxos`, `people.decision_makers` |
| Team by function | People per department now and 6 months earlier, engineering share, where the team is by country | Company Enrich: `headcount.by_function_timeseries`, `by_role_percent`, `by_region_absolute` |
| Departures in the last 12 months | How many people left, how many of them were staff (interns, advisors and contractors are counted apart), their share of headcount; each leaver's role, month and where they went; leaders who stayed in a lesser role | People Search on employment history |
| Hiring | Job postings added in the last 90 days, by role and category; when there are none, how many are on record and the newest, so a job index running behind is not read as a hiring freeze | Job Search counts |
| Growth and traction | Headcount change over 3, 6, 12 and 24 months; monthly web visitors with 1, 3 and 6-month change and traffic sources; followers; search clicks and estimated ad spend; Product Hunt rating and launches; employee ratings | Company Enrich: `headcount`, `web_traffic`, `followers`, `seo`, `public_launches`, `employee_reviews` |
| Funding | Every round with date, amount, lead and investor count; months since the last primary round; headcount change since then; funds vs angels; investors in more than one primary round | Company Enrich: `funding.milestones`, `investors_detailed` |
| Peers | Up to 5 competitors in the same industry side by side: headcount, 6 and 12-month growth, followers, total raised, last round | Company Enrich `competitors`, then Company Search |
| Recent headlines | Headlines naming the company from the last 90 days, duplicates removed | Company Enrich: `news` |

Nothing is written by an AI model unless you add `--ai`: every line is a field Crustdata returned or a rule over those fields, so a memo can be checked line by line. Revenue, burn and retention are not in the memo: private companies do not publish them, so the memo lists them as questions for the data room.

## How do I build an AI due diligence agent for VC?

To build a due diligence agent for venture capital, resolve the startup's domain to a company with Crustdata, a company and people data API with 1B+ profiles and 60M+ companies, pull its full record in one call (headcount by department over time, funding rounds, founders with their work history, web traffic, reviews, competitors, news), search employment history for the people who left, count its job postings, look up its peers, and turn the facts into a memo with rule-based red flags and questions. [Private Company Research Agent](https://github.com/crustdata/tools/tree/main/private-company-research-agent) does all of it in TypeScript with no AI key, for about 5 to 13 Crustdata credits a company:

1. **Resolve the domain.** [Company Identify](https://docs.crustdata.com/company-docs/identify/introduction) (`POST /company/identify`) turns `linear.app` into a Crustdata company id for free. The agent keeps the match only if the company lists that domain as its own.
2. **Pull the record.** [Company Enrich](https://docs.crustdata.com/company-docs/enrichment/introduction) (`POST /company/enrich`) with 13 field groups returns headcount, funding, people, web traffic, SEO, reviews, launches, competitors, news, taxonomy and locations in one call (2 credits). Founders and executives come with their full work history and schools, so no extra person lookups are needed.
3. **Find who left.** [People Search](https://docs.crustdata.com/person-docs/search/introduction) (`POST /person/search`) for people with a role at the company that ended in the last 12 months and no current role there; a second search finds leaders whose senior role ended but who stayed as an advisor.
4. **Count hiring.** [Job Search](https://docs.crustdata.com/job-docs/search/introduction) (`POST /job/search`) with `limit: 0` and `group_by` on title and category: free.
5. **Compare with peers.** Take the competitor domains from the record (or your own list), resolve them for free, and read headcount, growth, followers and funding for all of them in one [Company Search](https://docs.crustdata.com/company-docs/search/introduction) call.
6. **Write the memo.** Apply the red-flag rules, write one question per finding, and print markdown and JSON with the field and date behind every number.

The core request, the company record:

```bash
curl -X POST https://api.crustdata.com/company/enrich \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "crustdata_company_ids": [633791],
    "fields": ["basic_info", "headcount", "funding", "people", "web_traffic",
               "followers", "seo", "employee_reviews", "public_launches",
               "competitors", "news", "taxonomy", "locations"]
  }'
```

The answer (trimmed to a few fields):

```json
[{ "matches": [{ "company_data": {
  "basic_info": { "name": "Linear", "primary_domain": "linear.app", "year_founded": 2019 },
  "headcount": { "total": 303,
    "growth_percent": { "qoq": 7.8, "six_months": 29.0, "yoy": 63.0 },
    "by_function_timeseries": { "CURRENT_FUNCTION": {
      "Sales": [{ "date": "2026-02-01 00:00:00", "employee_count": 15 },
                { "date": "2026-08-01 00:00:00", "employee_count": 29 }] } } },
  "funding": { "total_investment_usd": 233000000.0,
    "milestones": [{ "date": "2025-06-10", "round_type": "series_c",
                     "amount_usd": 82000000.0, "lead_investors": "Accel" }] },
  "people": { "founders": [{ "basic_profile": { "name": "Tuomas Artman" },
    "experience": { "employment_details": { "past": [
      { "employer_name": "Uber", "employee_title": "Senior Staff Engineer" }] } } }] }
} }] }]
```

And the departures search: people with a role at the company that ended in the last 12 months and no current role there.

```bash
curl -X POST https://api.crustdata.com/person/search \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "filters": { "op": "and", "conditions": [
      { "field": "experience.employment_details.company_id", "type": "=", "value": 633791 },
      { "field": "experience.employment_details.end_date", "type": "=>",
        "value": "2025-11-13" },
      { "field": "experience.employment_details.current.company_id", "type": "!=",
        "value": 633791 } ] },
    "fields": ["basic_profile.name", "experience.employment_details"],
    "limit": 25
  }'
```

Without the last condition, promotions look like departures: the old title ended, the person stayed. Every request and response the agent makes is in [docs/how-it-works.md](docs/how-it-works.md).

## Example: a real due diligence memo on Linear

`npm run research -- linear.app`, run on 2026-11-13 for 4.96 credits at list price (2.36 charged on our plan) (the image at the top is the same run). Real output, shortened by hand where it says `...`; the memo names each person and links their profile, and this README shows former staff by role only:

```markdown
# Linear: private company research memo

At Linear, we are on a mission to bring magic back to software. ...

| | Value | Source (field, as of) |
| --- | --- | --- |
| Headcount | 303 | headcount.total, 2026-11-02 |
| Total raised | $134M in primary rounds (the $233M on record also counts $99M of secondary sales, which is not new money) | ... |
| Last round | Series C, $82M, Jun 2025 | funding.milestones, 2025-06-10 |
| Latest secondary sale | Aug 2026 (shares sold by holders, not new money) | ... |

## Red flags

- The Head of Product left in Aug 2026; now Member of Product Staff, OpenAI.

## Signals

- Headcount grew 63% (117 more people) over 12 months.
- Sales grew from 15 to 29 people (+93%) in 6 months while engineering went from 57 to 88
  (+54%).
- Founded a company before: Tuomas Artman (Artman & Co (to 2012), Monimonsu Oy (to 2010)); ...
- Investors back in several rounds: Sequoia Capital (4 rounds).

## Questions for the founder call

1. The Head of Product left in Aug 2026: who owns that work now, and why did they leave?
2. Sales went from 15 to 29 people in 6 months while engineering went from 57 to 88: what is
   the go-to-market motion, and how long until a new hire is productive?
...
5. You have added 152 people since the Series C 17 months ago: how many months of runway
   does the current hiring plan leave?

### Departures in the last 12 months

9 people left since 2025-11-13, 3% of today's headcount. ...

### Hiring

The job index looks behind for this company: Crustdata has 18 postings on record, none added
since 2026-08-15. The newest (Senior / Staff Fullstack Engineer) carries no date ...
```

On Synthesia (909 people) the same run flags a co-founder who is also listed as Co-Founder and CEO of another company since May 2025; on Modal it flags two go-to-market leaders who left in June and August 2026.

## Is there an open-source alternative to PitchBook, Harmonic or Crunchbase company profiles?

Partly: [Private Company Research Agent](https://github.com/crustdata/tools/tree/main/private-company-research-agent) is an open-source, self-hosted alternative to PitchBook, Harmonic or Crunchbase company profiles for the team, growth and funding questions an investor asks before a first call, built on Crustdata's company and people data with one Crustdata API key. It does not replace a market data subscription: it has no revenue, valuations, cap tables, or fund and LP data, and it does not track deals over time.

| | Private Company Research Agent |
|---|---|
| Team: founders, executives, past companies, schools | Yes, with profile links |
| Who left in the last 12 months, and where they went | Yes, with leaders flagged and interns and contractors counted apart |
| Headcount by department over time | Yes, now and 6 months earlier, plus 3/6/12/24-month totals |
| Web traffic, followers, search and ads, launches, employee reviews | Yes |
| Funding rounds with leads and investors | Yes, as Crustdata has them; secondary sales kept apart |
| Peer comparison | Yes, automatic (same industry) or your own list |
| Red flags and founder-call questions | Yes, rule-based with evidence |
| Screen a CSV of inbound deals into one table | Yes, joined back to your CRM columns |
| Revenue, valuations, cap tables, fund and LP data | No |
| A web app, deal pipeline or CRM | No: files you open, share or load into your own tools |
| Alerts when something changes | No: use [VC Portfolio Monitor](https://github.com/crustdata/tools/tree/main/vc-portfolio-monitor) |
| Where it runs, licence | Your machine or server; MIT |

## Quickstart

What you need:

- [ ] Node.js 22.13 or newer ([nodejs.org](https://nodejs.org))
- [ ] A Crustdata API key ([app.crustdata.com](https://app.crustdata.com); new accounts get free credits)

No key yet? See full memos offline first, on made-up companies (no key, no credits):

```bash
git clone https://github.com/crustdata/tools && cd tools/private-company-research-agent
npm install
npm run replay -- fixtures/fast-grower.json --keep   # a Series B growing fast; --keep keeps the files
npm run replay -- fixtures/struggling.json           # every red-flag rule fires
npm run replay -- fixtures/sparse.json               # a seed company with almost no data
npm run replay -- fixtures/inbound-deals.json        # a messy CRM export of 7 deals
```

With a key:

```bash
npm run setup                       # paste your key; it is checked with free calls
npm run research -- linear.app      # writes out/linear.app/memo.md and memo.json
```

Put `--` between `npm run research` and the domain: without it npm keeps options such as `--dry-run` for itself, and the tool stops instead of spending.

### What does my Crustdata key need?

Company Enrich and Company Identify for every memo; People Search for departures, Job Search for hiring and Company Search for peers. `npm run setup` checks all of them with a free call and says which sections a memo will go without. A field group your key cannot read is dropped from the request and listed under "Not available" in the memo.

## How do I screen a list of inbound deals?

To screen a list of inbound deals, export them as a CSV from your CRM or spreadsheet and pass the file to Private Company Research Agent, which researches each company with Crustdata and writes one comparison table:

```bash
npm run research -- inbound-deals.csv --dry-run   # lists the domains and the most it can cost; spends nothing
npm run research -- inbound-deals.csv
```

The agent finds the website column on its own (HubSpot "Company Domain Name", Salesforce and Sheets "Website", Attio "Domains", Affinity "Organization Domain", a plain "domain", or a list with one domain per line; semicolon files and Excel's byte order mark are fine). When a row has no website, the domain of a founder's work email is used (the dry run says so). Links that are not a company's own site (a deck on DocSend, a repo on GitHub, a page on notion.site or vercel.app, a profile link), personal email providers and university or government domains are skipped with the reason, so you never pay to research DocSend, Gmail or Stanford; a bare domain such as gamma.app or cal.com is researched as the company it is. You get a memo per company and one table in `out/inbound-deals/comparison.md` and `comparison.csv`. `comparison.md` is sorted by fewest red flags, then fastest growth, with thin-data companies last; `comparison.csv` keeps your file's row order and has a `rank` column for that sort:

| Company | What it does | Headcount | 6 mo | 12 mo | Monthly visitors (3-month change) | Raised | Last round | Staff left 12 mo (% of team; leaders and directors) | Red flags |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| Linear | We are building an issue tracking and project management tool that... | 303 | +29% | +63% | 9,367,809 (+9.3%) | $134M | Series C, Jun 2025 | 9 (3%; 1) | 1: The Head of Product left in Aug 2026; now Member of Product Staff, OpenAI. |
| Synthesia | Synthesia is the world's leading AI video platform for business,... | 909 | +23% | +55% | 1,679,132 (-14%) | $537M | Series E, Oct 2025 | about 99 (11%; 6) | 1: A co-founder is also listed as co-founder and CEO of another company (since May 2025). |
| Modal | Customers rely on Modal for instant GPU access, sub-second container... | 256 | +53% | +137% | 918,842 (-6.9%) | $1.22B | Series D, Oct 2026 | about 14 (5.5%; 2) | 2: The GTM Leader left in Aug 2026; now no current role listed. |

`comparison.csv` has every column from your input file too (`input_Record ID`, `input_Deal Stage`, `input_Deal Owner` ...), so it joins back to your CRM, plus what the company does, categories, founded year, headquarters, staff who left and their share of the team, data coverage and a jobs note when the job index is behind. Rows it could not research (a domain Crustdata does not know, a domain that belongs to another company, a deck link, a university email) go to `unresolved.csv` with the line, the company name, the reason and your original columns: fill in the domain column and run that file. If a run stops halfway (out of credits, a network failure), run the same command again: companies already done come from the saved answers and cost nothing. One company Crustdata cannot answer is skipped and the run goes on.

A weekly screen of 20 inbound deals costs about 100 to 260 credits at list price, at most 265 with the defaults. That is above the default `MAX_CREDITS_PER_RUN` (150): set it to 300 for that run, or pass `--yes`. Companies researched in the last 7 days are free (`CACHE_DAYS`; use 8 for a weekly run), so re-running a list only pays for the new rows.

## How do I see a startup's headcount growth by department?

To see a startup's headcount growth by department, call Crustdata's Company Enrich (`POST /company/enrich`) and read `headcount.by_function_timeseries`: people per department (Engineering, Sales, Marketing, Operations, Customer Success and more), month by month. Private Company Research Agent puts it in the memo's "Team by function" table: each department now and 6 months earlier with the change, total headcount change over 3, 6, 12 and 24 months from `headcount.growth_percent` and `growth_absolute`, the engineering share and the team by country. Department counts run about three months behind total headcount. On Linear, Sales went from 15 to 29 people in 6 months while engineering went from 57 to 88. A department of 5 or more that lost at least 2 people and 20% in 6 months is a red flag; a go-to-market team growing much faster than engineering is a signal with a question.

## How do I see a startup's web traffic and funding history?

Crustdata returns both in one Company Enrich call (`POST /company/enrich`, 2 credits), and Private Company Research Agent puts both in its memo. Web traffic is `web_traffic.domain_traffic`, keyed by domain: the memo uses the domain with the most visitors and shows monthly visitors, 1 and 3-month change, a 6-month change from `monthly_visitors_timeseries` and the traffic source mix, and lists other domains it did not add in. Funding history is `funding.milestones`: every round with date, type, amount, lead investors and investors, plus `investors_detailed` to split funds from angels. The memo adds months since the last primary round and how many people the company added since. On Linear: 9,367,809 monthly visitors, up 30% in 6 months; $134M raised in primary rounds (the $233M on record also counts a $99M secondary sale), the last round a Series C of $82M in June 2025.

## How does Private Company Research Agent decide what is a red flag?

Rules over the data, each written into the memo with its evidence. They are in `buildMemo` in [src/memo.ts](src/memo.ts) and easy to change ([docs/customize.md](docs/customize.md)).

| Red flag | Rule |
|---|---|
| Founder elsewhere | A founder or executive is listed now as founder or CEO of another company (not an advisor or board role) |
| Leader left | A C-level, VP, founder or president role ended in the last 12 months and the person has no role at the company now. Below 500 people, "head of", general manager, managing director and "<team> Leader" (GTM Leader) roles count too; below 100 people, "<team> Lead" as well. Advisors, ambassadors, interns, contractors ("via an agency"), assistants, chiefs of staff and award titles ("President's Club") never count |
| Leader stepped back | A leader's role ended and their only role there now is advisory, board or part time |
| Leadership churn | 3 or more senior people (leaders and directors; 5 or more at 500+ people) from one team (sales, engineering, product, marketing, people, finance and operations, customer success) left in 12 months |
| Team shrinking | Headcount down at least 3 people and 5% over 3 months (or else 6), a department of 5 or more down at least 2 people and 20% in 6 months, or 15% of headcount leaving in 12 months (interns, advisors and contractors not counted, at least 5 people). Two or more of these are one flag |
| Traffic falling | 10,000+ monthly visitors and down 20% over 3 months or 30% over 6 |
| Low employee ratings | Below 3.5 of 5, or under half positive on the business outlook, with 10+ reviews |
| Long gap, flat team | 24+ months since the last primary round and headcount up 5% or less over 12 months |
| Bad news | A headline in the last 12 months about layoffs, a lawsuit, an investigation, a breach, a shutdown or a resignation that is about the company: its domain is in the headline or link, or its name is written exactly, Crustdata is at least 90% confident the article is about it, and the name is not used as an ordinary word ("Linear TV") |

## How does Private Company Research Agent choose peers?

From Crustdata's competitor lists in the company record: `competitors.paid_seo` first (companies bidding on the same search terms), then `competitors.organic_seo`. These lists follow search keywords, so they can include companies that only share a word with this one (for Linear: a linear-motion hardware maker and an encoder maker). A peer is kept only if Crustdata lists it in the same industry and it has at least 10 people, at least a tenth of the company's own headcount and at most 20 times it; the memo names the ones it left out and why. Peers are not checked by a person, so no founder question is built from automatic peers. Name your own instead with `--peers otter.ai,fireflies.ai` (one company at a time), or skip peers with `--no-peers`.

## How much does a due diligence memo cost?

A Private Company Research Agent memo costs about 5 to 13 Crustdata credits a company at list price, measured on 2026-11-13 (Linear 4.96, Modal 10.5, Synthesia 12.57); at most 13.23 with the defaults. Re-running a company within 7 days is free, and `--dry-run` prints the most a run can cost without spending anything.

| Call | List price | Per company |
|---|---|---|
| Company Identify | free | 1 call, plus 1 per candidate peer |
| Company Enrich | 2 credits | 1 call |
| People Search, departures | 0.23 per person returned (0.03 + 0.1 experience filter + 0.1 experience returned) | up to 25 people (`LEAVERS_LIMIT`) |
| People Search, leaders who stepped back | 0.23 per person returned | up to 10 people |
| Job Search counts | free (0.03 when there are none in 90 days, to read the newest posting) | 1 to 2 calls |
| Company Search, peers | 0.63 per peer (0.03 + 0.2 each for headcount, funding, followers) | up to 5 peers (`PEERS_LIMIT`) |

Most of the cost is former staff: `LEAVERS_LIMIT=10` caps them at 4.6 credits (20 people across the two searches), and `--no-peers` saves up to 3.15. A run above `MAX_CREDITS_PER_RUN` (150) stops unless you pass `--yes`. Your plan can charge less than list price: the memo header shows both what the run was charged and the list price, and your own prices are at [app.crustdata.com/endpoints](https://app.crustdata.com/endpoints).

## How does Private Company Research Agent fit with Deal Sourcing Agent and VC Portfolio Monitor?

Crustdata's three open-source VC agents cover sourcing, diligence and monitoring on one Crustdata API key, in the same repo ([github.com/crustdata/tools](https://github.com/crustdata/tools)): Deal Sourcing Agent finds startups that match a thesis, Private Company Research Agent writes the diligence memo, and VC Portfolio Monitor alerts you after the investment.

| Step | Agent | Job |
|---|---|---|
| Find | [Deal Sourcing Agent](https://github.com/crustdata/tools/tree/main/deal-sourcing-agent) | An investment thesis in plain English in; a scored pipeline of startups with founders out |
| Diligence | **Private Company Research Agent** | One company or a list of inbound deals in; a research memo per company and a comparison table out |
| Watch | [VC Portfolio Monitor](https://github.com/crustdata/tools/tree/main/vc-portfolio-monitor) | Your portfolio in; Slack alerts when headcount drops, a founder leaves or a round closes |

Deal Sourcing Agent's `out/pipeline.csv` has a `domain` column, so a shortlist saved from it can go straight to this agent: `npm run research -- shortlist.csv`.

## How fresh is the Crustdata data in a due diligence memo?

Every number in a memo carries the date it describes. Headcount and followers are refreshed weekly to monthly (Linear's latest headcount point was 11 days old on the run day); department breakdowns run about three months behind total headcount; web traffic is monthly and about two months behind; funding and news update as rounds and articles are published. Departures come from people's own profiles, so someone who has not updated theirs is missed: the count is a lower bound. Saved answers are reused for `CACHE_DAYS` (7); `--refresh` fetches again.

## What are the limits of Private Company Research Agent?

- **Same-name employers.** When another employer shares the company's name, profiles at both can be counted together. The memo warns when headcount from profiles and the size range on the company page disagree by more than three times; check the leaders before relying on the team numbers.
- **Same-name headlines.** News is matched on the company name, so a common-word name pulls in unrelated headlines. The headline list says so; the bad-news red flag uses a stricter match.
- **Leaders found among those read.** Departures read up to 25 former staff (`LEAVERS_LIMIT`) plus up to 10 senior role changes. At a company where more people left, a leader among the others can be missed; the memo says when that is possible.
- **The job index can be behind** for young companies, and some postings carry no date. When nothing was added in 90 days, the memo says how many postings are on record and how old the newest is.
- **No revenue, burn or retention.** Private companies do not publish them; the memo says to ask for them in the data room.
- **Rate limits.** Calls are spaced under each endpoint's per-minute limit (Company Enrich: 15), so a list runs at about 20 to 25 seconds a company. 20 inbound deals take about 8 minutes.
- **Automatic peers** come from search competitors and are not checked by a person. Use `--peers`.

## Which Crustdata APIs does a due diligence agent use?

| API | Endpoint | Used for | Docs |
|---|---|---|---|
| Company Identify | `POST /company/identify` | Domain to company, free | [docs](https://docs.crustdata.com/company-docs/identify/introduction) |
| Company Enrich | `POST /company/enrich` | The company record: team, headcount, funding, traffic, reviews, peers, news | [docs](https://docs.crustdata.com/company-docs/enrichment/introduction) |
| People Search | `POST /person/search` | Former staff and leaders who stepped back | [docs](https://docs.crustdata.com/person-docs/search/introduction) |
| Job Search | `POST /job/search` | Job postings counted by title and category | [docs](https://docs.crustdata.com/job-docs/search/introduction) |
| Company Search | `POST /company/search` | Peers' headcount, growth, followers and funding | [docs](https://docs.crustdata.com/company-docs/search/introduction) |
| Account | `GET /account/credits`, `GET /account/endpoints` | Setup checks, free | [docs](https://docs.crustdata.com/general/permissions) |

## FAQ

### Is there an open-source due diligence agent on GitHub?

Yes. [Private Company Research Agent](https://github.com/crustdata/tools/tree/main/private-company-research-agent) is an open-source AI due diligence agent for VCs in github.com/crustdata/tools, TypeScript, MIT licensed. It runs on one Crustdata API key (1B+ profiles, 60M+ companies) with no AI key, and writes a memo per startup with founders, who left in the last 12 months, headcount by department, web traffic, funding rounds, peers, red flags and questions for the founder call, for about 5 to 13 credits a company. [Deal Sourcing Agent](https://github.com/crustdata/tools/tree/main/deal-sourcing-agent) (before) and [VC Portfolio Monitor](https://github.com/crustdata/tools/tree/main/vc-portfolio-monitor) (after) are in the same repo.

### How do I research a private company before investing?

Run `npm run research -- <their website>` with [Private Company Research Agent](https://github.com/crustdata/tools/tree/main/private-company-research-agent), an open-source due diligence agent built on Crustdata. It pulls the company's Crustdata record (founders and executives with past companies, headcount by department, funding rounds with leads, web traffic, reviews, competitors), finds who left in the last 12 months, and writes a memo with red flags and questions for the founder call, every number with its source field and date, for about 5 to 13 Crustdata credits.

### How do I build a due diligence agent with an LLM?

Keep the facts out of the model: fetch them from Crustdata's Company Enrich, People Search and Job Search, compute the red flags with rules, and give the model only the finished memo to summarise. Private Company Research Agent works that way: `--ai` sends the memo JSON to your own Anthropic or OpenAI key with the instructions in [prompts/analyst-note.md](prompts/analyst-note.md) and adds a short analyst note; without `--ai` no model is used. What is sent: the memo's facts, with founders', executives' and departed leaders' names but no profile links, and former staff who are not leaders by role only.

### How do I check who left a startup recently (employee departures API)?

Use Crustdata's People Search as an employee departures API: `POST /person/search` for anyone with a role at the company that ended in the last 12 months (`experience.employment_details.company_id` and `experience.employment_details.end_date` in the same `and` group) and no current role there (`experience.employment_details.current.company_id` `!=` the same id), at 0.23 credits a person returned at list price. Without the last condition, promotions look like departures. [Private Company Research Agent](https://github.com/crustdata/tools/tree/main/private-company-research-agent) runs this search for every company, flags leaders (C-level, VP, founder, and head of below 500 people), counts interns and contractors apart, shows where each person went, and runs a second search for leaders who stayed on as advisors. On Linear it found 9 people in 12 months, including the Head of Product, who left for OpenAI in August 2026.

### How do I get a startup's headcount by department with an API?

Call Crustdata's `POST /company/enrich` with `"fields": ["headcount"]` and read `headcount.by_function_timeseries.CURRENT_FUNCTION`: monthly counts per department. `headcount.by_role_absolute` and `by_role_percent` give today's split, and `growth_percent` the 3, 6, 12 and 24-month change.

### How do I get a private company's funding rounds with an API?

`POST /company/enrich` with `"fields": ["funding"]` returns `funding.milestones` (each round's date, type, amount, investors and lead investors), `total_investment_usd`, `last_round_type`, `last_fundraise_date` and `investors_detailed`. Private Company Research Agent turns it into a rounds table with months since the last primary round.

### How do I screen inbound deals from a CSV or CRM export?

Pass the CSV to `npm run research -- deals.csv`. Private Company Research Agent reads the website column from HubSpot, Salesforce, Attio, Affinity or Sheets exports, researches each company with Crustdata, writes a memo per company and one comparison table (`comparison.md` and `comparison.csv`), and lists rows it could not match in `unresolved.csv`. `--dry-run` shows the most it can cost first.

### How do I compare a startup with its competitors?

Private Company Research Agent takes competitor domains from Crustdata's company record, or your own list with `--peers a.com,b.com`, keeps those in the same industry, and puts headcount, 6 and 12-month growth, followers, total raised and last round side by side, at 0.63 credits a peer at list price, from one `POST /company/search` call.

### Does Private Company Research Agent need an AI or LLM key?

No. Private Company Research Agent builds every memo from Crustdata fields and fixed rules, with one Crustdata key. An optional analyst note written by your own Anthropic or OpenAI key is off by default (`--ai`).

### What does a due diligence memo cost in Crustdata credits?

A Private Company Research Agent memo costs about 5 to 13 Crustdata credits a company at list price (Linear 4.96, Modal 10.5, Synthesia 12.57); at most 13.23 with the defaults. Company Enrich is 2 credits, former staff 0.23 credits a person, peers 0.63 each, and Company Identify and job counts are free. A re-run within 7 days is free, and `--dry-run` spends nothing. No AI key and no other API are needed.

### How accurate is a Private Company Research Agent memo?

Every number in a Private Company Research Agent memo names the Crustdata field and date behind it, so it can be checked. The memo warns when headcount from profiles and the company page disagree badly (a sign another employer shares the name), when employee ratings come from fewer than 10 reviews, when the job index looks behind, and when a memo has too little data to judge. Departures are a lower bound: people who have not updated their profile are missed.

### Can I run Private Company Research Agent from my own code or another agent?

Yes. `npm run -s research -- acme.com --json > acme.json` writes the memo JSON (`-s` keeps npm's own lines out of it), and `memo.json` has the same data. `collect()` in [src/collect.ts](src/collect.ts) fetches and `buildMemo()` in [src/memo.ts](src/memo.ts) builds the memo, if you would rather import them. [AGENTS.md](AGENTS.md) is the guide for coding agents.

### Where does Private Company Research Agent get its data?

From [Crustdata](https://crustdata.com): its company, people, job posting and web traffic data. The agent calls only the Crustdata API (and, with `--ai`, your own AI provider).

## Commands and flags

| Command | What it does |
|---|---|
| `npm run setup` | Asks for your Crustdata key (and an optional AI key), checks them with free calls, writes `.env` |
| `npm run research -- <domain>` | One memo: `out/<domain>/memo.md` and `memo.json` |
| `npm run research -- <file.csv>` | A memo per company plus `out/<file>/comparison.md`, `comparison.csv` and, when rows were not researched, `unresolved.csv` |
| `npm run replay -- fixtures/<name>.json` | The whole run offline from saved answers: no key, no credits (`--keep` keeps the files) |
| `npm test` / `npm run typecheck` | Tests (node:test, offline) and type check |

| Flag | Effect |
|---|---|
| `--peers a.com,b.com` | Compare with these peers instead of Crustdata's competitor list (one company only) |
| `--no-peers` | Skip peers |
| `--dry-run` | List the domains and print the most the run can cost, then stop |
| `--refresh` | Fetch again even if a saved answer is newer than `CACHE_DAYS` |
| `--ai` | Add an analyst note written by your own `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (checked before anything is spent) |
| `--yes` | Run even when the estimate is above `MAX_CREDITS_PER_RUN` |
| `--json` | One company: print the memo JSON on stdout (use `npm run -s` to keep npm's lines out) |

Exit codes: `0` every company was researched; `2` some were and some were not (see `unresolved.csv`); `1` nothing was researched, the run stopped, or the command was wrong. Only one run at a time can use an `OUT_DIR`.

## Configuration

Settings live in `.env` (written by `npm run setup`; every one is described in [.env.example](.env.example)). Variables set in your shell win.

| Variable | Default | Meaning |
|---|---|---|
| `CRUSTDATA_API_KEY` | (required) | Your Crustdata API key |
| `LEAVERS_LIMIT` | 25 | Former staff read per company, 0.23 credits each; 0 skips departures |
| `PEERS_LIMIT` | 5 | Peers per company, 0.63 credits each; 0 skips peers |
| `MAX_CREDITS_PER_RUN` | 150 | A run estimated above this needs `--yes`; 0 turns the check off |
| `CACHE_DAYS` | 7 | Days a saved answer is reused for free; 0 turns the cache off |
| `PEOPLE_DETAIL` | all | `leaders` names only founders, executives and leaders in memos; other former staff appear by role and month only |
| `OUT_DIR` | out | Where memos are written |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | (empty) | Only for `--ai` |
| `ANTHROPIC_MODEL`, `OPENAI_MODEL` | (newest general model) | Pin the model `--ai` uses |

## Data and security

Your Crustdata key stays in `.env` (owner-only) and is sent only to `api.crustdata.com`. Memos, comparisons and saved answers are written owner-only to `out/` on your machine; `out/.cache` holds the raw API answers for `CACHE_DAYS`. Memos include names, past employers and profile links of a company's leaders and former staff, as Crustdata returns them: treat them as you would any diligence notes, and set `PEOPLE_DETAIL=leaders` to name only leaders. Text from the data (names, titles, headlines) is escaped in markdown, and CSV cells that start like a formula are prefixed so a spreadsheet does not run them. See [SECURITY.md](SECURITY.md).

## Customize

[docs/customize.md](docs/customize.md) covers the common changes with the file and function to edit: red-flag thresholds, which titles count as leaders, the founder-call questions, the peer rules, the comparison columns, the AI note instructions, and running it on a schedule.

## Project structure

```text
src/
  cli.ts          npm run research: arguments, estimate, the credit guard, one run per folder, files
  collect.ts      fetches one company: identify, enrich, departures, jobs, peers (cached by request)
  crustdata.ts    the Crustdata API client: plain REST, paced under the rate limits, retries
  sanitize.ts     coerces API answers into the shapes the memo reads, so odd data cannot crash a run
  memo.ts         the memo: facts with sources, red flags, signals, questions (pure, no I/O)
  render.ts       memo.md, comparison.md and comparison.csv (pure)
  input.ts        domains, CSV exports, plain lists, links that are not websites (pure)
  cache.ts        saved answers in out/.cache for CACHE_DAYS
  ai.ts           the optional analyst note (--ai)
  setup.ts        npm run setup
  replay.ts       npm run replay, offline
  fake-api.ts     the stand-in Crustdata API for replay and tests
  entry.ts        runs a file only when it is the program started, never when imported
  config.ts       settings from .env
  types.ts        the API shapes this agent reads
fixtures/         made-up companies for replay and tests
prompts/          analyst-note.md, the instructions for --ai
docs/             how-it-works.md, customize.md
test/             node:test, offline
```

## Built on Crustdata

[Crustdata](https://crustdata.com) is a B2B data API for company and people data: 1B+ profiles and 60M+ companies with headcount by department over time, funding, web traffic, job postings and employment history, built for AI agents. This agent uses [Company Identify](https://docs.crustdata.com/company-docs/identify/introduction), [Company Enrich](https://docs.crustdata.com/company-docs/enrichment/introduction), [People Search](https://docs.crustdata.com/person-docs/search/introduction), [Job Search](https://docs.crustdata.com/job-docs/search/introduction) and [Company Search](https://docs.crustdata.com/company-docs/search/introduction). More open-source agents on Crustdata are in [github.com/crustdata/tools](https://github.com/crustdata/tools).

MIT licensed.
