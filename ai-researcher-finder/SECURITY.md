# Security

To report a vulnerability in this repository, open a private security advisory on GitHub ("Security" tab, "Report a vulnerability") or email support@crustdata.co with "ai-researcher-finder" in the subject. Please do not open a public issue for it.

The code runs on your machine and talks only to `api.crustdata.com`, plus `api.anthropic.com` when you pass `--ai` with a key set. With `--ai` it sends each person's titles, employers, role descriptions, headline, paper titles, research interests, h-index, citations and skills, never their name, profile URL, Google Scholar URL or location. Keys are read from the environment or `.env` (written owner-only by `npm run setup`) and never logged or written anywhere else.

Your files stay on your machine; the lookups go to Crustdata. The seeds you give it, the people it finds and their scores are written only under `out/` (in `.gitignore`, written owner-only): `people.json`, `researchers.csv`, `report.md`, `run.json`, `seeds.json`, `dropped.json`, `ai.json`, `suppressed.json`, and `watch-request.json`, which can hold a Slack webhook URL. There is no server, no telemetry and no shared database. Crustdata receives the searches and lookups themselves: the labs, the role and topic, the Google Scholar and GitHub URLs, the paper titles, the ids of the people found from them, and, with every search, the profile URLs of the people already in that folder, of people dropped as non-research and of people removed with `npm run forget` (so they are not returned or billed again).

Everything a run finds is personal data about real people. Keep `out/` out of version control and shared drives you do not control, and delete a search's folder when you are done with it. For a removal request, `npm run forget -- <profile URL, Google Scholar URL or person id>` deletes the person from every folder and keeps them out of later runs.

The tool never filters or scores on age, gender, family status, sexual orientation, national origin, religion, race or disability. Schools and past employers in your own rubric can act as proxies; keep that in mind when you change `rubric.json`.
