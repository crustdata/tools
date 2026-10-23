# Deploy Competitor Tracker

Competitor Tracker is one command run once a week: `npm run digest`. It needs its state (`data/tracker.sqlite`) to
survive between runs, because that is where last week's pages and the watcher ids live. Pick one of these.

## GitHub Actions (recommended: nothing to host)

1. Copy the tracker into a folder of its own and set it up on your laptop:

   ```bash
   npx degit crustdata/tools/competitor-tracker my-competitor-tracker
   cd my-competitor-tracker
   npm install
   npm run setup        # writes competitors.json (and .env, which is never committed)
   ```

2. Create an empty **private** repository at https://github.com/new (no README, no .gitignore). Then:

   ```bash
   mkdir -p .github/workflows
   cp examples/github-actions-weekly.yml .github/workflows/weekly-digest.yml
   git init
   git add .
   git commit -m "Competitor tracker"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/my-competitor-tracker.git
   git push -u origin main
   ```

3. In the repository on GitHub: **Settings > Secrets and variables > Actions**.
   - **Secrets** tab, **New repository secret**: `CRUSTDATA_API_KEY`, and if you want them `SLACK_WEBHOOK_URL`,
     `RESEND_API_KEY`, `DIGEST_EMAIL_FROM`, `DIGEST_EMAIL_TO`.
   - **Variables** tab (optional): `PAGES_PER_COMPETITOR`, `MAX_POSTS_PER_WEEK`, `MAX_JOBS_PER_WEEK`,
     `SHOW_POSTER_NAMES`. Settings you chose in `npm run setup` live in `.env`, which is not committed, so set them here.
4. **Actions > Weekly competitor digest > Run workflow** for the first digest now. After that it runs every Monday at
   08:00 UTC.

Every run starts with `npm run init -- --yes`, which sets up only what is missing (the starting point and the three
watchers on the first run, a competitor you added, a watcher deleted in your Crustdata account) and costs nothing
when everything is in place. If you already ran `npm run init` on your laptop, the first run on GitHub finds those
watchers on your Crustdata account and reuses them instead of creating new ones.

Each run then commits `data/tracker.sqlite`, `digests/` and `competitors.json` back to the repository, so the
repository history is also the history of every digest. Use a private repository: the state includes your competitor
list and the digests.

- **Add or remove a competitor:** edit `competitors.json` on GitHub (or run `npm run add -- acme.com` locally and push).
  The next run sets it up. To remove one, delete it from the file; the next run updates the watchers.
- **A failed run:** if the key was wrong or the account was out of credits, nothing is saved; fix the secret and run
  the workflow again. If Slack or email failed, the digest is saved and the next run sends it again first.
- **Change the day or time:** edit the `cron` line (`"0 8 * * 1"` is Mondays at 08:00 UTC).

## Cron on a machine that is always on

Run `npm run setup` and `npm run init` once by hand first. Then find the full path of npm (cron does not load your
shell's PATH):

```bash
which npm
crontab -e
```

```text
0 8 * * 1 cd /home/you/competitor-tracker && /usr/local/bin/npm run digest >> digest.log 2>&1
```

Use the path `which npm` printed (for example `/opt/homebrew/bin/npm` on a Mac with Homebrew). A laptop that is
asleep at that time skips the run; the next run covers both weeks.

## Railway or Fly.io (scheduled container)

The `Dockerfile` runs `init` (only what is missing) and then one digest, and exits. If `init` fails (a wrong key, no
credits), the digest does not run. Commit the `competitors.json` that `npm run setup` wrote: the first run copies it
to the volume at `/app/data`, where the state and past digests live from then on (edit that copy, or delete it to
copy again). Pass settings as environment variables.

- **Railway:** new service from the repo, Root Directory `competitor-tracker` (when deploying from crustdata/tools),
  add a volume at `/app/data`, set **Cron Schedule** to `0 8 * * 1`.
- **Fly.io:** `fly launch --no-deploy`, `fly volumes create data --size 1`, then
  `fly machine run . --schedule weekly --volume data:/app/data`.
- **Render:** Render cron jobs cannot keep a disk between runs, so use GitHub Actions or Railway instead.

## Moving machines

Copy `data/tracker.sqlite` and `competitors.json` to the new place. The watchers live in your Crustdata account and
keep their history, so the next digest picks up every run since the last one. Without the state file, `npm run init`
on the new machine finds the watchers on your account and reuses them; the pages get a new starting point.

## Stopping

`npm run delete-watches` cancels the three watchers so nothing more is billed. Your snapshots and past digests stay.
