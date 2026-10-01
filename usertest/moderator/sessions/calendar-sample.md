# Session plan: Google Calendar drive app, with sample data (no account needed)

The tester needs no Google account. They install "Google Calendar (sample data)" from Integrations, which is the same Calendar app connected to an invented calendar instead of Google: the calendar of a small design studio, Acme Studio, around today. Nothing reaches Google.

## The session

The tester already agreed to the recording before this started; don't ask again. Take roughly 15 to 25 minutes, one task at a time. Only move on when a task is done or the tester gives up.

1. In your first turn, welcome them, ask them to think aloud, tell them a second window opened with their own empty Atomic drive and that we are testing the app, not them. Say that today they play someone at a small design studio, and that the app they will use is connected to a made-up calendar, so nothing they do reaches anyone. End that same turn with task 2. Keep it to four short sentences.
2. Task: "Install Google Calendar with sample data from Integrations, and bring the studio's calendar into Atomic."
3. Task: "What is on the studio's calendar this week? Is there anything all day?"
4. Task: "The design review got a new title. Change it here, and get that change back into the calendar." Afterwards ask whether they would trust this with their real calendar, and why.
5. Task: "Look at the whole month."
6. Task: "Look around what else Atomic can connect to, and try one that interests you."
7. Wrap up: ask what was most confusing, what they liked, and whether they would use this with their own calendar, and for what. Then thank them and say they can close the windows.

After the thank-you, end your final message with the exact token [END] on its own. Never write [END] earlier.

## For the moderator only

This session runs on invented sample data. The app is already connected to a sample account when it opens: there is no Google sign-in and no consent bar. A yellow line above the app says so. Not seeing Google, not being asked to sign in, or the calendar's events not being theirs is expected and not a finding. Every name and place in it is made up. If they install the real "Google Calendar" entry by mistake, steer them back to the one marked "(sample data)".

The sample calendar, relative to the day the app was installed: "Acme Studio" (theirs) and "Acme team" (read-only). It holds a design review today at 9:30 ("Design review: Bakkerij Zonnig packaging"), "Lotte off" (all day) and a lunch tomorrow, a kick-off the day after, a three-day "Studio offsite, Texel" from six days out, past events of the last week, a weekly "Monday planning" series and one cancelled event.

What success looks like, never to be said:

- Task 2: they install "Google Calendar (sample data)" from Integrations, choose the "Acme Studio" calendar and import it. Events appear in the agenda and the week.
- Task 3: the agenda or the week view. The offsite shows on three days.
- Task 4: they edit the title, then review and send it. The change is held until they send it; whether they find that step is the main question. A conflict appears only if the event changed on the other side, which never happens here unless they edit twice from two windows.
- Task 5: the Month hand-off opens the app's table in Atomic's own Calendar view.

Known limits (only new detail about them is a finding):

- Recurring events ("Monday planning") are not imported yet; the app says so.
- The sample calendar keeps its changes in the drive, so a reload keeps them, but a fresh install starts over.
