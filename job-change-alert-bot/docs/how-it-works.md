# How the job change alert bot works: every Crustdata API call

Every Crustdata request this bot makes, with request and response shapes, in the order they happen. All requests go to `https://api.crustdata.com` with these headers:

```text
authorization: Bearer YOUR_API_KEY
content-type: application/json
x-api-version: 2025-11-01
```

Rate limited (429) and server error (5xx) responses are retried, six attempts in all, with exponential backoff that never waits less than `Retry-After`. Creating a watch is not retried on a server error, so a retry can never make a second, billed watch. Code: `request` in `src/crustdata.ts`.

## 1. Resolve emails to profiles

`npm run import` sends the emails that do not have a profile URL yet, 25 per request, one request every 2 seconds (the limit is 30 a minute). Results are saved after every request, so an interrupted import never pays twice.

```http
POST /person/identify
{ "emails": ["jane.doe@acme.com", "sam@fabrikam.com"] }
```

The response has one row per email, in request order:

```json
[
  {
    "matched_on": "jane.doe@acme.com",
    "match_status": "matched",
    "matches": [{
      "confidence_score": 1,
      "person_data": {
        "crustdata_person_id": 6324687,
        "basic_profile": { "name": "Jane Doe", "current_title": "Director of Sales" },
        "social_handles": { "professional_network_identifier": { "profile_url": "https://..." } }
      }
    }]
  },
  { "matched_on": "sam@fabrikam.com", "match_status": "not_found", "matches": [] }
]
```

- Cost: 1 credit per `matched` row. `not_found` and `redacted` rows are free. `redacted` means the person asked Crustdata to remove their data; the bot never looks them up again.
- `confidence_score` is 1 for an exact email match, and 0.5 to 1 when Crustdata matched by name and company domain. `MIN_MATCH_CONFIDENCE` skips matches below a threshold.
- One malformed address fails the whole request with `400 Invalid emails: ...`; the bot screens addresses first and retries without any the API rejects.
- Email lookup is enabled per account. Without it the request returns `403`.

Code: `identifyEmails` in `src/crustdata.ts`.

## 2. Create the watch

The bot keeps one watch per 10,000 people. When it has no watch ids yet (a fresh database, or a second machine), it checks `GET /watch/person?status=active` for watches already delivering to the same URL and uses those instead of creating duplicates. If creating a watch fails, it checks the same list in case the create went through.

```http
POST /watch/person
{
  "entities": { "professional_network_profile_urls": ["https://...", "https://..."] },
  "track": {
    "op": "or",
    "conditions": [
      { "field": "experience.employment_details.current", "type": "added" },
      { "field": "basic_profile.current_title", "type": "changed" },
      { "field": "experience.employment_details.past", "type": "added" }
    ]
  },
  "fields": ["basic_profile", "experience", "social_handles"],
  "config": {
    "trigger": { "type": "interval", "every_hours": 24 },
    "refresh_frequency_days": 30,
    "max_results_per_run": 1000
  },
  "notifications": [{ "type": "webhook", "url": "https://your-server.com/webhooks/crustdata" }]
}
```

- `track` decides **when** a notification fires: a new current position, a title change, or a role ending (how someone leaving without a new job shows up).
- `fields` decides **what** each notification carries about the person. It does not change the price.
- `refresh_frequency_days` decides how fresh the tracked data is kept, and the price per changed person: 30 days costs 5 credits, 14 costs 10, 7 costs 20, 3 costs 50, 1 costs 150.

`track` and `fields` are fixed from here on; freshness and the report interval are not. When the list changes, the bot replaces it instead of creating another watch:

```http
PATCH /watch/person/{id}
{ "entities": { "professional_network_profile_urls": ["...the full list..."] } }
```

New people are baselined silently on the next run. The same `PATCH` applies a changed `REFRESH_FREQUENCY_DAYS` or `CHECK_EVERY_HOURS` (`{ "config": { "trigger": { ... }, "refresh_frequency_days": 7 } }`) on import, and a changed `PUBLIC_URL` (`{ "notifications": [{ "type": "webhook", "url": "..." }] }`) when the server starts.

## 3. The baseline run

Shortly after you create the watch, Crustdata runs it once. This run records each person's current state, fires on nothing and costs nothing. It sends one notification with up to five sample people, each with `changes: []`. The server logs it and stores nothing. See `fixtures/baseline.json`.

## 4. A job change arrives

On a later run, for each person whose `track` condition just became true, Crustdata sends:

```http
POST https://your-server.com/webhooks/crustdata
x-crustdata-signature: t=1792000000,v1=5f2b...
```

