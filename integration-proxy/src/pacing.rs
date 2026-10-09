//! Pacing of the proxy's own traffic against a provider's announced quotas
//! (docs/design/pieces.md P4): `x-throttling` buckets
//! (`openapi-extensions/spec/throttling`) partitioned by `sourceIp`, which
//! the provider counts against the proxy's address, shared by every tenant,
//! or by nothing (`partitionBy: []`, one counter for all callers).
//!
//! A sliding log per (platform, bucket): at most `requests` requests in any
//! interval of `window.seconds`. That keeps the proxy under the announced
//! limit for every window kind Throttling 0.2.0 allows, whatever the phase
//! of a fixed window: `fixed` (anchored or not), `sliding` and
//! `unspecified`. A full bucket refuses the request with `429` and a
//! `Retry-After` taken from the log; nothing is queued.
//!
//! Bounds: one log per declared bucket, so the keys come from the catalog,
//! never from callers; a bucket with more than [`MAX_PACED_REQUESTS`]
//! requests per window is not paced, so no log holds more timestamps than
//! that. In memory, per instance: with N instances behind one egress
//! address the proxy may send up to N times the limit, and other clients of
//! the provider behind the same address (or, for `[]`, anywhere) are not
//! seen.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

/// Buckets announcing more requests per window than this are not paced.
pub const MAX_PACED_REQUESTS: u64 = 10_000;

/// One bucket the proxy paces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacedBucket {
    pub id: String,
    pub requests: usize,
    pub window: Duration,
}

/// The paced buckets an operation selects, from a composed document: the
/// operation's own `x-throttling` array when present (it replaces the
/// default in full), else the root `applies`; only buckets with a known
/// `requests` of at most [`MAX_PACED_REQUESTS`], a positive
/// `window.seconds`, and `partitionBy` exactly `[sourceIp]` or `[]`.
/// Anything malformed or unknown is not paced (the provider still enforces
/// its own limit).
pub fn selected_buckets(document: &Value, operation: &Value) -> Vec<PacedBucket> {
    let Some(root) = document.get("x-throttling") else {
        return Vec::new();
    };
    let Some(limits) = root.get("limits").and_then(Value::as_object) else {
        return Vec::new();
    };
    let selection = operation
        .get("x-throttling")
        .or_else(|| root.get("applies"))
        .and_then(Value::as_array);
    let mut buckets = Vec::new();
    for id in selection.into_iter().flatten().filter_map(Value::as_str) {
        let Some(limit) = limits.get(id) else {
            continue;
        };
        let partition = limit.get("partitionBy").and_then(Value::as_array);
        let proxy_wide = match partition.map(Vec::as_slice) {
            Some([]) => true,
            Some([only]) => only.as_str() == Some("sourceIp"),
            _ => false,
        };
        let requests = limit.get("requests").and_then(Value::as_u64);
        let seconds = limit
            .get("window")
            .and_then(|window| window.get("seconds"))
            .and_then(Value::as_u64);
        if let (true, Some(requests @ 1..=MAX_PACED_REQUESTS), Some(seconds @ 1..)) =
            (proxy_wide, requests, seconds)
        {
            if !buckets.iter().any(|b: &PacedBucket| b.id == id) {
                buckets.push(PacedBucket {
                    id: id.to_owned(),
                    requests: requests as usize,
                    window: Duration::from_secs(seconds),
                });
            }
        }
    }
    buckets
}

/// The sliding logs, keyed by (platform, bucket id).
#[derive(Default)]
pub struct Pacer {
    logs: Mutex<HashMap<(String, String), VecDeque<Instant>>>,
}

