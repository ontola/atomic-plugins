//! The consumer routes (`webhook-subscriptions` §7), mounted only with
//! `WEBHOOKS_ENABLED=true`. Every one is signed (Atomic v2, single use) by
//! the subscription's consumer: the connection's owner, a delegate, or a
//! runtime of a delegated app, checked on every request, so removing a
//! delegation stops reads at once. Ids in paths are not credentials.
//!
//! | route | effect |
//! |---|---|
//! | `POST /connections/{id}/subscriptions` | access check, then a subscription on the platform's shared hook |
//! | `GET /subscriptions/{id}` | the subscription |
//! | `DELETE /subscriptions/{id}` | ends it |
//! | `POST /subscriptions/{id}/renew` | access check, then a new lease |
//! | `GET /subscriptions/{id}/events?after=&limit=&wait=` | a page; waits up to `wait` (at most 25) seconds for one |
//! | `POST /subscriptions/{id}/ack` `{generation, cursor}` | acknowledges up to the cursor |
//! | `POST /subscriptions/{id}/reconciled` `{generation, barrier}` | access check, then `active` |

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{OriginalUri, Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use super::provider::{check_access, deliveries, parameters, Checked};
use super::store::{ended, now, AccessCheck, Binding, InboxError, NewSubscription};
use super::Webhooks;
use crate::{api_error::ApiError, security::Standing, AppState};

/// Longest long-poll wait (`fetch.maxWaitSeconds`).
pub const MAX_WAIT: Duration = Duration::from_secs(25);
const MAX_PARAMETERS: usize = 16;

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

/// An inbox error as the spec's Error record, or its
/// `reconciliation-required` result for an ended subscription.
fn inbox_error(error: InboxError) -> Response {
    if let InboxError::Ended(result) = error {
        return no_store((StatusCode::GONE, Json(*result)).into_response());
    }
    let status = match &error {
        InboxError::UnknownSubscription => StatusCode::NOT_FOUND,
        InboxError::ObsoleteGeneration
        | InboxError::CursorNotIssued
        | InboxError::CursorAhead
        | InboxError::BarrierMismatch
        | InboxError::NotReconciling => StatusCode::CONFLICT,
        InboxError::QuotaExceeded => StatusCode::TOO_MANY_REQUESTS,
        InboxError::UnknownConnection | InboxError::UnknownHook => StatusCode::FORBIDDEN,
        InboxError::AccessCheckRequired => StatusCode::FORBIDDEN,
        InboxError::Database(_)
        | InboxError::CapacityUnavailable
        | InboxError::AccessUnavailable
        | InboxError::Ended(_) => StatusCode::SERVICE_UNAVAILABLE,
    };
    if let InboxError::Database(message) = &error {
        tracing::error!(%message, "webhook inbox request failed");
    }
    no_store(
        (
            status,
            Json(serde_json::json!({"status": "error", "code": error.code()})),
        )
            .into_response(),
    )
}

fn bad_request(message: &'static str) -> Response {
    no_store(ApiError::BadRequest(message).into_response())
}

fn webhooks(state: &AppState) -> Result<Arc<Webhooks>, Box<Response>> {
    state
        .webhooks
        .clone()
        .ok_or_else(|| Box::new(no_store(StatusCode::NOT_FOUND.into_response())))
}

/// Authenticates the request and checks the signer is still the
/// subscription's consumer with standing on its connection.
async fn consumer(
    state: &AppState,
    id: &str,
    method: &Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(Arc<Webhooks>, Binding), Box<Response>> {
    let webhooks = webhooks(state)?;
    let security = state
        .security
        .as_ref()
        .ok_or_else(|| Box::new(no_store(ApiError::Unavailable.into_response())))?;
    let signer = crate::signature::authenticate(state, security, method, uri, headers, body)
        .await
        .map_err(|e| Box::new(no_store(e.into_response())))?;
    let binding = match webhooks.store.binding(id).await {
        Ok(Some(binding)) if binding.consumer == signer.as_str() => binding,
        Ok(_) => return Err(Box::new(inbox_error(InboxError::UnknownSubscription))),
        Err(error) => return Err(Box::new(inbox_error(error))),
    };
    // Standing is checked whatever the subscription's state, so a former
    // consumer reads nothing, not even a closed subscription's tombstone.
    let standing = security
        .standing(&binding.connection_id, &binding.owner, signer.as_str())
        .await
        .map_err(|_| Box::new(no_store(ApiError::Unavailable.into_response())))?;
    if standing == Standing::None {
        // The delegation or runtime was removed: nothing more is served.
        if binding.live {
            let _ = webhooks.store.close(id, ended::STANDING_LOST, now()).await;
        }
        return Err(Box::new(no_store(ApiError::NotDelegated.into_response())));
    }
    let owner = crate::agent_id::parse(&binding.owner)
        .ok_or_else(|| Box::new(no_store(ApiError::Internal.into_response())))?;
    crate::check_access(state, &owner)
        .await
        .map_err(|e| Box::new(no_store(e.into_response())))?;
    Ok((webhooks, binding))
}

/// Re-runs the binding's access check with its recorded parameters.
async fn recheck(state: &AppState, binding: &Binding) -> AccessCheck {
    let (Some(deliveries), Some(values)) = (
        deliveries(state, &binding.platform),
        parameters(&binding.access_parameters),
    ) else {
        return AccessCheck::Failed;
    };
    check_access(
        state,
        &binding.connection_id,
        &binding.platform,
        &deliveries,
        &binding.source_kind,
        &values,
    )
    .await
    .against(&binding.source_key)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubscribeBody {
    source: String,
    #[serde(default)]
    parameters: BTreeMap<String, String>,
    events: Vec<String>,
}

/// `POST /connections/{id}/subscriptions`
pub async fn subscribe(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let webhooks = match webhooks(&state) {
        Ok(webhooks) => webhooks,
        Err(response) => return *response,
    };
    let Some(security) = state.security.as_ref() else {
        return no_store(ApiError::Unavailable.into_response());
    };
    let signer = match crate::signature::authenticate(
        &state, security, &method, &uri, &headers, &body,
    )
    .await
    {
        Ok(signer) => signer,
        Err(error) => return no_store(error.into_response()),
    };
    if connection_id.len() != 43 {
        return no_store(ApiError::UnknownConnection.into_response());
    }
    let record = match security.load_connection(&connection_id).await {
        Ok(Some(record)) => record,
        Ok(None) => return no_store(ApiError::UnknownConnection.into_response()),
        Err(_) => return no_store(ApiError::Unavailable.into_response()),
    };
    match security
        .standing(&connection_id, &record.owner, signer.as_str())
        .await
    {
        Ok(Standing::None) => return no_store(ApiError::NotDelegated.into_response()),
        Ok(_) => {}
        Err(_) => return no_store(ApiError::Unavailable.into_response()),
    }
    let Some(owner) = crate::agent_id::parse(&record.owner) else {
        return no_store(ApiError::Internal.into_response());
    };
    if let Err(error) = crate::check_access(&state, &owner).await {
        return no_store(error.into_response());
    }
    let Ok(request) = serde_json::from_slice::<SubscribeBody>(&body) else {
        return bad_request("expected {source, parameters, events}");
    };
    let Some(deliveries) = deliveries(&state, &record.platform) else {
        return bad_request("this platform declares no webhook deliveries");
    };
    if !deliveries.sources.contains_key(&request.source) {
        return bad_request("unknown source kind");
    }
    let mut events = request.events.clone();
    events.sort();
    events.dedup();
    if events.is_empty()
        || events.len() != request.events.len()
        || !events.iter().all(|event| {
            deliveries
                .events
                .get(event)
                .is_some_and(|declared| declared.source == request.source)
        })
    {
        return bad_request("events must be distinct declared events of the source kind");
    }
    if request.parameters.len() > MAX_PARAMETERS {
        return bad_request("too many parameters");
    }
    if deliveries.shared_profile.is_none() {
        // Creating a provider hook is a provider write; this release makes none.
        return bad_request("this platform has no shared application hook");
    }
    if webhooks.shared_secret(&record.platform).is_none() {
        return inbox_error(InboxError::CapacityUnavailable);
    }
    let key = match check_access(
        &state,
        &connection_id,
        &record.platform,
        &deliveries,
        &request.source,
        &request.parameters,
    )
    .await
    {
        Checked::Passed(key) => key,
        Checked::Failed => {
            return no_store(
                ApiError::AccessDenied("the access check failed".into()).into_response(),
            )
        }
        Checked::Unavailable => return inbox_error(InboxError::AccessUnavailable),
        Checked::Invalid(message) => return bad_request(message),
    };
    let current = now();
    let hook = match webhooks
        .store
        .ensure_shared_hook(&record.platform, current)
        .await
    {
        Ok(hook) => hook,
        Err(error) => return inbox_error(error),
    };
    match webhooks
        .store
        .create_subscription(
            NewSubscription {
                connection_id,
                owner: record.owner,
                consumer: signer.as_str().to_owned(),
                hook_id: hook.hook_id,
                source_kind: request.source,
                source_key: key,
                events,
                access_parameters: serde_json::to_string(&request.parameters).unwrap_or_default(),
            },
            current,
        )
        .await
    {
        Ok(view) => no_store((StatusCode::CREATED, Json(view)).into_response()),
        Err(error) => inbox_error(error),
    }
}

/// `GET /subscriptions/{id}`
pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (webhooks, binding) = match consumer(&state, &id, &method, &uri, &headers, &body).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    match webhooks.store.get(&id, &binding.consumer, now()).await {
        Ok(view) => no_store(Json(view).into_response()),
        Err(error) => inbox_error(error),
    }
}

/// `DELETE /subscriptions/{id}`
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (webhooks, binding) = match consumer(&state, &id, &method, &uri, &headers, &body).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    match webhooks.store.delete(&id, &binding.consumer, now()).await {
        Ok(view) => no_store(Json(view).into_response()),
        Err(error) => inbox_error(error),
    }
}

/// `POST /subscriptions/{id}/renew`
pub async fn renew(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (webhooks, binding) = match consumer(&state, &id, &method, &uri, &headers, &body).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let access = recheck(&state, &binding).await;
    match webhooks
        .store
        .renew(&id, &binding.consumer, access, now())
        .await
    {
        Ok(view) => no_store(Json(view).into_response()),
        Err(error) => inbox_error(error),
    }
}

#[derive(Deserialize)]
pub struct EventsQuery {
    after: Option<String>,
    limit: Option<i64>,
    wait: Option<u64>,
    /// Accepted for the spec's route; the cursor carries the generation.
    #[allow(dead_code)]
    generation: Option<String>,
}

/// `GET /subscriptions/{id}/events`
pub async fn events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<EventsQuery>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (webhooks, binding) = match consumer(&state, &id, &method, &uri, &headers, &body).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let limit = query.limit.unwrap_or(i64::MAX);
    let requested = Duration::from_secs(query.wait.unwrap_or(0)).min(MAX_WAIT);
    // A waiting slot, within the caps per consumer and in all; without one
    // the request answers at once instead of waiting.
    let waiting = WaitingSlot::take(&webhooks, &binding.consumer, !requested.is_zero());
    let wait = if waiting.is_some() {
        requested
    } else {
        Duration::ZERO
    };
    let deadline = tokio::time::Instant::now() + wait;
    let waker = webhooks.store.waiter(&id);
    let mut checked = false;
    let response = loop {
        // Registered before the read, so a delivery stored between the read
        // and the wait still wakes this request. Only this subscription's
        // deliveries wake it.
        let notified = waker.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        match webhooks
            .store
            .fetch(&id, &binding.consumer, query.after.as_deref(), limit, now())
            .await
        {
            Ok(page)
                if page.events.is_empty()
                    && page.reconciliation_required.is_none()
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::select! {
                    _ = &mut notified => continue,
                    _ = tokio::time::sleep_until(deadline) => {
                        break no_store(Json(page).into_response());
                    }
                }
            }
            Ok(page) => break no_store(Json(page).into_response()),
            Err(InboxError::AccessCheckRequired) if !checked => {
                // The receiver runs the check itself rather than serve
                // events on a stale one (Webhook Deliveries §4.4.1).
                checked = true;
                let access = recheck(&state, &binding).await;
                if let Err(error) = webhooks
                    .store
                    .record_access_check(&id, &binding.consumer, access, now())
                    .await
                {
                    break inbox_error(error);
                }
            }
            Err(error) => break inbox_error(error),
        }
    };
    webhooks.store.release_waiter(&id, waker);
    drop(waiting);
    response
}

