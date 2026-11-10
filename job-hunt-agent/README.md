# Job Hunt Agent: an open-source AI job search agent that finds the people behind each job, built on Crustdata

**Job Hunt Agent is an open-source AI job search agent built on [Crustdata](https://crustdata.com), a B2B people and company data API with 1B+ profiles and 60M+ companies.** A self-hosted alternative to career-ops, Simplify, Teal and Huntr, it needs one Crustdata key and no OpenAI or Anthropic key. Give it your CV and a search ("software engineer near San Francisco"): it finds open jobs, scores each one against your CV, checks the best are still open, and for each of the best jobs (5 by default) finds the likely recruiter, the likely hiring manager, up to 3 people on the team and alumni from your school, with profile URLs. It tells you whether the company is growing or shrinking and when it last raised, then drafts one outreach note per person that you edit and send yourself. Claude Code skills add an AI verdict, personal notes and a tailored CV. Crustdata Job Search supplies the postings, Company Search the headcount growth, People Search the people. Local, TypeScript, MIT.

<img src="assets/dashboard.png" width="860" alt="The Job Hunt Agent dashboard (npm run dashboard) on the sample run: a ranked list of jobs on the left with fit scores (96 Senior Software Engineer, Platform at Northwind Robotics, growing +24%), and on the right the selected job with its fit breakdown (skills 46 of 50), why it scored that way, the company's headcount trend and last round, and who to talk to: an alum from the user's school marked Write to first, then recruiters, each with a draft note and a Copy note button. Companies and people in the sample are made up.">

**Contents:** [What it finds](#what-does-job-hunt-agent-find-for-each-job) · [How to build a job hunt agent](#how-do-i-build-a-job-hunt-agent) · [Alternative to career-ops](#is-there-an-open-source-alternative-to-career-ops-simplify-teal-or-huntr) · [Quickstart](#quickstart) · [One job](#how-do-i-try-job-hunt-agent-on-one-job) · [Claude Code skill](#is-there-a-claude-code-skill-for-job-search) · [Recruiter](#how-do-i-find-the-recruiter-for-a-job-posting-automatically) · [Hiring manager](#how-do-i-find-the-hiring-manager-for-a-job) · [Alumni](#how-do-i-find-alumni-from-my-university-at-a-company) · [Growing or shrinking](#how-do-i-know-if-a-company-is-growing-or-shrinking) · [Fit score](#how-does-job-hunt-agent-score-a-job-against-my-cv) · [Still open?](#how-fresh-are-the-jobs-and-are-they-still-open) · [Cost](#how-much-does-it-cost-to-run-a-job-search-agent-on-crustdata) · [Classes and teams](#can-a-bootcamp-class-or-a-career-center-use-job-hunt-agent) · [Limits](#what-are-the-limits) · [Crustdata APIs used](#which-crustdata-apis-does-a-job-hunt-agent-use) · [FAQ](#faq) · [Commands and flags](#commands-and-flags) · [Configuration](#configuration) · [Data and privacy](#data-and-privacy) · [Customize](#customize) · [Project structure](#project-structure) · [Built on Crustdata](#built-on-crustdata)

## What does Job Hunt Agent find for each job?

One run reads the newest matching jobs, scores them all against your CV, and looks up people for the best 5. You get a markdown report, JSON, a CSV and a local dashboard.

| For each job | What you see | Source |
|---|---|---|
| Fit score | 0 to 100 with every point explained: skills the posting asks for that your CV has (and the ones it does not), title and level against your years, place, company momentum, freshness | Worked out on your machine from the posting and your CV |
| Flags | "Does not sponsor visas", "needs a security clearance", "US citizens only", "asks for 8+ years; your CV shows 4", "the team shrank 9% in 6 months" | The posting text and Company Search |
| Still open? | Checked on the job board for Greenhouse, Lever, Ashby and SmartRecruiters postings (free); closed ones drop out and the next one moves up | The job board's public API |
| Recruiter | Up to 2 people whose title says recruiting, technical recruiters for engineering roles, in the job's country first | Crustdata People Search |
| Hiring manager (likely) | A manager in the job's line of work at the company (engineering manager, head of product), nearest the job's city; not always this job's own team | Crustdata People Search |
| On the team | Up to 3 people with a similar title at the company | Crustdata People Search |
| Alumni from your school | Up to 3 people at the company who went to your school or bootcamp (read from your CV), with their graduation year | Crustdata People Search |
| Company | Headcount and its growth over 6 and 12 months, last round and date, total raised | Crustdata Company Search and Job Search |
| Draft notes | One note per person (about 200 characters, never over 300), and one person per company to write to first; the same person under two jobs gets one note; with Claude Code, written for each person from your CV | Templates, or your Claude Code |

**Rule: the agent drafts, you send.** Job Hunt Agent never applies, never sends a message or an email, and has no code that could. It marks one person per job to write to first.

## How do I build a job hunt agent?

To build a job hunt agent, search job postings by title, place and date with Crustdata, a people and company data API with 1B+ profiles and 60M+ companies; score each posting against the skills, school and years in your CV; check the best ones are still open on their job board; look up the company's headcount growth; then search the people who work there for the recruiter, the hiring manager, the team and alumni of your school, and draft a note to each. [Job Hunt Agent](https://github.com/crustdata/tools/tree/main/job-hunt-agent) does all of it in TypeScript with one Crustdata key:

1. **Find the jobs.** [Job Search](https://docs.crustdata.com/job-docs/search/introduction) (`POST /job/search`): title words in any order, within 50 miles of a city (or remote in a country), posted in the last 30 days, newest first, with the full description and the company's basics and funding (0.03 credits a job; a count with `limit: 0` is free).
2. **Score against the CV.** Read skills, schools and years from the CV on your machine, fold the same role listed on several sites into one, leave out staffing agencies, and score each job (rules in [src/score.ts](src/score.ts)).
3. **Check they are still open.** The public job board APIs of Greenhouse, Lever, Ashby and SmartRecruiters say whether a posting is live (free, no key).
4. **Company momentum.** [Company Search](https://docs.crustdata.com/company-docs/search/introduction) (`POST /company/search`) by Crustdata company id: headcount growth over 1, 3, 6 and 12 months.
5. **The people.** [People Search](https://docs.crustdata.com/person-docs/search/introduction) (`POST /person/search`) at that company, ranked by a short query ("technical recruiter hiring software engineers", the job title), with `education.schools.school` for alumni. Then draft the notes.

The core request, the recruiter for an engineering job at one company. Use the `crustdata_company_id` from a Job Search row (900101 here is made up). The top-level `"mode": "exact"` keeps the filters hard while the query ranks the people:

```bash
curl -X POST https://api.crustdata.com/person/search \
  -H "authorization: Bearer $CRUSTDATA_API_KEY" \
  -H "x-api-version: 2025-11-01" \
  -H "content-type: application/json" \
  -d '{
    "search": { "query": "technical recruiter hiring software engineers", "mode": "hybrid" },
    "mode": "exact",
    "filters": { "op": "and", "conditions": [
      { "field": "experience.employment_details.current.company_id", "type": "=",
        "value": 900101 },
      { "field": "basic_profile.location.country", "type": "in",
        "value": ["United States", "United States of America"] } ] },
    "fields": ["basic_profile.name", "experience.employment_details.current.title",
               "social_handles.professional_network_identifier.profile_url"],
    "limit": 2
  }'
```

Every request and answer, in order, with its cost: [docs/how-it-works.md](docs/how-it-works.md).

## Is there an open-source alternative to career-ops, Simplify, Teal or Huntr?

Yes. Job Hunt Agent runs on your machine like [career-ops](https://github.com/career-ops-hq/career-ops) and keeps the same rule (it drafts, you submit). What it adds is structured people and company data from Crustdata, a B2B people and company data API with 1B+ profiles and 60M+ companies: the best jobs come with named people found by title and school at that company, and the company's measured headcount trend.

| | Job Hunt Agent | career-ops | Simplify, Teal, Huntr |
|---|---|---|---|
| Finds jobs | Crustdata Job Search (job boards and company career sites) | Portal scanner over company boards | Browser extension and job boards |
| Fit against your CV | Rule score without AI; full read with Claude Code | AI evaluation | Match scores (varies by product) |
| Still open check | Greenhouse, Lever, Ashby, SmartRecruiters | Yes | Partly |
| Recruiter, hiring manager, team | By title at the company, with profile URLs, job's country first | A contact mode that names a hiring manager, recruiter or peer | Contact tracking for people you add; Simplify shows people in your network who can refer you |
| Alumni from your school at the company | Yes, by school on profiles | Not a listed feature | Not a listed feature |
| Company growing or shrinking | Headcount growth over 6 and 12 months | Company research mode, recently funded companies | Company pages with size and funding (varies by product) |
| Draft notes | One per person, one suggested first contact; you send | Yes; you send | Some |
| Tailored CV, cover letters, interview prep | Tailored CV via a Claude Code skill; no PDF or cover letters | Yes, much more | Yes |
| Submits applications | Never | Never | Autofill; you submit |
| Cost | Crustdata credits per run (about 18 at list price) | Free, plus your AI CLI | Free tier, paid plans |

If you already use career-ops, the two fit together: Job Hunt Agent for who to talk to and whether the company is growing, career-ops for the CV and the application.

## Quickstart

What you need:

- [ ] Node.js 22.13 or newer (`node --version`)
- [ ] A Crustdata API key from [app.crustdata.com](https://app.crustdata.com) (new accounts get free credits)
- [ ] Your CV as markdown, plain text or PDF. Copy it into the folder as `cv.pdf` (or `cv.md`), or give its path when setup asks. To try first, use [examples/cv-example.md](examples/cv-example.md).

```bash
git clone https://github.com/crustdata/tools.git
cd tools/job-hunt-agent
npm install            # "npm warn install-scripts" lines are harmless
npm run setup          # key (checked, free), CV, search; shows how many jobs match
npm run hunt           # about 18 credits at list price, about a minute; ranked jobs
npm run dashboard      # then open http://localhost:3480
```

`npm run hunt -- --dry-run` shows how many jobs match and the most the run could cost at your account's prices, and spends nothing. Every flag overrides your saved search for one run: `npm run hunt -- --title "backend engineer" --location "Austin" --top 3`.

To see a full run with no key and no network, replay the sample (made-up companies and people):

```bash
npm run replay -- fixtures/hunt-sf.json
```

## How do I try Job Hunt Agent on one job?

Paste the posting's URL into Job Hunt Agent. You get the fit, the company's trend from Crustdata and the people to contact for that one job, for about 3 credits at list price:

```bash
npm run job -- "<paste the job posting URL>"     # job boards, Greenhouse, Lever, Ashby, ...
npm run replay -- fixtures/one-job.json          # the same offline, on the sample
```

Links copied from a job site's search page (with `currentJobId=`) work too. If the posting is not in the Crustdata job index (a brand new one, or a site the index does not cover), the lookup costs nothing; give the company's website and the title instead, and the score then uses the title, level and company only:

```bash
npm run job -- --company <company website> --title "Backend Engineer"
```

## Is there a Claude Code skill for job search?

Yes. Job Hunt Agent ships two Claude Code skills in [.claude/skills](.claude/skills) that run the agent on your Crustdata key and add the reading only an AI can do. Open the folder in [Claude Code](https://claude.com/claude-code) and ask, for example, "find software engineer jobs in San Francisco that fit my CV" or "evaluate this job: <URL>":

- **job-hunt** runs the agent, then reads each posting against your whole CV, gives a verdict (Apply, Maybe, Skip, 1 to 5) with the reasons and gaps, says who to contact first, and writes one personal note per person. It saves them to `out/<run>/ai/<job id>.md`, and the dashboard shows them next to the job.
- **tailor-cv** rewrites your CV for one job by reordering and rewording what is already in it, never adding anything, and lists the changes and the gaps.

No AI API key is needed: the AI steps run in your own Claude Code, which needs a Claude plan. Codex, Cursor and other coding agents follow the same steps from [AGENTS.md](AGENTS.md).

## How do I find the recruiter for a job posting automatically?

Job Hunt Agent finds the recruiter for a job automatically with Crustdata People Search: it searches the people who work at the company now, ranked by "technical recruiter hiring software engineers" (or "recruiter hiring for <role>" outside engineering and data), in the job's country first, with the top-level `"mode": "exact"` so the company filter holds. It keeps only people whose title at that company says recruiting, talent or sourcing, nearest the job's city first. If nobody in the country fits, it searches again anywhere. Recruiters working through an agency the company uses ("Technical Recruiter, Consultant via ...") count; recruiting managers are never shown as the hiring manager. Run `npm run job -- <posting URL>` for one job.

## How do I find the hiring manager for a job?

Job postings rarely name the hiring manager, so Job Hunt Agent finds the likely one: a Crustdata People Search at the hiring company (filtered on `experience.employment_details.current.company_id`, in the job's country first), ranked by the manager title for the job's line of work plus the job title ("engineering manager Backend Engineer", "director of product or group product manager Product Manager"), with top-level `"mode": "exact"`. It keeps a person whose title there says manager, head, director or lead. At a large company this is a manager in the right function near the job, not always the manager of that exact team; the report labels them "likely". The queries are `MANAGER_QUERY` in [src/people.ts](src/people.ts).

## How do I find alumni from my university at a company?

Job Hunt Agent finds alumni of your university or bootcamp at a company with two Crustdata API calls: the free Person Autocomplete (`POST /person/search/autocomplete`, field `education.schools.school`) for the spellings of your school on profiles, then People Search (`POST /person/search`) at the company with `education.schools.school` matching any spelling as a phrase (`[.]`), ranked by the job title, so engineers come first for an engineering job. It reads the school from your CV (or `--school "University of Washington"`) and adds common short forms ("UC Berkeley" for "University of California, Berkeley"); it keeps only spellings that start with your school's name, so "University of Washington" never brings in "Washington State University". Each person shows the school and graduation year.

```json
{
  "search": { "query": "software engineer", "mode": "hybrid" },
  "mode": "exact",
  "filters": { "op": "and", "conditions": [
    { "field": "experience.employment_details.current.company_id", "type": "=",
      "value": 900101 },
    { "op": "or", "conditions": [
      { "field": "education.schools.school", "type": "[.]",
        "value": "University of California, Berkeley" },
      { "field": "education.schools.school", "type": "[.]", "value": "UC Berkeley" } ] } ] },
  "fields": ["basic_profile.name", "experience.employment_details.current.title",
             "education.schools.school", "education.schools.end_year",
             "social_handles.professional_network_identifier.profile_url"],
  "limit": 3
}
```

## How do I know if a company is growing or shrinking?

Crustdata Company Search returns the headcount and its growth over 1, 3, 6 and 12 months; Crustdata Job Search rows already carry the last round, its date and the total raised. Job Hunt Agent calls a company growing at +5% or more over 6 months, shrinking at -5% or less, flat in between. A shrinking team is flagged on the job.

## How does Job Hunt Agent score a job against my CV?

Job Hunt Agent scores every job 0 to 100 without AI, every part shown in the report:

| Part | Points | How |
|---|---|---|
| Skills | 50 | Skills the posting names that your CV has. Skills under "Nice to have", "Preferred" or "Bonus" count half; skills your CV marks "(learning)" do not count. 144 skills with their other spellings ("k8s", "golang"), in [src/skills.ts](src/skills.ts) |
| Title and level | 20 | The title has the words of a title you search for (12); the level (intern to principal) fits your years of experience (8) |
| Place | 10 | The work mode fits what you asked for |
| Company | 10 | Headcount growth over 6 months (6), a round in the last 12 months (4) |
| Freshness | 10 | Posted in the last 3 days (10), 7 (8), 14 (6), 30 (4) |
| Flags | minus | No visa sponsorship when you need it (-25), a security clearance (-15), US citizens only when you need sponsorship (-15), more than a year beyond the years you have (-10) |

70 and above is "Strong fit", 50 to 69 "Possible fit", below 50 "Weak fit". A role two levels above your years, or asking for more than a year beyond the years you have, is "Stretch" at most, and a posting that names fewer than 2 skills is never "Strong fit". Because the search already matches the title and place, about 30 points are similar for every job: read the skills line first. Jobs under 50 get no people search unless you add `--all`, to save credits. The weights are `WEIGHTS` in [src/score.ts](src/score.ts). With Claude Code, the job-hunt skill reads the whole posting and your whole CV and gives its own verdict next to this score.

## How fresh are the jobs, and are they still open?

Job Hunt Agent reads jobs from Crustdata's job index, newest first, posted in the last 30 days by default (`--days`). The index can keep a posting for a while after it closes, so for postings on Greenhouse, Lever, Ashby and SmartRecruiters the agent asks the job board itself, for free: closed ones are dropped and listed at the end of the report, and the next job moves up. Other postings are marked "not checked" with how many days ago they were posted. The people and company data come from Crustdata's indexed profiles and companies.

## How much does it cost to run a job search agent on Crustdata?

**About 18 Crustdata credits at list price** for a default Job Hunt Agent search: measured 17.96 at list price for 50 jobs read and people found at the best 5 (software engineer near San Francisco, Oct 2026). Some Crustdata plans include the premium field groups this uses; the same run cost 3.36 on one. Every run prints both numbers, and `--dry-run` prints the worst case at your own account's prices for free.

| Step | Credits at list price |
|---|---|
| Count matching jobs, school spellings, open checks, your prices | free |
| Read and score 50 jobs (`--scan`) | 1.5 (0.03 a job) |
| Headcount growth for the best 5 (`--top`) | 1.15 (0.03 a company + 0.2 headcount group) |
| Recruiter, manager and team for the best 5 | about 9 (0.23 a person: 0.03 + 0.1 experience filter + 0.1 experience returned) |
| Alumni for the best 5 | about 6 (0.43 a person: also 0.1 + 0.1 for education) |
| Work emails for recruiters and managers (`--emails`) | 1 per person matched, even when their only address is at a former employer (then left out) |
| One job by URL (`npm run job`) | about 3 |

Companies and people are kept for 14 days (`CACHE_DAYS`): a second run the same week pays mostly for the jobs it reads again, and a second job at the same company reuses its recruiters (a different title pays again for the manager, team and alumni searches). A run whose worst case is above 30 credits (`MAX_CREDITS_PER_RUN`; a default run is at most about 25) asks for `--yes`, and a run charged more than a quarter above its estimate stops itself. Prices per call on your account: `GET /account/endpoints` (free) or [app.crustdata.com](https://app.crustdata.com).

## Can a bootcamp class or a career center use Job Hunt Agent?

Yes, with three things agreed up front.

- **Keys and credits.** Give each student their own Crustdata key (new accounts get free credits), or share one key and stagger runs: Crustdata allows 30 requests a minute per endpoint per key and a run makes about 20 people searches, so two runs at once on one key slow each other down. A student who runs one search a week for a 12 week job hunt uses about 12 × 18 = 216 credits at list price, less with the cache and on plans that include premium field groups. Credit packs and the free allowance are on [app.crustdata.com](https://app.crustdata.com); prices per credit and plan allowances: [docs.crustdata.com/general/pricing](https://docs.crustdata.com/general/pricing).
- **Etiquette.** Students searching the same city find the same recruiters and alumni, and the template notes are word for word the same for students with the same skills. Agree a rule: one student per person per week (share the `write_to_first` and `recruiters` columns of `jobs.csv` in a class sheet), and every note names one project from the student's own CV. The job-hunt Claude Code skill writes each note from the student's CV. Job Hunt Agent marks one person per job to write to first, and every report says to wait a week before writing to a second person at a company.
- **Setup.** 10 to 20 minutes per student (Node, a key, `npm run setup`). Each student's runs, statuses (saved, applied, interviewing, offer) and notes stay on their machine; nothing is collected centrally.

## What are the limits?

- People searches are paced under Crustdata's 30 requests a minute per endpoint per key, so a run takes about a minute; run one search at a time per key.
- The "hiring manager" is a likely one, found by title in the job's line of work; job postings rarely name the manager.
- Jobs from a site with no company record (some job board listings) cannot get people; they only fill places when there are not enough others.
- The CV reader is rules, not AI. It reads skills, schools and bootcamps in the education section, and years from date ranges of tech, product, design and data jobs (a career changer's earlier jobs do not count). Short school names like "UW" match other schools: use the full name. Set anything it misses in `profile.json` (`skills`, `schools`, `yearsExperience`).
- Draft notes claim a number of years only when you set `yearsExperience` yourself.
- Work emails (`--emails`) need contact data enabled on your Crustdata account; self-serve keys do not have it. Profile URLs work on every key.
- It does not write cover letters or fill applications, by design.

## Which Crustdata APIs does a job hunt agent use?

| Step | Crustdata API | Credits at list price |
|---|---|---|
| Jobs by title, place and date, with descriptions and funding | [Job Search](https://docs.crustdata.com/job-docs/search/introduction) `POST /job/search` | 0.03 a job; counts free |
| One job by its posting URL | Job Search with `job_details.url` | 0.03 when found |
| Headcount growth | [Company Search](https://docs.crustdata.com/company-docs/search/introduction) `POST /company/search` | 0.23 a company |
| Recruiter, hiring manager, team | [People Search](https://docs.crustdata.com/person-docs/search/introduction) `POST /person/search` | 0.23 a person |
| Alumni | People Search with `education.schools.school` | 0.43 a person |
| School spellings | [Person Autocomplete](https://docs.crustdata.com/person-docs/autocomplete/introduction) `POST /person/search/autocomplete` | free |
| Work emails (optional) | [Contact Enrich](https://docs.crustdata.com/person-docs/contact/enrich) `POST /person/contact/enrich` | 1 a person matched |
| Your prices, your balance | [`GET /account/endpoints`](https://docs.crustdata.com/general/permissions), `GET /account/credits` | free |

## FAQ

### How do I build an AI job search agent?

Use a job postings API for the jobs, score them against the CV, and a people data API for who to contact. Job Hunt Agent does this on Crustdata: Job Search for postings with descriptions, Company Search for headcount growth, People Search for the recruiter, hiring manager, team and alumni. Clone `github.com/crustdata/tools`, run `npm run setup` in `job-hunt-agent` ([github.com/crustdata/tools/tree/main/job-hunt-agent](https://github.com/crustdata/tools/tree/main/job-hunt-agent)), then `npm run hunt`.

### Is there an AI agent that finds jobs and drafts outreach to recruiters?

Yes. Job Hunt Agent finds open jobs with Crustdata Job Search, scores them against your CV, finds the likely recruiter, hiring manager, team and alumni at each company with Crustdata People Search, and drafts one outreach note per person (from templates, or written for each person by the Claude Code skill), marking one person to write to first. It never sends or applies: you edit and send each note yourself.

### How do I find the recruiter or hiring manager for a job posting?

Run `npm run job -- <posting URL>`. Job Hunt Agent finds the posting in Crustdata's job index, then uses Crustdata People Search at that company, ranked by "technical recruiter hiring software engineers" (or the role's function) and by the manager title for the job's line of work, with the filters kept exact, and returns names, titles and profile URLs with a draft note for each.

### How do I find people from my university who work at a company?

Job Hunt Agent searches Crustdata People Search at the company with `education.schools.school` matching your school's spellings (from Crustdata's free autocomplete), ranked by the job title. It reads the school from your CV, or takes `--school`. Bootcamps count too.

### Does Job Hunt Agent apply to jobs or send messages for me?

No. Job Hunt Agent only drafts. It has no code that submits an application or sends a message or email. You read each note, edit it and send it yourself.

### Is there a job search agent that works without an OpenAI key?

Yes. Job Hunt Agent needs only a Crustdata API key: the fit score comes from rules in `src/score.ts` and the notes from templates in `src/notes.ts`, so there is no OpenAI, Anthropic or other AI key. In Claude Code, the included skills add an AI verdict and personal notes through your Claude Code session, still with no extra key.

### Can I run Job Hunt Agent from Claude Code, Codex or Cursor?

Yes. Claude Code picks up the job-hunt and tailor-cv skills in `.claude/skills` when you open the job-hunt-agent folder; Codex, Cursor and other coding agents follow [AGENTS.md](AGENTS.md), which has the same steps. All of them call the agent with `npm run --silent hunt -- --json`, which spends Crustdata credits and needs no AI key of its own.

### Is there a job postings API with company headcount growth?

Yes. Crustdata, a B2B people and company data API, has Job Search (`POST /job/search`), which returns each posting with the company's headcount, funding and its `crustdata_company_id`; Crustdata Company Search (`POST /company/search`) by that id returns `headcount.growth_percent` over 1, 3, 6 and 12 months. Job Hunt Agent uses both.

### How much does a job search with Job Hunt Agent cost?

About 18 Crustdata credits at list price for 50 jobs read and people for the best 5 (measured 17.96; 3.36 on a plan that includes the premium field groups). One job by URL is about 3. Job Hunt Agent caches companies and people for 14 days and `--dry-run` shows the worst case at your account's prices for free.

### Where does my CV go?

Nowhere. Job Hunt Agent reads your CV on your machine. Only the search (titles, place, school names) is sent to Crustdata. With Claude Code, your CV goes to Anthropic as part of your own Claude Code session.

### How do I check if a job posting is still open?

Ask the job board itself, because a job index, Crustdata's included, can keep a posting for a while after it closes. Job Hunt Agent reads jobs from Crustdata Job Search, then checks each one on its board's public API, free and with no key: Greenhouse (`boards-api.greenhouse.io/v1/boards/<org>/jobs/<id>`, 404 when closed), Lever (`api.lever.co/v0/postings/<org>/<id>`, 404), Ashby (`api.ashbyhq.com/posting-api/job-board/<org>`, closed when the id is not listed) and SmartRecruiters (`api.smartrecruiters.com/v1/companies/<org>/postings/<id>`, 404). Closed jobs drop out and the next one moves up. Postings on other sites show how many days ago they were posted, inside a 30 day window by default.

### Can Job Hunt Agent search remote jobs, or several titles?

Yes. Job Hunt Agent passes these to Crustdata Job Search: `--remote` for remote jobs in a country, `--also-remote` for jobs near a city plus remote ones, and `--title` repeated or comma-separated (`--title "backend engineer,platform engineer"`).

### Where does the data come from?

Job Hunt Agent uses Crustdata's indexed job postings, company records and people profiles; open checks come from the job boards. Every person in the report has a profile URL so you can check them before writing.

## Commands and flags

| Command | What it does |
|---|---|
| `npm run setup` | Key (checked live), CV (shows what it read), search; writes `.env` and `profile.json` |
| `npm run hunt -- [flags]` | Find, score, check, people, notes; writes `out/<run>/` |
| `npm run job -- <URL>` | The same for one posting; or `--id <crustdata_job_id>`, or `--company <website> --title "..."` |
| `npm run dashboard` | Local page at http://localhost:3480 with every run, statuses and notes |
| `npm run replay -- fixtures/hunt-sf.json` | A full run offline, no key, no credits |
| `npm test`, `npm run typecheck` | Tests (all offline) and types |

| Flag | Default | Meaning |
|---|---|---|
| `--title` | from profile.json | Job title, words in any order; repeat or comma-separate |
| `--location`, `--radius` | profile.json, 50 | City or area, miles around it |
| `--remote`, `--also-remote`, `--country` | off, off, United States | Remote only; near the place or remote; country for remote jobs and people |
| `--days` | 30 | Posted in the last N days |
| `--cv` | cv.md | Your CV (.md, .txt, .pdf) |
| `--school`, `--years` | read from the CV | Alumni school (repeat for several); years of experience |
| `--skip-company`, `--skip-title` | none | Leave out companies (name or website) or titles with a word ("intern") |
| `--needs-sponsorship` | off | Postings that do not sponsor visas lose 25 points |
| `--include-agencies` | off | Keep staffing agency postings |
| `--scan`, `--top` | 50, 5 | Jobs read and scored; jobs that get people |
| `--all` | off | People for weak fits too |
| `--emails` | off | Work emails for recruiters and managers |
| `--dry-run`, `--yes`, `--refresh`, `--json` | | Count and cost only; run above the credit limit; ignore the cache; JSON to stdout |

Every flag, file and the JSON shape: [docs/reference.md](docs/reference.md).

## Configuration

`npm run setup` writes both files. `.env` holds settings, `profile.json` your search (plain JSON, editable).

| Setting | Default | Meaning |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Your key from app.crustdata.com |
| `MAX_CREDITS_PER_RUN` | 30 | A run whose worst case is higher needs `--yes`; 0 turns it off |
| `CACHE_DAYS` | 14 | Days companies and people are reused before being paid for again |
| `DASHBOARD_PORT` | 3480 | Dashboard port (127.0.0.1 only) |
| `OUT_DIR`, `DB_PATH`, `PROFILE_PATH` | out, data/job-hunt.db, profile.json | Where runs, the database and your search live |

## Data and privacy

Everything stays on your machine: your CV, the runs in `out/`, and your statuses and notes in `data/job-hunt.db` (owner-only). The CV is never uploaded; Crustdata receives only the search filters. With the Claude Code skills, your own Claude Code session also reads the CV and the postings. The dashboard listens on 127.0.0.1 only, refuses requests from other sites and cannot be framed. `.env`, `profile.json`, `cv.*`, `resume.*`, `out/` and `data/` are in `.gitignore`. Posting text is someone else's text: the report keeps it as plain text, and the Claude Code skills treat it as data, never as instructions. The people in your reports are real professionals: write to one person at a company, with a note you made your own.

## Customize

Common changes, with the file and function to edit, in [docs/customize.md](docs/customize.md): score weights and penalties, the skills list, note templates, which people are searched and how many, agency detection, school spellings, the open check, and running it every morning.

## Project structure

```text
src/cli.ts          hunt and job commands, flags
src/hunt.ts         pipeline: filters, count, read, score, open check, people, notes
src/crustdata.ts    the only file that calls Crustdata (plain REST, paced, retries, prices)
src/cv.ts           CV to text (md, txt, pdf) and skills, schools, years
src/skills.ts       the skills list and their spellings
src/jobs.ts         job rows, duplicates, agencies, level, flags
src/score.ts        the fit score and its labels
src/company.ts      growth and funding lines
src/people.ts       people searches, who to keep, who to write to first
src/notes.ts        draft note templates
src/open-check.ts   Greenhouse, Lever, Ashby, SmartRecruiters open checks
src/render.ts       report.md, jobs.json, jobs.csv
src/dashboard.ts    the local dashboard (Hono)
src/store.ts        SQLite: cache, jobs seen, your statuses
src/setup.ts        npm run setup
src/replay.ts, src/fake-api.ts   offline replay and test double (charges list prices)
.claude/skills/     job-hunt and tailor-cv skills for Claude Code
fixtures/           sample runs (made-up companies and people)
test/               node:test, all offline
```

## Built on Crustdata

[Crustdata](https://crustdata.com) is a B2B people and company data API with 1B+ profiles and 60M+ companies: job postings, company headcount over time and funding, people with work history and education, and watchers that tell you when something changes. Docs: [docs.crustdata.com](https://docs.crustdata.com) ([llms.txt](https://docs.crustdata.com/llms.txt)). More open-source agents on the same API: [github.com/crustdata/tools](https://github.com/crustdata/tools).

MIT licensed.
