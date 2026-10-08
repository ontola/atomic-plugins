//! The inbox against PostgreSQL. Ignored without `TEST_DATABASE_URL`; CI
//! runs them with `--include-ignored`. Each test gets its own schema.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::sync::Barrier;

use super::cleanup::{CleanupError, HookDeleter};
use super::store::{
    AccessCheck, Delivery, HookToDelete, InboxError, IngestOutcome, NewSubscription,
    SubscriptionView,
};
use super::{Policy, Store};
use crate::security::tests::{admin, test_database_url, TEST_KEY};
use crate::security::Security;

const PLATFORM: &str = "tracker";
const HOUR: u64 = 3600;
const DAY: u64 = 86_400;

fn at(seconds: u64) -> SystemTime {
    // 2026-10-08T12:00:00Z, the fixtures' time.
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_791_460_800 + seconds)
}

fn agent(name: &str) -> String {
    format!("atomic:agent:{name:A<43}")
}

struct Env {
    store: Arc<Store>,
    security: Security,
    schema: String,
    tag: String,
    url: String,
}

/// A fresh schema with the proxy's tables and the inbox's.
async fn env(policy: Policy) -> Env {
    let schema = format!("webhooks_{:016x}", rand::random::<u64>());
    admin()
        .await
        .batch_execute(&format!("CREATE SCHEMA \"{schema}\""))
        .await
        .expect("create schema");
    let tag = format!("inbox_{:016x}", rand::random::<u64>());
    let mut url = url::Url::parse(&test_database_url()).expect("TEST_DATABASE_URL");
    url.query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={schema}"))
        .append_pair("application_name", &tag);
    let url = url.to_string();
    let security = Security::connect(&url, TEST_KEY).await.expect("security");
    let store = Store::connect(&url, &security, policy)
        .await
        .expect("inbox store");
    Env {
        store: Arc::new(store),
        security,
        schema,
        tag,
        url,
    }
}

/// Small limits, so each limit can be reached in a test.
fn small() -> Policy {
    let mut policy = Policy::pilot(1 << 20);
    policy.subscription_max_pending_events = 10;
    policy.subscription_max_pending_bytes = 4096;
    policy.owner_max_pending_bytes = 8192;
    policy.owner_max_pending_references = 15;
    policy.owner_max_live_subscriptions = 3;
    policy.max_verified_bytes = 4096;
    policy.max_body_bytes = 1024;
    policy.subscription_max_pending_age = Duration::from_secs(DAY);
    policy.receipt_max_per_owner = 50;
    policy.receipt_max_count = 100;
    policy.cleanup_max_jobs_per_owner = 1;
    policy
}

impl Env {
    async fn sql(&self) -> tokio_postgres::Client {
        let (client, connection) = tokio_postgres::connect(&self.url, tokio_postgres::NoTls)
            .await
            .expect("connect");
        tokio::spawn(connection);
        client
    }

    async fn count(&self, query: &str) -> i64 {
        self.sql().await.query_one(query, &[]).await.unwrap().get(0)
    }

    async fn connection(&self, owner: &str) -> String {
        self.security
            .create_connection(PLATFORM, owner, b"{\"fixture\":true}")
            .await
            .expect("connection")
    }

    async fn shared(&self) -> super::store::HookRecord {
        self.store
            .ensure_shared_hook(PLATFORM, at(0))
            .await
            .unwrap()
    }

    async fn subscribe(
        &self,
        owner: &str,
        connection: &str,
        hook: &str,
        key: &str,
        now: SystemTime,
    ) -> Result<SubscriptionView, InboxError> {
        self.store
            .create_subscription(
                NewSubscription {
                    connection_id: connection.into(),
                    owner: owner.into(),
                    consumer: owner.into(),
                    hook_id: hook.into(),
                    source_kind: "project".into(),
                    source_key: key.into(),
                    events: vec!["task".into()],
                },
                now,
            )
            .await
    }

    async fn deliver(
        &self,
        endpoint: &str,
        id: &str,
        key: &str,
        bytes: usize,
        now: SystemTime,
    ) -> IngestOutcome {
        self.store
            .ingest(&delivery(endpoint, id, key, bytes), now)
            .await
            .expect("ingest")
    }

