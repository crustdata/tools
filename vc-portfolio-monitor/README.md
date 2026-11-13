# VC Portfolio Monitor

**VC Portfolio Monitor is an open-source VC portfolio monitoring agent built on [Crustdata](https://crustdata.com), the B2B company and people data API with 60M+ companies and 1B+ people.** A fund gives it the companies it owns, as a CSV file or a Google Sheet. It watches each company and its founders and C-level, and posts to Slack after the daily check that catches something worth knowing: headcount drops or a team shrinks, a founder or executive leaves, the CEO changes, hiring stops or jumps, a round or a bridge closes, or the company is in the news for layoffs, a sale or a shutdown. Every Monday it sends one digest of the week to Slack and email. Crustdata does the watching: two Crustdata watchers follow the companies and their leaders, and Crustdata Web Fetch reads each company's careers page. TypeScript, no server, no AI key, MIT licensed. A self-hosted alternative to the portfolio monitoring in Harmonic, Affinity and Visible.

<img src="assets/digest-email.png" width="820" alt="VC Portfolio Monitor weekly digest email for a sample fund, Example Ventures, Oct 19 to Oct 26, 2026, built on Crustdata data: Northwind Robotics headcount down 15% from 48 to 41, its sales team down 50%, and a co-founder left; Tallyhoo in the news for layoffs and no open roles on its careers page for two readings; Brightwave closed a $12M Series A and hiring jumped from 6 to 15 open roles; Quillstack's CEO is now Executive Chairman. Each line says why it matters to an investor and links its source; the footer shows 4 credits for the tool's own calls and 35 billed by the Crustdata watchers">

**Contents:** [What it alerts on](#what-does-vc-portfolio-monitor-alert-on) · [How to build a portfolio monitoring agent](#how-do-i-build-a-vc-portfolio-monitoring-agent) · [Alternative to Harmonic](#open-source-alternative-to-harmonic-affinity-and-visible-for-portfolio-monitoring) · [Quickstart](#quickstart) · [Load the portfolio](#load-your-portfolio-from-a-csv-or-a-google-sheet) · [Send alerts to Slack](#send-portfolio-alerts-to-slack) · [Run it every day](#how-do-i-run-portfolio-monitoring-every-day) · [How it decides](#how-does-vc-portfolio-monitor-decide-what-to-alert-on) · [How it works](#how-it-works) · [How fresh is the data?](#how-fresh-is-the-data) · [Cost](#how-much-does-portfolio-monitoring-cost) · [Limits](#limits) · [Portfolio monitoring API](#portfolio-monitoring-api) · [FAQ](#faq) · [Configuration](#configuration) · [Commands](#commands) · [Data and security](#data-and-security) · [Customize](#customize) · [Project structure](#project-structure) · [Built on Crustdata](#built-on-crustdata)

## What does VC Portfolio Monitor alert on?

VC Portfolio Monitor sends one line per event, grouped by company: what happened with the numbers, a sentence on why it matters to an investor, and a link to the source. Every headcount and hiring rule needs a percentage **and** a count, so a six-person company losing one person (17%) does not fire, and a 200-person company losing 20 does.

| Event | Fires when (defaults, all editable) | Example line | Source |
|---|---|---|---|
| Headcount down | Down 10% **and** 3 people from its highest reading in the last 6 months, or 25 people whatever the percentage; under 15 people, 25% and 2 | Headcount down 15% since Sep 28, 2026, from 48 to 41 (7 people fewer) | Crustdata Company Entity Watcher |
| A team shrinks | One department down 20% and 3 people, from a team of 5 or more | Sales team down 50%, from 10 to 5 (monthly department counts, Jul 2026 to Aug 2026) | Crustdata Company Entity Watcher |
| Founder or executive leaves | A watched founder or C-level ends their role at the company, or lists a new main job elsewhere that started after they were first watched | Founder left: Dana Doe (Co-Founder & CTO) no longer lists a role at Northwind Robotics; now Founder at Stealth Startup | Crustdata Person Entity Watcher |
| CEO change, or a leader steps back | The CEO drops the CEO title, or a leader becomes an advisor, board member or chair (alerts); any other new title (note) | CEO change: Rafael Loe is no longer CEO at Quillstack; now Executive Chairman. Stepped back: Uma Joe (Co-Founder, COO) is now Advisor at Cobalt Fox | Crustdata Person Entity Watcher |
| New leader | A founder or C-level who started since the last search appears in the monthly search (alert for a CEO or CFO); people who were there all along are watched quietly | New leader: Kim Roe (Chief Financial Officer) now lists a role at Brightwave | Crustdata People Search |
| Hiring stops | No open roles on the careers page for two readings in a row, after 3 or more | No open roles found on the careers page for two readings in a row (5 on Oct 12) | Careers page, read with Crustdata Web Fetch |
| Hiring jumps or slows | Open roles at least double (and 5 more) or halve (and 5 fewer) against about 4 weeks before | Hiring jumped: 15 open roles, up from 6 on Sep 28 | Careers page |
| Hiring again | 3 or more open roles after 4 weeks or more with none (good news) | Hiring again: 4 open roles after 4+ weeks with none | Careers page |
| New round | The last round type or date changes; new investors | New round: Series A, $12M (Oct 20, 2026); last round before was seed. New investors: Harbor Capital, Example Growth | Crustdata Company Entity Watcher |
| Bridge, extension or debt | Debt, a note, a smaller round type, or another round of the same stage after a priced seed round or later (a date change alone is a note) | Bridge or smaller round: a convertible note (Oct 2, 2026); last round before was Series A | Crustdata Company Entity Watcher |
| Acquired, layoffs, shutdown, down round, an executive exit | Acquired by someone, or a recent headline about the company: layoffs, cuts, a hiring freeze, shuts down, Chapter 11, a down round or slashed valuation, a CEO who steps down, resigns or is fired, "Google acquires Acme" | In the news (Oct 23): "Tallyhoo lays off 20% of staff as it refocuses on enterprise" (Example News) | Crustdata Company Entity Watcher (news) |
| Headcount up | Up 25% **and** 5 people from its lowest reading in the window | Headcount up 30% since Aug 1, 2026, from 40 to 52 | Crustdata Company Entity Watcher |
| Legal or security story | A lawsuit, an investigation, a breach (note) | In the news (Oct 23): "Acme sued by rival over patents" | Crustdata Company Entity Watcher (news) |
| Other news | Any other article that names the company | In the news (Oct 22): "Ten developer tools to watch, from Quillstack to ..." | Crustdata Company Entity Watcher (news), weekly digest only |

Alerts, good news and notes post to Slack after each daily check. Ordinary news waits for the weekly digest, which has everything.

## How do I build a VC portfolio monitoring agent?

To build a VC portfolio monitoring agent, resolve each portfolio company with Crustdata, find its founders and C-level, put the companies on a Crustdata Company Entity Watcher and the leaders on a Crustdata Person Entity Watcher, read each company's careers page once a week, and every day turn what changed into alerts with thresholds a partner would agree with. [VC Portfolio Monitor](https://github.com/crustdata/tools/tree/main/vc-portfolio-monitor) does all of it in TypeScript, with no AI key:

1. **Resolve each company.** [Company Identify](https://docs.crustdata.com/company-docs/identify/introduction) (`POST /company/identify`) turns `linear.app` into a Crustdata company id (free). A name alone works when it matches one company.
2. **Save the starting point.** One [company record](https://docs.crustdata.com/company-docs/enrichment/introduction) per company (2 credits): headcount, its 6-month change, headcount by department, last round. [People Search](https://docs.crustdata.com/person-docs/search/introduction) (`POST /person/search`) finds the founders and C-level.
3. **Create two watchers with no delivery channel.** A [Company Entity Watcher](https://docs.crustdata.com/watcher-docs/company/entity) on headcount, funding, status and news, and a [Person Entity Watcher](https://docs.crustdata.com/watcher-docs/person/entity) on the leaders' roles. Both check daily; the first run is a free baseline.
4. **Every day, collect.** Read each watcher's finished runs (`GET /watch/{dataset}/{id}/runs`, then the run summary's NDJSON download). Once a week, read each careers page with [Web Fetch](https://docs.crustdata.com/web-docs/fetch/introduction) (`POST /web/enrich/live`, 1 credit) and count the open roles.
5. **Judge and send.** Apply the thresholds, keep each event once, post alerts to the owner's Slack channel, and send a weekly digest.

The leader watcher at the heart of it:

```bash
curl -X POST https://api.crustdata.com/watch/person \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "entities": { "professional_network_profile_urls": ["FOUNDER_PROFILE_URL"] },
    "track": { "op": "or", "conditions": [
      { "field": "experience.employment_details.past", "type": "added",
        "keys": [["crustdata_company_id", "title"], ["name", "title"]] },
      { "field": "experience.employment_details.current", "type": "added",
        "keys": [["crustdata_company_id", "title"], ["name", "title"]] },
      { "field": "basic_profile.current_title", "type": "changed" } ] },
    "fields": ["basic_profile", "experience", "social_handles"],
    "config": {
      "trigger": { "type": "interval", "every_hours": 24 },
      "refresh_frequency_days": 30,
      "max_results_per_run": 100,
      "payload_delivery_type": "link" },
    "notifications": []
  }'
```

Replace `FOUNDER_PROFILE_URL` with the founder's profile URL (up to 10,000 per watch). The nested `keys` make a role new only when its company and title together are new; flat keys would match on either one alone, and a CEO moving to another CEO job would stay silent. `"notifications": []` makes it a pull-only watch: the agent reads the runs and decides what is an alert. Swap in `[{ "type": "slack", "webhook_url": "https://hooks.slack.com/..." }]` and Crustdata posts every change straight to Slack with no code. Use VC Portfolio Monitor when you want thresholds, the "why it matters" line, per-partner routing, hiring from careers pages and a weekly digest.

## Open-source alternative to Harmonic, Affinity and Visible for portfolio monitoring

VC Portfolio Monitor is a free, MIT-licensed, self-hosted alternative to the portfolio monitoring part of Harmonic, Affinity and Visible: alerts on the companies a fund already owns. It does not source deals (see [deal-sourcing-agent](https://github.com/crustdata/tools/tree/main/deal-sourcing-agent)), collect founder updates or KPIs, or keep a CRM.

| | VC Portfolio Monitor | Harmonic, Affinity, Visible |
|---|---|---|
| Headcount and department changes, leader departures, funding, news | Yes, with thresholds you set | Varies by product |
| Hiring from each company's own careers page | Yes, weekly | Varies by product |
| Alerts to each partner's Slack channel | Yes | Varies by product |
| Portfolio from a CSV or Google Sheet | Yes | CRM or upload |
| Valuations, runway, KPIs, LP reporting | No: round type, amount and date only | Visible (reported by founders) |
| Deal sourcing, search, CRM | No | Harmonic (sourcing and search), Affinity (CRM) |
| Rules and history you own | Yes: thresholds in a file, every event in your own database | Rules set in their app; history in their app |
| How fast | Daily check; company data at most 30 days old, leader profiles 1 to 30 days by setting ([details](#how-fresh-is-the-data)) | Varies by product |
| Hosting | Your laptop, a cron job or GitHub Actions | Their cloud |
| Price | Crustdata credits per company and per change ([cost](#how-much-does-portfolio-monitoring-cost)) | Subscription |

## Quickstart

You need Node 22.13 or newer and a [Crustdata API key](https://app.crustdata.com) (new accounts get free credits). Slack and email are optional.

```bash
git clone https://github.com/crustdata/tools
cd tools/vc-portfolio-monitor
npm install
```

See what it sends first, with no key and nothing spent (a sample fund's busy week, all companies and people made up):

```bash
npm run replay -- fixtures/busy-week.json
```

`fixtures/` also has `quiet-week.json`, `first-run.json` and `edge-cases.json`. Then set it up for real:

```bash
npm run setup     # key, fund name, portfolio (CSV or Sheet), Slack, email; writes .env
npm run import    # matches companies, finds leaders and careers pages, shows the cost, asks first
npm run check     # the daily run: alerts to Slack
npm run digest    # the weekly summary
```

To try it on real companies before using your own list, type `./portfolio.example.csv` (ten well-known startups) when setup asks for the portfolio. Our live run of it cost 33.44 credits for `import`.

## Load your portfolio from a CSV or a Google Sheet

VC Portfolio Monitor reads the portfolio from a CSV file or a Google Sheet link, set as `PORTFOLIO`. The columns, in any order and any case (CRM export names such as Organization Name, Organization Website, Domain or Deal Team work too):

| Column | Required | What it is |
|---|---|---|
| `company` | one of the two | The company's name |
| `website` | one of the two | Its website, such as `linear.app`. Best: a name alone can match several companies |
| `owner` | no | The partner who owns it, or several (`Priya Shah, Sam Lee`); their alerts can go to their own Slack channels |
| `status` | no | Rows marked Exited, Acquired, Written off, Shut down, Pass, Passed, Lost or Rejected are skipped, so you do not pay to watch them ("Not exited", "Exit pending" and "Closed Won" are kept). Import lists the statuses it is watching, so a pipeline export is caught before it is paid for |
| `careers` | no | Its jobs page, when it is not at `/careers` or `/jobs` (for example `https://jobs.ashbyhq.com/acme`) |
| `leaders` | no | Profile URLs of the people to watch, separated by spaces. When given, this list replaces the automatic search for that company |

```csv
company,website,owner,status,careers,leaders
Linear,linear.app,Priya Shah,Active,,
Resend,resend.com,Sam Lee,Active,,
```

**Google Sheet:** keep these columns on a tab of their own with nothing confidential on it (no check sizes, ownership or notes). In Google Sheets choose **File > Share > Publish to web**, pick that tab and **Comma-separated values (.csv)**, click **Publish**, and paste the link into `npm run setup` (or set `PORTFOLIO` to it). Only that tab can be read, by anyone who has the link, and no Google sign-in is needed. A link shared as **Anyone with the link** also works, but it exposes every tab in the file.

Run `npm run import` after you change the list: new rows are added (with the cost shown first), removed rows stop being watched, and nothing is spent when nothing changed. A row it cannot match goes to `unresolved.csv` with the reason, and for a name that matches several companies, the top 3 websites to pick from. `npm run check` reminds you when the list has rows not imported yet. On a schedule (`import -- --yes`), an import that would stop watching more than 10% of the companies (and more than 2) at once, or could cost more than `MAX_IMPORT_CREDITS`, is refused until a person runs it.

## Send portfolio alerts to Slack

VC Portfolio Monitor posts to Slack through an [incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/): a private URL that can post into one channel and do nothing else. It takes five minutes:

1. **Create a channel** for the alerts, for example `#portfolio-alerts`. Public or private both work.
2. **Create a Slack app.** Open [api.slack.com/apps](https://api.slack.com/apps), click **Create New App**, choose **Blank app** (older screens call it **From scratch**), name it, for example `Portfolio Monitor`, and pick your workspace.
3. **Turn on incoming webhooks.** In the app's left menu, open **Incoming Webhooks** and switch **Activate Incoming Webhooks** to **On**.
4. **Add a webhook for your channel.** Click **Add New Webhook** (or **Add New Webhook to Workspace**), pick the channel, and click **Allow**.
5. **Copy the Webhook URL.** It starts with `https://hooks.slack.com/services/`. Paste it into `npm run setup`, or set it as `SLACK_WEBHOOK_URL` in `.env`.

Things that trip people up:

- **No bot scopes needed.** Leave **OAuth & Permissions** alone; ignore any bot token (`xoxb-`) or app token (`xapp-`) Slack shows you.
- **Treat the webhook URL like a password.** Anyone with it can post into your channel. If it leaks, remove that webhook on the **Incoming Webhooks** page and add a new one.
- **"Requires admin approval"** means your workspace only lets admins install apps. Send the request, or ask a Slack admin to create the webhook.

**One channel per partner.** Add one webhook per partner channel (step 4, once per channel), then answer "y" when `npm run setup` asks about owners, or set `SLACK_ROUTES` in `.env`, keyed by the names in the `owner` column:

```bash
SLACK_ROUTES={"Priya Shah": "https://hooks.slack.com/services/...", "Sam Lee": "https://hooks.slack.com/services/..."}
```

A company's alerts go to each of its owners' channels; companies without a route, and the weekly digest, go to `SLACK_WEBHOOK_URL`. If a partner's webhook is removed, their alerts go to the main channel instead. `npm run import` lists owners with no route, and `npm run test-slack` posts a test message to every channel.

**Weekly email.** Add a [Resend](https://resend.com) key, a sender on a verified domain (or `onboarding@resend.dev` to send to yourself) and recipients in `npm run setup`. The email has the same content as the Slack digest.

## How do I run portfolio monitoring every day?

VC Portfolio Monitor is two commands: `npm run check` daily and `npm run digest` weekly. The Crustdata watchers run on their own in your Crustdata account at about 06:00 UTC; a check after that picks up their runs.

- **GitHub Actions (nothing to host).** Copy the monitor into your own private repo with `npx degit crustdata/tools/vc-portfolio-monitor my-monitor`, add [the workflow](examples/github-actions.yml), your `CRUSTDATA_API_KEY` secret and a `PORTFOLIO` variable (your Sheet link). Every day at 07:00 UTC it imports the Sheet (free when nothing changed), runs the check, looks for new leaders on the 1st of the month, sends the digest on Mondays, and commits its state back. Steps: [docs/deploy.md](docs/deploy.md).
- **Cron on a machine that is always on.** Use the full path of npm (`which npm`):
  `0 7 * * * cd /path/to/vc-portfolio-monitor && { /opt/homebrew/bin/npm run import -- --yes; /opt/homebrew/bin/npm run check; } >> monitor.log 2>&1` every day,
  `0 8 * * 1 cd /path/to/vc-portfolio-monitor && /opt/homebrew/bin/npm run digest >> monitor.log 2>&1` on Mondays, and
  `0 9 1 * * cd /path/to/vc-portfolio-monitor && /opt/homebrew/bin/npm run refresh-leaders -- --yes >> monitor.log 2>&1` on the 1st of the month.
- **A scheduled container.** The `Dockerfile` imports, checks, looks for new leaders on the 1st of the month, sends the digest on Mondays, and exits: schedule it daily with a volume at `/app/data`. Steps for Railway and Fly.io: [docs/deploy.md](docs/deploy.md).

A missed day is caught up on the next check: the watchers keep their runs, and each run is read once. When a watcher stops (paused, suspended for lack of credits, deleted), the check says so in Slack once a day and exits with code 3.

## How does VC Portfolio Monitor decide what to alert on?

Every rule is a pure function in `src/signals.ts` and `src/leaders.ts` with a test, and every number is in [config/thresholds.json](config/thresholds.json):

- **Headcount** is compared with its highest (and lowest) reading since the last headcount alert, within the last 180 days, so a slow decline of 2% a month adds up to an alert in about six months, and a second drop after a rehire is seen. After an alert the window starts again, so the same drop is not reported twice.
- **Leaders:** the people search returns anyone whose title contains "chief" or "founder"; "Chief of Staff", "Executive Assistant to the CEO" and "Founding Engineer" are dropped. A leader counts as gone only with evidence: their role at the company now has an end date, or they list a new main job elsewhere that started after they were first watched (Crustdata notes a person's current roles can go missing for one run, and serial founders often keep old roles listed). A leader recorded as gone stays watched for 60 days, and the monthly search finds them again later, so a return is reported too. A board seat elsewhere is not news; a move to advisor, board member or chair at the company is.
- **Hiring** counts the distinct jobs linked from the careers page (Ashby, Greenhouse, Lever, Workable and similar boards, or the site's own job pages). "Stopped" needs two readings in a row with none, because one empty page can be a glitch. A page that comes back much smaller than usual with no roles is counted only when it comes back like that on two different days.
- **News** decides by the first telling words after the company's name: "Acme lays off 20%" is an alert, "Retailer lays off 300; suppliers including Acme" and "Acme rival Beta lays off 30%" are not, "Layoffs hit Acme" and "Acme, the Stripe rival, lays off 20%" are, and "Acme raises $20M to help retailers avoid layoffs" is good news. A down round or bridge is a warning even when the headline says "raises". Articles older than 30 days, and articles that do not name the company, never alert.
- **Rounds:** a priced round up the ladder is good news; debt, a note, a smaller round type or another round of the same stage after a priced seed round or later is an alert (a date change alone is a note, as it can be a correction).
- **Each event is stored once,** keyed by the company and what makes the event distinct (the article, the round date, the person and the day), so it is never posted twice and two portfolio companies in one story both hear about it. A round and the article about it become one line.

## How it works

```text
portfolio.csv or Google Sheet
  │
  ├─ npm run import ─► Company Identify (free) ─► Company Enrich (2) ─► People Search
  │                    ─► Web Fetch careers page (1)
  │                    ─► Company Entity Watcher + Person Entity Watcher (free to create)
  │
  ├─ npm run check (daily) ─► watcher runs (free to read) ─► rules ─► Slack, per owner
  │                         └─ weekly: Web Fetch each careers page (1 each)
  │
  ├─ npm run refresh-leaders (monthly) ─► People Search ─► new leaders
  │
  └─ npm run digest (weekly) ─► every event since the last digest ─► Slack, email, digests/<date>.md
```

Every request and response, in order, with cost: [docs/how-it-works.md](docs/how-it-works.md).

## How fresh is the data?

How soon VC Portfolio Monitor reports an event depends on the kind of signal:

- **Headcount, funding, news:** Crustdata company records refresh every 1 to 30 days (at most 30), and the company watcher checks daily, so a change shows within a day of the record updating, not on the day it happened. Headcount lines name the date of the reading they compare with. Department counts are monthly and about two months behind, and the line names the months.
- **Leaders:** Crustdata refreshes each watched person every 30 days by default, so a departure usually shows within a month of the change becoming public. `LEADER_REFRESH_DAYS` of 14, 7, 3 or 1 shows it sooner and costs more per change.
- **Hiring:** read live from each careers page once a week (`HIRING_CHECK_DAYS`).

## How much does portfolio monitoring cost?

VC Portfolio Monitor is paid in Crustdata credits. At list prices:

| What | Credits |
|---|---|
| `npm run import`, once per company | 2 for the company record, the leader search below, 1 to 3 to find its careers page |
| Leader search, at import (up to 12 people) and once a month (up to 25) | At least 1 credit per search. Crustdata's listed price for a search that filters on and returns experience fields, as this one does, is 0.23 per person returned: up to 2.76 a company at import and 5.75 a month. Our live runs were billed 0.03 per person by the `x-credits-used` header, which shows what your account pays |
| A leader listed by profile URL in the portfolio | 1 |
| Careers page reading, per company per week | 1 |
| Company watcher, per company that changed in a run | 5. Any tracked change counts, even one too small to alert on: one person joining, an ordinary article |
| Leader watcher, per leader whose profile changed | 5 at 30-day freshness; 10, 20, 50 or 150 at 14, 7, 3 or 1 days |
| Watcher baselines, reading runs, job index counts, matching companies, credit checks | free |

One-line total: ten companies with 33 leaders cost about 45 credits once (up to about 80 at Crustdata's listed prices; our live run was billed 33.44 by the response headers). After that, careers pages cost about 43 credits a month, the monthly leader search 10 to 58, and the watchers bill 5 credits for every company or leader that changed on a run, including changes too small to alert on. Plan on up to about 320 credits in a busy month (about 105 in a quiet one); a company in the press most days can add 100 or more on its own, and the sample busy week in `fixtures/busy-week.json` billed 35 watcher credits for six companies. A fund of 60 companies with 240 leaders: about 260 once (up to about 470), then about 620 to 1,920 a month. Crustdata's credits page says a fractional cost is rounded up to a whole credit when it is taken from your balance, so small searches are counted here as at least 1 credit. `npm run import` shows the estimate and your balance before spending anything, and every digest ends with what it cost, including what the watchers billed.

## Limits

VC Portfolio Monitor's limits, most of them set by Crustdata's data and watchers:

- Up to 10,000 companies and 10,000 leaders per watcher. Most funds track 10 to 200 companies.
- A company not in Crustdata's company data cannot be watched; it goes to `unresolved.csv`.
- Companies with an everyday name can have people from other companies of that name counted in their Crustdata headcount and leaders. `npm run import` warns when the headcount is far above the company's size range; list the right leaders in the `leaders` column to replace the search.
- Careers pages that build their job list in the browser may show few or no roles. Import follows a job board link when the page shows fewer than 3; otherwise put the board URL in the `careers` column.
- A leader's move that is not public yet will not show as a departure until it is.
- If Crustdata records a round's new date a day or two before its new type, a short "Extension" note can come before the "New round" line.
- Headlines are judged by words, not meaning: a company named after a common word ("Linear", "Front") can match a headline about something else. Those land in the digest as news, and a layoff headline needs the company named before the layoff words to alert.

## Portfolio monitoring API

There is no hosted VC Portfolio Monitor API: it is a command you run, and every signal it reports is a plain Crustdata REST call you can make from any language. For portfolio headcount, `POST /company/enrich` (2 credits per company) returns `headcount.total`, `headcount.growth_percent` and `headcount.growth_absolute` (`mom`, `qoq`, `six_months`, `yoy`) and `headcount.by_function_timeseries`. For alerts, a Crustdata Company Entity Watcher on `headcount.total`, `funding.last_round_type` and `news` tells you when they move (5 credits per changed company), and a Person Entity Watcher on a founder's `experience.employment_details` tells you when they leave (5 credits per changed person).

```bash
curl -X POST https://api.crustdata.com/watch/company \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "entities": { "domains": ["linear.app", "resend.com"] },
    "track": { "op": "or", "conditions": [
      { "field": "headcount.total", "type": "changed" },
      { "field": "funding.last_round_type", "type": "changed" },
      { "field": "news", "type": "added", "keys": ["article_url"] } ] },
    "fields": ["basic_info", "headcount", "funding", "news"],
    "config": { "trigger": { "type": "interval", "every_hours": 24 } },
    "notifications": [{ "type": "slack", "webhook_url": "https://hooks.slack.com/services/..." }]
  }'
```

The rules are pure functions you can import into your own code: `headcountSignals`, `teamSignals`, `fundingSignals`, `newsSignals`, `hiringSignals` and `leaderSignal` in `src/signals.ts`, `leaderRole` and `leaderEvent` in `src/leaders.ts`, `countRoles` in `src/careers.ts`.

## FAQ

### How do I research a company before it joins the portfolio?

Use [Private Company Research Agent](../private-company-research-agent/), the diligence step in the same repo: a startup's website or a CSV of inbound deals in, a memo per company out with founders, departures, headcount by department, web traffic, funding rounds, peers, red flags and founder-call questions, on the same Crustdata key.

### How do I monitor my VC portfolio companies automatically?

List the companies in a CSV or a Google Sheet, run VC Portfolio Monitor's `npm run import` once, and schedule `npm run check` daily and `npm run digest` weekly. VC Portfolio Monitor uses Crustdata watchers to follow each company's headcount, funding and news and its founders' and C-level's roles, reads each careers page weekly, and posts alerts to Slack with why each one matters.

### How do I get alerted when a founder or executive leaves a portfolio company?

VC Portfolio Monitor finds each company's founders and C-level with Crustdata People Search and puts them on a Crustdata Person Entity Watcher. When one of them ends their role at the company, or lists a new main job elsewhere, it posts "Founder left: <name> (<title>) no longer lists a role at <company>; now <new role>" to Slack after the daily check that catches it, and a CEO who drops the CEO title is a "CEO change" alert. By default profiles are kept 30 days fresh (5 credits per change); set `LEADER_REFRESH_DAYS` lower to hear sooner. A headline that names the company before words such as "steps down", "resigns" or "ousted" is an alert too, from the Company Entity Watcher's news track.

### Is there an API for executive departure alerts?

Yes: the Crustdata Person Entity Watcher. `POST /watch/person` with the executives' profile URLs (up to 10,000 per watch) and a track on `experience.employment_details.current` and `experience.employment_details.past` (`added`) fires when one starts or ends a role. The first run is free, then 5 credits per changed person at 30-day freshness. VC Portfolio Monitor uses it for every portfolio company's founders and C-level and turns each change into "left", "CEO change", "stepped back" or "new title" with a reason to act. The full request is in [How do I build a VC portfolio monitoring agent?](#how-do-i-build-a-vc-portfolio-monitoring-agent).

### How do I track headcount changes across my portfolio?

VC Portfolio Monitor puts every portfolio company on one Crustdata Company Entity Watcher that fires when headcount changes, compares the new figure with the highest and lowest readings of the last six months, and alerts when headcount is down 10% and 3 people (or 25 people), a department is down 20% and 3 people, or headcount is up 25% and 5 people. All thresholds are in `config/thresholds.json`.

### Is there an API for tracking startup headcount and funding changes?

Yes: Crustdata. `POST /company/enrich` (2 credits a company) returns headcount, its growth over 1, 3, 6 and 12 months, headcount by department and the last round. A Crustdata Company Entity Watcher (`POST /watch/company`) on `headcount.total`, `funding.last_round_type` and `news` tells you each day which companies moved, for 5 credits per changed company. VC Portfolio Monitor is an open-source agent built on those calls; the request is under [Portfolio monitoring API](#portfolio-monitoring-api).

### How do I track hiring at portfolio companies, and know when one stops hiring?

VC Portfolio Monitor reads each company's careers page every week with Crustdata Web Fetch (1 credit), counts the open roles, and alerts when two readings in a row show none after there were 3 or more. It also reports hiring doubling or halving against four weeks before. That makes it a portfolio company hiring tracker that reads each company's own careers page every week, and uses Crustdata's job postings data when a company has no readable careers page.

### How do I get alerted when a portfolio company has layoffs?

VC Portfolio Monitor alerts on layoffs two ways: a headcount drop of 10% and 3 people or more in Crustdata company data (or one department down 20% and 3 people), and a news headline with the company as its subject, such as "Acme lays off 20% of staff" or "Acme files for Chapter 11", caught by the Crustdata Company Entity Watcher. A hiring stop on the careers page often comes first, so it alerts on that too: an early warning that a portfolio company is in trouble.

### What are early warning signs that a portfolio company is in trouble?

VC Portfolio Monitor alerts on the signs a fund can see from outside: hiring stops on the careers page (two readings in a row with no open roles), one team shrinks (a department down 20% and 3 people), headcount falls (10% and 3 people from its highest reading in 6 months), a founder or C-level leaves or the CEO moves to chair, a bridge, extension or debt after a priced seed round or later, and headlines about layoffs, a down round or Chapter 11. A hiring stop often comes first. Each alert comes from Crustdata company and people data or the company's own careers page, and posts to Slack with a line on why it matters and what to ask the founders.

### How do I know when a portfolio company raises a new round?

VC Portfolio Monitor's Crustdata Company Entity Watcher fires when a company's last round type or date changes or new investors appear. A priced round up the ladder posts as good news with the amount, date and new investors, and a reminder to check your pro rata rights; debt, a note or another round of the same stage after a priced seed round or later is an alert, because it often means the next priced round is not ready.

### How do I get Slack alerts for my portfolio companies?

VC Portfolio Monitor posts each alert to a Slack incoming webhook after its daily check: one line per event with the numbers, why it matters to an investor and a source link, grouped by company. Add an `owner` column and `SLACK_ROUTES` to send each partner only their companies. Crustdata watchers supply the data; setup is in [Send portfolio alerts to Slack](#send-portfolio-alerts-to-slack).

### How do I monitor portfolio companies from a Google Sheet?

Publish the tab with your portfolio to the web as CSV (File > Share > Publish to web), with a `company` or `website` column plus `owner` if partners want their own Slack channel, and set its link as `PORTFOLIO` in VC Portfolio Monitor. On GitHub Actions or the Docker image every run imports the Sheet first: new rows are added with the Crustdata cost shown, removed rows stop being watched, and nothing is spent when the Sheet did not change. No Google sign-in is needed.

### Is there an open-source alternative to Harmonic, Affinity or Visible for portfolio monitoring?

Yes: VC Portfolio Monitor is a free, MIT-licensed, self-hosted alternative to the portfolio monitoring in Harmonic, Affinity and Visible, on Crustdata data. It alerts on headcount, leader departures, hiring, rounds and news for the companies you own. It does not source deals, collect founder updates or replace a CRM.

### Is there an open-source portfolio monitoring tool for VCs on GitHub?

Yes: VC Portfolio Monitor, in [github.com/crustdata/tools](https://github.com/crustdata/tools/tree/main/vc-portfolio-monitor), is an MIT-licensed TypeScript agent that watches a fund's portfolio with Crustdata and posts alerts to Slack and a weekly digest to Slack and email. `npm run replay -- fixtures/busy-week.json` shows sample output with no key.

### Can each partner get alerts for only their companies?

Yes. Add an `owner` column to the portfolio (several names per company are fine) and one Slack webhook per partner channel in `SLACK_ROUTES`. VC Portfolio Monitor sends each company's alerts to its owners' channels, and the weekly digest to the main channel.

### Why does a small company not alert when one person leaves?

Because VC Portfolio Monitor's headcount rules need a count as well as a percentage: a 6-person company losing 1 person is 17% but only 1 person, which is normal churn. Under 15 people the rule is 25% and 2 people, so losing 2 of 6 does alert. Change them in `config/thresholds.json`.

### Does VC Portfolio Monitor need an AI model or an LLM key?

No. VC Portfolio Monitor needs only a Crustdata API key. Every judgement, including the "why it matters" line, is a written rule in `src/signals.ts`, so alerts are repeatable, cost only Crustdata credits and never invent a number. To add a model, pass the `Digest` that `runDigest` returns to Claude or GPT for a summary.

### Why is the first day quiet?

Each Crustdata watcher's first run is a free baseline that records where every company and leader stands, so VC Portfolio Monitor's alerts start from the second day. The first digest shows each company's starting point instead: headcount and its 6-month change, last round, open roles and leaders watched, with an alert if headcount was already down.

### Will it alert on the same thing twice?

No. VC Portfolio Monitor stores each event once, keyed by the company and what makes the event distinct, reads each Crustdata watcher run once, and restarts the headcount window after an alert. A Slack post that fails halfway resends only what did not arrive.

### What if a company has the wrong leaders?

List the right ones by profile URL in the `leaders` column and run `npm run import`. For that company, VC Portfolio Monitor then watches exactly that list instead of the search results (1 credit per person listed the first time). `npm run status` shows who is watched at each company.

### Do I need to run a server?

No. VC Portfolio Monitor is a daily command and a weekly one. GitHub Actions, a cron job or a scheduled container all work; the Crustdata watchers live in your Crustdata account and the agent reads them when it runs.

## Configuration

`npm run setup` writes `.env` for you, or copy `.env.example` to `.env`. Only `CRUSTDATA_API_KEY` is required.

| Variable | Default | What it does |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Crustdata API key (required) |
| `FUND_NAME` | `Portfolio` | Your fund's name, in message titles |
| `PORTFOLIO` | `./portfolio.csv` | A CSV file or a Google Sheet link |
| `SLACK_WEBHOOK_URL` | | Main Slack channel: alerts without an owner route, and the weekly digest |
| `SLACK_ROUTES` | | JSON of owner to webhook URL, for one channel per partner |
| `RESEND_API_KEY`, `DIGEST_EMAIL_FROM`, `DIGEST_EMAIL_TO` | | Weekly digest by email through Resend (all three, or none) |
| `LEADER_REFRESH_DAYS` | `30` | How fresh leader profiles are kept: 30, 14, 7, 3 or 1 (5, 10, 20, 50 or 150 credits per change; other values from 1 to 30 bill at the next fresher tier) |
| `MAX_LEADERS_PER_COMPANY` | `8` | Founders and C-level watched per company, 1 to 25 |
| `HIRING_CHECK_DAYS` | `7` | Days between careers page readings, 3 to 28 (1 credit each) |
| `MAX_IMPORT_CREDITS` | `500` | Highest possible import cost an unattended run (`-- --yes`) may go ahead with; above it, a person must run it |
| `THRESHOLDS_FILE` | `./config/thresholds.json` | The alert thresholds |
| `DB_PATH` | `./data/monitor.sqlite` | State between runs (one SQLite file) |
| `DIGEST_DIR` | `./digests` | Where the markdown digests are written |
| `RUN_DIGEST` | | Docker image only: `1` sends the digest on every run, `0` never; unset sends it on Mondays (UTC) |

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Guided setup: checks your key, reads your portfolio, sets up Slack (and per-partner channels) and email; writes `.env` |
| `npm run import` | Matches the portfolio, finds leaders and careers pages, sets up or updates the two watchers. Shows the cost and asks first (`-- --yes` to skip, `-- --dry-run` to only look, `-- --allow-removals` to let an unattended run drop more than 10% and more than 2) |
| `npm run check` | The daily run: reads the watchers, reads careers pages when due, posts alerts (`-- --dry-run` saves, posts and spends nothing; `-- --hiring-now` reads careers pages now, billed; `-- --no-hiring` skips them). Exit codes: 2 a Slack post failed, 3 a watcher is not running |
| `npm run digest` | The weekly digest to Slack, email and `digests/` (`-- --dry-run` to preview) |
| `npm run resend` | Posts alerts and digests a channel missed (`-- --all` sends the latest digest again) |
| `npm run status` | Companies, leaders, open roles, watchers, credits |
| `npm run refresh-leaders` | Looks for new founders and C-level and reports them (`-- linear.app` for one company); the workflow runs it monthly |
| `npm run pause` / `npm run resume` | Pauses or resumes both watchers |
| `npm run delete-watches` | Cancels both watchers so nothing more is billed |
| `npm run test-slack` | Posts a test message to every Slack channel set up |
| `npm run replay -- fixtures/busy-week.json` | Offline check and digest from a sample week (add `--slack` for the Slack payloads) |
| `npm test` | Runs the tests |

## Data and security

- **What goes to Crustdata:** your portfolio companies' websites and names, the profile URLs of their leaders, and their careers page URLs. The two watchers keep that list in your Crustdata account, so the list itself, including any undisclosed positions, is shared with Crustdata.
- **What is stored locally:** the companies, their leaders' names, titles, profile URLs and role changes, headcount readings, a reference company record, careers page counts, watcher ids, every event and every digest, in `data/monitor.sqlite`. On GitHub Actions this file is committed every day, so it stays in the repository history; removing a person later means rewriting that history. Alerts go to Slack and, when set, the digest goes to Resend for email.
- **Your key:** only in `.env` (written with permissions 600) or your CI secrets, given only to the steps that need them. On GitHub Actions use a private repo, since the workflow commits `data/` and `digests/`.
- **Slack and email:** everything taken from a record or a headline is escaped, so text from outside cannot ping a channel, add a link or inject HTML.
- **Downloads:** run files are only fetched over https from Crustdata's own storage host, with no redirects and a 50 MB limit read as it streams; a Sheet link only from Google's hosts, 5 MB at most.

## Customize

- **Change the thresholds:** [config/thresholds.json](config/thresholds.json).
- **Change the rules or the "why it matters" lines:** `WHY` and the functions in `src/signals.ts`; who counts as a leader in `src/leaders.ts`.
- **Change what is an alert and what waits for the digest:** the `severity` each rule sets in `src/signals.ts`.
- **Watch VPs or a Head of Finance too, add a signal, or send alerts somewhere else (Teams, a CRM, a webhook):** [docs/customize.md](docs/customize.md).

## Project structure

```text
src/
  cli.ts           every npm run command except setup and replay
  setup.ts         guided setup that writes .env
  replay.ts        offline check and digest from a fixture (npm run replay)
  config.ts        settings from .env, checked at start
  run.ts           import, the daily check, leader refresh and the weekly digest: order of calls and state
  crustdata.ts     every Crustdata API call, paced and retried
  portfolio.ts     CSV and Google Sheet reading (pure parsing)
  leaders.ts       who is a leader, and what a profile change means (pure)
  careers.ts       open roles on a careers page (pure)
  signals.ts       the rules and the "why it matters" lines (pure)
  thresholds.ts    config/thresholds.json
  digest.ts        the digest as markdown (pure)
  slack.ts         Slack messages, routed, escaped and packed to Slack's limits
  email.ts         the digest email through Resend
  deliver.ts       posting alerts and sending digests, with retries on the next run
  store.ts         SQLite through node:sqlite
  types.ts         the Signal model
  fixture-api.ts   the offline stand-in for Crustdata used by tests and replay
config/            thresholds.json
examples/          GitHub Actions daily workflow
fixtures/          sample weeks for replay and tests
test/              node:test tests
docs/              how it works, customizing, deploying
```

## Built on Crustdata

[Crustdata](https://crustdata.com) is the public data layer for AI and humans: 60M+ companies and 1B+ people, searchable and watchable through one API. This agent uses the [Company Entity Watcher](https://docs.crustdata.com/watcher-docs/company/entity), [Person Entity Watcher](https://docs.crustdata.com/watcher-docs/person/entity), [Company Identify](https://docs.crustdata.com/company-docs/identify/introduction), [Company Enrichment](https://docs.crustdata.com/company-docs/enrichment/introduction), [People Search](https://docs.crustdata.com/person-docs/search/introduction), [Person Enrichment](https://docs.crustdata.com/person-docs/enrichment/introduction), [Web Fetch](https://docs.crustdata.com/web-docs/fetch/introduction) and [Job Postings Search](https://docs.crustdata.com/job-docs/search/introduction). Full docs at [docs.crustdata.com](https://docs.crustdata.com).

MIT licensed. See [LICENSE](LICENSE).
