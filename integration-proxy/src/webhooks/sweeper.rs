//! The periodic sweep (`webhook-subscriptions` §4.3, §6): it expires
//! receipts, ends subscriptions past a deadline or without their
//! connection, ages out old events, retires dedicated hooks nothing uses,
//! and purges tombstones, closed hooks and empty owner rows, all in bounded
//! batches. Every step runs even when another one fails, and receipts go
//! first. Deadlines are also enforced on the request path, so a sweeper
//! that stops cannot let a subscription keep growing.

use std::time::SystemTime;

use super::store::{InboxError, Store};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    pub receipts: u64,
    pub ended: u64,
    pub aged_out: i64,
    pub hooks_retired: u64,
    pub tombstones: u64,
    pub hooks: u64,
    pub owners: u64,
    /// Seconds the oldest still-overdue deadline is behind; 0 when none.
    pub lag_seconds: u64,
    /// Steps that failed in this sweep.
    pub failed_steps: u32,
}

const LIVE: &str = "('provisioning', 'needs-reconciliation', 'active')";

impl Store {
    /// One sweep. Returns the first error after every step has been tried;
    /// the last-sweep time (what new subscriptions are refused on) moves
    /// only when every step succeeded.
    pub async fn sweep(&self, now: SystemTime) -> Result<SweepReport, InboxError> {
        let mut report = SweepReport::default();
        let mut first_error = None;
        let mut note = |result: Result<(), InboxError>, report: &mut SweepReport| {
            if let Err(error) = result {
                tracing::error!(%error, "webhook inbox sweep step failed");
                report.failed_steps += 1;
                first_error.get_or_insert(error);
            }
        };
        let r = self.expire_receipts(now).await.map(|n| report.receipts = n);
        note(r, &mut report);
        let r = self.end_due(now).await.map(|n| report.ended = n);
        note(r, &mut report);
        let r = self.age_events(now).await.map(|n| report.aged_out = n);
        note(r, &mut report);
        let r = self
            .retire_unused_hooks(now)
            .await
            .map(|n| report.hooks_retired = n);
        note(r, &mut report);
        let r = self
            .purge_tombstones(now)
            .await
            .map(|n| report.tombstones = n);
        note(r, &mut report);
        let r = self.purge_hooks().await.map(|n| report.hooks = n);
        note(r, &mut report);
        let r = self.purge_owners().await.map(|n| report.owners = n);
        note(r, &mut report);
        let r = self.lag(now).await.map(|n| report.lag_seconds = n);
        note(r, &mut report);
        if let Some(error) = first_error {
            return Err(error);
        }
        let client = self.transaction_client().await?;
        client
            .execute(
                "UPDATE webhook_deployment_usage SET last_sweep_at = $1",
                &[&now],
            )
            .await?;
        Ok(report)
    }

