# Session plans

One file per moderated session, each testing one feature of Atomic: a drive
app, or a part of Atomic itself. The moderator's system prompt is
`../script.md`, which says how to moderate, followed by the plan the tester
picked in the page's "What do you want to test?" menu. The invite link's
`session` preselects one:

```
https://plugins.<base-domain>/usertest/?code=<USERTEST_CODE>&session=<plan>
```

Without `session`, the menu starts on `calendar`, so older links behave as
before. A misspelled name is refused when the session starts, and the page
says so. Every `.md` file here except this README is a plan and shows up in
the menu, titled by its first `# ` heading without the `Session plan: `
prefix; the moderator refuses to start when a plan has none.

| Plan                   | Tests                                                        | Tester needs                                                                                |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `calendar`             | Google Calendar drive app                                    | a Google account (optional)                                                                 |
| `calendar-view`        | atomic-server's calendar view on tables                      | nothing                                                                                     |
| `issue-tracker`        | GitHub issues drive app                                      | a GitHub account and a repository where changes are fine                                    |
| `issue-tracker-seeded` | GitHub issues drive app, team tasks in a prepared repository | a GitHub account with write access to a test repository prepared before the session (below) |
| `timesheets`           | Clockify drive app                                           | a Clockify account with recent entries                                                      |
| `notion`               | Notion drive app                                             | a Notion account with a database                                                            |
| `money`                | Bank statements (Money) drive app, installed from Drive apps | nothing: sample statements on the session page (their own export is optional)               |
| `calendar-sample`      | Google Calendar drive app, on sample data                    | nothing                                                                                     |
| `issue-tracker-sample` | GitHub issues drive app, on sample data                      | nothing                                                                                     |
| `timesheets-sample`    | Clockify drive app, on sample data                           | nothing                                                                                     |
| `notion-sample`        | Notion drive app, on sample data                             | nothing                                                                                     |

## Sample data (no account needed)

The `-sample` plans, and `money` by default, need no provider account
(#196). Testers install the app's "(sample data)" entry from the test
catalog: the same app, with its provider answered by invented data in the
app's frame (`../../sample-data/`), already connected. So these sessions
test the app's own screens, not signing in to the provider; that needs the
plan without `-sample` and a real account. Each `-sample` plan says so in
"For the moderator only", so the analysis doesn't report "couldn't connect"
or "not my data" as findings. Use them when the tester has no account, or
when we have no test account to lend.

A plan whose tester downloads files has a line starting with
`Sample files`, naming them in backticks as `<app>/<file>` paths. The
moderator lists them with the plan (`GET /plans`), and the session page
links them from `https://catalog.<base-domain>/samples/<app>/<file>`, where
`../../catalog.mjs` puts them. The moderator can't speak a URL; the plan
tells it to say "on the session page, under Sample files".

## Not covered by a task: syncing a table the app did not make

Calendar 0.3.0, GitHub issues 0.3.0 and Clockify 0.6.0 offer "Sync this
table to Google Calendar / GitHub / Clockify" on a table of the shared class
(event, issue, time entry) that the app did not create. Reaching it means
making that table by hand, with New Table and the class address pasted in,
then Add view. That is not something a non-technical tester finds, so no
plan has a task for it; each plan's "For the moderator only" says what it
does, for a tester who already has such a table or asks. A plan that tests
it needs a prepared drive with the table already made and a written
invitation, which does not exist yet (question for Michiel, in the PR).

## Todoist

The Todoist drive app (`integrations/issue-tracker/todoist-app/`, 0.1.1)
has no plan: it is not in `../../catalog.mjs`, so the test catalog cannot
install it, it imports active tasks only (read-only, nothing to send), and
its synthetic fixture has five tasks. A plan would need a `-sample` entry
(`../../sample-data/todoist.mjs`, a `SAMPLES` and `VERSIONS` entry, a
sample-data test) and a deploy.

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

- First line `# Session plan: <title>`. The title is what testers see in the
  menu, in English, so name the feature the way a tester would.
- `## The session`: numbered steps, spoken one at a time. The first turn
  welcomes the tester; the last step is the wrap-up and ends with `[END]`.
  Phrase each task as an outcome ("Close an issue that is done"), never as a
  click path. Give a skip path for testers without the account.
- `## For the moderator only`: what success looks like for each task, and the
  limits already known, with issue numbers. The moderator never reads this
  part out. The analysis (`../analyze.mjs`) gets the plan too, and reports a
  known limit only when the session adds something new about it.
- Invented examples only: plans are public.
- On sample data, say so in "For the moderator only": what the tester will
  see, and which "failures" (no sign-in, not their data) are expected.

The plans come from the laptop sessions of 2026-09-25 onwards (the method is
in `.claude/skills/feature-user-testing/SKILL.md`). Those sessions used a
local stack with seeded data and the mock proxy. Here testers bring their own
accounts, so the tasks refer to "one of your repositories", not to seeded
names, except in the sample-data plans above.