    /// Every counter equals what it counts.
    async fn check_invariants(&self) {
        let client = self.sql().await;
        let bad: i64 = client
            .query_one(
                "SELECT count(*) FROM webhook_subscriptions s WHERE pending_events <>
                   (SELECT count(*) FROM webhook_event_refs r WHERE r.subscription_id = s.subscription_id)
                 OR pending_bytes <> (SELECT coalesce(sum(bytes), 0) FROM webhook_event_refs r
                                      WHERE r.subscription_id = s.subscription_id)",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(bad, 0, "subscription counters");
        let bad: i64 = client
            .query_one(
                "SELECT count(*) FROM webhook_owner_usage o WHERE
                   pending_refs <> (SELECT coalesce(sum(pending_events), 0) FROM webhook_subscriptions s WHERE s.owner = o.owner)
                OR pending_bytes <> (SELECT coalesce(sum(pending_bytes), 0) FROM webhook_subscriptions s WHERE s.owner = o.owner)
                OR live_subscriptions <> (SELECT count(*) FROM webhook_subscriptions s WHERE s.owner = o.owner
                                          AND state IN ('provisioning', 'needs-reconciliation', 'active'))",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(bad, 0, "owner counters");
        let bad: i64 = client
            .query_one(
                "SELECT count(*) FROM webhook_payloads p WHERE references_left <>
                   (SELECT count(*) FROM webhook_event_refs r WHERE r.payload_id = p.payload_id)
                 OR references_left = 0",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(bad, 0, "payload references");
        let row = client
            .query_one(
                "SELECT inbox_bytes, receipts, cleanup_jobs,
                   (SELECT coalesce(sum(bytes + 512), 0) FROM webhook_payloads)::bigint
                     + (SELECT count(*) * 128 FROM webhook_event_refs)::bigint,
                   (SELECT count(*) FROM webhook_receipts),
                   (SELECT count(*) FROM webhook_cleanup_jobs)
                 FROM webhook_deployment_usage",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, i64>(0), row.get::<_, i64>(3), "inbox bytes");
        assert_eq!(row.get::<_, i64>(1), row.get::<_, i64>(4), "receipts");
        assert_eq!(row.get::<_, i64>(2), row.get::<_, i64>(5), "cleanup jobs");
    }

    async fn state(&self, id: &str) -> (String, Option<String>, i64) {
        let row = self
            .sql()
            .await
            .query_one(
                "SELECT state, closed_reason, generation FROM webhook_subscriptions WHERE subscription_id = $1",
                &[&id],
            )
            .await
            .unwrap();
        (row.get(0), row.get(1), row.get(2))
    }

    async fn drop_schema(self) {
        drop(self.store);
        let _ = admin()
            .await
            .batch_execute(&format!("DROP SCHEMA \"{}\" CASCADE", self.schema))
            .await;
    }
}

fn delivery(endpoint: &str, id: &str, key: &str, bytes: usize) -> Delivery {
    let mut body = format!("{{\"kind\":\"task\",\"project\":{{\"id\":\"{key}\"}},\"pad\":\"");
    while body.len() + 2 < bytes {
        body.push('x');
    }
    body.push_str("\"}");
    Delivery {
        endpoint_id: endpoint.into(),
        delivery_id: id.into(),
        event_type: "task".into(),
        action: Some("updated".into()),
        source_kind: "project".into(),
        source_key: key.into(),
        body: body.into_bytes(),
    }
}

fn ended_reason(error: InboxError) -> (String, String) {
    match error {
        InboxError::Ended(result) => (result.state.to_owned(), result.gap.reason),
        other => panic!("expected an ended subscription, got {other:?}"),
    }
}

// --- the abandonment proof -----------------------------------------------------

/// One signup, then nothing from the consumer ever again, while events
/// keep arriving every hour for a month: retention stops at the lease, and
/// after the sweeps nothing of the subscription is left but the shared hook.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn permanent_abandonment_stops_retention_while_events_keep_arriving() {
    let env = env(Policy::pilot(1 << 30)).await;
    let owner = agent("abandoner");
    let connection = env.connection(&owner).await;
    let hook = env.shared().await;
    let sub = env
        .subscribe(&owner, &connection, &hook.hook_id, "p-1", at(0))
        .await
        .unwrap();
    assert_eq!(sub.state, "needs-reconciliation");

    let mut peak_bytes = 0i64;
    for hour in 1..=30 * 24 {
        let now = at(hour * HOUR);
        let outcome = env
            .deliver(&hook.endpoint_id, &format!("d-{hour}"), "p-1", 600, now)
            .await;
        if hour < 7 * 24 {
            assert_eq!(outcome.retained, 1, "hour {hour}");
        } else if hour == 7 * 24 {
            // The lease ends on the request path, in this delivery.
            assert_eq!((outcome.ended, outcome.retained), (1, 0), "hour {hour}");
        } else {
            assert_eq!(
                outcome,
                IngestOutcome::default(),
                "hour {hour}: no state at all"
            );
        }
        if hour % 24 == 0 {
            env.store.sweep(now).await.unwrap();
            peak_bytes = peak_bytes.max(
                env.count("SELECT inbox_bytes FROM webhook_deployment_usage")
                    .await,
            );
        }
    }
    env.check_invariants().await;
    // Bounded by one lease of events: 7 days x 24 x (600 + 512 + 128).
    assert!(peak_bytes <= 7 * 24 * (600 + 640), "peak {peak_bytes}");
    assert_eq!(env.count("SELECT count(*) FROM webhook_payloads").await, 0);
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_event_refs").await,
        0
    );
    assert_eq!(env.count("SELECT count(*) FROM webhook_receipts").await, 0);
    assert_eq!(
        env.count("SELECT inbox_bytes FROM webhook_deployment_usage")
            .await,
        0
    );
    let (state, reason, _) = env.state(&sub.id).await;
    assert_eq!(
        (state.as_str(), reason.as_deref()),
        ("closed", Some("lease-expired"))
    );
    let returned = env
        .store
        .get(&sub.id, &owner, at(31 * DAY))
        .await
        .unwrap_err();
    assert_eq!(
        ended_reason(returned),
        ("expired".into(), "lease-expired".into())
    );

    // The tombstone goes after its TTL; then only the shared hook is left.
    env.store.sweep(at(7 * DAY + 31 * DAY)).await.unwrap();
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_subscriptions")
            .await,
        0
    );
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_owner_usage").await,
        0
    );
    assert_eq!(env.count("SELECT count(*) FROM webhook_hooks").await, 1);
    env.drop_schema().await;
}

/// The sweeper alone also ends an abandoned subscription, with no delivery
/// arriving to trip the request-path check.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn the_sweeper_ends_an_abandoned_subscription_without_deliveries() {
    let env = env(Policy::pilot(1 << 30)).await;
    let owner = agent("quiet");
    let connection = env.connection(&owner).await;
    let hook = env.shared().await;
    let sub = env
        .subscribe(&owner, &connection, &hook.hook_id, "p-1", at(0))
        .await
        .unwrap();
    env.deliver(&hook.endpoint_id, "d-1", "p-1", 100, at(HOUR))
        .await;
    assert_eq!(env.store.sweep(at(7 * DAY - 1)).await.unwrap().ended, 0);
    let report = env.store.sweep(at(7 * DAY)).await.unwrap();
    assert_eq!(report.ended, 1);
    assert_eq!(env.state(&sub.id).await.0, "closed");
    assert_eq!(env.count("SELECT count(*) FROM webhook_payloads").await, 0);
    env.check_invariants().await;
    env.drop_schema().await;
}

// --- leases, progress, access -----------------------------------------------------

/// Renewing every 12 hours without acknowledging anything does not keep a
/// subscription with pending events alive past the progress deadline.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn the_progress_deadline_expires_a_renewing_consumer_that_never_acknowledges() {
    let env = env(Policy::pilot(1 << 30)).await;
    let owner = agent("stuck");
    let connection = env.connection(&owner).await;
    let hook = env.shared().await;
    let stuck = env
        .subscribe(&owner, &connection, &hook.hook_id, "p-1", at(0))
        .await
        .unwrap();
    let helper = agent("healthy");
    let helper_connection = env.connection(&helper).await;
    let healthy = env
        .subscribe(&helper, &helper_connection, &hook.hook_id, "p-1", at(0))
        .await
        .unwrap();

    // Pending becomes non-empty at hour 2: the deadline is hour 2 + 7 days.
    env.deliver(&hook.endpoint_id, "d-1", "p-1", 100, at(2 * HOUR))
        .await;
    let mut half_days = 1;
    loop {
        let now = at(half_days * 12 * HOUR);
        let renewed = env
            .store
            .renew(&stuck.id, &owner, AccessCheck::Passed, now)
            .await;
        // The healthy consumer acknowledges what it has, then renews.
        let page = env
            .store
            .fetch(&healthy.id, &helper, None, 100, now)
            .await
            .unwrap();
        if let Some(next) = &page.next {
            env.store
                .acknowledge(&healthy.id, &helper, next, now)
                .await
                .unwrap();
        }
        env.store
            .renew(&healthy.id, &helper, AccessCheck::Passed, now)
            .await
            .unwrap();
        if now < at(2 * HOUR + 7 * DAY) {
            assert!(renewed.is_ok(), "half-day {half_days}");
            assert_eq!(
                renewed
                    .unwrap()
                    .lease
                    .unwrap()
                    .progress_deadline_at
                    .unwrap(),
                super::store::rfc3339(at(2 * HOUR + 7 * DAY))
            );
        } else {
            let (state, reason) = ended_reason(renewed.unwrap_err());
            assert_eq!(
                (state.as_str(), reason.as_str()),
                ("expired", "progress-stalled")
            );
            break;
        }
        // More events keep arriving; they do not move the deadline.
        env.deliver(
            &hook.endpoint_id,
            &format!("d-{half_days}x"),
            "p-1",
            100,
            now,
        )
        .await;
        half_days += 1;
    }
    let healthy_now = env
        .store
        .get(&healthy.id, &helper, at(8 * DAY))
        .await
        .unwrap();
    assert!(matches!(
        healthy_now.state,
        "active" | "needs-reconciliation"
    ));
    env.check_invariants().await;
    env.drop_schema().await;
}

