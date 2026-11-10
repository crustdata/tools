# Job Hunt Agent reference: commands, flags, settings and the JSON shape

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Asks for the key (hidden, checked with free calls), the CV (shows what it read) and the search; writes `.env` (owner only) and `profile.json`; shows how many jobs match (free) |
| `npm run hunt -- [flags]` | The full run; writes `out/<date>-<search>/` |
| `npm run job -- <URL>` | One posting (`--id <crustdata_job_id>` also works), or `--company <website> --title "<title>"`; `--dry-run` prints the cost only |
| `npm run dashboard` | http://localhost:3480 (127.0.0.1 only) |
| `npm run replay -- <fixture> [--keep] [flags]` | A run against saved answers: no key, no network, files in a temp folder |
| `npm test`, `npm run typecheck` | Offline tests, types |

Exit codes: 0 done (or a dry run), 1 stopped (a plain message says why).

## Flags (hunt and job)

| Flag | profile.json key | Default | Meaning |
|---|---|---|---|
| `--title <t>` | `titles` | (required for hunt) | Repeat or comma-separate. Words match in any order |
| `--location <place>` | `location` | (required unless remote only) | Geocoded by Crustdata |
| `--radius <miles>` | `radiusMiles` | 50 | 1 to 300 |
| `--remote` / `--also-remote` | `remote` | `"no"` | `"only"` / `"also"` |
| `--country <name>` | `country` | United States | For remote jobs and for people |
| `--days <n>` | `days` | 30 | 1 to 90 |
| `--cv <file>` | `cv` | cv.md | .md, .txt or .pdf; a path on the command line is relative to where you ran npm |
| `--school <name>` | `schools` | read from the CV | Repeat for several (names contain commas); in profile.json a list |
| `--years <n>` | `yearsExperience` | read from the CV | |
| (none) | `skills` | [] | Skills you have that the CV does not spell out |
| `--skip-company <c>` | `skipCompanies` | [] | Name or website |
| `--skip-title <word>` | `skipTitleWords` | [] | Whole word in the title |
| `--needs-sponsorship` | `needsSponsorship` | false | |
| `--include-agencies` | `includeAgencies` | false | |
| `--scan <n>` | `scan` | 50 | 1 to 500 jobs read (0.03 each); whole numbers |
| `--top <n>` | `top` | 5 | 1 to 50 jobs that get people |
| `--all` | | off | People for jobs under 50 too |
| `--emails` | | off | Work emails for recruiters and managers |
| `--dry-run` | | | Count and worst-case cost; spends nothing |
| `--yes` | | | Run when the worst case is above `MAX_CREDITS_PER_RUN` |
| `--refresh` | | | Ignore cached companies and people |
| `--json` | | | JSON to stdout (use `npm run --silent`), progress to stderr |

## Settings (.env)

| Name | Default | Meaning |
|---|---|---|
| `CRUSTDATA_API_KEY` | | Required for hunt, job, setup |
| `MAX_CREDITS_PER_RUN` | 30 | 0 turns the check off |
| `CACHE_DAYS` | 14 | 0 turns the cache off (`--refresh` for one run) |
| `DASHBOARD_PORT` | 3480 | |
| `OUT_DIR` | out | |
| `DB_PATH` | data/job-hunt.db | `:memory:` keeps nothing |
| `PROFILE_PATH` | profile.json | |

Variables set in your shell win over `.env`.

## Files a run writes

```text
out/<run id>/
  report.md          all jobs, best first, with people and notes
  jobs.json          the run (shape below)
  jobs.csv           one row per job
  jobs/01-<company>-<title>.md   one job with its full posting
  ai/<job id>.md     written by the Claude Code skill, shown in the dashboard
  cv/<job id>.md     written by the tailor-cv skill
data/job-hunt.db     cache, jobs seen, your statuses and notes
```

## jobs.json

```ts
{
  id: string; createdAt: string; kind: "hunt" | "job";
  search: { titles: string[]; location: string; radiusMiles: number;
            remote: "no" | "also" | "only"; country: string; days: number };
  me: { skills: string[]; schools: string[]; schoolSpellings: string[];
        years: number | null; needsSponsorship: boolean };
  counts: { matching: number; scanned: number; unique: number;
            skipped: Record<string, number>; closed: number; checked: number };
  jobs: Array<{
    job: {
      id: string; aliases?: string[];            // every listing id folded into this role
      title: string; url: string | null; source: string | null; category: string | null;
      workplace: string | null; employmentType: string | null;
      location: string | null; city: string | null; state: string | null; country: string | null;
      postedAt: string | null; description: string; alsoListed: number;
      company: { id: number | null; name: string; domain: string | null; industries: string[];
                 headcount: number | null; lastRound: string | null; lastRoundDate: string | null;
                 totalRaisedUsd: number | null };
    };
    fit: { score: number; label: "Strong fit" | "Possible fit" | "Stretch" | "Weak fit";
           parts: { skills: number; title: number; place: number; company: number;
                    freshness: number; penalties: number };
           matched: string[]; missing: string[]; reasons: string[]; flags: string[] };
    momentum: { headcount: number | null; growth3m: number | null; growth6m: number | null;
                growth12m: number | null; trend: "growing" | "flat" | "shrinking" | "unknown";
                lastRound: string | null; lastRoundDate: string | null;
                lastRoundUsd: number | null; totalRaisedUsd: number | null };
    open: "open" | "closed" | "not checked";
    daysAgo: number | null;
    isNew: boolean;
    people: Array<{ kind: "recruiter" | "manager" | "team" | "alumni"; name: string; title: string;
                    location: string | null; profileUrl: string | null; since: string | null;
                    school: string | null; schoolYear: number | null; email: string | null;
                    first?: boolean;              // the one person to write to first
                    note: string }>;
  }>;
  closed: Array<{ title: string; company: string; url: string | null }>;
  credits: number;      // charged to your account (x-credits-used)
  estimate: number;     // the worst case allowed, at your account's prices
  listCredits: number;  // the same rows at list price
  notes: string[];
}
```

With `--json`, the printed object also has `dir`, the run folder.
