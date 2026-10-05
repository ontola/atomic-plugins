# Session plan: Clockify timesheets drive app

The tester connects their own Clockify account. It works best with some time entries from the last week. The app changes something in Clockify only after the tester has reviewed the change and pressed Send; nothing else is written there. The one write in this plan (task 7) happens only in the Clockify test workspace the tester was invited to for this session (Decision Inbox Q-076, Q-078), never in the tester's own workspaces.

## The session

The tester already agreed to the recording before this started; don't ask again. Take roughly 20 to 25 minutes, one task at a time. Only move on when a task is done or the tester gives up.

1. In your first turn, welcome them, ask them to think aloud, tell them a second window opened with their own empty Atomic drive and that we are testing the app, not them. End that same turn with task 2. Keep it to three short sentences.
2. Task: "Bring your Clockify time from the last week into Atomic." If they have no Clockify account or prefer not to connect one, skip to task 9. Remind them never to read their key aloud. Ask them to choose, in the app, the Clockify test workspace they were invited to for this session.
3. Task: "How many hours did you work yesterday, and how many of them were billable?" If yesterday was empty for them, ask about their last working day.
4. Task: "What did you work on for one of your projects this week, and when?"
5. Task: "Start and stop a short timer in Clockify, then make it show up here."
6. Task: "Now look at your whole last month."
7. First ask them to check that the app shows the Clockify test workspace they were invited to for this session. Only if it does: task: "Change the description of one small entry here, and get that change into Clockify." Afterwards ask whether they would trust this with their real timesheet, and why. If it shows one of their own workspaces, or they are not sure, don't ask for any change: skip to task 8.
8. Task: "Stop this app from reading your Clockify, but keep what it already copied."
9. Wrap up: ask what was most confusing, what they liked, and whether they would use this and for what. Then thank them and say they can close the windows.

After the thank-you, end your final message with the exact token [END] on its own. Never write [END] earlier.

## For the moderator only

Before the session, Michiel invites the tester to the Clockify test workspace (Decision Inbox Q-078). The plan doesn't name the workspace; a tester without the invite skips the write in task 7.

What success looks like, never to be said:

- Task 2: they install the Clockify app from Integrations and connect. The integration proxy's consent page asks for their Clockify API key, which they create in Clockify's profile settings. Then they choose a workspace and a 7- or 30-day window, and the Week grid appears. The API key step is the likely stumbling block: note where they look for the key (atomic-plugins#121: the consent page has no help link).
- Task 3: read from the Week grid's day total and the billable split.
- Task 4: the Projects view, or the entry drawer from the grid.
- Task 5: "Sync now". A running timer is only counted ("1 timer is running"), not shown, until it stops.
- Task 6: the settings sheet, switching the window to 30 days.
- Task 7: they open the entry (the grid or the drawer) and edit it. The edit shows at once, but it is held under "Changes to send" until they press "Send 1 to Clockify". Whether they find that list and understand why Clockify still shows the old text is the main question. If Clockify changed the same entry meanwhile, a conflict shows and Clockify's value is kept; that counts too. Ask them to check Clockify afterwards. A changed start or end is rounded down to whole minutes.
- Task 8: Disconnect in settings. The copied rows stay.

Known limits (only new detail about them is a finding):

- Editable: an entry's description, project, billable flag, start and end, and deleting an entry; tags, tasks and custom fields are not. Running timers, breaks, locked entries and entries with custom fields can't be edited. Editing a time range ("Edit a time range…", for example marking an hour as not worked) is also there, but is not a task here: it is a stretch if the tester finds it, and its wording and result are a finding either way.
- Tags, tasks and rates are not copied, and only the tester's own entries are.
- "Sync this table to Clockify" (0.6.0) is for a time entry table the app did not make. It needs a table made by pasting the class address into New Table, so it is not a task for this session. Rows already in that table stay local, and the app can't delete rows there.
- From 0.6.2 a row without a start time is listed as "incomplete" with "Open row" and counted nowhere; a tester only meets this after editing the table by hand.
- After a reload the app can briefly lose its settings.
- Writing back to Clockify has been tested against mock data only; it has never been run against a real Clockify account. Any connect or send failure is a finding.