/// The deadline is measured from the later of the last acknowledgement and
/// the moment pending became non-empty, and is cleared while nothing is
/// pending.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn the_progress_deadline_restarts_when_pending_becomes_non_empty() {
    let env = env(Policy::pilot(1 << 30)).await;
    let owner = agent("progress");
    let connection = env.connection(&owner).await;
    let hook = env.shared().await;
    let sub = env
        .subscribe(&owner, &connection, &hook.hook_id, "p-1", at(0))
        .await
        .unwrap();
    env.deliver(&hook.endpoint_id, "d-1", "p-1", 100, at(HOUR))
        .await;
    env.deliver(&hook.endpoint_id, "d-2", "p-1", 100, at(2 * HOUR))
        .await;
    let page = env
        .store
        .fetch(&sub.id, &owner, None, 1, at(3 * HOUR))
        .await
        .unwrap();
    env.store
        .acknowledge(&sub.id, &owner, page.next.as_ref().unwrap(), at(3 * DAY))
        .await
        .unwrap();
    let view = env.store.get(&sub.id, &owner, at(3 * DAY)).await.unwrap();
    assert_eq!(
        view.lease.unwrap().progress_deadline_at.unwrap(),
        super::store::rfc3339(at(3 * DAY + 7 * DAY)),
        "an advancing acknowledgement restarts it"
    );
    env.store
        .renew(&sub.id, &owner, AccessCheck::Passed, at(3 * DAY))
        .await
        .unwrap();
    let page = env
        .store
        .fetch(&sub.id, &owner, None, 10, at(3 * DAY))
        .await
        .unwrap();
    env.store
        .acknowledge(&sub.id, &owner, page.next.as_ref().unwrap(), at(4 * DAY))
        .await
        .unwrap();
    let view = env.store.get(&sub.id, &owner, at(4 * DAY)).await.unwrap();
    assert_eq!(view.lease.unwrap().progress_deadline_at, None);
    env.store
        .renew(&sub.id, &owner, AccessCheck::Passed, at(5 * DAY))
        .await
        .unwrap();
    env.deliver(&hook.endpoint_id, "d-3", "p-1", 100, at(6 * DAY))
        .await;
    let view = env.store.get(&sub.id, &owner, at(6 * DAY)).await.unwrap();
    assert_eq!(
        view.lease.unwrap().progress_deadline_at.unwrap(),
        super::store::rfc3339(at(6 * DAY + 7 * DAY))
    );
    env.drop_schema().await;
}

/// No events are served while the last passing access check is older than
/// `access.maxCheckAgeSeconds`, however the consumer renews (rule 2 of the
/// review); a failed check closes, an unavailable one changes nothing.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn events_are_served_only_after_a_recent_passing_access_check() {
    let env = env(Policy::pilot(1 << 30)).await;
    let owner = agent("access");
    let connection = env.connection(&owner).await;
    let hook = env.shared().await;
    let sub = env
        .subscribe(&owner, &connection, &hook.hook_id, "p-1", at(0))
        .await
        .unwrap();
    env.deliver(&hook.endpoint_id, "d-1", "p-1", 100, at(HOUR))
        .await;
    assert!(env
        .store
        .fetch(&sub.id, &owner, None, 10, at(12 * HOUR))
        .await
        .is_ok());
    assert!(matches!(
        env.store
            .fetch(&sub.id, &owner, None, 10, at(12 * HOUR + 1))
            .await,
        Err(InboxError::AccessCheckRequired)
    ));
    assert!(matches!(
        env.store
            .record_access_check(&sub.id, &owner, AccessCheck::Unavailable, at(13 * HOUR))
            .await,
        Err(InboxError::AccessUnavailable)
    ));
    assert!(matches!(
        env.store
            .fetch(&sub.id, &owner, None, 10, at(13 * HOUR))
            .await,
        Err(InboxError::AccessCheckRequired)
    ));
    env.store
        .record_access_check(&sub.id, &owner, AccessCheck::Passed, at(13 * HOUR))
        .await
        .unwrap();
    let page = env
        .store
        .fetch(&sub.id, &owner, None, 10, at(13 * HOUR))
        .await
        .unwrap();
    assert_eq!(page.events.len(), 1);
    let failed = env
        .store
        .record_access_check(&sub.id, &owner, AccessCheck::Failed, at(14 * HOUR))
        .await
        .unwrap_err();
    assert_eq!(
        ended_reason(failed),
        ("closed".into(), "access-denied".into())
    );
    assert_eq!(env.count("SELECT count(*) FROM webhook_payloads").await, 0);
    env.check_invariants().await;
    env.drop_schema().await;
}

/// Rule 3: `expired` is never left standing. The stored state is closed in
/// the same transaction, the result says `expired`, and the owner's quota
/// is free again.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn expiry_closes_at_once_and_frees_the_owners_quota() {
    let env = env(small()).await;
    let owner = agent("quota");
    let connection = env.connection(&owner).await;
    let hook = env.shared().await;
    let mut subs = Vec::new();
    for key in ["a", "b", "c"] {
        subs.push(
            env.subscribe(&owner, &connection, &hook.hook_id, key, at(0))
                .await
                .unwrap(),
        );
    }
    assert!(matches!(
        env.subscribe(&owner, &connection, &hook.hook_id, "d", at(0))
            .await,
        Err(InboxError::QuotaExceeded)
    ));
    // Only the first is left to expire.
    for sub in &subs[1..] {
        env.store
            .renew(&sub.id, &owner, AccessCheck::Passed, at(6 * DAY))
            .await
            .unwrap();
    }
    // Creating a subscription at the quota ends the expired one first.
    let fourth = env
        .subscribe(&owner, &connection, &hook.hook_id, "d", at(7 * DAY))
        .await
        .unwrap();
    assert_eq!(fourth.state, "needs-reconciliation");
    assert_eq!(env.state(&subs[0].id).await.0, "closed");
    let error = env
        .store
        .get(&subs[0].id, &owner, at(7 * DAY))
        .await
        .unwrap_err();
    assert_eq!(
        ended_reason(error),
        ("expired".into(), "lease-expired".into())
    );
    env.check_invariants().await;
    env.drop_schema().await;
}

// --- routing, receipts, gaps -----------------------------------------------------

/// Rule 1: a subscription in `needs-reconciliation` (a new one) is routed
/// to; rule 8: an unrouted delivery leaves nothing, a duplicate is caught
/// per owner, receipts are per owner.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn new_subscriptions_receive_events_and_receipts_are_per_owner() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let alice = agent("alice");
    let bob = agent("bob");
    let alice_connection = env.connection(&alice).await;
    let bob_connection = env.connection(&bob).await;
    let a = env
        .subscribe(&alice, &alice_connection, &hook.hook_id, "p-1", at(0))
        .await
        .unwrap();
    assert_eq!(a.state, "needs-reconciliation");

    let unrouted = env
        .deliver(&hook.endpoint_id, "d-0", "p-unknown", 100, at(1))
        .await;
    assert_eq!(unrouted, IngestOutcome::default());
    assert_eq!(env.count("SELECT count(*) FROM webhook_receipts").await, 0);

    assert_eq!(
        env.deliver(&hook.endpoint_id, "d-1", "p-1", 100, at(2))
            .await
            .retained,
        1
    );
    let again = env
        .deliver(&hook.endpoint_id, "d-1", "p-1", 100, at(3))
        .await;
    assert_eq!((again.retained, again.duplicates), (0, 1));

    // Bob subscribes later; the same delivery id is new for him.
    env.subscribe(&bob, &bob_connection, &hook.hook_id, "p-1", at(4))
        .await
        .unwrap();
    let redelivered = env
        .deliver(&hook.endpoint_id, "d-1", "p-1", 100, at(5))
        .await;
    assert_eq!((redelivered.retained, redelivered.duplicates), (1, 1));
    assert_eq!(env.count("SELECT count(*) FROM webhook_receipts").await, 2);
    // After the receipt TTL a redelivery is new again.
    let late = env
        .deliver(&hook.endpoint_id, "d-1", "p-1", 100, at(2 * DAY + 3))
        .await;
    assert_eq!(late.retained, 1);

    let page = env
        .store
        .fetch(&a.id, &alice, None, 10, at(2 * DAY + 4))
        .await;
    assert!(matches!(page, Err(InboxError::AccessCheckRequired)));
    env.store
        .record_access_check(&a.id, &alice, AccessCheck::Passed, at(2 * DAY + 4))
        .await
        .unwrap();
    let page = env
        .store
        .fetch(&a.id, &alice, None, 10, at(2 * DAY + 4))
        .await
        .unwrap();
    // The first copy passed the one-day age limit on the way: a gap, and
    // only the late copy is left.
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.generation, "g2");
    assert_eq!(
        page.reconciliation_required.as_ref().unwrap().gap.reason,
        "subscription-age-limit"
    );
    env.check_invariants().await;
    env.drop_schema().await;
}

