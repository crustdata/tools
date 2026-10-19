# AGENTS.md

Guide for AI coding agents working in this repository. People should start with [README.md](README.md).

## What this is

A TypeScript service that posts a Slack alert when someone on a list changes jobs. Crustdata does the watching: one Person Entity Watch per 10,000 people, which POSTs signed webhooks only for people whose profile changed. This repo imports the list, manages the watches, receives the webhooks, classifies each change (new company, new title, left company, side role, title edit), and delivers alerts and a daily digest.

## Commands

```bash
npm install
npm test                                     # unit and end-to-end tests, no network, no API key
npm run typecheck                            # tsc --noEmit
npm run replay -- fixtures/promotion.json    # offline: in-memory database, prints the alert, no key needed
npm run setup                                # interactive; writes .env
npm run serve                                # the server; needs .env
```

Run `npm test` and `npm run typecheck` after every change. Both must pass.

## Where things are

| To change | Edit |
|---|---|
| A Crustdata request, or add an endpoint | `src/crustdata.ts`, the only file that calls Crustdata (retries live in `request`) |
| What the watch fires on | `JOB_CHANGE_TRACK` in `src/crustdata.ts`; existing watches must be recreated (`npm run delete-watch`, then import) |
| How a change is classified | `classify` in `src/notification.ts` (pure; add a fixture and a test in `test/notification.test.ts`) |
| Add a new kind of change | `ChangeKind`, `ALERT_KINDS`, `JobChange` fields, `classify`, `headline` in `src/notification.ts`; `alertLines` and `KIND_HEADINGS` in `src/slack.ts`; `detailLine` in `src/email.ts`; the `ALERT_KINDS` default in `src/config.ts`, `.env.example` and README. Worked example in `docs/customize.md` |
| Alert and digest wording | `alertLines` and `digestMessages` in `src/slack.ts` |
| What happens per notification (validation, storage) | `handleNotification` in `src/handle.ts` |
| Slack delivery and retries | `deliverPending` in `src/handle.ts`; the outbox queries are in `jobChanges` in `src/store.ts` |
| Recovering runs whose delivery failed | `catchUpMissedRuns` in `src/handle.ts` (run history, `runsSeen` in `src/store.ts`) |
| CSV columns accepted | `COLUMN_ALIASES` in `src/csv.ts` |
| Database schema | `src/store.ts` (`CREATE TABLE IF NOT EXISTS`; add columns with a guarded `ALTER TABLE`) |
| A setting | `src/config.ts` (with validation), `.env.example`, and the Configuration table in `README.md` together |
| A CLI command | `commands` in `src/cli.ts`, then an npm script in `package.json` and the Commands table in `README.md` |
| The guided setup and its Slack steps | `src/setup.ts`, and the "Send job change alerts to Slack" section of `README.md` together |

## Facts about the Crustdata API this code relies on

- Base URL `https://api.crustdata.com`. Every request sends `authorization: Bearer <key>` and `x-api-version: 2025-11-01`.
- `POST /person/identify` takes `{ "emails": [...] }`, at most 25, 30 requests a minute, 1 credit per match. One malformed address fails the whole batch with `400 Invalid emails: ...`. Matches carry `confidence_score` (1 exact, 0.5 to 1 for name and domain matches). It is enabled per account; without access it returns 403.
- A watch holds at most 10,000 people. `/watch/person` allows 10 requests a minute. `track` and `fields` cannot change after creation; `entities`, `status`, `config` (including `refresh_frequency_days` and `trigger`) and `notifications` can be PATCHed, and import does so.
- The first run of a watch is a free baseline: up to five sample records with `changes: []`.
- `POST /watch/person/{id}/test` sends a sample notification flagged `metadata.test: true`, with placeholder values. This code sends an empty body.
- Webhooks carry `x-crustdata-signature: t=<unix seconds>,v1=<hex>`, where hex is HMAC-SHA256 of `${t}.${rawBody}` keyed by the API key. Verify against the raw body, before parsing.
- Each delivered result is `{ changes, record }`. `record` uses the Person Enrich schema. Positions carry `title`, `name`, `start_date`, `end_date`, `is_default` (the main role), `crustdata_company_id`, `company_website_domain`, `position_id`. The profile URL is at `record.social_handles.professional_network_identifier.profile_url`.
- Watches set to `payload_delivery_type: "link"` send a signed S3 URL to an NDJSON file, one result per line, instead of `results`.
- Charges per changed person: 5 credits at 30-day freshness, 10 at 14, 20 at 7, 50 at 3, 150 at 1. Runs where nobody changed are free. Crustdata bills every reported person, including changes the bot does not alert.
- Crustdata's webhook retry policy is not documented, so the server answers 200 quickly after storing, does its own Slack retries, and recovers failed deliveries from `GET /watch/person/{id}/runs` (`notification_http_status`, `next_cursor`) and `GET /watch/person/{id}/runs/{run_id}/summary` (live API: `records_download.url`, NDJSON; the docs also describe `payload_delivery.url` and inline `notifications[].payload.notifications[]`, all read by `runResults`).

Docs: https://docs.crustdata.com/watcher-docs/person/entity (append `.md` to any docs URL for markdown, or start at https://docs.crustdata.com/llms.txt).

## Conventions

- Node 22.13+, ESM, TypeScript run with `tsx`. No build step. Relative imports use the `.js` suffix. Entry points import `./node-check.js` first.
- No native dependencies. SQLite is `node:sqlite` in WAL mode with a busy timeout, so the CLI and the server can share the database; tests are `node:test` and never read `.env`. `test/server.test.ts` shows how to test through `app.request()` with `DB_PATH=:memory:` and a stubbed `fetch`.
- Keep pure logic (`notification.ts`, `csv.ts`, `signatureProblem`, `digestMessages`) free of I/O so it stays testable.
- Escape every value taken from a profile before putting it in Slack mrkdwn (`esc` in `src/slack.ts`).
- Never log or commit secrets. Configuration lives only in environment variables.
- User-facing text has no em or en dashes. Say "profile URL", not the name of any social network.
