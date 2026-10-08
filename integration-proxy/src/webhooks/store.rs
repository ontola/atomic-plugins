//! The bounded inbox in PostgreSQL (`webhook-subscriptions` §4–§6).
//!
//! Every write runs in one transaction on a pooled connection
//! ([`super::pool`]) and takes row locks in one order, so concurrent
//! deliveries, acknowledgements, renewals and sweeps cannot deadlock or lose
//! an update:
//!
//! 1. subscription rows, by id;
//! 2. owner usage rows, by owner;
//! 3. the single deployment usage row;
//! 4. a hook row; payload and receipt rows.
//!
//! Since every write takes the deployment row, writes are serialized after
//! their subscription locks; that is the pilot's throughput bound.
//!
//! Time is always passed in (`now`), never read from the database, so tests
//! can move it. The provider-facing and consumer-facing routes are step 3;
//! this module is what they will call.

use std::collections::BTreeMap;
use std::time::SystemTime;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio_postgres::{types::ToSql, Row, Transaction};

use super::cursor::{generation_token, CursorKey};
use super::policy::{Policy, PAYLOAD_ROW_OVERHEAD, REFERENCE_ROW_OVERHEAD};
use super::pool::Pool;

/// Created idempotently when `WEBHOOKS_ENABLED=true`, and only then.
pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS webhook_hooks (
  hook_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  ownership TEXT NOT NULL CHECK (ownership IN ('sharedApplication', 'dedicated')),
  endpoint_id TEXT NOT NULL UNIQUE,
  source_kind TEXT,
  source_key TEXT,
  access_parameters TEXT,
  owner TEXT,
  management_connection_id TEXT,
  provider_hook_id TEXT,
  secret_envelope TEXT,
  created_by_receiver BOOLEAN NOT NULL DEFAULT FALSE,
  cleanup_failed BOOLEAN NOT NULL DEFAULT FALSE,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'active', 'cleanup-pending', 'closed')),
  created_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_hooks_shared_idx ON webhook_hooks (platform)
  WHERE ownership = 'sharedApplication';
CREATE UNIQUE INDEX IF NOT EXISTS webhook_hooks_dedicated_idx ON webhook_hooks (platform, source_kind, source_key)
  WHERE ownership = 'dedicated' AND state <> 'closed';
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  consumer TEXT NOT NULL,
  hook_id TEXT NOT NULL REFERENCES webhook_hooks (hook_id),
  source_kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  events TEXT[] NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'needs-reconciliation', 'active', 'cleanup-pending', 'closed')),
  closed_reason TEXT,
  generation BIGINT NOT NULL,
  next_seq BIGINT NOT NULL,
  barrier_seq BIGINT NOT NULL,
  ack_seq BIGINT NOT NULL,
  last_returned_seq BIGINT NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  renew_after TIMESTAMPTZ,
  progress_deadline_at TIMESTAMPTZ,
  access_checked_at TIMESTAMPTZ,
  pending_events BIGINT NOT NULL CHECK (pending_events >= 0),
  pending_bytes BIGINT NOT NULL CHECK (pending_bytes >= 0),
  suspended BOOLEAN NOT NULL,
  suspended_missed BOOLEAN NOT NULL,
  gap_generation BIGINT,
  gap_reason TEXT,
  gap_detected_at TIMESTAMPTZ,
  gap_last_ack BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS webhook_subscriptions_route_idx
  ON webhook_subscriptions (hook_id, source_kind, source_key)
  WHERE state IN ('needs-reconciliation', 'active');
CREATE INDEX IF NOT EXISTS webhook_subscriptions_owner_idx ON webhook_subscriptions (owner);
CREATE INDEX IF NOT EXISTS webhook_subscriptions_lease_idx ON webhook_subscriptions (lease_expires_at)
  WHERE state IN ('provisioning', 'needs-reconciliation', 'active');
CREATE INDEX IF NOT EXISTS webhook_subscriptions_progress_idx ON webhook_subscriptions (progress_deadline_at)
  WHERE state IN ('provisioning', 'needs-reconciliation', 'active');
CREATE INDEX IF NOT EXISTS webhook_subscriptions_ended_idx ON webhook_subscriptions (ended_at)
  WHERE state = 'closed';
CREATE TABLE IF NOT EXISTS webhook_payloads (
  payload_id BIGSERIAL PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  action TEXT,
  source_kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  body BYTEA NOT NULL,
  references_left INTEGER NOT NULL CHECK (references_left >= 0)
);
CREATE TABLE IF NOT EXISTS webhook_event_refs (
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions (subscription_id),
  seq BIGINT NOT NULL,
  generation BIGINT NOT NULL,
  payload_id BIGINT NOT NULL REFERENCES webhook_payloads (payload_id),
  received_at TIMESTAMPTZ NOT NULL,
  bytes BIGINT NOT NULL,
  PRIMARY KEY (subscription_id, seq)
);
CREATE INDEX IF NOT EXISTS webhook_event_refs_payload_idx ON webhook_event_refs (payload_id);
CREATE INDEX IF NOT EXISTS webhook_event_refs_received_idx ON webhook_event_refs (received_at);
CREATE TABLE IF NOT EXISTS webhook_receipts (
  endpoint_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (endpoint_id, delivery_id, owner)
);
CREATE INDEX IF NOT EXISTS webhook_receipts_owner_idx ON webhook_receipts (owner, received_at);
CREATE INDEX IF NOT EXISTS webhook_receipts_received_idx ON webhook_receipts (received_at);
CREATE INDEX IF NOT EXISTS webhook_receipts_expires_idx ON webhook_receipts (expires_at);
CREATE TABLE IF NOT EXISTS webhook_owner_usage (
  owner TEXT PRIMARY KEY,
  pending_bytes BIGINT NOT NULL DEFAULT 0 CHECK (pending_bytes >= 0),
  pending_refs BIGINT NOT NULL DEFAULT 0 CHECK (pending_refs >= 0),
  live_subscriptions BIGINT NOT NULL DEFAULT 0 CHECK (live_subscriptions >= 0)
);
CREATE TABLE IF NOT EXISTS webhook_deployment_usage (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  inbox_bytes BIGINT NOT NULL DEFAULT 0 CHECK (inbox_bytes >= 0),
  receipts BIGINT NOT NULL DEFAULT 0 CHECK (receipts >= 0),
  cleanup_jobs BIGINT NOT NULL DEFAULT 0 CHECK (cleanup_jobs >= 0),
  last_sweep_at TIMESTAMPTZ
);
INSERT INTO webhook_deployment_usage (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS webhook_cleanup_jobs (
  hook_id TEXT PRIMARY KEY REFERENCES webhook_hooks (hook_id),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
";

const LIVE: &str = "('provisioning', 'needs-reconciliation', 'active')";

/// The states a subscription row can be in. `expired` is never stored: a
/// subscription that expires is released and moves on to `cleanup-pending`
/// or `closed` in the same transaction; its tombstone remembers why
/// (`webhook-subscriptions` §4.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Provisioning,
    NeedsReconciliation,
    Active,
    CleanupPending,
    Closed,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            State::Provisioning => "provisioning",
            State::NeedsReconciliation => "needs-reconciliation",
            State::Active => "active",
            State::CleanupPending => "cleanup-pending",
            State::Closed => "closed",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "provisioning" => State::Provisioning,
            "needs-reconciliation" => State::NeedsReconciliation,
            "active" => State::Active,
            "cleanup-pending" => State::CleanupPending,
            _ => State::Closed,
        }
    }

    fn is_live(self) -> bool {
        matches!(
            self,
            State::Provisioning | State::NeedsReconciliation | State::Active
        )
    }

    fn captures(self) -> bool {
        matches!(self, State::NeedsReconciliation | State::Active)
    }
}

/// Why a subscription ended; its tombstone's `gap.reason`
/// (`webhook-subscriptions` §5.2).
pub mod ended {
    pub const LEASE_EXPIRED: &str = "lease-expired";
    pub const PROGRESS_STALLED: &str = "progress-stalled";
    pub const ACCESS_DENIED: &str = "access-denied";
    pub const CONNECTION_DELETED: &str = "connection-deleted";
    pub const DELETED: &str = "deleted";
    pub const PROVISIONING_FAILED: &str = "provisioning-failed";
}

/// Gap reasons (`webhook-subscriptions` §5.1).
pub mod gap {
    pub const INITIAL: &str = "initial";
    pub const EVENTS: &str = "subscription-events-limit";
    pub const BYTES: &str = "subscription-bytes-limit";
    pub const AGE: &str = "subscription-age-limit";
    pub const OWNER: &str = "owner-limit";
    pub const DEPLOYMENT: &str = "deployment-limit";
    pub const OVERSIZED: &str = "oversized-delivery";
    pub const SUSPENDED: &str = "access-suspended";
    pub const RECEIPTS: &str = "receipt-limit";
}

#[derive(Debug)]
pub enum InboxError {
    Database(String),
    UnknownSubscription,
    UnknownConnection,
    UnknownHook,
    /// The subscription ended; the result tells the consumer to subscribe
    /// again.
    Ended(Box<Reconciliation>),
    ObsoleteGeneration,
    CursorNotIssued,
    CursorAhead,
    BarrierMismatch,
    NotReconciling,
    QuotaExceeded,
    CapacityUnavailable,
    AccessCheckRequired,
    AccessUnavailable,
}

