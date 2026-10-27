# GitHub issues webhook inbox (sandbox plugin)

Status: pilot code for ontola/atomic-plugins#369 step 4b. It is not in the
catalog and is not published. The integration proxy's webhook inbox it
talks to is disabled by default (`WEBHOOKS_ENABLED`) and not deployed.

This is an atomic-server sandbox plugin. An Installation runs it unattended
as a sync session (`sync_worker.rs` and `sync_session.rs`, the
preview/step protocol), on the interval its schedule sets: at least one
minute. Each run:

1. Acknowledges the events the previous run stored, and reports a
   reconciliation the previous run found done. Both are read from the
   installation's connection state, which the previous run wrote in its
   final checkpoint.
2. Renews the subscription's lease when due.
3. Fetches up to 4 events (1 after a failed run) and at most 6 MiB of
   base64 payload (`maxBytes`), writes a **Webhook delivery** row (the raw
   payload, base64) and a **Webhook work item** row for each new one, and a
   **Webhook gap** row for each gap.
4. Checkpoints the new state.

An event is acknowledged only by a later run, after that run has read the
checkpoint written once its rows landed. A run stopped between writing the
rows and the checkpoint is resumed by the host from its saved session. If
it is not resumed, a later run fetches the same events again and finds
their rows by delivery id. Both cases are covered by `plugin.test.ts`.

It holds no credential. The host signs every request as the installation's
node agent, and the proxy accepts that agent as a runtime of the app the
GitHub connection is delegated to (on the Installation page, Connections).

The three classes (`schema.ts`) stay in this folder for the pilot. This is
a coordinator decision of 2026-10-12, and it is reversible. They are not
GitHub-specific and are expected to move to shared code once a generic
runner exists (docs/design/pieces.md D2/D5).

## What a user sees, and the known limits

- **A gap stays open until the drive app marks it done.** A new
  subscription starts with a gap: the provider's history before it is not
  available. A gap also comes from an expiry, the retention limit, or a
  revoked hook. For each gap the inbox writes a Webhook gap row and a
  `reconcile` work item (status `pending`). It tells the proxy the gap is
  reconciled only once that work item is `done`.
  - Nothing marks it `done` yet. The issue-tracker drive app is to do so
    after its full read (a separate unit, in the step-4b plan).
  - Until then, the subscription stays `needs-reconciliation` at the proxy.
    Deliveries are still stored and acknowledged, and nothing is lost
    because of it. But the gap row and its `pending` work item stay, and
    no run reports the gap closed.
  - Every later gap adds another row and another pending item.
- **A delivery over 6 MiB of base64 (about 4.5 MiB raw) is kept without
  its payload.** The host caps a fetched response and a saved sync session
  at 8 MiB each, and a payload travels as base64 (4/3 of its size). The
  proxy retains bodies up to 8 MiB (`delivery.maxBodyBytes`, pilot policy),
  so such deliveries can exist.
  - Each fetch asks for at most 6 MiB of payload (`maxBytes`, Webhook
    Subscriptions 0.2.0-draft). The proxy returns a delivery that is over
    that alone without its body. The plugin stores it as a Webhook
    delivery row without **Payload**, but with **Payload bytes**,
    **Payload SHA-256** and the rest of the envelope, plus its work item,
    and acknowledges it like any other.
  - Its content is then not in Atomic. Whatever processes the work item
    has to read the issue through the provider's API instead. Nothing does
    that yet (the drive app's part, step-4b plan Unit A).
  - Against a receiver that does not know `maxBytes` (one before
    0.2.0-draft ignores it), the old limits apply: past 6 MiB of base64 in
    one run the plugin stops collecting and goes on in the next run; one
    event over 7.5 MiB of base64 is refused with `lastError`; a page over
    the 8 MiB fetch cap fails, and the next run asks for one event. That
    success clears the error, so while the rest of the page is still over
    the cap, runs alternate between that failure and a one-event success:
    one event per two runs. A single event over about 5.6 MiB raw then
    stalls the inbox until the proxy drops it (7 days).
- **An abandoned first run leaves an orphan gap row and reconcile item.**
  If the very first run stops after its rows are written and the host
  never resumes it, no checkpoint names the subscription it created. The
  next run subscribes again and writes a new gap row and reconcile item for
  the new subscription. The first ones stay `pending` and nothing will
  report them, and the first subscription stays at the proxy until it
  expires. A later run abandoned the same way loses nothing: its state
  still names the subscription, and its rows are found by id.
- **A failed step does not stop the schedule.** A transport failure, or a
  refusal a retry would not fix, ends the run with `lastError` recorded
  instead of an error. An errored sync session would stop the schedule
  until a person reviews it again. Not caught: a failed Atomic write (the
  host stops the session), and a configuration error in preview (the host
  stops the schedule). Both need a person.
- **The proxy is reached by its absolute URL**, which atomic-server signs
  but logs as deprecated. `build.mjs` bakes the origin in
  (`--proxy-origin`, default `https://localthought.io`). Every such place
  carries `TODO(ontola/atomic-server#2228)`.
- **There is no "Set up" for the destination.** The host's set-up of a
  manifest `destination` exists only for file importers. The tables,
  classes and properties have to be created with `provisionDestination`
  (`@tomic/lib`), and its config passed to the sync preview. The
  installation's agent then needs read on that schema and write on the three
  tables: a run writes with both the approving person's rights and that
  agent's, and without them every run's write plan is refused ("refusing to
  apply a blocked plan"). The e2e does exactly that.
- **Where to find what a run wrote.** Each checkpoint names the rows its run
  wrote (`lastWritten` in the state). A server-side run's rows reach a
  browser's local index only through drive sync, so read them by subject.

## Commands

```sh
node integrations/tooling/link-atomic-server.mjs
./browser/node_modules/.bin/vitest run --config integrations/issue-tracker/vitest.config.ts inbox
node integrations/issue-tracker/inbox/build.mjs --out /tmp/inbox-plugin.js
```

The e2e is `integrations/issue-tracker/e2e/inbox.spec.ts`, in the
issue-tracker lane:

```sh
node integrations/tooling/run-lane.mjs issue-tracker --tier e2e
```
