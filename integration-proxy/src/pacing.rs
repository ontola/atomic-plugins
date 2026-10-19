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
//! Bounds: one log per declared bucket, or per tier of a bucket with plan
//! tiers, so the keys come from the catalog, never from callers. A bucket or
//! tier with more than [`MAX_PACED_REQUESTS`] requests per window is not
//! paced, so no log holds more timestamps than that; for a tiered bucket
//! the other tiers still count, which paces below what Throttling requires
//! (every tier at once) when the left-out tier would have been the binding
//! one. In memory, per instance: with N instances behind one egress
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
    /// The tier's position in the limit's `tiers`, for a bucket with plan
    /// tiers: each tier keeps its own log, keyed apart from every bucket id.
    pub tier: Option<usize>,
    pub requests: usize,
    pub window: Duration,
}

/// The counts a limit asks a consumer to keep within, as `(tier, requests,
/// window seconds)`: its own `requests` in its `window` (tier `None`); for a
/// Limit Object with plan `tiers` (Throttling 0.5.0), the tier whose `plans`
/// name `plan`, else every tier at once, each its own count over the same
/// requests (no single tier is safe alone: 30 per hour still allows a burst
/// that 20 per second forbids). A tier is told apart by its position in
/// `tiers`, so it keeps its own count. Tiers without a positive `requests`
/// and `window.seconds` are skipped.
pub fn limit_counts(limit: &Value, plan: Option<&str>) -> Vec<(Option<usize>, u64, u64)> {
    let amount = |value: &Value| -> Option<(u64, u64)> {
        let requests = value.get("requests").and_then(Value::as_u64)?;
        let seconds = value
            .get("window")
            .and_then(|window| window.get("seconds"))
            .and_then(Value::as_u64)?;
        (requests > 0 && seconds > 0).then_some((requests, seconds))
    };
    let Some(tiers) = limit.get("tiers").and_then(Value::as_array) else {
        return amount(limit)
            .map(|(requests, seconds)| (None, requests, seconds))
            .into_iter()
            .collect();
    };
    let tiers: Vec<(Option<usize>, &Value)> = tiers
        .iter()
        .enumerate()
        .map(|(index, tier)| (Some(index), tier))
        .collect();
    let names = |tier: &Value, plan: &str| {
        tier.get("plans")
            .and_then(Value::as_array)
            .is_some_and(|plans| plans.iter().any(|p| p.as_str() == Some(plan)))
    };
    if let Some((suffix, tier)) =
        plan.and_then(|plan| tiers.iter().find(|(_, tier)| names(tier, plan)))
    {
        if let Some((requests, seconds)) = amount(tier) {
            return vec![(*suffix, requests, seconds)];
        }
    }
    tiers
        .iter()
        .filter_map(|(suffix, tier)| {
            amount(tier).map(|(requests, seconds)| (*suffix, requests, seconds))
        })
        .collect()
}

