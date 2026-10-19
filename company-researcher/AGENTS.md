# AGENTS.md

Guide for AI coding agents working in this repository. People should start with [README.md](README.md).

## What this is

A company research agent in TypeScript (Next.js App Router). A domain or a company name goes in; a brief comes out with headcount, hiring, leadership, funding, traffic, tech stack, news and three questions to ask. The data comes from three Crustdata endpoints: `/company/identify`, `/company/enrich` and `/job/search`. One core (`lib/research.ts`) serves the web app, the JSON API and the CLI.

## Commands

```bash
npm install
npm test                                   # offline tests on a saved, scrubbed response; no key needed
npm run typecheck                          # tsc --noEmit
npx tsx scripts/research.ts vercel.com     # needs CRUSTDATA_API_KEY
npm run dev                                # web app on port 3217
```

Run `npm test` and `npm run typecheck` after every change. Both must pass.

## Where things are

| To change | Edit |
|---|---|
| A Crustdata request | `lib/crustdata.ts`, the only file that calls Crustdata (retries, credits, the plan-limit retry) |
| How a raw field becomes a section | `lib/shape.ts` (pure; add a test in `test/brief.test.ts`) |
| What the brief says, how changes rank, the questions | `lib/brief.ts` |
| The AI brief | `lib/ai.ts` |
| Caching, the demo budget, the pipeline | `lib/research.ts` |
| Keys from headers, demo policy, rate limits, error responses | `lib/http.ts` |
| The JSON schema | `lib/types.ts` (bump `SCHEMA_VERSION` when a field changes meaning) |
| Markdown output | `lib/markdown.ts` |
| A card on the page | `components/Sections.tsx`; charts in `components/Charts.tsx`; icons in `components/Icons.tsx` |
| The page, the keys box, the nav | `app/page.tsx` |
| A setting | the code, `.env.example` and the Configuration table in `README.md` together |

## Rules for copy (UI strings, README, comments shown to people)

- No em dashes or en dashes. Use a comma, a colon, a full stop or parentheses.
- Never use the words "honestly", "noise" or "stale".
- Never name a social network as the source of the data. Write "profile URL".
- Crustdata figures: 1B+ profiles, 60M+ companies. No prices in dollars except "start free with $20 in credits".

## Facts about the Crustdata API this code relies on

- Base URL `https://api.crustdata.com`; headers `authorization: Bearer <key>` and `x-api-version: 2025-11-01`. Credits used come back in `x-credits-used`.
- `/company/identify` is free and takes `domains` or `names`.
- `/company/enrich` `fields` is a whitelist. A group the key cannot read fails the whole call, naming the group.
- Enrich growth keys are `mom`, `qoq`, `six_months`, `yoy`, `two_years`.
- `/job/search` aggregations with `limit: 0` return no rows and cost nothing; rows cost 0.03 each.
- Region labels in `headcount.by_region_absolute` mix countries, states and metros and overlap.
