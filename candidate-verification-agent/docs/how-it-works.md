# How Candidate Verification Agent works

Every Crustdata request a run makes, in order, with what it costs. Every request sends
`authorization: Bearer $CRUSTDATA_API_KEY`; all except `GET /batch/{id}` and `GET /batch/` also send
`x-api-version: 2025-11-01`.

Crustdata is a people and company data API with 1B+ profiles and 60M+ companies. Candidate Verification Agent
is open-source TypeScript: [README](../README.md).

## 1. What the key can use (free)

```bash
curl https://api.crustdata.com/account/endpoints \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" -H "x-api-version: 2025-11-01"
```

The agent reads three entries: `/batch/person/verify` (`"status": "enabled"` means the full check),
`/person/enrich` (its `fields.enabled` list includes `assessment` when the quick screen is available) and
`/person/identify` (email lookup). `--dry-run` stops after this call and prints the plan.

## 2. Emails to profile URLs (1 credit per match)

Only for rows with no profile URL. Up to 25 emails per call, 30 calls a minute.

```bash
curl -X POST https://api.crustdata.com/person/identify \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" -H "x-api-version: 2025-11-01" \
  -H "content-type: application/json" \
  -d '{ "emails": ["jane.doe@example.com"] }'
```

```json
[{ "matched_on": "jane.doe@example.com", "match_status": "matched",
   "matches": [{ "confidence_score": 1.0, "person_data": {
     "social_handles": { "professional_network_identifier": {
       "profile_url": "https://www.linkedin.com/in/example-jane-doe" } } } }] }]
```

The agent uses a match only when there is exactly one with `confidence_score` 1. Anything looser goes to
`unresolved.csv`: checking the wrong person is worse than skipping a row. It also skips a match whose profile name
looks like another person (a different surname, or first names with different initials; word order, titles,
initials and "Last, First" do not count).

## 3. Profile details (1 credit per profile found)

Up to 25 profile URLs per call, 15 calls a minute (the agent waits about 4 seconds between calls).

```bash
curl -X POST https://api.crustdata.com/person/enrich \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" -H "x-api-version: 2025-11-01" \
  -H "content-type: application/json" \
  -d '{ "professional_network_profile_urls": ["https://www.linkedin.com/in/example-jane-doe"],
        "fields": ["basic_profile", "experience", "education", "social_handles",
                   "assessment"] }'
```

```json
[{ "matched_on": "https://www.linkedin.com/in/example-jane-doe", "match_status": "matched",
   "matches": [{ "confidence_score": 1.0, "person_data": {
     "basic_profile": { "name": "Jane Doe", "current_title": "Senior Engineer" },
     "experience": { "employment_details": {
       "current": [{ "title": "Senior Engineer", "name": "Example Co",
                     "start_date": "2022-03-01T00:00:00+00:00", "end_date": null,
                     "employment_type": "", "is_default": true }],
       "past": [] } },
     "education": { "schools": [{ "school": "Example University",
                    "degree": "Bachelor of Science", "start_year": 2014, "end_year": 2018 }] },
     "assessment": { "authenticity": { "verdict": "clearly_genuine", "tier": 0 } } } }] }]
```

The name and current role go next to every verdict. `assessment.authenticity` is the quick screen's verdict
(tier 0 is most trusted, 9 least). A profile Crustdata does not have comes back `"match_status": "not_found"` and
costs nothing. A key without the `assessment` field gets a 403 naming it; the agent drops the field and asks again.

## 4. Batch Person Verification: submit a job (10 credits per verdict, billed when the job finishes)

Profiles go out in jobs of 10. At most 5 jobs run at once (a sixth submit gets 429) and at most 5 are
submitted a minute. Each job id is saved in `out/<list>/state.json` as soon as it comes back.

```bash
curl -X POST https://api.crustdata.com/batch/person/verify \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" -H "x-api-version: 2025-11-01" \
  -H "content-type: application/json" \
  -d '{ "professional_network_profile_urls":
          ["https://www.linkedin.com/in/example-jane-doe"] }'
```

```json
{ "batch_id": "b82e4e5e-8812-4f47-bccd-0439315695b0", "status": "pending", "entity": "person",
  "action": "verify", "identifier_count": 1,
  "status_url": "/batch/b82e4e5e-8812-4f47-bccd-0439315695b0" }
```

