//! Calls the receiver makes to a provider through a connection: source
//! access checks (Webhook Deliveries §4.4.1) and dedicated-hook deletion
//! (§4.5.2). Both go through [`crate::proxy::receiver_call`], so they use
//! the catalog allowlist and the connection's own credential exactly as a
//! proxied request would.

use std::collections::BTreeMap;
use std::future::Future;

use axum::http::{Method, StatusCode};

use super::cleanup::{CleanupError, HookDeleter};
use super::metadata::{fill_path, Deliveries};
use super::store::{AccessCheck, HookToDelete};
use crate::proxy::ReceiverReply;
use crate::AppState;

/// The result of an access check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Checked {
    /// 2xx, and the response selects this key.
    Passed(String),
    /// 403, 404, a 401 after one refresh, a 2xx without a key, or the
    /// connection is gone.
    Failed,
    /// 3xx, 5xx, a timeout, a failed refresh: nothing is known.
    Unavailable,
    /// The request cannot be made as asked (parameters, catalog).
    Invalid(&'static str),
}

impl Checked {
    /// Against a binding's key: another key is a failure.
    pub fn against(self, bound_key: &str) -> AccessCheck {
        match self {
            Checked::Passed(key) if key == bound_key => AccessCheck::Passed,
            Checked::Passed(_) | Checked::Failed => AccessCheck::Failed,
            Checked::Unavailable => AccessCheck::Unavailable,
            Checked::Invalid(_) => AccessCheck::Failed,
        }
    }
}

pub fn parameters(json: &str) -> Option<BTreeMap<String, String>> {
    serde_json::from_str(json).ok()
}

/// Runs `source_kind`'s access check through `connection_id`.
pub async fn check_access(
    state: &AppState,
    connection_id: &str,
    platform: &str,
    deliveries: &Deliveries,
    source_kind: &str,
    parameters: &BTreeMap<String, String>,
) -> Checked {
    let Some(security) = state.security.as_ref() else {
        return Checked::Unavailable;
    };
    let Some(source) = deliveries.sources.get(source_kind) else {
        return Checked::Invalid("unknown source kind");
    };
    let Ok(path) = fill_path(&source.access_path, parameters) else {
        return Checked::Invalid("access parameters must fill the access path, one segment each");
    };
    match crate::proxy::receiver_call(state, security, connection_id, platform, Method::GET, &path)
        .await
    {
        ReceiverReply::Answered(status, body) if status.is_success() => {
            match serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| source.access_key.key(&value))
            {
                Some(key) => Checked::Passed(key),
                None => Checked::Failed,
            }
        }
        ReceiverReply::Answered(
            StatusCode::UNAUTHORIZED
            | StatusCode::FORBIDDEN
            | StatusCode::NOT_FOUND
            | StatusCode::GONE,
            _,
        ) => Checked::Failed,
        ReceiverReply::Answered(..) | ReceiverReply::Unreachable => Checked::Unavailable,
        ReceiverReply::Refused("unknown-connection" | "platform-mismatch")
        | ReceiverReply::RefreshRefused => Checked::Failed,
        ReceiverReply::Refused(reason) => Checked::Invalid(reason),
    }
}

/// The platform's declaration, if its composed document has one that this
/// version can use.
pub fn deliveries(state: &AppState, platform: &str) -> Option<Deliveries> {
    Deliveries::from_document(&state.catalog.webhook_document(platform)?).ok()
}

/// The receiver's URL for an endpoint, as given to the provider.
pub fn endpoint_url(state: &AppState, endpoint_id: &str) -> String {
    format!("{}/webhooks/{endpoint_id}", state.base_url)
}

