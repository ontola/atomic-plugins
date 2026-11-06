SyncD now has a local read-only data browser: `syncables ui --config FILE`
prints a browser link for configured collections, searchable paginated records
and exact source JSON details. It reads accepted PostgreSQL snapshots without
provider requests and keeps paging on one saved revision until refreshed.
