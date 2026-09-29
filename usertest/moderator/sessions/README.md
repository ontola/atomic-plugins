# Session plans

One file per moderated session. The moderator's system prompt is
`../script.md`, which says how to moderate, followed by the plan the invite
link names:

```
https://plugins.<base-domain>/usertest/?code=<USERTEST_CODE>&session=<plan>
```

Without `session`, a link gets `calendar`, so older links behave as before. A
misspelled name is refused when the session starts, and the page says so.

| Plan | Tests | Tester needs |
| --- | --- | --- |
| `calendar` | Google Calendar drive app | a Google account (optional) |
| `calendar-view` | atomic-server's calendar view on tables | nothing |
| `issue-tracker` | GitHub issues drive app | a GitHub account and a repository where changes are fine |
| `timesheets` | Clockify drive app | a Clockify account with recent entries |
| `notion` | Notion drive app | a Notion account with a database |
| `money` | Bank statements (Money) drive app | an MT940 or camt.053 export they are willing to show on screen |

## Writing a plan

- `## The session`: numbered steps, spoken one at a time. The first turn
  welcomes the tester; the last step is the wrap-up and ends with `[END]`.
  Phrase each task as an outcome ("Close an issue that is done"), never as a
  click path. Give a skip path for testers without the account.
- `## For the moderator only`: what success looks like for each task, and the
  limits already known, with issue numbers. The moderator never reads this
  part out. The analysis (`../analyze.mjs`) gets the plan too, and reports a
  known limit only when the session adds something new about it.
- Invented examples only: plans are public.

The plans come from the laptop sessions of 2026-09-25 onwards (the method is
in `.claude/skills/plugin-user-testing/SKILL.md`). Those sessions used a
local stack with seeded data and the mock proxy. Here testers bring their own
accounts, so the tasks refer to "one of your repositories", not to seeded
names.
