# Security

To report a vulnerability in this repository, open a private security advisory on GitHub ("Security" tab, "Report a vulnerability") or email support@crustdata.com with "private-company-research-agent" in the subject. Please do not open a public issue for it.

The code runs on your machine and talks only to `api.crustdata.com` (and, only with `--ai`, to the AI provider whose key you set). The keys are read from the environment or `.env` (written owner-only by `npm run setup`, listed in `.gitignore`) and are never logged or written anywhere else.

Memos name real people: a company's founders, executives and former staff, with their past employers and profile links, as Crustdata returns them. Memos, comparisons and the raw API answers in `out/.cache/` stay in `out/` on your machine (in `.gitignore`), written owner-only; saved answers are deleted at the start of a run once they are older than `CACHE_DAYS` (7 by default). `PEOPLE_DETAIL=leaders` keeps the names of former staff who are not leaders out of memos. Keep them out of version control and shared drives you do not control, use them for the investment decision you made them for, and delete them when you no longer need them: `rm -rf out/`. People who asked Crustdata to remove their data are never returned.

A memo is not a background check or a consumer report under the US Fair Credit Reporting Act (FCRA). Do not use it to decide on a person's employment, credit, insurance or housing.

External text in a memo (names, titles, headlines) is escaped, so it cannot add links, HTML, headings or lists to the markdown, and only `http(s)` addresses become links. CSV cells that start like a spreadsheet formula are prefixed with `'`. With `--ai`, the memo JSON is sent to your AI provider without profile links and with former staff who are not leaders reduced to their role (founders', executives' and departed leaders' names, news headlines and job titles are sent); the instructions tell the model to ignore instructions inside the data, and the note is shown as AI-written next to the facts it came from.
