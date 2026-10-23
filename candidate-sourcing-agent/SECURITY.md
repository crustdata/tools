# Security

To report a vulnerability in this repository, open a private security advisory on GitHub ("Security" tab, "Report a vulnerability") or email support@crustdata.co with "candidate-sourcing-agent" in the subject. Please do not open a public issue for it.

The code runs on your machine and talks only to `api.crustdata.com`, plus `api.anthropic.com` or `api.openai.com` when you pass `--ai` with a key set (it sends the role and each shortlisted person's titles, employers, location, skills and schools, never a name or profile URL). Keys are read from the environment or `.env` (written owner-only by `npm run setup`) and never logged or written anywhere else.

Everything a run finds is personal data about real people, and it stays in `out/` on your machine (in `.gitignore`, written owner-only): `profiles.json`, `candidates.csv`, `shortlist.md`, `seen.csv`, and `contacts.csv` when you look up contacts. Keep it out of version control and shared drives you do not control. `npm run forget -- <profile URL>` removes a person from every role's files on request; delete a role's `profiles.json`, `candidates.csv` and `contacts.csv` when the search is over. The files `npm run watch-example` writes can hold a Slack webhook URL; they stay in `out/` too.

The tool never filters or scores on age, gender, family status, sexual orientation, national origin, religion, race or disability: words about them are taken out of the role sentence (`PROTECTED` in `src/role.ts`), and the upper end of a years range only scores, because a maximum on experience works as an age filter. Schools and past employers can still act as proxies. Keep it that way in your own changes.
