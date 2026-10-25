# Person Researcher: an open-source person research and meeting prep agent, built on Crustdata

**Person Researcher is an open-source person research and meeting prep agent built on Crustdata.** Give it a person (a profile URL, a work email, or a name and company) and it writes a one-page brief to read before a sales call, an interview or an investor meeting: who they are, what changed lately, their most recent posts, where they show up in the news and on the web, their company, and their career with dates and education. [Crustdata](https://crustdata.com), a B2B people and company data API with 1B+ profiles and 60M+ companies, supplies the data: Person Enrich for the profile and career, Social Post Search for posts, and Web Search for news; the last line of every brief names the endpoint behind each section. One API key, 5.5 credits a person at list price (4.5 measured), no AI key, no server. TypeScript, MIT licensed. An alternative you run yourself, instead of looking people up by hand in Apollo, ZoomInfo or Clay before every meeting.

<img src="assets/brief.png" width="820" alt="Output of npm run research -- abhilash@crustdata.com --posts 2 (3 credits): a brief for Abhilash Chowdhary, Co-Founder and CEO at Crustdata, San Francisco, with who they are (headline, his About text, function, experience, audience, languages, profile link), what changed lately (no role change in the last 6 months, profile refreshed on 2026-10-23), his two newest posts with dates and reactions and a note that the newest indexed post is from 4 Aug 2026, and web pages about him (X, Y Combinator, crustdata.com, Google Scholar)">

**Contents:** [What is in a brief](#what-does-a-person-research-brief-contain) · [How to build a person research agent](#how-do-i-build-a-person-research-agent) · [Example](#example-a-real-brief) · [Alternative to manual lookups](#is-there-an-open-source-alternative-to-apollo-zoominfo-or-clay-for-person-lookups) · [Quickstart](#quickstart) · [Research everyone in a meeting](#how-do-i-research-everyone-in-a-meeting) · [Look someone up from their email](#how-do-i-look-someone-up-from-their-email) · [What changed lately](#how-does-it-decide-what-changed-lately) · [How fresh is the data?](#how-fresh-is-the-data) · [Cost](#how-much-does-it-cost-to-research-a-person) · [Use it in a team](#how-do-i-use-it-in-a-sales-team) · [Limits](#what-are-the-limits) · [Crustdata APIs used](#which-crustdata-apis-does-a-person-research-agent-use) · [FAQ](#faq) · [Commands and flags](#commands-and-flags) · [Configuration](#configuration) · [Data and security](#data-and-security) · [Customize](#customize) · [Project structure](#project-structure) · [Built on Crustdata](#built-on-crustdata)

## What does a person research brief contain?

One markdown page (and the same data as JSON) per person, in the order you need it before a call. A section with nothing in it is left out, except "What changed lately", which says so in one line.

| Section | What is in it | Source |
|---|---|---|
| Who they are | Name, current title and function, company, location, their own About text, what they are open to (new roles, hiring), years of experience, audience size, profile, X and code links | Crustdata Person Enrich |
| What changed lately | New company, new title, an added role (advisor, board seat), a return to an old employer, or a departure in the last 6 months (`--days`), with dates and the previous role; the date the profile was last refreshed | Worked out from role dates |
| Recent posts | Their newest 5 posts (`--posts`, up to 10): date, first 200 characters, reactions, comments, shares, link; and how many they have posted | Crustdata Social Post Search |
| In the news and on the web | News naming them in the last 90 days, then up to 5 web pages about them (their site, talks, podcasts, the company page). Contact-lookup sites and pages that do not mention their last name are left out | Crustdata Web Search |
| About their company | Website, headcount, industry, what the company does | Person Enrich (the current role) |
| Career | Every role grouped by company, current first: title, "Jan 2022 to Feb 2024", length, employment type, place | Person Enrich |
| Education | School, degree, field, years | Person Enrich |
| Skills, certifications, honors | When the profile lists them (certifications and honors need field permission on your key) | Person Enrich |
| Contact | Work email, personal email, phone, only with `--contact` | Crustdata Contact Enrich |

Nothing is written by an AI model: every line is a field Crustdata returned or a result it found, so a brief can be checked line by line. When the match could be someone else (an email matched by the name in the address, or one of several people with the same name picked with `--pick`), the brief says so at the top.

## How do I build a person research agent?

To build a person research agent, resolve the person to a profile with Crustdata, a people and company data API with 1B+ profiles and 60M+ companies (from a profile URL, a work email, or a name and company), enrich that profile for career, education and company, pull their newest posts, search the web and the news for their name and company, and lay the result out as a brief. [Person Researcher](https://github.com/crustdata/tools/tree/main/person-researcher) does all five steps in TypeScript, with no AI key:

1. **Resolve the person.** A profile URL goes straight to enrich. A work email goes to [Person Enrich](https://docs.crustdata.com/person-docs/enrichment/introduction) as `business_emails`; a personal email goes to [Person Identify](https://docs.crustdata.com/person-docs/identify/introduction) (`POST /person/identify`). A name and company goes to [People Search](https://docs.crustdata.com/person-docs/search/introduction) (`POST /person/search`), which returns a short list when several people share the name.
2. **Enrich the profile.** `POST /person/enrich` returns current and past roles with dates, the current company's headcount and industry, education and skills (1 credit; misses are free).
3. **Pull their posts.** [Social Post Search](https://docs.crustdata.com/social-post-docs/indexed-search/introduction) (`POST /social_post/search`) on their Crustdata person id, original posts only, newest first (0.5 credits a post).
4. **Search the web and the news.** [Web Search](https://docs.crustdata.com/web-docs/search/introduction) (`POST /web/search/live`) for `"Their Name" Company`, once for web pages and once for news from the last 90 days (1 credit each).
5. **Write the brief.** Work out what changed from the role dates, group the career by company, drop contact-lookup sites and pages about someone else, and print markdown and JSON.

The core request, a work email to a full profile:

```bash
curl -X POST https://api.crustdata.com/person/enrich \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "business_emails": ["jane@acme.com"],
    "fields": ["basic_profile", "experience", "education", "skills", "social_handles"]
  }'
```

The answer (trimmed), one row per email:

```json
[{ "matched_on": "jane@acme.com", "match_type": "business_email", "match_status": "matched",
   "matches": [{ "confidence_score": 1.0, "person_data": {
     "basic_profile": { "name": "Jane Doe", "current_title": "VP of Sales" },
     "experience": { "employment_details": {
       "current": [{ "title": "VP of Sales", "name": "Acme",
                     "start_date": "2026-08-01T00:00:00+00:00",
                     "company_website_domain": "acme.com", "company_headcount_latest": 212 }],
       "past": [{ "title": "Director of Sales", "name": "Acme",
                  "start_date": "2023-03-01T00:00:00+00:00",
                  "end_date": "2026-08-01T00:00:00+00:00" }] } },
     "education": { "schools": [{ "school": "University of Texas at Austin",
                                  "degree": "BBA" }] } } }] }]
```

Work emails on `/person/enrich` worked on the live API on 2026-10-23 but are not yet in the Person Enrich docs; if Crustdata ever answers 400, the agent sends those emails to Person Identify instead. Every request and response the agent makes is in [docs/how-it-works.md](docs/how-it-works.md).

## Example: a real brief

`npm run research -- abhilash@crustdata.com --posts 2`, run on 2026-10-23 for 3 credits (Abhilash is a co-founder of Crustdata; the image at the top is the same run). Real output, shortened by hand where it says `...`:

```markdown
# Abhilash Chowdhary

**Co-Founder & CEO at Crustdata (YC F24)** · San Francisco, California, United States

## Who they are

- Headline: Co-founder at Crustdata (YC F24) | Infra for building AI employees
- About: Love building things. A software engineer with vast experience in shipping
  products spanning robotics, web technologies and quantitative finance.
- Function: Executive Leadership
- Experience: More than 10 years
- Audience: 24,299 followers, 5,874 connections
- Languages: English, Hindi
- Links: [Profile](...)

## What changed lately

No role change in the last 6 months. Profile refreshed on 2026-10-23.

## Recent posts

87 posts by them in the index, newest 2 below.

- **4 Aug 2026**: Almost every YC founder I speak with has a "product graveyard".
  Here is ours: ... (17 reactions, 4 comments) [Open](...)
- **4 Aug 2026**: This onboarding fix was responsible for growing our MCP adoption ...
  (29 reactions, 2 comments) [Open](...)

Newest indexed post: 4 Aug 2026. Posts reach the index with a delay, so newer ones
may exist.

## In the news and on the web

No news articles naming them in the last 90 days.

On the web:

- [Abhilash Chowdhary (@TheChowdhary) ...](https://x.com/...)
- [Crustdata: Real-time B2B data via simple APIs](https://www.ycombinator.com/...)
- [About Us](https://crustdata.com/about)
- ...

## About Crustdata (YC F24)

- Website: [crustdata.com](https://crustdata.com)
- Headcount: 47 people (11-50 band)
- Industry: Software Development

## Career

**Crustdata (YC F24)** (current) · 2 yrs 10 mos

- Co-Founder & CEO, Jan 2024 to now · 2 yrs 10 mos

**Serve Robotics** · 3 yrs

- Product, Jan 2022 to Feb 2024 · 2 yrs 2 mos · Full-time · San Francisco, California, ...
- ...

## Education

- IIIT Hyderabad, Bachelor of Technology (B.Tech.), Computer Science
- ...

---

Found by work email: abhilash@crustdata.com. Profile refreshed on 2026-10-23.

Sources: profile, career, education and company from Crustdata Person Enrich
(`/person/enrich`); ...
```

For a person with a recent move, "What changed lately" reads like this (from the offline sample in `fixtures/meeting.json`, made-up people):

```text
- New title at Northwind Analytics: VP of Sales (was Director of Sales), since Aug 2026.
- Joined Initech as Head of Data in Jul 2026. Before: Senior Data Scientist at Umbrella
  Insurance until Jun 2026.
- Added a role: Technical Advisor at Vandelay Ventures, since Sep 2026 (still Chief
  Technology Officer at Hooli).
- Left Massive Dynamic (Director of Product) in Sep 2026. No current role listed.
```

## Is there an open-source alternative to Apollo, ZoomInfo or Clay for person lookups?

Yes, for the lookup before a meeting. Most people prepare for a call by opening the person's profile, a data tool and a search engine in three tabs. Person Researcher puts the same facts on one page from one Crustdata key, and you own the code. Where the data tools win is inside your CRM and browser. To fill a CSV of people with Crustdata columns instead of writing briefs, see the [Clay Alternative](https://github.com/crustdata/tools/tree/main/clay-alternative).

| | Person Researcher | By hand: profile, data tool, search engine |
|---|---|---|
| Career with dates, education, company size | Yes, from Crustdata Person Enrich | Yes |
| What changed lately, in one line | Yes, worked out from role dates | You read the history yourself |
| Their recent posts | Yes, newest 5 with dates and reactions | Usually a separate tab |
| News and web pages about them | Yes, with contact-lookup sites left out | A separate search |
| A whole meeting at once | Yes, up to 100 people, one brief each plus an index | Data tools enrich lists too; the reading is still one tab at a time |
| Work email and phone | Only with Crustdata contact data (enterprise plans), not on self-serve keys | Yes, in most data tools |
| Inside your CRM, calendar or browser | No: a command line tool, or `research()` from your own code | Yes, in most data tools |
| Usage per rep | Per API key, in the Crustdata dashboard | Yes |
| Writes talking points with AI | No: every line is data; pipe `--json` to your own model | Depends on the tool |
| Watches the person for job changes | No: use the [job change alert bot](https://github.com/crustdata/tools/tree/main/job-change-alert-bot) | Some tools |
| Price | 5.5 Crustdata credits a person at list price (up to 6.5 when an email needs a lookup); the code is free | A seat or credit plan |

## Quickstart

You need Node 22.13 or newer (check with `node -v`; get it from [nodejs.org](https://nodejs.org)) and a Crustdata API key ([get one](https://app.crustdata.com); new accounts get free credits).

```bash
git clone https://github.com/crustdata/tools.git
cd tools/person-researcher
npm install
npm run setup                          # checks your key and what it can use, writes .env
npm run research -- jane@acme.com      # one brief, printed and saved to out/
```

Other ways to name the person:

```bash
npm run research -- "<profile URL>"    # the address of their public profile page
npm run research -- --name "Jane Doe" --company acme.com
npm run research -- --name "Jane Doe" --company acme.com --dry-run   # the cost; spends nothing
```

The brief is markdown: open the file in `out/` in any markdown viewer (VS Code's preview, Obsidian, your notes app) for a formatted page.

### What does my Crustdata key need?

Person Enrich and Web Search work on every plan, new self-serve keys included. Social Post Search (Recent posts) is off by default: ask Crustdata to enable it. Person Identify (personal emails) is enabled per account. Contact Enrich (`--contact`) needs contact data on your account (enterprise plans). Certifications and honors need field permission. `npm run setup` checks each one for free. On a new self-serve key a brief has the profile, career, education, company, news and web, at most 3 credits; `--dry-run` still budgets posts and Person Identify, so add `--no-posts` for a closer estimate on such a key.

Try it offline first, with made-up people and no key:

```bash
npm run replay -- fixtures/single-email.json  # one person, promoted two months ago
npm run replay -- fixtures/meeting.json       # five attendees, one of them unknown
npm run replay -- fixtures/name-pick.json     # a common name: it stops and lists the matches
```

## How do I research everyone in a meeting?

Pass several people at once (up to 100), or a file. Each gets a brief, and `out/index.md` lists everyone with their latest change, so you can read the index first.

```bash
npm run research -- jane@acme.com sam@globex.com "Ana Silva, Initech"
npm run research -- --file ~/Downloads/attendees.txt --skip-domain mycompany.com
```

The file can be a plain list (one profile URL, email, or "Name, Company" per line; lines starting with `#` are skipped) or a CSV export from a CRM, a contacts app or a spreadsheet, with a header row. Columns it reads: `Email` (also `Work Email`, `E-mail Address`, `E-mail 1 - Value`), `Profile URL` (and the profile URL column names CRM exports use), `Name` or `First Name` and `Last Name`, and `Website`, `Company Domain` or `Company`. A website column matches the employer exactly, so it is preferred over a company name. Commas, semicolons and tabs all work, and quoted cells may hold line breaks.

Paste the attendees from a calendar invite as they are: `Required: Jane Doe <jane@acme.com>; Sam Lee <sam@globex.com>` counts as two people, and labels, meeting rooms and lines like "4 guests" are left out. Your own colleagues are skipped when their domain is in `SKIP_DOMAINS` (set by `npm run setup`) or passed with `--skip-domain`. In a file, a name needs a company ("Jane Doe, acme.com"), because a bare name matches too many people. Rows it cannot read are listed with their line number, and the same person twice (by email and by profile URL) gets one brief and is paid for once. Run with `--dry-run` first to see the list it understood.

## How do I look someone up from their email?

A work email goes to Crustdata Person Enrich directly, so the lookup and the profile are one call and 1 credit. If that finds nobody (a personal email, or an address Crustdata has not seen), the agent asks Person Identify, which also matches personal emails, and names in the address at the company that owns the domain, then enriches the profile it finds (2 credits in all). A name-at-the-domain match carries a match score below 1, and the brief then says "Check this is the right person" at the top. Misses cost nothing. Person Identify is enabled per Crustdata account; `npm run setup` checks it with a free probe, and without it personal emails come back as "not found".

## How does it decide what changed lately?

From the start and end month of each role, compared with today, over the last 180 days (`--days` changes the window). The rules, in `changes()` in `src/brief.ts`:

| Change | Rule | Example |
|---|---|---|
| New title | A current role started in the window at a company where their previous role ran up to it | New title at Acme: VP of Sales (was Director of Sales), since Aug 2026. |
| New company | A current role started in the window at a company they had no recent role at ("Rejoined" when they worked there before) | Joined Initech as Head of Data in Jul 2026. Before: Senior Data Scientist at Umbrella until Jun 2026. |
| Added role | A current role started in the window while an older current role continues | Added a role: Technical Advisor at Vandelay, since Sep 2026 (still CTO at Hooli). |
| Left | A role that ended in the window, at a company with no current role, not already named as the previous role | Left Massive Dynamic (Director of Product) in Sep 2026. No current role listed. |

Roles with no start date or a start date in the future are never called new, the same role listed twice counts once, and a quiet profile says "No role change in the last 6 months" with the date the profile was last refreshed, so you know how recent "quiet" is.

## How fresh is the data?

- **Profiles:** Crustdata refreshes every indexed profile at least once every 30 days, the most active ones as often as daily ([Data updates](https://docs.crustdata.com/general/data-updates)). Each brief shows the date its profile was refreshed ("Profile refreshed on 2026-10-23"). A live profile fetch is in [docs/customize.md](docs/customize.md).
- **Posts:** come from Crustdata's post index, refreshed every 1 to 45 days, so the newest posts may be missing. When the newest indexed post is more than 30 days old, the brief says so ("Newest indexed post: 4 Aug 2026. Posts reach the index with a delay, so newer ones may exist.").
- **News and web:** searched live on every run.
- **Your own repeats:** answers are reused for 24 hours (`CACHE_HOURS`), so researching the same person again the same day costs nothing. `--refresh` fetches again. Older saved answers are deleted at the start of the next run; nothing deletes them on a timer, so remove `out/.cache/` when you stop using the tool.

## How much does it cost to research a person?

**5.5 Crustdata credits a person at list price** (1 profile, 2.5 for five posts, 1 web search, 1 news search). An email Crustdata has not seen as a work email adds 1 for Person Identify (6.5), and a name adds up to 0.65 for People Search (about 6.2 with a company). Measured on 2026-10-23: 4.5 for Abhilash with the default 5 posts (3 with `--posts 2`, the example above). Every miss is free, a repeat within 24 hours costs nothing, and `--posts`, `--no-posts` and `--no-web` lower it.

| Call | When | Credits (list price) |
|---|---|---|
| Person Enrich (`/person/enrich`) | Every person found, by profile URL or work email | 1 |
| Person Identify (`/person/identify`) | Only when a work email lookup finds nobody | 1 when it finds someone, else 0 |
| People Search (`/person/search`) | Only for names: up to 5 people returned, and once more on past employers when nobody is at the company now | 0.03 each, plus 0.1 each when a company is given |
| Social Post Search (`/social_post/search`) | Newest posts (`--posts 5`) | 0.5 per post returned; the post count alone is free |
| Web Search (`/web/search/live`) | Once for web, once for news | 1 each (a search that found nothing cost 0 on 2026-10-23; the docs say 1 per query, so budget 1) |
| Contact Enrich (`/person/contact/enrich`) | Only with `--contact` | 1 work email, 2 personal email, 2 phone, per person found |

`--dry-run` prints the most a run can cost and spends nothing; it budgets the Person Identify call for every email, so it shows 6.5 per email even though a work email costs 5.5. Every run prints what it used. A meeting of 5 people found by work email is 27.5 credits (`--dry-run` shows at most 32.5). The estimate uses list prices; your account's own prices are in `GET /account/endpoints` (free) and the Crustdata dashboard, and `npm run setup` shows your balance.

## How do I use it in a sales team?

- **One key per rep.** Give each rep their own Crustdata API key: keys share the account's credit balance, usage per key shows in Crustdata's usage reports, and an admin can limit each key to the endpoints it needs.
- **Skip your own people.** Set `SKIP_DOMAINS=yourcompany.com` (setup asks), so colleagues on an invite cost nothing.
- **Cap a run.** `MAX_CREDITS_PER_RUN` (150 by default, about 23 people by email) refuses any run whose estimate is higher unless it has `--yes`, so a scheduled run over a huge file cannot spend much by mistake. It caps one run, not a day.
- **Run it before every meeting.** Read tomorrow's attendees from your calendar API, write their emails to a file, and run `npm run research -- --file attendees.txt` once a day. Someone in two meetings is paid for once (24-hour cache).
- **Pacing is per process.** Each run keeps under the published rate limits, but many reps running at once on one shared key can still hit them (the run waits and retries); separate keys keep reps from slowing each other down.

## What are the limits?

- **Up to 100 people a run**, and runs over `MAX_CREDITS_PER_RUN` need `--yes`.
- **Rate limits are paced for you:** Person Enrich and Contact Enrich 15 calls a minute, People Search, Person Identify and Social Post Search 30, Web Search 10. One person takes about 10 to 20 seconds (the two web searches are 6 seconds apart); 25 people take about 6 to 8 minutes, mostly waiting on web search.
- **Names need help:** `--name` alone returns up to 5 people with that name; add `--company` (a website domain such as `acme.com` is exact) or use `--pick`.
- **People who opted out** are never returned by Crustdata and never charged.
- **Posts, personal emails and contacts need those endpoints on your key** (see [What does my Crustdata key need?](#what-does-my-crustdata-key-need)). Without them the brief goes without those sections and says so once.
- **Not built in:** checking whether a work history is real (Crustdata has a separate [verification API](https://docs.crustdata.com/person-docs/verification/batch)), watching a person for changes (see the [job change alert bot](https://github.com/crustdata/tools/tree/main/job-change-alert-bot)), and a company deep dive (see the [company researcher](https://github.com/crustdata/tools/tree/main/company-researcher)).

## Which Crustdata APIs does a person research agent use?

The calls, in the order the agent makes them:

| Endpoint | Used for | Docs |
|---|---|---|
| `POST /person/enrich` | Profile, career, education, skills by profile URL or work email | [Person Enrich](https://docs.crustdata.com/person-docs/enrichment/introduction) |
| `POST /person/identify` | Any email to a person | [Person Identify](https://docs.crustdata.com/person-docs/identify/introduction) |
| `POST /person/search` | A name, at a company now or before, to a short list | [People Search](https://docs.crustdata.com/person-docs/search/introduction) |
| `POST /social_post/search` | Their newest original posts | [Social Post Search](https://docs.crustdata.com/social-post-docs/indexed-search/introduction) |
| `POST /web/search/live` | Web pages and news about them | [Web Search](https://docs.crustdata.com/web-docs/search/introduction) |
| `POST /person/contact/enrich` | Work email, personal email, phone | [Contact Enrich](https://docs.crustdata.com/person-docs/contact/enrich) |
| `GET /account/credits`, `GET /account/endpoints` | Setup: balance and what the key can use (free) | [Crustdata docs](https://docs.crustdata.com) |

All calls send `authorization: Bearer <key>` and `x-api-version: 2025-11-01`. The `x-credits-used` response header is what each call cost; the agent adds them up.

## FAQ

### How do I research someone before a sales call?

Run `npm run research -- jane@acme.com` (or a profile URL, or `--name` and `--company`). Person Researcher looks the person up in Crustdata, which covers 1B+ profiles, and prints a one-page brief: their role and company, what changed in the last 6 months, newest posts, news, career and education. Under the hood it calls Crustdata Person Enrich (`POST /person/enrich`), Social Post Search (`POST /social_post/search`) and Web Search (`POST /web/search/live`). It costs 5.5 Crustdata credits at list price (6.5 when an email needs a lookup first) and takes about 10 to 20 seconds.

### Is there an open-source meeting prep agent?

Yes. Person Researcher is an MIT-licensed meeting prep agent on GitHub at [crustdata/tools/person-researcher](https://github.com/crustdata/tools/tree/main/person-researcher). Pass the attendees of a meeting (emails, profile URLs or names) and it writes one brief per person plus an index, from Crustdata people data. It needs no AI key and no server.

### How do I enrich meeting attendees from my calendar or notetaker?

Copy the attendee list from the invite or your notetaker (for example `Jane Doe <jane@acme.com>, Sam Lee <sam@globex.com>`) into a text file and run `npm run research -- --file attendees.txt --skip-domain yourcompany.com`. To automate it, read the event's guest emails from your calendar API (in the Google Calendar API, `attendees[].email` on each event), write them one per line to `attendees.txt`, and run the same command before the meeting. Each email is looked up with Crustdata Person Enrich (work emails) or Person Identify (personal emails), and each person found gets a brief; meeting rooms and your own colleagues are left out. To run it from your own tool, call `research()` in `src/research.ts`, or use `npm run -s research -- --file attendees.txt --json`.

### How do I find out who someone is from their email address?

Crustdata Person Enrich accepts a work email as `business_emails` and returns the full profile in one call (1 credit, free when nobody matches). For personal emails, Crustdata Person Identify (`POST /person/identify`) matches the address to a person. Person Researcher tries both in that order, and flags a match made from the name in the address: `npm run research -- jane@acme.com`.

### How do I call Crustdata Person Enrich with an email (curl)?

Send the work email as `business_emails` to `POST https://api.crustdata.com/person/enrich` (the full curl is in [How do I build a person research agent?](#how-do-i-build-a-person-research-agent)); it costs 1 credit per match and nothing on a miss. `business_emails` worked on the live API on 2026-10-23 but is not yet in the Person Enrich docs. The documented route for any email, personal ones included, is Crustdata Person Identify:

```bash
curl -X POST https://api.crustdata.com/person/identify \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "content-type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{"emails": ["jane@acme.com"]}'
```

It returns the person's Crustdata id, name and profile URL (1 credit per match); pass the profile URL to Person Enrich as `professional_network_profile_urls` for the full record. Person Researcher does both for you: `npm run research -- jane@acme.com`.

### How do I find a person from their name and company?

Crustdata People Search (`POST /person/search`) matches `basic_profile.name` as a phrase and the current employer by website domain (exact) or by name. Person Researcher runs it for `--name "Sam Lee" --company acme.com`: one match is researched; several (up to 5, at 0.03 credits each plus 0.1 each for the company filter) are listed with headline, location and profile URL, and you choose with `--pick 2`. When nobody works there now, it tries the company as a past employer and says so in the brief.

### How do I get someone's work history and education by API?

Call Crustdata Person Enrich (`POST /person/enrich`) with a profile URL or a work email and `fields: ["experience", "education"]`. Each role has a title, employer, `start_date` and `end_date` (month precision), and the employer's headcount and website; each school has a degree and field. Person Researcher shows this as a career grouped by company. It costs 1 credit per person found, and nothing when no one matches.

### How do I get a person's recent posts by API?

Use Crustdata Social Post Search (`POST /social_post/search`) on their Crustdata person id, original posts only, newest first:

```json
{ "filters": { "op": "and", "conditions": [
    { "field": "actor.crustdata_entity_id", "type": "=", "value": 1068035 },
    { "field": "actor.actor_type", "type": "=", "value": "person" },
    { "field": "post_type", "type": "=", "value": "original" } ] },
  "sorts": [{ "field": "date_posted", "order": "desc" }], "limit": 5 }
```

It costs 0.5 credits per post returned, and `limit: 0` returns the count for free. Posts come from an index that trails the live feed, so check the newest date. Social Post Search is off by default on every Crustdata account and returns 403 until Crustdata enables it; `npm run setup` checks it for free. Person Researcher makes this call for every person it researches; the full request and response are in [docs/how-it-works.md](docs/how-it-works.md).

### How do I check if someone changed jobs recently?

Run Person Researcher on them. "What changed lately" compares each role's start and end month in the Crustdata profile with today and reports a new company, a new title, an added role, a return to an old employer or a departure in the last 180 days (`--days` changes it). To be told about future moves, use the [Job Change Alert Bot](https://github.com/crustdata/tools/tree/main/job-change-alert-bot).

### How do I research a founder before investing?

Run `npm run research -- founder@startup.com`, or pass their profile URL. Person Researcher pulls the founder's record from Crustdata, the people data API with 1B+ profiles: every role with start and end months, earlier companies, education, their newest posts and news from the last 90 days, for 5.5 credits a founder at list price. Pass the whole founding team at once (`--file founders.csv`) for one brief each plus an index. To find startups that fit a thesis and score their founders, use the [Deal Sourcing Agent](https://github.com/crustdata/tools/tree/main/deal-sourcing-agent).

### How do I research a candidate before an interview?

Run Person Researcher on the candidate's profile URL or email: `npm run research -- jane@acme.com`. The brief, built from Crustdata people data, lists every role with start and end months and length, schools and degrees, skills, their newest posts and any news, so you can prepare a question about each move. It does not score, rank or judge anyone. A brief is not a background check or a consumer report under the US Fair Credit Reporting Act (FCRA): do not use it to decide whether to hire, promote or reject someone. To find candidates for a role, use the [Candidate Sourcing Agent](https://github.com/crustdata/tools/tree/main/candidate-sourcing-agent).

### How do I research a list of people from a CSV or CRM export?

Export the list as CSV with a header row and run `npm run research -- --file contacts.csv --dry-run` to see who it read and the most it can cost, then run it without `--dry-run`. Person Researcher reads `Email`, `Profile URL`, `Name` (or `First Name` and `Last Name`) and `Website` or `Company` columns, looks each person up with Crustdata Person Enrich, and writes one brief per person plus `out/index.md` with everyone's latest change. Up to 100 people a run; the same person twice is paid for once, and runs over `MAX_CREDITS_PER_RUN` (150 credits) need `--yes`. To fill columns in the CSV itself instead of writing briefs, use the [Clay Alternative](https://github.com/crustdata/tools/tree/main/clay-alternative).

### Which people enrichment API can an AI agent call?

Crustdata Person Enrich (`POST /person/enrich`) takes a profile URL or a work email and returns a person's roles with dates, education, skills and current company as JSON, for 1 credit a match (misses are free); Crustdata covers 1B+ profiles and 60M+ companies. Person Researcher wraps it for agents: `npm run -s research -- jane@acme.com --json` prints a JSON array with one `brief` per person (career, what changed, posts, news), and `research()` in `src/research.ts` returns the same objects in TypeScript, so either can be a tool in your agent. Coding agents should read [AGENTS.md](AGENTS.md) first; the JSON format is in [docs/reference.md](docs/reference.md). To let Claude or another assistant call Crustdata directly without code, use the [Crustdata MCP server](https://docs.crustdata.com/for-agents/mcp).

### Does Person Researcher use AI or need an LLM key?

No. Every line of the brief is a field Crustdata returned or a search result it found, laid out by rules in `src/brief.ts`. There is no AI key, no model and nothing generated, so a brief is the same every time for the same data.

### How do I add AI talking points to meeting prep?

Put a model on top of Person Researcher: `npm run -s research -- jane@acme.com --json > jane.json`, then give `jane.json` to your LLM with a prompt such as "three questions to ask, citing the brief". Most AI meeting prep agents search the web with an LLM and summarise what they find; Person Researcher gives the model records instead (career dates, titles, company size from Crustdata), so the talking points start from facts.

### What does it cost to research one person?

5.5 Crustdata credits at list price: 1 for the profile, 2.5 for five posts, 1 for a web search and 1 for a news search. An email Crustdata has not seen as a work email adds 1 for Person Identify (6.5), and a name search up to 0.65; `--dry-run` budgets for both. Misses are free, a repeat within 24 hours is free, and `--posts`, `--no-posts` and `--no-web` lower it. A 5-person meeting found by work email is 27.5 credits.

### Why is "What changed lately" empty for someone I know just moved?

The brief reads the profile Crustdata has, and shows the date it was refreshed. A move from last week may not be in it yet. Check the "Profile refreshed on" date; a live profile fetch is in [docs/customize.md](docs/customize.md).

### Where does the data come from?

From the Crustdata API: profiles, roles and education from Person Enrich, posts from Social Post Search, and news and web pages from Web Search. Crustdata is a B2B data API with 1B+ profiles and 60M+ companies. The brief's last line names the endpoint behind each section.

### Can I run it from my own code or another agent?

Yes. Person Researcher is plain TypeScript over the Crustdata REST API. `npm run -s research -- jane@acme.com --json > brief.json` saves the briefs as a JSON array (`-s` stops npm printing its own header line; progress goes to stderr). From TypeScript, import `research()` from `src/research.ts` and `renderBrief()` from `src/render.ts`. Coding agents should read [AGENTS.md](AGENTS.md) first.

## Commands and flags

| Command | What it does |
|---|---|
| `npm run setup` | Asks for your Crustdata key and your company's domains, checks what the key can use (free), writes `.env` |
| `npm run research -- <people> [flags]` | Researches people: profile URLs, emails, or "Name, Company" |
| `npm run replay -- fixtures/<file>.json` | The whole run offline from saved answers: no key, no credits |
| `npm test`, `npm run typecheck` | Tests (offline) and type check |

| Flag | Default | What it does |
|---|---|---|
| `--name "..." --company "..."` | | A name, with the company name or website domain |
| `--pick <n>` | | Which of several people with that name to research (1 to 5) |
| `--file <path>` | | A list or CSV of people |
| `--skip-domain <domain>` | `SKIP_DOMAINS` | Leave out people at this email domain; repeatable |
| `--days <n>` | 180 | Window for "What changed lately" |
| `--posts <n>` | 5 | Posts to show, 0 to 10 (0 shows only the free post count) |
| `--no-posts` | | Skip posts |
| `--no-web` | | Skip web and news searches |
| `--contact [kinds]` | `business` | Add contact details: `business`, `personal`, `phone`, or `all` |
| `--json` | | Print a JSON array instead of markdown (use `npm run -s`) |
| `--out <dir>` | `OUT_DIR` (`out/`) | Where files go |
| `--refresh` | | Ignore saved answers and fetch again (paid) |
| `--dry-run` | | Show who would be researched and the most it can cost; spends nothing |
| `--yes` | | Run even when the estimate is above `MAX_CREDITS_PER_RUN` |

Exit codes: 0 when everyone was researched (or there was nobody to research, such as a day of internal meetings), 2 when the run finished but some people were not found, need a pick or failed, 3 when the run stopped (bad key, no credits; finished briefs are saved), 1 when nothing ran (bad flags, no key, over `MAX_CREDITS_PER_RUN` without `--yes`). Every flag and the JSON format are in [docs/reference.md](docs/reference.md).

## Configuration

Settings come from the environment or `.env` (`npm run setup` writes it; `.env.example` has every setting with a comment).

| Setting | Default | What it does |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Your Crustdata API key, from [app.crustdata.com](https://app.crustdata.com) |
| `SKIP_DOMAINS` | | Your own company's email domains, comma-separated: those attendees are skipped |
| `MAX_CREDITS_PER_RUN` | `150` | A run whose estimate is higher needs `--yes`; `0` turns the check off |
| `OUT_DIR` | `out` | Where briefs and the answer cache go |
| `CACHE_HOURS` | `24` | Hours a saved answer is reused before it is paid for again; `0` turns it off |

## Data and security

The tool runs on your machine and talks only to `api.crustdata.com`. Your key stays in `.env` (owner-only, in `.gitignore`) or the environment and is never logged. Briefs are personal data about real people: they stay in `out/` (owner-only files, in `.gitignore`), with saved API answers in `out/.cache/`, deleted at the start of the next run once they are older than `CACHE_HOURS` (remove the folder when you stop using the tool). Delete briefs when you no longer need them. Person Researcher is not a consumer reporting agency and a brief is not a consumer report under the US FCRA: do not use briefs to decide on someone's employment, credit, insurance or housing. In the EU and UK, have a lawful basis for researching someone. See [SECURITY.md](SECURITY.md).

## Customize

Common changes, with the exact function to edit, are in [docs/customize.md](docs/customize.md): the brief's sections and their order, the "what changed" rules, which web sites are left out (`config/ignored-sites.json`), the news window, more or fewer posts, a live profile fetch, and sending briefs to Slack or your CRM.

## Project structure

```text
person-researcher/
├── src/
│   ├── cli.ts          npm run research: flags, files, output, exit codes
│   ├── research.ts     the order of calls, the cache, writing files
│   ├── brief.ts        pure: raw answers to a brief, the "what changed" rules
│   ├── render.ts       pure: a brief to markdown, the index
│   ├── input.ts        pure: profile URLs, emails, names, calendar pastes, CSV files
│   ├── crustdata.ts    the only file that calls Crustdata (plain REST, paced, retries)
│   ├── cache.ts        saved answers for CACHE_HOURS
│   ├── setup.ts        npm run setup
│   ├── replay.ts       npm run replay, offline
│   └── fake-api.ts     the offline Crustdata stand-in for replay and tests
├── config/ignored-sites.json   web sites left out of the brief
├── fixtures/           made-up people for replay and tests
├── test/               node:test, offline
└── docs/               how-it-works, customize, reference
```

## Built on Crustdata

Person Researcher runs on the [Crustdata API](https://crustdata.com): [Person Enrich](https://docs.crustdata.com/person-docs/enrichment/introduction), [Person Identify](https://docs.crustdata.com/person-docs/identify/introduction), [People Search](https://docs.crustdata.com/person-docs/search/introduction), [Social Post Search](https://docs.crustdata.com/social-post-docs/indexed-search/introduction), [Web Search](https://docs.crustdata.com/web-docs/search/introduction) and [Contact Enrich](https://docs.crustdata.com/person-docs/contact/enrich). More open-source agents on Crustdata: [github.com/crustdata/tools](https://github.com/crustdata/tools).

MIT licensed. See [LICENSE](LICENSE).
