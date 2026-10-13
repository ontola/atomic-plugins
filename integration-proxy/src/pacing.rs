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

/// A limit's `(requests, window seconds)`. For a Limit Object with `tiers`
/// (Throttling 0.5.0, plan tiers): the tier named in `configured`, when it is
/// one of them, else the most restrictive tier, the lowest requests per
/// second and, of two equal rates, the longer window. Tiers without a
/// positive `requests` and `window.seconds` are skipped. `None` when the
/// limit has no usable amount.
pub fn limit_amount(limit: &Value, configured: Option<&str>) -> Option<(u64, u64)> {
    let amount = |value: &Value| -> Option<(u64, u64)> {
        let requests = value.get("requests").and_then(Value::as_u64)?;
        let seconds = value
            .get("window")
            .and_then(|window| window.get("seconds"))
            .and_then(Value::as_u64)?;
        (requests > 0 && seconds > 0).then_some((requests, seconds))
    };
    let Some(tiers) = limit.get("tiers").and_then(Value::as_array) else {
        return amount(limit);
    };
    if let Some(chosen) = configured.and_then(|name| {
        tiers
            .iter()
            .find(|tier| tier.get("name").and_then(Value::as_str) == Some(name))
            .and_then(amount)
    }) {
        return Some(chosen);
    }
    tiers.iter().filter_map(amount).min_by(|a, b| {
        // a's rate a.0/a.1 against b's, without division; then the longer
        // window first.
        (u128::from(a.0) * u128::from(b.1))
            .cmp(&(u128::from(b.0) * u128::from(a.1)))
            .then(b.1.cmp(&a.1))
    })
}

