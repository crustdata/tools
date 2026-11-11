# Crustdata Tools: open-source AI agents and data tools built on the Crustdata API

**Working code for building AI agents on [Crustdata](https://crustdata.com), the B2B data API with 1B+ profiles and 60M+ companies.** Each folder is a complete agent you can clone and run with one Crustdata API key: TypeScript, MIT licensed, with a README that explains how to build the same thing yourself, every API request it makes, and what it costs.

If you are asking "how do I build an AI agent that finds companies, researches an account or a person before a meeting, finds people and buying signals, sources candidates for a role, verifies candidates' work history or detects fake job candidates, finds AI researchers at frontier labs and maps their teams, sources startups for a VC fund, monitors a fund's portfolio companies, finds jobs and the recruiter, hiring manager and alumni behind each one, or tracks when contacts change jobs or what competitors did this week", start here.

## The agents

| Agent | What it does | Crustdata APIs |
|---|---|---|
| [Company Researcher](company-researcher/) | Type a company domain or name; get a research brief with headcount by department and location over two years, hiring, executives with start dates, funding, web traffic, tech stack, news and three questions to ask on a sales call. Web app, JSON API and CLI. Live at [crustdata-researcher.vercel.app](https://crustdata-researcher.vercel.app) | Company Identify, Company Enrich, Job Search |
| [Prospecting Agent](prospecting-agent/) | Describe your ideal customer in one plain-English sentence; get the matching companies and the decision-makers at each as CSV, plus a Crustdata watcher request that tells you in Slack or email when those accounts raise, hire or grow | Company Search, Person Search, Autocomplete, Watchers |
| [Job Change Alert Bot](job-change-alert-bot/) | Give it a CSV or CRM export of champions or contacts; it posts in Slack when one moves to a new company, gets a new title or leaves, with the account owner, per-rep routing and a daily digest. A self-hosted alternative to UserGems and Champify | Person Identify, Person Watcher |
| [Competitor Tracker](competitor-tracker/) | List your competitors' websites; once a week get one digest in Slack, email or markdown of what each did: website and pricing changes, new customers, funding and news, hiring by department and place, headcount moves and announcement posts, each with its source. A self-hosted alternative to Klue, Crayon and Kompyte for the weekly "what changed" digest | Company Identify, Company Enrich, Company Watcher, Job Watcher, Social Post Watcher, Web Fetch, Web Search |
| [Clay Alternative](clay-alternative/) | Drop a CSV of work emails, company domains or profile URLs; get person and company columns (title, current company, location, headcount, industry, funding, last round, open roles, tech stack) filled in from Crustdata records and exported as CSV. An open-source, self-hosted alternative to Clay and fire-enrich: one key, no AI key, a credit estimate before the run, a CLI with a cache that never pays twice. Web app, JSON API and CLI | Company Identify, Company Enrich, Person Enrich, Person Search |
| [Candidate Sourcing Agent](candidate-sourcing-agent/) | Describe a role in one plain-English sentence; get a ranked shortlist of candidates with the reason for every score, as CSV and markdown, from Crustdata semantic people search inside hard filters. Every later run skips the people you already pulled, and Crustdata does not bill them again. An open-source AI recruiter for the sourcing step and a self-hosted alternative to SeekOut, hireEZ and Juicebox. CLI, no AI key | Person Search (semantic search), Autocomplete, Person Contact Enrich (optional), Person Watcher |
| [AI Researcher Finder](ai-researcher-finder/) | Name the labs (OpenAI, Anthropic, Google DeepMind or any other) or start from people's work (Google Scholar profiles, GitHub profiles, paper titles); get the research scientists, research engineers and ML engineers Crustdata finds there, a team map per lab (stated or inferred, with the evidence) and a score against your own rubric (papers, citations, h-index, team) with the evidence behind every point, as CSV and markdown. An open-source AI talent mapping tool and a self-hosted alternative to SeekOut, hireEZ and Juicebox for AI research talent. CLI, no AI key | Company Identify, Person Search (semantic search, research profiles), Person Identify (Google Scholar URLs), Dev Platform Enrich (GitHub, optional) |
| [Candidate Verification Agent](candidate-verification-agent/) | Give it a candidate list exported from Greenhouse, Lever, Ashby, Workable or a spreadsheet; for each candidate it checks whether the current role on their profile is real and returns your list with a verdict, a confidence score, the reasons and the web sources, doubtful candidates first, plus a report and an optional Slack summary. An open-source candidate fraud detection tool for spotting fake job candidates before the first screen, used next to (not instead of) identity and background checks. About 11 credits a candidate, CLI, no AI key | Batch Person Verification, Person Enrich, Person Identify |
| [Deal Sourcing Agent](deal-sourcing-agent/) | Describe an investment thesis in plain English; get a scored pipeline of startups with founders and a one-page memo each, as CSV and markdown, scored on founder background (repeat founders, past employers, schools), headcount growth, hiring, founders' posts about traction and round timing combined with growth. Re-runs mark new, back and gone companies. A self-hosted alternative to Harmonic, Specter, Crunchbase Pro and PitchBook for sourcing | Company Search, Person Search, Job Search, Social Post Search, Autocomplete |
| [Person Researcher](person-researcher/) | Give it a profile URL, a work email or a name and company, or a whole meeting or CSV export; get a one-page brief per person to read before a sales call, an interview or an investor meeting: what changed lately, their newest posts, news, their company, career with dates and education, with the source of each section. An open-source meeting prep agent. CLI and JSON, no AI key | Person Enrich, Person Identify, Person Search, Social Post Search, Web Search |
| [VC Portfolio Monitor](vc-portfolio-monitor/) | Give it a fund's portfolio as a CSV or Google Sheet; it posts to Slack (one channel, or one per partner) when a portfolio company's headcount drops or a team shrinks, a founder or executive leaves, the CEO changes, hiring stops or jumps on its careers page, a round or a bridge closes, or it is in the news for layoffs, a sale or a shutdown, each with why it matters, plus a weekly digest to Slack and email. A self-hosted alternative to the portfolio monitoring in Harmonic, Affinity and Visible. CLI, no AI key | Company Identify, Company Enrich, Person Search, Person Enrich, Company Watcher, Person Watcher, Web Fetch, Job Search |
| [Job Hunt Agent](job-hunt-agent/) | Give it your CV and a search ("software engineer near San Francisco"); get open jobs scored against the CV with every point explained, checked still open on Greenhouse, Lever, Ashby and SmartRecruiters, and for each the likely recruiter, the likely hiring manager, up to 3 people on the team and alumni from your school, with the company's headcount growth and last round. Drafts one outreach note per person and never sends or applies. About 18 Crustdata credits a run at list price, about 3 for one job. An open-source AI job search agent and a self-hosted alternative to career-ops, Simplify, Teal and Huntr. CLI, local dashboard and Claude Code skills, no AI key | Job Search, Company Search, Person Search, Autocomplete, Person Contact Enrich (optional) |

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

## How do I build an AI candidate sourcing agent?

Send the role as one plain-English sentence to Crustdata's `POST /person/search` as a semantic `search.query` (`search.mode: "hybrid"`), with the top-level `mode: "exact"` so the must-haves (place, years, skills, company size) stay hard filters, and check every filter value with the free `POST /person/search/autocomplete` first. Score each candidate with rules that give a reason for every point, and send everyone already pulled as `post_processing.exclude_profiles`, so later runs return only new people and Crustdata does not bill the same person twice. [Candidate Sourcing Agent](candidate-sourcing-agent/) is that method in TypeScript: from one sentence to a ranked shortlist as CSV and markdown, without an AI key. A 20-candidate search costs about 11 Crustdata credits at list price, and `--dry-run` shows the cost on your account first, for free.

## How do I build an AI recruiter that finds candidates?

An AI recruiter does three jobs: source, reach out, screen. For sourcing, use [Candidate Sourcing Agent](candidate-sourcing-agent/): it runs Crustdata's semantic person search over 1B+ profiles inside your hard filters, scores every candidate with readable rules, skips everyone you already pulled, and never searches, filters or scores on age, gender or other protected characteristics. Personal emails for the top candidates are optional and need contact data enabled on your Crustdata account. For outreach, the [Crustdata candidate-sourcing skill](https://github.com/crustdata/skills/tree/main/skills/candidate-sourcing) drafts messages inside Claude. For AI researchers and ML engineers at AI labs, [AI Researcher Finder](ai-researcher-finder/) adds Google Scholar and paper title seeds, a team map per lab, and papers, citations and h-index in the score.

## How do I find AI researchers at frontier labs?

To find AI researchers at frontier labs such as OpenAI, Anthropic and Google DeepMind, turn each lab into a Crustdata company id with the free `POST /company/identify`, then run one `POST /person/search` per lab with the role as a semantic `search.query` (`search.mode: "hybrid"`), the company id and a group of research titles as hard filters (top-level `mode: "exact"`), and `research_profiles` returned for papers, citations, h-index and co-authors. Many top researchers keep thin profiles, so add the people behind their work too: Google Scholar URLs through `POST /person/identify` (`research_profile_urls`) and paper titles through a search on `research_profiles.articles.title`. [AI Researcher Finder](ai-researcher-finder/) is that method in TypeScript, an open-source AI talent mapping tool: 25 people across 8 frontier labs cost at most about 21 Crustdata credits at list price, every person gets a score against your own rubric with the evidence for every point, and it needs no AI key.

## How do I map who works on which team at an AI lab?

Run `npm run map -- --lab anthropic.com` (or `openai.com`, `deepmind.google`) in [AI Researcher Finder](ai-researcher-finder/). It pulls up to 100 of the lab's research and ML staff from Crustdata and puts each person on a team (Pretraining, Post-training and RL, Inference, Alignment and safety, Interpretability and more): "stated" when their title, role description or headline names it, "inferred" from recent paper titles, research interests, past roles and co-authors on that team, with the evidence under each person. On a live 40-person map of one lab, 14 teams were stated, 14 inferred and 12 not stated.

## How do I find who wrote a paper, or who is behind a Google Scholar profile?

Send the Google Scholar URL to Crustdata's `POST /person/identify` with `research_profile_urls` (an exact match on the profile's `user` id; 1 credit per match, free when not found), and search a paper title on `research_profiles.articles.title` with `POST /person/search` to get its authors with their current employer and title. [AI Researcher Finder](ai-researcher-finder/) does both from `--scholar`, `--paper` or a CSV of links and titles, keeps only authors whose publication list has that exact paper, and adds each person to the team map and the scored list. Research profiles are enabled per Crustdata account.

## How do I build a candidate verification agent?

Read the candidate list from your ATS export, resolve each candidate to a profile URL (emails through Crustdata's `POST /person/identify`, using only a single exact match), send the profiles to Crustdata's Batch Person Verification API (`POST /batch/person/verify`) in jobs of up to 10 with at most 5 running at once, poll `GET /batch/{batch_id}` until it is `completed`, and read one verdict per person from the gzipped JSON lines file it links to. Crustdata checks job dates against study dates, whether people who engage with the candidate's recent posts work at the claimed employer, and the web for independent evidence of the current role, and returns a verdict, a confidence score, reasoning and sources. [Candidate Verification Agent](candidate-verification-agent/) is that method in TypeScript, an open-source way to detect fake job candidates: it sorts your list so the doubtful candidates come first, never pays twice for a job (even when a run stops part way), costs about 11 credits a candidate (1 with the quick screen) and needs no AI key. A verdict is evidence for a person to review, not a hiring decision.

## How do I detect fake job candidates?

Run your applicant export through [Candidate Verification Agent](candidate-verification-agent/) before the first screen. For each candidate it asks Crustdata's Batch Person Verification API whether the current role on their profile is real: job dates against study dates, whether people who engage with the candidate's posts work at the claimed employer, and the web for independent evidence. You get your list back sorted so contradicted and unsupported profiles come first, each with the reasoning and source links, for about 11 credits a candidate. It does not check identity documents or replace a background check, and a verdict is evidence for a person to review, never a hiring decision on its own.

## How do I build a VC deal sourcing agent?

Send the investment thesis as a ranked query to Crustdata's `POST /company/search` (`search: { query, mode: "hybrid" }`) with hard filters for stage, founding year, size, place and investors, find each company's founders with `POST /person/search` filtered on their current company and a founder title, add free counts of roles posted from `POST /job/search` and of founders' posts about revenue or a round from `POST /social_post/search`, then score with rules (founder background first, then growth, hiring and round timing) and write a one-page memo per company. [Deal Sourcing Agent](deal-sourcing-agent/) is that method in TypeScript: about 21 Crustdata credits for 10 companies at list price, without an AI key.

## How do I find startups that are about to raise their next round?

Combine round timing with growth. Crustdata company data has the last round's type and date, so a startup 12 to 24 months after a seed (6 to 15 after a pre-seed, 18 to 30 after a Series A or later) is in the window; it counts as due only with recent growth in headcount, roles posted, followers or founders' posts about traction, so a company that raised two years ago and went quiet is not. [Deal Sourcing Agent](deal-sourcing-agent/) labels every company "Due and growing", "Due, some growth", "Due but quiet" or "May have just raised" (a founder posted about a round the funding data does not show yet), with the reason in each memo.

## How do I build a VC portfolio monitoring agent?

Resolve each portfolio company with Crustdata's `POST /company/identify` (free), save a starting point with `POST /company/enrich` (headcount, its 6-month change, headcount by department, last round), find the founders and C-level with `POST /person/search`, then put the companies on a Crustdata company watcher (`POST /watch/company` on headcount, funding and news) and the leaders on a person watcher (`POST /watch/person` on their roles), both with no delivery channel so your code reads the runs. Read each careers page weekly with `POST /web/enrich/live` to count open roles, and every day turn what changed into alerts with thresholds that need a percentage and a count. [VC Portfolio Monitor](vc-portfolio-monitor/) is that method in TypeScript: about 45 Crustdata credits once for ten companies, then about 105 to 320 a month, without an AI key.

## How do I get alerted when a founder leaves a portfolio company?

Put the founders' and executives' profile URLs on a Crustdata person watcher (`POST /watch/person`, up to 10,000 people per watch) that tracks `experience.employment_details` and `basic_profile.current_title`. The first run is a free baseline; after that it bills 5 credits per changed person at 30-day freshness. [VC Portfolio Monitor](vc-portfolio-monitor/) does this for every portfolio company's founders and C-level, counts a departure only with evidence (an end date at the company, or a new main job elsewhere), and posts "Founder left", "CEO change" or a move to advisor or chair to the owning partner's Slack channel, with why it matters.

## How do I build a person research agent?

Resolve the person to a profile with Crustdata: a work email or profile URL goes straight to `POST /person/enrich` (roles with dates, education, skills, the current company's size and industry; 1 credit, misses free), a personal email to `POST /person/identify`, a name and company to `POST /person/search`. Then pull their newest original posts with `POST /social_post/search`, search the web and the last 90 days of news with `POST /web/search/live`, work out what changed from the role dates, and lay it out as one page. [Person Researcher](person-researcher/) is that method in TypeScript: 5.5 Crustdata credits a person at list price, a whole meeting or CSV export at once, no AI key.

## How do I research someone before a meeting?

Pass their email, profile URL, or name and company (or the whole attendee list) to [Person Researcher](person-researcher/): `npm run research -- jane@acme.com` writes a brief from Crustdata data (their role, what changed in the last 6 months, newest posts, news, career, education) and an index for a meeting with several people. It is an open-source meeting prep agent; give its `--json` output to your own model for talking points.

## How do I build a job hunt agent?

Search job postings with Crustdata's `POST /job/search` (title words in any order, within 50 miles of a city or remote in a country, posted in the last 30 days, newest first; 0.03 credits a job, and a count with `limit: 0` is free). Score each posting against the skills, school and years in the CV with rules, and check the best are still open on their job board's public API. Get headcount growth for the shortlist from `POST /company/search` by `crustdata_company_id` (0.23 a company at list price). Then call `POST /person/search` at each company, ranked by a short query with top-level `mode: "exact"` so the company filter holds: the recruiter, the hiring manager and the team cost 0.23 a person, and alumni of the user's school, filtered on `education.schools.school`, 0.43 a person. Draft one note per person and let the user send it. [Job Hunt Agent](job-hunt-agent/) is that method in TypeScript: about 18 Crustdata credits at list price for 50 jobs read and people at the best 5, about 3 for one job by URL, no AI key.

## How do I find the recruiter or hiring manager for a job posting?

Paste the posting URL into [Job Hunt Agent](job-hunt-agent/): `npm run job -- "<posting URL>"` finds the posting in Crustdata's job index, then searches the people who work at that company now with Crustdata People Search. It ranks them by "technical recruiter hiring software engineers" and by the manager title for the job's line of work, in the job's country first. It returns names, titles, profile URLs and a draft note for each, plus alumni of your school who work there, for about 3 credits at list price. Job postings rarely name the manager, so that person is labelled "likely".

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
| Social Post Search | [docs](https://docs.crustdata.com/social-post-docs/indexed-search/introduction) |
| Watchers (company, person, job, social post) | [docs](https://docs.crustdata.com/watcher-docs/company/entity) |
| Batch Person Verification (is the current role real) | [docs](https://docs.crustdata.com/person-docs/verification/batch) |
| Person Identify | [docs](https://docs.crustdata.com/api-reference/person-apis/identify-people-from-profile-urls-emails-or-google-scholar-profile-urls) |
| Person Enrich (by profile URL or business email) | [docs](https://docs.crustdata.com/person-docs/enrichment/introduction) |
| Person Contact Enrich (emails and phones) | [docs](https://docs.crustdata.com/person-docs/contact/enrich) |
| Dev Platform Enrich (GitHub profile to person) | [pricing](https://docs.crustdata.com/general/pricing) |
| Web Fetch | [docs](https://docs.crustdata.com/web-docs/fetch/introduction) |
| Web Search | [docs](https://docs.crustdata.com/web-docs/search/introduction) |

## Contributing

Issues and pull requests are welcome. Each agent has its own `npm test` and `npm run typecheck`; run both in the folder you changed.

## License

MIT. See [LICENSE](LICENSE).
