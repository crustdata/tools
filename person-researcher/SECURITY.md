# Security

To report a vulnerability in this repository, open a private security advisory on GitHub ("Security" tab, "Report a vulnerability") or email support@crustdata.com with "person-researcher" in the subject. Please do not open a public issue for it.

The code runs on your machine and talks only to `api.crustdata.com`. The key is read from the environment or `.env` (written owner-only by `npm run setup`, listed in `.gitignore`) and is never logged or written anywhere else.

Every brief is personal data about a real person. Briefs stay in `out/` on your machine (owner-only files, in `.gitignore`), with the raw API answers in `out/.cache/` (owner-only; deleted at the start of the next run once they are older than `CACHE_HOURS`, 24 by default; nothing deletes them on a timer, so remove the folder when you stop using the tool). Keep them out of version control and shared drives you do not control, and delete them when you no longer need them: `rm -rf out/` for everything, or one person's briefs with `grep -l "jane@acme.com" out/*.json | sed 's/\.json$//' | xargs -I{} rm {}.md {}.json`, then `rm -rf out/.cache/` for their saved answers. Use a brief for the purpose you looked the person up for. People who asked Crustdata to remove their data are never returned. When you research by email, Crustdata may check an address it does not have with a contact data provider inside the same request.

Person Researcher is not a consumer reporting agency, and a brief is not a background check or a consumer report under the US Fair Credit Reporting Act (FCRA). Do not use briefs to decide on someone's employment, credit, insurance or housing. In the EU and UK, have a lawful basis for researching someone.

External text in a brief (names, titles, post text) is escaped, so it cannot add links, HTML, headings or lists to the markdown, and only `http(s)` addresses become links.