impl InboxError {
    /// The spec's error code (`webhook-subscriptions` §7).
    pub fn code(&self) -> &'static str {
        match self {
            InboxError::Database(_) | InboxError::CapacityUnavailable => "capacity-unavailable",
            InboxError::UnknownSubscription => "unknown-subscription",
            InboxError::UnknownConnection | InboxError::UnknownHook => "access-denied",
            InboxError::Ended(result) if result.state == "expired" => "expired",
            InboxError::Ended(_) => "closed",
            InboxError::ObsoleteGeneration => "obsolete-generation",
            InboxError::CursorNotIssued => "cursor-not-issued",
            InboxError::CursorAhead => "cursor-ahead",
            InboxError::BarrierMismatch | InboxError::NotReconciling => "barrier-mismatch",
            InboxError::QuotaExceeded => "quota-exceeded",
            InboxError::AccessCheckRequired => "access-check-required",
            InboxError::AccessUnavailable => "access-check-required",
        }
    }
}

impl From<tokio_postgres::Error> for InboxError {
    fn from(error: tokio_postgres::Error) -> Self {
        InboxError::Database(error.to_string())
    }
}

impl std::fmt::Display for InboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InboxError::Database(error) => write!(f, "webhook inbox database error: {error}"),
            other => f.write_str(other.code()),
        }
    }
}

type Result<T> = std::result::Result<T, InboxError>;

/// The outcome of an access check made through a subscription's connection
/// (Webhook Deliveries §4.4.1), as the caller determined it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessCheck {
    Passed,
    /// 403, 404, another key, or a 401 after one refresh: closes.
    Failed,
    /// 5xx, timeout, redirect: changes nothing, passes nothing.
    Unavailable,
}