/// What is wrong with a catalog selection's `throttlingTiers` (a map from
/// bucket id to tier name) for this document: entries that name no bucket
/// with `tiers`, or no tier of it, or are not strings. Each such entry is
/// ignored, so the bucket is paced at its most restrictive tier; the
/// catalog load logs these.
pub fn tier_selection_problems(
    document: &Value,
    selection: &serde_json::Map<String, Value>,
) -> Vec<String> {
    let Some(tiers) = selection.get("throttlingTiers") else {
        return Vec::new();
    };
    let Some(tiers) = tiers.as_object() else {
        return vec!["is not an object of bucket ids to tier names".into()];
    };
    let limits = document
        .get("x-throttling")
        .and_then(|root| root.get("limits"))
        .and_then(Value::as_object);
    let mut problems = Vec::new();
    for (bucket, name) in tiers {
        let names: Vec<&str> = limits
            .and_then(|limits| limits.get(bucket))
            .and_then(|limit| limit.get("tiers"))
            .and_then(Value::as_array)
            .map(|tiers| {
                tiers
                    .iter()
                    .filter_map(|tier| tier.get("name").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default();
        match name.as_str() {
            _ if names.is_empty() => problems.push(format!("bucket {bucket:?} has no plan tiers")),
            Some(name) if names.contains(&name) => {}
            Some(name) => problems.push(format!("bucket {bucket:?} has no tier {name:?}")),
            None => problems.push(format!("the tier for bucket {bucket:?} is not a string")),
        }
    }
    problems
}

/// The paced buckets an operation selects, from a composed document: the
/// operation's own `x-throttling` array when present (it replaces the
/// default in full), else the root `applies`; only buckets with a known
/// `requests` of at most [`MAX_PACED_REQUESTS`], a positive
/// `window.seconds`, and `partitionBy` exactly `[sourceIp]` or `[]`. A
/// bucket with plan `tiers` is paced at the tier `tiers` names for it (the
/// catalog selection's `throttlingTiers`), else at its most restrictive tier
/// ([`limit_amount`]). Anything malformed or unknown is not paced (the
/// provider still enforces its own limit).
pub fn selected_buckets(
    document: &Value,
    operation: &Value,
    tiers: Option<&serde_json::Map<String, Value>>,
) -> Vec<PacedBucket> {
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
        let configured = tiers
            .and_then(|tiers| tiers.get(id))
            .and_then(Value::as_str);
        if let (true, Some((requests @ 1..=MAX_PACED_REQUESTS, seconds))) =
            (proxy_wide, limit_amount(limit, configured))
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
    /// Takes one request in every bucket now, or none: when any bucket is
    /// full, nothing is recorded and the answer is how long until a slot
    /// frees in every full bucket, in whole seconds rounded up. The clock is
    /// read inside the lock, so entries are appended in time order.
    pub fn take(&self, platform: &str, buckets: &[PacedBucket]) -> Result<(), Duration> {
        self.take_with(platform, buckets, Instant::now)
    }

    fn take_with(
        &self,
        platform: &str,
        buckets: &[PacedBucket],
        clock: impl FnOnce() -> Instant,
    ) -> Result<(), Duration> {
        if buckets.is_empty() {
            return Ok(());
        }
        let mut logs = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        let now = clock();
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
            // `wait` is positive, so rounding up gives at least one second.
            return Err(Duration::from_secs(wait.as_secs_f64().ceil() as u64));
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

    impl Pacer {
        fn take_at(
            &self,
            platform: &str,
            buckets: &[PacedBucket],
            now: Instant,
        ) -> Result<(), Duration> {
            self.take_with(platform, buckets, || now)
        }
    }

    fn bucket(id: &str, requests: usize, seconds: u64) -> PacedBucket {
        PacedBucket {
            id: id.into(),
            requests,
            window: Duration::from_secs(seconds),
        }
    }

    fn tiered() -> Value {
        json!({"partitionBy": ["sourceIp"], "tiers": [
            {"name": "FREE", "requests": 30, "window": {"seconds": 3600, "kind": "unspecified"}},
            {"name": "PAID", "requests": 20, "window": {"seconds": 1, "kind": "unspecified"}},
            {"name": "SLOW", "requests": 60, "window": {"seconds": 7200, "kind": "fixed"}},
            {"name": "BROKEN", "window": {"seconds": 1, "kind": "fixed"}}
        ]})
    }

    #[test]
    fn a_tiered_limit_uses_the_configured_tier_else_the_most_restrictive() {
        let limit = tiered();
        assert_eq!(limit_amount(&limit, Some("PAID")), Some((20, 1)));
        // FREE and SLOW have the same rate (1 per 120 s): the longer window.
        assert_eq!(limit_amount(&limit, None), Some((60, 7200)));
        // An unknown or unusable tier falls back to the most restrictive.
        assert_eq!(limit_amount(&limit, Some("GOLD")), Some((60, 7200)));
        assert_eq!(limit_amount(&limit, Some("BROKEN")), Some((60, 7200)));
        // A limit without tiers is its own amount; with no usable tier, none.
        assert_eq!(
            limit_amount(
                &json!({"requests": 5, "window": {"seconds": 60}}),
                Some("PAID")
            ),
            Some((5, 60))
        );
        assert_eq!(limit_amount(&json!({"tiers": [{"name": "X"}]}), None), None);
        assert_eq!(limit_amount(&json!({"tiers": []}), None), None);
    }

    #[test]
    fn a_tiered_proxy_wide_bucket_is_paced_at_its_selected_tier() {
        let document = json!({"x-throttling": {
            "limits": {"plan": tiered(), "user": {"partitionBy": ["user"], "tiers": [
                {"name": "FREE", "requests": 1, "window": {"seconds": 1}}]}},
            "applies": ["plan", "user"]
        }});
        let paced = |tiers: Value| selected_buckets(&document, &json!({}), tiers.as_object());
        assert_eq!(
            paced(json!({})),
            [bucket("plan", 60, 7200)],
            "default: most restrictive; a user bucket is not paced"
        );
        assert_eq!(paced(json!({"plan": "PAID"})), [bucket("plan", 20, 1)]);
        assert_eq!(paced(json!({"plan": "GOLD"})), [bucket("plan", 60, 7200)]);
        // A tier above the cap is not paced.
        let huge = json!({"x-throttling": {"limits": {"b": {"partitionBy": [], "tiers": [
            {"name": "BIG", "requests": 10001, "window": {"seconds": 1}}]}}, "applies": ["b"]}});
        assert!(selected_buckets(&huge, &json!({}), None).is_empty());

        let selection = |tiers: Value| {
            json!({"query_overrides": [], "throttlingTiers": tiers})
                .as_object()
                .unwrap()
                .clone()
        };
        assert!(tier_selection_problems(&document, &selection(json!({"plan": "PAID"}))).is_empty());
        assert!(tier_selection_problems(&document, json!({}).as_object().unwrap()).is_empty());
        let problems = tier_selection_problems(
            &document,
            &selection(json!({"plan": "GOLD", "missing": "FREE", "user": 3})),
        );
        assert_eq!(problems.len(), 3, "{problems:?}");
        assert!(problems
            .iter()
            .any(|p| p.contains("\"plan\" has no tier \"GOLD\"")));
        assert!(problems
            .iter()
            .any(|p| p.contains("\"missing\" has no plan tiers")));
        assert!(problems
            .iter()
            .any(|p| p.contains("\"user\" is not a string")));
        assert_eq!(
            tier_selection_problems(&document, &selection(json!(["plan"]))).len(),
            1
        );
    }

    #[test]
    fn a_sliding_log_admits_the_limit_in_any_window() {
        let pacer = Pacer::default();
        let b = [bucket("source", 3, 60)];
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        pacer.take_at("p", &b, at(0)).unwrap();
        pacer.take_at("p", &b, at(10)).unwrap();
        pacer.take_at("p", &b, at(20)).unwrap();
        // Full until the first entry leaves the window at 60 s.
        assert_eq!(pacer.take_at("p", &b, at(30)), Err(Duration::from_secs(30)));
        assert_eq!(pacer.take_at("p", &b, at(59)), Err(Duration::from_secs(1)));
        pacer.take_at("p", &b, at(60)).unwrap();
        // Unlike a fixed window, no burst at a boundary: 10 s and 20 s are
        // still inside the window ending at 61 s.
        assert_eq!(pacer.take_at("p", &b, at(61)), Err(Duration::from_secs(9)));
        // Fractions round up, so a retry never comes too early.
        let err = pacer
            .take_at("p", &b, at(61) + Duration::from_millis(500))
            .unwrap_err();
        assert_eq!(err, Duration::from_secs(9));
        // Another platform's bucket of the same name is separate.
        pacer.take_at("q", &b, at(61)).unwrap();
    }

    #[test]
    fn several_buckets_are_taken_together_or_not_at_all() {
        let pacer = Pacer::default();
        let start = Instant::now();
        let small = bucket("small", 1, 60);
        let big = bucket("big", 5, 60);
        pacer
            .take_at("p", &[small.clone(), big.clone()], start)
            .unwrap();
        // `small` is full: refused, and `big` is not charged for it.
        for _ in 0..3 {
            assert!(pacer
                .take_at("p", &[small.clone(), big.clone()], start)
                .is_err());
        }
        for _ in 0..4 {
            pacer
                .take_at("p", std::slice::from_ref(&big), start)
                .unwrap();
        }
        assert!(pacer
            .take_at("p", std::slice::from_ref(&big), start)
            .is_err());
        // The longest wait of the full buckets.
        let later = start + Duration::from_secs(20);
        assert_eq!(
            pacer.take_at("p", &[small, big, bucket("free", 9, 60)], later),
            Err(Duration::from_secs(40))
        );
        assert_eq!(pacer.take_at("p", &[], later), Ok(()));
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
            selected_buckets(&document, &operation, None)
                .into_iter()
                .map(|b| b.id)
                .collect()
        };
        assert_eq!(ids(json!({})), ["ip", "everyone", "atCap"]);
        let ip = &selected_buckets(&document, &json!({}), None)[0];
        assert_eq!(ip.requests, 150);
        assert_eq!(ip.window, Duration::from_secs(300));
        // An operation's list replaces the default in full; `[]` selects none.
        assert_eq!(
            ids(json!({"x-throttling": ["everyone", "user"]})),
            ["everyone"]
        );
        assert!(ids(json!({"x-throttling": []})).is_empty());
        // No declaration, or no limits: nothing is paced.
        assert!(selected_buckets(&json!({}), &json!({}), None).is_empty());
        assert!(
            selected_buckets(&json!({"x-throttling": {"headers": {}}}), &json!({}), None)
                .is_empty()
        );
    }
}