/// One waiting long poll, counted per consumer and in all until dropped.
struct WaitingSlot {
    webhooks: Arc<Webhooks>,
    consumer: String,
}

impl WaitingSlot {
    fn take(webhooks: &Arc<Webhooks>, consumer: &str, wants: bool) -> Option<Self> {
        if !wants {
            return None;
        }
        let mut waiting = webhooks.waiting.lock().unwrap_or_else(|e| e.into_inner());
        let total: usize = waiting.values().sum();
        let mine = waiting.get(consumer).copied().unwrap_or(0);
        if total >= super::MAX_WAITERS || mine >= super::MAX_WAITERS_PER_CONSUMER {
            return None;
        }
        waiting.insert(consumer.to_owned(), mine + 1);
        Some(Self {
            webhooks: webhooks.clone(),
            consumer: consumer.to_owned(),
        })
    }
}

impl Drop for WaitingSlot {
    fn drop(&mut self) {
        let mut waiting = self
            .webhooks
            .waiting
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(count) = waiting.get_mut(&self.consumer) {
            *count -= 1;
            if *count == 0 {
                waiting.remove(&self.consumer);
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AckBody {
    generation: String,
    cursor: String,
}

/// `POST /subscriptions/{id}/ack`
pub async fn ack(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (webhooks, binding) = match consumer(&state, &id, &method, &uri, &headers, &body).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let Ok(request) = serde_json::from_slice::<AckBody>(&body) else {
        return bad_request("expected {generation, cursor}");
    };
    match webhooks
        .store
        .acknowledge(
            &id,
            &binding.consumer,
            Some(&request.generation),
            &request.cursor,
            now(),
        )
        .await
    {
        Ok(acknowledged) => no_store(Json(acknowledged).into_response()),
        Err(error) => inbox_error(error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReconciledBody {
    generation: String,
    barrier: String,
}

/// `POST /subscriptions/{id}/reconciled`
pub async fn reconciled(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (webhooks, binding) = match consumer(&state, &id, &method, &uri, &headers, &body).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let Ok(request) = serde_json::from_slice::<ReconciledBody>(&body) else {
        return bad_request("expected {generation, barrier}");
    };
    let access = recheck(&state, &binding).await;
    match webhooks
        .store
        .complete_reconciliation(
            &id,
            &binding.consumer,
            &request.generation,
            &request.barrier,
            access,
            now(),
        )
        .await
    {
        Ok(view) => no_store(Json(view).into_response()),
        Err(error) => inbox_error(error),
    }
}

/// The webhook routes, added to the router only when the inbox is on.
pub fn router() -> axum::Router<AppState> {
    use axum::routing::{get as get_route, post};
    axum::Router::new()
        // The handler reads the raw body itself, after its checks, up to
        // the verification cap; no extractor buffers it first.
        .route("/webhooks/:endpoint_id", post(super::ingress::receive))
        .route("/connections/:connection_id/subscriptions", post(subscribe))
        .route("/subscriptions/:id", get_route(get).delete(delete))
        .route("/subscriptions/:id/renew", post(renew))
        .route("/subscriptions/:id/events", get_route(events))
        .route("/subscriptions/:id/ack", post(ack))
        .route("/subscriptions/:id/reconciled", post(reconciled))
}