/// A verified delivery, routed by the caller to a source.
#[derive(Clone, Debug)]
pub struct Delivery {
    pub endpoint_id: String,
    pub delivery_id: String,
    pub event_type: String,
    pub action: Option<String>,
    pub source_kind: String,
    pub source_key: String,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IngestOutcome {
    /// Subscriptions the delivery was routed to.
    pub routed: usize,
    /// Of those, the ones that retained it.
    pub retained: usize,
    /// Of those, the ones that recorded a gap instead.
    pub gaps: usize,
    /// Of those, the ones that had a receipt already.
    pub duplicates: usize,
    /// Subscriptions found past a deadline and ended on the way.
    pub ended: usize,
    /// Suspended subscriptions that missed it.
    pub missed: usize,
}

pub struct NewSubscription {
    pub connection_id: String,
    pub owner: String,
    pub consumer: String,
    pub hook_id: String,
    pub source_kind: String,
    pub source_key: String,
    pub events: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct HookRecord {
    pub hook_id: String,
    pub endpoint_id: String,
}

/// What a cleanup job hands the hook deleter (step 3 makes the provider
/// calls, after re-running the managing connection's access check).
#[derive(Clone, Debug)]
pub struct HookToDelete {
    pub hook_id: String,
    pub platform: String,
    pub source_kind: String,
    pub source_key: String,
    pub access_parameters: String,
    pub provider_hook_id: Option<String>,
    pub management_connection_id: Option<String>,
}

// --- records exposed to consumers (webhook-subscriptions schema.json) ---------

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    pub kind: String,
    pub key: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeaseView {
    pub expires_at: String,
    pub renew_after: String,
    pub progress_deadline_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub events: i64,
    pub bytes: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GapView {
    pub generation: Option<String>,
    pub reason: String,
    pub detected_at: String,
    pub last_acknowledged: Option<String>,
    pub earliest_available_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reconciliation {
    pub status: &'static str,
    pub subscription: String,
    pub state: &'static str,
    pub action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub barrier: Option<String>,
    pub gap: GapView,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionView {
    pub id: String,
    pub connection: String,
    pub consumer: String,
    pub source: SourceView,
    pub events: Vec<String>,
    pub hook: &'static str,
    pub state: &'static str,
    pub generation: Option<String>,
    pub lease: Option<LeaseView>,
    pub acknowledged: Option<String>,
    pub pending: PendingView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconciliation_required: Option<Reconciliation>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PayloadView {
    pub media_type: &'static str,
    pub bytes: i64,
    pub sha256: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub cursor: String,
    pub generation: String,
    pub delivery_id: String,
    pub event_type: String,
    pub action: Option<String>,
    pub received_at: String,
    pub source: SourceView,
    pub payload: PayloadView,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub subscription: String,
    pub generation: String,
    pub events: Vec<EventView>,
    pub next: Option<String>,
    pub more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconciliation_required: Option<Reconciliation>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Acknowledgement {
    pub generation: String,
    pub cursor: String,
}

pub(crate) fn rfc3339(value: SystemTime) -> String {
    time::OffsetDateTime::from(value)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// --- rows -------------------------------------------------------------------

const SUB_COLUMNS: &str = "s.subscription_id, s.connection_id, s.owner, s.consumer, s.hook_id,
  h.ownership, h.created_by_receiver, h.platform, s.source_kind, s.source_key, s.events, s.state,
  s.closed_reason, s.generation, s.next_seq, s.barrier_seq, s.ack_seq, s.last_returned_seq,
  s.lease_expires_at, s.renew_after, s.progress_deadline_at, s.access_checked_at,
  s.pending_events, s.pending_bytes, s.suspended, s.suspended_missed, s.gap_generation,
  s.gap_reason, s.gap_detected_at, s.gap_last_ack, s.created_at, s.ended_at";

#[derive(Clone, Debug)]
struct SubRow {
    id: String,
    connection_id: String,
    owner: String,
    consumer: String,
    hook_id: String,
    dedicated: bool,
    created_by_receiver: bool,
    source_kind: String,
    source_key: String,
    events: Vec<String>,
    state: State,
    closed_reason: Option<String>,
    generation: i64,
    next_seq: i64,
    barrier_seq: i64,
    ack_seq: i64,
    last_returned_seq: i64,
    lease_expires_at: Option<SystemTime>,
    renew_after: Option<SystemTime>,
    progress_deadline_at: Option<SystemTime>,
    access_checked_at: Option<SystemTime>,
    pending_events: i64,
    pending_bytes: i64,
    suspended: bool,
    suspended_missed: bool,
    gap_generation: Option<i64>,
    gap_reason: Option<String>,
    gap_detected_at: Option<SystemTime>,
    gap_last_ack: Option<i64>,
    created_at: SystemTime,
    ended_at: Option<SystemTime>,
}

impl SubRow {
    fn from_row(row: &Row) -> Self {
        Self {
            id: row.get(0),
            connection_id: row.get(1),
            owner: row.get(2),
            consumer: row.get(3),
            hook_id: row.get(4),
            dedicated: row.get::<_, String>(5) == "dedicated",
            created_by_receiver: row.get(6),
            source_kind: row.get(8),
            source_key: row.get(9),
            events: row.get(10),
            state: State::parse(row.get(11)),
            closed_reason: row.get(12),
            generation: row.get(13),
            next_seq: row.get(14),
            barrier_seq: row.get(15),
            ack_seq: row.get(16),
            last_returned_seq: row.get(17),
            lease_expires_at: row.get(18),
            renew_after: row.get(19),
            progress_deadline_at: row.get(20),
            access_checked_at: row.get(21),
            pending_events: row.get(22),
            pending_bytes: row.get(23),
            suspended: row.get(24),
            suspended_missed: row.get(25),
            gap_generation: row.get(26),
            gap_reason: row.get(27),
            gap_detected_at: row.get(28),
            gap_last_ack: row.get(29),
            created_at: row.get(30),
            ended_at: row.get(31),
        }
    }

    /// The deadline this subscription is past, if any.
    fn overdue(&self, now: SystemTime) -> Option<&'static str> {
        if !self.state.is_live() {
            return None;
        }
        if self.lease_expires_at.is_some_and(|at| at <= now) {
            return Some(ended::LEASE_EXPIRED);
        }
        if self.progress_deadline_at.is_some_and(|at| at <= now) {
            return Some(ended::PROGRESS_STALLED);
        }
        None
    }

    /// Records a gap: the history of the current generation stops here, a
    /// new generation starts after the last assigned position.
    fn record_gap(&mut self, reason: &str, now: SystemTime) {
        self.gap_generation = Some(self.generation);
        self.gap_reason = Some(reason.to_owned());
        self.gap_detected_at = Some(now);
        self.gap_last_ack = Some(self.ack_seq);
        self.generation += 1;
        self.barrier_seq = self.next_seq - 1;
        self.state = State::NeedsReconciliation;
    }

    fn start_initial(&mut self, now: SystemTime) {
        self.state = State::NeedsReconciliation;
        self.generation = 1;
        self.barrier_seq = self.next_seq - 1;
        self.gap_generation = None;
        self.gap_reason = Some(gap::INITIAL.to_owned());
        self.gap_detected_at = Some(now);
        self.gap_last_ack = None;
    }
}

#[derive(Clone, Debug)]
struct OwnerRow {
    owner: String,
    pending_bytes: i64,
    pending_refs: i64,
    live_subscriptions: i64,
}

#[derive(Clone, Debug)]
struct Deployment {
    inbox_bytes: i64,
    receipts: i64,
    cleanup_jobs: i64,
    last_sweep_at: Option<SystemTime>,
}

/// What a release of event references freed.
#[derive(Debug, Default)]
struct Released {
    events: i64,
    max_generation: i64,
}

enum Release {
    UpTo(i64),
    ReceivedBefore(SystemTime),
}

pub struct Store {
    pool: Pool,
    policy: Policy,
    cursors: CursorKey,
    #[cfg(test)]
    pub(crate) fail_before_commit: std::sync::atomic::AtomicBool,
}

impl Store {
    /// Creates the inbox schema (under an advisory lock, so several
    /// instances may start at once) and the inbox's connection pool.
    pub async fn connect(
        database_url: &str,
        security: &crate::security::Security,
        policy: Policy,
    ) -> std::result::Result<Self, String> {
        policy.check()?;
        let (mut setup, driver) = crate::security::connect_once(database_url).await?;
        let driver = tokio::spawn(driver);
        let transaction = setup.transaction().await.map_err(|e| e.to_string())?;
        transaction
            .query_one(
                "SELECT pg_advisory_xact_lock($1)",
                &[&7_316_186_474_691_124_078_i64],
            )
            .await
            .map_err(|e| e.to_string())?;
        transaction
            .batch_execute(SCHEMA)
            .await
            .map_err(|e| e.to_string())?;
        transaction.commit().await.map_err(|e| e.to_string())?;
        drop(setup);
        let _ = driver.await;
        Ok(Self {
            pool: Pool::new(database_url, 4),
            policy,
            cursors: CursorKey::new(security.derive_subkey(super::cursor::SUBKEY_LABEL)),
            #[cfg(test)]
            fail_before_commit: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    async fn commit(&self, transaction: Transaction<'_>) -> Result<()> {
        #[cfg(test)]
        if self
            .fail_before_commit
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            // Dropping the transaction rolls it back, as a crash would.
            drop(transaction);
            return Err(InboxError::Database(
                "injected failure before commit".into(),
            ));
        }
        transaction.commit().await?;
        Ok(())
    }

    // --- locking helpers ------------------------------------------------------

    async fn lock_subscription(tx: &Transaction<'_>, id: &str) -> Result<Option<SubRow>> {
        let row = tx
            .query_opt(
                &format!(
                    "SELECT {SUB_COLUMNS} FROM webhook_subscriptions s JOIN webhook_hooks h ON h.hook_id = s.hook_id
                     WHERE s.subscription_id = $1 FOR UPDATE OF s"
                ),
                &[&id],
            )
            .await?;
        Ok(row.as_ref().map(SubRow::from_row))
    }

    async fn lock_owners(
        tx: &Transaction<'_>,
        owners: &[String],
    ) -> Result<BTreeMap<String, OwnerRow>> {
        let mut sorted: Vec<&String> = owners.iter().collect();
        sorted.sort();
        sorted.dedup();
        let mut locked = BTreeMap::new();
        for owner in sorted {
            // An upsert locks the row it inserts or finds, so a concurrent
            // sweep cannot delete it in between.
            let row = tx
                .query_one(
                    "INSERT INTO webhook_owner_usage (owner) VALUES ($1)
                     ON CONFLICT (owner) DO UPDATE SET owner = EXCLUDED.owner
                     RETURNING owner, pending_bytes, pending_refs, live_subscriptions",
                    &[owner],
                )
                .await?;
            locked.insert(
                owner.clone(),
                OwnerRow {
                    owner: row.get(0),
                    pending_bytes: row.get(1),
                    pending_refs: row.get(2),
                    live_subscriptions: row.get(3),
                },
            );
        }
        Ok(locked)
    }

    async fn lock_deployment(tx: &Transaction<'_>) -> Result<Deployment> {
        let row = tx
            .query_one(
                "SELECT inbox_bytes, receipts, cleanup_jobs, last_sweep_at
                 FROM webhook_deployment_usage FOR UPDATE",
                &[],
            )
            .await?;
        Ok(Deployment {
            inbox_bytes: row.get(0),
            receipts: row.get(1),
            cleanup_jobs: row.get(2),
            last_sweep_at: row.get(3),
        })
    }

    async fn save_subscription(tx: &Transaction<'_>, row: &SubRow) -> Result<()> {
        tx.execute(
            "UPDATE webhook_subscriptions SET state = $2, closed_reason = $3, generation = $4,
               next_seq = $5, barrier_seq = $6, ack_seq = $7, last_returned_seq = $8,
               lease_expires_at = $9, renew_after = $10, progress_deadline_at = $11,
               access_checked_at = $12, pending_events = $13, pending_bytes = $14,
               suspended = $15, suspended_missed = $16, gap_generation = $17, gap_reason = $18,
               gap_detected_at = $19, gap_last_ack = $20, ended_at = $21
             WHERE subscription_id = $1",
            &[
                &row.id,
                &row.state.as_str(),
                &row.closed_reason,
                &row.generation,
                &row.next_seq,
                &row.barrier_seq,
                &row.ack_seq,
                &row.last_returned_seq,
                &row.lease_expires_at,
                &row.renew_after,
                &row.progress_deadline_at,
                &row.access_checked_at,
                &row.pending_events,
                &row.pending_bytes,
                &row.suspended,
                &row.suspended_missed,
                &row.gap_generation,
                &row.gap_reason,
                &row.gap_detected_at,
                &row.gap_last_ack,
                &row.ended_at,
            ],
        )
        .await?;
        Ok(())
    }

    async fn save_owners(tx: &Transaction<'_>, owners: &BTreeMap<String, OwnerRow>) -> Result<()> {
        for owner in owners.values() {
            tx.execute(
                "UPDATE webhook_owner_usage SET pending_bytes = $2, pending_refs = $3, live_subscriptions = $4
                 WHERE owner = $1",
                &[
                    &owner.owner,
                    &owner.pending_bytes,
                    &owner.pending_refs,
                    &owner.live_subscriptions,
                ],
            )
            .await?;
        }
        Ok(())
    }

    async fn save_deployment(tx: &Transaction<'_>, deployment: &Deployment) -> Result<()> {
        tx.execute(
            "UPDATE webhook_deployment_usage SET inbox_bytes = $1, receipts = $2, cleanup_jobs = $3",
            &[
                &deployment.inbox_bytes,
                &deployment.receipts,
                &deployment.cleanup_jobs,
            ],
        )
        .await?;
        Ok(())
    }

    async fn connection_exists(tx: &Transaction<'_>, connection_id: &str) -> Result<bool> {
        Ok(tx
            .query_opt(
                "SELECT 1 FROM agent_connections WHERE connection_id = $1",
                &[&connection_id],
            )
            .await?
            .is_some())
    }

    // --- releasing references ---------------------------------------------------

    /// Deletes event references of `row`, and the payloads no reference is
    /// left for, keeping every counter in step. The caller holds the
    /// subscription, owner and deployment locks.
    async fn release(
        tx: &Transaction<'_>,
        row: &mut SubRow,
        owner: &mut OwnerRow,
        deployment: &mut Deployment,
        what: Release,
    ) -> Result<Released> {
        let (condition, bound): (&str, Box<dyn ToSql + Sync + Send>) = match what {
            Release::UpTo(seq) => ("seq <= $2", Box::new(seq)),
            Release::ReceivedBefore(at) => ("received_at < $2", Box::new(at)),
        };
        let row_out = tx
            .query_one(
                &format!(
                    "WITH gone AS (
                       DELETE FROM webhook_event_refs WHERE subscription_id = $1 AND {condition}
                       RETURNING payload_id, bytes, generation),
                     counts AS (SELECT payload_id, count(*)::int AS n FROM gone GROUP BY payload_id),
                     freed AS (
                       DELETE FROM webhook_payloads p USING counts c
                       WHERE p.payload_id = c.payload_id AND p.references_left = c.n
                       RETURNING p.bytes),
                     kept AS (
                       UPDATE webhook_payloads p SET references_left = p.references_left - c.n
                       FROM counts c WHERE p.payload_id = c.payload_id AND p.references_left > c.n
                       RETURNING p.payload_id)
                     SELECT (SELECT count(*) FROM gone)::bigint,
                            (SELECT coalesce(sum(bytes), 0) FROM gone)::bigint,
                            (SELECT coalesce(max(generation), 0) FROM gone)::bigint,
                            (SELECT count(*) FROM freed)::bigint,
                            (SELECT coalesce(sum(bytes), 0) FROM freed)::bigint,
                            (SELECT count(*) FROM kept)::bigint"
                ),
                &[&row.id, bound.as_ref()],
            )
            .await?;
        let events: i64 = row_out.get(0);
        let bytes: i64 = row_out.get(1);
        let max_generation: i64 = row_out.get(2);
        let freed_payloads: i64 = row_out.get(3);
        let freed_bytes: i64 = row_out.get(4);
        row.pending_events -= events;
        row.pending_bytes -= bytes;
        if row.pending_events == 0 {
            row.progress_deadline_at = None;
        }
        owner.pending_refs -= events;
        owner.pending_bytes -= bytes;
        deployment.inbox_bytes -=
            freed_bytes + freed_payloads * PAYLOAD_ROW_OVERHEAD + events * REFERENCE_ROW_OVERHEAD;
        Ok(Released {
            events,
            max_generation,
        })
    }

    /// Releases references and records a gap if the current generation lost
    /// one (older generations are already behind a gap).
    async fn evict(
        tx: &Transaction<'_>,
        row: &mut SubRow,
        owner: &mut OwnerRow,
        deployment: &mut Deployment,
        what: Release,
        reason: &str,
        now: SystemTime,
    ) -> Result<bool> {
        let released = Self::release(tx, row, owner, deployment, what).await?;
        let broke = released.events > 0 && released.max_generation == row.generation;
        if broke {
            row.record_gap(reason, now);
        }
        Ok(broke)
    }

    /// Ends a subscription: releases everything it holds, moves it to
    /// `cleanup-pending` (the last user of a dedicated hook the receiver
    /// created) or `closed`, hands hook management on, and starts cleanup.
    async fn end(
        tx: &Transaction<'_>,
        policy: &Policy,
        row: &mut SubRow,
        owner: &mut OwnerRow,
        deployment: &mut Deployment,
        reason: &str,
        now: SystemTime,
    ) -> Result<()> {
        Self::release(tx, row, owner, deployment, Release::UpTo(i64::MAX)).await?;
        if row.state.is_live() {
            owner.live_subscriptions -= 1;
        }
        row.closed_reason = Some(reason.to_owned());
        row.ended_at = Some(now);
        row.lease_expires_at = None;
        row.renew_after = None;
        row.progress_deadline_at = None;
        row.suspended = false;
        row.state = State::Closed;
        if row.dedicated {
            let hook = tx
                .query_one(
                    "SELECT state, management_connection_id FROM webhook_hooks WHERE hook_id = $1 FOR UPDATE",
                    &[&row.hook_id],
                )
                .await?;
            let hook_state: String = hook.get(0);
            let manager: Option<String> = hook.get(1);
            let successor = tx
                .query_opt(
                    &format!(
                        "SELECT connection_id, owner FROM webhook_subscriptions
                         WHERE hook_id = $1 AND subscription_id <> $2 AND state IN {LIVE}
                         ORDER BY created_at, subscription_id LIMIT 1"
                    ),
                    &[&row.hook_id, &row.id],
                )
                .await?;
            match successor {
                Some(successor) => {
                    // Management moves on when its connection leaves
                    // (Webhook Deliveries §4.5.2).
                    if manager.as_deref() == Some(row.connection_id.as_str()) || manager.is_none() {
                        let connection: String = successor.get(0);
                        let new_owner: String = successor.get(1);
                        tx.execute(
                            "UPDATE webhook_hooks SET management_connection_id = $2, owner = $3 WHERE hook_id = $1",
                            &[&row.hook_id, &connection, &new_owner],
                        )
                        .await?;
                    }
                }
                None if row.created_by_receiver && hook_state == "active" => {
                    tx.execute(
                        "UPDATE webhook_hooks SET state = 'cleanup-pending' WHERE hook_id = $1",
                        &[&row.hook_id],
                    )
                    .await?;
                    let inserted = tx
                        .execute(
                            "INSERT INTO webhook_cleanup_jobs (hook_id, next_attempt_at, deadline_at, created_at)
                             VALUES ($1, $2, $3, $2) ON CONFLICT DO NOTHING",
                            &[&row.hook_id, &now, &(now + policy.cleanup_deadline)],
                        )
                        .await?;
                    deployment.cleanup_jobs += inserted as i64;
                    row.state = State::CleanupPending;
                }
                None => {
                    if hook_state == "provisioning" {
                        tx.execute(
                            "UPDATE webhook_hooks SET state = 'closed', closed_at = $2 WHERE hook_id = $1",
                            &[&row.hook_id, &now],
                        )
                        .await?;
                    }
                }
            }
        }
        Self::save_subscription(tx, row).await
    }

    // --- views -----------------------------------------------------------------

    fn cursor(&self, row: &SubRow, generation: i64, seq: i64) -> String {
        self.cursors.encode(&row.id, generation, seq)
    }

    async fn reconciliation(
        &self,
        tx: &Transaction<'_>,
        row: &SubRow,
    ) -> Result<Option<Reconciliation>> {
        if row.state == State::NeedsReconciliation {
            let earliest = match (row.gap_generation, row.gap_last_ack) {
                (Some(generation), Some(ack)) => tx
                    .query_one(
                        "SELECT min(seq) FROM webhook_event_refs
                         WHERE subscription_id = $1 AND generation = $2 AND seq > $3",
                        &[&row.id, &generation, &ack],
                    )
                    .await?
                    .get::<_, Option<i64>>(0)
                    .map(|seq| self.cursor(row, generation, seq)),
                _ => None,
            };
            return Ok(Some(Reconciliation {
                status: "reconciliation-required",
                subscription: row.id.clone(),
                state: "needs-reconciliation",
                action: "reconcile",
                generation: Some(generation_token(row.generation)),
                barrier: Some(self.cursor(row, row.generation, row.barrier_seq)),
                gap: GapView {
                    generation: row.gap_generation.map(generation_token),
                    reason: row
                        .gap_reason
                        .clone()
                        .unwrap_or_else(|| gap::INITIAL.into()),
                    detected_at: rfc3339(row.gap_detected_at.unwrap_or(row.created_at)),
                    last_acknowledged: match (row.gap_generation, row.gap_last_ack) {
                        (Some(generation), Some(ack)) if ack > 0 => {
                            Some(self.cursor(row, generation, ack))
                        }
                        _ => None,
                    },
                    earliest_available_cursor: earliest,
                },
            }));
        }
        Ok(None)
    }

    /// The `resubscribe` result for an ended subscription.
    fn ended_result(&self, row: &SubRow) -> Reconciliation {
        let reason = row
            .closed_reason
            .clone()
            .unwrap_or_else(|| ended::DELETED.into());
        let expired = reason == ended::LEASE_EXPIRED || reason == ended::PROGRESS_STALLED;
        let generation = row.generation.max(1);
        Reconciliation {
            status: "reconciliation-required",
            subscription: row.id.clone(),
            state: if expired { "expired" } else { "closed" },
            action: "resubscribe",
            generation: None,
            barrier: None,
            gap: GapView {
                generation: Some(generation_token(generation)),
                reason,
                detected_at: rfc3339(row.ended_at.unwrap_or(row.created_at)),
                last_acknowledged: (row.ack_seq > 0)
                    .then(|| self.cursor(row, generation, row.ack_seq)),
                earliest_available_cursor: None,
            },
        }
    }

    async fn view(&self, tx: &Transaction<'_>, row: &SubRow) -> Result<SubscriptionView> {
        let state = match row.state {
            State::Closed | State::CleanupPending
                if matches!(
                    row.closed_reason.as_deref(),
                    Some(ended::LEASE_EXPIRED | ended::PROGRESS_STALLED)
                ) =>
            {
                "expired"
            }
            other => other.as_str(),
        };
        Ok(SubscriptionView {
            id: row.id.clone(),
            connection: row.connection_id.clone(),
            consumer: row.consumer.clone(),
            source: SourceView {
                kind: row.source_kind.clone(),
                key: row.source_key.clone(),
            },
            events: row.events.clone(),
            hook: if row.dedicated {
                "dedicated"
            } else {
                "sharedApplication"
            },
            state,
            generation: (row.generation > 0).then(|| generation_token(row.generation)),
            lease: match (row.lease_expires_at, row.renew_after) {
                (Some(expires_at), Some(renew_after)) => Some(LeaseView {
                    expires_at: rfc3339(expires_at),
                    renew_after: rfc3339(renew_after),
                    progress_deadline_at: row.progress_deadline_at.map(rfc3339),
                }),
                _ => None,
            },
            acknowledged: (row.ack_seq > 0).then(|| {
                self.cursor(
                    row,
                    row.gap_generation.unwrap_or(row.generation).max(1),
                    row.ack_seq,
                )
            }),
            pending: PendingView {
                events: row.pending_events,
                bytes: row.pending_bytes,
            },
            reconciliation_required: self.reconciliation(tx, row).await?,
            created_at: rfc3339(row.created_at),
        })
    }

    /// Locks a consumer's subscription and enforces, on the request path,
    /// everything that ends it: an unknown consumer, a deleted connection,
    /// a passed deadline. `Ok(Err(..))` means the transaction must still be
    /// committed (the subscription may just have been ended).
    async fn open(
        &self,
        tx: &Transaction<'_>,
        id: &str,
        consumer: &str,
        now: SystemTime,
    ) -> Result<std::result::Result<SubRow, InboxError>> {
        let Some(mut row) = Self::lock_subscription(tx, id).await? else {
            return Ok(Err(InboxError::UnknownSubscription));
        };
        if row.consumer != consumer {
            return Ok(Err(InboxError::UnknownSubscription));
        }
        if !row.state.is_live() {
            return Ok(Err(InboxError::Ended(Box::new(self.ended_result(&row)))));
        }
        let reason = if !Self::connection_exists(tx, &row.connection_id).await? {
            Some(ended::CONNECTION_DELETED)
        } else {
            row.overdue(now)
        };
        if let Some(reason) = reason {
            let mut owners = Self::lock_owners(tx, std::slice::from_ref(&row.owner)).await?;
            let mut deployment = Self::lock_deployment(tx).await?;
            let owner = owners.get_mut(&row.owner).expect("locked");
            Self::end(
                tx,
                &self.policy,
                &mut row,
                owner,
                &mut deployment,
                reason,
                now,
            )
            .await?;
            Self::save_owners(tx, &owners).await?;
            Self::save_deployment(tx, &deployment).await?;
            return Ok(Err(InboxError::Ended(Box::new(self.ended_result(&row)))));
        }
        Ok(Ok(row))
    }

    /// Validates a consumer's cursor (`webhook-subscriptions` §4.2).
    fn position(&self, row: &SubRow, cursor: &str) -> Result<(i64, i64)> {
        let (generation, seq) = self
            .cursors
            .decode(&row.id, cursor)
            .ok_or(InboxError::CursorNotIssued)?;
        if generation != row.generation && Some(generation) != row.gap_generation {
            return Err(InboxError::ObsoleteGeneration);
        }
        if seq > row.last_returned_seq.max(row.barrier_seq) {
            return Err(InboxError::CursorAhead);
        }
        Ok((generation, seq))
    }

    // --- hooks -----------------------------------------------------------------

    /// The platform's shared application hook (Webhook Deliveries §4.5.1),
    /// created on first use. The receiver never deletes it.
    pub async fn ensure_shared_hook(&self, platform: &str, now: SystemTime) -> Result<HookRecord> {
        let client = self.pool.get().await.map_err(InboxError::Database)?;
        client
            .execute(
                "INSERT INTO webhook_hooks (hook_id, platform, ownership, endpoint_id, state, created_at)
                 VALUES ($1, $2, 'sharedApplication', $3, 'active', $4) ON CONFLICT DO NOTHING",
                &[&crate::connect::random(), &platform, &crate::connect::random(), &now],
            )
            .await?;
        let row = client
            .query_one(
                "SELECT hook_id, endpoint_id FROM webhook_hooks
                 WHERE platform = $1 AND ownership = 'sharedApplication'",
                &[&platform],
            )
            .await?;
        Ok(HookRecord {
            hook_id: row.get(0),
            endpoint_id: row.get(1),
        })
    }

    /// Records a dedicated hook before the provider is asked to create it
    /// (Webhook Deliveries §4.5.2): its endpoint, sealed secret, bound key
    /// and the access parameters its management will re-check. Refused at
    /// the deployment's or the owner's cleanup-job cap.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_dedicated_hook(
        &self,
        platform: &str,
        source_kind: &str,
        source_key: &str,
        access_parameters: &str,
        owner: &str,
        management_connection_id: &str,
        secret_envelope: &str,
        now: SystemTime,
    ) -> Result<HookRecord> {
        let mut client = self.pool.get().await.map_err(InboxError::Database)?;
        let tx = client.transaction().await?;
        // Lock order: owner, then deployment.
        let _owner = Self::lock_owners(&tx, &[owner.to_owned()]).await?;
        let deployment = Self::lock_deployment(&tx).await?;
        let owner_jobs: i64 = tx
            .query_one(
                "SELECT count(*) FROM webhook_cleanup_jobs j JOIN webhook_hooks h USING (hook_id)
                 WHERE h.owner = $1",
                &[&owner],
            )
            .await?
            .get(0);
        if deployment.cleanup_jobs >= self.policy.cleanup_max_jobs
            || owner_jobs >= self.policy.cleanup_max_jobs_per_owner
        {
            return Err(InboxError::CapacityUnavailable);
        }
        let hook = HookRecord {
            hook_id: crate::connect::random(),
            endpoint_id: crate::connect::random(),
        };
        let inserted = tx
            .execute(
                "INSERT INTO webhook_hooks (hook_id, platform, ownership, endpoint_id, source_kind, source_key,
                   access_parameters, owner, management_connection_id, secret_envelope, created_by_receiver,
                   state, created_at)
                 VALUES ($1, $2, 'dedicated', $3, $4, $5, $6, $7, $8, $9, TRUE, 'provisioning', $10)
                 ON CONFLICT DO NOTHING",
                &[
                    &hook.hook_id,
                    &platform,
                    &hook.endpoint_id,
                    &source_kind,
                    &source_key,
                    &access_parameters,
                    &owner,
                    &management_connection_id,
                    &secret_envelope,
                    &now,
                ],
            )
            .await?;
        if inserted == 0 {
            // The source has a dedicated hook already: subscribe to that one.
            return Err(InboxError::UnknownHook);
        }
        self.commit(tx).await?;
        Ok(hook)
    }

    /// The provider created the hook: its subscriptions start capturing.
    pub async fn hook_provisioned(
        &self,
        hook_id: &str,
        provider_hook_id: &str,
        now: SystemTime,
    ) -> Result<()> {
        let mut client = self.pool.get().await.map_err(InboxError::Database)?;
        let tx = client.transaction().await?;
        let ids: Vec<String> = tx
            .query(
                "SELECT subscription_id FROM webhook_subscriptions
                 WHERE hook_id = $1 AND state = 'provisioning' ORDER BY subscription_id",
                &[&hook_id],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        for id in &ids {
            if let Some(mut row) = Self::lock_subscription(&tx, id).await? {
                if row.state == State::Provisioning {
                    row.start_initial(now);
                    Self::save_subscription(&tx, &row).await?;
                }
            }
        }
        let updated = tx
            .execute(
                "UPDATE webhook_hooks SET state = 'active', provider_hook_id = $2
                 WHERE hook_id = $1 AND state = 'provisioning'",
                &[&hook_id, &provider_hook_id],
            )
            .await?;
        if updated == 0 {
            return Err(InboxError::UnknownHook);
        }
        self.commit(tx).await
    }

    /// The provider did not create the hook within its bounded retries: its
    /// subscriptions close, and so does the hook record (nothing to clean
    /// up at the provider).
    pub async fn hook_provisioning_failed(&self, hook_id: &str, now: SystemTime) -> Result<()> {
        let ids: Vec<String> = {
            let client = self.pool.get().await.map_err(InboxError::Database)?;
            client
                .query(
                    "SELECT subscription_id FROM webhook_subscriptions
                     WHERE hook_id = $1 AND state = 'provisioning' ORDER BY subscription_id",
                    &[&hook_id],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect()
        };
        for id in &ids {
            let mut client = self.pool.get().await.map_err(InboxError::Database)?;
            let tx = client.transaction().await?;
            if let Some(mut row) = Self::lock_subscription(&tx, id).await? {
                if row.state == State::Provisioning {
                    let mut owners =
                        Self::lock_owners(&tx, std::slice::from_ref(&row.owner)).await?;
                    let mut deployment = Self::lock_deployment(&tx).await?;
                    let owner = owners.get_mut(&row.owner).expect("locked");
                    Self::end(
                        &tx,
                        &self.policy,
                        &mut row,
                        owner,
                        &mut deployment,
                        ended::PROVISIONING_FAILED,
                        now,
                    )
                    .await?;
                    Self::save_owners(&tx, &owners).await?;
                    Self::save_deployment(&tx, &deployment).await?;
                }
            }
            self.commit(tx).await?;
        }
        let client = self.pool.get().await.map_err(InboxError::Database)?;
        client
            .execute(
                "UPDATE webhook_hooks SET state = 'closed', closed_at = $2, secret_envelope = NULL
                 WHERE hook_id = $1 AND state = 'provisioning'",
                &[&hook_id, &now],
            )
            .await?;
        Ok(())
    }

    // --- subscriptions ---------------------------------------------------------

    /// Creates a subscription after the caller's access check passed
    /// (Webhook Deliveries §4.4.1). It starts in `needs-reconciliation`
    /// with reason `initial`, or in `provisioning` while its dedicated hook
    /// is.
    pub async fn create_subscription(
        &self,
        new: NewSubscription,
        now: SystemTime,
    ) -> Result<SubscriptionView> {
        // An expired subscription never holds quota past a request: end the
        // owner's overdue ones first (each in its own transaction, keeping
        // the lock order subscription, owner, deployment).
        let overdue: Vec<String> = {
            let client = self.pool.get().await.map_err(InboxError::Database)?;
            client
                .query(
                    &format!(
                        "SELECT subscription_id FROM webhook_subscriptions
                         WHERE owner = $1 AND state IN {LIVE}
                           AND (lease_expires_at <= $2 OR progress_deadline_at <= $2)"
                    ),
                    &[&new.owner, &now],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect()
        };
        for id in &overdue {
            self.end_if_due(id, now).await?;
        }
        let mut client = self.pool.get().await.map_err(InboxError::Database)?;
        let tx = client.transaction().await?;
        let mut owners = Self::lock_owners(&tx, std::slice::from_ref(&new.owner)).await?;
        let deployment = Self::lock_deployment(&tx).await?;
        let hook = tx
            .query_opt(
                "SELECT state, platform, ownership, created_by_receiver FROM webhook_hooks WHERE hook_id = $1 FOR UPDATE",
                &[&new.hook_id],
            )
            .await?
            .ok_or(InboxError::UnknownHook)?;
        let hook_state: String = hook.get(0);
        let platform: String = hook.get(1);
        // The connection must be of the hook's document (Webhook Deliveries
        // §4.4.1), so equal keys of two providers never meet.
        let connection_platform: Option<String> = tx
            .query_opt(
                "SELECT platform FROM agent_connections WHERE connection_id = $1 AND owner = $2",
                &[&new.connection_id, &new.owner],
            )
            .await?
            .map(|row| row.get(0));
        if connection_platform.as_deref() != Some(platform.as_str()) {
            return Err(InboxError::UnknownConnection);
        }
        if !matches!(hook_state.as_str(), "active" | "provisioning") {
            return Err(InboxError::UnknownHook);
        }
        let owner = owners.get_mut(&new.owner).expect("locked");
        if owner.live_subscriptions >= self.policy.owner_max_live_subscriptions {
            return Err(InboxError::QuotaExceeded);
        }
        if deployment
            .last_sweep_at
            .is_some_and(|at| at + self.policy.sweep_interval * 3 < now)
        {
            // The sweeper is behind: new state could not be kept bounded.
            return Err(InboxError::CapacityUnavailable);
        }
        let mut row = SubRow {
            id: crate::connect::random(),
            connection_id: new.connection_id,
            owner: new.owner,
            consumer: new.consumer,
            hook_id: new.hook_id,
            dedicated: hook.get::<_, String>(2) == "dedicated",
            created_by_receiver: hook.get(3),
            source_kind: new.source_kind,
            source_key: new.source_key,
            events: new.events,
            state: State::Provisioning,
            closed_reason: None,
            generation: 0,
            next_seq: 1,
            barrier_seq: 0,
            ack_seq: 0,
            last_returned_seq: 0,
            lease_expires_at: Some(now + self.policy.lease),
            renew_after: Some(now + self.policy.renew_after),
            progress_deadline_at: None,
            access_checked_at: Some(now),
            pending_events: 0,
            pending_bytes: 0,
            suspended: false,
            suspended_missed: false,
            gap_generation: None,
            gap_reason: None,
            gap_detected_at: None,
            gap_last_ack: None,
            created_at: now,
            ended_at: None,
        };
        if hook_state == "active" {
            row.start_initial(now);
        }
        tx.execute(
            "INSERT INTO webhook_subscriptions (subscription_id, connection_id, owner, consumer, hook_id,
               source_kind, source_key, events, state, generation, next_seq, barrier_seq, ack_seq,
               last_returned_seq, pending_events, pending_bytes, suspended, suspended_missed, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, 0, 0, 0, 0, FALSE, FALSE, $12)",
            &[
                &row.id,
                &row.connection_id,
                &row.owner,
                &row.consumer,
                &row.hook_id,
                &row.source_kind,
                &row.source_key,
                &row.events,
                &row.state.as_str(),
                &row.generation,
                &row.barrier_seq,
                &row.created_at,
            ],
        )
        .await?;
        Self::save_subscription(&tx, &row).await?;
        owner.live_subscriptions += 1;
        Self::save_owners(&tx, &owners).await?;
        let view = self.view(&tx, &row).await?;
        self.commit(tx).await?;
        Ok(view)
    }

    /// Stores a verified delivery for every subscription it routes to
    /// (Webhook Deliveries §4.4.1), within every limit, or records the gap
    /// in its place. Only an `Ok` may be acknowledged to the provider; on
    /// `Err` nothing was committed.
    pub async fn ingest(&self, delivery: &Delivery, now: SystemTime) -> Result<IngestOutcome> {
        let mut client = self.pool.get().await.map_err(InboxError::Database)?;
        let tx = client.transaction().await?;
        let rows = tx
            .query(
                &format!(
                    "SELECT {SUB_COLUMNS} FROM webhook_subscriptions s JOIN webhook_hooks h ON h.hook_id = s.hook_id
                     WHERE h.endpoint_id = $1 AND s.source_kind = $2 AND s.source_key = $3
                       AND s.state IN ('needs-reconciliation', 'active') AND $4 = ANY(s.events)
                       AND EXISTS (SELECT 1 FROM agent_connections c
                                   WHERE c.connection_id = s.connection_id AND c.platform = h.platform)
                     ORDER BY s.subscription_id FOR UPDATE OF s"
                ),
                &[
                    &delivery.endpoint_id,
                    &delivery.source_kind,
                    &delivery.source_key,
                    &delivery.event_type,
                ],
            )
            .await?;
        let mut outcome = IngestOutcome::default();
        if rows.is_empty() {
            // Nobody wants it: no state at all, not even a receipt.
            tx.rollback().await?;
            return Ok(outcome);
        }
        let mut subs: Vec<SubRow> = rows.iter().map(SubRow::from_row).collect();
        outcome.routed = subs.len();
        let owner_ids: Vec<String> = subs.iter().map(|row| row.owner.clone()).collect();
        let mut owners = Self::lock_owners(&tx, &owner_ids).await?;
        let mut deployment = Self::lock_deployment(&tx).await?;
        let body_bytes = delivery.body.len() as i64;

        // Receipts, per owner (Webhook Deliveries §4.3).
        let mut owner_status: BTreeMap<String, ReceiptStatus> = BTreeMap::new();
        for owner in owners.keys() {
            let status = self
                .take_receipt(&tx, delivery, owner, &mut deployment, now)
                .await?;
            owner_status.insert(owner.clone(), status);
        }

        let mut retainers: Vec<usize> = Vec::new();
        for (index, row) in subs.iter_mut().enumerate() {
            let owner = owners.get_mut(&row.owner).expect("locked");
            if let Some(reason) = row.overdue(now) {
                Self::end(&tx, &self.policy, row, owner, &mut deployment, reason, now).await?;
                outcome.ended += 1;
                continue;
            }
            match owner_status[&row.owner] {
                ReceiptStatus::Duplicate => {
                    outcome.duplicates += 1;
                    continue;
                }
                ReceiptStatus::Floor => {
                    row.record_gap(gap::RECEIPTS, now);
                    Self::save_subscription(&tx, row).await?;
                    outcome.gaps += 1;
                    continue;
                }
                ReceiptStatus::Taken => {}
            }
            if row.suspended {
                row.suspended_missed = true;
                Self::save_subscription(&tx, row).await?;
                outcome.missed += 1;
                continue;
            }
            match self
                .make_room(&tx, row, owner, &mut deployment, body_bytes, now)
                .await?
            {
                None => retainers.push(index),
                Some(reason) => {
                    row.record_gap(reason, now);
                    Self::save_subscription(&tx, row).await?;
                    outcome.gaps += 1;
                }
            }
        }

        if !retainers.is_empty() {
            let needed =
                body_bytes + PAYLOAD_ROW_OVERHEAD + retainers.len() as i64 * REFERENCE_ROW_OVERHEAD;
            if deployment.inbox_bytes + needed > self.policy.deployment_max_inbox_bytes {
                // No owner's history is evicted for another's (§5.1).
                for index in retainers.drain(..) {
                    let row = &mut subs[index];
                    row.record_gap(gap::DEPLOYMENT, now);
                    Self::save_subscription(&tx, row).await?;
                    outcome.gaps += 1;
                }
            }
        }

        if !retainers.is_empty() {
            let payload_id: i64 = tx
                .query_one(
                    "INSERT INTO webhook_payloads (endpoint_id, delivery_id, event_type, action, source_kind,
                       source_key, received_at, sha256, bytes, body, references_left)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING payload_id",
                    &[
                        &delivery.endpoint_id,
                        &delivery.delivery_id,
                        &delivery.event_type,
                        &delivery.action,
                        &delivery.source_kind,
                        &delivery.source_key,
                        &now,
                        &hex(&Sha256::digest(&delivery.body)),
                        &body_bytes,
                        &delivery.body,
                        &(retainers.len() as i32),
                    ],
                )
                .await?
                .get(0);
            deployment.inbox_bytes += body_bytes + PAYLOAD_ROW_OVERHEAD;
            for index in retainers {
                let row = &mut subs[index];
                let owner = owners.get_mut(&row.owner).expect("locked");
                let seq = row.next_seq;
                row.next_seq += 1;
                tx.execute(
                    "INSERT INTO webhook_event_refs (subscription_id, seq, generation, payload_id, received_at, bytes)
                     VALUES ($1, $2, $3, $4, $5, $6)",
                    &[&row.id, &seq, &row.generation, &payload_id, &now, &body_bytes],
                )
                .await?;
                if row.pending_events == 0 {
                    // From the moment pending became non-empty (§4.3).
                    row.progress_deadline_at = Some(now + self.policy.progress_deadline);
                }
                row.pending_events += 1;
                row.pending_bytes += body_bytes;
                owner.pending_refs += 1;
                owner.pending_bytes += body_bytes;
                deployment.inbox_bytes += REFERENCE_ROW_OVERHEAD;
                Self::save_subscription(&tx, row).await?;
                outcome.retained += 1;
            }
        }
        Self::save_owners(&tx, &owners).await?;
        Self::save_deployment(&tx, &deployment).await?;
        self.commit(tx).await?;
        Ok(outcome)
    }

    /// Takes `owner`'s receipt for a delivery, within the per-owner and
    /// deployment caps; at a cap only receipts older than the minimum age
    /// are evicted (Webhook Deliveries §4.3).
    async fn take_receipt(
        &self,
        tx: &Transaction<'_>,
        delivery: &Delivery,
        owner: &str,
        deployment: &mut Deployment,
        now: SystemTime,
    ) -> Result<ReceiptStatus> {
        let existing: Option<SystemTime> = tx
            .query_opt(
                "SELECT expires_at FROM webhook_receipts
                 WHERE endpoint_id = $1 AND delivery_id = $2 AND owner = $3",
                &[&delivery.endpoint_id, &delivery.delivery_id, &owner],
            )
            .await?
            .map(|row| row.get(0));
        let expires_at = now + self.policy.receipt_ttl;
        if let Some(previous) = existing {
            if previous > now {
                return Ok(ReceiptStatus::Duplicate);
            }
            // An expired receipt not swept yet: renewed in place.
            tx.execute(
                "UPDATE webhook_receipts SET received_at = $4, expires_at = $5
                 WHERE endpoint_id = $1 AND delivery_id = $2 AND owner = $3",
                &[
                    &delivery.endpoint_id,
                    &delivery.delivery_id,
                    &owner,
                    &now,
                    &expires_at,
                ],
            )
            .await?;
            return Ok(ReceiptStatus::Taken);
        }
        let evictable_before = now
            .checked_sub(self.policy.receipt_min_age)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let owner_receipts: i64 = tx
            .query_one(
                "SELECT count(*) FROM webhook_receipts WHERE owner = $1",
                &[&owner],
            )
            .await?
            .get(0);
        if owner_receipts >= self.policy.receipt_max_per_owner {
            let evicted = tx
                .execute(
                    "DELETE FROM webhook_receipts WHERE ctid IN (
                       SELECT ctid FROM webhook_receipts WHERE owner = $1 AND received_at <= $2
                       ORDER BY received_at LIMIT 1)",
                    &[&owner, &evictable_before],
                )
                .await?;
            if evicted == 0 {
                return Ok(ReceiptStatus::Floor);
            }
            deployment.receipts -= 1;
        }
        if deployment.receipts >= self.policy.receipt_max_count {
            let evicted = tx
                .execute(
                    "DELETE FROM webhook_receipts WHERE ctid IN (
                       SELECT ctid FROM webhook_receipts WHERE received_at <= $1
                       ORDER BY received_at LIMIT 1)",
                    &[&evictable_before],
                )
                .await?;
            if evicted == 0 {
                return Ok(ReceiptStatus::Floor);
            }
            deployment.receipts -= 1;
        }
        tx.execute(
            "INSERT INTO webhook_receipts (endpoint_id, delivery_id, owner, received_at, expires_at)
             VALUES ($1, $2, $3, $4, $5)",
            &[
                &delivery.endpoint_id,
                &delivery.delivery_id,
                &owner,
                &now,
                &expires_at,
            ],
        )
        .await?;
        deployment.receipts += 1;
        Ok(ReceiptStatus::Taken)
    }

    /// Frees room in `row` for one more event of `bytes`, evicting its own
    /// oldest events (and recording the gap) where a subscription or owner
    /// limit requires it. `Some(reason)` when it cannot be retained.
    async fn make_room(
        &self,
        tx: &Transaction<'_>,
        row: &mut SubRow,
        owner: &mut OwnerRow,
        deployment: &mut Deployment,
        bytes: i64,
        now: SystemTime,
    ) -> Result<Option<&'static str>> {
        let policy = &self.policy;
        if bytes > policy.max_body_bytes || bytes > policy.subscription_max_pending_bytes {
            return Ok(Some(gap::OVERSIZED));
        }
        if let Some(cutoff) = now.checked_sub(policy.subscription_max_pending_age) {
            Self::evict(
                tx,
                row,
                owner,
                deployment,
                Release::ReceivedBefore(cutoff),
                gap::AGE,
                now,
            )
            .await?;
        }
        let sub_events = row.pending_events + 1 - policy.subscription_max_pending_events;
        let owner_events = owner.pending_refs + 1 - policy.owner_max_pending_references;
        let sub_bytes = row.pending_bytes + bytes - policy.subscription_max_pending_bytes;
        let owner_bytes = owner.pending_bytes + bytes - policy.owner_max_pending_bytes;
        let need_events = sub_events.max(owner_events).max(0);
        let need_bytes = sub_bytes.max(owner_bytes).max(0);
        if need_events == 0 && need_bytes == 0 {
            return Ok(None);
        }
        let reason = if owner_events > sub_events.max(0) || owner_bytes > sub_bytes.max(0) {
            gap::OWNER
        } else if sub_bytes > 0 {
            gap::BYTES
        } else {
            gap::EVENTS
        };
        if need_events > row.pending_events || need_bytes > row.pending_bytes {
            // This subscription's own history cannot make room.
            return Ok(Some(reason));
        }
        let up_to: Option<i64> = tx
            .query_one(
                "SELECT min(seq) FROM (
                   SELECT seq, row_number() OVER (ORDER BY seq) AS n, (sum(bytes) OVER (ORDER BY seq))::bigint AS total
                   FROM webhook_event_refs WHERE subscription_id = $1) oldest
                 WHERE n >= $2 AND total >= $3",
                &[&row.id, &need_events, &need_bytes],
            )
            .await?
            .get(0);
        let Some(up_to) = up_to else {
            return Ok(Some(reason));
        };
        Self::evict(
            tx,
            row,
            owner,
            deployment,
            Release::UpTo(up_to),
            reason,
            now,
        )
        .await?;
        Ok(None)
    }

    /// Up to `limit` events after `after` (or after the last
    /// acknowledgement), all of one generation (`webhook-subscriptions`
    /// §7). Refused while the last passing access check is too old.
    pub async fn fetch(
        &self,
        id: &str,
        consumer: &str,
        after: Option<&str>,
        limit: i64,
        now: SystemTime,
    ) -> Result<EventPage> {
        let mut client = self.pool.get().await.map_err(InboxError::Database)?;
        let tx = client.transaction().await?;
        let mut row = match self.open(&tx, id, consumer, now).await? {
            Ok(row) => row,
            Err(error) => {
                self.commit(tx).await?;
                return Err(error);
            }
        };
        if row.state == State::Provisioning {
            return Err(InboxError::NotReconciling);
        }
        if row.suspended
            || row
                .access_checked_at
                .is_none_or(|at| at + self.policy.access_max_check_age < now)
        {
            return Err(InboxError::AccessCheckRequired);
        }
        let start = match after {
            Some(cursor) => self.position(&row, cursor)?.1,
            None => row.ack_seq,
        };
        let limit = limit.clamp(1, self.policy.fetch_max_events);
        let rows = tx
            .query(
                "SELECT r.seq, r.generation, r.received_at, p.delivery_id, p.event_type, p.action,
                        p.source_kind, p.source_key, p.sha256, p.bytes, p.body
                 FROM webhook_event_refs r JOIN webhook_payloads p ON p.payload_id = r.payload_id
                 WHERE r.subscription_id = $1 AND r.seq > $2 ORDER BY r.seq LIMIT $3",
                &[&row.id, &start, &(limit + 1)],
            )
            .await?;
        let generation = rows
            .first()
            .map(|event| event.get::<_, i64>(1))
            .unwrap_or(row.generation);
        let mut events = Vec::new();
        let mut more = false;
        for event in &rows {
            if event.get::<_, i64>(1) != generation || events.len() as i64 == limit {
                more = true;
                break;
            }
            let seq: i64 = event.get(0);
            let body: Vec<u8> = event.get(10);
            events.push(EventView {
                cursor: self.cursor(&row, generation, seq),
                generation: generation_token(generation),
                delivery_id: event.get(3),
                event_type: event.get(4),
                action: event.get(5),
                received_at: rfc3339(event.get(2)),
                source: SourceView {
                    kind: event.get(6),
                    key: event.get(7),
                },
                payload: PayloadView {
                    media_type: "application/json",
                    bytes: event.get(9),
                    sha256: event.get(8),
                    body: STANDARD.encode(body),
                },
            });
            row.last_returned_seq = row.last_returned_seq.max(seq);
        }
        Self::save_subscription(&tx, &row).await?;
        let page = EventPage {
            subscription: row.id.clone(),
            generation: generation_token(generation),
            next: events.last().map(|event| event.cursor.clone()),
            more,
            events,
            reconciliation_required: self.reconciliation(&tx, &row).await?,
        };
        self.commit(tx).await?;
        Ok(page)
    }

    /// Acknowledges everything up to `cursor`; monotonic, and releases what
    /// it acknowledges.
    pub async fn acknowledge(
        &self,
        id: &str,
        consumer: &str,
        cursor: &str,
        now: SystemTime,
    ) -> Result<Acknowledgement> {
        let mut client = self.pool.get().await.map_err(InboxError::Database)?;
        let tx = client.transaction().await?;
        let mut row = match self.open(&tx, id, consumer, now).await? {
            Ok(row) => row,
            Err(error) => {
                self.commit(tx).await?;
                return Err(error);
            }
        };
        let (generation, seq) = self.position(&row, cursor)?;
        if seq > row.ack_seq {
            let mut owners = Self::lock_owners(&tx, std::slice::from_ref(&row.owner)).await?;
            let mut deployment = Self::lock_deployment(&tx).await?;
            let owner = owners.get_mut(&row.owner).expect("locked");
            Self::release(&tx, &mut row, owner, &mut deployment, Release::UpTo(seq)).await?;
            row.ack_seq = seq;
            row.progress_deadline_at =
                (row.pending_events > 0).then(|| now + self.policy.progress_deadline);
            Self::save_owners(&tx, &owners).await?;
            Self::save_deployment(&tx, &deployment).await?;
            Self::save_subscription(&tx, &row).await?;
        }
        let acknowledged = Acknowledgement {
            generation: generation_token(generation),
            cursor: self.cursor(&row, generation, row.ack_seq),
        };
        self.commit(tx).await?;
        Ok(acknowledged)
    }

    /// Applies an access check's result: a failure closes the subscription,
    /// a pass records when and resumes a suspended binding (recording the
    /// gap if it missed anything).
    async fn apply_access(
        &self,
        tx: &Transaction<'_>,
        row: &mut SubRow,
        access: AccessCheck,
        now: SystemTime,
    ) -> Result<std::result::Result<(), InboxError>> {
        match access {
            AccessCheck::Unavailable => Ok(Err(InboxError::AccessUnavailable)),
            AccessCheck::Failed => {
                let mut owners = Self::lock_owners(tx, std::slice::from_ref(&row.owner)).await?;
                let mut deployment = Self::lock_deployment(tx).await?;
                let owner = owners.get_mut(&row.owner).expect("locked");
                Self::end(
                    tx,
                    &self.policy,
                    row,
                    owner,
                    &mut deployment,
                    ended::ACCESS_DENIED,
                    now,
                )
                .await?;
                Self::save_owners(tx, &owners).await?;
                Self::save_deployment(tx, &deployment).await?;
                Ok(Err(InboxError::Ended(Box::new(self.ended_result(row)))))
            }
            AccessCheck::Passed => {
                row.access_checked_at = Some(now);
                if row.suspended {
                    row.suspended = false;
                    if row.suspended_missed && row.state.captures() {
                        row.record_gap(gap::SUSPENDED, now);
                    }
                    row.suspended_missed = false;
                }
                Ok(Ok(()))
            }
        }
    }

    /// Records an access check the receiver ran itself (before serving
    /// events, or after a revocation), without renewing the lease.
    pub async fn record_access_check(
        &self,
        id: &str,
        consumer: &str,
        access: AccessCheck,
        now: SystemTime,
    ) -> Result<SubscriptionView> {
        self.with_access(id, consumer, access, now, false).await
    }

    /// Renews the lease, after the caller re-ran the access check
    /// (`webhook-subscriptions` §4.3).
    pub async fn renew(
        &self,
        id: &str,
        consumer: &str,
        access: AccessCheck,
        now: SystemTime,
    ) -> Result<SubscriptionView> {
        self.with_access(id, consumer, access, now, true).await
    }

    async fn with_access(
        &self,
        id: &str,
        consumer: &str,
        access: AccessCheck,
        now: SystemTime,
        renew: bool,
    ) -> Result<SubscriptionView> {
        let mut client = self.pool.get().await.map_err(InboxError::Database)?;
        let tx = client.transaction().await?;
        let mut row = match self.open(&tx, id, consumer, now).await? {
            Ok(row) => row,
            Err(error) => {
                self.commit(tx).await?;
                return Err(error);
            }
        };
        if let Err(error) = self.apply_access(&tx, &mut row, access, now).await? {
            self.commit(tx).await?;
            return Err(error);
        }
        if renew {
            row.lease_expires_at = Some(now + self.policy.lease);
            row.renew_after = Some(now + self.policy.renew_after);
        }
        Self::save_subscription(&tx, &row).await?;
        let view = self.view(&tx, &row).await?;
        self.commit(tx).await?;
        Ok(view)
    }

    /// Completes a reconciliation for the current generation and barrier.
    pub async fn complete_reconciliation(
        &self,
        id: &str,
        consumer: &str,
        generation: &str,
        barrier: &str,
        access: AccessCheck,
        now: SystemTime,
    ) -> Result<SubscriptionView> {
        let mut client = self.pool.get().await.map_err(InboxError::Database)?;
        let tx = client.transaction().await?;
        let mut row = match self.open(&tx, id, consumer, now).await? {
            Ok(row) => row,
            Err(error) => {
                self.commit(tx).await?;
                return Err(error);
            }
        };
        if row.state != State::NeedsReconciliation {
            return Err(InboxError::NotReconciling);
        }
        if super::cursor::parse_generation(generation) != Some(row.generation) {
            return Err(InboxError::ObsoleteGeneration);
        }
        if self.cursors.decode(&row.id, barrier) != Some((row.generation, row.barrier_seq)) {
            return Err(InboxError::BarrierMismatch);
        }
        if let Err(error) = self.apply_access(&tx, &mut row, access, now).await? {
            self.commit(tx).await?;
            return Err(error);
        }
        if row.state == State::NeedsReconciliation {
            row.state = State::Active;
        }
        Self::save_subscription(&tx, &row).await?;
        let view = self.view(&tx, &row).await?;
        self.commit(tx).await?;
        Ok(view)
    }

    /// Ends a subscription at its consumer's request.
    pub async fn delete(
        &self,
        id: &str,
        consumer: &str,
        now: SystemTime,
    ) -> Result<SubscriptionView> {
        let mut client = self.pool.get().await.map_err(InboxError::Database)?;
        let tx = client.transaction().await?;
        let mut row = match self.open(&tx, id, consumer, now).await? {
            Ok(row) => row,
            Err(error) => {
                self.commit(tx).await?;
                return Err(error);
            }
        };
        let mut owners = Self::lock_owners(&tx, std::slice::from_ref(&row.owner)).await?;
        let mut deployment = Self::lock_deployment(&tx).await?;
        let owner = owners.get_mut(&row.owner).expect("locked");
        Self::end(
            &tx,
            &self.policy,
            &mut row,
            owner,
            &mut deployment,
            ended::DELETED,
            now,
        )
        .await?;
        Self::save_owners(&tx, &owners).await?;
        Self::save_deployment(&tx, &deployment).await?;
        let view = self.view(&tx, &row).await?;
        self.commit(tx).await?;
        Ok(view)
    }

    /// The subscription as its consumer sees it, deadlines enforced.
    pub async fn get(&self, id: &str, consumer: &str, now: SystemTime) -> Result<SubscriptionView> {
        let mut client = self.pool.get().await.map_err(InboxError::Database)?;
        let tx = client.transaction().await?;
        let row = match self.open(&tx, id, consumer, now).await? {
            Ok(row) => row,
            Err(error) => {
                self.commit(tx).await?;
                return Err(error);
            }
        };
        let view = self.view(&tx, &row).await?;
        self.commit(tx).await?;
        Ok(view)
    }

    // --- sweeping ----------------------------------------------------------------

    pub(crate) async fn transaction_client(
        &self,
    ) -> std::result::Result<super::pool::PooledClient<'_>, InboxError> {
        self.pool.get().await.map_err(InboxError::Database)
    }

    /// Ends one subscription if it is (still) past a deadline or without its
    /// connection. Returns whether it ended.
    pub(crate) async fn end_if_due(&self, id: &str, now: SystemTime) -> Result<bool> {
        let mut client = self.transaction_client().await?;
        let tx = client.transaction().await?;
        let Some(mut row) = Self::lock_subscription(&tx, id).await? else {
            return Ok(false);
        };
        if !row.state.is_live() {
            return Ok(false);
        }
        let reason = if !Self::connection_exists(&tx, &row.connection_id).await? {
            Some(ended::CONNECTION_DELETED)
        } else {
            row.overdue(now)
        };
        let Some(reason) = reason else {
            return Ok(false);
        };
        let mut owners = Self::lock_owners(&tx, std::slice::from_ref(&row.owner)).await?;
        let mut deployment = Self::lock_deployment(&tx).await?;
        let owner = owners.get_mut(&row.owner).expect("locked");
        Self::end(
            &tx,
            &self.policy,
            &mut row,
            owner,
            &mut deployment,
            reason,
            now,
        )
        .await?;
        Self::save_owners(&tx, &owners).await?;
        Self::save_deployment(&tx, &deployment).await?;
        self.commit(tx).await?;
        Ok(true)
    }

    /// Evicts one subscription's events older than the age limit.
    pub(crate) async fn age_out(&self, id: &str, now: SystemTime) -> Result<i64> {
        let Some(cutoff) = now.checked_sub(self.policy.subscription_max_pending_age) else {
            return Ok(0);
        };
        let mut client = self.transaction_client().await?;
        let tx = client.transaction().await?;
        let Some(mut row) = Self::lock_subscription(&tx, id).await? else {
            return Ok(0);
        };
        let mut owners = Self::lock_owners(&tx, std::slice::from_ref(&row.owner)).await?;
        let mut deployment = Self::lock_deployment(&tx).await?;
        let owner = owners.get_mut(&row.owner).expect("locked");
        let before = row.pending_events;
        Self::evict(
            &tx,
            &mut row,
            owner,
            &mut deployment,
            Release::ReceivedBefore(cutoff),
            gap::AGE,
            now,
        )
        .await?;
        let evicted = before - row.pending_events;
        Self::save_subscription(&tx, &row).await?;
        Self::save_owners(&tx, &owners).await?;
        Self::save_deployment(&tx, &deployment).await?;
        self.commit(tx).await?;
        Ok(evicted)
    }

    pub(crate) async fn finish_cleanup(
        &self,
        hook_id: &str,
        failed: bool,
        now: SystemTime,
    ) -> Result<()> {
        let mut client = self.transaction_client().await?;
        let tx = client.transaction().await?;
        let ids: Vec<String> = tx
            .query(
                "SELECT subscription_id FROM webhook_subscriptions
                 WHERE hook_id = $1 AND state = 'cleanup-pending' ORDER BY subscription_id",
                &[&hook_id],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        for id in &ids {
            if let Some(mut row) = Self::lock_subscription(&tx, id).await? {
                row.state = State::Closed;
                Self::save_subscription(&tx, &row).await?;
            }
        }
        let mut deployment = Self::lock_deployment(&tx).await?;
        let removed = tx
            .execute(
                "DELETE FROM webhook_cleanup_jobs WHERE hook_id = $1",
                &[&hook_id],
            )
            .await?;
        deployment.cleanup_jobs -= removed as i64;
        tx.execute(
            "UPDATE webhook_hooks SET state = 'closed', closed_at = $2, cleanup_failed = $3,
               secret_envelope = NULL, management_connection_id = NULL
             WHERE hook_id = $1",
            &[&hook_id, &now, &failed],
        )
        .await?;
        Self::save_deployment(&tx, &deployment).await?;
        self.commit(tx).await
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReceiptStatus {
    Taken,
    Duplicate,
    /// A cap left no receipt to evict: store nothing, record a gap, 2xx.
    Floor,
}