impl Pacer {
    /// Takes one request in every bucket at `now`, or none: when any bucket
    /// is full, nothing is recorded and the answer is how long until a slot
    /// frees in every full bucket (at least one second).
    pub fn take(
        &self,
        platform: &str,
        buckets: &[PacedBucket],
        now: Instant,
    ) -> Result<(), Duration> {
        if buckets.is_empty() {
            return Ok(());
        }
        let mut logs = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        let mut wait = Duration::ZERO;
        for bucket in buckets {
            let log = logs
                .entry((platform.to_owned(), bucket.id.clone()))
                .or_default();
            while log
                .front()
                .is_some_and(|t| now.duration_since(*t) >= bucket.window)
            {
                log.pop_front();
            }
            if log.len() >= bucket.requests {
                // The oldest entry within the limit leaves the window first.
                let oldest = log[log.len() - bucket.requests];
                wait = wait.max(bucket.window - now.duration_since(oldest));
            }
        }
        if wait > Duration::ZERO {
            return Err(
                Duration::from_secs(wait.as_secs_f64().ceil() as u64).max(Duration::from_secs(1))
            );
        }
        for bucket in buckets {
            logs.get_mut(&(platform.to_owned(), bucket.id.clone()))
                .expect("created above")
                .push_back(now);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bucket(id: &str, requests: usize, seconds: u64) -> PacedBucket {
        PacedBucket {
            id: id.into(),
            requests,
            window: Duration::from_secs(seconds),
        }
    }

    #[test]
    fn a_sliding_log_admits_the_limit_in_any_window() {
        let pacer = Pacer::default();
        let b = [bucket("source", 3, 60)];
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        pacer.take("p", &b, at(0)).unwrap();
        pacer.take("p", &b, at(10)).unwrap();
        pacer.take("p", &b, at(20)).unwrap();
        // Full until the first entry leaves the window at 60 s.
        assert_eq!(pacer.take("p", &b, at(30)), Err(Duration::from_secs(30)));
        assert_eq!(pacer.take("p", &b, at(59)), Err(Duration::from_secs(1)));
        pacer.take("p", &b, at(60)).unwrap();
        // Unlike a fixed window, no burst at a boundary: 10 s and 20 s are
        // still inside the window ending at 61 s.
        assert_eq!(pacer.take("p", &b, at(61)), Err(Duration::from_secs(9)));
        // Fractions round up, so a retry never comes too early.
        let err = pacer
            .take("p", &b, at(61) + Duration::from_millis(500))
            .unwrap_err();
        assert_eq!(err, Duration::from_secs(9));
        // Another platform's bucket of the same name is separate.
        pacer.take("q", &b, at(61)).unwrap();
    }

    #[test]
    fn several_buckets_are_taken_together_or_not_at_all() {
        let pacer = Pacer::default();
        let start = Instant::now();
        let small = bucket("small", 1, 60);
        let big = bucket("big", 5, 60);
        pacer
            .take("p", &[small.clone(), big.clone()], start)
            .unwrap();
        // `small` is full: refused, and `big` is not charged for it.
        for _ in 0..3 {
            assert!(pacer
                .take("p", &[small.clone(), big.clone()], start)
                .is_err());
        }
        for _ in 0..4 {
            pacer.take("p", std::slice::from_ref(&big), start).unwrap();
        }
        assert!(pacer.take("p", std::slice::from_ref(&big), start).is_err());
        // The longest wait of the full buckets.
        let later = start + Duration::from_secs(20);
        assert_eq!(
            pacer.take("p", &[small, big, bucket("free", 9, 60)], later),
            Err(Duration::from_secs(40))
        );
        assert_eq!(pacer.take("p", &[], later), Ok(()));
    }

    #[test]
    fn only_proxy_wide_buckets_with_a_known_bounded_count_are_selected() {
        let document = json!({"x-throttling": {
            "limits": {
                "ip": {"requests": 150, "window": {"seconds": 300, "kind": "unspecified"}, "partitionBy": ["sourceIp"]},
                "everyone": {"requests": 1000, "window": {"seconds": 3600, "kind": "fixed", "anchor": "2026-01-01T00:00:00Z"}, "partitionBy": []},
                "user": {"requests": 10, "window": {"seconds": 60, "kind": "sliding"}, "partitionBy": ["user"]},
                "pair": {"requests": 10, "window": {"seconds": 60, "kind": "fixed"}, "partitionBy": ["sourceIp", "user"]},
                "unknownPartition": {"requests": 10, "window": {"seconds": 60, "kind": "fixed"}},
                "unknownCount": {"window": {"seconds": 60, "kind": "fixed"}, "partitionBy": ["sourceIp"]},
                "huge": {"requests": 10001, "window": {"seconds": 60, "kind": "fixed"}, "partitionBy": ["sourceIp"]},
                "atCap": {"requests": 10000, "window": {"seconds": 60, "kind": "sliding"}, "partitionBy": ["sourceIp"]},
                "noWindow": {"requests": 10, "partitionBy": ["sourceIp"]}
            },
            "applies": ["ip", "everyone", "user", "pair", "unknownPartition", "unknownCount", "huge", "atCap", "noWindow", "undefined", "ip"]
        }});
        let ids = |operation: Value| -> Vec<String> {
            selected_buckets(&document, &operation)
                .into_iter()
                .map(|b| b.id)
                .collect()
        };
        assert_eq!(ids(json!({})), ["ip", "everyone", "atCap"]);
        let ip = &selected_buckets(&document, &json!({}))[0];
        assert_eq!(ip.requests, 150);
        assert_eq!(ip.window, Duration::from_secs(300));
        // An operation's list replaces the default in full; `[]` selects none.
        assert_eq!(
            ids(json!({"x-throttling": ["everyone", "user"]})),
            ["everyone"]
        );
        assert!(ids(json!({"x-throttling": []})).is_empty());
        // No declaration, or no limits: nothing is paced.
        assert!(selected_buckets(&json!({}), &json!({})).is_empty());
        assert!(selected_buckets(&json!({"x-throttling": {"headers": {}}}), &json!({})).is_empty());
    }
}
