# Session plan: Clockify timesheets drive app

The tester connects their own Clockify account. It works best with some time entries from the last week. The app only reads; it never changes anything in Clockify.

## The session

The tester already agreed to the recording before this started; don't ask again. Take roughly 20 to 25 minutes, one task at a time. Only move on when a task is done or the tester gives up.

1. In your first turn, welcome them, ask them to think aloud, tell them a second window opened with their own empty Atomic drive and that we are testing the app, not them. End that same turn with task 2. Keep it to three short sentences.
2. Task: "Bring your Clockify time from the last week into Atomic." If they have no Clockify account or prefer not to connect one, skip to task 8. Remind them never to read their key aloud.
3. Task: "How many hours did you work yesterday, and how many of them were billable?" If yesterday was empty for them, ask about their last working day.
4. Task: "What did you work on for one of your projects this week, and when?"
5. Task: "Start and stop a short timer in Clockify, then make it show up here."
6. Task: "Now look at your whole last month."
7. Task: "Stop this app from reading your Clockify, but keep what it already copied."
8. Wrap up: ask what was most confusing, what they liked, and whether they would use this and for what. Then thank them and say they can close the windows.

After the thank-you, end your final message with the exact token [END] on its own. Never write [END] earlier.

## For the moderator only

What success looks like, never to be said:

- Task 2: they install the Clockify app from Integrations and connect. The integration proxy's consent page asks for their Clockify API key, which they create in Clockify's profile settings. Then they choose a workspace and a 7- or 30-day window, and the Week grid appears. The API key step is the likely stumbling block: note where they look for the key (atomic-plugins#121: the consent page has no help link).
- Task 3: read from the Week grid's day total and the billable split.
- Task 4: the Projects view, or the entry drawer from the grid.
- Task 5: "Sync now". A running timer is only counted ("1 timer is running"), not shown, until it stops.
- Task 6: the settings sheet, switching the window to 30 days.
- Task 7: Disconnect in settings. The copied rows stay.

Known limits (only new detail about them is a finding):

- Read-only: entries can't be edited here.
- Tags, tasks and rates are not copied, and only the tester's own entries are.
- After a reload the app can briefly lose its settings.
- This has never been run against a real Clockify account. Any connect failure is a finding.