/// A connection of another platform cannot subscribe on this platform's
/// hook (bindings are scoped by document).
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_connection_subscribes_only_on_its_own_platforms_hooks() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("other-platform");
    let connection = env
        .security
        .create_connection("another-platform", &owner, b"{}")
        .await
        .unwrap();
    assert!(matches!(
        env.subscribe(&owner, &connection, &hook.hook_id, "p-1", at(0))
            .await,
        Err(InboxError::UnknownConnection)
    ));
    let someone_else = agent("thief");
    let own = env.connection(&owner).await;
    assert!(matches!(
        env.subscribe(&someone_else, &own, &hook.hook_id, "p-1", at(0))
            .await,
        Err(InboxError::UnknownConnection)
    ));
    env.drop_schema().await;
}

/// The receipt floor (re-review point 1): at an owner's cap, with every
/// receipt younger than the minimum age, the delivery is stored for nobody
/// of that owner, a gap is recorded, and other owners are not affected.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn the_receipt_floor_records_a_gap_for_that_owner_only() {
    let mut policy = small();
    policy.receipt_max_per_owner = 3;
    let env = env(policy).await;
    let hook = env.shared().await;
    let busy = agent("busy");
    let calm = agent("calm");
    let busy_connection = env.connection(&busy).await;
    let calm_connection = env.connection(&calm).await;
    let b = env
        .subscribe(&busy, &busy_connection, &hook.hook_id, "hot", at(0))
        .await
        .unwrap();
    let c = env
        .subscribe(&calm, &calm_connection, &hook.hook_id, "hot", at(0))
        .await
        .unwrap();
    for n in 0..3 {
        let outcome = env
            .deliver(&hook.endpoint_id, &format!("d-{n}"), "hot", 100, at(10 + n))
            .await;
        assert_eq!(outcome.retained, 2);
    }
    // Both owners have 3 receipts, all younger than 1800 s.
    let floor = env
        .deliver(&hook.endpoint_id, "d-3", "hot", 100, at(20))
        .await;
    assert_eq!(
        (floor.retained, floor.gaps),
        (0, 2),
        "both at their own cap"
    );
    let (_, _, generation) = env.state(&b.id).await;
    assert_eq!(generation, 2);
    // A replay of the floored delivery adds no state, only another gap.
    let payloads = env.count("SELECT count(*) FROM webhook_payloads").await;
    env.deliver(&hook.endpoint_id, "d-3", "hot", 100, at(21))
        .await;
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_payloads").await,
        payloads
    );
    assert_eq!(env.count("SELECT count(*) FROM webhook_receipts").await, 6);
    // Once the oldest receipt is old enough to evict, deliveries are kept.
    let later = env
        .deliver(&hook.endpoint_id, "d-4", "hot", 100, at(10 + 1800))
        .await;
    assert_eq!(later.retained, 2);
    let _ = c;
    env.check_invariants().await;
    env.drop_schema().await;
}

/// Each limit records a gap before history is lost, and the gap starts a
/// new generation only when the current generation loses an event.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn every_limit_records_a_gap_before_history_is_lost() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("limits");
    let connection = env.connection(&owner).await;

    // Events limit: 10 retained, the 11th evicts the oldest of generation 1.
    let events = env
        .subscribe(&owner, &connection, &hook.hook_id, "events", at(0))
        .await
        .unwrap();
    for n in 0..11 {
        env.deliver(
            &hook.endpoint_id,
            &format!("e-{n}"),
            "events",
            50,
            at(1 + n),
        )
        .await;
    }
    let view = env.store.get(&events.id, &owner, at(20)).await.unwrap();
    assert_eq!(view.pending.events, 10);
    let gap = view.reconciliation_required.unwrap().gap;
    assert_eq!(
        (gap.reason.as_str(), gap.generation.as_deref()),
        ("subscription-events-limit", Some("g1"))
    );
    assert!(
        gap.earliest_available_cursor.is_some(),
        "recent events of generation 1 are still there"
    );
    assert_eq!(view.generation.as_deref(), Some("g2"));
    // Evicting the rest of generation 1 does not start generation 3.
    for n in 11..20 {
        env.deliver(
            &hook.endpoint_id,
            &format!("e-{n}"),
            "events",
            50,
            at(1 + n),
        )
        .await;
    }
    assert_eq!(env.state(&events.id).await.2, 2);
    env.store.delete(&events.id, &owner, at(30)).await.unwrap();

    // Bytes limit: 4096 bytes per subscription.
    let bytes = env
        .subscribe(&owner, &connection, &hook.hook_id, "bytes", at(30))
        .await
        .unwrap();
    for n in 0..5 {
        env.deliver(
            &hook.endpoint_id,
            &format!("b-{n}"),
            "bytes",
            1000,
            at(31 + n),
        )
        .await;
    }
    let view = env.store.get(&bytes.id, &owner, at(40)).await.unwrap();
    assert_eq!(view.pending.events, 4);
    assert_eq!(
        view.reconciliation_required.unwrap().gap.reason,
        "subscription-bytes-limit"
    );
    env.store.delete(&bytes.id, &owner, at(40)).await.unwrap();

    // Oversized: over the retention cap, routed but not retained.
    let big = env
        .subscribe(&owner, &connection, &hook.hook_id, "big", at(40))
        .await
        .unwrap();
    let outcome = env
        .deliver(&hook.endpoint_id, "big-1", "big", 2000, at(41))
        .await;
    assert_eq!((outcome.retained, outcome.gaps), (0, 1));
    let view = env.store.get(&big.id, &owner, at(42)).await.unwrap();
    assert_eq!(
        view.reconciliation_required.unwrap().gap.reason,
        "oversized-delivery"
    );

    // Age limit: on the request path and in the sweep.
    env.store
        .renew(&big.id, &owner, AccessCheck::Passed, at(42))
        .await
        .unwrap();
    env.deliver(&hook.endpoint_id, "age-1", "big", 100, at(50))
        .await;
    env.store
        .complete_reconciliation(
            &big.id,
            &owner,
            view.generation.as_deref().unwrap(),
            view_barrier(&env, &big.id, &owner, at(51)).await.as_str(),
            AccessCheck::Passed,
            at(51),
        )
        .await
        .unwrap();
    let report = env.store.sweep(at(50 + DAY + 1)).await.unwrap();
    assert_eq!(report.aged_out, 1);
    let view = env
        .store
        .get(&big.id, &owner, at(50 + DAY + 2))
        .await
        .unwrap();
    assert_eq!(view.state, "needs-reconciliation");
    assert_eq!(
        view.reconciliation_required.unwrap().gap.reason,
        "subscription-age-limit"
    );
    env.check_invariants().await;
    env.drop_schema().await;
}

