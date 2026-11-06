# SyncD local data browser

The local data view shows the records saved in SyncD's accepted PostgreSQL
snapshots. Select a collection, search its saved JSON, page through records,
and select a record to inspect its source JSON. Local browsing requires no provider login and never starts a sync or sends
edits. The dashboard also lists grant-approved remote connections and the
recorded sync status of configured collections.

From an updated source checkout, build and launch it:

```sh
cd syncables
npm run build
# Use the same SYNCABLES_DATABASE_URL as your local SyncD installation.
node build/src/cli/main.js ui --config /path/to/syncd.json
```

An installation containing this feature also supports:

```sh
syncables ui --config /path/to/syncd.json
syncables ui --config /path/to/syncd.json \
  --collections github/work/issues,google-keep/personal/notes --browser-port 9889
```

Open the link printed in the terminal. Leave the process running while you
browse; Ctrl+C closes it. The scheduler can continue running separately.
The browser uses the job's recorded collection scope when available, just as
the terminal browser does. Otherwise it derives scope from the configured
local API document. Local data is limited to configured/selected collections. The connection
overview additionally shows other remote connections approved for SyncD,
including those not yet configured for local syncing.

Search is a case-insensitive substring search of the saved resource JSON,
limited to 200 characters; it may match field names as well as values. Pages
contain 25 records, ordered by source identity. Paging and searching stay on
one saved revision even if SyncD publishes a newer snapshot. Refresh selects
the latest accepted revision. A collection that has never synced has a
separate empty state from a saved snapshot containing no records.

The JSON detail panel preserves number lexemes, including integers larger
than JavaScript's exact numeric range. It is a view of saved source records,
not a response-archive viewer or an editor. Unsaved local edits and failed or
unaccepted provider reads are not presented as accepted synced data.

## Local access and limits

The server binds only to `127.0.0.1`, defaults to port 9889, and prints an
unpredictable per-process access link. The link's token stays in the URL
fragment until the page moves it into tab session storage and clears the
fragment. API requests require that token; restarting the server requires
opening its new link. Host/origin checks, no-store responses and a restrictive
content policy keep the local data out of other websites and frames. No
provider credential or database connection string is sent to the page.

This simple browser enumerates a snapshot using the existing store interface.
It refuses snapshots over 50,000 resources or 32 MiB of decoded resource JSON,
and pages over 8 MiB of serialized response JSON, rather than truncating them.
For larger data, use `syncables browse` or export the collection. Missing or
inaccessible snapshots produce an explicit refresh/error message.

## Remote connections and sync status

The UI server calls integration-proxy's `GET /connections` using SyncD's
existing device session. Tokens remain in the server process/Keychain and
never enter the page. This API lists only connections approved for that
particular SyncD access grant, not all of the owner's connections. The
owner-wide `/device/sessions` management API requires an owner signature or
an explicitly approved `sessions:manage` device grant. Default UI sessions
do not gain that permission. Use the separate foreground `ui --manage` flow
to embed IAP access management; see
[SyncD with IAP](daemon.md#syncd-with-integrations-atomic-place-iap).
It does not replace or widen the daemon's saved Keychain grant.

On macOS, the UI reuses the session stored by `syncables login --config FILE`.
For an explicit foreground login (including platforms without Keychain):

```sh
node build/src/cli/main.js ui --config /path/to/config.json --interactive
```

Follow the device approval instructions printed in the terminal. Foreground
credentials stay in memory. Without a usable login, local browsing remains
available and the dashboard explains how to sign in. A remote discovery
failure is shown separately from a recorded provider sync failure. A missing
connection after successful discovery is marked unavailable to the grant;
it may have been removed or not approved. Discovery does not probe provider
credentials or fetch provider records, so approval is not a live provider
health check.

Connection cards show their configured collections and the newest known
successful sync among them. Select a collection for its own last successful
sync, last attempt, next due time, and sanitized auth/sync/working-folder
failure. A successful sync updates the timestamp even if its data did not
change. A failed attempt never advances it. Cards with no configured local
collections are distinguished from never-synced configured collections.

The existing scheduler table gains nullable attempt/success/failure timestamp
and error-category columns on initialization. Older snapshots have no reliable
last-sync timestamp: the UI displays “not recorded for older data,” rather
than using a snapshot/import date or claiming they never synced. A changed
connection/query scope resets the scheduler's timestamps and error state.
Times are formatted in the browser's local timezone. Status refreshes every
15 seconds while the page is visible, or on **Check status**; data snapshots
refresh only when selected/refreshed, preserving stable pagination.

Use the same config file you already use to start SyncD. `syncd.json` is not
a generated/default filename. The laptop setup guide's example is
`~/.local/share/syncables-live/config.json`.

Connection-card timestamps aggregate only the collections selected in this UI.
A connection with none selected is “not tracked in this view,” not “never
synced”; excluded collections may have their own sync history.
