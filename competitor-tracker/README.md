# Competitor Tracker

**Competitor Tracker is an open-source competitor tracking and competitive intelligence agent built on Crustdata.** Once a week it answers one question: what did my competitors do this week? You list the companies you compete with. It checks each one for six kinds of change (launches and pricing changes, money and news, customers, hiring, headcount and posts), keeps the changes that matter, and sends one digest to Slack, email or a markdown file. Every line from a page, post, job or article links to it; headcount lines are labelled as Crustdata company data. [Crustdata](https://crustdata.com), a B2B company and people data API with 60M+ companies and 1B+ people, does the watching: three Crustdata watchers catch new jobs, announcement posts and company changes, and Crustdata Web Fetch and Web Search read competitor websites and the news. TypeScript, no server, no AI key, MIT licensed. A self-hosted alternative to Klue, Crayon and Kompyte for the weekly "what changed" digest.

<img src="assets/digest-email.png" width="820" alt="Weekly competitor digest email, Oct 19 to Oct 26, 2026, for two sample competitors: Northwind added an Agents page, the Pro plan went from 10k to 20k credits, 2 new logos and a case study, a $40M Series B, 15 new postings up from about 3 a week, engineering up 25% since Sep 28, and the CEO posted that they crossed $10M ARR. Contoso had a quiet week. Lines link to their source; headcount lines are Crustdata company data; the footer shows the run cost 8 credits plus 24.5 billed by the watchers">

**Contents:** [What it reports](#what-does-competitor-tracker-report) · [How to build a competitor tracking agent](#how-do-i-build-a-competitor-tracking-agent) · [Alternative to Klue and Crayon](#open-source-alternative-to-klue-crayon-and-kompyte) · [Quickstart](#quickstart) · [Run it every week](#how-do-i-run-competitor-tracking-every-week) · [Send the digest to Slack or email](#send-the-competitor-digest-to-slack-or-email) · [How it decides what matters](#how-does-competitor-tracker-decide-what-matters) · [How it works](#how-it-works) · [How fresh is the data?](#how-fresh-is-the-data) · [Cost](#how-much-does-competitor-tracking-cost) · [Limits](#limits) · [Competitor tracking API](#competitor-tracking-api) · [FAQ](#faq) · [Configuration](#configuration) · [Commands](#commands) · [Data and security](#data-and-security) · [Customize](#customize) · [Project structure](#project-structure) · [Built on Crustdata](#built-on-crustdata)

## What does Competitor Tracker report?

Competitor Tracker sends one heading per competitor with six sections under it, one line per change: what changed, why it matters, and its source. A section with nothing new says so in one line, and a competitor with nothing new at all gets one line. Competitors with news come first.

| Section | What counts | Example line | Source |
|---|---|---|---|
| Launches | New product, feature, integration or docs pages; pricing changes; new changelog entries | Pricing changed (Pro): "10k credits included" is now "20k credits included" | Crustdata Web Fetch, compared week to week |
| Money and news | Funding rounds, acquisitions, new investors, press | Raised Series B ($40M) on Oct 21, 2026 | Crustdata Company Entity Watcher and Web Search |
| Customers | New logos on the homepage or customers page, new case studies | 2 new logos on the homepage: Hooli, Stark Industries | Crustdata Web Fetch, compared week to week |
| Hiring | New postings by department and place, jumps or drops in posting rate, senior roles | 15 new postings, up from about 3 a week: 14 sales roles (10 in London) | Crustdata Job Watcher |
| Headcount | Total up or down 5% or more, a department up or down 20% or more | Engineering up 25% since Sep 28 (60 to 75) | Crustdata Company Entity Watcher |
| Posts | Company page and staff posts that announce a launch, a customer, a figure or a round | CEO posted: "We just crossed $10M ARR, with 1,200 customers" | Crustdata Social Post Watcher |

A number only appears when a page, post or record states it, quoted with its source. The one figure the agent works out itself is the usual weekly hiring rate, an average of past weeks.

## How do I build a competitor tracking agent?

To build a competitor tracking agent, resolve each competitor to a company with Crustdata, save a starting point (their key pages and company record), create Crustdata watchers that catch new jobs, posts and company changes, and once a week read what the watchers caught, compare each competitor's pages with last week, search the news, and send one digest. [Competitor Tracker](https://github.com/crustdata/tools/tree/main/competitor-tracker) does all five steps in TypeScript, with no AI key:

1. **Resolve each competitor.** [Company Identify](https://docs.crustdata.com/company-docs/identify/introduction) (`POST /company/identify`) turns `attio.com` into a Crustdata company id (free).
2. **Save the starting point.** Fetch the homepage with [Web Fetch](https://docs.crustdata.com/web-docs/fetch/introduction) (`POST /web/enrich/live`, 1 credit per page), pick the pricing, changelog, customers, blog and integrations pages from its links, fetch those, and keep their visible text. Pull one [company record](https://docs.crustdata.com/company-docs/enrichment/introduction) for headcount by department and funding (2 credits).
3. **Create three watchers with no delivery channel.** A [Company Entity Watcher](https://docs.crustdata.com/watcher-docs/company/entity) for headcount, funding and news changes, a [Job Watcher](https://docs.crustdata.com/watcher-docs/job/watch) for new postings, and a [Social Post Watcher](https://docs.crustdata.com/watcher-docs/social-post/discovery) for posts by the company or its staff that contain announcement words. The job and post watchers check daily and the company watcher weekly, all early in the morning UTC; the first run is a free baseline.
4. **Every week, collect.** Read each watcher's finished runs (`GET /watch/{dataset}/{id}/runs`, then the run summary's NDJSON download), fetch the pages again and compare the text, and run one [Web Search](https://docs.crustdata.com/web-docs/search/introduction) news query per competitor.
5. **Judge and send.** Keep what matters (rules below), order it, save it, and post one digest.

The post watcher at the heart of it, for one competitor:

```bash
curl -X POST https://api.crustdata.com/watch/social_post/search \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "filters": { "op": "and", "conditions": [
      { "field": "date_posted", "type": "=>", "value": "now-3M" },
      { "op": "or", "conditions": [
        { "op": "and", "conditions": [
          { "field": "actor.actor_type", "type": "=", "value": "company" },
          { "field": "actor.crustdata_entity_id", "type": "=", "value": 664000 } ] },
        { "op": "and", "conditions": [
          { "field": "actor.actor_type", "type": "=", "value": "person" },
          { "field": "actor.company_name", "type": "=", "value": "Attio" } ] } ] },
      { "op": "or", "conditions": [
        { "field": "text", "type": "[.]", "value": "introducing" },
        { "field": "text", "type": "[.]", "value": "M ARR" },
        { "field": "text", "type": "[.]", "value": "we raised" } ] } ] },
    "config": {
      "trigger": { "type": "interval", "every_hours": 24 },
      "preferred_hour": 6,
      "max_results_per_run": 29 },
    "notifications": []
  }'
```

`"notifications": []` makes it a pull-only watch: nothing is pushed anywhere, and the agent reads the runs when it builds the digest. Swap in `[{ "type": "slack", "webhook_url": "https://hooks.slack.com/..." }]` and Crustdata posts each matching post straight to Slack with no code at all. Use Competitor Tracker when you want all six sections in one weekly digest, website and pricing changes, and the judgement calls below.

## Open-source alternative to Klue, Crayon and Kompyte

Competitor Tracker is a free, MIT-licensed, self-hosted alternative to Klue, Crayon and Kompyte for the weekly "what did my competitors do" digest. It is not a battlecard or win/loss tool.

| | Competitor Tracker | Klue, Crayon, Kompyte |
|---|---|---|
| Website, pricing and changelog changes | Yes, visible text compared week to week | Yes |
| Pages watched per competitor | 6 by default, up to 10 | Many, often site-wide |
| Hiring by department and place, headcount by department | Yes, from Crustdata's company and job data | Yes (varies by plan) |
| Funding, acquisitions, press | Yes | Yes |
| Company and staff posts that announce something | Yes | Yes (varies by plan) |
| Weekly digest in Slack, email or markdown | Yes | Yes |
| Analyst or AI curation, search across past items, CRM sharing | No | Yes |
| Battlecards, win/loss, sales enablement | No | Yes |
| How fast | Weekly digest; hiring, posts and funding can reach it up to a few weeks after they happen | Daily or real-time alerts |
| Hosting | Your laptop, a cron job or GitHub Actions | Their cloud |
| Price | Crustdata credits per page, search and item found ([cost](#how-much-does-competitor-tracking-cost)) | Annual contracts |

## Quickstart

You need Node 22.13 or newer and a [Crustdata API key](https://app.crustdata.com) (new accounts get free credits). Slack and email are optional.

```bash
git clone https://github.com/crustdata/tools
cd tools/competitor-tracker
npm install
```

See a sample digest first, with no key and nothing spent (a week for two made-up competitors):

```bash
npm run replay -- fixtures/busy-week.json
```

`fixtures/` also has `quiet-week.json`, `first-run.json` and `edge-cases.json`. Then set it up for real:

```bash
npm run setup     # key, competitors, Slack or email; writes .env and competitors.json
npm run init      # starting point + three watchers; shows the cost and asks first
npm run digest    # the first digest: posts, jobs, funding and news from the last 7 days
```

`npm run setup` checks your key, shows what Crustdata knows about each competitor, and asks what each one makes in a word or two (so news about "Twenty" the CRM is told apart from the number twenty). To preview a digest without saving or sending anything, run `npm run digest -- --dry-run` (it still pays for the pages and news searches).

Posts need Social Post Search, which Crustdata enables per account on request. Without it, Competitor Tracker skips the Posts section and says so; every other section works.

## How do I run competitor tracking every week?

Competitor Tracker's digest is one command, `npm run digest`, run once a week; the Crustdata watchers run on their own in your Crustdata account. Three ways to schedule it:

- **GitHub Actions (nothing to host).** Follow [docs/deploy.md](docs/deploy.md#github-actions-recommended-nothing-to-host): it copies the tracker into your own private repo with `npx degit crustdata/tools/competitor-tracker`, adds [the weekly workflow](examples/github-actions-weekly.yml) and your `CRUSTDATA_API_KEY` secret. Each Monday it sets up anything missing, sends the digest, and commits its state back so next week can compare.
- **Cron on a machine that is always on.** Use the full path of npm (run `which npm`): `0 8 * * 1 cd /path/to/competitor-tracker && /opt/homebrew/bin/npm run digest >> digest.log 2>&1`. A laptop that is asleep at that time skips the run.
- **A scheduled container.** The `Dockerfile` sets up anything missing, runs one digest and exits; schedule it on Railway or Fly.io with a volume at `/app/data`. Steps: [docs/deploy.md](docs/deploy.md).

Each digest covers the time since the last one, so a skipped week is caught up the next time (hiring rates are worked out per week). The job and post watchers check daily at about 06:00 UTC and the company watcher weekly, so a Monday 08:00 digest has the latest of each; a watcher that has not run since the last digest is named in its section rather than reported as quiet. Running the digest more often adds page and news checks, not faster hiring or post data.

## Send the competitor digest to Slack or email

Competitor Tracker sends one weekly digest of each competitor's launches, pricing changes, funding and news, hiring, headcount and announcement posts, built from Crustdata data, to a Slack channel, an email list or a markdown file.

- **Slack:** api.slack.com/apps > Create New App > From scratch > name it and pick your workspace > Incoming Webhooks > turn on Activate > Add New Webhook to Workspace > pick a channel > Copy. Paste the URL into `npm run setup` (or set `SLACK_WEBHOOK_URL`); `npm run test-slack` posts a test message. The digest arrives as one message: competitors with news in full, quiet ones together on one line.
- **Email:** set `RESEND_API_KEY`, `DIGEST_EMAIL_FROM` (on a domain verified in [Resend](https://resend.com)) and `DIGEST_EMAIL_TO` (comma separated). The email is the same digest as simple HTML, with a plain-text copy.
- **Markdown:** always written to `digests/YYYY-MM-DD.md` and printed. On GitHub Actions the file is committed, so the repo keeps every past week.
- **If a send fails:** the digest is saved first, so nothing is lost. Fix the channel and run `npm run resend`; the next `npm run digest` also resends it before building a new one. Every digest a channel missed in the last 8 weeks is resent, oldest first, and a Slack send that stopped halfway carries on from the message it stopped at; anything older is in `digests/`.

## How does Competitor Tracker decide what matters?

Competitor Tracker uses written rules, not a model, to decide what goes in the digest:

- **Only what the source says.** A revenue or customer number appears only when a post or page states it, quoted with a link.
- **Websites:** compares visible text, never the code, so a redesign with the same words is not a change. Skips navigation, scripts, hidden elements, translations (`/fr/`, `/de/`), legal pages and pages over 400,000 characters of text. Links are compared without tracking parameters. A page that shows a bot check or comes back mostly empty is not compared that week. On blogs, only new posts with launch wording count.
- **Pricing:** a price or plan line whose figures moved is reported as `"X" is now "Y"`, under the plan it belongs to; a plan whose only price line was reworded counts too. New plan lines are reported as new, and a removed plan or price line (a dropped free tier) as removed. Outside the pricing page, only lines with money in them count (a visitor counter is not a price).
- **Hiring:** reports the change, never the total: postings from the last 30 days that are new since the last digest, by department and in your places; "up from about N a week" when the week is at least double the usual rate and "down from" when it is half or less (for a usual rate of 4 a week or more); senior roles by title; and fewer new listings when the 30-day count drops by 40% or more (and by at least 5).
- **Headcount:** total up or down 5% or more, or a department up or down 20% or more (departments under 5 people are ignored), compared with a company record about a month old, so steady growth adds up and is reported. The line names the date of that record ("since Sep 28"), because company records refresh every 1 to 30 days.
- **Posts:** keeps posts that announce a launch, a customer, a figure or a round. A staff post counts only when it speaks for the company ("we", "our" or the company's name), so "Contoso just raised" posted by a competitor's employee, or "congrats to our customer on their Series A", is not reported as their funding. Drops reposts, questions, personal news and event promotions. Shows the poster's title, not their name. The words are in [config/post-keywords.json](config/post-keywords.json).
- **News:** an article counts when it names the competitor's website, the competitor with what they make, or (for a capitalised name) the competitor next to a business word such as founder, raises or API. Listing pages, roundups ("top 10"), comparisons, reviews and share-price stories are dropped, and press about a round that already has its own line is folded into it.
- **Order:** inside each competitor, launches and money first, then customers, hiring, headcount and posts.
- **Never twice:** every post, job, article link and funding event is reported once, and a headline is remembered, so the same headline from another outlet next week is not news again (a reworded headline can still appear). A digest is saved in one step with everything it marks as reported, so a crash, a dry run or a rejected key leaves nothing half done.

## How it works

```text
npm run init (safe to re-run: only what is missing is set up or paid for)
  POST /company/identify             resolve each domain (free)
  POST /web/enrich/live              homepage + linked pages, 6 by default (1 credit each)
  POST /company/enrich               headcount by department, funding (2 credits each)
  GET  /watch/company, .../search    reuse a matching watcher already on the account (free)
  POST /watch/company                company changes, weekly, pull-only
  POST /watch/job/search             new jobs (last 30 days), daily, pull-only
  POST /watch/social_post/search     announcement posts by them or staff, daily, pull-only

npm run digest (weekly)
  GET  /account/credits              stop early on a rejected key or an empty account (free)
  GET  /watch/{dataset}/{id}         is each watcher on, and has it run since last time? (free)
  POST /web/enrich/live              the same pages again, compared with last week
  POST /web/search/live              one news query per competitor, since the last digest
  GET  /watch/{dataset}/{id}/runs    finished runs of each watcher not read yet
  GET  .../runs/{run}/summary        signed link to the run's records (NDJSON)
  POST /job/search (limit 0)         listings posted in the last 30 days (free)
  first digest only: POST /job/search, POST /social_post/search for the last 7 days
```

Every request and response, in order, with cost: [docs/how-it-works.md](docs/how-it-works.md).

## How fresh is the data?

How current each Competitor Tracker section is depends on its Crustdata source:

- **Launches, Customers, news:** fetched live from the competitor's site and the web at digest time. A pricing change made on Friday is in Monday's digest.
- **Funding and headcount:** from Crustdata company records, refreshed every 1 to 30 days. A round can reach the digest up to a few weeks after it is announced; the news search usually catches it the same week.
- **Hiring and posts:** from Crustdata's job and social post datasets, refreshed every 1 to 30 days for jobs and 1 to 45 days for posts. For a small company, a post can reach the digest a few weeks after it was published. Post lines carry the post's date and hiring lines show the range of posting dates; postings older than 30 days are left out.

## How much does competitor tracking cost?

Competitor Tracker is paid in Crustdata credits per page, search and item found. At list prices, with the default 6 pages per competitor:

| What | Credits |
|---|---|
| Starting point (`npm run init`), once per competitor | up to 8 (6 pages + 2 for the company record) |
| Direct searches for the last 7 days: on the first digest, and for a competitor added since the last digest | 0.03 per job and 0.5 per post returned, at most 15.5 per competitor |
| Catch-up searches after the competitor list or post words change (the gap of about a day while a watcher is replaced) | at most about 5 per competitor tracked |
| Each weekly digest, per competitor | 7 (6 pages + 1 news search) |
| Company watcher, per competitor whose record changed in a run | 5. A headcount change or a new news item counts, even one too small to report; at most 5 per competitor per week, typically about 5 a month |
| Job watcher, per new posting caught | 0.5 |
| Post watcher, per post caught | 2 (including posts the rules then drop; the watch words are specific phrases to keep this low) |
| Watcher baselines, recent-listing counts, credit checks | free |

One-line total: three competitors cost about 21 credits on a quiet week and about 75 on a busy one; ten competitors about 70 and 250, plus about 5 per competitor in the week its company record refreshes. The default caps (`MAX_JOBS_PER_WEEK` 500, `MAX_POSTS_PER_WEEK` 200) limit what one week can bill to about 780 credits for ten competitors; anything over a cap arrives, and is billed, on later runs, so the caps spread a busy spell rather than cut it. Our live test on three real companies used 21 credits for `init` and 17 to 18 for each digest. `npm run init` shows the estimate, the ceiling and your balance before spending anything, and every digest ends with what it cost, including what the watchers billed. Lower the cost with `PAGES_PER_COMPETITOR`, fewer words in `config/post-keywords.json`, or lower caps.

## Limits

Competitor Tracker's limits:

- Up to 50 competitors. Watchers take up to 10,000 companies, so the limit is the weekly page cost, not Crustdata.
- Up to 10 pages per competitor (`PAGES_PER_COMPETITOR`).
- Pages that need a login, or that a site only renders in a browser, may come back empty; the digest says when a page could not be fetched or compared.
- A company not in Crustdata's company index gets the website and news sections only, and the digest says so.
- Posts need Social Post Search enabled on your Crustdata account; without it the digest says so once at the top.
- Staff posts are found by employer name. For a company with an everyday name ("Twenty", "folk"), posts by people at other companies of that name can be caught and billed; the rules then drop most of them because they do not speak for your competitor.
- Watcher filters are fixed once created: adding or removing a competitor, or changing the post words, replaces the job and post watchers (the company watcher is updated in place). The old ones are paused, read one last time by the next digest (which also runs a short catch-up search for the time between the old watcher's last run and the switch, usually about a day), then deleted, so no week is lost. `npm run init` and `npm run remove` do this for you and show the cost first (after `npm run add`, run `npm run init`; until you do, the digest searches the new competitor directly and says so).

## Competitor tracking API

There is no hosted Competitor Tracker API: it is a command you run, and every signal it reports is a plain Crustdata REST call you can make from any language. For competitor headcount growth, Crustdata's `POST /company/enrich` (2 credits per company) returns `headcount.growth_percent` (`mom`, `qoq`, `six_months`, `yoy`) and `headcount.by_function_timeseries` (monthly headcount per department, such as Engineering or Sales), and a Crustdata Company Entity Watcher on `headcount.total` tells you when it moves (5 credits per changed company). For competitor hiring, `POST /job/search` filters job postings by company domain, department and place (`limit: 0` returns the count free), and a Crustdata Job Watcher delivers new postings (0.5 credits each).

```bash
curl -X POST https://api.crustdata.com/company/enrich \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{ "crustdata_company_ids": [664000], "fields": ["headcount", "funding"] }'
```

Every call is listed in [How it works](#how-it-works) and [docs/how-it-works.md](docs/how-it-works.md). The judging rules are pure functions in `src/` (`website.ts`, `hiring.ts`, `headcount.ts`, `money.ts`, `posts.ts`) that you can import into your own code.

## FAQ

### How do I track what my competitors are doing every week?

List their websites in Competitor Tracker, run `npm run init` once and schedule `npm run digest` weekly. Competitor Tracker reports their website, pricing and changelog changes, new customers, funding and news, hiring, headcount moves and announcement posts, all from Crustdata, in one digest with a source on every line.

### Is Competitor Tracker an AI agent for competitive intelligence?

Yes, in the sense that matters: Competitor Tracker runs on its own every week, decides what changed and what matters, and reports it with sources, with Crustdata watchers, Web Fetch and Web Search as its data layer. It deliberately uses no LLM. Every judgement (what counts as a pricing change, a hiring push or an announcement post) is a written rule in `src/` with a test, so the digest is repeatable, costs only Crustdata credits, cannot invent a number and needs no AI key. To add a model, pass the structured `Digest` that `runDigest` returns ([docs/customize.md](docs/customize.md#send-the-digest-somewhere-else)) to Claude or GPT for a summary or a battlecard draft; the facts stay the ones Crustdata and the competitors' pages stated.

### How do I monitor competitors' websites for changes automatically?

Competitor Tracker fetches each competitor's homepage and the pricing, changelog, customers, blog and integrations pages it links to (6 pages by default, up to 10) every week with Crustdata Web Fetch (`POST /web/enrich/live`, 1 credit per page). It compares the visible text with last week's copy and reports new product pages, changelog entries, price and plan changes, new customer logos and case studies, each with a link. It compares words, not HTML, so a redesign alone is not a change, and it skips translations, legal pages and bot-check pages. Schedule `npm run digest` weekly on GitHub Actions or cron.

### How do I monitor a competitor's pricing page for changes?

Competitor Tracker finds the pricing page from the homepage links (or you list it in `competitors.json`), fetches it each week with Crustdata Web Fetch, compares the visible text with last week, and reports any price or plan limit that moved as `"X" is now "Y"` under the plan name. New plan lines are reported too. A redesign with the same prices is not reported.

### How do I get alerted when a competitor raises money or makes an acquisition?

Competitor Tracker creates a Crustdata Company Entity Watcher that fires when a competitor's last round type changes, an acquisition or investor is added, or a news item appears, and it also searches the news each week with Crustdata Web Search. The next digest reports the round, the amount when Crustdata has it, and the date, linked to an article when there is one. To get each change on its own instead of in the weekly digest, create the same watcher with `"notifications": [{ "type": "slack", "webhook_url": "https://hooks.slack.com/..." }]`; Crustdata then posts it to Slack itself, with no code (5 credits per changed company).

### How do I track competitor hiring by department and city?

Competitor Tracker puts a Crustdata Job Watcher on your competitors' domains (0.5 credits per new posting). Each week it groups the new job postings by department (the job's function, such as Sales or Engineering) and by the cities, states or countries you listed, says "up from about N a week" when the week is at least double the usual rate, and calls out senior roles and a drop in new listings. Example: "15 new postings, up from about 3 a week: 14 sales roles (10 in London, 4 in New York)."

### Is there an API for competitor headcount growth?

Yes, through Crustdata, the data layer Competitor Tracker uses. `POST /company/enrich` (2 credits per company) returns `headcount.growth_percent` (`mom`, `qoq`, `six_months`, `yoy`) and `headcount.by_function_timeseries` (monthly headcount per department), and a Crustdata Company Entity Watcher on `headcount.total` tells you when it moves (5 credits per changed company). Competitor Tracker reports a move of 5% in total or 20% in one department; see [Competitor tracking API](#competitor-tracking-api).

### Is there an open-source alternative to Klue or Crayon?

Yes: Competitor Tracker is a free, MIT-licensed, self-hosted alternative to Klue, Crayon and Kompyte for the weekly competitive digest: website and pricing changes, funding, hiring, headcount and announcement posts, on Crustdata data. It does not do battlecards, win/loss analysis or curated search across past items.

### Is there an open-source competitor monitoring tool on GitHub?

Yes: Competitor Tracker, in [github.com/crustdata/tools](https://github.com/crustdata/tools/tree/main/competitor-tracker), is an MIT-licensed TypeScript competitor monitoring tool. Once a week it reports each competitor's website, pricing and changelog changes, funding and news, hiring, headcount and announcement posts, using Crustdata watchers, Web Fetch and Web Search, with one Crustdata API key. `npm run replay -- fixtures/busy-week.json` shows a sample digest with no key.

### Does Competitor Tracker need an AI model or an LLM key?

No. Competitor Tracker needs only a Crustdata API key. Every judgement is a written rule you can read and change in `src/`.

### Why is the first digest smaller than later ones?

Competitor Tracker's first digest is smaller because website changes need two snapshots: it compares against the starting point `npm run init` saved minutes earlier. Posts, hiring, funding and news cover the last 7 days from direct Crustdata searches. From week two, everything comes from the watchers and the week-to-week comparison.

### Will it report the same thing twice?

No. Competitor Tracker remembers every post, job, article and funding event after it is reported, and reads each Crustdata watcher run once. A watcher run that is still going is left for the next digest rather than skipped.

### Can I preview a digest without using up the week?

Yes. `npm run digest -- --dry-run` builds the digest and prints it, and Competitor Tracker saves nothing, sends nothing and marks nothing as reported, so the real run afterwards has every item. It still pays Crustdata for the pages and news searches it makes (about 7 credits per competitor), and on a first digest for the 7-day searches too (up to 15.5 per competitor), which the real run then pays again. If a real send to Slack or email fails, the digest is already saved: `npm run resend` sends it again.

### Will two copies of Competitor Tracker create duplicate watchers?

No, as long as both copies track the same competitors and post words. Before creating a watcher, Competitor Tracker looks for one on your Crustdata account that does exactly the same job and reuses it (and marks what it caught earlier as read), so running `init` on a laptop and then on GitHub Actions does not double the bill. Make changes to the competitor list in one place, the repository, and push before the next run.

### How many competitors can Competitor Tracker track?

Competitor Tracker tracks up to 50 competitors (a Crustdata watcher takes up to 10,000 companies, so the limit is the weekly page cost); most people track 3 to 20. Cost grows with the number of pages per competitor; see [cost](#how-much-does-competitor-tracking-cost).

### Do I need to run a server?

No. Competitor Tracker is one command a week. GitHub Actions, a cron job or a scheduled container all work; the Crustdata watchers live in your Crustdata account, and the agent reads them when it runs.

### What happens if I skip a week?

Competitor Tracker's next digest covers everything since the last one: the Crustdata watchers keep their runs, the pages are compared with the last saved version, and hiring rates are worked out per week.

## Configuration

`npm run setup` writes `.env` and `competitors.json` for you, or copy `.env.example` to `.env` and [competitors.example.json](competitors.example.json) to `competitors.json` by hand. Only `CRUSTDATA_API_KEY` is required.

| Variable | Default | What it does |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Crustdata API key (required) |
| `COMPETITORS_FILE` | `./competitors.json` | Your competitors, their pages, what they make, and your places |
| `SLACK_WEBHOOK_URL` | | Slack incoming webhook for the digest |
| `RESEND_API_KEY`, `DIGEST_EMAIL_FROM`, `DIGEST_EMAIL_TO` | | Email through Resend (all three, or none) |
| `PAGES_PER_COMPETITOR` | `6` | Pages compared per competitor each week, 1 to 10, 1 credit each |
| `MAX_POSTS_PER_WEEK` | `200` | Most posts the post watcher delivers in a week, spread over its daily runs (2 credits each); more arrive on later runs |
| `MAX_JOBS_PER_WEEK` | `500` | Most jobs the job watcher delivers in a week, spread over its daily runs (0.5 credits each); more arrive on later runs |
| `SHOW_POSTER_NAMES` | `false` | Show the names of competitors' staff next to their posts (titles only by default) |
| `DB_PATH` | `./data/tracker.sqlite` | State between runs (one SQLite file) |
| `DIGEST_DIR` | `./digests` | Where the markdown digests are written |

`competitors.json`:

```json
{
  "competitors": [
    { "name": "Attio", "domain": "attio.com", "about": "CRM",
      "pages": [
        "https://attio.com/",
        "https://attio.com/pricing",
        "https://attio.com/changelog"
      ] }
  ],
  "cities": ["London", "San Francisco"]
}
```

`pages` is filled by `npm run init` from the homepage links; edit it to watch other pages. `about` is what they make, used to match news. `cities` takes cities, states or countries, written the way job posts write them.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Guided setup: checks your Crustdata key, your competitors, Slack and email; writes `.env` and `competitors.json` |
| `npm run init` | Saves the starting point and sets up the three watchers. Shows the cost and asks first (`-- --yes` to skip). Safe to re-run: only what is missing is set up or paid for |
| `npm run digest` | Builds the digest, saves it, writes it to `digests/`, sends it to Slack and email (`-- --dry-run` to preview with nothing saved or sent) |
| `npm run resend` | Sends every digest from the last 8 weeks that a channel missed (`-- --all` sends the latest digest to every channel again) |
| `npm run status` | Competitors, watchers, credits spent by each, last digest, balance |
| `npm run add -- acme.com` | Adds a competitor; run `npm run init` after to save its starting point |
| `npm run remove -- acme.com` | Removes a competitor and updates the watchers |
| `npm run pause` / `npm run resume` | Pauses or resumes the three watchers |
| `npm run delete-watches` | Cancels the watchers so nothing more is billed; your snapshots stay |
| `npm run test-slack` | Posts a test message to `SLACK_WEBHOOK_URL` |
| `npm run replay -- fixtures/busy-week.json` | Offline digest from a sample week (add `--slack` to print the Slack payload) |
| `npm test` | Runs the tests |

## Data and security

- **What goes to Crustdata:** your competitors' domains and names, and the URLs of their pages. Nothing about you or your customers. Competitor pages are fetched by Crustdata, not from your network.
- **What is stored locally:** the visible text and links of each tracked page, a reference company record per competitor, weekly job counts, watcher ids and every digest, in `data/tracker.sqlite`.
- **What the digest contains:** quotes from competitors' public posts with the poster's job title (names only with `SHOW_POSTER_NAMES`). Digests go to your Slack and to Resend when set up, and on GitHub Actions they are kept in your repo's history.
- **Your key:** only in `.env` (written with permissions 600) or your CI secrets. On GitHub Actions use a private repo, since the workflow commits `data/` and `digests/`.
- **Slack and email:** everything taken from a page, post or record is escaped, so text from a competitor's site cannot ping a channel, add a link or inject HTML.
- **Run downloads:** only followed over https from Crustdata's own storage host, with no redirects and a 50 MB limit.

## Customize

- **Change the judging rules:** `launchItems` and `customerItems` in `src/website.ts`, `hiringItems` in `src/hiring.ts`, `headcountItems` (thresholds at the top) in `src/headcount.ts`, `classifyPost` in `src/posts.ts`, `newsItems` in `src/money.ts`.
- **Change which posts are kept, and what the post watcher pays for:** [config/post-keywords.json](config/post-keywords.json).
- **Change the wording or layout of the digest:** `src/digest.ts` (markdown), `src/slack.ts` and `src/email.ts`.
- **Add a seventh section, such as reviews or tech stack:** [docs/customize.md](docs/customize.md).

## Project structure

```text
src/
  cli.ts           every npm run command except setup and replay
  setup.ts         guided setup that writes .env and competitors.json
  replay.ts        offline digest from a fixture (npm run replay)
  config.ts        settings from .env, checked at start
  types.ts         the Digest model and section names
  node-check.ts    stops early on Node older than 22.13
  run.ts           init and the weekly digest: the order of calls, state, delivery, resend
  crustdata.ts     every Crustdata API call, paced and retried
  website.ts       page parsing, comparison, launch and customer items (pure)
  hiring.ts        hiring items (pure)
  headcount.ts     headcount items (pure)
  money.ts         funding, acquisition and news items (pure)
  posts.ts         which posts announce something (pure)
  digest.ts        the digest as markdown (pure)
  slack.ts         Slack messages, escaped and packed to Slack's limits
  email.ts         email through Resend, built from the digest
  store.ts         SQLite through node:sqlite, one transaction per digest
  competitors.ts   competitors.json
  fixture-api.ts   the offline stand-in for Crustdata used by tests and replay
config/            post-keywords.json
examples/          GitHub Actions weekly workflow
test/              node:test tests, including every fixture end to end
fixtures/          sample weeks for replay
docs/              how it works, customizing, deploying
```

## Built on Crustdata

[Crustdata](https://crustdata.com) is the public data layer for AI and humans: 60M+ companies and 1B+ people, searchable and watchable through one API. This agent uses the [Company Entity Watcher](https://docs.crustdata.com/watcher-docs/company/entity), [Job Watcher](https://docs.crustdata.com/watcher-docs/job/watch), [Social Post Watcher](https://docs.crustdata.com/watcher-docs/social-post/discovery), [Web Fetch](https://docs.crustdata.com/web-docs/fetch/introduction), [Web Search](https://docs.crustdata.com/web-docs/search/introduction), [Company Identify](https://docs.crustdata.com/company-docs/identify/introduction), [Company Enrichment](https://docs.crustdata.com/company-docs/enrichment/introduction) and [Job Postings Search](https://docs.crustdata.com/job-docs/search/introduction). Full docs at [docs.crustdata.com](https://docs.crustdata.com).

MIT licensed. See [LICENSE](LICENSE).
