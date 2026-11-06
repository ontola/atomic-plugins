# SyncD local data browser

The read-only browser shows the records saved in SyncD's accepted PostgreSQL
snapshots. Select a collection, search its saved JSON, page through records,
and select a record to inspect its source JSON. It requires no provider login
and never starts a sync or sends edits.

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
local API document. It displays only the configured/selected collections.

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
