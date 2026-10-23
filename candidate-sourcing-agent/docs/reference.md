# Candidate Sourcing Agent reference: flags, settings, files

The [README](../README.md) explains what the tool does; this page lists every flag, setting and file.

## Flags

Flags for `npm run source` (`npm run source -- --help` prints them). `--x none` clears a filter the sentence or a flag set.

| Flag | Example | Does |
|---|---|---|
| `--role` | `"Data engineer, 3+ years, Germany"` | The role sentence. It ranks, and its filters are read |
| `--name` | `ml-engineer-us` | The role's folder in `out/`. Default: from the title and place |
| `--must` | `"PyTorch, Kubernetes"` | Skills every candidate must list (stored names, checked) |
| `--nice` | `"LLM fine-tuning"` | Skills that raise the score |
| `--skills` | `"Go, Rust"` | Replace the skills read from the sentence (scored) |
| `--title`, `--title-strict` | `"Data engineer"` | Set the title; `--title-strict` also makes it a filter |
| `--years` | `4`, `4+`, `3-7` | Years of experience. The lower number is a filter; the upper one only scores |
| `--country`, `--state`, `--near` | `"United States"`, `California`, `"Berlin:30"` | Where people live |
| `--size` | `1-500`, `startup`, `scale-up`, `enterprise` | Current employer size |
| `--past` | `"examplelabs.example, Example Robotics"` | Worked at one of these (domains or names) |
| `--school` | `"Example State University"` | Studied at one of these |
| `--exclude` | `yourcompany.example` or `do-not-poach.txt` | Never people currently at these companies |
| `--open-only`, `--has-code`, `--papers` | | Open to new roles only; public code profile only; read research records |
| `--keywords` | `'"site reliability" +kubernetes'` | A boolean keyword query instead of the sentence |
| `--limit` | `50` | New candidates per run (default 20, up to 1,000) |
| `--top` | `15` | People in `shortlist.md` (default 10) |
| `--seen` | `out/team-seen.csv` | A seen list shared by several roles; the role remembers it |
| `--skip-from` | `ats-export.csv` | Also skip every profile URL in this file (read only) |
| `--fresh` | | Ignore the role's seen list for this run (people are billed again) |
| `--dry-run` | | Show what it understood and the cost; spend nothing |
| `--ai` | | Add the "why this candidate" sentence (needs an AI key) |
| `--yes`, `--no-watch-hint` | | Run without asking (needed in a script above 30 credits); no watcher line |

## Flags for the other commands

| Command | Flags |
|---|---|
| `npm run contacts` | `--top N` (default 25, up to 500), `--name <role>` (default: the last role), `--work-email`, `--phone`, `--no-personal-email`, `--yes` (needed in a script) |
| `npm run watch-example` | `--slack <webhook URL>`, `--email <addresses>`, `--webhook <URL>` (any of them, or none for a watcher you read with the API), `--name <role>`, `--every-days N` (default 7), `--per-run N` (default 50) |
| `npm run rescore` | `--name <role>`, `--top N`. Role flags are refused: change the role with `npm run source` |
| `npm run forget` | `<profile URL>`, `--erase` (also remove the profile URL from the seen lists) |
| `npm run replay` | `fixtures/<case>.json`, `--again` (run the role twice), `--keep` (keep the temporary files); any `source` flag is passed on |

## Settings

Settings come from environment variables or `.env` in this folder (`npm run setup` writes it; see [.env.example](../.env.example)). To use the key in a curl from this folder: `set -a; . ./.env; set +a`.

| Variable | Default | What |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Your key from [app.crustdata.com](https://app.crustdata.com). Needed by `source`, `contacts` and `setup` |
| `OUT_DIR` | `out` | Where each role's folder goes |
| `WATCH_HINT` | `true` | `false` turns off the watcher line at the end of each run |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | `claude-opus-5-5` | Optional, for `--ai` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | | Optional, for `--ai`, instead of Anthropic |

## Files

```text
src/
  cli.ts          commands: source, rescore, contacts, watch-example, forget
  role.ts         the sentence parser, flags, filters, rounds and cost estimate (pure)
  score.ts        the weights table and scoreCandidate (pure)
  profile.ts      reading a person record: main role, years worked, tenure (pure)
  seen.ts         the seen list and profile URL normalising
  source.ts       npm run source and npm run rescore
  output.ts       candidates.csv and shortlist.md
  contacts.ts     npm run contacts
  forget.ts       npm run forget
  crustdata.ts    the only file that calls Crustdata
  ai.ts           the optional "why this candidate" sentence
  setup.ts        npm run setup
  replay.ts       npm run replay, with fake-api.ts serving the fixtures
examples/
  watch-role.ts   npm run watch-example: the watcher request
fixtures/         saved responses with made-up people, used by replay and the tests
test/             node:test, offline
docs/             how it works, customizing
```