/// What is wrong with a catalog selection's `throttlingPlans` (a map from
/// bucket id to the provider plan the deployment is on) for this document,
/// each a complete sentence for the catalog load to log: an entry for a
/// bucket id not in `limits`, for a bucket without plan tiers, for a plan no
/// tier names, or that is not a string. Such an entry is ignored.
pub fn plan_selection_problems(
    document: &Value,
    selection: &serde_json::Map<String, Value>,
) -> Vec<String> {
    let Some(plans) = selection.get("throttlingPlans") else {
        return Vec::new();
    };
    let Some(plans) = plans.as_object() else {
        return vec![
            "throttlingPlans is not an object of bucket ids to plan names; it is ignored, and every tiered bucket keeps within all its tiers".into(),
        ];
    };
    let limits = document
        .get("x-throttling")
        .and_then(|root| root.get("limits"))
        .and_then(Value::as_object);
    let mut problems = Vec::new();
    for (bucket, plan) in plans {
        let Some(limit) = limits.and_then(|limits| limits.get(bucket)) else {
            problems.push(format!(
                "throttlingPlans names {bucket:?}: no such bucket in x-throttling limits; the entry is ignored"
            ));
            continue;
        };
        let named: Vec<&str> = limit
            .get("tiers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|tier| tier.get("plans").and_then(Value::as_array))
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        match plan.as_str() {
            _ if named.is_empty() => problems.push(format!(
                "throttlingPlans names {bucket:?}, which has no plan tiers; the entry is ignored"
            )),
            Some(plan) if named.contains(&plan) => {}
            Some(plan) => problems.push(format!(
                "throttlingPlans gives {bucket:?} the plan {plan:?}, which no tier names; the bucket keeps within all its tiers"
            )),
            None => problems.push(format!(
                "throttlingPlans gives {bucket:?} a plan that is not a string; the bucket keeps within all its tiers"
            )),
        }
    }
    problems
}

/// The paced buckets an operation selects, from a composed document: the
/// operation's own `x-throttling` array when present (it replaces the
/// default in full), else the root `applies`; only buckets with
/// `partitionBy` exactly `[sourceIp]` or `[]`, and only counts of at most
/// [`MAX_PACED_REQUESTS`] requests in a positive `window.seconds`. A bucket
/// with plan tiers is paced at the tier the deployment's plan names
/// (`plans`, the catalog selection's `throttlingPlans`), else within every
/// tier at once ([`limit_counts`]). Anything malformed or unknown is not
/// paced (the provider still enforces its own limit).
pub fn selected_buckets(
    document: &Value,
    operation: &Value,
    plans: Option<&serde_json::Map<String, Value>>,
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
        if !proxy_wide {
            continue;
        }
        let plan = plans
            .and_then(|plans| plans.get(id))
            .and_then(Value::as_str);
        for (tier, requests, seconds) in limit_counts(limit, plan) {
            let duplicate = buckets
                .iter()
                .any(|b: &PacedBucket| b.id == id && b.tier == tier);
            if requests <= MAX_PACED_REQUESTS && !duplicate {
                buckets.push(PacedBucket {
                    id: id.to_owned(),
                    tier,
                    requests: requests as usize,
                    window: Duration::from_secs(seconds),
                });
            }
        }
    }
    buckets
}

/// A log's key: platform, bucket id, and the tier's position for a bucket
/// with plan tiers.
type LogKey = (String, String, Option<usize>);