async fn view_barrier(env: &Env, id: &str, consumer: &str, now: SystemTime) -> String {
    env.store
        .get(id, consumer, now)
        .await
        .unwrap()
        .reconciliation_required
        .unwrap()
        .barrier
        .unwrap()
}

/// An owner's subscriptions share one budget: the receiving subscription
/// evicts its own oldest, never another's.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn the_owner_budget_evicts_only_the_receiving_subscriptions_history() {
    let mut policy = small();
    policy.owner_max_pending_references = 12;
    let env = env(policy).await;
    let hook = env.shared().await;
    let owner = agent("budget");
    let connection = env.connection(&owner).await;
    let first = env
        .subscribe(&owner, &connection, &hook.hook_id, "one", at(0))
        .await
        .unwrap();
    let second = env
        .subscribe(&owner, &connection, &hook.hook_id, "two", at(0))
        .await
        .unwrap();
    for n in 0..8 {
        env.deliver(&hook.endpoint_id, &format!("one-{n}"), "one", 10, at(1 + n))
            .await;
    }
    for n in 0..5 {
        env.deliver(
            &hook.endpoint_id,
            &format!("two-{n}"),
            "two",
            10,
            at(20 + n),
        )
        .await;
    }
    let view = env.store.get(&second.id, &owner, at(30)).await.unwrap();
    assert_eq!(view.pending.events, 4);
    assert_eq!(
        view.reconciliation_required.unwrap().gap.reason,
        "owner-limit"
    );
    let view = env.store.get(&first.id, &owner, at(30)).await.unwrap();
    assert_eq!(
        view.pending.events, 8,
        "the other subscription's history is untouched"
    );
    env.check_invariants().await;
    env.drop_schema().await;
}

/// A full deployment records a gap for the delivering owner instead of
/// evicting another owner's history.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_full_deployment_records_gaps_without_evicting_other_owners() {
    let mut policy = small();
    policy.deployment_max_inbox_bytes = 8192;
    let env = env(policy).await;
    let hook = env.shared().await;
    let keeper = agent("keeper");
    let filler = agent("filler");
    let kc = env.connection(&keeper).await;
    let fc = env.connection(&filler).await;
    let kept = env
        .subscribe(&keeper, &kc, &hook.hook_id, "keep", at(0))
        .await
        .unwrap();
    let fill = env
        .subscribe(&filler, &fc, &hook.hook_id, "fill", at(0))
        .await
        .unwrap();
    for n in 0..2 {
        assert_eq!(
            env.deliver(&hook.endpoint_id, &format!("k-{n}"), "keep", 10, at(1 + n))
                .await
                .retained,
            1
        );
    }
    let mut gaps = 0;
    for n in 0..10 {
        gaps += env
            .deliver(&hook.endpoint_id, &format!("f-{n}"), "fill", 10, at(10 + n))
            .await
            .gaps;
    }
    assert!(gaps > 0);
    let view = env.store.get(&fill.id, &filler, at(30)).await.unwrap();
    assert_eq!(
        view.reconciliation_required.unwrap().gap.reason,
        "deployment-limit"
    );
    assert_eq!(
        env.store
            .get(&kept.id, &keeper, at(30))
            .await
            .unwrap()
            .pending
            .events,
        2
    );
    assert!(
        env.count("SELECT inbox_bytes FROM webhook_deployment_usage")
            .await
            <= 8192
    );
    env.check_invariants().await;
    env.drop_schema().await;
}

