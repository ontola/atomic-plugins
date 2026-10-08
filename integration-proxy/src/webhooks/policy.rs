//! The inbox limits: `openapi-extensions/spec/webhook-subscriptions` §6,
//! with the plan's pilot values. Every limit applies at the same time.

use std::time::Duration;

/// Bytes counted against the deployment budget for each stored payload row
/// on top of its body: a conservative stand-in for row and index overhead
/// until it is measured (plan, step 7).
pub const PAYLOAD_ROW_OVERHEAD: i64 = 512;
/// Bytes counted against the deployment budget for each event reference.
pub const REFERENCE_ROW_OVERHEAD: i64 = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub lease: Duration,
    pub renew_after: Duration,
    pub progress_deadline: Duration,
    /// `access.maxCheckAgeSeconds`: no events are served while the last
    /// passing access check is older.
    pub access_max_check_age: Duration,
    pub subscription_max_pending_events: i64,
    pub subscription_max_pending_bytes: i64,
    pub subscription_max_pending_age: Duration,
    pub owner_max_pending_bytes: i64,
    pub owner_max_pending_references: i64,
    pub owner_max_live_subscriptions: i64,
    pub deployment_max_inbox_bytes: i64,
    pub receipt_ttl: Duration,
    pub receipt_max_count: i64,
    pub receipt_max_per_owner: i64,
    /// Receipts younger than this are never evicted early: twice the
    /// largest `toleranceSeconds` Webhook Deliveries allows.
    pub receipt_min_age: Duration,
    pub tombstone_ttl: Duration,
    pub tombstone_max_count: i64,
    pub cleanup_deadline: Duration,
    pub cleanup_max_jobs: i64,
    pub cleanup_max_jobs_per_owner: i64,
    pub sweep_interval: Duration,
    /// `delivery.maxVerifiedBytes`: the verification cap.
    pub max_verified_bytes: i64,
    /// `delivery.maxBodyBytes`: the retention cap.
    pub max_body_bytes: i64,
    pub fetch_max_events: i64,
    /// Rows one sweep step handles per batch.
    pub sweep_batch: i64,
}

const DAY: u64 = 86_400;
/// Twice the 900-second ceiling of a verification profile's tolerance.
const MIN_RECEIPT_TTL: u64 = 2 * 900;

impl Policy {
    /// The plan's pilot values; the spec's open limits take its proposed
    /// values (marked "open" there).
    pub fn pilot(deployment_max_inbox_bytes: i64) -> Self {
        Self {
            lease: Duration::from_secs(7 * DAY),
            renew_after: Duration::from_secs(12 * 3600),
            progress_deadline: Duration::from_secs(7 * DAY),
            access_max_check_age: Duration::from_secs(12 * 3600),
            subscription_max_pending_events: 10_000,
            subscription_max_pending_bytes: 64 << 20,
            subscription_max_pending_age: Duration::from_secs(7 * DAY),
            owner_max_pending_bytes: 256 << 20,
            owner_max_pending_references: 50_000,
            owner_max_live_subscriptions: 20,
            deployment_max_inbox_bytes,
            receipt_ttl: Duration::from_secs(2 * DAY),
            receipt_max_count: 200_000,
            receipt_max_per_owner: 20_000,
            receipt_min_age: Duration::from_secs(MIN_RECEIPT_TTL),
            tombstone_ttl: Duration::from_secs(30 * DAY),
            tombstone_max_count: 10_000,
            cleanup_deadline: Duration::from_secs(30 * DAY),
            cleanup_max_jobs: 10_000,
            cleanup_max_jobs_per_owner: 20,
            sweep_interval: Duration::from_secs(60),
            max_verified_bytes: 25 << 20,
            max_body_bytes: 8 << 20,
            fetch_max_events: 100,
            sweep_batch: 200,
        }
    }

