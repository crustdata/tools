# Customize

## Change what the brief says

Edit `buildBrief()` in `lib/brief.ts`. Each change is a `Signal` with a `rank` (lower comes first), the sentence for "What changed lately" and, optionally, a question. To add one:

```ts
if (c.followers?.m12 !== null && c.followers!.m12! >= 50) {
  signals.push({ rank: 6, change: `Followers up ${pct(c.followers!.m12)} in 12 months.`,
    question: "Your audience grew by half this year. Which channel drove it?" });
}
```

Add a test in `test/brief.test.ts` against the saved Vercel response, then `npm test`.

## Add a section

1. Add the field group to `ENRICH_GROUPS` in `lib/crustdata.ts` if it is not there.
2. Read it in `shapeCompany()` in `lib/shape.ts` and add the type to `Company` in `lib/types.ts`.
3. Render it: a card in `components/Sections.tsx`, a heading in `lib/markdown.ts`, a line in the nav list in `app/page.tsx`.

## Change the role types for hiring

`ROLE_TYPES` in `lib/shape.ts` maps title patterns to role types. The first pattern that matches wins.

## Change the demo companies

`DEMO_DOMAINS=acme.com,globex.com` in `.env`, and `EXAMPLES` in `app/page.tsx` for the "Try" buttons.

## Use a different AI model

`ANTHROPIC_MODEL` or `OPENAI_MODEL`. Without them the newest model in the key's model list is used.
