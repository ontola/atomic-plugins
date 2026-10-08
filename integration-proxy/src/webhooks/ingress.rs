//! `POST /webhooks/{endpointId}`: the provider-facing receiver (Webhook
//! Deliveries §4.2.1–§4.4, Webhook Subscriptions §5.3).
//!
//! In order: the body is capped while it is read (the route's body limit is
//! the verification cap); the endpoint's hook, profile and secret are looked
//! up; the signature is verified over the exact bytes; only then is the body
//! scanned for depth and parsed; revocations are applied; the delivery is
//! routed and stored in one transaction. A 2xx goes out only after that
//! transaction committed, or when nothing is to be kept.

use std::collections::BTreeMap;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
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

pub async fn receive(
    State(state): State<AppState>,
    Path(endpoint_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(webhooks) = state.webhooks.clone() else {
        return answer(StatusCode::NOT_FOUND);
    };
    if endpoint_id.len() != 43 {
        return answer(StatusCode::NOT_FOUND);
    }
    let hook = match webhooks.store.hook_by_endpoint(&endpoint_id).await {
        Ok(Some(hook)) => hook,
        Ok(None) => return answer(StatusCode::NOT_FOUND),
        Err(_) => return answer(StatusCode::SERVICE_UNAVAILABLE),
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
        return answer(StatusCode::UNAUTHORIZED);
    };
    if let Err(refused) = verify(&profile, &headers, &body, &secret, crate::now_secs()) {
        tracing::info!(?refused, platform = %hook.platform, "webhook delivery refused");
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
