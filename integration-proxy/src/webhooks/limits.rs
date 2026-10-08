//! Rate limits on the webhook routes (plan: "Rate-limit verification work,
//! subscription creation"): per endpoint and per client network on
//! `POST /webhooks/{endpointId}`, checked before any verification work;
//! per owner on subscription creation, checked before its access check
//! reaches the provider.
//!
//! Fixed windows, in memory, per proxy instance: what they bound is this
//! instance's CPU and outbound calls. Memory is bounded too: at most
//! `MAX_KEYS` keys are tracked; past that, expired windows are dropped, and
//! if none has expired, every new key shares one overflow window with the
//! same limit, so a flood of addresses cannot grow the map or escape the
//! limit. Keys are only held in memory, never stored or logged.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_KEYS: usize = 10_000;
const OVERFLOW: &str = "\0overflow";

pub struct Limiter {
    limit: u32,
    window: Duration,
    max_keys: usize,
    windows: Mutex<HashMap<String, (Instant, u32)>>,
}

impl Limiter {
    pub fn new(limit: u32, window: Duration) -> Self {
        Self::with_max_keys(limit, window, MAX_KEYS)
    }

    fn with_max_keys(limit: u32, window: Duration, max_keys: usize) -> Self {
        Self {
            limit,
            window,
            max_keys,
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Counts one request for `key` at `now`; `Err(retry_after)` when the
    /// key's window is full.
    pub fn take(&self, key: &str, now: Instant) -> Result<(), Duration> {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let mut key = key;
        if !windows.contains_key(key) && windows.len() >= self.max_keys {
            let window = self.window;
            windows.retain(|_, (start, _)| now.duration_since(*start) < window);
            if windows.len() >= self.max_keys {
                key = OVERFLOW;
            }
        }
        let entry = windows.entry(key.to_owned()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        if entry.1 >= self.limit {
            let retry = self.window.saturating_sub(now.duration_since(entry.0));
            return Err(retry.max(Duration::from_secs(1)));
        }
        entry.1 += 1;
        Ok(())
    }
}

/// The three limits, from [`crate::config::WebhookConfig`].
pub struct Limits {
    pub ingress_per_endpoint: Limiter,
    pub ingress_per_network: Limiter,
    pub subscribe_per_owner: Limiter,
}

impl Limits {
    pub fn from_config(config: &crate::config::WebhookConfig) -> Self {
        Self {
            ingress_per_endpoint: Limiter::new(
                config.ingress_per_endpoint_per_minute,
                Duration::from_secs(60),
            ),
            ingress_per_network: Limiter::new(
                config.ingress_per_network_per_minute,
                Duration::from_secs(60),
            ),
            subscribe_per_owner: Limiter::new(
                config.subscribe_per_owner_per_hour,
                Duration::from_secs(3600),
            ),
        }
    }
}

/// A `429` with `Retry-After`, `no-store`.
pub fn too_many(retry: Duration) -> axum::response::Response {
    use axum::response::IntoResponse;
    let mut response = (
        axum::http::StatusCode::TOO_MANY_REQUESTS,
        axum::Json(serde_json::json!({"status": "error", "code": "rate-limited"})),
    )
        .into_response();
    let headers = response.headers_mut();
    headers.insert(
        axum::http::header::RETRY_AFTER,
        retry.as_secs().max(1).to_string().parse().unwrap(),
    );
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_admits_its_limit_then_reopens() {
        let limiter = Limiter::new(3, Duration::from_secs(60));
        let start = Instant::now();
        for _ in 0..3 {
            limiter.take("a", start).unwrap();
        }
        let retry = limiter
            .take("a", start + Duration::from_secs(20))
            .unwrap_err();
        assert_eq!(retry, Duration::from_secs(40));
        // Other keys are not affected.
        limiter.take("b", start).unwrap();
        // A new window.
        limiter.take("a", start + Duration::from_secs(60)).unwrap();
    }

    #[test]
    fn memory_is_bounded_and_new_keys_share_an_overflow_window() {
        let limiter = Limiter::with_max_keys(2, Duration::from_secs(60), 3);
        let start = Instant::now();
        for key in ["a", "b", "c"] {
            limiter.take(key, start).unwrap();
        }
        // The map is full and nothing has expired: new keys share one window.
        limiter.take("d", start).unwrap();
        limiter.take("e", start).unwrap();
        assert!(limiter.take("f", start).is_err());
        assert!(limiter.windows.lock().unwrap().len() <= 4);
        // Once windows expire, they are dropped for new keys.
        limiter.take("g", start + Duration::from_secs(61)).unwrap();
        assert!(limiter.windows.lock().unwrap().len() <= 2);
    }
}
