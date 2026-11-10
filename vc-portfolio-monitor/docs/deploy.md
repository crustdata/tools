# Deploy VC Portfolio Monitor

VC Portfolio Monitor is a daily command (`npm run check`) and a weekly one (`npm run digest`). Its state
(`data/monitor.sqlite`) must survive between runs: it holds the watcher ids, the leaders, the headcount reference
records, the careers page readings and every event already reported. Pick one of these.

A Google Sheet link as `PORTFOLIO` is the easiest list to keep up to date wherever it runs: partners edit the Sheet
and the next run imports the change (free when nothing changed). Publish only the portfolio tab, as CSV (File > Share >
Publish to web), so nothing else in the file can be read. An unattended import refuses to stop watching more than 10% of the
companies (and more than 2) at once, or to spend more than `MAX_IMPORT_CREDITS`, until a person runs it.

## GitHub Actions (recommended: nothing to host)

1. Copy the monitor into a folder of its own and set it up on your laptop:

   ```bash
   npx degit crustdata/tools/vc-portfolio-monitor my-portfolio-monitor
   cd my-portfolio-monitor
   npm install
   npm run setup        # writes .env, which is never committed
   ```

2. Create an empty **private** repository at https://github.com/new (no README, no .gitignore). Then:

   ```bash
   mkdir -p .github/workflows
   cp examples/github-actions.yml .github/workflows/portfolio-monitor.yml
   git init
   git add .
   git commit -m "Portfolio monitor"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/my-portfolio-monitor.git
   git push -u origin main
   ```

   Using a CSV file instead of a Sheet? Commit it too: `git add -f portfolio.csv`.

3. In the repository on GitHub: **Settings > Secrets and variables > Actions**.
   - **Secrets** tab, **New repository secret**: `CRUSTDATA_API_KEY`, and if you want them `SLACK_WEBHOOK_URL`,
     `SLACK_ROUTES`, `RESEND_API_KEY`, `DIGEST_EMAIL_FROM`, `DIGEST_EMAIL_TO`.
   - **Variables** tab: `PORTFOLIO` (your Sheet link, or `./portfolio.csv`), `FUND_NAME`, and optionally
     `LEADER_REFRESH_DAYS`, `HIRING_CHECK_DAYS`, `MAX_LEADERS_PER_COMPANY`, `MAX_IMPORT_CREDITS`. What
     `npm run setup` wrote lives in `.env`, which is not committed, so set the values here.
4. **Actions > Portfolio monitor > Run workflow** for the first import now (the log shows what it cost; tick "Send the
   digest now" for a first digest). After that it runs every day at 07:00 UTC, looks for new leaders on the 1st of
   the month and sends the digest on Mondays.

Every run starts with `npm run import -- --yes`: it adds new rows from the Sheet (the cost is printed in the log),
stops watching removed rows, and costs nothing when the list did not change. If you already ran `npm run import` on
your laptop, the first run on GitHub finds the two watchers on your Crustdata account and reuses them instead of
creating new ones, and marks their earlier runs as read so nothing old is posted. It pays again for the company
records, leader searches and careers pages, about 4.3 credits a company, because the laptop's state is not in the
repository; copy `data/monitor.sqlite` into the repository first to avoid that.

Each run commits `data/monitor.sqlite` and `digests/` back to the repository. Use a private repository: the state holds
your portfolio, its leaders and every alert.

- **A failed run:** if the key was wrong or the account was out of credits, nothing from that check is saved; fix the
  secret and run the workflow again. If Slack failed, the alerts are kept and posted by the next run. Each step runs
  even when an earlier one failed, so a Slack hiccup never skips Monday's digest.
- **Change the time:** edit the `cron` line (`"0 7 * * *"` is every day at 07:00 UTC). Keep it after 06:00 UTC, when
  the watchers run.

## Cron on a machine that is always on

Run `npm run setup` and `npm run import` once by hand first. Then find the full path of npm (cron does not load your
shell's PATH):

```bash
which npm
crontab -e
```

```text
0 7 * * * cd /home/you/vc-portfolio-monitor && { /usr/local/bin/npm run import -- --yes; /usr/local/bin/npm run check; } >> monitor.log 2>&1
0 8 * * 1 cd /home/you/vc-portfolio-monitor && /usr/local/bin/npm run digest >> monitor.log 2>&1
0 9 1 * * cd /home/you/vc-portfolio-monitor && /usr/local/bin/npm run refresh-leaders -- --yes >> monitor.log 2>&1
```

Use the path `which npm` printed (for example `/opt/homebrew/bin/npm` on a Mac with Homebrew). Drop the
`import -- --yes` part if you would rather approve every new company's cost by hand. A laptop asleep at that time
skips the run; the next check catches up.

## Railway or Fly.io (scheduled container)

The `Dockerfile` runs `import -- --yes`, then `check`, on the 1st of the month `refresh-leaders`, and on Mondays
(UTC) the digest, then exits with the worst exit code of the steps. Schedule it once a
day after 06:00 UTC and mount a volume at `/app/data` for the state. Pass settings as environment variables (a Sheet
link as `PORTFOLIO` means no rebuild when the list changes; a committed `portfolio.csv` is baked into the image).
`RUN_DIGEST=1` sends the digest on every run, `RUN_DIGEST=0` never.

- **Railway:** new service from the repo, Root Directory `vc-portfolio-monitor` (when deploying from crustdata/tools),
  a volume at `/app/data`, **Cron Schedule** `0 7 * * *`.
- **Fly.io:** `fly launch --no-deploy`, `fly volumes create data --size 1`, then
  `fly machine run . --schedule daily --volume data:/app/data` (Fly picks the hour; the digest goes out on the Monday
  run).
- **Render:** Render cron jobs cannot keep a disk between runs, so use GitHub Actions or Railway instead.

## Moving machines

Copy `data/monitor.sqlite` to the new place. The watchers live in your Crustdata account and keep their history, so the
next check reads every run since the last one. Without the state file, `npm run import` on the new machine reuses the
watchers on your account (marking what they caught before as read, so nothing old is posted), and pays again for the
starting point.

## Stopping

`npm run delete-watches` cancels both watchers so nothing more is billed. Your data and past digests stay.
