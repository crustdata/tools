# Customize VC Portfolio Monitor

Run `npm test` and `npm run typecheck` after any change.

## Thresholds

[config/thresholds.json](../config/thresholds.json), read on every run:

| Key | Default | Meaning |
|---|---|---|
| `headcount_down` | `{ "percent": 10, "people": 3, "or_people": 25 }` | Alert when headcount falls by both from its highest reading in the window, or by `or_people` whatever the percentage |
| `small_company` | `{ "below": 15, "percent": 25, "people": 2 }` | The drop rule for companies under `below` people |
| `team_down` | `{ "percent": 20, "people": 3, "min_team": 5 }` | Alert when one department falls by both, from a team of at least `min_team` |
| `headcount_up` | `{ "percent": 25, "people": 5 }` | Good news when headcount grows by both |
| `hiring_stopped` | `{ "from_at_least": 3 }` | Alert when two readings in a row show no roles after one with at least this many |
| `hiring_jump` | `{ "times": 2, "more_roles": 5 }` | Good news when roles multiply by `times` and grow by `more_roles` against about 4 weeks before |
| `hiring_slowed` | `{ "percent": 50, "fewer_roles": 5 }` | Note when roles fall by both against about 4 weeks before |
| `hiring_started` | `{ "quiet_weeks": 4, "to_at_least": 3 }` | Good news when roles reach `to_at_least` after `quiet_weeks` with none |
| `reference_days` | `180` | Headcount is compared with its highest and lowest reading in this many days, since the last headcount alert; department counts with a reference record kept this long |
| `repeat_after_days` | `28` | A hiring jump, slowdown or restart is not repeated for the same company within this many days |

## Which events are alerts

Each rule in [src/signals.ts](../src/signals.ts) sets a `severity`: `alert`, `good`, `note` (all posted to Slack after
each check) or `news` (weekly digest only). To keep, say, leader title changes out of Slack, change `"note"` to
`"news"` in `leaderSignal`. The "why it matters" sentences are in `WHY` at the top of the same file.

## Who counts as a leader

`leaderRole` in [src/leaders.ts](../src/leaders.ts): the founder, CEO, C-level and president patterns, and
`NOT_A_LEADER` for titles to drop. To watch VPs, a Head of Finance or a General Counsel too, add the words (`"VP"`,
`"vice president"`, `"head of finance"`, `"general counsel"`) to `LEADER_TITLE_WORDS` in `src/crustdata.ts`, return a
role for them in `leaderRole` (for example `c_level`), and raise `MAX_LEADERS_PER_COMPANY`. Then run
`npm run refresh-leaders`: it posts a "New leader" note for each person it adds, so expect one per VP the first time.
Each watched person costs only when their profile changes: 5 credits at the default 30-day freshness (more at a
fresher `LEADER_REFRESH_DAYS`).

For one company, list the right people by profile URL in the portfolio's `leaders` column instead: that list replaces
the search.

## News words

`BAD`, `DOWN`, `LEGAL` and `MONEY` in `src/signals.ts` decide which headlines are alerts, notes or good news. The
company must be named before the matching words, and the first kind of word after its name wins (a down round always
counts as a warning). Add words your sector uses ("recall", "FDA warning").

## One copy per portfolio

Run one copy of the monitor per portfolio and Crustdata key. Two copies with different lists on one account will each
create their own watchers (they never reuse a watcher whose list differs); two copies sharing one state file will
update the same watchers to their own lists in turn.

## Send alerts somewhere else

Everything goes through [src/deliver.ts](../src/deliver.ts). `sendAlerts` reads `store.unposted()` (a list of `Signal`
objects with `company`, `kind`, `severity`, `text`, `why`, `url`) and marks them posted after the channel accepts them.
To post to Microsoft Teams, a CRM or your own webhook, write a function that takes those signals and call it next to
`sendMessages`. For the weekly digest, `runDigest` in `src/run.ts` returns a `Digest` object (companies with their
signals, quiet companies, credits): send it anywhere, or hand it to a model for a written summary.

## Add a signal

1. Add the kind to `SignalKind` in `src/types.ts`, and a `WHY` line in `src/signals.ts`.
2. If it needs a new field from Crustdata, add the field to `COMPANY_TRACK` (and its group to `COMPANY_FIELDS` when the
   rule reads the record) in `src/crustdata.ts`. For an `added` track on a list, give it `keys` so a re-listed item is
   not billed again (check live that the field accepts them: `funding.acquisitions` does not). A watch's track and
   fields are fixed once created: run `npm run delete-watches`, then `npm run import`.
3. Write the rule in `src/signals.ts` as a pure function and call it from `companySignals` in `src/run.ts` inside its
   own `rule(...)` call, so an error in it never loses the other rules' signals. A rule about a person goes in
   `leaderEvent` (`src/leaders.ts`) and `leaderSignal`, called from `personSignals`.
4. Give every signal a key that names the company's domain and what makes this event distinct (an article URL, a
   date, a person and the day). Same key, same event: it is stored and posted once. Two companies must never share a
   key, and two different events must never get the same one.
5. Add a test in `test/signals.test.ts`. If you add a case to `fixtures/busy-week.json`, update the exact list of
   signals that `test/run.test.ts` expects from it.
