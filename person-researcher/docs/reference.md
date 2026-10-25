# Person Researcher reference

## Commands

| Command | What it does | Needs a key |
|---|---|---|
| `npm run setup` | Asks for the Crustdata key, checks it with free calls, writes `.env` (owner-only) | Yes |
| `npm run research -- <people> [flags]` | Researches up to 100 people and writes their briefs | Yes |
| `npm run replay -- fixtures/<file>.json [flags]` | The same run against saved answers, in a temporary folder; `--keep` keeps the files | No |
| `npm test` | All tests, offline | No |
| `npm run typecheck` | `tsc --noEmit` | No |

## Naming people

| You pass | It is read as | First call |
|---|---|---|
| A profile URL, with or without `https://`, `www.`, a trailing slash or `?query` | A profile | `/person/enrich` |
| `jane@acme.com`, or `Jane Doe <jane@acme.com>` | An email | `/person/enrich` (work email), then `/person/identify` |
| `--name "Jane Doe" --company acme.com` | A name at a company domain (exact) | `/person/search` |
| `--name "Jane Doe" --company "Acme Labs"` | A name at an employer whose name contains the phrase | `/person/search` |
| `"Jane Doe, Acme"`, `"Jane Doe at acme.com"`, `"Jane Doe (Acme)"` | A name and company (in arguments or a file) | `/person/search` |
| `--file list.txt` or `--file export.csv` | A list, one person per line, or a CSV with a header | as above per row |

A name needs a first and last name; in a file it also needs a company. Several emails on one line count as
several people, and so do names separated by `;`. Labels (`To:`, `Cc:`, `Required:`, `Optional:`), calendar
summary lines ("4 guests"), meeting rooms (`@resource.calendar.google.com`) and no-reply addresses are left out.
Pronouns, titles and credentials ("(she/her)", "Dr.", "PhD") are taken off names. The same person twice gets one
brief, and attendees at `SKIP_DOMAINS` or `--skip-domain` are skipped. CSV headers read (any case, words in brackets ignored, so `Email (Work)` is `Email`): `Email`, `Work Email`,
`Business Email`, `Email Address`, `E-mail Address`, `E-mail 1 - Value`, `Attendee Email`; `Profile URL`,
`Profile`, `URL` and the profile URL column names of common CRM exports; `Name`, `Full Name`, `Contact Name`
("Doe, Jane" is read as Jane Doe); `First Name` + `Last Name`; `Website`, `Company Domain`, `Domain` (matched
exactly, preferred); `Company`, `Company Name`, `Account Name`, `Organization Name`. Rows with a single filled
cell under a header of three or more columns (report titles, totals) are skipped. A header with no column it
reads, or with no email or profile URL column, gets a note. A spreadsheet file (`.xlsx`, `.numbers`) is refused
with a hint to save it as CSV.

## Flags

| Flag | Default | What it does |
|---|---|---|
| `--name "..."` | | A person's name; goes with `--company` or alone |
| `--company "..."` | | Their company: a website domain (exact match) or a name (phrase match) |
| `--pick <n>` | | Which of several name matches to research, 1 to 5 (one name per run) |
| `--file <path>` | | A list or CSV, relative to the folder you run the command in |
| `--skip-domain <domain>` | `SKIP_DOMAINS` | Leave out people at this email domain (and its subdomains); repeatable or comma-separated |
| `--days <n>` | 180 | Window for "What changed lately", 1 to 3650 |
| `--posts <n>` | 5 | Posts to show, 0 to 10; 0 shows only the post count (free) |
| `--no-posts` | | No post search at all |
| `--no-web` | | No web or news search |
| `--contact [kinds]` | `business` | Contact details: `business`, `personal`, `phone`, `all`, or a list such as `business,phone` |
| `--json` | | JSON on stdout instead of markdown |
| `--out <dir>` | `OUT_DIR` (`out/`) | Where the briefs go (the cache stays in `OUT_DIR/.cache`) |
| `--refresh` | | Fetch again even if a saved answer is fresh (paid) |
| `--dry-run` | | List who would be researched and the most it can cost; sends nothing |
| `--yes` | | Run even when the estimate is above `MAX_CREDITS_PER_RUN` |
| `--help` | | The flag list |

