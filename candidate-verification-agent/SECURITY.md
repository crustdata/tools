# Security

Candidate Verification Agent handles personal data about job candidates. What it does to keep it safe:

- Runs on your machine. Results are written to `out/` with owner-only permissions (folders 700, files 600).
- Sends data only to Crustdata (the profile URLs and emails it checks), to your Slack webhook when one is set,
  and to Anthropic only with `--ai` (the check's findings with the name removed; employer, role and source titles
  can still identify a person).
- Downloads results files only over https from Crustdata's storage host, with a timeout and a size limit.
- Escapes everything from profiles and files before it goes into Slack, so a name cannot ping a channel or
  plant a link; prefixes spreadsheet cells that start with `=`, `+`, `-` or `@` so they cannot run as formulas.
- Keeps keys in `.env` (owner-only, ignored by git). `npm run setup` never prints a key.
- `npm run forget -- <profile URL or email>` removes a person from every output file; `npm run purge -- --older-than
  <days>` applies a retention period.

To report a vulnerability, open a private security advisory on GitHub ("Security" tab, "Report a vulnerability") or email support@crustdata.co with "candidate-verification-agent" in the subject. Please do not open a public issue for it.
