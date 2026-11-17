//! Cleanup jobs for dedicated hooks the receiver created (Webhook
//! Deliveries §4.5.2): bounded retries with backoff, a deadline, and a
//! visible failure.
//!
//! Deleting a hook at the provider needs the managing connection's
//! credential, and the proxy cannot open one without the key a client
//! presents ([`crate::connection_key`]). So a job waits until an authorised
//! request for its managing connection arrives with the key
//! ([`Store::run_cleanup_for_connection`], started by
//! [`super::run_deferred_cleanup`]); the sweeper only fails the jobs whose
//! deadline passed ([`Store::expire_cleanup`]). The provider calls are behind [`HookDeleter`]; step 3
//! implements it, re-running the managing connection's access check with the
//! hook's recorded parameters before each `list` or `delete`.

use std::future::Future;
use std::time::{Duration, SystemTime};

use super::store::{HookToDelete, InboxError, Store};

/// Why one deletion attempt did not succeed. Shown to the operator as a
/// class, never with provider content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CleanupError {
    /// Try again later (5xx, timeout, rate limit).
    Retry(&'static str),
    /// No later attempt can succeed (no managing connection, its access
    /// check failed or selected another key): fail visibly now.
    Permanent(&'static str),
}

pub trait HookDeleter {
    fn delete(&self, hook: &HookToDelete) -> impl Future<Output = Result<(), CleanupError>> + Send;
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CleanupReport {
    pub deleted: u64,
    pub retried: u64,
    pub failed: u64,
}

/// A claimed attempt holds its job this long; a crashed runner's claim
/// lapses after it.
const CLAIM: Duration = Duration::from_secs(300);
const MAX_BACKOFF: Duration = Duration::from_secs(86_400);

fn backoff(attempts: i32) -> Duration {
    let exponent = attempts.clamp(0, 20) as u32;
    Duration::from_secs(60u64 << exponent).min(MAX_BACKOFF)
}

impl Store {
    /// Fails the jobs whose deadline passed, without calling any provider.
    /// The sweeper runs this: it has no connection key.
    pub async fn expire_cleanup(&self, now: SystemTime) -> Result<u64, InboxError> {
        let expired: Vec<String> = {
            let client = self.transaction_client().await?;
            client
                .query(
                    "SELECT hook_id FROM webhook_cleanup_jobs
                     WHERE deadline_at <= $1 AND next_attempt_at <= $1
                     ORDER BY deadline_at LIMIT $2",
                    &[&now, &self.policy().sweep_batch],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect()
        };
        for hook_id in &expired {
            tracing::warn!(hook = %hook_id, "webhook hook cleanup expired before a client presented the managing connection's key; manual removal needed");
            self.finish_cleanup(hook_id, true, now).await?;
        }
        Ok(expired.len() as u64)
    }

    /// Runs the due jobs of the hooks `connection_id` manages, with a
    /// deleter that holds that connection's key.
    pub async fn run_cleanup_for_connection<D: HookDeleter>(
        &self,
        deleter: &D,
        connection_id: &str,
        now: SystemTime,
    ) -> Result<CleanupReport, InboxError> {
        self.run_cleanup_where(deleter, Some(connection_id), now)
            .await
    }

    /// Whether any cleanup job waits for `connection_id`'s key.
    pub async fn cleanup_waits_for(&self, connection_id: &str) -> Result<bool, InboxError> {
        let client = self.transaction_client().await?;
        Ok(client
            .query_opt(
                "SELECT 1 FROM webhook_cleanup_jobs j JOIN webhook_hooks h USING (hook_id)
                 WHERE h.management_connection_id = $1 LIMIT 1",
                &[&connection_id],
            )
            .await?
            .is_some())
    }

    /// Runs every due job, whatever its managing connection. Only for a
    /// deleter that needs no connection key (tests).
    #[cfg(test)]
    pub async fn run_cleanup<D: HookDeleter>(
        &self,
        deleter: &D,
        now: SystemTime,
    ) -> Result<CleanupReport, InboxError> {
        self.run_cleanup_where(deleter, None, now).await
    }

    async fn run_cleanup_where<D: HookDeleter>(
        &self,
        deleter: &D,
        connection_id: Option<&str>,
        now: SystemTime,
    ) -> Result<CleanupReport, InboxError> {
        let mut report = CleanupReport::default();
        let due: Vec<(String, i32, SystemTime)> = {
            let client = self.transaction_client().await?;
            client
                .query(
                    // Claimed by pushing the next attempt out, so two
                    // runners never call the provider for one job at once.
                    "UPDATE webhook_cleanup_jobs SET next_attempt_at = $2
                     WHERE hook_id IN (SELECT j.hook_id FROM webhook_cleanup_jobs j
                                       JOIN webhook_hooks h USING (hook_id)
                                       WHERE j.next_attempt_at <= $1
                                         AND ($4::text IS NULL OR h.management_connection_id = $4)
                                       ORDER BY j.next_attempt_at LIMIT $3
                                       FOR UPDATE OF j SKIP LOCKED)
                     RETURNING hook_id, attempts, deadline_at",
                    &[
                        &now,
                        &(now + CLAIM),
                        &self.policy().sweep_batch,
                        &connection_id,
                    ],
                )
                .await?
                .iter()
                .map(|row| (row.get(0), row.get(1), row.get(2)))
                .collect()
        };
        for (hook_id, attempts, deadline) in due {
            if deadline <= now {
                self.finish_cleanup(&hook_id, true, now).await?;
                report.failed += 1;
                continue;
            }
            let hook = {
                let client = self.transaction_client().await?;
                let row = client
                    .query_one(
                        "SELECT hook_id, platform, source_kind, source_key, coalesce(access_parameters, '{}'),
                                provider_hook_id, management_connection_id, endpoint_id
                         FROM webhook_hooks WHERE hook_id = $1",
                        &[&hook_id],
                    )
                    .await?;
                HookToDelete {
                    hook_id: row.get(0),
                    platform: row.get(1),
                    source_kind: row.get::<_, Option<String>>(2).unwrap_or_default(),
                    source_key: row.get::<_, Option<String>>(3).unwrap_or_default(),
                    access_parameters: row.get(4),
                    provider_hook_id: row.get(5),
                    management_connection_id: row.get(6),
                    endpoint_id: row.get(7),
                }
            };
            match deleter.delete(&hook).await {
                Ok(()) => {
                    self.finish_cleanup(&hook_id, false, now).await?;
                    report.deleted += 1;
                }
                Err(CleanupError::Permanent(class)) => {
                    tracing::warn!(hook = %hook_id, class, "webhook hook cleanup failed; manual removal needed");
                    self.finish_cleanup(&hook_id, true, now).await?;
                    report.failed += 1;
                }
                Err(CleanupError::Retry(class)) => {
                    let client = self.transaction_client().await?;
                    client
                        .execute(
                            "UPDATE webhook_cleanup_jobs SET attempts = attempts + 1, last_error = $2,
                               next_attempt_at = least($3, deadline_at)
                             WHERE hook_id = $1",
                            &[&hook_id, &class, &(now + backoff(attempts + 1))],
                        )
                        .await?;
                    report.retried += 1;
                }
            }
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn backoff_doubles_and_is_capped_at_a_day() {
        assert_eq!(super::backoff(0).as_secs(), 60);
        assert_eq!(super::backoff(1).as_secs(), 120);
        assert_eq!(super::backoff(5).as_secs(), 1920);
        assert_eq!(super::backoff(30).as_secs(), 86_400);
    }
}
