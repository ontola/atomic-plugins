//! Provider webhooks (ontola/atomic-plugins#369): the bounded inbox (step 2)
//! and verified ingress and consumption (step 3), per
//! `openapi-extensions/spec/webhook-deliveries` and `webhook-subscriptions`.
//!
//! Off unless `WEBHOOKS_ENABLED=true`: then the inbox tables, the sweeper
//! and the webhook routes exist; otherwise none of them. Everything here is
//! generic: a platform takes part only through its catalog document's
//! `x-webhook-deliveries`, and its shared hook's secret comes from
//! `WEBHOOK_SECRET_<PLATFORM>`, the name derived from the catalog's
//! platform name like the OAuth client variables.

use std::collections::BTreeMap;
use std::sync::Arc;

pub mod cleanup;
pub mod cursor;
pub mod ingress;
pub mod metadata;
pub mod policy;
pub mod pool;
pub mod provider;
pub mod routes;
pub mod store;
pub mod sweeper;
pub mod verify;

#[cfg(test)]
mod route_tests;
#[cfg(test)]
mod tests;

pub use policy::Policy;
pub use store::Store;

/// How much ingress work runs at once, and for how long (review of #394):
/// what an unauthenticated sender can make the receiver hold.
pub struct IngressGate {
    /// Bodies being read at once; each is at most the verification cap.
    pub reads: tokio::sync::Semaphore,
    /// Endpoint lookups at once, apart from the deliveries' database slots,
    /// so a flood of unknown ids cannot take those slots from verified
    /// deliveries.
    pub lookups: tokio::sync::Semaphore,
    /// Bodies read at once for one endpoint, so one endpoint (or one
    /// attacker at it) cannot hold every read slot.
    pub reads_per_endpoint: usize,
    pub reading: std::sync::Mutex<std::collections::HashMap<String, usize>>,
    /// Deliveries using the database at once (lookup, revocation, store),
    /// fewer than the inbox pool's four connections, so consumer routes and
    /// the sweeper always find one.
    pub database: tokio::sync::Semaphore,
    /// How long a body may take to arrive.
    pub read_timeout: std::time::Duration,
    /// How long a delivery waits for a slot before `503`.
    pub wait: std::time::Duration,
}

/// Bodies read at once (at most 8 x 25 MiB held).
pub const INGRESS_READS: usize = 8;
/// Deliveries using the database at once.
pub const INGRESS_DATABASE: usize = 2;
/// Endpoint lookups at once (the third of the pool's four connections at
/// most; the fourth stays free for consumer routes and the sweeper).
pub const INGRESS_LOOKUPS: usize = 1;
/// Bodies read at once per endpoint.
pub const INGRESS_READS_PER_ENDPOINT: usize = 4;

impl Default for IngressGate {
    fn default() -> Self {
        Self {
            reads: tokio::sync::Semaphore::new(INGRESS_READS),
            lookups: tokio::sync::Semaphore::new(INGRESS_LOOKUPS),
            reads_per_endpoint: INGRESS_READS_PER_ENDPOINT,
            reading: Default::default(),
            database: tokio::sync::Semaphore::new(INGRESS_DATABASE),
            read_timeout: std::time::Duration::from_secs(10),
            wait: std::time::Duration::from_secs(3),
        }
    }
}

/// Long polls waiting at once: in all, and per consumer agent.
pub const MAX_WAITERS: usize = 256;
pub const MAX_WAITERS_PER_CONSUMER: usize = 4;

/// The inbox and the operator-configured shared-hook secrets.
pub struct Webhooks {
    pub store: Arc<Store>,
    shared_secrets: BTreeMap<String, Vec<u8>>,
    pub gate: IngressGate,
    /// Long polls waiting, per consumer.
    pub waiting: std::sync::Mutex<std::collections::HashMap<String, usize>>,
}

impl Webhooks {
    pub fn new(store: Arc<Store>, shared_secrets: BTreeMap<String, Vec<u8>>) -> Self {
        Self {
            store,
            shared_secrets,
            gate: IngressGate::default(),
            waiting: Default::default(),
        }
    }

    pub fn shared_secret(&self, platform: &str) -> Option<&[u8]> {
        self.shared_secrets.get(platform).map(Vec::as_slice)
    }
}

/// The environment variable holding a platform's shared-hook secret.
pub fn secret_variable(platform: &str) -> String {
    format!(
        "WEBHOOK_SECRET_{}",
        platform.to_ascii_uppercase().replace('-', "_")
    )
}

/// Associated data of a dedicated hook's sealed secret: bound to its row.
pub fn hook_secret_aad(hook_id: &str) -> Vec<u8> {
    format!("webhook-hook-secret-v1:{hook_id}").into_bytes()
}

/// Starts the inbox when `config` enables it: creates its schema and reads
/// the shared-hook secrets of the catalog's platforms that declare webhook
/// deliveries. The caller spawns the sweeper once its state exists.
pub async fn start(
    config: &crate::config::WebhookConfig,
    database_url: &str,
    security: &crate::security::Security,
    catalog: &crate::catalog::Catalog,
) -> Result<Option<Arc<Webhooks>>, String> {
    if !config.enabled {
        return Ok(None);
    }
    let store = Arc::new(
        Store::connect(
            database_url,
            security,
            Policy::pilot(config.inbox_max_bytes),
        )
        .await?,
    );
    let mut secrets = BTreeMap::new();
    for platform in catalog.names() {
        if catalog.webhook_document(&platform).is_none() {
            continue;
        }
        match std::env::var(secret_variable(&platform)) {
            Ok(secret) if !secret.is_empty() => {
                secrets.insert(platform, secret.into_bytes());
            }
            _ => tracing::warn!(
                %platform,
                variable = %secret_variable(&platform),
                "declares webhook deliveries but has no shared-hook secret; its deliveries are refused"
            ),
        }
    }
    tracing::info!("webhook inbox enabled");
    Ok(Some(Arc::new(Webhooks::new(store, secrets))))
}
