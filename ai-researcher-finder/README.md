# AI Researcher Finder: find AI researchers and map who works on which team at AI labs, built on Crustdata

_Part of [crustdata/tools](https://github.com/crustdata/tools), open-source agents built on the Crustdata API._

**AI Researcher Finder is an open-source AI talent mapping tool for finding AI researchers and ML engineers at frontier labs such as OpenAI, Anthropic and Google DeepMind, built on [Crustdata](https://crustdata.com), the people and company data API (1B+ profiles, 60M+ companies).** It searches the labs you name for every research and ML role, starts from people's work too (Google Scholar profiles, GitHub profiles, paper titles) so it finds researchers whose profiles say little, scores each person against your own rubric (papers, citations, h-index, team, title) with the evidence behind every point, and maps who works on which team at each lab. It is the find and map half of an AI recruiting agent for research scientists and research engineers.

How it works: Crustdata's semantic people search (in beta) ranks each lab's staff by your role, Crustdata Person Identify turns a Google Scholar URL into a person, a search on research profiles turns a paper title into its authors, and a team guess reads titles, role descriptions, recent paper titles, research interests and co-authors, and labels each team "stated" or "inferred". It is a self-hosted, open-source alternative to talent mapping and recruiting tools such as SeekOut, hireEZ and Juicebox for the research and sourcing step. TypeScript, MIT licensed, one Crustdata API key, no AI key needed, no server.

![report.md for three made-up AI labs (Example Labs, Northwind AI, Sample Intelligence): a team map table per lab with each team (Inference, Pretraining, Post-training and RL, Alignment and safety, Infrastructure and scaling, Evaluations, Multimodal) and its people split into stated and inferred, a group for people not at a searched lab, then the top researcher, Jane Doe, score 89, with her team and the evidence behind every point](assets/report.png)

**Contents:** [What it does](#what-it-does) · [How to find AI researchers](#how-do-i-find-ai-researchers-at-frontier-labs) · [Alternatives](#open-source-alternative-to-seekout-hireez-and-juicebox-for-ai-research-talent) · [Quickstart](#quickstart) · [Example run](#example-run) · [Team map](#how-do-i-find-who-works-on-which-team-at-an-ai-lab) · [Thin profiles](#how-do-i-find-ai-researchers-with-thin-or-out-of-date-profiles) · [Scholar URL](#how-do-i-turn-a-google-scholar-profile-into-a-person) · [Rubric](#how-does-the-rubric-score-work) · [Cost](#what-does-it-cost-to-find-ai-researchers-with-crustdata) · [Privacy](#is-my-target-list-private) · [Removal](#how-do-i-remove-a-person-who-asks) · [Job moves](#how-do-i-know-when-a-researcher-changes-jobs) · [Limits](#what-are-the-limits) · [FAQ](#faq) · [Commands](#commands)

## What it does

| You give it | You get |
|---|---|
| `--labs frontier` (or any labs: `--labs openai.com,anthropic.com`) | Research scientists, research engineers, members of technical staff and ML engineers Crustdata finds at those labs, ranked by your role, up to `--limit` people shared across the labs. |
| `--role "Research engineer, inference"` and `--topic "speculative decoding"` | The role and topic rank people by meaning (Crustdata semantic search), and the topic feeds the rubric's "papers on the topic" rule. |
| `--past-labs frontier` | People who worked at those labs before, wherever they are now (founders and professors included). |
| `--from seeds.csv`, or `--scholar`, `--github`, `--paper` | Starting from the work: Google Scholar profiles, GitHub profiles, profile URLs and paper titles, each turned into the person behind it. |
| `--scholar-email 10` | Also up to 10 people per lab whose Google Scholar profile has an email at the lab's domain, even when their work history does not list the lab. |
| `npm run map -- --lab anthropic.com` | One lab's research and ML staff (engineers and tech leads included), grouped by team. |
| Your `rubric.json` | A score from 0 to 100 per person, every point with its evidence (a title, a paper, an h-index), "no data" where the profile is silent, and how much of the rubric could be checked. |
| `npm run watch-example` | The Crustdata watcher request that tells you when anyone on the list moves to a new employer. You create it; this repo sends nothing. |

Every run writes to `out/<name>/` (the name says what was searched, for example `out/frontier-labs/`):

- `report.md`: the team map (lab, then team, then people, stated and inferred), then the top 25 with the evidence trail behind each score.
- `researchers.csv`: everyone, every column: score, how much of the rubric could be checked, the score on the checked rules alone, lab, current company, team and its evidence, title, past frontier labs, h-index, citations, recent papers, research interests, how and when they were found, the points earned, what had no data, profile URL, Google Scholar URL.
- `people.json`: the Crustdata records, so `npm run rescore` works offline.
- `run.json`, `seeds.json` and `dropped.json`: the search, the seed lookups and the people dropped as non-research, so running it again skips everyone already found, resumes after a failure, and reuses lookups for free.

## How do I find AI researchers at frontier labs?

To find AI researchers at frontier labs, search each lab's current staff for research and ML titles with a people search API that ranks by meaning, add the people behind papers and Google Scholar profiles (many top researchers have thin profiles), then group everyone by lab and team and score them with rules you can read. AI Researcher Finder does exactly that on [Crustdata's Person Search API](https://docs.crustdata.com/person-docs/search/introduction), in five steps:

1. **Turn labs into company ids.** `POST /company/identify` (free) turns `anthropic.com` or "Google DeepMind" into a Crustdata company id, so the search finds the company's own staff. ([`src/labs.ts`](src/labs.ts))
2. **Search each lab by meaning.** One `POST /person/search` per lab: the role as `search.query` with `mode: "hybrid"`, the lab and a research-title group as hard filters (`mode: "exact"`), and `research_profiles` returned for papers and citations. ([`src/find.ts`](src/find.ts))
3. **Start from the work.** Google Scholar URLs go to `POST /person/identify` (`research_profile_urls`), GitHub URLs to `POST /dev_platform/enrich`, paper titles to a search on `research_profiles.articles.title`. ([`src/seeds.ts`](src/seeds.ts), [`src/crustdata.ts`](src/crustdata.ts))
4. **Guess each team, with evidence.** Stated when the title, role description or headline names it; inferred from recent paper titles, research interests, past roles and co-authors at the same lab. ([`src/teams.ts`](src/teams.ts))
5. **Score with your rubric.** Every rule in `rubric.json` earns its points with the evidence, or says "no data". ([`src/rubric.ts`](src/rubric.ts))

The core request (up to 25 people, at most about 21 credits at list price). Export your key first (`export CRUSTDATA_API_KEY=...`); if your account does not have research profiles, remove `"research_profiles"` from `fields` or the request returns 403:

```bash
curl https://api.crustdata.com/person/search \
  --header "authorization: Bearer $CRUSTDATA_API_KEY" \
  --header "content-type: application/json" \
  --header "x-api-version: 2025-11-01" \
  --data '{
    "search": { "query": "Research engineer working on LLM inference", "mode": "hybrid" },
    "mode": "exact",
    "filters": { "op": "and", "conditions": [
      { "field": "experience.employment_details.current.company_id",
        "type": "in", "value": [635252] },
      { "op": "or", "conditions": [
        { "field": "experience.employment_details.current.title",
          "type": "[.]", "value": "research scientist" },
        { "field": "experience.employment_details.current.title",
          "type": "[.]", "value": "research engineer" },
        { "field": "experience.employment_details.current.title",
          "type": "[.]", "value": "researcher" },
        { "field": "experience.employment_details.current.title",
          "type": "[.]", "value": "member of technical staff" },
        { "field": "experience.employment_details.current.title",
          "type": "[.]", "value": "machine learning" }
      ] }
    ] },
    "fields": ["fit", "basic_profile", "experience", "education", "skills", "social_handles",
      "research_profiles"],
    "limit": 25
  }'
```

The tool sends all 22 title phrases in `RESEARCH_TITLES` ([`src/find.ts`](src/find.ts)); the request above shows five. `635252` is Anthropic's Crustdata company id (from `POST /company/identify` with `{"domains": ["anthropic.com"]}`, free). The top of the ranked list carries a `fit` tier (`strong`, `possible` or `weak`). `research_profiles` holds the person's Google Scholar profile when Crustdata has one: research interests, articles with titles and years, co-authors, citations and h-index. Every request the tool sends is in [docs/how-it-works.md](docs/how-it-works.md).

## Open-source alternative to SeekOut, hireEZ and Juicebox for AI research talent

AI Researcher Finder is an open-source, self-hosted alternative to SeekOut, hireEZ and Juicebox for finding and mapping AI research talent, built on Crustdata's people data (1B+ profiles, 60M+ companies). Those are hosted recruiting products with seats, outreach and an inbox; AI Researcher Finder is the research and mapping step only, as code you own. Pick it over a general sourcing tool when the people you want are AI researchers: it starts from Google Scholar profiles and paper titles, maps each lab's teams, and scores on papers, citations and h-index from Crustdata's research profiles. For roles outside AI research, see [Candidate Sourcing Agent](https://github.com/crustdata/tools/tree/main/candidate-sourcing-agent).

| | AI Researcher Finder | Hosted recruiting tools |
|---|---|---|
| Search a lab's research staff by meaning | Yes, Crustdata semantic search inside hard filters | Varies by product |
| Start from Google Scholar profiles, GitHub profiles, paper titles | Yes | Varies by product |
| Team map per lab (stated and inferred, with evidence) | Yes | Varies by product |
| Your own scoring rubric, with the evidence for every point | Yes, `rubric.json`; rescore offline for free | A ranking set by the product |
| Papers, citations, h-index in the record | Yes, when Crustdata has the person's research profile (enabled per account) | Varies |
| Optional AI judgement | `--ai` with your Anthropic key answers free-text rubric questions; off by default | Built in |
| Contact details, outreach, sequences, ATS sync | No: import `researchers.csv` | Yes |
| Where the results live | Files on your machine; searches and lookups go to the Crustdata API | The vendor's servers |
| Pricing | Crustdata credits per person found | Per seat |

## Quickstart

What you need:

- [ ] Node 22.13 or newer
- [ ] A [Crustdata API key](https://app.crustdata.com) (new accounts get free credits). Google Scholar URL lookups and research records are enabled per account; GitHub lookups are on enterprise plans. `npm run setup` tells you what your key has.

```bash
git clone https://github.com/crustdata/tools
cd tools/ai-researcher-finder
npm install
npm run setup                              # checks your key and its prices; writes .env
npm run find -- --labs frontier --dry-run  # the plan and the most it can cost; free
npm run find -- --labs frontier            # 25 research and ML people, 8 frontier labs
```

`frontier` is eight labs: OpenAI, Anthropic, Google DeepMind, xAI, Mistral AI, Thinking Machines Lab, Safe Superintelligence and Reflection AI. Meta is left out because its Crustdata company id covers all of Meta; add `meta.com` with `--labs` when you want it.

Then open `out/frontier-labs/report.md`. 25 people over 8 labs is about 3 per lab: enough to see it work. For one lab's team map, run `npm run map -- --lab anthropic.com` (100 people, at most 83 credits at list price). Run `npm run find -- --name frontier-labs` for the next 25: everyone already found is skipped and not billed again.

To see it work first with no key and no credits, replay saved responses (made-up labs and people):

```bash
npm run replay -- fixtures/example-labs.json
```

## Example run

From the offline replay, trimmed (made-up labs and people). The run prints the plan and the most it can cost before anything is billed:

```text
  query:     ML researchers and engineers, working on speculative decoding
  titles:    research scientist, research engineer, researcher, technical staff, ML and
             scientist titles (--any-title for all)
  skipping:  nobody yet
  papers:    "Speculative decoding for example models"
  cost:      at most 37.75 credits at your account's prices (research records are billed only
             for people who have one)

Search, Example Labs now: 4 new of 1,843 who match
Search, Northwind AI now: 4 new of 962 who match
Search, Sample Intelligence now: 2 new of 410 who match
Google Scholar profiles: 1 of 1 matched
  GitHub https://github.com/example-unlinked: found (Example Account), but not linked to a
  person in Crustdata (1 credit)
GitHub profiles: 1 of 2 linked to a person
Paper "Speculative decoding for example models": 2 authors found (1 already in the folder,
free); 1 other person with a different paper using the same words was left out (billed)

  #   score  checked  name                  team                                 lab
  1   89     100%     Jane Doe              Inference (stated)                   Example Labs
  2   68     100%     Kofi Example          Inference (inferred)                 Example University
  3   63     100%     Priya Example         Alignment and safety (stated)        Northwind AI
  5   51     63%      Mei Example           Post-training and RL (stated)        Example Labs
```

In `report.md`, each person reads like this:

```text
### 1. Jane Doe, score 89 (100% of the rubric checked)
Member of Technical Staff at Example Labs (2024 to now).
San Francisco, California, United States
- Team: Inference (stated), from the role description: "Inference: speculative decoding..."
- Found by: search; paper: Speculative decoding for example models
- Research: h-index 8, 2,310 citations, 2 papers in the last 3 years
- Points (85 of 95 checked):
  - +15 of 15, At a frontier lab, now or before: Research Engineer at DeepMind (2018 to 2021)
  - +15 of 15, On a model research team: Inference (stated: role description: "...")
  - +10 of 10, Recent papers on the topic (--topic): 1 paper: "Speculative decoding for
    example models" (2025)
  - 0 of 10, h-index 10 or more: h-index 8
  - +5 of 5, Found from their work (Scholar, GitHub or a paper): found from paper:
    Speculative decoding for example models
```

## How do I find who works on which team at an AI lab?

To map who works on which team at OpenAI, Anthropic or Google DeepMind, run `npm run map -- --lab anthropic.com` (or `openai.com`, `deepmind.google`, or any lab Crustdata knows) with AI Researcher Finder. It pulls up to 100 research and ML people at that lab from Crustdata (engineers and tech leads included, ranked by the role, every research and ML role by default) and puts each one on a team, with a label that says how sure it is:

- **stated**: their current title, the description of their current role, or their headline names the team ("Inference", "Pretraining scaling", "Alignment Training"). Only the parts of a headline about now count; "Ex-..." and "previously ..." pieces are ignored.
- **inferred**: the profile does not say, but other signals point one way, added up with caps so no single signal decides: paper titles from the last three years (2 points each), research interests (1), past roles (1), skills (0.5), and co-authors at the same lab whose team is stated (2 each when their Google Scholar ids match, 1 when only the name does). A team needs 2 points. A model's launch paper or technical report ("Gemini 1.5: ...", "The Llama 3 Herd of Models") is ignored, because hundreds of people from every team sign it.
- **not stated**: nothing points anywhere. Most "Member of Technical Staff" profiles with an empty description land here unless their papers say more.

The teams and the words for each (Pretraining, Post-training and RL, Inference, Infrastructure and scaling, Alignment and safety, Interpretability, Evaluations, Multimodal, Reasoning, Agents, Code, Data, Robotics, Science, Security, Model behavior, Long context and retrieval, Applied AI), plus phrases that never count ("causal inference", "trust and safety"), are in [`config/teams.json`](config/teams.json). Change them and run `npm run rescore` (free). On a live map of 40 people at one lab (2026-10-28), 14 teams were stated, 14 inferred and 12 not stated. Labs' own product names (a model or app name used as a team name) are not in the file: add them for the labs you map.

## How do I find AI researchers with thin or out of date profiles?

To find AI researchers whose professional profiles are thin or out of date, start from their work: many top researchers keep a sparse profile (a one-word title, no role description, an old employer) but a full Google Scholar page, a GitHub account or a list of papers. AI Researcher Finder takes those as seeds (a CSV or text file with `--from`, or `--scholar`, `--github`, `--paper`, `--profile`) and turns each into the Crustdata person behind it:

| Seed | Crustdata call | Cost at list price |
|---|---|---|
| Google Scholar profile URL | `POST /person/identify` with `research_profile_urls` (exact match), then the full record | 1 credit per match, free when not found, plus the full record (0.73 at most; the 0.4 research part only when they have one) |
| Paper title | `POST /person/search` on `research_profiles.articles.title` (exact phrase), then a local check that it is the same paper | Up to 1.13 per person returned (`--per-paper`, default 20) |
| GitHub profile URL | `POST /dev_platform/enrich` with `profile_url` | 1 credit a call, even when the account is not linked to a person; enterprise plans |
| Profile URL (a professional network profile) | `POST /person/identify` with `professional_network_profile_urls` | 1 credit per match, plus the full record |

The seeds file can be a text file with one paper title or link per line (titles with commas stay whole), or a CSV. In a CSV, links are read from every column, and plain text is read as a paper title only in a column named `paper` (or `papers`, `paper title`, `article`), or `Title` in a Google Scholar export (next to `Authors` or `Year`), so a name, job title or venue column is never searched as a paper. Pass `--from` more than once for several files. Paper links (arXiv, OpenReview), GitHub repository links and personal homepages are refused with a note. Every lookup is saved in `seeds.json`, so a second run reuses it for free. A paper search can also return people with a different paper that uses the same words ("Channel attention is all you need"); those are dropped and the run says how many (they are billed).

`--scholar-email 10` adds one more search per lab: people whose Google Scholar profile has an email at the lab's domain (`research_profiles.verified_email_domain`), whatever their work history says. Scholar keeps old emails too, so this finds people at the lab whose professional profile is out of date and people who have left; each is marked "Google Scholar email at <domain>" and grouped by their current employer.

## How do I turn a Google Scholar profile into a person?

Send the Scholar URL to Crustdata's Person Identify API. It matches exactly on the profile's `user` id, costs 1 credit per match and nothing when it finds nobody, and takes up to 25 URLs per request:

```bash
curl https://api.crustdata.com/person/identify \
  --header "authorization: Bearer $CRUSTDATA_API_KEY" \
  --header "content-type: application/json" \
  --header "x-api-version: 2025-11-01" \
  --data '{ "research_profile_urls": ["https://scholar.google.com/citations?user=<id>"] }'
```

Each row comes back with `match_status` (`matched`, `not_found` or `redacted`) and, when matched, the person's `crustdata_person_id`, name, title and profile URL. AI Researcher Finder does this for every `--scholar` URL and every Scholar link in a `--from` file (it keeps only the `user` id, so links with `hl=en` or other parameters work), matches each answer to its own URL, then fetches the full record. A `redacted` row means the person asked Crustdata to remove their data; nothing is stored. Person Identify is enabled per Crustdata account; `npm run setup` checks yours with a free lookup.

## How does the rubric score work?

AI Researcher Finder gives every person a score from 0 to 100 from their Crustdata record: the points they earned, plus a quarter of the points of any rule their record has no data for, out of all the points the rubric can give. The rules are in [`rubric.json`](rubric.json), and each one earns its points with the evidence behind it:

| Points | Rule (as shipped) | Evidence shown |
|---|---|---|
| 15 | At a frontier lab, now or before (by Crustdata company id, plus older names such as DeepMind) | The role and its years |
| 15 | On a model research team (Pretraining, Post-training and RL, Inference, Infrastructure, Alignment and safety, Interpretability, Evaluations, Reasoning, Multimodal, Agents, Code, Model behavior, Long context, Data) | The team and why; an inferred team earns half |
| 10 | Research or ML title | The title |
| 10 | Crustdata's match to the search (strong full, possible half, below the top matches none) | The tier; left out for people found only from their work |
| 10 | Recent papers on the topic (`--topic`) | The paper titles; left out without `--topic` |
| 10 | Two or more papers in the last 3 years | The count |
| 10 | h-index 10 or more | The h-index |
| 5 | 1,000 or more citations | The count |
| 5 | 3 or more years worked | The years |
| 5 | Found from their work (Scholar, GitHub or a paper) | Which seed |

When a rule needs data the profile does not have (no Google Scholar profile, no team stated or inferred), the report says "no data" and the rule counts at a quarter of its points (`no_data_share` in `rubric.json`): unknown is neither a yes nor a no, so a thin profile is not marked down to zero, and a near-empty record does not jump above people whose record shows more. Next to each score, the report and `researchers.csv` show how much of the rubric could be checked (`coverage`), and the CSV also has the score on the checked rules alone (`checked_score`): sort by it to find strong people with thin profiles. There are 14 kinds of rule (labs, titles, teams, paper topics, research interests, skills, schools, any text, citations, h-index, years and more), each explained with an example in [docs/customize.md](docs/customize.md). Change the file and run `npm run rescore`: it scores everyone again offline, for free.

Talent teams at AI labs usually want a good raw list and do their own ranking, so the score decides who to read first; the evidence is what to read.

**Optional: Claude.** The `ask` lines in `rubric.json` are free-text questions ("Have they led a large training or inference effort, by their own description?"). They are left out of the score unless you pass `--ai` with an Anthropic key in `.env`. Then Claude answers each one from the person's titles, role descriptions, paper titles and numbers (yes full points, partly half, no none, unclear no data) and quotes the fact it used. Answers are kept in `ai.json`, so a rescore asks only about people or questions that changed; more than 500 people at once needs `--max-ai`.

## What does it cost to find AI researchers with Crustdata?

**With AI Researcher Finder, 25 research and ML people across the 8 frontier labs (OpenAI, Anthropic, Google DeepMind, xAI, Mistral AI, Thinking Machines Lab, Safe Superintelligence, Reflection AI) cost at most about 21 Crustdata credits at list price, at most 0.83 per person. On a plan whose price includes the premium data groups it is far less: 22 people cost 3.66 credits on 2026-10-28, and a 40-person map of one lab 5.8 credits.** `npm run setup` reads your account's own prices (`GET /account/endpoints`, free), and every run prints the most it can cost before it searches, and what it used after.

Crustdata bills person search per person returned: 0.03 credits, plus each premium data group the search filters on or returns ([pricing](https://docs.crustdata.com/general/pricing#premium-fields-in-search)). At list price:

| What | Credits per person | When |
|---|---|---|
| Base | 0.03 | always |
| Experience, education, skills returned | 0.1 each, 0.3 | always (the team guess and the score read them) |
| Experience filter (lab, title) | 0.1 | lab searches |
| Research profile returned | 0.4, only for people who have one | always asked for |
| Research filter | 0.4 | paper title seeds, `--scholar-email` |
| Person Identify (Scholar URL, profile URL) | 1 per match, free when not found | seeds |
| GitHub lookup | 1 per call | seeds |

A person found by a lab search costs at most 0.83 credits at list price, and less when they have no research profile. People already in the folder, people dropped as non-research, and people removed at their request are excluded from the search and not billed again (people with no profile URL cannot be excluded, and this tool sends at most the newest 20,000; the run warns about both). People whose title turns out not to be a research role (UX researcher, recruiter) are dropped after the search, billed once, and skipped in later runs; the run counts them. A rerun of the same search after a failure resumes it: labs whose search finished are not searched again. The ceiling also counts full records still to fetch for seeds looked up before. A run that can cost more than 100 credits stops before it starts (a dry run says so too) (`MAX_CREDITS` in `.env`, or `--max-credits` for one run). `--dry-run`, `npm run rescore`, `npm run watch-example`, `npm run forget` and `npm run replay` cost nothing.

## Is my target list private?

Your files stay on your machine; the lookups go to Crustdata. AI Researcher Finder writes the people it finds, their scores and your seeds only under `out/` (in `.gitignore`, written owner-only), keeps no logs elsewhere, and has no server, telemetry or shared database. It sends requests only to `api.crustdata.com`, and to `api.anthropic.com` when you pass `--ai`.

Crustdata receives the searches and lookups themselves: the labs, the role and topic, the Google Scholar and GitHub URLs, the paper titles, the ids of the people found from them, and, with every search, the profile URLs of the people already in that folder, of people dropped as non-research and of people removed with `npm run forget` (so they are not returned or billed again). With `--ai`, Anthropic receives each person's titles, employers, role descriptions, headline, paper titles, research interests, skills and research numbers, never their name, profile URL, Scholar URL or location. See [SECURITY.md](SECURITY.md).

## How do I remove a person who asks?

Run `npm run forget -- <profile URL, Google Scholar URL or Crustdata person id>`. AI Researcher Finder deletes them from every search folder under `out/` (the people file, seed lookups, saved seeds, the dropped list, cached Claude answers and any watcher request written), writes each report and CSV again without them, and adds them (id, profile URL, Google Scholar id) to `out/suppressed.json` first: no later run stores them or looks them up again, even from their Scholar URL, and every search skips their profile URL so they are not billed again (pass the profile URL: by id alone, a search can still return them, and they are dropped after it). If you already created a Crustdata watcher, remove them there too. It works offline and costs nothing. You are responsible for the data in `out/`: keep it only while a search is open, and delete copies you shared elsewhere yourself. A Scholar URL that Crustdata answers as `redacted` (the person asked Crustdata to remove their data) is never stored.

## How do I know when a researcher changes jobs?

AI Researcher Finder hands the list to a Crustdata person watcher. `npm run watch-example -- --email you@yourcompany.example` (or `--slack <webhook URL>`, `--webhook <https URL>`) writes `out/<name>/watch-request.json`: a Crustdata person watcher over the profile URLs of everyone in the folder (`--top 50` for the 50 best scored), set to fire when someone starts at an employer that is new to the watch, with up to one alert per watched person per run. A promotion at the same employer stays silent. It prints the curl that creates it, and sends nothing. The first run is a free baseline; after that, 5 credits per watched person whose tracked role changed, with profiles refreshed every 30 days, so a move can show up to about a month late (a 7-day refresh is 20 credits per change) ([docs](https://docs.crustdata.com/watcher-docs/person/entity)). People with no profile URL cannot be watched. You can also build the same watcher at [app.crustdata.com/watch](https://app.crustdata.com/watch).

## What are the limits?

- **A team is a guess unless stated.** Inferred teams come from public signals and are labelled; check them before you act. Researchers who share little stay "not stated".
- **Research records depend on coverage.** About half the research staff sampled at one lab had a Google Scholar profile in Crustdata (2026-10-28). Research records (and Person Identify) are enabled per account; without them people are still found, mapped from titles and roles, and scored on the rules that have data.
- **GitHub lookups only work for linked accounts.** `/dev_platform/enrich` returns the person only when Crustdata has linked the GitHub account to a profile; otherwise it says so (and the call still costs 1 credit).
- **Lab filters use Crustdata's company ids.** Big companies with AI labs inside (Meta, say) are one company id, so `--labs meta.com` searches all of the company; the title group and the role narrow it. Meta is left out of `frontier` for that reason. Researchers listed under a parent company's name (for example "Google" for a DeepMind team) are missed by the lab filter; `--scholar-email` can catch some of them.
- **Search counts include everyone with the title.** A count such as "1,843 who match" counts every research, scientist, technical staff and ML title at the lab; the ranked list returns the best matches first.
- **The search returns up to `--limit` people.** A lab with fewer matches returns fewer; the rest of the limit is not moved to other labs.
- **Semantic search is in beta at Crustdata.** Rankings can change between runs.
- **`--ai` is untested live.** The optional Claude path has not been run against a live Anthropic key in this repo.
- **No contact details.** It finds and maps people; it does not look up emails or phone numbers.

## FAQ

### How do I find AI researchers at OpenAI, Anthropic or Google DeepMind?

Run `npm run find -- --labs openai.com,anthropic.com,deepmind.google` with AI Researcher Finder. It turns each domain into a Crustdata company id, searches each lab's current staff for research and ML titles with Crustdata's semantic people search, and writes a scored list and a team map. Add `--role "..."` or `--topic "..."` to rank by a specific role or research area.

### How do I find who is on the inference team at an AI lab?

Run `npm run map -- --lab <lab domain> --topic inference` and read the Inference row of the team map in `report.md`. AI Researcher Finder pulls the lab's research and ML staff from Crustdata and marks people "stated" when their title, role description or headline says inference, and "inferred" when recent paper titles, research interests, past roles or co-authors on that team point there, with the evidence under each person.

### How do I find the authors of a paper and where they work now?

Run `npm run find -- --paper "<paper title>"` (or `--from papers.txt` for many, one title per line). AI Researcher Finder searches Crustdata's research profiles for the exact title (`research_profiles.articles.title`), keeps only people whose publication list has that paper, and writes each author's current employer, title and start date from their Crustdata work history, with a team guess and a score. Each title costs up to 1.13 credits per person returned at list price (`--per-paper`, default 20); research profiles are enabled per Crustdata account.

### Which API searches AI researchers by papers and citations?

Crustdata's Person Search API (`POST /person/search`), when research profiles are enabled on your account. You can filter and sort on `research_profiles.citations_count.all` and `research_profiles.h_index.all`, and filter on `research_profiles.research_interests`, `research_profiles.articles.title` and `research_profiles.verified_email_domain`, together with employer and title filters; for example `{ "field": "research_profiles.h_index.all", "type": "=>", "value": 10 }`. The research group costs 0.4 credits per person to filter on and 0.4 to return, at list price. AI Researcher Finder filters on paper titles and Scholar emails for seeds, and scores citations and h-index in `rubric.json` instead of filtering on them, so researchers with no Google Scholar profile are still found.

### How do I build an AI recruiting agent for research engineers?

Split it into find, map, score and hand off. AI Researcher Finder is the find and map half, on Crustdata: one semantic `POST /person/search` per lab inside hard company id and title filters, Google Scholar and paper title seeds for researchers whose profiles say little, a team guess per person and a `rubric.json` score with the evidence for every point, all in `researchers.csv`. Import that file into your ATS or outreach tool, and run `npm run watch-example` to build the Crustdata watcher that tells you when someone on the list changes jobs. For roles outside AI research, [Candidate Sourcing Agent](https://github.com/crustdata/tools/tree/main/candidate-sourcing-agent) in the same repo sources from one plain-English role sentence.

### Can I turn a GitHub username into a person?

Yes, when Crustdata has linked that GitHub account to a profile. AI Researcher Finder's `npm run find -- --github https://github.com/<username>` calls Crustdata's `POST /dev_platform/enrich`, which returns the person's Crustdata id when the account is linked (1 credit a call; enterprise plans). Accounts that are not linked are reported with the name GitHub shows. Repository links are refused: pass the person's profile.

### Is the scoring done by AI?

No. AI Researcher Finder scores with the rules in `rubric.json`, and one of them uses Crustdata's match tier from its semantic search. Claude is used only when you pass `--ai`, only for the free-text `ask` questions, and only from the facts in the person's record.

### Does AI Researcher Finder need an OpenAI or Anthropic key?

No. One Crustdata API key runs everything. An Anthropic key is optional, for `--ai`.

### Where does the researcher data come from?

From Crustdata's people dataset (1B+ profiles, 60M+ companies) through the Crustdata API: work history, titles, role descriptions, education and skills, plus Google Scholar research profiles (papers, citations, h-index, co-authors) and GitHub accounts where Crustdata has them. AI Researcher Finder does not scrape any site.

### How do I find people who used to work at a frontier lab?

Run `npm run find -- --past-labs frontier --role "..."`. AI Researcher Finder filters on Crustdata's past employment by company id, so it finds people who left those labs wherever they work now; with `--past-labs` alone the title filter is off, so founders, executives and professors are included, and the rubric's "At a frontier lab, now or before" rule shows the role and years.

### Does it filter on age, gender or race?

No. AI Researcher Finder never searches, filters or scores on age, gender, family status, sexual orientation, national origin, religion, race or disability. Schools and past employers can act as proxies when you put them in your rubric; use the score to decide who to read first, not who to reject.

## Commands

| Command | What it does | Credits |
|---|---|---|
| `npm run setup` | Asks for your Crustdata key (and an optional Anthropic key), checks what the key can use and its prices, writes `.env` | free |
| `npm run find -- --labs frontier --dry-run` | The plan and the most it can cost | free |
| `npm run find -- [flags]` | Search, resolve seeds, map teams, score, write `out/<name>/` | billed per person |
| `npm run find -- --name <name>` | The same search again: the next people (flags typed now, such as `--limit`, replace the saved ones) | billed per new person |
| `npm run find -- --name <name> --paper "..."` | Add seeds to a saved search without searching again | billed per seed |
| `npm run map -- --lab <lab>` | One lab's research and ML people by team (default 100) | billed per person |
| `npm run rescore` | Score and map again after changing `rubric.json` or `config/teams.json` | free |
| `npm run watch-example -- --email <you>` | Writes the Crustdata watcher request for job moves; sends nothing | free |
| `npm run forget -- <profile URL or id>` | Removes a person from every folder, seed lookup and watcher request; later runs skip them | free |
| `npm run replay -- fixtures/example-labs.json` | The whole run offline, from saved responses | free |

Every flag: `npm run find -- --help` and [docs/reference.md](docs/reference.md).

## Configuration

| Setting in `.env` | Default | What it does |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Your Crustdata API key |
| `OUT_DIR` | `out` | Where each search's folder goes |
| `MAX_CREDITS` | `100` | A run that can cost more stops before it starts |
| `ANTHROPIC_API_KEY` | | Optional, for `--ai` |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | The model `--ai` uses |

## Customize

The common changes, with file names: your scoring rules (`rubric.json`), the teams and their words (`config/teams.json`), what `frontier` means (`FRONTIER_LABS` in `src/labs.ts` and `FRONTIER_IDS` in `src/rubric.ts`), which titles count as research (`RESEARCH_TITLES` in `src/find.ts`). See [docs/customize.md](docs/customize.md).

## Project structure

```text
src/cli.ts         commands: find, map, rescore, watch-example, forget
src/find.ts        the run: plan and cost, searches, seeds, files, rescore
src/crustdata.ts   the only file that talks to Crustdata (plain REST, retries, pacing)
src/labs.ts        labs to company ids, the frontier list
src/seeds.ts       Scholar, GitHub, profile URLs and paper titles from a file or flags
src/teams.ts       the team guess: stated, inferred, not stated
src/rubric.ts      rubric.json: rules, evidence, score
src/output.ts      report.md and researchers.csv
src/profile.ts     reading a Crustdata person record
src/forget.ts      removal requests
src/ai.ts          optional --ai answers
src/cost.ts        prices and the cost ceiling
examples/          watch-people.ts: the watcher request for job moves
config/teams.json  the teams and their words
rubric.json        your scoring rules
fixtures/          made-up responses for npm run replay and the tests
test/              node:test, offline
```

## Built on Crustdata

[Crustdata](https://crustdata.com) is a people and company data API (1B+ profiles, 60M+ companies) for AI agents and the products built on them. APIs this tool uses:

- [Person Search API](https://docs.crustdata.com/person-docs/search/introduction) and the [semantic search guide](https://docs.crustdata.com/guides/person-semantic-search)
- [Person Identify API](https://docs.crustdata.com/person-docs/identify/introduction) (Google Scholar and profile URLs)
- [Company Identify API](https://docs.crustdata.com/company-docs/identify/introduction)
- Dev Platform Enrich, `POST /dev_platform/enrich` (GitHub; [pricing](https://docs.crustdata.com/general/pricing))
- [Person Entity Watcher](https://docs.crustdata.com/watcher-docs/person/entity)

More open-source agents on Crustdata: [crustdata/tools](https://github.com/crustdata/tools).

## License

MIT
