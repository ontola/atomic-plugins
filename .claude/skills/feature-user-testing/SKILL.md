---
name: feature-user-testing
description: Plan, run and follow up a live user-testing session for one Atomic feature: a plugin (notion, calendar, timesheets, issue-tracker, money, or a server plugin) or a part of Atomic itself (the calendar view on tables, say). Use when asked to "user test", "run a test session", or "prepare user testing" for a plugin or Atomic feature.
---

# Feature user-testing session

A moderated, think-aloud session about one feature of Atomic, a plugin or a part of Atomic itself: Michiel uses the real app in a browser, you watch the interaction log and screen, and you turn what happens into filed issues. This is the method used for the calendar session on 2026-09-25.

## Two ways to run a session

- **On the user-testing droplet** (`usertest/`, see its README): a tester opens an invite link on their own laptop, a voice moderator (Claude) gives the tasks, and the analysis files anonymized findings in the private repo `ontola/usertest-findings`. Testers bring their own provider accounts. The tasks come from a plan in `usertest/moderator/sessions/<plan>.md`, which the tester picks in the page's "What do you want to test?" menu; `&session=<plan>` on the invite link preselects it. Every plan in that folder shows up in the menu. To prepare a session for the droplet, write or update that plan (see the README next to the plans) and open a PR.
- **Moderated on a prepared laptop** (the rest of this skill): you watch Michiel use a local stack with seeded data and the mock proxy. Use it to try a new app before strangers do, or to dig into a problem the droplet sessions found.

A plan written for one works for the other with small changes: seeded names become "one of your …".

## 1. Plan first, confirm before building

Read the feature before writing anything. For a plugin: `integrations/<plugin>/` in ontola/atomic-plugins (`app/`, `design/DESIGN.md`, `design/issues.md`, `README.md`), plus the "For users" section of its implementation PR (#144 notion, #145 calendar, #146 timesheets, #147 issue-tracker, #148 money). For a part of Atomic itself: its code and PRs in ontola/atomic-server. Then send Michiel a short plan containing:

- **Goal:** which features, and what "works for a person" means for them.
- **Setup:** the branch or pin, the seed data, and the accounts needed (see step 3).
- **Tasks:** 6–8 per feature. Phrase each one as an outcome to reach ("Move Friday's design review to Thursday afternoon"), never as a click path. Keep the expected result on your side, not in the task text.
- **Timing:** how long setup takes, and when the session can start.

Wait for his OK before building tooling.

## 2. Tooling

Reuse the demo-session tooling on atomic-server branch `claude/demo-session-tooling` (`scripts/demo-session/`; see its README). If it's merged by now, use it from `develop`.

- **Which host branch:** a host feature (like the table calendar) can be tested on `develop`. A drive app needs the pinned host, the branch that holds `.atomic-server-ref` (currently `claude/atomic-plugins-pin`), because `develop` may not have the frame capabilities the app uses.

- `scripts/demo-session/demo-session.sh <branch>` gives an isolated server on :9893, Vite on :6757, a fresh store, no signup, and the dev-only interaction log at `~/.cache/atomic-demo/sessions/latest/ux.jsonl`. Password and secret fields are redacted.
- Add a seed for the feature in `seed.js` (`?demo-seed=<name>`). Build it through the app's own creation code, with invented data only (e.g. "Acme Studio", `example.org` addresses). Put the edge cases the tasks probe into the seed: time zones, DST dates, long text, empty states, many rows, read-only items.
- **Keep seeds spoiler-free:** names and notes hold only what a real user would write. Explanations of an edge case go in code comments. In session 1 a note like "01:30 Wednesday in Amsterdam" answered a task outright.
- **Provider data** for a drive app comes from the shared mock proxy's fixtures (`integrations/localthought/fixtures/<platform>/`), not from `seed.js`. Extend the fixture for richer data, and use its drivers (`POST /fixture/<platform>/…`) to change the remote side mid-session (renames, conflicts, 429/503, revoked access).
- **Mock first:** run the UX session against the mock proxy, which needs no accounts. Verify live afterwards as a short separate run (step 3).
- For a plugin, install its drive app test-side, the way its e2e does, until catalog install covers it. Point the app at the local mock proxy, or at the real proxy when a test account is used.
- Follow the log with Monitor (`tail -f` piped through `jq`) during the session, so you see each action as it happens. Watch `server.log`/`vite.log` in a second monitor, and filter out the iroh/relay warnings, which are noise. Clicks in a table editor carry `cell: {row, column}`.
- Keep the task list with expected results in your scratchpad, and mark task starts in the session folder (`task-marks.log`) so the report can time each task.

## 3. Test accounts: never handle secrets yourself

- Use dedicated test accounts only, never Michiel's personal ones (see `integrations/LIVE_TESTING.md`).
- API-token services (Clockify, Todoist, Moneybird): Michiel puts the token himself in `~/.config/atomic-plugins/<platform>.env`, mode 600. Ask him for the file, never for the token. Never paste or type a token or password into chat, a form, a URL or a commit.
- OAuth services (Google Calendar, Notion, GitHub): Michiel signs in himself through the proxy's consent flow in the browser. If an OAuth client secret has to be entered, he types it.
- If an account doesn't exist yet, list exactly which one is needed and what test data it should hold.

## 4. During the session

- Open the app in the browser pane (the desktop app's built-in browser, not Chrome) and check that Michiel can see it. Before the first task, tell him where the pane's toggle is: closing windows hides it, and you can't unhide it.
- **Phone width:** ask him to drag the divider until the pane is about 400 px wide. Your `resize_window` emulation is reset when your turn ends, so he can't use it.
- A short spoken cue per task (`say "Task three. …"`) plus the task in chat works well with dictation.
- Give one task at a time. Don't help unless he's stuck or asks. When he asks, answer briefly and note it as a finding.
- Write down every hesitation, wrong first click, misread label and workaround, with the log timestamp. Take a screenshot at moments of confusion.
- Small fixes through hot reload mid-session are fine when they unblock the session. Note each one.

## 5. Afterwards: findings to issues

1. **Report:** write a findings report, one entry per finding:
   - what he tried, and what happened;
   - evidence: log lines and screenshots;
   - severity: blocks the task / slows it / cosmetic;
   - likely cause (read the code);
   - which repo it belongs to.
2. **Check for duplicates:** search open issues in ontola/atomic-plugins and ontola/atomic-server first.
3. **File issues** once Michiel has OK'd the list: one labeled issue per finding, or per shared cause, with the evidence, linking the report. atomic-server wants existing labels (`bug`/`enhancement` plus an area like `browser`/`server`). Writes to ontola/atomic-plugins go through its repo-oversight session (atomic-plugins AGENTS.md), so hand those findings to the coordination session instead of filing them.
   - A product question goes to Michiel in plain terms, not into an issue as a decided fix.
4. **Hand off:** send the list of issues to the "Atomic server/plugins coordination" session, which routes them to the workers and tracks them. Don't start fixing things yourself unless Michiel asks.
5. **Screenshots:** they stay in chat, in PR/issue comments, or on a private page. Never in a commit.

## Rules that always apply

- Never `git commit --no-verify`.
- Never merge into atomic-server `develop`.
- Invented data only in seeds, screenshots and recordings.
