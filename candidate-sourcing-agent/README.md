# Candidate Sourcing Agent: an open-source AI recruiter for candidate sourcing, built on Crustdata

_Part of [crustdata/tools](https://github.com/crustdata/tools), open-source agents built on the Crustdata API._

**Candidate Sourcing Agent is an open-source AI recruiter for the sourcing step, built on [Crustdata](https://crustdata.com), the people and company data API (1B+ profiles, 60M+ companies). Describe the role in one plain-English sentence and get a ranked shortlist of candidates, with the reason for every score, as CSV and markdown. Every later run skips the people you already pulled, and Crustdata does not bill you for them again.**

How it works: the role goes to Crustdata's semantic people search as the query, the must-haves stay hard filters, every candidate is scored by a table of rules you can read and change (so it needs no AI key), and a seen list keeps anyone from coming back. It is a self-hosted, open-source alternative to recruiting tools such as LinkedIn Recruiter, SeekOut, hireEZ and Juicebox for the sourcing step, running on Crustdata's people data rather than a seat in any of them. TypeScript, MIT licensed, one API key, no server.

![The shortlist for a machine learning engineer role: each candidate with a score from 0 to 100, where they worked before, and the reasons behind the score, such as strong fit for the role, has PyTorch, 7 years worked, 3.6 years in the current role, a company of 120 people, open to new roles](assets/shortlist.png)

## How to build an AI candidate sourcing agent (AI recruiter)

To build an AI candidate sourcing agent, send the role as a plain-English query to a people search API that ranks profiles by meaning, keep the hard requirements as filters, score each result with rules you can explain, and keep a list of everyone already pulled so you never pay for or contact them twice. This repo does exactly that on [Crustdata's Person Search API](https://docs.crustdata.com/person-docs/search/introduction), in five steps:

1. **Read the role.** Pull the hard filters out of the sentence (place, years, company size, past employers, schools) and check every value against Crustdata's free autocomplete, so a typo stops the run instead of silently returning nobody. ([`src/role.ts`](src/role.ts))
2. **Search by meaning, inside hard filters.** Send the sentence as `search.query` with `mode: "hybrid"` (keyword plus semantic matching over title, skills, company history, education, location and summary) and the top-level `mode: "exact"`, so every result meets every filter and the query only ranks. ([`src/crustdata.ts`](src/crustdata.ts))
3. **Skip who you already have.** Send every profile URL you pulled before as `post_processing.exclude_profiles`: those people are not returned and not billed. ([`src/seen.ts`](src/seen.ts))
4. **Score with rules.** Crustdata's fit tier, skills listed or written about, title, years, time in the current role, employer size, past employers, school. Each point comes with a reason. ([`src/score.ts`](src/score.ts))
5. **Write the shortlist.** CSV for the ATS, markdown for the hiring manager. ([`src/output.ts`](src/output.ts))

The core request, which you can run as it is once your key is in the shell (`export CRUSTDATA_API_KEY=...`, or `set -a; . ./.env; set +a` after `npm run setup`):

```bash
curl https://api.crustdata.com/person/search \
  --header "authorization: Bearer $CRUSTDATA_API_KEY" \
  --header "content-type: application/json" \
  --header "x-api-version: 2025-11-01" \
  --data '{
    "search": {
      "query": "Machine learning engineer, 4+ years, PyTorch, shipped models in production",
      "mode": "hybrid"
    },
    "mode": "exact",
    "filters": { "op": "and", "conditions": [
      { "field": "basic_profile.location.country", "type": "in", "value": ["United States"] },
      { "field": "skills.professional_network_skills", "type": "=", "value": "PyTorch" },
      { "field": "years_of_experience_raw", "type": "=>", "value": 4 }
    ] },
    "fields": ["fit", "basic_profile", "experience", "education", "skills", "social_handles"],
    "limit": 20
  }'
```

The top of the ranked list (up to 200 people) carries a `fit` tier (`strong`, `possible` or `weak`); the rest have `fit: null`. With `mode: "exact"`, `total_count` is the number of people who meet every filter. Every request and response the agent sends is in [docs/how-it-works.md](docs/how-it-works.md).

**Contents:** [Alternatives](#open-source-alternative-to-linkedin-recruiter-seekout-hireez-and-juicebox) · [Quickstart](#quickstart) · [Cost](#what-does-a-candidate-search-cost-on-crustdata) · [Scoring](#how-does-candidate-scoring-work) · [Contacting twice](#how-do-i-avoid-contacting-the-same-candidate-twice) · [Emails](#how-do-i-get-candidate-emails) · [Weekly](#how-do-i-keep-sourcing-candidates-every-week) · [Too few](#what-if-a-candidate-search-finds-too-few-people) · [Responsible use](#responsible-use) · [Limits](#what-are-the-limits) · [FAQ](#faq) · [Commands](#commands)

## What it does

| You give it | You get |
|---|---|
| One sentence: `"Machine learning engineer, 4+ years, PyTorch, United States, at a company under 500 people"` | The sentence ranks the people inside your filters by meaning (Crustdata semantic search), and the parts that can be hard filters (place, years, company size, past employers, schools) become filters. It prints what it understood, and what it will cost, before anything is billed. |
| `--must "PyTorch"`, `--nice "Kubernetes"`, `--exclude yourcompany.example` | Must-have skills are a hard filter; nice-to-have skills raise the score; your own company's people are left out. |
| The same role again (`--name <role>`) | The next batch of new people. Everyone pulled for the role before is skipped and not billed again, even when you reword the sentence. |
| `npm run contacts -- --top 25` | Personal emails for your top 25, if your Crustdata account has contact data turned on. |
| `npm run watch-example` | The Crustdata watcher request that sends new matches for the role to Slack or email every week. You create it; this repo sends nothing. |

Every run writes to `out/<role>/`:

- `shortlist.md`: the top 10 new candidates for the hiring manager, with where each worked before, their education, and the reasons for the score.
- `candidates.csv`: everyone found for the role so far, ranked again on every run: score, reasons, skills matched and missing, years worked, time in the current role, past employers, education, open to new roles, profile URL.
- `seen.csv`: every profile URL already pulled, so no later run returns them.
- `profiles.json`: the Crustdata records found for the role, so `npm run rescore` works offline.
- `role.json`: the role as understood, reused by `--name`.

## Open-source alternative to LinkedIn Recruiter, SeekOut, hireEZ and Juicebox

LinkedIn Recruiter, SeekOut, hireEZ and Juicebox are hosted recruiting products with seats, an inbox and outreach. Candidate Sourcing Agent is the sourcing step only, as code you own: it searches Crustdata's people dataset (1B+ profiles) through the Crustdata API, and it does not log in to, scrape or need a seat in any of those products.

| | Candidate Sourcing Agent | Hosted recruiting tools |
|---|---|---|
| Search by a plain-English role | Yes, Crustdata semantic search | Varies by product |
| Filters: skills, years, place or radius, employer size, past employers, school, open to new roles, public code profile, research record | Yes, each billed per candidate; research records and contact data need enabling on your Crustdata account | Varies by product and plan |
| A score you can read and change | The rules are a table in [`src/score.ts`](src/score.ts) with a reason for every point; one row is Crustdata's fit tier from its semantic search | A ranking set by the product |
| Skip everyone already sourced, unbilled | Yes: `seen.csv`, plus any ATS export with `--skip-from` | Inside the product |
| Export | CSV and markdown, every column | Varies by plan |
| Contact data | Optional, personal email by default (needs contact data on your Crustdata account) | Varies by product |
| Outreach, sequences, inbox | No (the [Crustdata candidate-sourcing skill](https://github.com/crustdata/skills/tree/main/skills/candidate-sourcing) drafts outreach inside Claude) | Yes |
| ATS sync (Greenhouse, Ashby, Lever) | No: import the CSV. A good first pull request | Varies by product |
| Web app and team seats | No, a command line tool | Yes |
| Pricing | Crustdata credits per candidate returned | Per seat |

## Quickstart

What you need:

- [ ] Node 22.13 or newer
- [ ] A [Crustdata API key](https://app.crustdata.com) (new accounts get free credits)

```bash
git clone https://github.com/crustdata/tools
cd tools/candidate-sourcing-agent
npm install
npm run setup               # checks your key, what it can use, and your price; writes .env
npm run source -- --dry-run \
  --role "Machine learning engineer, 4+ years, PyTorch, shipped models in production, United States, at a company under 500 people" \
  --must "PyTorch" --nice "Kubernetes, LLM fine-tuning" --exclude yourcompany.example
```

`--dry-run` prints what it understood and the cost, and spends nothing. Run the same command without `--dry-run` to search. The first run returns up to 20 new people (`--limit` changes it; anyone dropped by the local `--exclude` check is still billed) and costs about 11 credits at list price; `npm run setup` and every run print your account's own price, which can be far lower. Then run `npm run source -- --name machine-learning-engineer-united-states` for the next 20: the first 20 are skipped and not billed.

To see it work first with no key and no credits, replay saved responses (made-up people):

```bash
npm run replay -- fixtures/ml-engineer.json --again
```

## Example run

The run says what it understood, what it will cost, and how many people each round of filters keeps, before the ranked search. From the offline replay, trimmed (made-up people and companies; the replay asks for 4 people a run so that `--again` shows a second batch):

```text
  role:        Machine learning engineer, 4+ years, PyTorch, shipped models in production,
               United States, at a company under 500 people
  title:       Machine learning engineer (scored; --title-strict to require it)
  nice to have: Kubernetes, LLM Fine-Tuning (scored, lower weight)
  filter:      lives in United States   (--country none to drop)
  filter:      lists the skill PyTorch   (--must none to drop)
  filter:      4+ years of experience   (--years none to drop)
  filter:      current employer under 500 people   (--size none to drop)
  filter:      not currently at yourcompany.example   (--exclude none to drop)
  new people:  up to 4 per run
  note:        "shipped models in production" is not a skill name, so it is not scored;
               the query ranks on it.
  skipping:    nobody from this role yet
  cost:        about 2.5 credits at list price (0.53 per candidate, 4 candidates)

Round 1: lives in United States: 167,270,316 people (0 credits)
Round 2: lists the skill PyTorch, 4+ years of experience: 55,766 people (0 credits)
Round 3: current employer under 500 people, not currently at yourcompany.example: 15,934 new people match every filter
Ranked search: 4 returned and billed, 0 credits
  dropped here: 1 (Alex Example (currently at yourcompany.example))
Open to new roles: 1 of 3 (0 credits, billed only for those who are)

  #   score name            current title                      company           years
  1   100   Jane Doe        Senior Machine Learning Engineer   Example Labs      7
  2   92    Rahul Example   Machine Learning Engineer          Example Health    7
  3   79    Maria Example   Machine Learning Engineer          Example Robotics  9
```

Each person in `shortlist.md` has their current role, where they worked before, their education, and one bullet per reason for the score ([example](docs/how-it-works.md#5-score-and-write)).

## What does a candidate search cost on Crustdata?

**A 20-candidate search costs about 11 Crustdata credits at list price. Plans whose price includes the premium data groups pay far less: the whole run measured 0.69 credits on 2026-10-21.** `npm run setup` reads your account's own prices from Crustdata (`GET /account/endpoints`, free) and every run prints its estimate with them before it searches, and the credits it used after.

Crustdata bills person search per result: 0.03 credits, plus each premium data group the search filters on or returns ([pricing](https://docs.crustdata.com/general/pricing#premium-fields-in-search)). At list price:

| What | Credits per candidate | When |
|---|---|---|
| Base | 0.03 | always |
| Experience, education, skills returned | 0.1 each, 0.3 | always (the score needs them) |
| Experience filter | 0.1 | employer size, past employers, `--exclude`, `--title-strict` |
| Skills filter | 0.1 | `--must` |
| Education filter | 0.1 | `--school` |
| Professional network filter | 0.2 | `--open-only` |
| Code profile filter | 0.8 | `--has-code` |
| Research records returned | 0.4, only for people who have one | `--papers` |

Place, radius and years filters add nothing. On top: one counted result per round (0.03 plus that round's filters), and the "open to new roles" check, billed only for people who are open (0.23 each at list price; 1 to 4 in 20 on live runs). People skipped from the seen list are not billed. `--dry-run`, `npm run rescore`, `npm run watch-example`, `npm run forget` and `npm run replay` cost nothing.

Contacts are separate: 2 credits per person found for a personal email, 1 for a work email, 2 for a phone number; nothing for people not found. A Crustdata watcher is free for its first run (a sample of up to 5 people), then 0.5 credits per person delivered.

## How does candidate scoring work?

Candidate Sourcing Agent scores every candidate 0 to 100 from their Crustdata record with rules plus one model signal, and every point has a reason you can read in `candidates.csv`. The one model signal is Crustdata's fit tier, which comes from its semantic search (in beta) and is 25 of the 100 points; everything else is a rule. The weights are one table at the top of [`src/score.ts`](src/score.ts):

| Row | Points | How |
|---|---|---|
| Crustdata fit | 25 | `strong` 25, `possible` 15, `weak` 5. Crustdata gives the tier to the top of the ranked list (up to 200 people); everyone below it scores as `weak`, so they never rank above someone Crustdata rated. |
| Skills asked | 20 | Share of the sentence's and `--must` skills present. Listed as a skill counts in full; only written about in a title, headline or role description counts half. |
| Nice to have | 10 | The same for `--nice`. |
| Title | 15 | Current title against the role, at any level: the exact phrase 15, every word 10, the main word ("related") 4. ML, AI, SWE and similar are read as their long forms, and "developer" counts as "engineer". |
| Years worked | 10 | Inside the band asked 10, more than its upper end 8, a year short of it 5. |
| Time in current role | 10 | Under 6 months 2 (just started), 6 to 24 months 7, 2 years or more 10, no start date 4. |
| Employer size | 5 | The current employer's latest headcount is inside the size asked. |
| Past employer | 10 | Worked at one of `--past`. |
| School | 5 | Studied at one of `--school`. |
| Open to new roles | +8 bonus | Says they are open to new roles. |
| Research | +8 bonus | With `--papers`: h-index 10 or more 8, 3 or more 5, any record 2. |

Rows you did not ask for (no school, no years) are left out of the total, so a score means "how much of what you asked for this person has". Bonuses add on top, capped at 100. Change a number and run `npm run rescore` to rank the saved candidates again, free. Use the score to decide who to read first, not who to reject.

Optional: with `--ai` and an Anthropic or OpenAI key in `.env`, each shortlisted person also gets one "why this candidate" sentence, written only from the facts in their record (never their name or profile URL). The score never depends on it.

## How do I avoid contacting the same candidate twice?

Keep a seen list and send it to Crustdata with every search. Candidate Sourcing Agent writes every profile URL a run returns to `out/<role>/seen.csv`, as soon as each page is billed, and the next run sends the newest 20,000 of them to Crustdata's `POST /person/search` as `post_processing.exclude_profiles`: those people are not returned and not billed again. It drops them again locally (by profile URL and Crustdata person id) in case a URL was written differently.

```json
"post_processing": { "exclude_profiles": ["<profile URL you already pulled>", "..."] }
```

- **The same role in other words:** "Senior ML engineer, US" and "Machine learning engineer, United States" land in the same role folder ("Senior", "Sr" and abbreviations are ignored in its name; junior, staff, principal and lead roles get their own folder), so they share the seen list. `--name <role>` picks a folder yourself.
- **Several roles, one list:** each role has its own list, so someone skipped for one role can still come up for another. Share one on purpose with `--seen out/team-seen.csv`; the role remembers it.
- **Two sourcers on two machines:** keep one seen list on a network share both machines mount (SMB or NFS, in a folder your team controls) and pass `--seen /path/to/team-seen.csv` on every machine. Each run locks the file and merges with it just before writing; two runs at the same moment can still each pull one person once. Sync folders such as Google Drive or Dropbox can make a conflicted copy when both machines write between syncs; if one appears, pass it with `--skip-from`.
- **People already in your ATS:** `--skip-from ats-export.csv`. Any column with profile URLs is read, the role remembers the file, and the file is never changed.
- **See everyone again:** `--fresh` (they are billed again).
- **Someone asks to be removed:** `npm run forget -- <profile URL>` deletes them from every role's files and shared seen lists, keeping their profile URL, first-seen date and Crustdata id (name blanked) in the seen lists so no later run pulls them again (`--erase` removes that too). Run it on every machine that ran the role.

## How do I get candidate emails?

Candidate Sourcing Agent looks up emails with Crustdata's contact API, which needs contact data enabled on your Crustdata account; self-serve keys do not have it. `npm run setup` reads the free `GET /account/endpoints` and tells you whether your key has it, and `npm run contacts` stops with that same sentence when it does not. Ask Crustdata to turn it on.

With it on:

```bash
npm run contacts -- --top 25                 # personal emails, 2 credits per person found
npm run contacts -- --top 25 --work-email    # also work emails, 1 credit more
npm run contacts -- --top 25 --phone         # also phone numbers, 2 credits more
```

Personal email is the default because most candidates should not hear about a new job at their current work address. It prints the most it can cost and asks before it spends (in a script, add `--yes`), looks up nobody twice for the same kinds, and writes `out/<role>/contacts.csv` after every batch of 25. People not found cost nothing.

## How do I keep sourcing candidates every week?

Candidate Sourcing Agent gives you two ways, and neither keeps anything of yours running:

- **Run `npm run source -- --name <role>` once a week** (from cron, a CI schedule or by hand, with `--yes`). You get the next ranked, scored batch, without anyone you already have.
- **Or let Crustdata watch for you.** `npm run watch-example -- --name <role> --slack <webhook URL>` (or `--email you@yourcompany.example`) writes the request for a Crustdata person discovery watcher over the role's filters, plus its title at any level, and prints the curl that creates it. It sends nothing and creates nothing. Once created, Crustdata re-runs the filters weekly and posts people whose profiles newly match, or changed since the last run, to Slack, email or a webhook. You can also build it at [app.crustdata.com/watch](https://app.crustdata.com/watch). A watcher takes filters only: it does not rank by the sentence, score, or use `seen.csv`, so people you already sourced can be delivered again when their profile changes.

Watcher cost at list price: the first run is a free sample of up to 5 people, then 0.5 Crustdata credits per person delivered. The request this repo writes delivers at most 50 people a week, so at most 25 credits a week, and nothing for a week with nobody to deliver. Cancel it with `DELETE /watch/person/search/<id>`.

Every `source` run ends with one line about the watcher. Turn it off with `--no-watch-hint` or `WATCH_HINT=false` in `.env`.

## What if a candidate search finds too few people?

Candidate Sourcing Agent stops and tells you what to change. It never loosens a filter or spends more on its own.

- **Nobody matches:** Crustdata's free explain step names the filter that removed everyone and how many people match without it, and the run prints the command to drop it. For example, when `--must "PyTorch, Rust"` matches nobody, it prints `npm run source -- --name machine-learning-engineer-united-states --must "PyTorch"`.
- **Fewer than you asked for:** the run names the round that cut the most (from the round counts) and the flags that widen it.
- **A typo:** a must-have skill, country or state that is not a stored value stops the run before anything is billed, with the closest stored values.
- **Not sure:** `--dry-run` shows what the sentence became and the cost, for free.

## Responsible use

Candidate Sourcing Agent ranks real people for recruiting, so:

- **No protected characteristics.** It never searches, filters or scores on age, gender, family status, sexual orientation, national origin, religion, race or disability. Common phrasings ("under 30 years old", "in their 20s", "born in", "native English speaker", "young") are taken out of the query and out of flag values, the AI sentence never sees them, and the run says so. The upper end of a years range only scores (more experience still scores 8 of 10), because a maximum on experience works as an age filter. The list cannot catch every wording, and schools and past employers can still act as proxies: review your role sentence before you search.
- **A person stays in the loop.** Use the score to decide who to read first, not who to reject. Depending on where you hire, laws on automated hiring tools may apply (for example the EU AI Act treats systems that evaluate candidates as high-risk).
- **Personal data.** Everything in `out/` is about real people and stays on your machine, written owner-only (on macOS and Linux; on Windows, keep the folder in your user profile). If you recruit in the EU or UK you need a lawful basis (often legitimate interest) and must tell people you hold their data, usually within a month (GDPR Article 14). `npm run forget -- <profile URL>` removes a person on request, from every role and shared seen list on that machine (files passed with `--skip-from` are yours to edit; run it on every machine that ran the role). Delete a role's `profiles.json`, `candidates.csv` and `contacts.csv` when the search is done; keep `seen.csv` if you want later runs to skip the same people.

## What are the limits?

- Semantic search on Crustdata is in beta. The ranking can change as it improves; the filters are always enforced (`mode: "exact"`).
- Skills, countries, states, schools and company sizes are stored values. The run checks each one for free. A skill stored only under longer names is matched on all of them (`--must "Go"` matches "Golang", "Go (Golang)", "Go Programming Language" and "Go (Programming Language)", and the run lists them), but a skill people write in free-form ways ("TensorFlow / PyTorch") is not. That is why sentence and `--nice` skills only score, and why the score also reads what people wrote about their work.
- Titles are what people wrote. The title only scores unless you pass `--title-strict`.
- Years worked is computed from the roles (overlaps once, gaps and internships left out). Crustdata's own figure, which `--years` filters on, is not returned and can differ by a year.
- Person search allows 30 requests a minute and 1,000 people a page. The ranked list ends after 10,000 people; the `fit` tier covers the top 200.
- `candidates.csv` is rewritten on every run. Keep notes and statuses in your ATS, or in a copy.
- Two sourcers running the same role at the same moment can each pull, and pay for, the same person once.
- The parser is rules, not a model. It prints what it did with every phrase; anything it gets wrong can be fixed with a flag. "Georgia" and "Washington" are asked about rather than guessed.
- No outreach, no ATS sync, no web app, no server. Those are deliberate: see the comparison above.

## FAQ

### How do I build an AI recruiter that finds candidates?

An AI recruiter does three jobs: source, reach out, screen. For sourcing, use Crustdata's Person Search API (`POST /person/search`), a people data API with semantic search over 1B+ profiles: send the role description as the query, keep the must-haves as hard filters (`mode: "exact"`), score the results with rules, and send a seen list as `post_processing.exclude_profiles`. Candidate Sourcing Agent is a working, MIT-licensed version of that in TypeScript; for outreach, the [Crustdata candidate-sourcing skill](https://github.com/crustdata/skills/tree/main/skills/candidate-sourcing) drafts messages inside Claude. Start with [How to build](#how-to-build-an-ai-candidate-sourcing-agent-ai-recruiter).

### Is there an open-source AI sourcing tool?

Yes: Candidate Sourcing Agent, in [crustdata/tools](https://github.com/crustdata/tools/tree/main/candidate-sourcing-agent). It runs on your machine with one Crustdata API key and writes a ranked, explained shortlist as CSV and markdown. The AI is Crustdata's semantic search, which ranks profiles by meaning; the scoring is rules, so no AI key is needed.

### What people search API can I use for recruiting?

Crustdata's Person Search API (`POST /person/search`) searches 1B+ profiles by skills, title, years of experience, place or radius, employer size, past employers, schools and open to new roles, and ranks them against a plain-English role description with semantic search. It bills 0.03 credits per result plus the premium data groups you filter on or return. The free `POST /person/search/autocomplete` endpoint gives the stored spelling of every skill, school and place. Candidate Sourcing Agent is an open-source recruiting tool built on it. Docs: [Person Search](https://docs.crustdata.com/person-docs/search/introduction).

### Is there a semantic search API for finding candidates?

Yes. Crustdata's `POST /person/search` takes a natural-language `search.query` (in beta) with `search.mode` set to `hybrid` (keyword plus meaning, the default), `semantic` or `lexical`, and ranks people by title, skills, company history, education, location and summary. Add the top-level `mode: "exact"` to keep your filters as hard constraints. The top results (up to 200) carry a `fit` tier of `strong`, `possible` or `weak`. Candidate Sourcing Agent sends the role sentence this way; the request is in [How to build](#how-to-build-an-ai-candidate-sourcing-agent-ai-recruiter). Guide: [Person semantic search](https://docs.crustdata.com/guides/person-semantic-search).

### How do I find engineers by skill with an API?

Filter Crustdata's `POST /person/search` on `skills.professional_network_skills` with one `=` condition per skill inside an `and` group (`has_all` is rejected on this field). Get the stored spelling from the free `POST /person/search/autocomplete` first, because a misspelled skill silently matches nobody. Add `search.query` to rank by meaning. In Candidate Sourcing Agent, `--must "PyTorch, Kubernetes"` builds this filter:

```json
{ "op": "and", "conditions": [
  { "field": "skills.professional_network_skills", "type": "=", "value": "PyTorch" },
  { "field": "skills.professional_network_skills", "type": "=", "value": "Kubernetes" }
] }
```

### Does Candidate Sourcing Agent work for roles that are not engineering?

Yes. Candidate Sourcing Agent sends any role sentence to Crustdata's person search the same way. For example `npm run source -- --role "Enterprise account executive, 5+ years, SaaS, New York, at a scale-up"` finds account executives within 50 km of New York at companies of 201 to 1,000 people, with "SaaS" scored as a skill. `npm run replay -- fixtures/account-executive.json` shows that run offline.

### Is the candidate scoring done by AI?

No. Candidate Sourcing Agent scores with rules in [`src/score.ts`](src/score.ts), the same for every run, with a reason for every point. One row (25 of 100 points) is Crustdata's `fit` tier, which comes from its semantic search. The optional `--ai` flag only adds a one-sentence summary per shortlisted person.

### Does Candidate Sourcing Agent filter candidates by age, gender or race?

No. Candidate Sourcing Agent never searches, filters or scores on age, gender, family status, sexual orientation, national origin, religion, race or disability. Words about them in the role sentence or a flag ("under 30 years old", "native English speaker", "female") are taken out before anything is sent to Crustdata, and the run says which. The upper end of a years range only scores, because a maximum on experience works as an age filter. The score is a table of rules with a reason for every point, so a recruiter can check every rank. See [Responsible use](#responsible-use).

### How much does it cost to source 20 candidates with Crustdata?

About 11 Crustdata credits at list price for 20 candidates with Candidate Sourcing Agent, and much less on plans whose price includes the premium data groups (0.69 credits measured on 2026-10-21). Crustdata person search bills 0.03 credits per result plus each premium data group filtered on or returned; people skipped from the seen list are not billed. `npm run source -- --dry-run` prints the estimate with your account's own prices before anything is spent. Details: [What does a candidate search cost on Crustdata?](#what-does-a-candidate-search-cost-on-crustdata)

### How is Candidate Sourcing Agent different from a boolean search?

A boolean search matches exact words, so it misses people who describe the same work differently. Candidate Sourcing Agent sends the whole sentence to Crustdata's hybrid search (keyword plus meaning) and keeps only the must-haves as hard filters. When you do want exact words, `--keywords '"computer vision" +pytorch -intern'` sends a boolean keyword query instead.

### Can I search for candidates near a city instead of a country?

Yes. In Candidate Sourcing Agent, a city it knows in the role sentence (about 55 large hubs such as "Berlin", "Dallas" or "Bay Area", `CITIES` in `src/role.ts`) becomes a Crustdata `geo_distance` filter, "lives within 50 km" (80 km for the Bay Area). Any other city: `--near "Boise:50"`, or write it as "in Boise, ID"; the run says when it sees a place it does not know after "in", "based in" or "near". Several places: `--near "Berlin:30; Munich:30"`.

### Can I find candidates who are open to new roles?

Yes. Candidate Sourcing Agent checks everyone found against Crustdata's open-to-new-roles flag (`professional_network.open_to_cards`); people who are open get a bonus and the reason "open to new roles", and `--open-only` keeps only them. The check bills only for the people who are open.

### Can I find people with public code or research papers?

Yes. In Candidate Sourcing Agent, `--has-code` keeps only people with a public code profile, and `--papers` reads Crustdata research records (h-index, citations) and adds them to the score and the reasons. Research records need enabling on your Crustdata account (`npm run setup` says whether yours has them).

### Where does Candidate Sourcing Agent get its candidate data?

From Crustdata's own people dataset (1B+ profiles), through the Crustdata API. Candidate Sourcing Agent does not log in to, scrape or call any recruiting product or social network, and stores nothing beyond the files it writes in `out/` on your machine.

### Does Candidate Sourcing Agent keep charging Crustdata credits?

Nothing keeps running. A Candidate Sourcing Agent run bills once, for the people it returns. If you created a Crustdata watcher, pause or cancel it with Crustdata (`DELETE /watch/person/search/<id>`, or in the dashboard).

### Do I need an OpenAI or Anthropic key to run Candidate Sourcing Agent?

No. One Crustdata key runs everything. An AI key is only used for the optional `--ai` sentence.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Checks your Crustdata key, what it can use (search, skills, research, contacts) and your price; writes `.env` |
| `npm run source -- --role "..." --dry-run` | What it understood and the cost; spends nothing |
| `npm run source -- --role "..."` | A ranked shortlist for the role. `npm run source -- --name <role>` for the next batch |
| `npm run rescore` | Scores the saved candidates again with the current weights, free |
| `npm run contacts -- --top N` | Personal emails for the top N (needs contact data on your account) |
| `npm run watch-example -- --slack <url>` | Writes the Crustdata watcher request for the role; sends nothing |
| `npm run forget -- <profile URL>` | Removes one person from every role's files |
| `npm run replay -- fixtures/<case>.json` | The whole run offline from saved responses; `--again` runs it twice |
| `npm test`, `npm run typecheck` | Tests (offline) and types |

Every flag, the settings in `.env`, and the project layout: [docs/reference.md](docs/reference.md). `npm run source -- --help` prints the flags too.

## Data and security

The code runs on your machine and talks to `api.crustdata.com` only (and to Anthropic or OpenAI if you pass `--ai`, sending the role and each shortlisted person's titles, employers, location, skills and schools, never a name or profile URL). Keys stay in `.env`, which is in `.gitignore` and written owner-only. Candidate files stay in `out/`, also in `.gitignore`, written owner-only. See [Responsible use](#responsible-use) and [SECURITY.md](SECURITY.md).

## Customize

[docs/customize.md](docs/customize.md) covers the common changes: the weights, what the sentence can say, the columns, the shortlist, a do-not-poach list, and importing into an ATS. [AGENTS.md](AGENTS.md) is the map of the code for people and coding agents.

## Contributing

Issues and pull requests are welcome; ATS sync (Greenhouse, Ashby, Lever) is a good first one. Run `npm test` and `npm run typecheck` before opening a pull request.

## Built on Crustdata

[Crustdata](https://crustdata.com) is the people and company data API for AI agents and humans: 1B+ profiles and 60M+ companies, searchable, enrichable and watchable through one API. Docs at [docs.crustdata.com](https://docs.crustdata.com).

| Endpoint | Used for |
|---|---|
| [`POST /person/search`](https://docs.crustdata.com/person-docs/search/introduction) | the ranked candidate search ([semantic search](https://docs.crustdata.com/guides/person-semantic-search)), the round counts, the open-to-new-roles check |
| [`POST /person/search/autocomplete`](https://docs.crustdata.com/person-docs/autocomplete/introduction) | checking skills, countries, states and schools before any credit is spent (free) |
| [`POST /person/contact/enrich`](https://docs.crustdata.com/person-docs/contact/enrich) | personal emails, work emails, phones (optional, needs contact data) |
| [`GET /account/endpoints`](https://docs.crustdata.com/general/permissions) | what the key can use, and its prices (free) |
| [`POST /watch/person/search`](https://docs.crustdata.com/watcher-docs/person/discovery) | the example weekly watcher (you create it) |

## License

MIT. See [LICENSE](LICENSE).
