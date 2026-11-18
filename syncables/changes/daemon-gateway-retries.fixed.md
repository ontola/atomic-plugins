SyncD retries short gateway outages during connection discovery and paged
metadata reads. Each page retry uses the original request and counts
toward the read budget. Snapshots still require a complete read.
