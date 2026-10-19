# Security

To report a vulnerability in this repository, open a private security advisory on GitHub ("Security" tab, "Report a vulnerability") or email support@crustdata.com with "prospecting-agent" in the subject. Please do not open a public issue for it.

The code runs on your machine and talks only to `api.crustdata.com` (and `api.anthropic.com` if you set the optional `ANTHROPIC_API_KEY`). The API key is read from the environment and never logged or written to a file. `npm run watch-example` sends nothing; the files it writes can hold a Slack webhook URL, so they stay in `out/`, which is in `.gitignore`.
