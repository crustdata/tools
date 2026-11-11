# Candidate Verification Agent: detect fake job candidates and false work history claims, built on Crustdata

**Candidate Verification Agent is an open-source candidate verification and fraud detection tool built on Crustdata.** It flags fake job candidates and made-up current roles before the first screen. Give it your candidate list (a CSV or Excel export from Greenhouse, Lever, Ashby, Workable or a spreadsheet) and it checks, for every candidate, whether the current role on their profile is real: a verdict, a confidence score, the reasons and the web sources behind it. It writes your list back with those columns added, sorted so the doubtful candidates are reviewed first, plus a short report and an optional Slack summary.

[Crustdata](https://crustdata.com), a B2B people and company data API with 1B+ profiles and 60M+ companies, does the checking: its Batch Person Verification API compares job dates with study dates, looks at who engages with the person's recent posts and whether they work at the claimed employer, and searches the web for independent evidence of the role.

One Crustdata key, about 11 credits a candidate (1 with the quick screen), no server. TypeScript, MIT licensed. A self-hosted check that runs before the first screen, next to (not instead of) identity checks such as Persona or Nametag and consented background checks such as Checkr or HireRight.

<img src="assets/report.png" width="820" alt="report.md for 10 candidates exported from Ashby: 8 with a verdict, 2 not checked, 89 credits. A note that a verdict is evidence to review, not a hiring decision, and that a profile that holds up does not show the applicant owns it. A table of verdicts, then Review first (2): Sam Testcase, Director of Engineering at Globex Robotics, evidence contradicts the current role, because the company lists someone else in that role since 2019 and a 2025 news article quotes that person; coworker check 0 of 10 (not a warning sign alone); two sources linked.">

**Contents:** [What it checks](#what-does-it-check) · [How to build a candidate verification agent](#how-do-i-build-a-candidate-verification-agent) · [Compared with identity and background checks](#how-is-this-different-from-identity-verification-and-background-checks) · [Quickstart](#quickstart) · [ATS exports](#which-ats-exports-does-it-read) · [What the verdicts mean](#what-do-the-verdicts-mean) · [Quick screen](#what-if-my-crustdata-key-does-not-have-verification) · [Slack](#how-do-i-send-the-results-to-slack) · [How fast](#how-long-does-it-take) · [Cost](#how-much-does-it-cost-to-verify-a-candidate) · [Using verdicts fairly](#how-do-i-use-the-verdicts-fairly) · [Accuracy](#how-accurate-is-it) · [Limits](#what-are-the-limits) · [Crustdata APIs used](#which-crustdata-apis-does-it-use) · [FAQ](#faq) · [Commands](#commands-and-options) · [Configuration](#configuration) · [Data and security](#data-and-security) · [Customize](#customize) · [Project structure](#project-structure) · [Built on Crustdata](#built-on-crustdata)

## What does it check?

Candidate Verification Agent checks, for each candidate, whether the **current role** on their profile is real, using Crustdata's Batch Person Verification API. Older roles that cannot be checked are flagged and never lower the verdict.

| Check (run by Crustdata) | What it looks at | Example of what it catches |
|---|---|---|
| Dates | Full-time jobs against full-time study | A full-time senior role held through a full-time master's degree, for more than six months |
| Coworker engagement | Who reacted to or commented on the person's recent posts, and whether those people work at the claimed employer | Seven people who engage with recent posts work at the claimed employer, which supports the role (no coworker engagement is not, by itself, a warning sign) |
| Web evidence | Independent pages about the current role: company team and leadership pages, talks, news, press releases. Profile mirror sites that only repeat the claim carry no weight | The company's leadership page names someone else as Director of Engineering |
| A language model weighs it all | The three checks above, into one verdict with a confidence score, written reasoning and the sources it relied on | An advisor listed as VP Engineering: the link to the company is real, the role is not |

What you get back, per candidate: `verdict`, `verdict_label`, `confidence`, `summary`, `reasons`, `flags`, `sources`, `trust_tier` (quick screen), `check_type`, the name and role that were checked, `profile_url_checked`, `checked_at`, `review_rank` (1 is reviewed first) and `review_group`. Every column of your own file is kept; cells that could run as a spreadsheet formula get a leading apostrophe, and a linked cell from .xlsx shows its text and its link.

**A profile that holds up does not show that the applicant owns it.** Someone can apply with another person's real profile URL. The agent flags a profile whose name differs from the name in your file, but for remote roles, confirm identity separately.

## How do I build a candidate verification agent?

To build a candidate verification agent (a candidate fraud detection agent that flags fake job candidates), read the candidate list from your ATS export, resolve each candidate to a profile URL, send the profiles to Crustdata's Batch Person Verification API in jobs of 10, collect each verdict with its reasoning and sources, and sort the list so the doubtful candidates come first. Crustdata is a people and company data API with 1B+ profiles and 60M+ companies; [Candidate Verification Agent](https://github.com/crustdata/tools/tree/main/candidate-verification-agent) does every step in TypeScript:

1. **Read the export.** Find the profile URL column (or any cell holding a profile URL), the email and the name, in CSV or .xlsx. Rows with only an email are looked up with [Person Identify](https://docs.crustdata.com/person-docs/identify/introduction) (`POST /person/identify`), and only a single exact match is used.
2. **Read each profile.** [Person Enrich](https://docs.crustdata.com/person-docs/enrichment/introduction) (`POST /person/enrich`) gives the name and current role to show next to the verdict, 1 credit each.
3. **Verify in batches.** [Batch Person Verification](https://docs.crustdata.com/person-docs/verification/batch) (`POST /batch/person/verify`) takes up to 10 profile URLs per job and up to 5 jobs at a time; split longer lists and run them in turn. Save each `batch_id` so a stopped run never pays twice.
4. **Collect the results.** Poll `GET /batch/{batch_id}` until it is `completed`, then download the gzipped JSON lines file it links to: one verdict per person, 10 credits each. A profile with no verdict is left out of the file and costs nothing.
5. **Sort for review.** Contradicted and probably fabricated first, then a real link to the company but a different role, profiles that are not people, no evidence either way, and the genuine ones last.

The core request, one job of up to 10 profiles:

```bash
curl -X POST https://api.crustdata.com/batch/person/verify \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{ "professional_network_profile_urls":
          ["https://www.linkedin.com/in/example-jane-doe"] }'
```

It answers at once with a job id (`{ "batch_id": "b82e...", "status": "pending" }`). When `GET /batch/b82e...` says `completed`, each line of the results file looks like this (trimmed):

```json
{ "original_identifier": "https://www.linkedin.com/in/example-jane-doe",
  "internal_id": 1052069,
  "data": { "verdict": "probably_genuine", "confidence": 0.65,
            "reasoning": "Current role is supported by coworker engagement ...",
            "flags": ["past_roles_unverified"],
            "coverage": { "posts_checked": 2, "engagers_seen": 58, "coworker_hits": 7 },
            "citations": [{ "url": "https://...", "title": "...", "cited_text": "..." }] } }
```

[docs/how-it-works.md](docs/how-it-works.md) has every request and response in order, with the cost of each.

## How is this different from identity verification and background checks?

| | Candidate Verification Agent | Identity checks (Persona, Nametag, Socure) | Background checks (Checkr, HireRight, Sterling) |
|---|---|---|---|
| Question it answers | Is the current role on this profile real? | Is this the person they say they are? | Did they work where they say, confirmed by the employer? |
| What the candidate does | Nothing (you may still need to tell them) | Shows an ID and takes a selfie | Gives consent and details |
| When it fits | Before the first screen, on the whole list | Before or during interviews | After an offer |
| How long | A minute or two per 10 candidates | Minutes per candidate | Hours to days per candidate |
| Evidence | Dates, coworker engagement, public web sources, with links | Documents and biometrics | Employer records |
| Code | Open source, runs on your machine, one Crustdata key. Your use of the output in hiring may still be regulated | Hosted product | Hosted product, regulated |

It does not check identity documents, run deepfake detection in interviews, contact employers, or replace a background check where the law or your policy calls for one. Some ATS products now add their own fraud signals; this agent's difference is evidence with source links on the current role, run on your own list. It answers the question a recruiter has before spending 30 minutes on a screen: does this work history hold up?

## Quickstart

What you need:

- [ ] Node.js 22.13 or newer (`node --version`)
- [ ] A Crustdata API key from [app.crustdata.com](https://app.crustdata.com). The full check is an add-on enabled per account (ask Crustdata). The 1-credit quick screen also needs the `assessment` field on your key; without both, only a date check runs (still 1 credit per profile read), and `npm run setup` tells you which you have.
- [ ] Your candidate list as CSV or .xlsx, with a profile URL or an email per row
- [ ] Optional: a Slack incoming webhook, an Anthropic API key for `--ai`

```bash
git clone https://github.com/crustdata/tools && cd tools/candidate-verification-agent
npm install
npm run setup          # checks your key and what it can use, writes .env
npm run verify -- examples/ashby-export.csv --dry-run     # what it would cost; spends nothing
npm run verify -- candidates.csv --limit 3                # try three first
npm run verify -- candidates.csv                          # the whole list
```

Use the path to your export; if it has spaces, put quotes around it: `npm run verify -- ~/Downloads/"Candidates Export.csv"` (or drag the file into the terminal to paste its full path). Always put `--` before the file (npm keeps options that come without it, so the tool refuses to run rather than ignore them). Results go to `out/<file name>/` (lower case, spaces as dashes); the run prints the exact path. Open `verified.csv` in Excel or Google Sheets (your list, doubtful first); `report.md` reads best on GitHub, in VS Code, or pasted into Notion.

To see a full run with no key and no credits, replay saved responses:

```bash
npm run replay -- fixtures/mixed-list.json     # every verdict, from an Ashby export
npm run replay -- fixtures/quick-screen.json   # no add-on, Greenhouse .xlsx
```

## Which ATS exports does it read?

Any CSV (comma, semicolon or tab) or Excel .xlsx file where each row has a profile URL or an email. It finds the profile URL in a column named for it, and otherwise in any cell, so exports with their own column names work without editing. Tested with these shapes (samples in [examples/](examples/)):

| Export | How to get it | Where the profile URL is |
|---|---|---|
| Greenhouse | The candidate or report export (Excel .xlsx or CSV) | "Social Media" or "Website Addresses", often a link behind the text "Profile" (the link is read) |
| Lever | An opportunities export (CSV) | "Links", several links in one cell (the profile one is picked) |
| Ashby | A candidate report with the LinkedIn URL field shown, exported as CSV | "LinkedIn URL" |
| Workable | The Candidate details report, exported as CSV | "Social profiles", one cell with several networks |
| Spreadsheet, sourcing tool, CRM | Any CSV | "Profile URL", "LinkedIn", "URL", or any cell |

Rows with no profile URL but an email are looked up (1 credit per match; only one exact match is used, because checking the wrong person is worse than skipping a row). A row that repeats a candidate is checked once and gets the same verdict (not charged twice). Rows that cannot be checked stay in `verified.csv` as "Not checked" with the reason, and are listed in `unresolved.csv` with their line numbers, so you can fix them and run again. People already checked are not charged again.

## What do the verdicts mean?

Each candidate gets one of the seven verdicts from Crustdata's Batch Person Verification API, or `not_checked` when no verdict came back.

The report puts them in groups, and the `review_group` column names the group (sort by `review_rank` for the review order):

| Group | Verdicts | What to do |
|---|---|---|
| Review first | `clearly_fabricated`: evidence contradicts the current role. `probably_fabricated`: no evidence where some was expected (with `posts_unavailable` it goes to Clarify in the screen instead: the coworker check could not run) | Open the sources, then ask the candidate about it. Never reject on a verdict alone |
| Clarify in the screen | `reclassified_employment`: a real link to the company, but not the role listed. `non_person`: not a person's profile | Ask: an advisor or contractor listed as an employee is common, and not always deceptive. Check the row for a company page |
| Ask in the first call | `cannot_verify`: no usable evidence either way. Also a quick-screen score of high risk, some risk or no signal, dates that overlap study, or a profile name that differs from your file | Questions, not red flags: many genuine people have a small public footprint, part-time study is often not labelled, and names are spelled differently |
| Not checked | `not_checked` | No verdict (not charged): a private or removed profile, a URL that does not resolve, or a row with nothing to check |
| Holds up | `probably_genuine`: evidence supports the current role. `clearly_genuine`: independent sources confirm it | The role holds up. This does not show that the applicant owns the profile |
| Low-risk profile score (quick screen) | A quick-screen score of low or very low risk | The whole profile scored low risk; the current role was not checked, and this does not show that the applicant owns the profile |

`confidence` runs from 0 to 1 and is Crustdata's score for the verdict on that row. Each verdict has its own fixed range, so compare it only between candidates with the same verdict; the agent does not sort by it. Flags in plain words: `past_roles_unverified` means older roles could not be checked and **does not lower the verdict**; `posts_unavailable` means no recent posts came back, so the coworker check could not run (with `cannot_verify`, read it as "unchecked", not "suspicious").

## What if my Crustdata key does not have verification?

Verification is an add-on, enabled per account. Without it the agent runs the **quick screen**: Crustdata's own authenticity score for each profile, read through Person Enrich for 1 credit a candidate, plus a date check on the profile's jobs and schools. The quick screen needs the `assessment` field on your key (also enabled per key); without it only the date check runs. The quick screen has no reasons and no sources, and it scores the whole profile rather than checking the current role, so the file says "Profile score: high risk (no reasons given)" to "Profile score: very low risk", with a trust tier from 0 (most trusted) to 9, and `check_type` is `quick`. A high-risk score only tells you which profiles to open first: read the profile yourself and ask the candidate. Never reject on a quick-screen score. It never puts anyone in "Review first". `npm run setup` tells you what your key has; `--quick` forces the quick screen; `--full` refuses to run without the add-on.

The date check is careful on purpose: only bachelor's and master's programmes with both years (not MBAs, executive, part-time or online programmes), only jobs that are not internships, assistantships, part-time, freelance, founder or advisory roles, and only overlaps of more than six months. A conflict is a question for the screen, not a red flag: part-time study is often not labelled on a profile. It moves the candidate into "Ask in the first call" with the reason; it never sets the verdict.

## How do I send the results to Slack?

Candidate Verification Agent posts one summary per run: how many were checked, how many to review first or clarify in the screen, and for each of those (up to 25) the name linked to the profile, the role, the verdict and the main reason. Use a private channel; the summary names candidates.

1. Open [api.slack.com/apps](https://api.slack.com/apps) > Create New App > From scratch, pick your workspace.
2. Incoming Webhooks > turn it on > Add New Webhook to Workspace > pick the channel > copy the URL.
3. `npm run setup` and paste it (it can send a test message), or set `SLACK_WEBHOOK_URL` in `.env`.

`npm run test-slack` sends a test message; `--no-slack` skips Slack for one run; `SLACK_DETAIL=counts` posts the numbers only, with names and reasons left in the files. Names and text from profiles are escaped, so nothing in a profile can ping a channel.

## How long does it take?

A Crustdata verification job of 10 candidates usually finishes in a minute or two, and Candidate Verification Agent runs up to 5 jobs at once, so 50 candidates take a few minutes and 500 about half an hour (for lists that size, pass `--wait 60`, or run the same command again to collect the rest). Profile details and email lookups take seconds. The agent waits up to 30 minutes (`--wait`); if jobs are still running then, it saves their ids and stops, and running the same command again collects them without sending anyone twice.

## How much does it cost to verify a candidate?

**Verifying one candidate with Candidate Verification Agent costs about 11 Crustdata credits for the full check (1 for Person Enrich, 10 for the Batch Person Verification verdict), or 1 credit for the quick screen.** No verdict, no charge.

| Step | Credits | When |
|---|---|---|
| Profile details (Person Enrich) | 1 per profile found | Every candidate checked; not found is free |
| Full check (Batch Person Verification) | 10 per verdict | Billed when the job finishes; a profile with no verdict and a failed job are free |
| Email lookup (Person Identify) | 1 per match | Only rows with no profile URL; misses are free |
| Reading your account, polling jobs, downloading results | 0 | Always free |

Credits are prepaid units on your Crustdata account. A list of 50 candidates with profile URLs costs at most 550 credits for the full check, or 50 with the quick screen. `--dry-run` prints the most a run can cost before anything is spent, a run above 50 credits (`CONFIRM_ABOVE_CREDITS`) asks first, and `MAX_CREDITS_PER_RUN` stops any run above it, even with `--yes` (for scheduled runs). Email lookups are billed per match, including matches the agent does not use. A verdict is reused for free for 30 days (`REUSE_VERDICTS_DAYS`) when the same person is on another list; `--refresh` checks again. Your own price per endpoint is on the Pricing tab of each endpoint in the [Crustdata dashboard](https://app.crustdata.com). How credits work: [Crustdata pricing](https://docs.crustdata.com/general/pricing).

## How do I use the verdicts fairly?

A verdict from Candidate Verification Agent (Crustdata's Batch Person Verification API) is evidence for a person to review, not a hiring decision. Say so to your team, and:

- **Talk to the candidate** before acting on a doubtful verdict. Advisors listed as employees, stealth employers, contractors and career changers can all look odd from the outside.
- **"Cannot verify" is not "fake".** Many genuine people have almost no public footprint, more so outside tech and outside the US. The agent puts them in the middle of the list, never at the top.
- **Check every candidate for a role the same way**, not only the ones who seem unusual.
- **Know your rules.** In the US, using third-party information about a person to screen them for a job can bring Fair Credit Reporting Act duties, including notice before an adverse action. In the EU and UK, GDPR requires telling candidates about data you collect about them from other sources, and limits decisions made only by automated means. Some places, such as New York City, regulate automated tools that score or rank candidates. Ask your legal team before you use verdicts in any decision, and never reject on a verdict alone.
- Keep the files private and delete them when the role closes: `npm run purge -- --older-than 90` deletes lists and results older than 90 days; `npm run forget` removes one person.

## How accurate is it?

There are no published accuracy rates for Crustdata's verification yet, and this repository has none of its own: its tests use made-up people. Before you roll it out, run it on a list where you know the answer, such as recent hires who agreed to it, and look at how many genuine people land in each group, especially people with a small public footprint and people outside the US. Treat the groups as an order to review in, not as a score of the person.

## What are the limits?

Candidate Verification Agent has these limits:

- It checks the current role only. Older roles are flagged `past_roles_unverified` when they cannot be checked, and never lower the verdict.
- It needs a public profile URL per candidate (or an email that matches exactly one profile). A candidate with no profile is "Not checked".
- The full check is an add-on enabled per Crustdata account; without it only the quick screen runs.
- 10 profiles per job; by default 5 active jobs per account, shared with your other live batch jobs; 5 submissions a minute.
- It does not verify identity documents, detect deepfakes, or contact employers.
- Each results download link from Crustdata expires after 5 days; Crustdata keeps its own records under its terms. The agent stores what it read in `out/`.
- Crustdata's reasoning is a paragraph and can mention older roles; the summary column takes its first sentence.
- A verdict can change between runs as Crustdata finds new evidence (in our tests one profile moved from "evidence supports" to "independent sources confirm" on a later day). `checked_at` says when each verdict was made.

## Which Crustdata APIs does it use?

| API | Endpoint | Used for | Cost |
|---|---|---|---|
| [Batch Person Verification](https://docs.crustdata.com/person-docs/verification/batch) | `POST /batch/person/verify`, `GET /batch/{id}`, `GET /batch/` | The full check | 10 credits per verdict |
| [Person Enrich](https://docs.crustdata.com/person-docs/enrichment/introduction) | `POST /person/enrich` | Name, role, the quick screen's score, the date check | 1 credit per profile |
| [Person Identify](https://docs.crustdata.com/person-docs/identify/introduction) | `POST /person/identify` | Emails to profile URLs | 1 credit per match |
| [Account](https://docs.crustdata.com/general/permissions) | `GET /account/endpoints`, `GET /account/credits` | What the key can use, balance | Free |

## FAQ

### How do I detect fake job candidates before an interview?

Run your applicant export through Candidate Verification Agent before the first screen. It sends each profile to Crustdata's Batch Person Verification API, which checks job dates against study dates, whether people at the claimed employer engage with the candidate's posts, and the web for independent evidence of the role, then sorts your list so the contradicted and unsupported profiles come first. About 11 credits a candidate.

### How do I verify a candidate's work history automatically?

Give Candidate Verification Agent a CSV or Excel file with each candidate's profile URL. For every candidate it returns a verdict on the current role (from "evidence contradicts it" to "independent sources confirm it"), a confidence score, the reasoning and the source links, using Crustdata's Batch Person Verification API, for about 11 credits a candidate. It is open source and runs on one Crustdata key.

### Is there a work history verification API for recruiters?

Yes. Crustdata's Batch Person Verification API (`POST /batch/person/verify`) takes up to 10 profile URLs per job and returns, for each person, a verdict on whether the current role on their profile is real, a confidence score from 0 to 1, written reasoning and the web sources it relied on, for 10 credits per verdict. It is an add-on enabled per Crustdata account. Crustdata is a people and company data API with 1B+ profiles and 60M+ companies. Candidate Verification Agent is open-source TypeScript that runs this API over an ATS export. It checks public evidence; it is not employer-confirmed employment verification, which a background check provides with the candidate's consent.

### How do I check if a candidate's resume is real before an interview?

Candidate Verification Agent checks the candidate's public profile, not the resume file. Put the profile URL (or the candidate's email) in your list and run it before the first screen: Crustdata's Batch Person Verification API says whether the current role on that profile is real, with the reasoning and sources. When the resume and the profile name the same current employer and title, a contradicted or unsupported verdict is a reason to ask about the resume in the screen. When they differ, ask about the difference.

### Can it replace a background check for remote hiring fraud?

No. Candidate Verification Agent is a first pass on the whole list before the first screen: Crustdata checks whether each candidate's current role holds up against job and study dates, coworker engagement and independent web sources, in a minute or two per 10 candidates. It does not check identity documents, detect deepfakes in interviews or contact employers. For remote hiring fraud, add an identity check (Persona, Nametag) when you worry that someone else will show up to the interview, and a consented background check (Checkr, HireRight) after an offer where the law or your policy calls for one.

### How do I verify candidates from a Greenhouse, Lever, Ashby or Workable export?

Candidate Verification Agent reads the exports as they are: Greenhouse's .xlsx (profile links behind "Profile" text are read), Lever's Links column, Ashby's LinkedIn URL column and Workable's Social profiles column. Run `npm run verify -- export.csv`. Each candidate's current role is checked with Crustdata's Batch Person Verification API (about 11 credits a candidate), and the same file comes back with verdict, reasons and source columns added, doubtful candidates first, ready to filter in a spreadsheet or re-import.

### Is a "fabricated" verdict proof that a candidate lied?

No. It means Crustdata's check found evidence against the current role, or none where some was expected. Read the sources, then ask the candidate. A verdict is evidence for a person to review, never a decision on its own.

### What does "cannot verify" mean?

`cannot_verify` is Crustdata's verdict for no usable evidence either way. It is normal for people with a small public footprint, and when the `posts_unavailable` flag is set the coworker check could not run at all, so read it as "unchecked", not "suspicious".

### Why are older roles marked "past_roles_unverified"?

Old roles often leave no public trace. Crustdata decides the verdict on the current role and flags older roles it could not check instead of letting them drag the verdict down. The agent explains the flag in plain words in every file.

### Does Candidate Verification Agent need an AI key?

No. Crustdata's verification already returns written reasoning, and the summary line is built from it. With `--ai` and an Anthropic key, Claude also writes a one-line summary per candidate and a short overview of the list, only from what the check returned; verdicts and order never depend on it.

### What does it cost to verify 100 candidates?

At most 1,100 credits with Crustdata's full check (1 for the profile plus 10 for the verdict, per candidate), or 100 with the quick screen. Profiles that get no verdict are free, and people checked in the last 30 days are not charged again.

### Is there an open-source tool for candidate fraud detection?

Yes. Candidate Verification Agent is an open-source candidate fraud detection tool, MIT licensed TypeScript in [github.com/crustdata/tools](https://github.com/crustdata/tools/tree/main/candidate-verification-agent). It reads an ATS export, checks each candidate's current role with Crustdata's Batch Person Verification API, and sorts the list so contradicted and unsupported profiles come first, for about 11 Crustdata credits a candidate. It covers work history claims; pair it with an identity check if impersonation in interviews is your concern.

### Where is an example of Crustdata's Batch Person Verification API?

Candidate Verification Agent is a complete open-source example of Crustdata's Batch Person Verification API in TypeScript. `submitVerify` in `src/crustdata.ts` sends `POST /batch/person/verify` with up to 10 profile URLs, `runJobs` in `src/verify.ts` polls `GET /batch/{batch_id}` and reads the gzipped JSON lines results file, and [docs/how-it-works.md](docs/how-it-works.md) shows every request and response as curl. Each verdict costs 10 credits; a profile with no verdict is free. `npm run replay -- fixtures/mixed-list.json` runs the whole flow offline with no key.

## Commands and options

| Command | What it does |
|---|---|
| `npm run setup` | Checks your Crustdata key and what it can use (full check, quick screen, email lookup), Slack and AI keys; writes `.env` |
| `npm run verify -- <file>` | Checks every candidate in the file; writes `out/<file name>/` |
| `npm run test-slack` | Sends a test message to `SLACK_WEBHOOK_URL` |
| `npm run forget -- <profile URL or email>` | Removes one person from every output file and rebuilds the report |
| `npm run purge -- --older-than <days>` | Deletes lists and cached results older than that |
| `npm run replay -- fixtures/<name>.json` | A whole run offline from saved responses |
| `npm test`, `npm run typecheck` | Tests (offline) and type checks |

`verify` options: `--dry-run` (cost only, spends nothing), `--quick`, `--full`, `--limit <n>`, `--ai`, `--refresh`, `--name <folder>`, `--sheet <name>`, `--wait <minutes>`, `--no-slack`, `--yes`. Details in [docs/reference.md](docs/reference.md).

## Configuration

`npm run setup` writes these to `.env`; [.env.example](.env.example) has them all with comments.

| Setting | Default | What it does |
|---|---|---|
| `CRUSTDATA_API_KEY` | required | Your Crustdata key |
| `SLACK_WEBHOOK_URL` | empty | Post a summary of each run to Slack |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | empty, `claude-opus-5-5` | Only for `--ai` |
| `OUT_DIR` | `out` | Where results go |
| `REUSE_VERDICTS_DAYS` | `30` | Reuse a verdict for the same person for this many days (0 = never) |
| `CONFIRM_ABOVE_CREDITS` | `50` | Ask before a run that may spend more |
| `MAX_CREDITS_PER_RUN` | empty (no limit) | Stop any run that may spend more, even with `--yes` |
| `SLACK_DETAIL` | `names` | `counts` posts numbers only to Slack |

## Data and security

- Everything stays on your machine in `out/`, written owner-only, with a run log (`out/runs.csv`: who ran which file, when, for how many credits). Nothing is sent anywhere except Crustdata (the profile URLs and emails it checks; for an email that is not on file, Crustdata may look it up with a contact data provider, as its Person Identify docs describe), your Slack webhook if set, and Anthropic only with `--ai` (the check's findings for rows with a verdict, with every name in your list removed; employer, role, schools, reasoning and source titles can still identify a person, and the reasoning can name other people such as a colleague, so treat it as personal data).
- Results files are downloaded only over https from Crustdata's own storage.
- Cells that start with `=`, `+`, `-` or `@` are written with a leading apostrophe so they cannot run as spreadsheet formulas.
- `npm run forget -- <profile URL or email>` removes a person from this machine's files and rebuilds the report, and keeps only a one-way fingerprint so a file that still lists them never checks them again (`--undo` allows it again); `npm run purge -- --older-than <days>` applies a retention period. Delete any Slack message yourself, and send erasure requests that cover data held by Crustdata to Crustdata support.
- If you import `verified.csv` into your ATS, the added columns stay there under your ATS's own retention rules, and purge and forget do not reach them. Import the rows without the verdict columns unless your legal team has agreed otherwise.
- For a team: run it from one machine or one service account, with `OUT_DIR` on that machine's own disk (not a synced or network folder: the lock only sees runs on the same computer). Each copy keeps its own `out/` folder, so `forget` and `purge` must be run on every machine that ran a list.
- Keys live in `.env` (owner-only, ignored by git). See [SECURITY.md](SECURITY.md).

## Customize

[docs/customize.md](docs/customize.md) shows the common changes with exact file and function names: the review order, a new column, another ATS's column names, the date check rules, the Slack message, the AI prompt.

## Project structure

```text
src/
  cli.ts          commands: verify, test-slack, forget, purge
  verify.ts       the run: read, look up, enrich, verification jobs, results, files, Slack
  crustdata.ts    the only file that calls Crustdata (plain REST, retries, the results file)
  input.ts        CSV and .xlsx reading, column detection for ATS exports
  xlsx.ts         a small .xlsx reader with no dependencies
  profile-url.ts  finding and normalising profile URLs
  verdict.ts      verdicts, review order, plain-language summaries (pure)
  dates.ts        the quick screen's date check (pure)
  output.ts       verified.csv, unresolved.csv, report.md (pure)
  slack.ts        the Slack summary
  ai.ts           optional Claude summaries (--ai)
  store.ts        out/ files: progress, shared result cache, lock, run log
  forget.ts       npm run forget and npm run purge
  config.ts       settings from .env
  setup.ts        npm run setup
  replay.ts, fake-api.ts   the offline replay
examples/         sample Greenhouse (.xlsx), Lever, Ashby and Workable exports (made-up people)
fixtures/         saved API responses for replay and tests
test/             node:test, offline
docs/             how-it-works.md, customize.md, reference.md
```

## Built on Crustdata

[Crustdata](https://crustdata.com) is a B2B data API for people and companies: 1B+ profiles and 60M+ companies, with work history, education, posts, web search and verification. Docs: [docs.crustdata.com](https://docs.crustdata.com) ([Batch Person Verification](https://docs.crustdata.com/person-docs/verification/batch), [Person Enrich](https://docs.crustdata.com/person-docs/enrichment/introduction), [Person Identify](https://docs.crustdata.com/person-docs/identify/introduction)). More agents built on Crustdata: [github.com/crustdata/tools](https://github.com/crustdata/tools).

MIT licensed.
