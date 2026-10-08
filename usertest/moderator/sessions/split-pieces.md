# Session plan: Hours table with Clockify and Toggl Track (prototype)

No account is needed: this tests a prototype of Atomic's own tables, not a drive app. It is the split-pieces exploration of ontola/atomic-server#2069, in which what a table offers is divided between the **+** next to the view tabs and a **Connect** button beside them. The Clockify and Toggl Track in this build are stand-ins inside the browser: nothing reaches either service, there is no sign-in, and every table holds invented data. The question of this session is whether that division makes sense to people who have not had it explained. So never explain it, never use the words "view", "integration" or "lens" before the tester does, and write down the words they use instead.

## The session

The tester already agreed to the recording before this started; don't ask again. Take roughly 25 to 30 minutes, one task at a time. Only move on when a task is done or the tester gives up.

1. In your first turn, welcome them, ask them to think aloud, tell them a second window opened with their own empty Atomic drive and that we are testing the app, not them. End that same turn with task 2. Keep it to three short sentences.
2. [ENTRY PLACEHOLDER, fill in once candidate20 is on the droplet: how the tester gets from the empty drive to the demo page and the three tables, as one or two spoken sentences without a URL. Keep the demo page open in its own tab; the session needs it again in task 8.] Then task: "Open the table called Hours and tell me what you see."
3. Task: "Find out what you can add to the Hours table, and tell me in your own words what each of those would do." When they have looked around, ask: "What would you call these things?" Then: "Now do the same for the two other tables, Clockify mirror and Groceries. What is different about them?"
4. Task: "How many of the hours in the Hours table are billable?"
5. Task: "The entries in Hours should also end up in Clockify. Set that up." If they ask whether they need a Clockify account, say that for this session they don't, and nothing more.
6. Task: "Has everything in Hours reached Clockify? Tell me what has, what hasn't, and why." Let them read and talk before asking anything. Then task: "Get as much of it into Clockify as you can." Stop after about five minutes if they are not getting anywhere, and move on without explaining.
7. Task: "The same hours should also go to Toggl Track. Set that up." Give them about three minutes. If they are stuck by then and ask, say that the review it mentions is done on the page where they started, and note that you gave this hint.
8. Once Toggl Track is set up: task: "Hours now goes to both Clockify and Toggl Track. Check both, and tell me whether anything differs between them."
9. Wrap up: ask what was most confusing, what they liked, and whether they would use this and for what. Then ask: "If a colleague asked you what the difference is between the things under the plus and the things under Connect, what would you tell them?" Then thank them and say they can close the windows.

After the thank-you, end your final message with the exact token [END] on its own. Never write [END] earlier.

## For the moderator only

This plan needs the droplet to run a build with ontola/atomic-server#2069 in it (candidate20, not yet deployed). Everything in it was read from that PR's code and its screenshots page on 2026-10-08, not seen running on the droplet; "to confirm once the build is deployed" marks what only the deployed build can settle.

### What is real and what is a stand-in

Real, in the sense that the build does it:

- The **+** menu next to the view tabs, which lists the built-in view kinds (Default, Kanban, Calendar and the rest, on every table as today) plus Timesheet on Hours only; and the **Connect** button beside the tabs, with the header "Sync this table with", shown only on Hours and Clockify mirror. Groceries has no Connect button at all.
- Which tables offer what. Hours: + offers Timesheet; Connect offers Clockify ("via lens", helper "Through Time entry ↔ Clockify time entry") and Toggl Track, disabled with "needs review" and "Waiting for review of Time entry ↔ Toggl time entry" until task 7. Clockify mirror: + offers no Timesheet; Connect offers Clockify natively and Toggl Track "via 2 lenses". Groceries: neither.
- The Timesheet tab: the table's entries grouped by day, with hours per day, "Total" and "Billable" totals, and "running" for the entry without an end. It updates when the table changes.
- The Clockify and Toggl Track tabs (a sync-arrows icon on the tab) and what they show: cards Account, Last sync, In sync and Outbox; a line "This table is not Clockify-shaped. Rows are translated through Time entry ↔ Clockify time entry."; and a table of rows with a state each (held, pending, failed, conflict), "Sent to Clockify as" with the translated fields, and buttons Approve, Retry, Discard, "Keep this table's" and "Take Clockify's". Sync now, "Approve all held" and Disconnect above it. The states change when the tester acts, and an edit to a row in the table changes what "Sent to Clockify as" shows after Sync now.
- The review state of the Toggl lens turning Toggl Track from disabled to offered, and two tabs on Hours each with its own account, last sync and outbox.

Stand-ins and invented data:

- **Clockify and Toggl Track are fixtures inside the browser.** No request leaves the page, and there is no sign-in or consent page. On Hours, Clockify is already connected to "Demo workspace (fixture, no network)". Toggl Track, and Clockify on any other table, starts as "Not connected" with one button, "Connect Toggl Track (fixture account)" or "Connect Clockify (fixture account)", which connects at once. The fixture accepts any entry that has an end time and refuses one without: "400: Clockify refuses an entry without an end time. Stop the timer, then retry." Never promise that anything reaches a real Clockify or Toggl workspace.
- **All data is invented.** Hours has six entries for Monday 5 to Wednesday 7 October 2026: Client call: Acme, Write Q3 report, Code review, Planning: roadmap, Timer still running (no end time) and Lunch talk. Clockify mirror has one row, "Imported from Clockify". Groceries has Oat milk, Coffee beans and Apples. Times are shown in the tester's time zone; the entries were written in UTC.
- **The Clockify outbox on Hours is a seeded snapshot**, so every state is there on first open, with "Last sync" about two hours before the demo was seeded: Write Q3 report is a pending update; Code review is a held create; Planning: roadmap is a conflict on description ("was 'Planning', Clockify has 'Sprint planning', here 'Planning: roadmap'"); Timer still running is a failed create after 3 attempts, with the 400 above. Toggl Track starts empty.
- **Lens review is one button.** The demo page lists both lenses, "Time entry ↔ Clockify time entry: approved" and "Time entry ↔ Toggl time entry: waiting for review", with an "Approve lens" button on the second. There is no review screen showing what the lens maps. The PR says a real flow would put this on the lens's own page.

### What success looks like, never to be said

- Task 3: they open + and Connect on each table and say what they expect each entry to do. This is the session's main question: note where they look first, which menu they think the other menu's items belong in, whether they read "Sync this table with" and "via lens", and the words they use for the two groups ("views", "tabs", "layouts", "apps", "connections", "sync" or others). Whether the built-in kinds and Timesheet count as one group for them, and why Groceries has no Connect, are findings either way.
- Task 4: 4 billable hours (of 6.25 in total; the running timer counts for nothing), read from the Timesheet tab's totals after adding it from +. They may also count by hand in the default view; note which, and whether they went to Connect first.
- Task 5: Connect, then Clockify. A Clockify tab appears, already connected, with the outbox above. Note whether they look in + first, and what they make of being connected without signing in.
- Task 6: they read the cards and the row states. Pending (Write Q3 report) goes with Sync now; held (Code review) goes after Approve or "Approve all held"; the conflict (Planning: roadmap) is settled with "Keep this table's" (sends this table's text) or "Take Clockify's", which fails in this build (below); the failed entry (Timer still running) only goes once it has an end time, which means giving that row an End in the table, then Sync now, then Retry (below). Reaching three of the four is a good result. Note what "held", "pending" and "conflict" mean to them, and whether they notice the "not Clockify-shaped" line and what they take it to mean.
- Task 7: Connect shows Toggl Track disabled, with the waiting-for-review text. They have to go back to the demo page and click "Approve lens"; then Connect offers Toggl Track "via lens", and its tab needs "Connect Toggl Track (fixture account)" and Sync now. Where they look for the review, and whether "lens" means anything to them, are the findings.
- Task 8: two tabs on Hours, each with its own outbox. After Sync now, Toggl holds all six entries as creates until "Approve all held", then sends five; Timer still running fails there too. Note whether the two tabs read as the same kind of thing and whether they expect one to know about the other.

### Known limits (only new detail about them is a finding)

- "Take Clockify's" cannot write the table in this build: it shows an error toast saying that taking the remote value needs a row grant (ontola/atomic-server#1788) and what it would have written, and the conflict stays. Expect it; a tester who tries it has hit a limit, not a bug to report again.
- The Clockify tab's own text says "An integration: it syncs this table with Clockify and shows the sync state here. The rows stay in the other tabs." That word is in the build, not in this plan; note when a tester reads it and starts using it.
- The demo page keeps its "Approve lens" button only while that tab stays open: after a reload or navigating away, the page offers to seed again and shows no lens list (the seed is not idempotent, so don't let them seed twice). To confirm once the build is deployed: how a tester who closed it can still approve the lens, and what the entry steps should say to prevent this.
- The built-in view kinds (Kanban, Calendar and the rest) are offered on every table, Groceries included, as they are today; the PR lists declaring their classes as later work.
- The timer entry can only be sent after the tester gives it an End in the table; the fixture's message says to stop the timer, but there is no timer to stop. Retry alone resends what was tried before, without the new End: the tab picks the edit up on Sync now, and only then does Retry succeed. A tester who edits the row and presses Retry sees the same 400 again; that order is a finding about the prototype, not a tester error.
- Connect shrinks to its icon under 600 px; at phone width the "Sent to Clockify as" column is hidden. Not a task here.
- To confirm once the build is deployed: that the demo page and its seeding are reachable in the usertest build at all (the route is dev-only in the PR, gated like `/app/sandbox`), that the second window's drive is signed in when the tester reaches it, that the tabs and menus carry the labels quoted above, and the exact "Last sync" wording.