Every submission is saved in `out/<list>/state.json` before it is sent. If the answer is lost (a timeout, a dropped
connection, a 5xx), the job may still exist, so the agent never sends the same people again in that run: it holds
them and the rest of the list and says so. The next run reads `GET /batch/?limit=100` first and looks at the
verification jobs with the same number of people: a finished one whose results name only these people is adopted;
while one is still running, or the list cannot be read, the people stay held; only when there is no such job (or
the only ones billed nothing) are they sent again. People already in another list's running job are not sent
again either.

## 5. Batch Person Verification: poll the job (free)

Every 10 seconds, for each running job:

```bash
curl https://api.crustdata.com/batch/b82e4e5e-8812-4f47-bccd-0439315695b0 \
  -H "authorization: Bearer $CRUSTDATA_API_KEY"
```

```json
{ "batch_id": "b82e4e5e-...", "status": "completed", "action": "verify",
  "identifier_count": 10, "result_count": 9, "entities_fulfilled": 9,
  "download_url":
    "https://crustdata-batch-api-data.s3.amazonaws.com/.../results.jsonl.gz?..." }
```

`status` goes `pending`, `processing`, then `completed` or `failed`. A failed job is not charged and is sent once
more; a second failure marks its people "Not checked". With `result_count: 0` nothing is downloaded. Jobs
usually finish in a minute or two. After `--wait` minutes (30) the agent saves and stops; the next run polls the
same jobs instead of submitting new ones.

## 6. The results file (free)

The agent downloads `download_url` only over https from Crustdata's storage host, with a size limit, and reads
it line by line (a bad line is skipped and counted, never fatal). One line per person with a verdict:

```json
{ "original_identifier": "https://www.linkedin.com/in/example-jane-doe",
  "internal_id": 1052069,
  "data": { "verdict": "probably_genuine", "confidence": 0.65,
    "reasoning": "Current role is supported by coworker engagement ...",
    "flags": ["past_roles_unverified"],
    "coverage": { "social_ran": true, "posts_fetched": 2, "posts_checked": 2,
                  "engagers_seen": 58, "engagers_resolved": 56, "coworker_hits": 7,
                  "timeline_flags": 0, "flags": [] },
    "citations": [{ "url": "https://...", "title": "...", "cited_text": "..." }] } }
```

People missing from the file got no verdict and are not charged; the agent shows their quick screen when it has
one, labelled as such, or "Not checked".

## 7. What the agent does with it (no requests)

- **Review order:** 1 contradicted, 2 probably fabricated, 3 different role, 4 not a person, 5 a high-risk or
  some-risk quick-screen score, 6 cannot verify (also a quick-screen "no signal", dates that overlap study, or a name
  that differs from your file), 7 not checked, 8 probably genuine, 9 confirmed, 10 a low-risk quick-screen score.
  The groups: Review first (1, 2), Clarify in the screen (3, 4), Ask in the first call (5, 6), Not checked (7),
  Holds up (8, 9), Low-risk profile score (10). Inside a group, rows keep your file's order; confidence is not used,
  because Crustdata fixes it to a band per verdict.
- **Summary line:** the verdict in words, the first sentence of the reasoning, the coworker count, and plain words
  for `posts_unavailable` and `past_roles_unverified`.
- **Files:** `verified.csv` (your columns unchanged, then ours), `report.md`, `unresolved.csv`, `results.json`,
  and every result in `out/checked.json` so the same person on another list within 30 days is free.
- **Slack:** one message with the counts and the candidates to review first or clarify in the screen, if
  `SLACK_WEBHOOK_URL` is set (`SLACK_DETAIL=counts` for numbers only).
- **AI (`--ai`, off by default):** Claude gets each result's verdict, current role and company, reasoning,
  coverage, flags and source titles (a source's URL when it has no title), with the name removed, and writes one
  sentence; then one overview paragraph from the counts.

## Cost, worked out

| List | Full check | Quick screen |
|---|---|---|
| 10 candidates with profile URLs | at most 110 credits | at most 10 |
| 50 candidates, 5 of them email only | at most 555 credits | at most 55 |
| The same 50 again within 30 days | 0 | 0 |

Profiles with no verdict, failed jobs, missed lookups, polling and downloads are free.
