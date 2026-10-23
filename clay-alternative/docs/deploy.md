# Deploy

Nobody hosts this for you: it is a repo you run. Every option below needs one setting, `CRUSTDATA_API_KEY`, and serves the page, the JSON API and nothing else. There is no database.

## Vercel (the button)

The README's "Deploy with Vercel" button clones this folder into your own GitHub account and deploys it. It asks for `CRUSTDATA_API_KEY` and nothing else. Importing by hand instead:

1. Import `crustdata/tools` and set **Root Directory** to `clay-alternative`.
2. Set `CRUSTDATA_API_KEY`. Optionally `SITE_URL` (link previews) and the settings below.
3. Deploy. The API routes run on the Node runtime; `/api/enrich` is allowed 300 seconds, which covers about 500 rows at Crustdata's rate limits. Bigger files are cut to `MAX_ROWS_PER_RUN` and pointed at the CLI.

## A team deployment

The URL runs on your key for whoever can open it. On Vercel, turn on Deployment Protection (project Settings, Deployment Protection: Vercel Authentication for your team's accounts, or Password Protection) so only your team gets in; on other hosts put the app behind your SSO or a basic-auth proxy. Commercial use on Vercel needs a Pro plan, and the 300-second limit on `/api/enrich` relies on Fluid compute (on by default for new projects).

The caps below are per server process and in memory. On a serverless host every instance starts from zero, so `DAILY_CREDIT_CAP` and the per-address limit are advisory there; `MAX_CREDITS_PER_RUN`, `MAX_ROWS_PER_RUN` and `ALLOW_SERVER_KEY=false` hold everywhere because they apply to each request on its own. The address for the per-address limit is the last hop of `x-forwarded-for`, the one your platform's proxy appends.

Everyone using the deployment key shares one in-memory result cache for `CACHE_TTL_HOURS` (default 24; `0` turns it off), so one colleague's lookups answer another's at no cost. A visitor who pastes their own key gets their own cache.

## A copy exposed to strangers

By default the page runs on the deployment's key and shows credit numbers. For a public copy, set:

| Setting | What it does |
|---|---|
| `SHOW_CREDITS=false` | The estimate line and the cost bar show rows and companies only, until a visitor pastes their own key. |
| `DAILY_CREDIT_CAP=300` | The deployment's key spends at most this many credits per UTC day (per server process, see above; a visitor's own key is not capped). |
| `MAX_ROWS_PER_RUN=200` | The most rows one run may enrich on the page. |
| `MAX_CREDITS_PER_RUN=100` | A run stops before its next call once it has spent this much. |
| `ALLOW_SERVER_KEY=false` | Visitors must paste their own key; the deployment's key is only used for the free checks. |

Runs on the deployment's key are also limited to 30 per visitor address per 10 minutes (advisory on serverless hosts, as above).

## Railway, Render, Fly.io

Create a service from the repo with the root directory `clay-alternative`, build command `npm ci && npm run build`, start command `npm start` (port 3218, or set `PORT` and change the `start` script). Set `CRUSTDATA_API_KEY`.

## Plain Node 22.13+

```bash
git clone https://github.com/crustdata/tools
cd tools/clay-alternative
npm ci
cp .env.example .env     # set CRUSTDATA_API_KEY
npm run build
npm start                # http://localhost:3218
```

## Under a sub path

`BASE_PATH=/tools/clay-alternative` serves the page and its API under that path.

## Keys

The deployment's `CRUSTDATA_API_KEY` is read on the server only and never sent to the browser. A visitor's key arrives in the `x-crustdata-key` header, is used for that request only, and is never logged. Do not log request headers in front of this app.
