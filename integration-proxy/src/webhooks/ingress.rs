//! `POST /webhooks/{endpointId}`: the provider-facing receiver (Webhook
//! Deliveries §4.2.1–§4.4, Webhook Subscriptions §5.3).
//!
//! In order, before any body byte is read: the endpoint id's shape, a
//! `Content-Length` over the verification cap (413), and the endpoint's
//! hook, profile and secret, looked up under a bounded database slot. Then
//! the body is read, at most the cap, under a bounded read slot and a read
//! timeout; the signature is verified over the exact bytes; only then is
//! the body scanned for depth and parsed; revocations are applied; the
//! delivery is routed and stored in one transaction. A 2xx goes out only
//! after that transaction committed, or when nothing is to be kept. Every
//! wait is bounded: a slot not free in time is a 503.

use std::collections::BTreeMap;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

use super::metadata::{Deliveries, EventType};
use super::store::Delivery;
use super::verify::{single_header, verify};
use crate::AppState;

/// Nesting deeper than this is not parsed (`delivery.maxJsonDepth`).
pub const MAX_JSON_DEPTH: usize = 64;

fn answer(status: StatusCode) -> Response {
    status.into_response()
}

/// An endpoint id: 43 characters of base64url (256 random bits).
fn endpoint_shaped(id: &str) -> bool {
    id.len() == 43
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Logs refused deliveries at most once per ten seconds, with how many.
fn log_refused(reason: &str, platform: &str) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST: AtomicU64 = AtomicU64::new(0);
    static REFUSED: AtomicU64 = AtomicU64::new(0);
    let refused = REFUSED.fetch_add(1, Ordering::Relaxed) + 1;
    let now = crate::now_secs();
    let last = LAST.load(Ordering::Relaxed);
    if now >= last + 10
        && LAST
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    {
        REFUSED.store(0, Ordering::Relaxed);
        tracing::info!(reason, platform, refused, "webhook deliveries refused");
    }
}

async fn slot<'a>(
    semaphore: &'a tokio::sync::Semaphore,
    wait: std::time::Duration,
) -> Option<tokio::sync::SemaphorePermit<'a>> {
    tokio::time::timeout(wait, semaphore.acquire())
        .await
        .ok()?
        .ok()
}

enum ReadError {
    TooLarge,
    Broken,
}

/// Reads a body up to `cap` bytes, telling a body over the cap from a broken
/// upload.
async fn read_capped(mut body: Body, cap: usize) -> Result<Vec<u8>, ReadError> {
    use axum::body::HttpBody as _;
    let mut buffer = Vec::new();
    while let Some(frame) =
        std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_frame(cx)).await
    {
        let frame = frame.map_err(|_| ReadError::Broken)?;
        if let Ok(data) = frame.into_data() {
            if buffer.len() + data.len() > cap {
                return Err(ReadError::TooLarge);
            }
            buffer.extend_from_slice(&data);
        }
    }
    Ok(buffer)
}

/// One body being read for an endpoint, counted until dropped.
struct EndpointRead<'a> {
    gate: &'a super::IngressGate,
    endpoint: String,
}

impl<'a> EndpointRead<'a> {
    fn take(gate: &'a super::IngressGate, endpoint: &str) -> Option<Self> {
        let mut reading = gate.reading.lock().unwrap_or_else(|e| e.into_inner());
        let count = reading.entry(endpoint.to_owned()).or_insert(0);
        if *count >= gate.reads_per_endpoint {
            return None;
        }
        *count += 1;
        Some(Self {
            gate,
            endpoint: endpoint.to_owned(),
        })
    }
}

impl Drop for EndpointRead<'_> {
    fn drop(&mut self) {
        let mut reading = self.gate.reading.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = reading.get_mut(&self.endpoint) {
            *count -= 1;
            if *count == 0 {
                reading.remove(&self.endpoint);
            }
        }
    }
}