```json
{
  "metadata": { "watch_id": 50991, "run_id": 64200, "payload_delivery": { "type": "inline" } },
  "results": [{
    "changes": [
      { "field": "experience.employment_details.current", "type": "added",
        "new_elements": [{ "title": "VP of Sales", "name": "Northwind Analytics", "is_default": true }] },
      { "field": "basic_profile.current_title", "type": "changed",
        "from": "Director of Sales", "to": "VP of Sales" },
      { "field": "experience.employment_details.past", "type": "added",
        "new_elements": [{ "title": "Director of Sales", "name": "Contoso Cloud" }] }
    ],
    "record": {
      "crustdata_person_id": 6324687,
      "basic_profile": { "name": "Sherry Robinson", "current_title": "VP of Sales" },
      "experience": { "employment_details": {
        "current": [{ "title": "VP of Sales", "name": "Northwind Analytics" }],
        "past": [{ "title": "Director of Sales", "name": "Contoso Cloud" }]
      } },
      "social_handles": { "professional_network_identifier": { "profile_url": "https://..." } }
    }
  }]
}
```

Positions also carry `start_date`, `end_date`, `crustdata_company_id`, `company_website_domain`, `position_id` and more; the full example is `fixtures/job-change.json`. The server:

1. **Checks the request.** The `x-crustdata-signature` header must be present and the body under 5 MB before anything is read. `v1` must equal HMAC-SHA256 of `${t}.${rawBody}`, keyed by your API key, and `t` must be within 5 minutes. Code: `signatureProblem` in `src/crustdata.ts`.
2. **Checks the shape.** A body without `metadata.watch_id` or with non-array `results` gets a 400. Test sends (`metadata.test: true`) and notifications from watches that are not this bot's are acknowledged and ignored.
3. **Reads the results.** Inline in `results`, or, for watches set to `payload_delivery_type: "link"`, from the NDJSON file at `metadata.payload_delivery.url` (one result per line; only `https` URLs on `amazonaws.com` are fetched).
4. **Classifies each result.** A new main position at a different company is `new_company`; a new position or title at the same company is `title_change`; a role ending with nothing current is `left_company`; a new position elsewhere while the main role (`is_default`) continues is `added_role`; a title that only changed in case or punctuation is `title_edit`. Code: `classify` in `src/notification.ts`.
5. **Stores everything in one transaction.** Each change has the id `watch:run:person`, so a redelivered notification is ignored. Then it answers 200.
6. **Delivers alerts.** A background loop posts each alert to Slack (the owner's channel when `SLACK_ROUTES` has one), about one per second. A Slack rate limit pauses that webhook for as long as Slack asks; other failures are retried with backoff until the alert is two days old, and the next digest says if any never got through.

Charged: 5 credits for this person, at the default freshness.

## 5. Catching up on missed deliveries

Crustdata delivers each run once. Its run history records whether delivery worked (`notification_http_status`) and keeps the run's records. At startup and every 6 hours (or with `npm run catch-up`), the server reads it, paging back about 30 days:

```http
GET /watch/person/{id}/runs?limit=25&cursor=...
GET /watch/person/{id}/runs/{run_id}/summary
```

The summary carries `records_download.url`, a signed NDJSON file with one result per line. The bot also reads the other formats the docs describe: `payload_delivery.url` for link watches, and an inline `notifications[].payload.notifications[]` list. Every run with changes whose delivery did not get a 2xx, and that the bot has not already handled, is handled exactly as in step 4. Handled runs are remembered (only after they are stored), so nothing is processed twice; a run that fails to download is retried next time without holding up the others. `npm run catch-up` only stores what it recovers; the running server posts it, so nothing goes to Slack twice. Code: `catchUpMissedRuns` in `src/handle.ts`.

## 6. The daily digest

At `DIGEST_HOUR_UTC` (or as soon as the server is back if it was down then), the server collects every alert not yet in a digest and posts it to Slack grouped by kind, split into as many messages as Slack's limits need (up to 20; beyond that it counts the rest and `npm run changes` lists them), plus one email if Resend is configured. A Slack rate limit is waited out and retried. Changes are marked as digested only when a channel accepted the digest. It also checks each watch with `GET /watch/person/{id}` and posts a warning if one is paused, suspended (out of credits) or has stopped running. Code: `src/digest.ts`.

## Testing without waiting for a real move

- `npm run replay -- fixtures/job-change.json` classifies a saved notification (step 4.4) and prints the alert it would produce, without storing or posting anything. Add `--slack` to post it.
- `npm run test-webhook` asks Crustdata to send a signed sample notification to your server, for free:

```http
POST /watch/person/{id}/test
{}
```

## Managing the watch

| Action | Request | Command |
|---|---|---|
| Status and counters | `GET /watch/person/{id}` | `npm run status` |
| Run history | `GET /watch/person/{id}/runs` | `npm run status` |
| Use an existing watch | `GET /watch/person/{id}` | `npm run adopt -- <id>` |
| Pause or resume | `PATCH /watch/person/{id}` with `{ "status": "paused" }` | `npm run pause`, `npm run resume` |
| Cancel | `DELETE /watch/person/{id}` | `npm run delete-watch` |

Reference: [Person Entity Watcher](https://docs.crustdata.com/watcher-docs/person/entity), [Payload delivery](https://docs.crustdata.com/watcher-docs/payload-delivery), [Identify People](https://docs.crustdata.com/api-reference/person-apis/identify-people-from-profile-urls-emails-or-google-scholar-profile-urls), [Rate limits](https://docs.crustdata.com/general/rate-limits).
