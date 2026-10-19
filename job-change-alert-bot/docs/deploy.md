# Deploy the job change alert bot on Railway, Render, Fly.io or a server

The bot is one long-running Node process that receives Crustdata Watcher webhooks, posts to Slack and keeps a small SQLite file. It needs:

- Node 22.13 or newer, or the included `Dockerfile`
- a public HTTPS URL, set as `PUBLIC_URL`
- a persistent disk for `data/`, so the watch ids, your list and the history survive restarts
- the environment variables from `.env.example`: `CRUSTDATA_API_KEY` and `PUBLIC_URL` are required; set `SLACK_WEBHOOK_URL` too, or alerts only appear in the logs
- exactly one running copy

**Run the import on the server**, not on your laptop, so the watch and your list live in the server's database. It is safe to run while the server is running. Each section below shows how. If you already created a watch from a laptop, run `npm run adopt -- <watch id>` on the server (the id is in `npm run status` or the Crustdata dashboard), then import your CSV there to bring back names and owners. Starting `npm run serve` with a new `PUBLIC_URL` points existing watches at it automatically.

## Railway

1. New project, then **Deploy from GitHub repo**, and pick `crustdata/tools` (or your fork). In the service **Settings**, set **Root Directory** to `/job-change-alert-bot`; Railway then detects the `Dockerfile`.
2. **Variables:** add `CRUSTDATA_API_KEY`, `SLACK_WEBHOOK_URL`, and any optional ones.
3. Add a **volume** mounted at `/app/data`.
4. **Settings, Networking, Generate Domain.** Set `PUBLIC_URL` to that domain with `https://`, and redeploy.
5. Open a shell on the service with the [Railway CLI](https://docs.railway.com/guides/cli) (`railway ssh`), copy your CSV onto the volume, and import:

```bash
cat > /app/data/champions.csv     # paste the file's contents, then press Ctrl+D
node --import tsx src/cli.ts import /app/data/champions.csv
node --import tsx src/cli.ts test-webhook
```

## Render

1. **New Web Service** from the repo, runtime **Docker**, one instance. Set **Root Directory** to `job-change-alert-bot`.
2. Add a **disk** mounted at `/app/data` (disks need a paid instance type).
3. Add the environment variables. Set `PUBLIC_URL` to the service URL Render shows.
4. Deploy, then open the **Shell** tab. Copy your CSV onto the disk with `cat > /app/data/champions.csv` (paste the contents, then press Ctrl+D), then run `node --import tsx src/cli.ts import /app/data/champions.csv` and `node --import tsx src/cli.ts test-webhook`.

## Fly.io

```bash
cd job-change-alert-bot      # the bot lives in this folder of crustdata/tools
fly launch --no-deploy
fly volumes create data --size 1
fly secrets set CRUSTDATA_API_KEY=... SLACK_WEBHOOK_URL=... PUBLIC_URL=https://<app>.fly.dev
```

Add the volume to `fly.toml`, and stop Fly from putting the machine to sleep (the digest, Slack retries and catch-up run on timers, so it must stay up):

```toml
[mounts]
source = "data"
destination = "/app/data"

[http_service]
auto_stop_machines = "off"
min_machines_running = 1
```

Then deploy, keep exactly one machine running so the digest fires once, and import:

```bash
fly deploy
fly scale count 1
fly ssh console -C "node --import tsx src/cli.ts import /app/data/champions.csv"
```

Copy the CSV onto the volume first, for example with `fly ssh sftp shell`.

## A plain server

```bash
git clone https://github.com/crustdata/tools && cd tools/job-change-alert-bot
npm ci
npm run setup
npm run import -- champions.csv
npm run serve          # run under systemd, pm2 or Docker so it restarts
```

Put Caddy or nginx in front for HTTPS. The bot finds `.env` and `data/` in its own folder, whatever directory it is started from.
