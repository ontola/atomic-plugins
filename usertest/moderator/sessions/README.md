# Session plans

One file per moderated session. The moderator's system prompt is
`../script.md`, which says how to moderate, followed by the plan the invite
link names:

```
https://plugins.<base-domain>/usertest/?code=<USERTEST_CODE>&session=<plan>
```

Without `session`, a link gets `calendar`, so older links behave as before. A
misspelled name is refused when the session starts, and the page says so.

| Plan                   | Tests                                                        | Tester needs                                                                                |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `calendar`             | Google Calendar drive app                                    | a Google account (optional)                                                                 |
| `calendar-view`        | atomic-server's calendar view on tables                      | nothing                                                                                     |
| `issue-tracker`        | GitHub issues drive app                                      | a GitHub account and a repository where changes are fine                                    |
| `issue-tracker-seeded` | GitHub issues drive app, team tasks in a prepared repository | a GitHub account with write access to a test repository prepared before the session (below) |
| `timesheets`           | Clockify drive app                                           | a Clockify account with recent entries                                                      |
| `notion`               | Notion drive app                                             | a Notion account with a database                                                            |
| `money`                | Bank statements (Money) drive app                            | an MT940 or camt.053 export they are willing to show on screen                              |

## Preparing `issue-tracker-seeded`

The tasks refer to the synthetic `acme-studio/website` issues
(`integrations/issue-tracker/fixtures/github-issues/user-testing.mjs`: the
contact-form bug, the footer links to the old blog). Before the session, put them
into an empty, disposable repository with a dedicated GitHub test account
(never a personal one), and give the tester's own GitHub account write access
to it, for example as a collaborator:

```sh
GH_CONFIG_DIR=~/.config/gh-atomic-test node integrations/issue-tracker/fixtures/github-issues/seed-live-repo.mjs --repo <owner>/<name> --yes
```

Tell the tester the repository's name in the invitation, not during the
session. They sign in to GitHub on GitHub's own page, with their own account;
never share the test account's credentials with them. Not verified yet: no
repository has been seeded with this script, and whether the app's
repository picker lists a repository the tester is only a collaborator on
has not been checked against live GitHub.

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
