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

/// The inbox and the operator-configured shared-hook secrets.
pub struct Webhooks {
    pub store: Arc<Store>,
    shared_secrets: BTreeMap<String, Vec<u8>>,
}

impl Webhooks {
    pub fn new(store: Arc<Store>, shared_secrets: BTreeMap<String, Vec<u8>>) -> Self {
        Self {
            store,
            shared_secrets,
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
