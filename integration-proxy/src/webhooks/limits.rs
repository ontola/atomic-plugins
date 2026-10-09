//! Rate limits on the webhook routes (plan: "Rate-limit verification work,
//! subscription creation"). On `POST /webhooks/{endpointId}` they count
//! refusals only and never refuse a delivery that verifies, so a third
//! party cannot make the proxy refuse a provider's real deliveries, which a
//! provider such as GitHub does not retry: per client network, for ids that
//! are malformed or name no endpoint; per endpoint, for requests to it that
//! fail verification. The work a request can cause is bounded by the
//! ingress gate (lookup, read and database slots), not by these. Per owner
//! on subscription creation, checked before its access check reaches the
//! provider.
//!
//! Fixed windows, in memory, per proxy instance. Memory is bounded: at most
//! `MAX_KEYS` keys are tracked; past that, expired windows are dropped, and
//! if none has expired a new key passes uncounted. A shared overflow window
//! would let whoever fills the map block every key not yet in it, the
//! provider's addresses among them. Keys are only held in memory, never
//! stored or logged.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_KEYS: usize = 10_000;

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

    /// Whether `key`'s window is full at `now`, without counting anything.
    /// A key that is not tracked is never blocked.
    pub fn blocked(&self, key: &str, now: Instant) -> Option<Duration> {
        let windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let (start, count) = windows.get(key)?;
        if now.duration_since(*start) >= self.window || *count < self.limit {
            return None;
        }
        Some(
            self.window
                .saturating_sub(now.duration_since(*start))
                .max(Duration::from_secs(1)),
        )
    }

    /// How many keys are tracked.
    #[cfg(test)]
    pub(crate) fn tracked(&self) -> usize {
        self.windows.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Counts one request for `key` at `now`; `Err(retry_after)` when the
    /// key's window is full. With the map full of live windows, a new key
    /// passes uncounted.
    pub fn take(&self, key: &str, now: Instant) -> Result<(), Duration> {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        if !windows.contains_key(key) && windows.len() >= self.max_keys {
            let window = self.window;
            windows.retain(|_, (start, _)| now.duration_since(*start) < window);
            if windows.len() >= self.max_keys {
                return Ok(());
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
    fn blocked_tells_without_counting() {
        let limiter = Limiter::new(2, Duration::from_secs(60));
        let start = Instant::now();
        assert_eq!(limiter.blocked("a", start), None);
        assert_eq!(limiter.blocked("a", start), None);
        limiter.take("a", start).unwrap();
        limiter.take("a", start).unwrap();
        assert_eq!(limiter.blocked("a", start), Some(Duration::from_secs(60)));
        assert_eq!(limiter.blocked("a", start + Duration::from_secs(60)), None);
    }

    /// Review of the rate-limits PR, blocker B: with the map full, a key
    /// that is not in it passes, so whoever fills the map cannot block the
    /// keys it does not hold (a provider's delivery addresses).
    #[test]
    fn a_full_map_never_blocks_a_key_it_does_not_hold() {
        let limiter = Limiter::with_max_keys(2, Duration::from_secs(60), 3);
        let start = Instant::now();
        // An attacker fills the map and uses up its own windows.
        for key in ["a", "b", "c"] {
            limiter.take(key, start).unwrap();
            limiter.take(key, start).unwrap();
            assert!(limiter.take(key, start).is_err());
            assert!(limiter.blocked(key, start).is_some());
        }
        // Keys it does not hold pass, uncounted, however often.
        for _ in 0..10 {
            assert_eq!(limiter.blocked("provider", start), None);
            limiter.take("provider", start).unwrap();
        }
        assert_eq!(limiter.tracked(), 3);
        // Once windows expire, they are dropped and new keys are counted.
        let later = start + Duration::from_secs(61);
        limiter.take("provider", later).unwrap();
        limiter.take("provider", later).unwrap();
        assert!(limiter.take("provider", later).is_err());
        assert_eq!(limiter.tracked(), 1);
    }
}
