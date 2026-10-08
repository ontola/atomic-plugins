//! The bounded webhook inbox (ontola/atomic-plugins#369, step 2), per
//! `openapi-extensions/spec/webhook-subscriptions` and the storage rules of
//! `webhook-deliveries`.
//!
//! Off unless `WEBHOOKS_ENABLED=true`. Enabled, the proxy creates the inbox
//! tables and runs the sweeper; nothing else. No route is mounted: the
//! provider-facing receiver and the consumer routes are step 3, and until
//! then nothing outside the tests calls the store's operations.

pub mod cleanup;
pub mod cursor;
pub mod policy;
pub mod pool;
pub mod store;
pub mod sweeper;

#[cfg(test)]
mod tests;

pub use policy::Policy;
pub use store::Store;

/// Starts the inbox when `config` enables it: creates its schema and runs
/// the sweeper. Returns the store for the routes of step 3.
pub async fn start(
    config: &crate::config::WebhookConfig,
    database_url: &str,
    security: &crate::security::Security,
) -> Result<Option<std::sync::Arc<Store>>, String> {
    if !config.enabled {
        return Ok(None);
    }
    let store = std::sync::Arc::new(
        Store::connect(
            database_url,
            security,
            Policy::pilot(config.inbox_max_bytes),
        )
        .await?,
    );
    sweeper::spawn(store.clone());
    tracing::info!("webhook inbox enabled; no webhook route is mounted yet");
    Ok(Some(store))
}
