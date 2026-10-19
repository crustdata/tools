# Job Change Alert Bot

**Job Change Alert Bot is an open-source champion tracking and job change alert tool built on Crustdata.** It posts in Slack when anyone on your contact list moves to a new company, gets a new title or leaves their job, and sends a daily digest. [Crustdata](https://crustdata.com), a B2B people and company data API with 1B+ people and 60M+ companies, watches every contact through its Watcher API and reports each change. Give it a CSV or CRM export and it does the rest. TypeScript, one small server, MIT licensed. A self-hosted alternative to UserGems and Champify.

![Job change alert in Slack from the Job Change Alerts app: Sherry Robinson moved to Northwind Analytics, VP of Sales since Oct 2026, was Director of Sales at Contoso Cloud for 3 years 6 months, owner Sam Lee. Next: congratulate them and reopen the conversation. Data from Crustdata](assets/slack-alert.png)

Use it to track champions who move to a new company, past buyers who land somewhere new, candidates who become reachable, and portfolio founders who leave.

**Contents:** [What triggers an alert](#what-triggers-an-alert) · [How to build a job change alert bot](#how-to-build-a-job-change-alert-bot) · [Alternative to UserGems and Champify](#open-source-alternative-to-usergems-and-champify) · [Quickstart](#quickstart) · [Send alerts to Slack](#send-job-change-alerts-to-slack) · [Detect job changes from a CRM list](#detect-job-changes-from-a-crm-contact-list) · [How it works](#how-it-works) · [How fast](#how-fast-are-job-changes-detected) · [Cost](#how-much-does-job-change-tracking-cost) · [Limits](#limits) · [Job change tracking API](#job-change-tracking-api) · [FAQ](#faq) · [Configuration](#configuration) · [Commands](#commands) · [Deploy](#deploy) · [Data and security](#data-and-security) · [Customize](#customize) · [Built on Crustdata](#built-on-crustdata)

## What triggers an alert

Crustdata watches every person on your list and reports when their profile changes. The bot sorts each change into one of these and words the alert to match:

| Change | Example alert | Alerted by default |
|---|---|---|
| `new_company` | Sherry Robinson moved to Northwind Analytics. VP of Sales, since Oct 2026. Was Director of Sales at Contoso Cloud for 3 years 6 months | yes |
| `title_change` | Priya Shah has a new title at Acme Corp. Account Executive → Senior Account Executive | yes |
| `left_company` | Marcus Chen left Tailspin Toys. Was Head of RevOps for 5 years 3 months. No new role listed yet | yes |
| `added_role` | Dana Ruiz added a role: Advisor at TinyStartup. Still VP Operations at Northwind Analytics | no (set `ALERT_KINDS`) |
| title edit | "VP Sales" became "VP, Sales" | never |

Each alert shows the account owner from your CSV, and moves, new titles and departures come with a suggested next step. Crustdata sees a change once the person updates their public profile; see [How fast are job changes detected?](#how-fast-are-job-changes-detected)

## How to build a job change alert bot

To build a job change alert bot, resolve each contact to a profile URL with Crustdata, put the whole list in one Crustdata watch, receive the signed webhook Crustdata sends when someone changes jobs, and post that change to Slack. This repo does all four steps:

1. **Get a stable identifier for each person.** Resolve each work email to a profile URL with Crustdata [`POST /person/identify`](https://docs.crustdata.com/api-reference/person-apis/identify-people-from-profile-urls-emails-or-google-scholar-profile-urls) (1 credit per match, free when there is no match).
2. **Create one watch over the whole list.** [`POST /watch/person`](https://docs.crustdata.com/watcher-docs/person/entity) with a `track` rule for "new current position", "title changed" and "role ended". Crustdata re-checks every person, compares each against the last snapshot, and reports only the people who changed. Nothing to poll on your side.
3. **Receive the webhook.** Crustdata POSTs the changes to your URL, signed with HMAC-SHA256. Verify the signature, ignore the first (baseline) run, and drop repeats.
4. **Turn the change into a message.** Work out whether it is a move, a promotion or a departure, post it to Slack, and batch the day's changes into a digest.

The watch request at the heart of it:

```bash
curl -X POST https://api.crustdata.com/watch/person \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "entities": { "professional_network_profile_urls": ["https://...", "https://..."] },
    "track": { "op": "or", "conditions": [
      { "field": "experience.employment_details.current", "type": "added" },
      { "field": "basic_profile.current_title", "type": "changed" },
      { "field": "experience.employment_details.past", "type": "added" }
    ]},
    "fields": ["basic_profile", "experience", "social_handles"],
    "config": { "trigger": { "type": "interval", "every_hours": 24 }, "refresh_frequency_days": 30, "max_results_per_run": 1000 },
    "notifications": [{ "type": "webhook", "url": "https://your-server.com/webhooks/crustdata" }]
  }'
```

Swap the webhook for `{ "type": "slack", "webhook_url": "https://hooks.slack.com/..." }` and Crustdata posts each raw change straight to Slack with no server at all. Use this repo when you want one readable message per person saying where they moved from and to, promotions told apart from moves, owners on every alert, a daily digest, and your own record of every change.

## Open-source alternative to UserGems and Champify

Job Change Alert Bot is a free, MIT-licensed, self-hosted alternative to UserGems and Champify for the core job: you give it a list of people, and it tells you in Slack when one changes jobs. The data comes from Crustdata (1B+ profiles), billed per change detected: 5 credits per person who changed at the default freshness, nothing for people who did not.

| What you get | Job Change Alert Bot |
|---|---|
| Slack alerts per change, with owner and next step | yes |
| Daily digest in Slack and by email | yes |
| Promotions, departures and side roles told apart from moves | yes |
| Import from HubSpot, Salesforce, Attio or Sheets | CSV export; `npm run sync` keeps the watch in step with it |
| Writing back to your CRM | not built in; `handleNotification` in `src/handle.ts` is the one place to add it |
| Finding new contact details or ICP fit at the new company | not built in |
| Pricing | pay per detected change in Crustdata credits, no seats |
| Hosting | one Node process you run |

## Quickstart

You need:

- Node 22.13 or newer
- a [Crustdata API key](https://app.crustdata.com) (new accounts get free credits)
- a Slack channel you can add an app to
- a CSV of the people to watch, for example a HubSpot or Salesforce export with an email column (see [people.sample.csv](people.sample.csv))
- email lookup enabled on your Crustdata account if your CSV has emails rather than profile URLs (ask Crustdata, or use profile URLs)

```bash
git clone https://github.com/crustdata/tools
cd tools/job-change-alert-bot
npm install
npm run setup
```

`npm run setup` asks four questions and checks each answer as you go:

1. **Your Crustdata API key.** It confirms the key works.
2. **A Slack webhook URL.** It prints the steps to create one (also [below](#send-job-change-alerts-to-slack)), then posts a test message to your channel.
3. **A public https URL for this server.** Crustdata delivers changes there. To try the bot on a laptop, run `npx cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`) in another terminal and paste the https URL it prints. For real alerts, [deploy it](#deploy): a laptop tunnel changes URL on restart and stops when the laptop sleeps.
4. **Email digest (optional).**

It saves everything to `.env` and ends with a checklist of what is ready. Then, with the tunnel running in its own terminal, use two more:

```bash
npm run serve                      # terminal 1: alerts and digest
npm run import -- champions.csv    # terminal 2: creates the watch
npm run test-webhook               # terminal 2: free signed sample
```

The first run of the watch is a free baseline that records where everyone works today. From then on, each change produces one Slack message.

To see what alerts look like without spending anything, replay a sample offline (nothing is posted or saved):

```bash
npm run replay -- fixtures/job-change.json
```

## Send job change alerts to Slack

Job Change Alert Bot posts each job change Crustdata detects to a Slack channel through an [incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/): a private URL that can post into one channel and nothing else. Each team creates its own, so the bot posts into your workspace. It takes about two minutes:

1. **Create a channel** for the alerts, for example `#job-change-alerts`. Public or private both work.
2. **Create a Slack app.** Open [api.slack.com/apps](https://api.slack.com/apps), click **Create New App**, and choose **Blank app** (older screens call it **From scratch**). Name it, for example `Job Change Alerts`, pick your workspace, and create it.
3. **Turn on incoming webhooks.** In the app's left menu, open **Incoming Webhooks** and switch **Activate Incoming Webhooks** to **On**.
4. **Add a webhook for your channel.** Click **Add New Webhook** (or **Add New Webhook to Workspace**), pick the channel, and click **Allow**.
5. **Copy the Webhook URL.** It starts with `https://hooks.slack.com/services/`. Paste it into `npm run setup`, or set it as `SLACK_WEBHOOK_URL` in `.env`.

Things that trip people up:

- **No bot scopes needed.** Turning on incoming webhooks adds the only permission the bot uses. Leave **OAuth & Permissions** alone.
- **Ignore the bot token (`xoxb-`) and app token (`xapp-`).** If Slack shows them after you create the app, they are not what the bot needs, and they grant far more access than a webhook. Keep them private.
- **Treat the webhook URL like a password.** Anyone with it can post into your channel. If it leaks, remove that webhook on the **Incoming Webhooks** page and add a new one.
- **"Requires admin approval"** means your workspace only lets admins install apps. Send the request, or ask a Slack admin to create the webhook for you.

Check it any time with `npm run test-slack`, which posts a short "connected" message. For raw changes with no server, a Crustdata watch can post to Slack itself: use `{ "type": "slack", "webhook_url": "..." }` as its notification.

### Route job change alerts to each rep

Give each owner their own channel with `SLACK_ROUTES`, and @mention them with `OWNER_SLACK_IDS` (their Slack member ID: profile, three dots, **Copy member ID**). Keys are the owner values exactly as your CSV has them (a name such as `Sam Lee` from HubSpot, or an email); case and spaces are ignored:

```bash
SLACK_ROUTES={"Sam Lee": "https://hooks.slack.com/services/..."}
OWNER_SLACK_IDS={"Sam Lee": "U012ABCDEF"}
```

The daily digest always goes to `SLACK_WEBHOOK_URL`, so set it too.

## Detect job changes from a CRM contact list

Export contacts from HubSpot, Salesforce, Attio or Google Sheets as a CSV and run `npm run import -- contacts.csv`. The bot reads the email or profile URL column, resolves emails to profiles with Crustdata, and adds everyone to a Crustdata watch, which re-checks each contact and reports only the ones who changed jobs. It recognises the column names those exports use by default:

| Field | Column names it reads | Notes |
|---|---|---|
| Email | `Email`, `Work Email`, `Email Address`, `Email Addresses` | Looked up once: 1 credit per match, unmatched is free |
| Profile URL | `Profile URL`, `Profile`, `URL` | Used directly, no lookup |
| Name | `Name`, `Full Name`, or `First Name` + `Last Name` | Shown in alerts |
| Company, title | `Company`, `Company Name`, `Account Name`; `Title`, `Job Title` | Used as "Was" when needed |
| Owner | `Owner`, `Contact Owner`, `Account Owner` | Shown on alerts and used for routing |

- `npm run import` adds people and never removes anyone. New people are baselined silently, so adding someone never sends a false alert.
- `npm run sync -- contacts.csv` makes the watch match the CSV exactly: people no longer in it stop being watched and billed.
- Import prints how many rows it read, merged and skipped (with line numbers). Emails that did not match go to `data/unresolved.csv` with the name, company and owner; fill in its `profile_url` column and import that file. `npm run unresolved` lists them any time.
- Emails matched by name and company domain rather than an exact address are listed in `data/likely-matches.csv`. Set `MIN_MATCH_CONFIDENCE=1` to watch exact matches only.
- A big list is looked up at Crustdata's limit of 30 requests a minute (25 emails each) and saved as it goes, so an interrupted import resumes without paying twice.

## How it works

Crustdata watches the list and sends a signed webhook only for people whose profile changed. This server verifies it, works out what kind of change it is, stores it in SQLite, posts it to Slack, and sends a daily digest.

```text
champions.csv
   │  npm run import
   ▼
POST /person/identify   email to profile URL, once per person (30 requests/min, saved as it goes)
POST /watch/person      one watch per 10,000 people (PATCH to add or remove people later)
   │
   │  Crustdata keeps each profile fresh (REFRESH_FREQUENCY_DAYS) and reports changes every 24h
   ▼
POST /webhooks/crustdata   (this server)
   ├─ verify x-crustdata-signature (HMAC-SHA256, 5 minute window, 5 MB limit)
   ├─ skip the baseline run and test sends
   ├─ classify: new company, new title, left company, side role, title edit
   ├─ store in SQLite (one row per person per run, so repeats are ignored)
   └─ post to Slack, retrying for up to 2 days if Slack is down

Every 6 hours: re-read Crustdata's run history and recover any run whose delivery failed
          │
          ▼  daily at DIGEST_HOUR_UTC
     digest to Slack, and email if configured
```

Every request and response is shown in [docs/how-it-works.md](docs/how-it-works.md).

## How fast are job changes detected?

Crustdata sees a move once the person updates their public profile, and many people do that a few weeks after starting. After that, how quickly the bot hears about it depends on `REFRESH_FREQUENCY_DAYS`, the freshness Crustdata keeps each tracked profile at:

| `REFRESH_FREQUENCY_DAYS` | Detected within | Credits per changed person |
|---|---|---|
| 30 (default) | about 30 days | 5 |
| 14 | about 14 days | 10 |
| 7 | about 7 days | 20 |
| 3 | about 3 days | 50 |
| 1 | about 1 day | 150 |

`CHECK_EVERY_HOURS` only sets how often the watch reports. To change either on an existing watch, edit `.env` and run `npm run import -- champions.csv` again: the bot updates the watch in place.

## How much does job change tracking cost?

Tracking 1,000 contacts for a year costs about 2,000 to 4,000 Crustdata credits at the default freshness: up to 1,000 credits once to resolve emails, then 5 credits each time Crustdata reports a person. Plan for 200 to 300 people to change in a year once promotions and departures are counted, and for some moves to be reported two or three times as the person edits their profile. Runs where nobody changed are free.

| Step | Credits |
|---|---|
| Resolve an email to a profile | 1 per match, once (contacts imported by profile URL skip this) |
| Baseline run | free |
| Each person who changed | 5 at 30-day freshness, 10 at 14, 20 at 7, 50 at 3, 150 at 1 |
| A run where nobody changed | free |
| Sample notification (`npm run test-webhook`) | free |

Notes:

- Crustdata bills every person the watch reports, including side roles and cosmetic title edits that the bot then chooses not to post. A single move can also be reported, and billed, two or three times as the person edits their profile over a few weeks.
- Email lookup (`/person/identify`) is enabled per Crustdata account. If import says it is not enabled, ask Crustdata, or put profile URLs in the CSV.
- You also need somewhere to run one small always-on Node process with a persistent disk, and someone to look after it.
- Credit prices: [crustdata.com/pricing](https://crustdata.com/pricing). Your exact rates: [docs.crustdata.com/general/pricing](https://docs.crustdata.com/general/pricing).

## Limits

- **10,000 people per Crustdata watch.** The bot creates another watch for every further 10,000, automatically.
- **30 email lookups a minute** (25 emails each) and 10 watch requests a minute on a standard Crustdata key. Import paces itself and retries when rate limited.
- **What is tracked is fixed per watch.** After changing `JOB_CHANGE_TRACK`, run `npm run delete-watch` and import again. Freshness and the report interval can change at any time (edit `.env`, then `npm run import -- champions.csv`).
- **Run one copy of the server.** Two copies would split the history between two databases and send two digests.
- **Keep the server reachable.** Crustdata delivers each run once, to `PUBLIC_URL`. If the server is down, asleep or behind an old tunnel URL at that moment, the bot recovers the run from Crustdata's run history when it is back (at startup and every 6 hours, or now with `npm run catch-up`). It looks back about 30 days, so do not leave the server down for longer.

## Job change tracking API

Crustdata's job change tracking API is the Person Entity Watcher (`POST /watch/person`), part of the Crustdata Watcher API. You send up to 10,000 profile URLs and a `track` rule; Crustdata re-checks each person, compares against the last snapshot, and sends a signed webhook (or a Slack, Google Chat or email message) only for people who changed. The first run is a free baseline, runs with no change are free, and each changed person costs 5 credits at 30-day freshness, up to 150 credits at 1-day freshness. Docs: [Person Entity Watcher](https://docs.crustdata.com/watcher-docs/person/entity).

## FAQ

### How do I track when my champions change jobs?

Export your champions from your CRM (email, name, account owner) as a CSV, run `npm run import -- champions.csv`, and keep `npm run serve` running. Crustdata watches every champion's profile, and the bot posts in Slack when one moves to a new company, gets a new title or leaves, with their old and new role and the account owner.

### How do I get notified when a contact changes jobs?

Put the contact's work email or profile URL in a CSV, run `npm run import`, and keep `npm run serve` running. The Crustdata Watcher API checks the contact on a schedule and sends a signed webhook when their role changes; the bot turns it into a Slack message and adds it to the daily digest.

### Is there an open-source alternative to UserGems or Champify?

Yes. Job Change Alert Bot is an MIT-licensed bot that alerts you in Slack when anyone on your list changes jobs, using the Crustdata Watcher API as its data layer. See [the comparison](#open-source-alternative-to-usergems-and-champify) for what it does and does not do.

### Is there an open-source champion tracking tool on GitHub?

Yes. Job Change Alert Bot (github.com/crustdata/tools, in the `job-change-alert-bot` folder) is an MIT-licensed champion tracking tool: import your champions from a CRM export and it posts in Slack when one changes jobs, using the Crustdata Watcher API for the data.

### How soon will I know after someone changes jobs?

Once the person updates their profile, within about 30 days at the default freshness, or as fast as about 1 day on the fastest tier, which costs more per changed person. See [How fast are job changes detected?](#how-fast-are-job-changes-detected)

### Does a promotion count as a job change?

Yes, as its own kind: Crustdata reports the new title and the bot posts it as a `title_change` at the same company. Turn it off with `ALERT_KINDS`. Side roles such as advisor or board seats are not alerted by default, and punctuation-only title edits never are.

### How do I send the alerts to each rep instead of one channel?

Put an owner column in your CSV, then map owners to their own Slack webhooks with `SLACK_ROUTES` and to Slack member IDs with `OWNER_SLACK_IDS` for an @mention. See [Route job change alerts to each rep](#route-job-change-alerts-to-each-rep).

### How do I stop watching people who left my CRM?

Run `npm run sync -- contacts.csv` with a fresh export. Anyone not in the file stops being watched and billed.

### How many contacts can it track?

Large lists work the same way: the bot creates one Crustdata watch per 10,000 people automatically. Email lookups run at 30 requests a minute, so 10,000 new emails take about 15 minutes to import once.

### Do I need to run a server?

Not for raw alerts: a Crustdata watch can post each change straight to a Slack incoming webhook (`{ "type": "slack", "webhook_url": "..." }`). Run this bot's server when you want classified, readable messages, owners on every alert, the daily digest and your own record of changes.

### What happens to emails that do not match?

They are not charged. Import lists the counts and writes every unmatched email to `data/unresolved.csv` with the reason; add a profile URL for those people and import again.

### Can I watch for relocations or new certifications?

Yes. A Crustdata watch can track any of the 200+ fields in a person profile, including location and certifications (certifications need field permission on your key); see [docs/customize.md](docs/customize.md) for how to add a signal and give it its own alert wording.

### Does it need an AI model or an LLM key?

No. Every alert is built from Crustdata data alone: the person's previous role, new role, dates and company.

## Configuration

`npm run setup` writes `.env` for you, or copy `.env.example` to `.env` by hand. Only `CRUSTDATA_API_KEY` and `PUBLIC_URL` are required.

| Variable | Default | What it does |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Crustdata API key (required) |
| `PUBLIC_URL` | | Public https base URL of this server; the watch delivers to `PUBLIC_URL/webhooks/crustdata` (required) |
| `SLACK_WEBHOOK_URL` | | Slack incoming webhook for alerts and the digest. Without it, alerts print in the terminal |
| `SLACK_ROUTES` | | JSON map of owner to Slack webhook, to send each owner's alerts to their own channel |
| `OWNER_SLACK_IDS` | | JSON map of owner to Slack member ID, to @mention the owner |
| `MIN_MATCH_CONFIDENCE` | `0` | Watch email matches only at or above this confidence (0 to 1). `1` keeps exact email matches only. Applied on every import, including to matches already made |
| `ALERT_KINDS` | `new_company,title_change,left_company` | Which changes are alerted; add `added_role` for side roles |
| `ALERT_MODE` | `both` | `realtime` (a message per change), `digest` (one a day) or `both` |
| `REFRESH_FREQUENCY_DAYS` | `30` | Data freshness, 1 to 30: 30, 14, 7, 3 or 1 days for 5, 10, 20, 50 or 150 credits per changed person. A value between tiers is billed at the fresher tier. Applied on import |
| `CHECK_EVERY_HOURS` | `24` | How often the watch reports. Applied on import |
| `DIGEST_HOUR_UTC` | `8` | Hour of the daily digest, 0 to 23 |
| `RESEND_API_KEY`, `DIGEST_EMAIL_FROM`, `DIGEST_EMAIL_TO` | | Email copy of the digest through Resend (all three, or none) |
| `PORT` | `3000` | Port the server listens on |
| `DB_PATH` | `./data/bot.sqlite` | SQLite file |
| `ALLOW_UNSIGNED_WEBHOOKS` | `false` | Accept unsigned webhooks. Local testing only |

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Guided setup: checks your Crustdata key, connects Slack, writes `.env` |
| `npm run serve` | Run the webhook receiver, Slack delivery and the daily digest |
| `npm run import -- contacts.csv` | Add the people in a CSV to the watch |
| `npm run sync -- contacts.csv` | Make the watch match the CSV exactly, removing people not in it |
| `npm run status` | Watches, people, changes received, recent runs, credits used |
| `npm run test-webhook` | Ask Crustdata to send a signed sample notification to your server (free) |
| `npm run test-slack` | Post a "connected" message to your Slack channel |
| `npm run digest` | Send the digest now |
| `npm run unresolved` | List emails that did not match a profile, and write them to `data/unresolved.csv` |
| `npm run changes -- 30` | List every change received in the last 30 days (default 7), alerted or not, and write `data/changes.csv` |
| `npm run catch-up` | Recover changes from runs whose delivery failed while the server was down (the server also does this every 6 hours) |
| `npm run replay -- fixtures/job-change.json` | Show the alert for a saved notification, offline (add `--slack` to post it) |
| `npm run adopt -- <watch id>` | Use a watch that already exists, for example after moving to a new server |
| `npm run pause` / `npm run resume` | Pause or resume the watches |
| `npm run delete-watch` | Cancel the watches, needed before changing what is tracked |
| `npm run purge -- 180` | Delete stored profile data older than 180 days |
| `npm test` | Run the tests |

The `fixtures/` folder has one sample of each kind of change for `replay`: `job-change.json`, `promotion.json`, `left-company.json`, `side-role.json`, `title-edit.json`, plus `baseline.json` and `test-notification.json`, which show that those never alert.

## Deploy

Any host that runs Node and gives you a public https URL works. The repo ships a `Dockerfile`. Keep `data/` on a persistent volume, and run the import commands on the server itself so the watch and your list live in the same database. Step by step for Railway, Render, Fly.io and a plain server: [docs/deploy.md](docs/deploy.md).

## Data and security

- **What goes to Crustdata:** the emails and profile URLs you import. For an email that is not on file, Crustdata may match it by name and company domain, including through a contact data vendor, inside the same request.
- **What is stored locally:** your list (names, emails, owners, last known role) and every change received, including the profile data Crustdata delivered, in `data/bot.sqlite`. `npm run purge -- 180` deletes changes older than 180 days.
- **Webhooks:** every delivery must carry a valid `x-crustdata-signature` (HMAC-SHA256 keyed by your API key) from the last 5 minutes. Unsigned or oversized requests are rejected before the body is processed. Rotating the API key also rotates the signing secret.
- **Health check:** `GET /` returns counts only, never names.
- **Slack:** anything taken from a profile is escaped, so a name or title cannot ping a channel or add a link.
- **People who ask Crustdata to remove their data** are returned as `redacted`; the bot never looks them up again.

## Customize

- **Change the wording of an alert:** `alertLines` in `src/slack.ts`.
- **Change what counts as a move or a promotion:** `classify` in `src/notification.ts`, with a fixture and a test in `test/notification.test.ts`.
- **Track another signal, such as relocations:** [docs/customize.md](docs/customize.md).
- **Write changes to your CRM:** `handleNotification` in `src/handle.ts`.

## Project structure

```text
src/
  server.ts        HTTP server: webhook endpoint, Slack delivery loop, digest scheduler, health check
  cli.ts           every npm run command except setup, serve and replay
  setup.ts         guided setup that writes .env
  replay.ts        offline replay of a saved notification
  crustdata.ts     every Crustdata API call, retries, and webhook signature verification
  notification.ts  notification to classified job changes (pure, tested)
  handle.ts        validate, store and deliver each notification (the Slack outbox), and catch up on missed runs
  csv.ts           CSV reader with CRM column names (pure, tested)
  store.ts         SQLite through node:sqlite
  slack.ts         Slack messages and digest, escaped and split to Slack's limits
  email.ts         email digest through Resend
  digest.ts        daily digest (sent late if the server was down at DIGEST_HOUR_UTC), watch health warnings
  config.ts        environment variables, validated at startup
test/              node:test tests, including the server end to end
fixtures/          one sample notification for each kind of change
docs/              how it works, customizing, deploying
```

## Built on Crustdata

[Crustdata](https://crustdata.com) is the public data layer for AI and humans: 1B+ people and 60M+ companies, searchable and watchable through one API. This bot uses the [Person Entity Watcher](https://docs.crustdata.com/watcher-docs/person/entity) and [Identify People](https://docs.crustdata.com/api-reference/person-apis/identify-people-from-profile-urls-emails-or-google-scholar-profile-urls). Full docs at [docs.crustdata.com](https://docs.crustdata.com).

MIT licensed. See [LICENSE](LICENSE).
