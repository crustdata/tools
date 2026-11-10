# AI Researcher Finder reference

Every flag, setting and file.

## `npm run find` and `npm run map`

`npm run map -- --lab <lab>` is `find` with exactly one lab and a default of 100 people. Both take the same flags.

| Flag | What it does | Default |
|---|---|---|
| `--role "<sentence>"` | The role in plain English; ranks people by meaning | every research and ML role |
| `--labs <list>` | At one of these labs now: domains, names, or `frontier`, comma separated | none |
| `--past-labs <list>` | Worked at one of these before (same format); with `--labs`, both must hold | none |
| `--topic "<words>"` | Added to the ranking query, and used by `$topic` rubric rules; comma separate several | none |
| `--country "<country>"` | Lives in this country (checked against Crustdata's stored names, free) | anywhere |
| `--any-title` | Keep every title, not only research, scientist, technical staff and ML titles | off |
| `--from <file>` | Seeds: a text file (one link or paper title per line) or a CSV; repeat for several files | none |
| `--scholar <url>` | A Google Scholar profile URL (repeat, or comma separate) | none |
| `--github <url>` | A GitHub profile URL | none |
| `--paper "<title>"` | A paper title: finds its authors | none |
| `--profile <url>` | A profile URL | none |
| `--limit N` | People from the search, shared across `--labs` (1 to 1000) | 25 (`map`: 100) |
| `--per-lab N` | People from each lab instead | |
| `--per-paper N` | People fetched per paper title (1 to 100) | 20 |
| `--name <name>` | The folder under `out/`. Alone, it runs that saved search again (the next people); flags typed with it replace the saved ones; with seeds only, it adds them without searching again | from the role, topic and labs |
| `--rubric <file>` | Your scoring rules | `rubric.json` |
| `--ai` | Claude answers the rubric's `ask` lines (needs `ANTHROPIC_API_KEY`) | off |
| `--fresh` | Pull everyone again (fresh records), and look seeds up again (billed again) | off |
| `--top N` | People written out in full in `report.md` | 25 |
| `--scholar-email N` | Also search each lab for N people whose Google Scholar email is at the lab (may be a past job) | off |
| `--max-ai N` | Allow `--ai` to ask Claude about more than 500 people | 500 |
| `--dry-run` | Print the plan and the most it can cost; spend nothing | off |
| `--max-credits N` | Allow a run whose ceiling is above `MAX_CREDITS` | |

At least one of `--role`, `--labs`, `--past-labs`, `--topic`, or a seed is needed. A different search never lands in another search's folder: give it its own `--name`.

## `npm run rescore`

| Flag | What it does |
|---|---|
| `--name <name>` | Which folder (default: the one written last) |
| `--rubric <file>` | Another rubric |
| `--top N` | People in full in `report.md` |
| `--ai` | Also ask Claude the `ask` lines (answers cached in `ai.json`) |
| `--max-ai N` | Allow more than 500 people |

## `npm run watch-example`

| Flag | What it does |
|---|---|
| `--email <addresses>` | Send job moves to these addresses (comma separated); one of `--email`, `--slack`, `--webhook` is required |
| `--slack <webhook URL>` | Or to a Slack incoming webhook |
| `--webhook <https URL>` | Or to your own endpoint |
| `--name <name>` | Which folder (default: the one written last) |
| `--top N` | Only the N best scored people (needs `researchers.csv`) |

Writes `out/<name>/watch-request.json` and prints the curl that creates the watcher. Sends nothing. The watcher fires when someone starts at an employer new to the watch; a promotion stays silent.

## `npm run forget`

`npm run forget -- <profile URL, Google Scholar URL or Crustdata person id> [more ...]` adds the people to `out/suppressed.json` (id, profile URL, Scholar id), deletes them from every folder under `out/` (people, seed lookups, saved seeds, dropped list, Claude answers, watcher requests), and writes each report and CSV again. Every later run skips them (unbilled when it has their profile URL). Offline, free.

## Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Your Crustdata API key |
| `OUT_DIR` | `out` | Where each search's folder goes |
| `MAX_CREDITS` | `100` | A run whose ceiling is above this stops before it starts |
| `ANTHROPIC_API_KEY` | | Optional, for `--ai` |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | The model `--ai` uses |

Variables already set in the shell win over `.env`.

## Files in `out/<name>/`

| File | What it holds |
|---|---|
| `report.md` | The team map, then the top people with their evidence |
| `researchers.csv` | Everyone, ranked (columns below) |
| `people.json` | Every Crustdata record found, and how each person was found |
| `run.json` | The search (flags, labs with company ids, seeds) |
| `seeds.json` | Each seed's lookup result, reused for free |
| `dropped.json` | Profile URLs dropped after a search (not a research title), skipped by later runs |
| `ai.json` | Claude's answers with `--ai`, reused until the facts or questions change |
| `watch-request.json` | Written by `npm run watch-example` |

All are written owner-only. `out/suppressed.json` lists people removed with `npm run forget`. `out/` is in `.gitignore`.

## `researchers.csv` columns

| Column | What it holds |
|---|---|
| `rank`, `score`, `coverage`, `checked_score`, `points` | Rank by score; score 0 to 100 (a rule with no data counts at half); how much of the rubric could be checked; the score on the checked rules alone; points earned out of checked |
| `name`, `lab`, `current_company` | Name; the searched lab they are at (or "Not at a searched lab"); their main current employer |
| `team`, `team_label`, `team_also`, `team_evidence` | The team guess, `stated` / `inferred` / `not stated`, a close second, and why |
| `current_title`, `location`, `years_worked`, `past_frontier_labs` | From the record; years since the first role start; frontier labs in past roles |
| `h_index`, `citations`, `papers_last_3_years`, `recent_papers`, `research_interests` | From the Google Scholar profile, when Crustdata has it |
| `found_by`, `found_at`, `scholar_refreshed` | `search`, `Google Scholar profile <url>`, `Google Scholar email at <domain>`, `GitHub profile <url>`, `profile URL <url>`, `paper: <title>`; the date the record was fetched; when Crustdata last refreshed the Scholar profile |
| `points_earned`, `no_data_for` | Each rule that earned points (the evidence is in `report.md`); rules with no data |
| `profile_url`, `scholar_url`, `crustdata_person_id` | Links and the Crustdata id |

## Seeds file

A text file (any name not ending in .csv) is read one line at a time: a link is a link, any other line of three words or more a paper title, commas and all. A CSV (comma or semicolon): links are read from every column: Google Scholar (`scholar.google.*/citations?user=...`), GitHub profiles (`github.com/<user>`; repository links are refused), professional network profile URLs. A first row is a header when every cell in it is a column name; then plain text is read as a paper title only in a column named `paper`, `papers`, `paper title` or `article`, or `Title` next to `Authors` or `Year` (a Google Scholar export; elsewhere `Title` usually holds job titles); the run counts text it left unread. A CSV with no header row is read as titles only when it has one column. Paper links (arXiv, OpenReview, Semantic Scholar, ACL Anthology) and personal homepages are skipped with a note. Duplicates are looked up once; line numbers in notes match the file.
