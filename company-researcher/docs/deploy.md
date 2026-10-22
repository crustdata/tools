# Deploy

## Vercel

1. Import the repository and set the Root Directory to `company-researcher` (the app lives in that folder of `crustdata/tools`).
2. Set `CRUSTDATA_API_KEY`. Leave `ALLOW_OPEN_DEMO` unset to keep the demo to the three example companies, or set `DEMO_DOMAINS`.
3. Set `SITE_URL` to the public origin (for example `https://crustdata.com`) for link previews, the canonical URL and `sitemap.xml`.
4. Deploy. The API routes run on the Node runtime.

The cache, the daily credit cap and the rate limits live in memory, per instance. That is fine for a demo. For a busy public deployment, move them to a shared store such as Upstash Redis (`cached()`, `checkBudget()` and `record()` in `lib/research.ts`, `rateLimit()` in `lib/http.ts`).

## Under a sub path

`BASE_PATH=/tools/company-researcher` serves the app and its API under that path.

## Anything that runs Node 22.13+

```bash
npm install
npm run build
npm start          # port 3217
```

## Keys

The server's `CRUSTDATA_API_KEY` is read on the server only and never sent to the browser. Visitors' keys arrive in request headers and are used for that request only. Do not log request headers in front of this app.