    /// The consistency rules of the spec's §8.
    pub fn check(&self) -> Result<(), String> {
        let rules = [
            (self.renew_after < self.lease, "renew_after < lease"),
            (
                self.subscription_max_pending_bytes <= self.owner_max_pending_bytes
                    && self.owner_max_pending_bytes <= self.deployment_max_inbox_bytes,
                "subscription bytes <= owner bytes <= deployment bytes",
            ),
            (
                self.subscription_max_pending_events <= self.owner_max_pending_references,
                "subscription events <= owner references",
            ),
            (
                self.max_body_bytes <= self.subscription_max_pending_bytes
                    && self.max_body_bytes <= self.max_verified_bytes,
                "retention cap <= subscription bytes and <= verification cap",
            ),
            (
                self.receipt_max_per_owner <= self.receipt_max_count
                    && self.cleanup_max_jobs_per_owner <= self.cleanup_max_jobs,
                "per-owner caps at most the deployment's",
            ),
            (
                self.access_max_check_age <= Duration::from_secs(DAY)
                    && self.access_max_check_age <= self.lease,
                "access check age at most a day and at most the lease",
            ),
            (
                self.receipt_ttl >= Duration::from_secs(MIN_RECEIPT_TTL)
                    && self.receipt_min_age >= Duration::from_secs(MIN_RECEIPT_TTL)
                    && self.receipt_min_age <= self.receipt_ttl,
                "receipts live at least twice the largest tolerance",
            ),
            (
                self.sweep_interval <= Duration::from_secs(60),
                "sweep at least every minute",
            ),
            (
                self.tombstone_ttl <= Duration::from_secs(30 * DAY)
                    && self.cleanup_deadline <= Duration::from_secs(30 * DAY),
                "tombstones and cleanup at most 30 days",
            ),
            (
                [
                    self.subscription_max_pending_events,
                    self.subscription_max_pending_bytes,
                    self.owner_max_pending_bytes,
                    self.owner_max_pending_references,
                    self.owner_max_live_subscriptions,
                    self.receipt_max_count,
                    self.receipt_max_per_owner,
                    self.cleanup_max_jobs_per_owner,
                    self.tombstone_max_count,
                    self.cleanup_max_jobs,
                    self.max_verified_bytes,
                    self.max_body_bytes,
                    self.fetch_max_events,
                    self.sweep_batch,
                ]
                .iter()
                .all(|value| *value > 0),
                "limits are positive",
            ),
        ];
        match rules.iter().find(|(holds, _)| !holds) {
            Some((_, rule)) => Err(format!("webhook policy violates {rule}")),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pilot policy is the spec's: its schema defaults, and the
    /// proposed values of the limits it marks open.
    #[test]
    fn the_pilot_policy_is_the_specs() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../openapi-extensions/spec/webhook-subscriptions/schema.json");
        let schema: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("spec schema")).unwrap();
        let policy = &schema["$defs"]["Policy"]["properties"];
        let default = |group: &str, field: &str| {
            policy[group]["properties"][field]["default"]
                .as_i64()
                .unwrap_or_else(|| panic!("{group}.{field} has a default"))
        };
        let pilot = Policy::pilot(crate::config::DEFAULT_WEBHOOK_INBOX_MAX_BYTES);
        let secs = |d: Duration| d.as_secs() as i64;
        assert_eq!(secs(pilot.lease), default("lease", "durationSeconds"));
        assert_eq!(
            secs(pilot.renew_after),
            default("lease", "renewAfterSeconds")
        );
        assert_eq!(
            secs(pilot.progress_deadline),
            default("lease", "progressDeadlineSeconds")
        );
        assert_eq!(
            pilot.subscription_max_pending_events,
            default("subscription", "maxPendingEvents")
        );
        assert_eq!(
            pilot.subscription_max_pending_bytes,
            default("subscription", "maxPendingBytes")
        );
        assert_eq!(
            secs(pilot.subscription_max_pending_age),
            default("subscription", "maxPendingAgeSeconds")
        );
        assert_eq!(
            pilot.owner_max_pending_bytes,
            default("owner", "maxPendingBytes")
        );
        assert_eq!(
            pilot.owner_max_pending_references,
            default("owner", "maxPendingReferences")
        );
        assert_eq!(
            pilot.owner_max_live_subscriptions,
            default("owner", "maxActiveSubscriptions")
        );
        assert_eq!(
            pilot.deployment_max_inbox_bytes,
            default("deployment", "maxInboxBytes")
        );
        assert_eq!(secs(pilot.receipt_ttl), default("receipts", "ttlSeconds"));
        assert_eq!(
            secs(pilot.tombstone_ttl),
            default("closed", "tombstoneTtlSeconds")
        );
        assert_eq!(
            secs(pilot.cleanup_deadline),
            default("cleanup", "deadlineSeconds")
        );
        assert_eq!(
            secs(pilot.sweep_interval),
            default("sweep", "maxIntervalSeconds")
        );
        pilot.check().unwrap();
    }

    #[test]
    fn inconsistent_policies_are_refused() {
        let pilot = Policy::pilot(1 << 30);
        let mut policy = pilot.clone();
        policy.renew_after = policy.lease;
        assert!(policy.check().is_err());
        let mut policy = pilot.clone();
        policy.deployment_max_inbox_bytes = policy.owner_max_pending_bytes - 1;
        assert!(policy.check().is_err());
        let mut policy = pilot.clone();
        policy.max_body_bytes = policy.subscription_max_pending_bytes + 1;
        assert!(policy.check().is_err());
        let mut policy = pilot.clone();
        policy.sweep_interval = Duration::from_secs(61);
        assert!(policy.check().is_err());
        let mut policy = pilot.clone();
        policy.max_body_bytes = policy.max_verified_bytes + 1;
        assert!(policy.check().is_err());
        let mut policy = pilot.clone();
        policy.access_max_check_age = Duration::from_secs(DAY + 1);
        assert!(policy.check().is_err());
        let mut policy = pilot.clone();
        policy.receipt_ttl = Duration::from_secs(1799);
        assert!(policy.check().is_err());
        let mut policy = pilot;
        policy.fetch_max_events = 0;
        assert!(policy.check().is_err());
    }
}