/// A payload retained for two subscriptions is stored once, counted for
/// both owners, and reclaimed only when both let it go.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_shared_payload_is_reclaimed_after_its_last_reference() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let alice = agent("share-a");
    let bob = agent("share-b");
    let ac = env.connection(&alice).await;
    let bc = env.connection(&bob).await;
    let a = env
        .subscribe(&alice, &ac, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    let b = env
        .subscribe(&bob, &bc, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    env.deliver(&hook.endpoint_id, "d-1", "p", 300, at(1)).await;
    assert_eq!(env.count("SELECT count(*) FROM webhook_payloads").await, 1);
    assert_eq!(
        env.count("SELECT sum(pending_bytes)::bigint FROM webhook_owner_usage")
            .await,
        600
    );
    let page = env
        .store
        .fetch(&a.id, &alice, None, 10, at(2))
        .await
        .unwrap();
    env.store
        .acknowledge(&a.id, &alice, page.next.as_ref().unwrap(), at(3))
        .await
        .unwrap();
    assert_eq!(env.count("SELECT count(*) FROM webhook_payloads").await, 1);
    env.check_invariants().await;
    // Bob never acknowledges; his subscription ends instead.
    env.store.delete(&b.id, &bob, at(4)).await.unwrap();
    assert_eq!(env.count("SELECT count(*) FROM webhook_payloads").await, 0);
    assert_eq!(
        env.count("SELECT inbox_bytes FROM webhook_deployment_usage")
            .await,
        0
    );
    env.check_invariants().await;
    env.drop_schema().await;
}

// --- cursors and reconciliation --------------------------------------------------------

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn cursors_are_refused_when_forged_ahead_obsolete_or_foreign() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("cursor");
    let connection = env.connection(&owner).await;
    let sub = env
        .subscribe(&owner, &connection, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    let other = env
        .subscribe(&owner, &connection, &hook.hook_id, "q", at(0))
        .await
        .unwrap();
    for n in 0..3 {
        env.deliver(&hook.endpoint_id, &format!("d-{n}"), "p", 50, at(1 + n))
            .await;
        env.deliver(&hook.endpoint_id, &format!("q-{n}"), "q", 50, at(1 + n))
            .await;
    }
    let page = env
        .store
        .fetch(&sub.id, &owner, None, 1, at(10))
        .await
        .unwrap();
    let first = page.next.clone().unwrap();
    let other_page = env
        .store
        .fetch(&other.id, &owner, None, 1, at(10))
        .await
        .unwrap();
    let cursors =
        super::cursor::CursorKey::new(env.security.derive_subkey(super::cursor::SUBKEY_LABEL));
    // Correctly signed, but never returned: ahead.
    let ahead = cursors.encode(&sub.id, 1, 3);
    assert!(matches!(
        env.store.acknowledge(&sub.id, &owner, &ahead, at(11)).await,
        Err(InboxError::CursorAhead)
    ));
    // Signed with another key: not issued.
    let forged = super::cursor::CursorKey::new([9; 32]).encode(&sub.id, 1, 1);
    assert!(matches!(
        env.store
            .acknowledge(&sub.id, &owner, &forged, at(11))
            .await,
        Err(InboxError::CursorNotIssued)
    ));
    // Another subscription's cursor: not issued for this one.
    assert!(matches!(
        env.store
            .acknowledge(&sub.id, &owner, other_page.next.as_ref().unwrap(), at(11))
            .await,
        Err(InboxError::CursorNotIssued)
    ));
    // A generation that is neither current nor the gap's.
    let obsolete = cursors.encode(&sub.id, 7, 1);
    assert!(matches!(
        env.store
            .acknowledge(&sub.id, &owner, &obsolete, at(11))
            .await,
        Err(InboxError::ObsoleteGeneration)
    ));
    // Someone else's subscription is unknown to them.
    assert!(matches!(
        env.store
            .fetch(&sub.id, &agent("stranger"), None, 1, at(11))
            .await,
        Err(InboxError::UnknownSubscription)
    ));
    // Acknowledgement is monotonic.
    env.store
        .acknowledge(&sub.id, &owner, &first, at(12))
        .await
        .unwrap();
    let again = env
        .store
        .acknowledge(&sub.id, &owner, &first, at(13))
        .await
        .unwrap();
    assert_eq!(again.cursor, first);
    env.check_invariants().await;
    env.drop_schema().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn reconciliation_completes_only_for_the_current_generation_and_barrier() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("reconcile");
    let connection = env.connection(&owner).await;
    let sub = env
        .subscribe(&owner, &connection, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    let initial = sub.reconciliation_required.clone().unwrap();
    assert_eq!(initial.gap.reason, "initial");
    assert_eq!(initial.gap.generation, None);
    let barrier = initial.barrier.unwrap();
    assert!(matches!(
        env.store
            .complete_reconciliation(&sub.id, &owner, "g2", &barrier, AccessCheck::Passed, at(1))
            .await,
        Err(InboxError::ObsoleteGeneration)
    ));
    let wrong =
        super::cursor::CursorKey::new(env.security.derive_subkey(super::cursor::SUBKEY_LABEL))
            .encode(&sub.id, 1, 5);
    assert!(matches!(
        env.store
            .complete_reconciliation(&sub.id, &owner, "g1", &wrong, AccessCheck::Passed, at(1))
            .await,
        Err(InboxError::BarrierMismatch)
    ));
    let done = env
        .store
        .complete_reconciliation(&sub.id, &owner, "g1", &barrier, AccessCheck::Passed, at(1))
        .await
        .unwrap();
    assert_eq!(done.state, "active");
    assert!(done.reconciliation_required.is_none());
    assert!(matches!(
        env.store
            .complete_reconciliation(&sub.id, &owner, "g1", &barrier, AccessCheck::Passed, at(2))
            .await,
        Err(InboxError::NotReconciling)
    ));
    let json = serde_json::to_value(&done).unwrap();
    for field in [
        "id",
        "connection",
        "consumer",
        "source",
        "events",
        "hook",
        "state",
        "generation",
        "lease",
        "acknowledged",
        "pending",
        "createdAt",
    ] {
        assert!(json.get(field).is_some(), "{field}");
    }
    assert!(json["lease"].get("progressDeadlineAt").is_some());
    env.drop_schema().await;
}

/// Deleting the connection stops reads at once; deliveries are no longer
/// routed; the sweeper releases the rest.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn deleting_the_connection_stops_reads_at_once() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("leaver");
    let connection = env.connection(&owner).await;
    let sub = env
        .subscribe(&owner, &connection, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    let other = env
        .subscribe(&owner, &connection, &hook.hook_id, "q", at(0))
        .await
        .unwrap();
    env.deliver(&hook.endpoint_id, "d-1", "p", 50, at(1)).await;
    env.deliver(&hook.endpoint_id, "q-1", "q", 50, at(1)).await;
    assert!(env
        .security
        .delete_connection(&connection, &owner)
        .await
        .unwrap());
    let error = env
        .store
        .fetch(&sub.id, &owner, None, 10, at(2))
        .await
        .unwrap_err();
    assert_eq!(
        ended_reason(error),
        ("closed".into(), "connection-deleted".into())
    );
    assert_eq!(
        env.deliver(&hook.endpoint_id, "q-2", "q", 50, at(3))
            .await
            .routed,
        0
    );
    assert_eq!(env.store.sweep(at(4)).await.unwrap().ended, 1);
    assert_eq!(
        env.state(&other.id).await.1.as_deref(),
        Some("connection-deleted")
    );
    assert_eq!(env.count("SELECT count(*) FROM webhook_payloads").await, 0);
    env.check_invariants().await;
    env.drop_schema().await;
}

// --- hooks ---------------------------------------------------------------------------

/// The shared hook is never touched when its subscriptions end.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_shared_hook_outlives_every_subscription() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("shared");
    let connection = env.connection(&owner).await;
    let sub = env
        .subscribe(&owner, &connection, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    env.store.delete(&sub.id, &owner, at(1)).await.unwrap();
    assert_eq!(env.state(&sub.id).await.0, "closed");
    env.store.sweep(at(40 * DAY)).await.unwrap();
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_hooks WHERE state = 'active'")
            .await,
        1
    );
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_cleanup_jobs").await,
        0
    );
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_subscriptions")
            .await,
        0,
        "tombstone purged"
    );
    let same = env.store.ensure_shared_hook(PLATFORM, at(2)).await.unwrap();
    assert_eq!(same.endpoint_id, hook.endpoint_id);
    env.drop_schema().await;
}

struct ScriptedDeleter {
    answers: Mutex<VecDeque<Result<(), CleanupError>>>,
    calls: Mutex<Vec<HookToDelete>>,
}