pub async fn receive(
    State(state): State<AppState>,
    Path(endpoint_id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let Some(webhooks) = state.webhooks.clone() else {
        return answer(StatusCode::NOT_FOUND);
    };
    if !endpoint_shaped(&endpoint_id) {
        return answer(StatusCode::NOT_FOUND);
    }
    let cap = webhooks.store.policy().max_verified_bytes as usize;
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|length| length > cap as u64) {
        return answer(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let gate = &webhooks.gate;
    let hook = {
        let Some(_slot) = slot(&gate.lookups, gate.wait).await else {
            return answer(StatusCode::SERVICE_UNAVAILABLE);
        };
        match webhooks.store.hook_by_endpoint(&endpoint_id).await {
            Ok(Some(hook)) => hook,
            Ok(None) => return answer(StatusCode::NOT_FOUND),
            Err(_) => return answer(StatusCode::SERVICE_UNAVAILABLE),
        }
    };
    let Some(deliveries) = super::provider::deliveries(&state, &hook.platform) else {
        return answer(StatusCode::NOT_FOUND);
    };
    let profile_name = if hook.dedicated {
        deliveries.dedicated.as_ref().map(|d| d.profile.clone())
    } else {
        deliveries.shared_profile.clone()
    };
    let Some(profile) = profile_name.and_then(|name| deliveries.profiles.get(&name).cloned())
    else {
        return answer(StatusCode::NOT_FOUND);
    };
    let secret = if hook.dedicated {
        hook.secret_envelope.as_deref().and_then(|envelope| {
            state
                .security
                .as_ref()?
                .open(envelope, &super::hook_secret_aad(&hook.hook_id))
        })
    } else {
        webhooks.shared_secret(&hook.platform).map(<[u8]>::to_vec)
    };
    let Some(secret) = secret else {
        // No secret, no delivery (Webhook Deliveries §4.2).
        log_refused("no-secret", &hook.platform);
        return answer(StatusCode::UNAUTHORIZED);
    };
    // Only now is the body read: at most the cap, within the read timeout,
    // and only by a bounded number of requests at once.
    let body = {
        let Some(_endpoint_slot) = EndpointRead::take(gate, &endpoint_id) else {
            return answer(StatusCode::SERVICE_UNAVAILABLE);
        };
        let Some(_slot) = slot(&gate.reads, gate.wait).await else {
            return answer(StatusCode::SERVICE_UNAVAILABLE);
        };
        match tokio::time::timeout(gate.read_timeout, read_capped(body, cap)).await {
            Err(_) => return answer(StatusCode::REQUEST_TIMEOUT),
            Ok(Err(ReadError::TooLarge)) => return answer(StatusCode::PAYLOAD_TOO_LARGE),
            Ok(Err(ReadError::Broken)) => return answer(StatusCode::BAD_REQUEST),
            Ok(Ok(bytes)) => bytes,
        }
    };
    if let Err(refused) = verify(&profile, &headers, &body, &secret, crate::now_secs()) {
        log_refused(
            match refused {
                super::verify::Refused::Secret => "secret",
                super::verify::Refused::Signature => "signature",
                super::verify::Refused::Timestamp => "timestamp",
                super::verify::Refused::Mismatch => "mismatch",
            },
            &hook.platform,
        );
        return answer(StatusCode::UNAUTHORIZED);
    }

    // Verified. Only now is anything in the request read.
    let Some(delivery_id) = single_header(&headers, &deliveries.delivery_id_header)
        .filter(|id| {
            !id.is_empty() && id.len() <= 255 && id.bytes().all(|b| (0x21..=0x7e).contains(&b))
        })
        .map(str::to_owned)
    else {
        return answer(StatusCode::BAD_REQUEST);
    };
    if super::metadata::json_depth(&body) > MAX_JSON_DEPTH {
        // Verified but uncapturable, with no source that can be trusted:
        // the consumers' periodic full reads are the fallback.
        return answer(StatusCode::ACCEPTED);
    }
    let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return answer(StatusCode::ACCEPTED);
    };
    let event_type = match &deliveries.event_type {
        EventType::Header(name) => single_header(&headers, name).map(str::to_owned),
        EventType::Body(pointer) => pointer.key(&parsed),
    };
    let Some(event_type) = event_type else {
        return answer(StatusCode::NO_CONTENT);
    };
    let action = deliveries.action.as_ref().and_then(|p| p.key(&parsed));

    let Some(_slot) = slot(&gate.database, gate.wait).await else {
        return answer(StatusCode::SERVICE_UNAVAILABLE);
    };
    if let Err(status) = revoke(
        &state,
        &webhooks,
        &hook.platform,
        &deliveries,
        &event_type,
        action.as_deref(),
        &parsed,
    )
    .await
    {
        return answer(status);
    }

    // Nothing to keep: answered like any durable outcome.
    let Some(event) = deliveries.events.get(&event_type) else {
        return answer(StatusCode::NO_CONTENT);
    };
    let source = &deliveries.sources[&event.source];
    let Some(source_key) = source.key.key(&parsed) else {
        return answer(StatusCode::NO_CONTENT);
    };
    let context: BTreeMap<String, String> = source
        .context
        .iter()
        .filter_map(|(name, pointer)| Some((name.clone(), pointer.key(&parsed)?)))
        .collect();
    let delivery = Delivery {
        endpoint_id,
        delivery_id,
        event_type,
        action,
        source_kind: event.source.clone(),
        source_key,
        context,
        body: body.to_vec(),
    };
    match webhooks.store.ingest(&delivery, super::store::now()).await {
        // Retained, recorded as a gap, a duplicate, or wanted by nobody:
        // durable either way.
        Ok(_) => answer(StatusCode::NO_CONTENT),
        Err(error) => {
            tracing::error!(%error, "webhook delivery not stored; the provider may retry");
            answer(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

/// Suspends the bindings a revocation delivery names.
async fn revoke(
    _state: &AppState,
    webhooks: &super::Webhooks,
    platform: &str,
    deliveries: &Deliveries,
    event_type: &str,
    action: Option<&str>,
    parsed: &serde_json::Value,
) -> Result<(), StatusCode> {
    for revocation in &deliveries.revocations {
        if revocation.event != event_type {
            continue;
        }
        if let Some(actions) = &revocation.actions {
            if !action.is_some_and(|a| actions.iter().any(|x| x == a)) {
                continue;
            }
        }
        let keys = revocation.keys.keys(parsed);
        webhooks
            .store
            .suspend_bindings(
                platform,
                &revocation.source,
                revocation.context.as_deref(),
                &keys,
            )
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    }
    Ok(())
}