/// The sliding logs, keyed by (platform, bucket id, tier).
#[derive(Default)]
pub struct Pacer {
    logs: Mutex<HashMap<LogKey, VecDeque<Instant>>>,
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
                .entry((platform.to_owned(), bucket.id.clone(), bucket.tier))
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
            logs.get_mut(&(platform.to_owned(), bucket.id.clone(), bucket.tier))
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
            tier: None,
            requests,
            window: Duration::from_secs(seconds),
        }
    }

    fn tier(id: &str, tier: usize, requests: usize, seconds: u64) -> PacedBucket {
        PacedBucket {
            tier: Some(tier),
            ..bucket(id, requests, seconds)
        }
    }

    fn tiered() -> Value {
        json!({"partitionBy": ["sourceIp"], "tiers": [
            {"plans": ["FREE"], "requests": 30, "window": {"seconds": 3600, "kind": "unspecified"}},
            {"plans": ["BASIC", "PRO"], "requests": 20, "window": {"seconds": 1, "kind": "unspecified"}},
            {"plans": ["ENTERPRISE"], "requests": 50, "window": {"seconds": 1, "kind": "unspecified"}},
            {"plans": ["BROKEN"], "window": {"seconds": 1, "kind": "fixed"}}
        ]})
    }

    #[test]
    fn a_tiered_limit_uses_the_plans_tier_else_every_tier_at_once() {
        let limit = tiered();
        let counts = |plan| limit_counts(&limit, plan);
        assert_eq!(counts(Some("PRO")), [(Some(1), 20, 1)]);
        assert_eq!(counts(Some("ENTERPRISE")), [(Some(2), 50, 1)]);
        let every = vec![(Some(0), 30, 3600), (Some(1), 20, 1), (Some(2), 50, 1)];
        assert_eq!(counts(None), every);
        // An unknown plan, or one whose tier has no usable amount: every tier.
        assert_eq!(counts(Some("GOLD")), every);
        assert_eq!(counts(Some("BROKEN")), every);
        // A limit without tiers is its own single count.
        assert_eq!(
            limit_counts(
                &json!({"requests": 5, "window": {"seconds": 60}}),
                Some("PRO")
            ),
            [(None, 5, 60)]
        );
        assert!(limit_counts(&json!({"tiers": [{"plans": ["X"]}]}), None).is_empty());
    }

    #[test]
    fn a_tiered_proxy_wide_bucket_keeps_within_its_tiers() {
        let document = json!({"x-throttling": {
            "limits": {"plan": tiered(), "user": {"partitionBy": ["user"], "tiers": [
                {"plans": ["FREE"], "requests": 1, "window": {"seconds": 1}}]}},
            "applies": ["plan", "user"]
        }});
        let paced = |plans: Value| selected_buckets(&document, &json!({}), plans.as_object());
        assert_eq!(
            paced(json!({})),
            [
                tier("plan", 0, 30, 3600),
                tier("plan", 1, 20, 1),
                tier("plan", 2, 50, 1)
            ],
            "no plan: every tier, each its own count; a user bucket is not paced"
        );
        assert_eq!(paced(json!({"plan": "BASIC"})), [tier("plan", 1, 20, 1)]);
        // Every tier together: 30 an hour is the binding count over a
        // minute, 20 a second over a second.
        let pacer = Pacer::default();
        let all = paced(json!({}));
        let start = Instant::now();
        for i in 0..20u64 {
            pacer
                .take_at("p", &all, start + Duration::from_millis(i))
                .unwrap();
        }
        assert!(pacer
            .take_at("p", &all, start + Duration::from_millis(500))
            .is_err());
        for i in 0..10u64 {
            pacer
                .take_at("p", &all, start + Duration::from_secs(2 + i))
                .unwrap();
        }
        let wait = pacer
            .take_at("p", &all, start + Duration::from_secs(20))
            .unwrap_err();
        assert!(wait > Duration::from_secs(3000), "{wait:?}");
        // A tier above the cap is left out; the others still count.
        let huge = json!({"x-throttling": {"limits": {"b": {"partitionBy": [], "tiers": [
            {"plans": ["A"], "requests": 10001, "window": {"seconds": 1}},
            {"plans": ["B"], "requests": 10, "window": {"seconds": 1}}]}}, "applies": ["b"]}});
        assert_eq!(
            selected_buckets(&huge, &json!({}), None),
            [tier("b", 1, 10, 1)]
        );

        let selection = |plans: Value| {
            json!({"query_overrides": [], "throttlingPlans": plans})
                .as_object()
                .unwrap()
                .clone()
        };
        assert!(plan_selection_problems(&document, &selection(json!({"plan": "PRO"}))).is_empty());
        assert!(plan_selection_problems(&document, json!({}).as_object().unwrap()).is_empty());
        let problems = plan_selection_problems(
            &document,
            &selection(json!({"plan": "GOLD", "missing": "FREE", "user": 3})),
        );
        assert_eq!(problems.len(), 3, "{problems:?}");
        assert!(problems.iter().any(|p| p.contains(
            "gives \"plan\" the plan \"GOLD\", which no tier names; the bucket keeps within all its tiers"
        )));
        assert!(problems.iter().any(|p| p.contains(
            "names \"missing\": no such bucket in x-throttling limits; the entry is ignored"
        )));
        assert!(problems
            .iter()
            .any(|p| p.contains("gives \"user\" a plan that is not a string")));
        // A bucket that exists but has no tiers.
        let flat = json!({"x-throttling": {"limits": {"flat": {"partitionBy": [],
            "requests": 5, "window": {"seconds": 60}}}, "applies": ["flat"]}});
        assert_eq!(
            plan_selection_problems(&flat, &selection(json!({"flat": "PRO"}))),
            ["throttlingPlans names \"flat\", which has no plan tiers; the entry is ignored"]
        );
        assert_eq!(
            plan_selection_problems(&document, &selection(json!(["plan"]))).len(),
            1
        );
    }

    /// A tier's log is keyed by (bucket id, tier position), never by a
    /// string built from them, so a bucket whose id looks like another's
    /// tier (`plan#tier0`) keeps its own count.
    #[test]
    fn tier_logs_never_collide_with_bucket_ids() {
        let pacer = Pacer::default();
        let start = Instant::now();
        let tiered = tier("plan", 0, 1, 60);
        let lookalike = bucket("plan#tier0", 1, 60);
        pacer
            .take_at("p", std::slice::from_ref(&tiered), start)
            .unwrap();
        assert!(pacer
            .take_at("p", std::slice::from_ref(&tiered), start)
            .is_err());
        pacer
            .take_at("p", std::slice::from_ref(&lookalike), start)
            .unwrap();
        // And tier 0 of another bucket, or tier 1 of this one, is separate.
        pacer
            .take_at("p", &[tier("plan", 1, 1, 60)], start)
            .unwrap();
        pacer
            .take_at("p", &[tier("other", 0, 1, 60)], start)
            .unwrap();
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