impl ScriptedDeleter {
    fn new(answers: Vec<Result<(), CleanupError>>) -> Self {
        Self {
            answers: Mutex::new(answers.into()),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl HookDeleter for ScriptedDeleter {
    fn delete(
        &self,
        hook: &HookToDelete,
    ) -> impl std::future::Future<Output = Result<(), CleanupError>> + Send {
        self.calls.lock().unwrap().push(hook.clone());
        let answer = self.answers.lock().unwrap().pop_front().unwrap_or(Ok(()));
        async move { answer }
    }
}

async fn dedicated(
    env: &Env,
    owner: &str,
    connection: &str,
    key: &str,
    now: SystemTime,
) -> super::store::HookRecord {
    let hook = env
        .store
        .create_dedicated_hook(
            PLATFORM,
            "project",
            key,
            "{\"projectId\":\"fixture\"}",
            owner,
            connection,
            "sealed-fixture-envelope",
            now,
        )
        .await
        .unwrap();
    hook
}

/// A dedicated hook: subscriptions wait in `provisioning`, management
/// moves on when its connection's subscription ends, the last subscription
/// starts a cleanup job, which retries and then closes everything.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_dedicated_hook_is_handed_over_and_cleaned_up() {
    let env = env(small()).await;
    let creator = agent("creator");
    let heir = agent("heir");
    let cc = env.connection(&creator).await;
    let hc = env.connection(&heir).await;
    let hook = dedicated(&env, &creator, &cc, "p", at(0)).await;
    let first = env
        .subscribe(&creator, &cc, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    assert_eq!(first.state, "provisioning");
    assert_eq!(
        env.deliver(&hook.endpoint_id, "d-0", "p", 50, at(1))
            .await
            .routed,
        0
    );
    env.store
        .hook_provisioned(&hook.hook_id, "provider-hook-1", at(2))
        .await
        .unwrap();
    assert_eq!(
        env.store
            .get(&first.id, &creator, at(3))
            .await
            .unwrap()
            .state,
        "needs-reconciliation"
    );
    let second = env
        .subscribe(&heir, &hc, &hook.hook_id, "p", at(3))
        .await
        .unwrap();

    env.store.delete(&first.id, &creator, at(4)).await.unwrap();
    let manager: String = env
        .sql()
        .await
        .query_one(
            "SELECT management_connection_id FROM webhook_hooks WHERE hook_id = $1",
            &[&hook.hook_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        manager, hc,
        "management moved to the remaining subscription"
    );
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_cleanup_jobs").await,
        0
    );

    env.store.delete(&second.id, &heir, at(5)).await.unwrap();
    assert_eq!(env.state(&second.id).await.0, "cleanup-pending");
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_cleanup_jobs").await,
        1
    );
    env.check_invariants().await;

    let deleter = ScriptedDeleter::new(vec![Err(CleanupError::Retry("unavailable")), Ok(())]);
    let report = env.store.run_cleanup(&deleter, at(6)).await.unwrap();
    assert_eq!(report.retried, 1);
    // Not due again until the backoff has passed.
    assert_eq!(
        env.store.run_cleanup(&deleter, at(7)).await.unwrap(),
        Default::default()
    );
    let report = env.store.run_cleanup(&deleter, at(6 + 120)).await.unwrap();
    assert_eq!(report.deleted, 1);
    let calls = deleter.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0].management_connection_id.as_deref(),
        Some(hc.as_str())
    );
    assert_eq!(calls[0].hook_id, hook.hook_id);
    assert_eq!(
        (calls[0].platform.as_str(), calls[0].source_kind.as_str()),
        (PLATFORM, "project")
    );
    assert_eq!(
        calls[0].provider_hook_id.as_deref(),
        Some("provider-hook-1")
    );
    assert_eq!(calls[0].source_key, "p");
    assert_eq!(calls[0].access_parameters, "{\"projectId\":\"fixture\"}");
    assert_eq!(env.state(&second.id).await.0, "closed");
    assert_eq!(
        env.count(
            "SELECT count(*) FROM webhook_hooks WHERE state = 'closed' AND NOT cleanup_failed"
        )
        .await,
        1
    );
    env.check_invariants().await;
    env.store.sweep(at(40 * DAY)).await.unwrap();
    assert_eq!(env.count("SELECT count(*) FROM webhook_hooks").await, 0);
    env.drop_schema().await;
}

/// A cleanup that cannot succeed fails visibly, at once or at its deadline;
/// one owner's pending cleanups never block another owner's dedicated
/// subscriptions.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn failing_cleanups_are_bounded_per_owner() {
    let env = env(small()).await;
    let alice = agent("cleanup-a");
    let bob = agent("cleanup-b");
    let ac = env.connection(&alice).await;
    let bc = env.connection(&bob).await;
    let hook = dedicated(&env, &alice, &ac, "a-1", at(0)).await;
    env.store
        .hook_provisioned(&hook.hook_id, "provider-hook", at(0))
        .await
        .unwrap();
    let sub = env
        .subscribe(&alice, &ac, &hook.hook_id, "a-1", at(0))
        .await
        .unwrap();
    env.store.delete(&sub.id, &alice, at(1)).await.unwrap();
    // Alice is at her cap of 1 pending cleanup; Bob is not affected.
    let refused = env
        .store
        .create_dedicated_hook(
            PLATFORM,
            "project",
            "a-2",
            "{}",
            &alice,
            &ac,
            "sealed",
            at(2),
        )
        .await;
    assert!(matches!(refused, Err(InboxError::CapacityUnavailable)));
    let bobs = dedicated(&env, &bob, &bc, "b-1", at(2)).await;
    // Cleanup keeps failing until its 30-day deadline.
    let deleter = ScriptedDeleter::new(vec![Err(CleanupError::Retry("unavailable")); 64]);
    let mut now = 3;
    while env.count("SELECT count(*) FROM webhook_cleanup_jobs").await > 0 {
        env.store.run_cleanup(&deleter, at(now)).await.unwrap();
        now += DAY;
        assert!(now < 32 * DAY, "the deadline ends it");
    }
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_hooks WHERE cleanup_failed")
            .await,
        1
    );
    assert_eq!(env.state(&sub.id).await.0, "closed");
    // A permanent failure ends at once.
    env.store
        .hook_provisioned(&bobs.hook_id, "provider-hook-b", at(now))
        .await
        .unwrap();
    let bsub = env
        .subscribe(&bob, &bc, &bobs.hook_id, "b-1", at(now))
        .await
        .unwrap();
    env.store
        .renew(&bsub.id, &bob, AccessCheck::Passed, at(now))
        .await
        .unwrap();
    env.store.delete(&bsub.id, &bob, at(now + 1)).await.unwrap();
    let deleter = ScriptedDeleter::new(vec![Err(CleanupError::Permanent("key-changed"))]);
    assert_eq!(
        env.store
            .run_cleanup(&deleter, at(now + 2))
            .await
            .unwrap()
            .failed,
        1
    );
    assert_eq!(env.state(&bsub.id).await.0, "closed");
    env.check_invariants().await;
    env.drop_schema().await;
}

/// A hook the provider never created closes its waiting subscriptions.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn failed_provisioning_closes_the_waiting_subscriptions() {
    let env = env(small()).await;
    let owner = agent("unlucky");
    let connection = env.connection(&owner).await;
    let hook = dedicated(&env, &owner, &connection, "p", at(0)).await;
    let sub = env
        .subscribe(&owner, &connection, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    env.store
        .hook_provisioning_failed(&hook.hook_id, at(1))
        .await
        .unwrap();
    let error = env.store.get(&sub.id, &owner, at(2)).await.unwrap_err();
    assert_eq!(
        ended_reason(error),
        ("closed".into(), "provisioning-failed".into())
    );
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_hooks WHERE state = 'closed'")
            .await,
        1
    );
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_cleanup_jobs").await,
        0
    );
    env.check_invariants().await;
    env.drop_schema().await;
}

// --- races ---------------------------------------------------------------------------