    async fn expire_receipts(&self, now: SystemTime) -> Result<u64, InboxError> {
        let mut client = self.transaction_client().await?;
        let tx = client.transaction().await?;
        tx.query_one("SELECT 1 FROM webhook_deployment_usage FOR UPDATE", &[])
            .await?;
        let removed = tx
            .execute(
                "DELETE FROM webhook_receipts WHERE ctid IN (
                   SELECT ctid FROM webhook_receipts WHERE expires_at <= $1 LIMIT $2)",
                &[&now, &self.policy().sweep_batch],
            )
            .await?;
        tx.execute(
            "UPDATE webhook_deployment_usage SET receipts = receipts - $1",
            &[&(removed as i64)],
        )
        .await?;
        tx.commit().await?;
        Ok(removed)
    }

    async fn end_due(&self, now: SystemTime) -> Result<u64, InboxError> {
        let due: Vec<String> = self
            .transaction_client()
            .await?
            .query(
                &format!(
                    "SELECT subscription_id FROM webhook_subscriptions s
                     WHERE state IN {LIVE}
                       AND (lease_expires_at <= $1 OR progress_deadline_at <= $1
                            OR NOT EXISTS (SELECT 1 FROM agent_connections c
                                           WHERE c.connection_id = s.connection_id))
                     ORDER BY subscription_id LIMIT $2"
                ),
                &[&now, &self.policy().sweep_batch],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        let mut ended = 0;
        for id in &due {
            // One failing row is logged and skipped, not the whole step.
            match self.end_if_due(id, now).await {
                Ok(true) => ended += 1,
                Ok(false) => {}
                Err(error) => {
                    tracing::error!(%error, "webhook sweep: ending one subscription failed")
                }
            }
        }
        Ok(ended)
    }

    async fn age_events(&self, now: SystemTime) -> Result<i64, InboxError> {
        let Some(cutoff) = now.checked_sub(self.policy().subscription_max_pending_age) else {
            return Ok(0);
        };
        let aging: Vec<String> = self
            .transaction_client()
            .await?
            .query(
                "SELECT DISTINCT subscription_id FROM webhook_event_refs
                 WHERE received_at < $1 ORDER BY subscription_id LIMIT $2",
                &[&cutoff, &self.policy().sweep_batch],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        let mut aged = 0;
        for id in &aging {
            match self.age_out(id, now).await {
                Ok(evicted) => aged += evicted,
                Err(error) => {
                    tracing::error!(%error, "webhook sweep: ageing one subscription failed")
                }
            }
        }
        Ok(aged)
    }

    async fn retire_unused_hooks(&self, now: SystemTime) -> Result<u64, InboxError> {
        let unused_before = now
            .checked_sub(self.policy().unused_hook_deadline)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let unused: Vec<String> = self
            .transaction_client()
            .await?
            .query(
                &format!(
                    "SELECT h.hook_id FROM webhook_hooks h
                     WHERE h.ownership = 'dedicated' AND h.created_by_receiver
                       AND h.state IN ('provisioning', 'active') AND h.created_at <= $1
                       AND NOT EXISTS (SELECT 1 FROM webhook_subscriptions s
                                       WHERE s.hook_id = h.hook_id AND s.state IN {LIVE})
                     ORDER BY h.hook_id LIMIT $2"
                ),
                &[&unused_before, &self.policy().sweep_batch],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        let mut retired = 0;
        for hook_id in &unused {
            match self.retire_unused_hook(hook_id, unused_before, now).await {
                Ok(true) => retired += 1,
                Ok(false) => {}
                Err(error) => tracing::error!(%error, "webhook sweep: retiring one hook failed"),
            }
        }
        Ok(retired)
    }

    async fn purge_tombstones(&self, now: SystemTime) -> Result<u64, InboxError> {
        let policy = self.policy();
        let client = self.transaction_client().await?;
        let ttl_cutoff = now
            .checked_sub(policy.tombstone_ttl)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let mut purged = client
            .execute(
                "DELETE FROM webhook_subscriptions WHERE subscription_id IN (
                   SELECT subscription_id FROM webhook_subscriptions
                   WHERE state = 'closed' AND ended_at <= $1 LIMIT $2)
                 AND state = 'closed'",
                &[&ttl_cutoff, &policy.sweep_batch],
            )
            .await?;
        let tombstones: i64 = client
            .query_one(
                "SELECT count(*) FROM webhook_subscriptions WHERE state = 'closed'",
                &[],
            )
            .await?
            .get(0);
        let over = (tombstones - policy.tombstone_max_count).clamp(0, policy.sweep_batch);
        if over > 0 {
            purged += client
                .execute(
                    "DELETE FROM webhook_subscriptions WHERE subscription_id IN (
                       SELECT subscription_id FROM webhook_subscriptions
                       WHERE state = 'closed' ORDER BY ended_at, subscription_id LIMIT $1)
                     AND state = 'closed'",
                    &[&over],
                )
                .await?;
        }
        Ok(purged)
    }

    async fn purge_hooks(&self) -> Result<u64, InboxError> {
        Ok(self
            .transaction_client()
            .await?
            .execute(
                "DELETE FROM webhook_hooks h WHERE h.hook_id IN (
                   SELECT hook_id FROM webhook_hooks WHERE state = 'closed' LIMIT $1)
                 AND h.state = 'closed'
                 AND NOT EXISTS (SELECT 1 FROM webhook_subscriptions s WHERE s.hook_id = h.hook_id)
                 AND NOT EXISTS (SELECT 1 FROM webhook_cleanup_jobs j WHERE j.hook_id = h.hook_id)",
                &[&self.policy().sweep_batch],
            )
            .await?)
    }

    /// One row per statement: a multi-row delete could take owner locks in
    /// another order than a delivery does.
    async fn purge_owners(&self) -> Result<u64, InboxError> {
        let client = self.transaction_client().await?;
        let candidates: Vec<String> = client
            .query(
                "SELECT owner FROM webhook_owner_usage
                 WHERE pending_bytes = 0 AND pending_refs = 0 AND live_subscriptions = 0
                 ORDER BY owner LIMIT $1",
                &[&self.policy().sweep_batch],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        let mut purged = 0;
        for owner in &candidates {
            // The counters are checked on the row itself, so a concurrent
            // subscription that locked and changed it first is seen when the
            // delete re-checks the row.
            purged += client
                .execute(
                    "DELETE FROM webhook_owner_usage o
                     WHERE o.owner = $1 AND o.pending_bytes = 0 AND o.pending_refs = 0
                       AND o.live_subscriptions = 0
                       AND NOT EXISTS (SELECT 1 FROM webhook_subscriptions s WHERE s.owner = o.owner)",
                    &[owner],
                )
                .await?;
        }
        Ok(purged)
    }

    async fn lag(&self, now: SystemTime) -> Result<u64, InboxError> {
        let oldest_overdue: Option<SystemTime> = self
            .transaction_client()
            .await?
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
        Ok(oldest_overdue
            .and_then(|at| now.duration_since(at).ok())
            .map_or(0, |lag| lag.as_secs()))
    }
}

/// Runs [`Store::sweep`] and the hook cleanup every `sweep_interval` until
/// the process ends.
pub fn spawn<D>(store: std::sync::Arc<Store>, deleter: D)
where
    D: super::cleanup::HookDeleter + Send + Sync + 'static,
{
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
            if let Err(error) = store.run_cleanup(&deleter, SystemTime::now()).await {
                tracing::error!(%error, "webhook hook cleanup failed");
            }
        }
    });
}
