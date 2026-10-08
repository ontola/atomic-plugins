//! The periodic sweep (`webhook-subscriptions` §4.3, §6): it ends
//! subscriptions past a deadline or without their connection, ages out old
//! events, expires receipts, purges tombstones and closed hooks, all in
//! bounded batches. Deadlines are also enforced on the request path, so a
//! sweeper that stops cannot let a subscription keep growing.

use std::time::SystemTime;

use super::store::{InboxError, Store};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    pub ended: u64,
    pub aged_out: i64,
    pub receipts: u64,
    pub tombstones: u64,
    pub hooks: u64,
    pub owners: u64,
    /// Seconds the oldest still-overdue deadline is behind; 0 when none.
    pub lag_seconds: u64,
}

const LIVE: &str = "('provisioning', 'needs-reconciliation', 'active')";

impl Store {
    pub async fn sweep(&self, now: SystemTime) -> Result<SweepReport, InboxError> {
        let batch = self.policy().sweep_batch;
        let mut report = SweepReport::default();

        let due: Vec<String> = {
            let client = self.transaction_client().await?;
            client
                .query(
                    &format!(
                        "SELECT subscription_id FROM webhook_subscriptions s
                         WHERE state IN {LIVE}
                           AND (lease_expires_at <= $1 OR progress_deadline_at <= $1
                                OR NOT EXISTS (SELECT 1 FROM agent_connections c
                                               WHERE c.connection_id = s.connection_id))
                         ORDER BY subscription_id LIMIT $2"
                    ),
                    &[&now, &batch],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect()
        };
        for id in &due {
            if self.end_if_due(id, now).await? {
                report.ended += 1;
            }
        }

        if let Some(cutoff) = now.checked_sub(self.policy().subscription_max_pending_age) {
            let aging: Vec<String> = {
                let client = self.transaction_client().await?;
                client
                    .query(
                        "SELECT DISTINCT subscription_id FROM webhook_event_refs
                         WHERE received_at < $1 ORDER BY subscription_id LIMIT $2",
                        &[&cutoff, &batch],
                    )
                    .await?
                    .iter()
                    .map(|row| row.get(0))
                    .collect()
            };
            for id in &aging {
                report.aged_out += self.age_out(id, now).await?;
            }
        }

        let mut client = self.transaction_client().await?;
        {
            let tx = client.transaction().await?;
            tx.query_one("SELECT 1 FROM webhook_deployment_usage FOR UPDATE", &[])
                .await?;
            report.receipts = tx
                .execute(
                    "DELETE FROM webhook_receipts WHERE ctid IN (
                       SELECT ctid FROM webhook_receipts WHERE expires_at <= $1 LIMIT $2)",
                    &[&now, &batch],
                )
                .await?;
            tx.execute(
                "UPDATE webhook_deployment_usage SET receipts = receipts - $1",
                &[&(report.receipts as i64)],
            )
            .await?;
            tx.commit().await?;
        }

        let policy = self.policy();
        let ttl_cutoff = now
            .checked_sub(policy.tombstone_ttl)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        report.tombstones = client
            .execute(
                "DELETE FROM webhook_subscriptions WHERE subscription_id IN (
                   SELECT subscription_id FROM webhook_subscriptions
                   WHERE state = 'closed' AND ended_at <= $1 LIMIT $2)",
                &[&ttl_cutoff, &batch],
            )
            .await?;
        let tombstones: i64 = client
            .query_one(
                "SELECT count(*) FROM webhook_subscriptions WHERE state = 'closed'",
                &[],
            )
            .await?
            .get(0);
        let over = (tombstones - policy.tombstone_max_count).clamp(0, batch);
        if over > 0 {
            report.tombstones += client
                .execute(
                    "DELETE FROM webhook_subscriptions WHERE subscription_id IN (
                       SELECT subscription_id FROM webhook_subscriptions
                       WHERE state = 'closed' ORDER BY ended_at, subscription_id LIMIT $1)",
                    &[&over],
                )
                .await?;
        }
        report.hooks = client
            .execute(
                "DELETE FROM webhook_hooks h WHERE h.hook_id IN (
                   SELECT hook_id FROM webhook_hooks WHERE state = 'closed' LIMIT $1)
                 AND NOT EXISTS (SELECT 1 FROM webhook_subscriptions s WHERE s.hook_id = h.hook_id)
                 AND NOT EXISTS (SELECT 1 FROM webhook_cleanup_jobs j WHERE j.hook_id = h.hook_id)",
                &[&batch],
            )
            .await?;
        report.owners = client
            .execute(
                // The counters are checked on the deleted row itself, so a
                // concurrent subscription that locked and changed it first
                // is seen when the delete re-checks the row.
                "DELETE FROM webhook_owner_usage o
                 WHERE o.pending_bytes = 0 AND o.pending_refs = 0 AND o.live_subscriptions = 0
                   AND o.owner IN (SELECT owner FROM webhook_owner_usage
                                   WHERE pending_bytes = 0 AND pending_refs = 0 AND live_subscriptions = 0 LIMIT $1)
                   AND NOT EXISTS (SELECT 1 FROM webhook_subscriptions s WHERE s.owner = o.owner)",
                &[&batch],
            )
            .await?;
        let oldest_overdue: Option<SystemTime> = client
            .query_one(
                &format!(
                    "SELECT min(least(coalesce(lease_expires_at, 'infinity'), coalesce(progress_deadline_at, 'infinity')))
                     FROM webhook_subscriptions WHERE state IN {LIVE}
                       AND (lease_expires_at <= $1 OR progress_deadline_at <= $1)"
                ),
                &[&now],
            )
            .await?
            .get(0);
        report.lag_seconds = oldest_overdue
            .and_then(|at| now.duration_since(at).ok())
            .map_or(0, |lag| lag.as_secs());
        client
            .execute(
                "UPDATE webhook_deployment_usage SET last_sweep_at = $1",
                &[&now],
            )
            .await?;
        Ok(report)
    }
}

/// Runs [`Store::sweep`] every `sweep_interval` until the process ends.
pub fn spawn(store: std::sync::Arc<Store>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(store.policy().sweep_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            match store.sweep(SystemTime::now()).await {
                Ok(report) if report.lag_seconds > 0 => {
                    tracing::warn!(
                        lag_seconds = report.lag_seconds,
                        "webhook inbox sweep is behind"
                    )
                }
                Ok(report) => tracing::debug!(?report, "webhook inbox swept"),
                Err(error) => tracing::error!(%error, "webhook inbox sweep failed"),
            }
        }
    });
}
