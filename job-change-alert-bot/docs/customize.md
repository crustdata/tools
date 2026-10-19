# Customize the job change alert bot

## Choose which changes are alerted

`ALERT_KINDS` in `.env` lists the kinds that produce an alert: `new_company`, `title_change`, `left_company`, `added_role`. The default leaves out `added_role` (side roles such as advisor or board seats). Title edits that only change case or punctuation are never alerted. Every change is still stored, so `npm run status` counts them all.

`ALERT_MODE` chooses `realtime` (one Slack message per change), `digest` (one message a day) or `both`.

## Route alerts to each account owner

Put an owner column in your CSV (HubSpot's `Contact owner` works). Then in `.env`:

```bash
# Each owner's alerts go to their own channel; everyone else's go to SLACK_WEBHOOK_URL
SLACK_ROUTES={"Sam Lee": "https://hooks.slack.com/services/T0/B1/aaa",
  "Ana Diaz": "https://hooks.slack.com/services/T0/B2/bbb"}
# @mention the owner (Slack profile, three dots, Copy member ID)
OWNER_SLACK_IDS={"Sam Lee": "U012ABCDEF"}
```

Owner names match your CSV, ignoring case and spaces. Create one incoming webhook per channel ([the steps](../README.md#send-job-change-alerts-to-slack)). In `.env`, keep the JSON on one line; it is split here only to fit the page. The daily digest always goes to `SLACK_WEBHOOK_URL`.

## Change the wording

`alertLines` in `src/slack.ts` builds every alert and digest line, per kind. `detailLine` in `src/email.ts` does the same for the email. Update `test/slack.test.ts` if you change the wording it checks.

## Track another signal

`JOB_CHANGE_TRACK` in `src/crustdata.ts` is a `track` tree: leaves joined with `or` or `and`. Any field in the person profile can be tracked; `changed` works on single values and `added` on lists.

| Signal | Leaf |
|---|---|
| New current position | `{ "field": "experience.employment_details.current", "type": "added" }` |
| Title changed | `{ "field": "basic_profile.current_title", "type": "changed" }` |
| Role ended | `{ "field": "experience.employment_details.past", "type": "added" }` |
| Relocated | `{ "field": "basic_profile.location.raw", "type": "changed" }` |
| Headline changed | `{ "field": "basic_profile.headline", "type": "changed" }` |
| New degree | `{ "field": "education.schools", "type": "added" }` |
| New skill | `{ "field": "skills.professional_network_skills", "type": "added" }` |
| New certification (needs field permission on your key) | `{ "field": "certifications", "type": "added" }` |

Adding a signal takes five edits. Relocation as the example:

1. Add the leaf to `JOB_CHANGE_TRACK` in `src/crustdata.ts`.
2. In `src/notification.ts`, add `"relocated"` to `ChangeKind` and `ALERT_KINDS`, add any fields the alert needs to `JobChange` (for example `previousLocation` and `newLocation`), and in `classify` return `{ kind: "relocated", ... }` when `changes` has `field === "basic_profile.location.raw"`, before the final `return undefined`. Add a `headline` case.
3. Add a `"relocated"` case to `alertLines` in `src/slack.ts`, `detailLine` in `src/email.ts`, and a heading in `KIND_HEADINGS` in `src/slack.ts` (the typecheck fails until you do).
4. Turn it on: add `relocated` to the `ALERT_KINDS` default in `src/config.ts`, `.env.example` and the Configuration table in the README, or set `ALERT_KINDS` in your `.env`. New kinds are stored but not alerted until they are listed there.
5. Copy a fixture to `fixtures/relocated.json` with that change, and add a test in `test/notification.test.ts`.

A watch's `track` cannot be edited, and import refuses to reuse a watch whose `track` differs from `JOB_CHANGE_TRACK`. Recreate it (new people are baselined silently, so this sends no false alerts):

```bash
npm run delete-watch
npm run import -- champions.csv
```

Full list of trackable fields: the [Person Enrich reference](https://docs.crustdata.com/person-docs/enrichment/reference).

## Catch moves sooner

Set `REFRESH_FREQUENCY_DAYS` to `14`, `7`, `3` or `1` in `.env` and run `npm run import -- champions.csv` again; the bot updates existing watches in place. Each changed person then costs 10, 20, 50 or 150 credits instead of 5.

## Add more detail to each alert

To add facts about the new employer, such as headcount, growth and last funding round, call Crustdata [`POST /company/enrich`](https://docs.crustdata.com/company-docs/enrichment/introduction) (2 credits per company, 4 with technographics) in `handleNotification` in `src/handle.ts`, store the result on the change, and show it in `alertLines` in `src/slack.ts`. That is also where an AI-written line would go.

## Send changes to your CRM

`handleNotification` in `src/handle.ts` sees every new change in one place, after it is stored. Add a call there to create a task or update a contact in HubSpot, Salesforce or Attio.

## Use Google Chat or email instead of Slack

Crustdata watches can also deliver to Google Chat (`{ "type": "google_chat", "url": "..." }`) or email (`{ "type": "email", "to": ["..."] }`) directly. For formatted messages from this server, replace `postToSlack` in `src/slack.ts`.