Flags also take `--flag=value`. Paths are relative to the folder you ran the command in. Progress and errors go
to stderr; the brief (or JSON) goes to stdout. Use `npm run -s research -- ...` when you redirect stdout, so npm
does not print its own header line into it. Exit codes: 0 when everyone was researched or there was nobody to
research (an empty file, or only meeting rooms and colleagues), 2 when the run finished but some people were not
found, need a pick or failed, 3 when the run stopped (bad key, no credits; finished briefs are saved), 1 when
nothing ran (bad flags, a missing key, over `MAX_CREDITS_PER_RUN` without `--yes`).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Your key, from [app.crustdata.com](https://app.crustdata.com) |
| `OUT_DIR` | `out` | Briefs and the cache; relative paths are inside the project folder |
| `SKIP_DOMAINS` | | Your own company's email domains, comma-separated: attendees there are skipped |
| `MAX_CREDITS_PER_RUN` | `150` | A run whose estimate is higher needs `--yes`; `0` turns the check off |
| `CACHE_HOURS` | `24` | Hours a saved answer is reused; older ones are deleted at the next run; `0` turns the cache off |

Variables set in the shell win over `.env`. `PR_NO_DOTENV=1` skips `.env` (the replay and the tests do this).

## Files

| File | What is in it |
|---|---|
| `out/<name>.md` | The brief as markdown (`jane-doe.md`; a different person with the same name, now or in an earlier run, gets their Crustdata id: `jane-doe-9100001.md`). Written as soon as each brief is done, owner-only |
| `out/<name>.json` | The same brief as JSON (below) |
| `out/index.md` | With several people: everyone, their title and latest change, and why the others were not researched |
| `out/.cache/*.json` | Saved API answers, one per request, owner-only, reused for `CACHE_HOURS` then deleted |

## The JSON brief

`--json` always prints an array, one entry per person: `[{ "input", "status", "note"?, "candidates"?, "brief"? }]`.
`status` is `done`, `not_found`, `pick`, `skipped` or `failed`; `candidates` (name, headline, location,
profileUrl) comes with `pick`; a stopped run marks the people it did not reach `failed` with the reason in `note`.
With `--dry-run`, `--json` prints `[{ "input", "status": "would_research", "kind", ... }]` (`kind` is `url`,
`email` or `name`, with the parsed `url`, `email` or `name` and `company`) and sends nothing. The `brief` of one
person looks like this:

```json
{
  "input": "jane@acme.com",
  "matchedBy": "work email",
  "newsDays": 90,
  "person": {
    "id": 9100001, "name": "Maya Okafor", "title": "VP of Sales", "department": "Sales",
    "company": "Northwind Analytics", "headline": "...",
    "location": "Austin, Texas, United States", "experience": "6 to 10 years",
    "profileUrl": "...", "xUrl": "https://x.com/...", "followers": 4120, "connections": 2890,
    "languages": ["English"], "refreshed": "2026-10-20"
  },
  "changes": [{ "kind": "new_title", "month": "2026-08",
    "text": "New title at Northwind Analytics: VP of Sales (was Director of Sales), ..." }],
  "company": { "name": "Northwind Analytics", "domain": "northwind-analytics.example",
    "headcount": "212 people (201-500 band)", "industry": "Software Development",
    "about": "..." },
  "career": [{ "company": "Northwind Analytics", "domain": "...", "current": true,
    "span": "3 yrs 8 mos",
    "roles": [{ "title": "VP of Sales", "dates": "Aug 2026 to now · 3 mos", "current": true,
      "details": ["Full-time", "Austin, Texas, United States"], "description": "..." }] }],
  "education": [{ "school": "University of Texas at Austin",
    "detail": "BBA, Marketing · 2012 to 2016" }],
  "posts": { "total": 64, "newest": "15 Oct 2026",
    "shown": [{ "date": "15 Oct 2026", "text": "...", "reactions": 212, "comments": 31,
      "shares": 9, "url": "..." }] },
  "news": [{ "title": "...", "url": "...", "snippet": "..." }],
  "web": [{ "title": "...", "url": "...", "snippet": "..." }],
  "skills": ["Enterprise Sales"], "certifications": [], "honors": [],
  "notes": []
}
```

`changes[].kind` is `new_company` (its text says "Rejoined" for a return), `new_title`, `added_role` or `left`.
`matchScore` (0.5 to 1) is there only when an email was matched by the name in the address at the domain, and
`check` says why to check the person (that match, or a `--pick` among namesakes). `person.about` is their own
About text and `person.openTo` what the profile says they are open to (new roles, hiring). `quiet` replaces `changes` text when there
are none. `posts.note` explains an empty or older post list. `contact` (`business`, `personal`, `phones`) is there
only with `--contact`. `notes` lists sections that failed for this person.