/// Thirty concurrent deliveries to a subscription with room for ten keep it
/// at ten, with every counter right.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn concurrent_deliveries_stay_within_the_limits() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("race");
    let connection = env.connection(&owner).await;
    let sub = env
        .subscribe(&owner, &connection, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    let second = env
        .subscribe(&owner, &connection, &hook.hook_id, "q", at(0))
        .await
        .unwrap();
    let barrier = Arc::new(Barrier::new(40));
    let mut tasks = tokio::task::JoinSet::new();
    for n in 0..40 {
        let store = env.store.clone();
        let barrier = barrier.clone();
        let endpoint = hook.endpoint_id.clone();
        tasks.spawn(async move {
            barrier.wait().await;
            let key = if n % 4 == 0 { "q" } else { "p" };
            store
                .ingest(&delivery(&endpoint, &format!("d-{n}"), key, 100), at(1))
                .await
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap().expect("no transaction failed");
    }
    let p = env.store.get(&sub.id, &owner, at(2)).await.unwrap();
    let q = env.store.get(&second.id, &owner, at(2)).await.unwrap();
    assert!(p.pending.events <= 10 && q.pending.events <= 10);
    assert_eq!(
        p.pending.events + q.pending.events,
        15,
        "the owner's cap, full"
    );
    env.check_invariants().await;
    env.drop_schema().await;
}

/// Twenty concurrent copies of one delivery are retained once.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn concurrent_redeliveries_are_retained_once() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("dupes");
    let connection = env.connection(&owner).await;
    env.subscribe(&owner, &connection, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    let barrier = Arc::new(Barrier::new(20));
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..20 {
        let store = env.store.clone();
        let barrier = barrier.clone();
        let endpoint = hook.endpoint_id.clone();
        tasks.spawn(async move {
            barrier.wait().await;
            store
                .ingest(&delivery(&endpoint, "same", "p", 100), at(1))
                .await
        });
    }
    let mut retained = 0;
    let mut duplicates = 0;
    while let Some(result) = tasks.join_next().await {
        let outcome = result.unwrap().unwrap();
        retained += outcome.retained;
        duplicates += outcome.duplicates;
    }
    assert_eq!((retained, duplicates), (1, 19));
    env.check_invariants().await;
    env.drop_schema().await;
}

/// Concurrent creations stop exactly at the owner's quota.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn concurrent_subscriptions_stop_at_the_quota() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("rush");
    let connection = env.connection(&owner).await;
    let barrier = Arc::new(Barrier::new(12));
    let mut tasks = tokio::task::JoinSet::new();
    for n in 0..12 {
        let store = env.store.clone();
        let barrier = barrier.clone();
        let (owner, connection, hook_id) =
            (owner.clone(), connection.clone(), hook.hook_id.clone());
        tasks.spawn(async move {
            barrier.wait().await;
            store
                .create_subscription(
                    NewSubscription {
                        connection_id: connection,
                        owner: owner.clone(),
                        consumer: owner,
                        hook_id,
                        source_kind: "project".into(),
                        source_key: format!("p-{n}"),
                        events: vec!["task".into()],
                    },
                    at(0),
                )
                .await
        });
    }
    let mut created = 0;
    while let Some(result) = tasks.join_next().await {
        match result.unwrap() {
            Ok(_) => created += 1,
            Err(InboxError::QuotaExceeded) => {}
            Err(other) => panic!("{other:?}"),
        }
    }
    assert_eq!(created, 3);
    env.check_invariants().await;
    env.drop_schema().await;
}

/// Acknowledgements racing sweeps, and renewals racing expiry, always leave
/// a consistent result: a renewal either wins (and the subscription lives)
/// or finds it expired.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn acknowledgements_and_renewals_race_sweeps_consistently() {
    let env = env(small()).await;
    let hook = env.shared().await;
    for round in 0..10 {
        let owner = agent(&format!("racer{round}"));
        let connection = env.connection(&owner).await;
        let sub = env
            .subscribe(&owner, &connection, &hook.hook_id, "p", at(0))
            .await
            .unwrap();
        for n in 0..5 {
            env.deliver(
                &hook.endpoint_id,
                &format!("r{round}-{n}"),
                "p",
                100,
                at(1 + n),
            )
            .await;
        }
        let page = env
            .store
            .fetch(&sub.id, &owner, None, 10, at(10))
            .await
            .unwrap();
        let next = page.next.unwrap();
        let deadline = 7 * DAY;
        let (ack, renew, sweep) = tokio::join!(
            env.store
                .acknowledge(&sub.id, &owner, &next, at(deadline - 1)),
            env.store
                .renew(&sub.id, &owner, AccessCheck::Passed, at(deadline - 1)),
            env.store.sweep(at(deadline + 1)),
        );
        sweep.unwrap();
        let (state, _, _) = env.state(&sub.id).await;
        match renew {
            Ok(_) if state != "closed" => assert!(ack.is_ok()),
            Ok(_) => {} // renewed, then the sweep at a later time expired it
            Err(InboxError::Ended(_)) => assert_eq!(state, "closed"),
            Err(other) => panic!("{other:?}"),
        }
        env.check_invariants().await;
    }
    env.drop_schema().await;
}

// --- outages -------------------------------------------------------------------------

/// A failure before commit leaves nothing behind: no receipt, so the
/// provider's retry is accepted as new, and no counter moved.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_failure_before_commit_leaves_nothing_and_the_retry_is_new() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("rollback");
    let connection = env.connection(&owner).await;
    env.subscribe(&owner, &connection, &hook.hook_id, "p", at(0))
        .await
        .unwrap();
    env.store
        .fail_before_commit
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(env
        .store
        .ingest(&delivery(&hook.endpoint_id, "d-1", "p", 100), at(1))
        .await
        .is_err());
    env.store
        .fail_before_commit
        .store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(env.count("SELECT count(*) FROM webhook_receipts").await, 0);
    assert_eq!(env.count("SELECT count(*) FROM webhook_payloads").await, 0);
    env.check_invariants().await;
    assert_eq!(
        env.deliver(&hook.endpoint_id, "d-1", "p", 100, at(2))
            .await
            .retained,
        1
    );
    env.drop_schema().await;
}

/// The database connection dies while a delivery waits for a lock: the
/// delivery fails (so it must not be acknowledged), nothing is half-written,
/// and the next delivery works on a new connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_lost_database_connection_fails_the_delivery_and_recovers() {
    let env = env(small()).await;
    let hook = env.shared().await;
    let owner = agent("outage");
    let connection = env.connection(&owner).await;
    env.subscribe(&owner, &connection, &hook.hook_id, "p", at(0))
        .await
        .unwrap();

    let mut blocker = env.sql().await;
    let lock = blocker.transaction().await.unwrap();
    lock.batch_execute("LOCK TABLE webhook_deployment_usage IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let store = env.store.clone();
    let endpoint = hook.endpoint_id.clone();
    let pending = tokio::spawn(async move {
        store
            .ingest(&delivery(&endpoint, "d-1", "p", 100), at(1))
            .await
    });
    let admin = admin().await;
    let mut terminated = 0;
    for _ in 0..100 {
        terminated = admin
            .execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE application_name = $1 AND wait_event_type = 'Lock'",
                &[&env.tag],
            )
            .await
            .unwrap();
        if terminated > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(terminated > 0, "the delivery was waiting for the lock");
    assert!(
        pending.await.unwrap().is_err(),
        "a lost connection is an error, never a 2xx"
    );
    lock.rollback().await.unwrap();
    assert_eq!(env.count("SELECT count(*) FROM webhook_receipts").await, 0);
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_event_refs").await,
        0
    );
    env.check_invariants().await;
    assert_eq!(
        env.deliver(&hook.endpoint_id, "d-1", "p", 100, at(2))
            .await
            .retained,
        1
    );
    env.drop_schema().await;
}

// --- disabled ------------------------------------------------------------------------

/// With `WEBHOOKS_ENABLED` unset nothing is created.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn disabled_creates_no_tables() {
    let schema = format!("webhooks_off_{:016x}", rand::random::<u64>());
    let admin = admin().await;
    admin
        .batch_execute(&format!("CREATE SCHEMA \"{schema}\""))
        .await
        .unwrap();
    let mut url = url::Url::parse(&test_database_url()).unwrap();
    url.query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={schema}"));
    let security = Security::connect(url.as_str(), TEST_KEY).await.unwrap();
    let started = super::start(
        &crate::config::WebhookConfig::default(),
        url.as_str(),
        &security,
    )
    .await
    .unwrap();
    assert!(started.is_none());
    let tables: i64 = admin
        .query_one(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'webhook%'",
            &[&schema],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(tables, 0);
    admin
        .batch_execute(&format!("DROP SCHEMA \"{schema}\" CASCADE"))
        .await
        .unwrap();
}
