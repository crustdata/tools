# Customize AI Researcher Finder

The common changes, with the exact file. After changing `rubric.json` or `config/teams.json`, run `npm run rescore`: it scores and maps everyone already found again, offline and free.

## Your scoring rules: `rubric.json`

Each rule: `points` (above 0), `if` (the kind of check), `value` (what to look for), and `label` (text, shown in the report). Words and phrases match whole words, any case ("rl" matches "Code RL", not "world"). A rule whose data the profile lacks is listed as "no data" and counts at a part of its points: `no_data_share` at the top of the file, 0.25 by default (0 treats unknown as no; 0.5 as a coin flip). The score is that total out of all the points the rubric could give, 0 to 100; `coverage` in `researchers.csv` is how much of the rubric could be checked, and `checked_score` the score on the checked rules alone. Pass another file with `--rubric my-rubric.json`.

| `if` | `value` | Earns the points when | Example |
|---|---|---|---|
| `worked_at` | lab names, `"frontier"`, `"searched labs"`; optional `"when"`: `"now"`, `"before"`, `"ever"` (default) | A role at one of them: by employer name (company suffixes such as Inc, PBC, Ltd ignored), by company id for `frontier` (`FRONTIER_IDS`) and for searched labs. `frontier` also takes older full names (DeepMind, Google Brain) | `{ "points": 15, "if": "worked_at", "value": ["frontier"], "when": "before" }` |
| `title` | phrases | A current title contains one | `{ "points": 10, "if": "title", "value": ["research scientist"] }` |
| `team` | team names from `config/teams.json`, or `["any"]` | The team guess is one of them: stated earns all the points, inferred half | `{ "points": 15, "if": "team", "value": ["Inference"] }` |
| `fit` | none | Crustdata rated them `strong` (all) or `possible` (half) for the search; none below its top matches (the top 200 get a tier); left out for people found only from their work (a `--scholar-email` search counts as a search) | `{ "points": 10, "if": "fit" }` |
| `papers_about` | phrases, or `"$topic"` for `--topic`; optional `"since_years"` | A paper title contains one. A `$topic`-only rule is left out when the run has no topic | `{ "points": 10, "if": "papers_about", "value": ["kv cache"], "since_years": 3 }` |
| `recent_papers` | a number; optional `"since_years"` (default 3) | At least that many papers in the last N years | `{ "points": 10, "if": "recent_papers", "value": 2 }` |
| `h_index` | a number | h-index at least that | `{ "points": 10, "if": "h_index", "value": 10 }` |
| `citations` | a number | Lifetime citations at least that | `{ "points": 5, "if": "citations", "value": 1000 }` |
| `interests` | phrases | A Google Scholar research interest contains one (no data when the profile lists none) | `{ "points": 5, "if": "interests", "value": ["reinforcement learning"] }` |
| `skill` | phrases | A listed skill matches | `{ "points": 5, "if": "skill", "value": ["CUDA", "Triton"] }` |
| `school` | phrases | Studied at one | `{ "points": 5, "if": "school", "value": ["Example State University"] }` |
| `text` | phrases | The headline, any title, any role description or a skill contains one | `{ "points": 5, "if": "text", "value": ["kernel"] }` |
| `years` | a number | Years since their first role start (gaps included) at least that | `{ "points": 5, "if": "years", "value": 3 }` |
| `found_from_work` | none | Found from a Google Scholar profile, a GitHub profile or a paper | `{ "points": 5, "if": "found_from_work" }` |

A mistake in the file stops the run before anything is billed, with the rule number and a hint: an unknown `if` ("did you mean h_index?"), an unknown key ("did you mean value?"; `when` goes only with `worked_at`, `since_years` only with `papers_about` and `recent_papers`), a team name that is not in `config/teams.json`, a word where a number goes, or broken JSON (with the line, and the usual causes: a trailing comma, curly quotes).

**Questions for Claude (`ask`).** `{ "points": 10, "question": "..." }`. Scored only with `--ai` and `ANTHROPIC_API_KEY` set: yes earns all the points, partly half, no none, unclear is no data. Without `--ai` they are left out of the total. Answers are cached in the folder's `ai.json`; change a question and it is asked again. Write questions the record can answer (roles, descriptions, papers), not ones about things it does not hold.

A note on fairness: schools and past employers can act as proxies for things you must not select on. Use the score to decide who to read first, not who to reject.

## The teams: `config/teams.json`

A list of `{ "team": "...", "words": [...], "not": [...] }`. Phrases in `not` never count for that team (Inference has "causal inference", "bayesian inference"; Alignment and safety has "trust and safety"). A word in the current title, current role description or the current part of the headline makes the team stated; the same words in recent paper titles, research interests, past roles and skills add up to an inferred team (see [the README](../README.md#how-do-i-find-who-works-on-which-team-at-an-ai-lab)). When two teams are named, the one named first in the text wins; at the same place the longer word wins ("pretraining data" is Data); then the one listed first in the file. Labs' own product names used as team names are not in the file: add them for the labs you map. To add a team (say "Speech"), add an entry with its words; to rename one, change `team` (and the same name in `rubric.json` `team` rules).

The weights for inferred teams (paper 2, interest 1, past role 1, skill 0.5, co-author 2 by Google Scholar id or 1 by name only, older paper 0.5, with a cap per kind, and 2 points to count) are `CAPS` and the weights in `inferTeam` in [`src/teams.ts`](../src/teams.ts). Papers that look like a whole lab's model report are skipped by `labWidePaper` in the same file.

## What `frontier` means: `src/labs.ts`

`FRONTIER_LABS` is a list of lab domains: OpenAI, Anthropic, Google DeepMind, xAI, Mistral AI, Thinking Machines Lab, Safe Superintelligence, Reflection AI. Edit it to change `--labs frontier` and `--past-labs frontier`. `LAB_DISPLAY` in the same file gives a lab a report name when Crustdata lists it differently (x.ai is listed as "SpaceX Super Intelligence"), and `LAB_EMAIL_DOMAINS` adds Scholar email domains for `--scholar-email`. For a rubric `worked_at` rule, `"frontier"` uses `FRONTIER_IDS` (Crustdata company ids) and `FRONTIER_NAMES` (full and older names) in [`src/rubric.ts`](../src/rubric.ts); keep them in step with `FRONTIER_LABS` (`POST /company/identify` with the domain gives the id, free).

## Which titles count as research: `src/find.ts`

`RESEARCH_TITLES` are the phrases a current title must contain (exact phrase, whole words) unless you pass `--any-title`: research scientist, research engineer, researcher, research lead, research manager, research director, head of research, research fellow, member of technical staff, technical staff, mts, machine learning, ml, ai engineer, deep learning, applied scientist and a few more scientist titles. `map` uses `MAP_TITLES`, which adds engineer, tech lead and technical lead. `NOT_RESEARCH` drops titles such as UX researcher or research recruiter after the search (they are billed; the run counts them).

## The query

Without `--role`, the query is `DEFAULT_ROLE` in [`src/args.ts`](../src/args.ts) (every research and ML role). `--topic` adds "working on <topic>". The query only ranks; the filters decide who is in.

## Where the files go

`OUT_DIR` in `.env` (default `out`). Each search is a folder named by `--name`, or after the labs and role. Delete a folder to start that search over.
