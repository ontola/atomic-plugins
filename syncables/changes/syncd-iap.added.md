SyncD can embed IAP's reusable access-management page in its local control
panel. Start ui with --manage for a separate, foreground-only approval to
manage selected provider connections and account-wide client sessions.
Optional collection notifications subscribe to IAP's notification-only
webhook inbox, schedule durable local work before acknowledgement, and
perform full bootstrap reconciliation after a gap. Provider credentials
remain in IAP and imported data remains in local PostgreSQL.