/// The provider's id of the hook created for `hook`'s endpoint, by its
/// declared `list` operation.
async fn find_hook(
    state: &AppState,
    connection: &str,
    hook: &HookToDelete,
    dedicated: &super::metadata::Dedicated,
    values: &BTreeMap<String, String>,
) -> Result<Option<String>, CleanupError> {
    let Some((path, url_pointer, id_pointer)) = &dedicated.list else {
        return Err(CleanupError::Permanent("no-list-operation"));
    };
    let security = state
        .security
        .as_ref()
        .ok_or(CleanupError::Retry("no-database"))?;
    let path = fill_path(path, values).map_err(|_| CleanupError::Permanent("invalid-list-path"))?;
    let body = match crate::proxy::receiver_call(
        state,
        security,
        connection,
        &hook.platform,
        Method::GET,
        &path,
    )
    .await
    {
        ReceiverReply::Answered(status, body) if status.is_success() => body,
        ReceiverReply::Answered(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN, _) => {
            return Err(CleanupError::Permanent("refused"))
        }
        ReceiverReply::Answered(..) | ReceiverReply::Unreachable => {
            return Err(CleanupError::Retry("unavailable"))
        }
        ReceiverReply::Refused(_) => return Err(CleanupError::Permanent("not-allowlisted")),
        ReceiverReply::RefreshRefused => return Err(CleanupError::Permanent("refresh-refused")),
    };
    let listed: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| CleanupError::Retry("unreadable-list"))?;
    let ours = endpoint_url(state, &hook.endpoint_id);
    let (Some((items, url_inside)), Some((id_items, id_inside))) =
        (url_pointer.split_wildcard(), id_pointer.split_wildcard())
    else {
        return Err(CleanupError::Permanent("invalid-list-pointers"));
    };
    if items != id_items {
        return Err(CleanupError::Permanent("invalid-list-pointers"));
    }
    for item in items
        .select(&listed)
        .into_iter()
        .filter_map(serde_json::Value::as_array)
        .flatten()
    {
        if url_inside.key(item).as_deref() == Some(ours.as_str()) {
            return Ok(id_inside.key(item));
        }
    }
    Ok(None)
}

/// Deletes dedicated hooks through their managing connection, after
/// re-running its access check with the hook's recorded parameters and
/// finding the hook's bound key (Webhook Deliveries §4.5.2).
#[derive(Clone)]
pub struct ProviderHookDeleter {
    pub state: AppState,
}

impl HookDeleter for ProviderHookDeleter {
    fn delete(&self, hook: &HookToDelete) -> impl Future<Output = Result<(), CleanupError>> + Send {
        let state = self.state.clone();
        let hook = hook.clone();
        async move {
            tracing::debug!(hook = %hook.hook_id, platform = %hook.platform, "deleting a dedicated webhook hook");
            let deliveries = deliveries(&state, &hook.platform)
                .ok_or(CleanupError::Permanent("no-declaration"))?;
            let dedicated = deliveries
                .dedicated
                .as_ref()
                .ok_or(CleanupError::Permanent("no-dedicated-hooks"))?;
            if dedicated.source != hook.source_kind {
                return Err(CleanupError::Permanent("source-kind-changed"));
            }
            let connection = hook
                .management_connection_id
                .as_deref()
                .ok_or(CleanupError::Permanent("no-managing-connection"))?;
            let mut values = parameters(&hook.access_parameters)
                .ok_or(CleanupError::Permanent("invalid-parameters"))?;
            match check_access(
                &state,
                connection,
                &hook.platform,
                &deliveries,
                &hook.source_kind,
                &values,
            )
            .await
            .against(&hook.source_key)
            {
                AccessCheck::Passed => {}
                AccessCheck::Failed => return Err(CleanupError::Permanent("access-check-failed")),
                AccessCheck::Unavailable => {
                    return Err(CleanupError::Retry("access-check-unavailable"))
                }
            }
            let provider_hook_id = match hook.provider_hook_id.clone() {
                Some(id) => id,
                // Provisioning ended before the provider's answer: find the
                // hook by the endpoint URL it was created with.
                None => match find_hook(&state, connection, &hook, dedicated, &values).await? {
                    Some(id) => id,
                    // Not there: nothing was created, nothing to delete.
                    None => return Ok(()),
                },
            };
            values.insert(dedicated.hook_id_parameter.clone(), provider_hook_id);
            let path = fill_path(&dedicated.delete.path, &values)
                .map_err(|_| CleanupError::Permanent("invalid-delete-path"))?;
            let method =
                Method::from_bytes(dedicated.delete.method.to_ascii_uppercase().as_bytes())
                    .map_err(|_| CleanupError::Permanent("invalid-delete-method"))?;
            let security = state
                .security
                .as_ref()
                .ok_or(CleanupError::Retry("no-database"))?;
            match crate::proxy::receiver_call(
                &state,
                security,
                connection,
                &hook.platform,
                method,
                &path,
            )
            .await
            {
                ReceiverReply::Answered(status, _)
                    if status.is_success()
                        || status == StatusCode::NOT_FOUND
                        || status == StatusCode::GONE =>
                {
                    Ok(())
                }
                ReceiverReply::Answered(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN, _) => {
                    Err(CleanupError::Permanent("refused"))
                }
                ReceiverReply::Answered(..) | ReceiverReply::Unreachable => {
                    Err(CleanupError::Retry("unavailable"))
                }
                ReceiverReply::Refused(_) => Err(CleanupError::Permanent("not-allowlisted")),
                ReceiverReply::RefreshRefused => Err(CleanupError::Permanent("refresh-refused")),
            }
        }
    }
}
