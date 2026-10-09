//! `ANY /proxy/{connection_id}/{platform}/{path}`: proxied provider calls
//! (issue #54).
//!
//! Every request is authenticated one of two ways, both ending in a v2
//! request signature (see [`crate::signature`]):
//!
//! - **Signed by an agent with standing** on the connection: its owner; an
//!   app agent holding a delegation for it; or a runtime registered (by the
//!   owner) for such an app. Delegations and runtimes are read on every
//!   request, so revoking one takes effect on the next.
//! - **A frame capability** (`Authorization: Capability …`, see
//!   [`crate::capability`]) signed by the owner for a delegated app, plus a
//!   request signature by the capability's `cnf` key.
//!
//! Nothing rotates: the connection id is not a secret, and a signature is
//! accepted once. The connection id is in the path, so the signature covers
//! it. The owner is then checked against the access policy.
use axum::{
    body::Bytes,
    extract::{OriginalUri, Path, RawQuery, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
    agent_id,
    api_error::ApiError,
    capability,
    security::{ConnectionRecord, Security, Standing},
    AppState,
};

/// The provider credential sealed in a connection row, interpreted only here
/// and where it is minted (`oauth.rs`'s callback, `connect.rs`'s apiKey,
/// http and no-credential branches). Its `Debug` output names the kind and
/// platform only, never a secret.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind")]
pub(crate) enum StoredCredential {
    #[serde(rename = "oauth")]
    OAuth {
        provider: String,
        access_token: String,
        refresh_token: Option<String>,
        expires_at: Option<u64>,
    },
    /// `scheme` (unreleased; absent in rows written before) names the
    /// `apiKey` security scheme the key was entered for; while it is
    /// present the key is sent only under that scheme.
    #[serde(rename = "api_key")]
    ApiKey {
        provider: String,
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scheme: Option<String>,
        /// The scheme's `in` and `name` when the key was entered; while
        /// present, the key is sent only to that same place.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placement: Option<crate::providers::ApiKeyPlacement>,
    },
    /// A token for an `http` `bearer` scheme, sent as
    /// `Authorization: Bearer <token>`. `scheme` binds it as for an API key.
    #[serde(rename = "http_bearer")]
    HttpBearer {
        provider: String,
        token: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scheme: Option<String>,
    },
    /// The two halves of an `http` `basic` credential, sent as
    /// `Authorization: Basic base64(username:password)`. One half is the
    /// pasted token; the other is fixed by the scheme's
    /// `x-api-key-details.basicCredentials` or, for a username only, typed
    /// by the person. `scheme` and `layout` (the declared layout it was
    /// built from) bind it: while present, it is sent only under that
    /// scheme with that layout.
    #[serde(rename = "http_basic")]
    HttpBasic {
        provider: String,
        username: String,
        password: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scheme: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layout: Option<crate::providers::BasicLayout>,
    },
    /// A connection to a platform whose document requires no security
    /// (`SecurityScheme::NoCredential`): only the platform it is for.
    #[serde(rename = "none")]
    NoCredential { provider: String },
}

impl std::fmt::Debug for StoredCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match self {
            Self::OAuth { .. } => "oauth",
            Self::ApiKey { .. } => "api_key",
            Self::HttpBearer { .. } => "http_bearer",
            Self::HttpBasic { .. } => "http_basic",
            Self::NoCredential { .. } => "none",
        };
        f.debug_struct("StoredCredential")
            .field("kind", &kind)
            .field("provider", &self.provider())
            .finish_non_exhaustive()
    }
}

impl StoredCredential {
    fn provider(&self) -> &str {
        match self {
            Self::OAuth { provider, .. }
            | Self::ApiKey { provider, .. }
            | Self::HttpBearer { provider, .. }
            | Self::HttpBasic { provider, .. }
            | Self::NoCredential { provider } => provider,
        }
    }
}

#[derive(Deserialize)]
struct RefreshToken {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

fn needs_refresh(credential: &StoredCredential) -> bool {
    matches!(
        credential,
        StoredCredential::OAuth { expires_at: Some(expires), .. } if *expires <= crate::now_secs() + 30
    )
}

async fn refresh_token(state: &AppState, credential: &mut StoredCredential) -> Result<(), ()> {
    let StoredCredential::OAuth {
        provider,
        access_token,
        refresh_token,
        expires_at,
    } = credential
    else {
        // A static API key has nothing to refresh.
        return Ok(());
    };
    let refresh_token_value = refresh_token.as_deref().ok_or(())?;
    let configured =
        crate::providers::Provider::configured(&state.catalog, provider).map_err(|_| ())?;
    #[cfg(test)]
    let configured = {
        let mut configured = configured;
        if let Some(upstream) = &state.test_upstream {
            configured.provider.token_url = format!("{}/token", upstream.trim_end_matches('/'));
        }
        configured
    };
    let response = configured
        .token_request(
            &state.http_client,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token_value),
            ],
        )
        .send()
        .await
        .map_err(|_| ())?
        .error_for_status()
        .map_err(|_| ())?;
    let token = response.json::<RefreshToken>().await.map_err(|_| ())?;
    *access_token = token.access_token;
    if token.refresh_token.is_some() {
        *refresh_token = token.refresh_token;
    }
    *expires_at = token.expires_in.map(|seconds| crate::now_secs() + seconds);
    Ok(())
}

/// Refreshes a connection's OAuth token if it is about to expire, with at
/// most one refresh in flight per connection (see
/// `Security::claim_refresh_lease`). A caller that loses the race waits for
/// the winner's result instead of spending the refresh token again.
async fn refresh_connection(
    state: &AppState,
    security: &Security,
    connection_id: &str,
    credential: &mut StoredCredential,
) -> Result<(), ()> {
    const ATTEMPTS: usize = 50;
    const WAIT: std::time::Duration = std::time::Duration::from_millis(200);
    let reload = |record: Option<ConnectionRecord>| -> Result<StoredCredential, ()> {
        serde_json::from_slice(&record.ok_or(())?.credential).map_err(|_| ())
    };
    for _ in 0..ATTEMPTS {
        if !needs_refresh(credential) {
            return Ok(());
        }
        if security
            .claim_refresh_lease(connection_id)
            .await
            .map_err(|_| ())?
        {
            // Another caller may have finished a refresh between our read
            // and our claim; start from the row as it is now.
            if let Ok(current) =
                reload(security.load_connection(connection_id).await.ok().flatten())
            {
                *credential = current;
            }
            if !needs_refresh(credential) {
                let _ = security.release_refresh_lease(connection_id).await;
                return Ok(());
            }
            if refresh_token(state, credential).await.is_err() {
                let _ = security.release_refresh_lease(connection_id).await;
                return Err(());
            }
            let serialized = serde_json::to_vec(&*credential).map_err(|_| ())?;
            return security
                .store_refreshed_connection(connection_id, &serialized)
                .await
                .map_err(|_| ());
        }
        tokio::time::sleep(WAIT).await;
        *credential = reload(security.load_connection(connection_id).await.ok().flatten())?;
    }
    Err(())
}

/// How a request was allowed to use a connection.
#[derive(Debug, PartialEq, Eq)]
enum Caller {
    Owner,
    Delegate(String),
    Runtime { agent: String, app: String },
    Frame { app: String },
}

/// Authenticates a proxied request against the connection it names. See the
/// module documentation for the two accepted presentations.
#[allow(clippy::too_many_arguments)]
async fn authenticate(
    state: &AppState,
    security: &Security,
    record: &ConnectionRecord,
    platform: &str,
    method: &Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Caller, ApiError> {
    let owner = agent_id::parse(&record.owner).ok_or(ApiError::Internal)?;
    let authorization = headers
        .get(header::AUTHORIZATION)
        .map(|value| {
            value
                .to_str()
                .map_err(|_| ApiError::UnsupportedAuthorization)
        })
        .transpose()?;
    let caller = match authorization {
        Some(value) => {
            let token = value
                .strip_prefix("Capability ")
                .ok_or(ApiError::UnsupportedAuthorization)?;
            let parsed = capability::parse(token)?;
            parsed.verify(&owner, &state.public_origin, crate::now_secs())?;
            if parsed.claims.connection_id != record.connection_id
                || parsed.claims.platform != platform
                || record.platform != platform
            {
                return Err(ApiError::CapabilityScope);
            }
            if !security
                .is_delegated(&record.connection_id, parsed.app.as_str())
                .await
                .map_err(|_| ApiError::Unavailable)?
            {
                return Err(ApiError::NotDelegated);
            }
            let signer =
                crate::signature::authenticate(state, security, method, uri, headers, body).await?;
            if signer != parsed.cnf {
                return Err(ApiError::CapabilityKeyMismatch);
            }
            Caller::Frame {
                app: parsed.app.as_str().to_owned(),
            }
        }
        None => {
            let signer =
                crate::signature::authenticate(state, security, method, uri, headers, body).await?;
            match security
                .standing(&record.connection_id, owner.as_str(), signer.as_str())
                .await
                .map_err(|_| ApiError::Unavailable)?
            {
                Standing::Owner => Caller::Owner,
                Standing::Delegate => Caller::Delegate(signer.as_str().to_owned()),
                Standing::Runtime { app } => Caller::Runtime {
                    agent: signer.as_str().to_owned(),
                    app,
                },
                Standing::None => return Err(ApiError::NotDelegated),
            }
        }
    };
    if record.platform != platform {
        return Err(ApiError::PlatformMismatch);
    }
    crate::check_access(state, &owner).await?;
    Ok(caller)
}

/// How to attach a resolved credential to the outbound upstream request.
/// `None` covers query-located API keys, already appended to the target URL
/// before the request is built.
pub(crate) enum CredentialInjection {
    Bearer(String),
    Basic { username: String, password: String },
    Header { name: String, value: String },
    None,
}

impl CredentialInjection {
    /// Attaches the credential. reqwest marks the `Authorization` value it
    /// builds for `Bearer` and `Basic` as sensitive.
    pub(crate) fn apply(self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self {
            Self::Bearer(token) => request.bearer_auth(token),
            Self::Basic { username, password } => request.basic_auth(username, Some(password)),
            Self::Header { name, value } => request.header(name, value),
            Self::None => request,
        }
    }
}

pub async fn forward(
    Path((connection_id, platform, path)): Path<(String, String, String)>,
    RawQuery(query): RawQuery,
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut response = match forward_inner(
        &state,
        &connection_id,
        &platform,
        &path,
        query,
        method,
        &uri,
        &headers,
        body,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    // A proxied response is one caller's view of one connection: never to
    // be cached, also not heuristically from a forwarded `Last-Modified`.
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[allow(clippy::too_many_arguments)]
async fn forward_inner(
    state: &AppState,
    connection_id: &str,
    platform: &str,
    path: &str,
    query: Option<String>,
    method: Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let request_path = format!("/{path}");
    if contains_traversal_segment(&request_path) {
        return Err(ApiError::BadRequest(
            "path must not contain traversal segments",
        ));
    }
    if body.len() > 1_048_576 {
        return Ok((StatusCode::PAYLOAD_TOO_LARGE, "request body is too large").into_response());
    }
    let security = state.security.as_ref().ok_or(ApiError::Unavailable)?;
    if connection_id.len() != 43 {
        return Err(ApiError::UnknownConnection);
    }
    let record = security
        .load_connection(connection_id)
        .await
        .map_err(|_| ApiError::Unavailable)?
        .ok_or(ApiError::UnknownConnection)?;
    let caller = authenticate(
        state, security, &record, platform, &method, uri, headers, &body,
    )
    .await?;
    // Only an authenticated use keeps a connection alive.
    let (delegate, runtime) = match &caller {
        Caller::Owner => (None, None),
        Caller::Delegate(agent) => (Some(agent.as_str()), None),
        Caller::Runtime { agent, app } => (
            Some(app.as_str()),
            Some((record.owner.as_str(), agent.as_str())),
        ),
        Caller::Frame { app } => (Some(app.as_str()), None),
    };
    let _ = security.touch(connection_id, delegate, runtime).await;

    let mut credential = serde_json::from_slice::<StoredCredential>(&record.credential)
        .map_err(|_| ApiError::Internal)?;
    if credential.provider() != platform {
        return Err(ApiError::PlatformMismatch);
    }
    if refresh_connection(state, security, connection_id, &mut credential)
        .await
        .is_err()
    {
        return Err(ApiError::CredentialRefreshFailed);
    }
    let not_in_catalog = || {
        (
            StatusCode::NOT_FOUND,
            "method or path is not in the catalog",
        )
            .into_response()
    };
    let Some(required_headers) =
        state
            .catalog
            .required_headers(platform, method.as_str(), &request_path)
    else {
        return Ok(not_in_catalog());
    };
    let Some(mut target) = state
        .catalog
        .allows(platform, method.as_str(), &request_path)
    else {
        return Ok(not_in_catalog());
    };
    if let Err(message) = state.catalog.validate_request(
        platform,
        method.as_str(),
        &request_path,
        query.as_deref(),
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        !body.is_empty(),
    ) {
        return Ok((StatusCode::BAD_REQUEST, message).into_response());
    }
    target.set_path(&request_path);
    target.set_query(query.as_deref());
    let injection = match &credential {
        StoredCredential::OAuth { access_token, .. } => {
            // Only while the platform still resolves to OAuth: if its
            // selection has since moved to an apiKey profile, the token must
            // not go to that profile's operations, and the person has to
            // connect again.
            if !matches!(
                state.catalog.security_scheme(platform),
                Ok(crate::providers::SecurityScheme::OAuth(_))
            ) {
                return Err(ApiError::CredentialRefreshFailed);
            }
            CredentialInjection::Bearer(access_token.clone())
        }
        StoredCredential::ApiKey {
            key,
            scheme: bound,
            placement,
            ..
        } => {
            let Ok(crate::providers::SecurityScheme::ApiKey(scheme)) =
                state.catalog.security_scheme(platform)
            else {
                return Err(ApiError::Internal);
            };
            // A key entered for one apiKey scheme is not sent under another,
            // nor to another header or query parameter than it was entered
            // for (rows written before the binding have none, and are sent
            // as before).
            if bound
                .as_ref()
                .is_some_and(|bound| *bound != scheme.scheme_name)
                || placement
                    .as_ref()
                    .is_some_and(|placement| *placement != scheme.placement())
            {
                return Err(ApiError::CredentialRefreshFailed);
            }
            match scheme.location {
                crate::providers::ApiKeyLocation::Header => CredentialInjection::Header {
                    name: scheme.name,
                    value: key.clone(),
                },
                crate::providers::ApiKeyLocation::Query => {
                    target.query_pairs_mut().append_pair(&scheme.name, key);
                    CredentialInjection::None
                }
                crate::providers::ApiKeyLocation::Cookie => {
                    return Ok((
                        StatusCode::NOT_IMPLEMENTED,
                        "cookie-located API keys are not supported",
                    )
                        .into_response());
                }
            }
        }
        StoredCredential::HttpBearer {
            token,
            scheme: bound,
            ..
        } => {
            // Only while the platform still resolves to the bearer scheme
            // the token was entered for: it is not sent under another kind
            // or another scheme.
            match state.catalog.security_scheme(platform) {
                Ok(crate::providers::SecurityScheme::Http(crate::providers::HttpScheme {
                    name,
                    auth: crate::providers::HttpAuth::Bearer,
                    ..
                })) if bound.as_ref().is_none_or(|bound| *bound == name) => {
                    CredentialInjection::Bearer(token.clone())
                }
                _ => return Err(ApiError::CredentialRefreshFailed),
            }
        }
        StoredCredential::HttpBasic {
            username,
            password,
            scheme: bound,
            layout: bound_layout,
            ..
        } => match state.catalog.security_scheme(platform) {
            // The same for Basic, and the declared layout must still be the
            // one the halves were built from.
            Ok(crate::providers::SecurityScheme::Http(crate::providers::HttpScheme {
                name,
                auth: crate::providers::HttpAuth::Basic(layout),
                ..
            })) if bound.as_ref().is_none_or(|bound| *bound == name)
                && bound_layout
                    .as_ref()
                    .is_none_or(|bound| *bound == layout.layout()) =>
            {
                CredentialInjection::Basic {
                    username: username.clone(),
                    password: password.clone(),
                }
            }
            _ => return Err(ApiError::CredentialRefreshFailed),
        },
        StoredCredential::NoCredential { .. } => {
            // Only while the catalog still says the platform needs none: if
            // it has since gained a scheme, this connection holds nothing to
            // send, and the person has to connect again.
            if state.catalog.security_scheme(platform)
                != Ok(crate::providers::SecurityScheme::NoCredential)
            {
                return Err(ApiError::CredentialRefreshFailed);
            }
            CredentialInjection::None
        }
    };
    // P3: only where the operation declares the header. A provider scopes
    // idempotency keys to the account that sends them; a no-credential
    // connection sends none, so every tenant would share one key space and
    // one tenant could replay another's stored response. There the key is
    // namespaced per connection: stable, so a retry still matches.
    let idempotency_key = match headers.get(IDEMPOTENCY_KEY) {
        Some(value)
            if state.catalog.declares_header_parameter(
                platform,
                method.as_str(),
                &request_path,
                IDEMPOTENCY_KEY,
            ) =>
        {
            match &credential {
                StoredCredential::NoCredential { .. } => Some(
                    HeaderValue::from_str(
                        &security.connection_idempotency_key(connection_id, value.as_bytes()),
                    )
                    .map_err(|_| ApiError::Internal)?,
                ),
                _ => Some(value.clone()),
            }
        }
        _ => None,
    };
    let upstream = match upstream_request(
        &state.http_client,
        method.clone(),
        target.clone(),
        injection,
        headers,
        &required_headers,
        idempotency_key.as_ref(),
        body,
    )
    .send()
    .await
    {
        Ok(response) => response,
        Err(_) => return Ok((StatusCode::BAD_GATEWAY, "upstream request failed").into_response()),
    };
    let status = upstream.status();
    let forwarded_headers = upstream_response_headers(upstream.headers());
    let bytes = match read_bounded_body(upstream, MAX_RESPONSE_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok((
                StatusCode::BAD_GATEWAY,
                "upstream response failed or was too large",
            )
                .into_response())
        }
    };
    let mut response = Response::new(bytes.into());
    *response.status_mut() = status;
    *response.headers_mut() = forwarded_headers;
    Ok(response)
}

/// Rate-limit response headers forwarded unchanged, by exact name only:
/// the names Throttling 0.2.0 (`openapi-extensions/spec/throttling`) gives
/// roles to, GitHub's `x-ratelimit-resource`, the IETF `RateLimit` and
/// `RateLimit-Policy` fields and the older drafts' `RateLimit-Limit`,
/// `-Remaining` and `-Reset`. Each reports the quota of the credential (or,
/// for a no-credential or IP-partitioned API, the proxy's address) that this
/// very request used; none carries a secret. Never widen this to a prefix
/// match: a provider may send any `x-ratelimit-*`-looking name.
pub(crate) const RATE_LIMIT_HEADERS: [&str; 10] = [
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-used",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
    "ratelimit",
    "ratelimit-policy",
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
];

/// Representation and pagination response headers forwarded unchanged.
const REPRESENTATION_HEADERS: [&str; 7] = [
    "content-type",
    "link",
    "retry-after",
    "etag",
    "last-modified",
    "x-total-count",
    "x-next-page",
];

/// Every response header the proxy forwards, and so every one CORS
/// exposes (`browser_cors`): the one list both use.
pub(crate) fn forwarded_response_headers() -> impl Iterator<Item = header::HeaderName> {
    REPRESENTATION_HEADERS
        .into_iter()
        .chain(RATE_LIMIT_HEADERS)
        .map(header::HeaderName::from_static)
}

/// The caller's headers that go upstream unchanged, unless the catalog
/// fixes a value for the same name: the body's type, the write
/// precondition and the conditional-read validators (P2). None of them is
/// covered by the request signature (SECURITY.md, "Validating proxy").
pub(crate) const CALLER_HEADERS: [header::HeaderName; 4] = [
    header::CONTENT_TYPE,
    header::IF_MATCH,
    header::IF_NONE_MATCH,
    header::IF_MODIFIED_SINCE,
];

/// P3: forwarded only where the operation declares it, and namespaced per
/// connection on a no-credential connection (`forward_inner`).
pub(crate) const IDEMPOTENCY_KEY: &str = "idempotency-key";

// Forward only representation, pagination and rate-limit metadata from an
// explicit list, never provider cookies or credentials.
fn upstream_response_headers(headers: &HeaderMap) -> HeaderMap {
    let mut result = HeaderMap::new();
    for name in forwarded_response_headers() {
        for value in headers.get_all(&name) {
            result.append(name.clone(), value.clone());
        }
    }
    result
}

const MAX_RESPONSE_BYTES: usize = 10_485_760;

/// Reads the upstream body incrementally so an oversized or slow response is
/// rejected as soon as the limit is crossed, instead of after it is fully
/// buffered in memory.
async fn read_bounded_body(mut upstream: reqwest::Response, limit: usize) -> Result<Bytes, ()> {
    if upstream
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err(());
    }
    let mut buffer = Vec::new();
    while let Some(chunk) = upstream.chunk().await.map_err(|_| ())? {
        if buffer.len() + chunk.len() > limit {
            return Err(());
        }
        buffer.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(buffer))
}

/// Rejects any `.` or `..` path segment so a client cannot request a path
/// that, once assigned to the upstream URL, normalizes to a different path
/// than the one validated against the catalog allowlist.
fn contains_traversal_segment(path: &str) -> bool {
    path.split('/')
        .any(|segment| segment == "." || segment == "..")
}

#[allow(clippy::too_many_arguments)]
fn upstream_request(
    client: &reqwest::Client,
    method: axum::http::Method,
    target: Url,
    injection: CredentialInjection,
    headers: &HeaderMap,
    required_headers: &[(String, String)],
    idempotency_key: Option<&HeaderValue>,
    body: Bytes,
) -> reqwest::RequestBuilder {
    // The caller's own `Authorization` (a frame capability) is consumed by
    // `authenticate` and never copied: only the headers below go upstream.
    // A value the catalog fixes wins over the caller's, so no header is
    // sent twice.
    let fixed = |name: &str| {
        required_headers
            .iter()
            .any(|(fixed, _)| fixed.eq_ignore_ascii_case(name))
    };
    let mut request = injection.apply(client.request(method, target));
    for name in CALLER_HEADERS {
        if let Some(value) = headers.get(&name).filter(|_| !fixed(name.as_str())) {
            request = request.header(name, value);
        }
    }
    if let Some(value) = idempotency_key.filter(|_| !fixed(IDEMPOTENCY_KEY)) {
        request = request.header(IDEMPOTENCY_KEY, value);
    }
    for (name, value) in required_headers {
        request = request.header(name, value);
    }
    request.body(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_id::test_signer::Agent;
    use crate::capability::{mint, Claims};
    use crate::test_support::{body_json, security, signed_request, state, PUBLIC_ORIGIN};
    use axum::http::{header::AUTHORIZATION, HeaderValue};
    use axum::Json;
    use serde_json::json;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        state(None)
    }

    #[tokio::test]
    async fn forwarded_requests_include_server_owned_user_agent() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/repos/owner/repo/issues",
            axum::routing::post(|axum::extract::OriginalUri(uri): axum::extract::OriginalUri, headers: HeaderMap, body: Bytes| async move {
                Json(json!({
                    "query": uri.query(),
                    "user_agent": headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()),
                    "authorization": headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()),
                    "content_type": headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
                    "if_match": headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()),
                    "body": String::from_utf8(body.to_vec()).unwrap(),
                }))
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::build_http_client();
        for caller_user_agent in [None, Some("caller-controlled-agent")] {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            headers.insert(
                header::IF_MATCH,
                HeaderValue::from_static("\"event-version\""),
            );
            if let Some(value) = caller_user_agent {
                headers.insert(header::USER_AGENT, HeaderValue::from_static(value));
            }
            let response = upstream_request(
                &client,
                axum::http::Method::POST,
                Url::parse(&format!("http://{address}/repos/owner/repo/issues?state=all&page=2&per_page=1&labels=a%2Cb")).unwrap(),
                CredentialInjection::Bearer("test-provider-token".to_string()),
                &headers,
                &[],
                None,
                Bytes::from_static(b"{}"),
            )
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
            assert_eq!(
                response["query"],
                "state=all&page=2&per_page=1&labels=a%2Cb"
            );
            assert_eq!(response["user_agent"], "LocalThought-integration-proxy");
            assert_eq!(response["authorization"], "Bearer test-provider-token");
            assert_eq!(response["content_type"], "application/json");
            assert_eq!(response["body"], "{}");
            assert_eq!(response["if_match"], "\"event-version\"");
        }
        server.abort();
    }

    #[tokio::test]
    async fn api_key_credentials_are_sent_as_the_declared_header_not_bearer() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/workspaces",
            axum::routing::get(
                |headers: HeaderMap| async move {
                    Json(json!({
                        "authorization": headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()),
                        "x_api_key": headers.get("x-api-key").and_then(|v| v.to_str().ok()),
                    }))
                },
            ),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::build_http_client();
        let response = upstream_request(
            &client,
            axum::http::Method::GET,
            Url::parse(&format!("http://{address}/workspaces")).unwrap(),
            CredentialInjection::Header {
                name: "X-Api-Key".to_string(),
                value: "clockify-secret".to_string(),
            },
            &HeaderMap::new(),
            &[],
            None,
            Bytes::new(),
        )
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
        assert_eq!(response["authorization"], serde_json::Value::Null);
        assert_eq!(response["x_api_key"], "clockify-secret");
        server.abort();
    }

    #[test]
    fn pagination_headers_survive_without_forwarding_provider_credentials() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.append(
            header::LINK,
            HeaderValue::from_static(
                "<https://api.github.com/repos/o/r/issues?page=2>; rel=\"next\"",
            ),
        );
        headers.append(
            header::LINK,
            HeaderValue::from_static(
                "<https://api.github.com/repos/o/r/issues?page=3>; rel=\"last\"",
            ),
        );
        headers.insert(
            header::SET_COOKIE,
            HeaderValue::from_static("provider-session=private"),
        );
        headers.insert(
            "x-connection-code",
            HeaderValue::from_static("untrusted-provider-code"),
        );
        headers.insert(header::RETRY_AFTER, HeaderValue::from_static("300"));
        let forwarded = upstream_response_headers(&headers);
        assert_eq!(
            forwarded.get(header::RETRY_AFTER),
            Some(&HeaderValue::from_static("300"))
        );
        assert_eq!(forwarded.get_all(header::LINK).iter().count(), 2);
        assert_eq!(forwarded[header::CONTENT_TYPE], "application/json");
        assert!(!forwarded.contains_key(header::SET_COOKIE));
        assert!(!forwarded.contains_key("x-connection-code"));
    }

    /// P1 and P2: rate-limit headers and `Last-Modified` come back by exact
    /// name, every value of each, and nothing else that merely looks alike.
    #[test]
    fn rate_limit_headers_and_last_modified_are_forwarded_by_exact_name_only() {
        let mut headers = HeaderMap::new();
        for name in RATE_LIMIT_HEADERS {
            headers.insert(name, HeaderValue::from_static("42"));
        }
        headers.append(
            "ratelimit-policy",
            HeaderValue::from_static("\"hour\";q=5000;w=3600"),
        );
        headers.insert(
            header::LAST_MODIFIED,
            HeaderValue::from_static("Wed, 07 Oct 2026 10:00:00 GMT"),
        );
        for name in [
            "x-ratelimit-token",
            "x-ratelimit-client-id",
            "x-rate-limit-limit",
            "ratelimit-session",
            "x-oauth-scopes",
            "x-github-request-id",
            "www-authenticate",
            "authorization",
            "set-cookie",
        ] {
            headers.insert(name, HeaderValue::from_static("must-not-pass"));
        }
        let forwarded = upstream_response_headers(&headers);
        for name in RATE_LIMIT_HEADERS {
            assert_eq!(forwarded[name], "42", "{name}");
        }
        assert_eq!(forwarded.get_all("ratelimit-policy").iter().count(), 2);
        assert_eq!(
            forwarded[header::LAST_MODIFIED],
            "Wed, 07 Oct 2026 10:00:00 GMT"
        );
        assert_eq!(forwarded.len(), RATE_LIMIT_HEADERS.len() + 2);
        assert!(forwarded
            .values()
            .all(|value| value.as_bytes() != b"must-not-pass"));
    }

    /// P2 and P3: the conditional-read validators always go upstream, an
    /// `Idempotency-Key` only when its operation declares one and the
    /// catalog sets no fixed value, and other caller headers never.
    #[tokio::test]
    async fn conditional_and_declared_idempotency_headers_go_upstream() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/items",
            axum::routing::any(|headers: HeaderMap| async move {
                let all = |name: &str| {
                    headers
                        .get_all(name)
                        .iter()
                        .filter_map(|v| v.to_str().ok().map(str::to_owned))
                        .collect::<Vec<_>>()
                };
                Json(json!({
                    "if_none_match": all("if-none-match"),
                    "if_modified_since": all("if-modified-since"),
                    "idempotency_key": all("idempotency-key"),
                    "cookie": all("cookie"),
                    "forwarded_for": all("x-forwarded-for"),
                    "authorization": all("authorization"),
                }))
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::build_http_client();
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, HeaderValue::from_static("\"v7\""));
        headers.insert(
            header::IF_MODIFIED_SINCE,
            HeaderValue::from_static("Wed, 07 Oct 2026 10:00:00 GMT"),
        );
        headers.insert(IDEMPOTENCY_KEY, HeaderValue::from_static("create-1"));
        headers.insert(header::COOKIE, HeaderValue::from_static("session=caller"));
        headers.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.9"));
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Capability caller"));
        let key = HeaderValue::from_static("create-1");
        let send = |declared: bool, required: Vec<(String, String)>| {
            let request = upstream_request(
                &client,
                axum::http::Method::POST,
                Url::parse(&format!("http://{address}/items")).unwrap(),
                CredentialInjection::None,
                &headers,
                &required,
                declared.then_some(&key),
                Bytes::new(),
            );
            async move {
                request
                    .send()
                    .await
                    .unwrap()
                    .json::<serde_json::Value>()
                    .await
                    .unwrap()
            }
        };
        let declared = send(true, vec![]).await;
        assert_eq!(declared["if_none_match"], json!(["\"v7\""]));
        assert_eq!(
            declared["if_modified_since"],
            json!(["Wed, 07 Oct 2026 10:00:00 GMT"])
        );
        assert_eq!(declared["idempotency_key"], json!(["create-1"]));
        for name in ["cookie", "forwarded_for", "authorization"] {
            assert_eq!(declared[name], json!([]), "{name}");
        }
        let undeclared = send(false, vec![]).await;
        assert_eq!(undeclared["idempotency_key"], json!([]));
        assert_eq!(undeclared["if_none_match"], json!(["\"v7\""]));
        let fixed = send(
            true,
            vec![("Idempotency-Key".to_owned(), "catalog-fixed".to_owned())],
        )
        .await;
        assert_eq!(fixed["idempotency_key"], json!(["catalog-fixed"]));
        // A conditional header the catalog fixes is sent once, with the
        // catalog's value.
        let fixed = send(
            false,
            vec![
                ("If-None-Match".to_owned(), "*".to_owned()),
                ("if-modified-since".to_owned(), "catalog-date".to_owned()),
            ],
        )
        .await;
        assert_eq!(fixed["if_none_match"], json!(["*"]));
        assert_eq!(fixed["if_modified_since"], json!(["catalog-date"]));
        server.abort();
    }

    #[test]
    fn the_forwarded_list_is_the_representation_and_rate_limit_headers() {
        let names: Vec<_> = forwarded_response_headers().collect();
        assert_eq!(names.len(), 17);
        for name in [
            "last-modified",
            "x-next-page",
            "x-ratelimit-reset",
            "ratelimit-policy",
        ] {
            assert!(names.iter().any(|n| n == name), "{name}");
        }
    }

    #[test]
    fn traversal_segments_are_rejected_including_encoded_forms() {
        assert!(contains_traversal_segment("/repositories/../issues"));
        assert!(contains_traversal_segment("/repositories/./issues"));
        assert!(contains_traversal_segment("/../etc/passwd"));
        assert!(!contains_traversal_segment("/repositories/123/issues"));
        assert!(!contains_traversal_segment("/repositories/..foo/issues"));
    }

    #[tokio::test]
    async fn forward_rejects_a_path_containing_traversal_segments_before_touching_credentials() {
        let mut state = test_state();
        state.catalog = crate::catalog::Catalog::from_test_document(
            "github-issues",
            json!({
                "servers": [{"url": "https://api.example"}],
                "paths": {"/repositories/{id}/issues": {"get": {}}}
            }),
            json!({}),
        );
        // No Authorization header and no security service configured: if the
        // traversal check did not run first, this would fail with 401/503
        // instead of 400.
        let response = crate::router(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/proxy/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/github-issues/repositories/../issues")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        // Every proxied response, refusals included, is no-store.
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn read_bounded_body_rejects_a_response_over_the_limit() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route("/big", axum::routing::get(|| async { vec![0u8; 20] }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::build_http_client();
        let response = client
            .get(format!("http://{address}/big"))
            .send()
            .await
            .unwrap();
        assert!(read_bounded_body(response, 10).await.is_err());

        let response = client
            .get(format!("http://{address}/big"))
            .send()
            .await
            .unwrap();
        assert!(read_bounded_body(response, 20).await.is_ok());
        server.abort();
    }

    /// An upstream that echoes the API key it received, and a catalog for it.
    async fn api_key_upstream() -> (tokio::task::JoinHandle<()>, crate::catalog::Catalog) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/workspaces",
            axum::routing::any(|headers: HeaderMap| async move {
                axum::Json(json!({
                    "x_api_key": headers.get("x-api-key").and_then(|v| v.to_str().ok()),
                    "signature_forwarded": headers.contains_key("x-atomic-signature"),
                    "authorization": headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()),
                }))
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let catalog = crate::catalog::Catalog::from_test_document(
            "clockify",
            json!({
                "servers": [{"url": format!("http://{address}")}],
                "components": {"securitySchemes": {"clockifyApiKey": {
                    "type": "apiKey", "in": "header", "name": "X-Api-Key"
                }}},
                "security": [{"clockifyApiKey": []}],
                "paths": {"/workspaces": {"get": {}, "post": {"requestBody": {"content": {"application/json": {}}}}}}
            }),
            json!({}),
        );
        (server, catalog)
    }

    fn basic(username: &str, password: &str) -> String {
        use base64::Engine as _;
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
        )
    }

    #[tokio::test]
    async fn http_credentials_are_sent_as_bearer_or_basic_authorization() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/workspaces",
            axum::routing::get(|headers: HeaderMap| async move {
                Json(json!({
                    "authorization": headers.get_all(AUTHORIZATION).iter()
                        .filter_map(|v| v.to_str().ok()).collect::<Vec<_>>(),
                }))
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::build_http_client();
        // A caller's own Authorization in the incoming headers is not copied.
        let mut incoming = HeaderMap::new();
        incoming.insert(AUTHORIZATION, HeaderValue::from_static("Capability x"));
        for (injection, expected) in [
            (
                CredentialInjection::Bearer("pat-secret".into()),
                "Bearer pat-secret".to_owned(),
            ),
            (
                CredentialInjection::Basic {
                    username: "pat-secret".into(),
                    password: "api_token".into(),
                },
                basic("pat-secret", "api_token"),
            ),
            (
                CredentialInjection::Basic {
                    username: "sk_secret".into(),
                    password: String::new(),
                },
                basic("sk_secret", ""),
            ),
        ] {
            let response = upstream_request(
                &client,
                axum::http::Method::GET,
                Url::parse(&format!("http://{address}/workspaces")).unwrap(),
                injection,
                &incoming,
                &[],
                None,
                Bytes::new(),
            )
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
            assert_eq!(response["authorization"], json!([expected]));
        }
        server.abort();
    }

    #[test]
    fn a_stored_credential_debugs_without_its_secret() {
        for credential in [
            StoredCredential::HttpBearer {
                scheme: None,
                provider: "service".into(),
                token: "pat-secret".into(),
            },
            StoredCredential::HttpBasic {
                scheme: None,
                layout: None,
                provider: "service".into(),
                username: "user-secret".into(),
                password: "pat-secret".into(),
            },
            StoredCredential::ApiKey {
                placement: None,
                scheme: None,
                provider: "service".into(),
                key: "pat-secret".into(),
            },
            StoredCredential::OAuth {
                provider: "service".into(),
                access_token: "pat-secret".into(),
                refresh_token: Some("user-secret".into()),
                expires_at: None,
            },
        ] {
            let debug = format!("{credential:?}");
            assert!(debug.contains("service"), "{debug}");
            assert!(
                !debug.contains("pat-secret") && !debug.contains("user-secret"),
                "{debug}"
            );
        }
    }

    /// An upstream that echoes the `Authorization` it received, and a
    /// catalog whose one scheme is `scheme` (an `http` scheme, say).
    async fn http_upstream(
        scheme: serde_json::Value,
    ) -> (tokio::task::JoinHandle<()>, crate::catalog::Catalog) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/workspaces",
            axum::routing::any(|headers: HeaderMap| async move {
                axum::Json(json!({
                    "authorization": headers.get_all(AUTHORIZATION).iter()
                        .filter_map(|v| v.to_str().ok()).collect::<Vec<_>>(),
                    "signature_forwarded": headers.contains_key("x-atomic-signature"),
                }))
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let catalog = crate::catalog::Catalog::from_test_document(
            "clockify",
            json!({
                "servers": [{"url": format!("http://{address}")}],
                "components": {"securitySchemes": {"serviceToken": scheme}},
                "security": [{"serviceToken": []}],
                "paths": {"/workspaces": {"get": {}}}
            }),
            json!({}),
        );
        (server, catalog)
    }

    fn bearer_scheme() -> serde_json::Value {
        json!({"type": "http", "scheme": "bearer"})
    }

    fn basic_scheme() -> serde_json::Value {
        json!({"type": "http", "scheme": "basic", "x-api-key-details": {
            "basicCredentials": {"token": "username", "password": "api_token"}}})
    }

    /// Q-086: a bearer or basic token reaches the provider only as the
    /// `Authorization` the platform's scheme declares; the caller's own
    /// `Authorization` (a frame capability) never does, any other is
    /// refused, and a token connected under one kind is not sent once the
    /// platform resolves to another.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_http_tokens_reach_the_provider_only_as_declared() {
        let security = security().await;
        let bearer_credential = serde_json::to_vec(&StoredCredential::HttpBearer {
            scheme: None,
            provider: "clockify".into(),
            token: "pat-secret".into(),
        })
        .unwrap();
        let basic_credential = serde_json::to_vec(&StoredCredential::HttpBasic {
            scheme: None,
            layout: None,
            provider: "clockify".into(),
            username: "pat-secret".into(),
            password: "api_token".into(),
        })
        .unwrap();
        let owner = Agent::new(73);
        let fixture = |scheme: serde_json::Value, credential: Vec<u8>| {
            let security = security.clone();
            let owner_id = owner.id();
            async move {
                let (server, catalog) = http_upstream(scheme).await;
                let mut s = state(Some(security.clone()));
                s.catalog = catalog;
                let id = security
                    .create_connection("clockify", &owner_id, &credential)
                    .await
                    .unwrap();
                Fixture {
                    state: s,
                    security,
                    owner: Agent::new(73),
                    id,
                    _server: server,
                }
            }
        };

        // Bearer, signed by the owner.
        let f = fixture(bearer_scheme(), bearer_credential.clone()).await;
        let response = f.get_as(&f.owner).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["authorization"], json!(["Bearer pat-secret"]));
        assert_eq!(body["signature_forwarded"], false);
        // Through a frame capability: the capability is consumed here, and
        // only the connection's token goes upstream.
        let app = Agent::new(74);
        let frame = Agent::new(75);
        f.security
            .put_delegation(&f.id, &app.id(), None)
            .await
            .unwrap();
        let token = mint(&f.owner, &f.claims(&app, &frame));
        let response = f.frame_get(&token, &frame).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await["authorization"],
            json!(["Bearer pat-secret"])
        );
        // Any other Authorization from the caller is refused, not forwarded.
        for supplied in ["Bearer attacker-token", &basic("attacker", "x")] {
            let mut request = signed_request(&f.state, &f.owner, "GET", &f.path(), vec![]);
            request
                .headers_mut()
                .insert(AUTHORIZATION, HeaderValue::from_str(supplied).unwrap());
            expect_error(
                f.send(request).await,
                StatusCode::UNAUTHORIZED,
                "unsupported_authorization",
            )
            .await;
        }
        // The token is never echoed back to the caller.
        let response = f.get_as(&f.owner).await;
        assert!(!response
            .headers()
            .values()
            .any(|v| v.to_str().is_ok_and(|v| v.contains("pat-secret"))));

        // Basic: the declared layout, base64 of username:password.
        let f = fixture(basic_scheme(), basic_credential.clone()).await;
        let response = f.get_as(&f.owner).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await["authorization"],
            json!([basic("pat-secret", "api_token")])
        );

        // A token connected under one kind is not sent under another.
        for (scheme, credential) in [
            (basic_scheme(), bearer_credential.clone()),
            (bearer_scheme(), basic_credential.clone()),
            (
                json!({"type": "apiKey", "in": "header", "name": "X-Api-Key"}),
                bearer_credential,
            ),
            (
                json!({"type": "apiKey", "in": "header", "name": "X-Api-Key"}),
                basic_credential,
            ),
        ] {
            let f = fixture(scheme, credential).await;
            expect_error(
                f.get_as(&f.owner).await,
                StatusCode::UNAUTHORIZED,
                "credential_refresh_failed",
            )
            .await;
        }
    }

    #[test]
    fn credentials_without_a_binding_still_read_and_new_ones_carry_it() {
        // Rows written before the binding have no `scheme` or `layout`.
        for old in [
            json!({"kind": "api_key", "provider": "p", "key": "k"}),
            json!({"kind": "http_bearer", "provider": "p", "token": "t"}),
            json!({"kind": "http_basic", "provider": "p", "username": "u", "password": "w"}),
        ] {
            let credential: StoredCredential = serde_json::from_value(old.clone()).unwrap();
            // ... and are written back without them.
            assert_eq!(serde_json::to_value(&credential).unwrap(), old);
        }
        let new = StoredCredential::HttpBasic {
            provider: "p".into(),
            username: "u".into(),
            password: "w".into(),
            scheme: Some("serviceToken".into()),
            layout: Some(crate::providers::BasicLayout::Username {
                password: "api_token".into(),
            }),
        };
        let value = serde_json::to_value(&new).unwrap();
        assert_eq!(value["scheme"], "serviceToken");
        assert_eq!(
            value["layout"],
            json!({"token": "username", "password": "api_token"})
        );
        assert!(matches!(
            serde_json::from_value::<StoredCredential>(value).unwrap(),
            StoredCredential::HttpBasic {
                scheme: Some(_),
                layout: Some(_),
                ..
            }
        ));
    }

    /// A credential is sent only under the security scheme (and, for Basic,
    /// the declared layout) it was entered for; a credential without a
    /// binding, from before it existed, is sent as before.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_credential_is_sent_only_under_the_scheme_it_was_entered_for() {
        let security = security().await;
        let status = |scheme: serde_json::Value, credential: StoredCredential| {
            let security = security.clone();
            let owner = Agent::new(77);
            async move {
                let (_server, catalog) = http_upstream(scheme).await;
                let mut s = state(Some(security.clone()));
                s.catalog = catalog;
                let id = security
                    .create_connection(
                        "clockify",
                        &owner.id(),
                        &serde_json::to_vec(&credential).unwrap(),
                    )
                    .await
                    .unwrap();
                let request = signed_request(
                    &s,
                    &owner,
                    "GET",
                    &format!("/proxy/{id}/clockify/workspaces"),
                    vec![],
                );
                let response = crate::router(s).oneshot(request).await.unwrap();
                let status = response.status();
                let body = body_json(response).await;
                (status, body)
            }
        };
        let bearer = |scheme: Option<&str>| StoredCredential::HttpBearer {
            provider: "clockify".into(),
            token: "pat-secret".into(),
            scheme: scheme.map(str::to_owned),
        };
        let basic = |scheme: Option<&str>, layout: Option<crate::providers::BasicLayout>| {
            StoredCredential::HttpBasic {
                provider: "clockify".into(),
                username: "pat-secret".into(),
                password: "api_token".into(),
                scheme: scheme.map(str::to_owned),
                layout,
            }
        };
        let declared = || crate::providers::BasicLayout::Username {
            password: "api_token".into(),
        };
        let api_key = |scheme: Option<&str>| StoredCredential::ApiKey {
            placement: None,
            provider: "clockify".into(),
            key: "clockify-secret".into(),
            scheme: scheme.map(str::to_owned),
        };
        // Bound to the right scheme, and to where the key goes.
        let placed = |location: &str, name: &str| StoredCredential::ApiKey {
            placement: Some(crate::providers::ApiKeyPlacement {
                location: location.into(),
                name: name.into(),
            }),
            provider: "clockify".into(),
            key: "clockify-secret".into(),
            scheme: Some("serviceToken".into()),
        };
        let api_key_scheme = || json!({"type": "apiKey", "in": "header", "name": "X-Api-Key"});

        // Bound to the scheme it resolves to, or unbound: sent.
        for (scheme, credential) in [
            (bearer_scheme(), bearer(Some("serviceToken"))),
            (bearer_scheme(), bearer(None)),
            (
                basic_scheme(),
                basic(Some("serviceToken"), Some(declared())),
            ),
            (basic_scheme(), basic(None, None)),
            (api_key_scheme(), api_key(Some("serviceToken"))),
            (api_key_scheme(), api_key(None)),
            // Header names compare case-insensitively.
            (api_key_scheme(), placed("header", "x-api-key")),
        ] {
            let (status, _) = status(scheme.clone(), credential).await;
            assert_eq!(status, StatusCode::OK, "{scheme}");
        }
        // Entered for another scheme, or another Basic layout: not sent.
        let other_layouts = [
            crate::providers::BasicLayout::Username {
                password: String::new(),
            },
            crate::providers::BasicLayout::Password { username: None },
            crate::providers::BasicLayout::Password {
                username: Some("pat-secret".into()),
            },
        ];
        let mut refused = vec![
            (bearer_scheme(), bearer(Some("otherToken"))),
            (basic_scheme(), basic(Some("otherToken"), Some(declared()))),
            (api_key_scheme(), api_key(Some("otherKey"))),
            (api_key_scheme(), placed("query", "X-Api-Key")),
            (api_key_scheme(), placed("header", "x-other-key")),
        ];
        for layout in other_layouts {
            refused.push((basic_scheme(), basic(Some("serviceToken"), Some(layout))));
        }
        for (scheme, credential) in refused {
            let (status, body) = status(scheme.clone(), credential).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{scheme}");
            assert_eq!(body["error"], "credential_refresh_failed");
        }
    }

    /// An `http` bearer scheme as an authentication profile's one scheme:
    /// its token goes only to the operations the profile covers, and a
    /// token connected under it is not sent once the selection names an
    /// OAuth profile.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_an_http_profile_sends_its_token_only_where_the_profile_allows() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let echo = |headers: HeaderMap| async move {
            Json(json!({
                "authorization": headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()),
            }))
        };
        let app = axum::Router::new()
            .route("/v1/users/@me", axum::routing::any(echo))
            .route("/v1/users/@me/guilds", axum::routing::any(echo))
            .route("/v1/channels/1/messages", axum::routing::any(echo));
        let _server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let catalog = |selection| {
            let mut document =
                crate::test_support::mixed_profiles_document(&format!("http://{address}/v1"));
            document["components"]["securitySchemes"]["pat"] = bearer_scheme();
            document["components"]["x-authentication-profiles"]["pat"] =
                json!({"securityScheme": "pat"});
            document["paths"]["/users/@me"]["get"]["security"] =
                json!([{"botToken": []}, {"userOAuth": ["identify"]}, {"pat": []}]);
            crate::catalog::Catalog::from_test_document("mixed", document, selection)
        };
        let security = security().await;
        let mut s = state(Some(security.clone()));
        s.catalog = catalog(json!({"authenticationProfile": "pat"}));
        let owner = Agent::new(76);
        let id = security
            .create_connection(
                "mixed",
                &owner.id(),
                &serde_json::to_vec(&StoredCredential::HttpBearer {
                    scheme: None,
                    provider: "mixed".into(),
                    token: "pat-secret".into(),
                })
                .unwrap(),
            )
            .await
            .unwrap();
        let get = |s: &AppState, path: &str| {
            let request = signed_request(
                s,
                &owner,
                "GET",
                &format!("/proxy/{id}/mixed{path}"),
                vec![],
            );
            let router = crate::router(s.clone());
            async move { router.oneshot(request).await.unwrap() }
        };
        let response = get(&s, "/v1/users/@me").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await["authorization"],
            "Bearer pat-secret"
        );
        for path in ["/v1/users/@me/guilds", "/v1/channels/1/messages"] {
            assert_eq!(
                get(&s, path).await.status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        // Under the user (OAuth) profile the same connection sends nothing.
        let mut user = s.clone();
        user.catalog = catalog(json!({"authenticationProfile": "user"}));
        expect_error(
            get(&user, "/v1/users/@me").await,
            StatusCode::UNAUTHORIZED,
            "credential_refresh_failed",
        )
        .await;
        // Without a profile the mixed document is refused as before.
        let mut unselected = s.clone();
        unselected.catalog = catalog(json!({"httpSecurityScheme": "pat"}));
        expect_error(
            get(&unselected, "/v1/users/@me").await,
            StatusCode::UNAUTHORIZED,
            "credential_refresh_failed",
        )
        .await;
    }

    fn api_key_credential() -> Vec<u8> {
        serde_json::to_vec(&StoredCredential::ApiKey {
            placement: None,
            scheme: None,
            provider: "clockify".into(),
            key: "clockify-secret".into(),
        })
        .unwrap()
    }

    struct Fixture {
        state: AppState,
        security: Security,
        owner: Agent,
        id: String,
        _server: tokio::task::JoinHandle<()>,
    }

    async fn fixture(owner_seed: u8) -> Fixture {
        let security = security().await;
        let (server, catalog) = api_key_upstream().await;
        let mut s = state(Some(security.clone()));
        s.catalog = catalog;
        let owner = Agent::new(owner_seed);
        let id = security
            .create_connection("clockify", &owner.id(), &api_key_credential())
            .await
            .unwrap();
        Fixture {
            state: s,
            security,
            owner,
            id,
            _server: server,
        }
    }

    impl Fixture {
        fn path(&self) -> String {
            format!("/proxy/{}/clockify/workspaces", self.id)
        }
        async fn send(&self, request: axum::http::Request<axum::body::Body>) -> Response {
            crate::router(self.state.clone())
                .oneshot(request)
                .await
                .unwrap()
        }
        async fn get_as(&self, agent: &Agent) -> Response {
            self.send(signed_request(
                &self.state,
                agent,
                "GET",
                &self.path(),
                vec![],
            ))
            .await
        }
        fn claims(&self, app: &Agent, frame: &Agent) -> Claims {
            Claims {
                v: 2,
                connection_id: self.id.clone(),
                platform: "clockify".into(),
                aud: PUBLIC_ORIGIN.into(),
                app: app.id(),
                cnf: frame.id(),
                exp: crate::now_secs() + 600,
            }
        }
        async fn frame_get(&self, token: &str, signer: &Agent) -> Response {
            let mut request = signed_request(&self.state, signer, "GET", &self.path(), vec![]);
            request.headers_mut().insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Capability {token}")).unwrap(),
            );
            self.send(request).await
        }
    }

    async fn expect_error(response: Response, status: StatusCode, code: &str) {
        assert_eq!(response.status(), status, "expected {code}");
        assert_eq!(body_json(response).await["error"], code);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_the_owner_signs_requests_that_reach_the_provider_once_each() {
        let f = fixture(31).await;
        let request = signed_request(&f.state, &f.owner, "GET", &f.path(), vec![]);
        let replay = crate::test_support::clone_request(&request);
        let response = f.send(request).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key("x-connection-code"));
        let body = body_json(response).await;
        assert_eq!(body["x_api_key"], "clockify-secret");
        // The caller's own signature headers never reach the provider.
        assert_eq!(body["signature_forwarded"], false);
        // Nothing rotated: a second, freshly signed request works too.
        assert_eq!(f.get_as(&f.owner).await.status(), StatusCode::OK);
        // The exact same signed request is refused.
        expect_error(f.send(replay).await, StatusCode::UNAUTHORIZED, "replayed").await;
        // A signed POST covers its body.
        let post = signed_request(&f.state, &f.owner, "POST", &f.path(), b"{}".to_vec());
        assert_eq!(f.send(post).await.status(), StatusCode::OK);
    }

    /// atomic-plugins#258: on a platform whose document declares a bot token
    /// and OAuth together, the catalog's profile selection decides which
    /// credential a connection holds and which operations it reaches. A
    /// user's OAuth token goes only to operations the user profile covers,
    /// and to none once the selection no longer resolves to OAuth.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_profile_connection_sends_its_credential_only_where_the_profile_allows() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let echo = |headers: HeaderMap| async move {
            Json(json!({
                "authorization": headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()),
            }))
        };
        let app = axum::Router::new()
            .route("/v1/users/@me", axum::routing::any(echo))
            .route("/v1/users/@me/guilds", axum::routing::any(echo))
            .route("/v1/channels/1/messages", axum::routing::any(echo))
            .route("/v1/public", axum::routing::any(echo));
        let _server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let catalog = |selection| {
            crate::catalog::Catalog::from_test_document(
                "mixed",
                crate::test_support::mixed_profiles_document(&format!("http://{address}/v1")),
                selection,
            )
        };
        let security = security().await;
        let mut s = state(Some(security.clone()));
        s.catalog = catalog(json!({"authenticationProfile": "user"}));
        let owner = Agent::new(48);
        let connect = |credential: StoredCredential| {
            let security = security.clone();
            let owner = owner.id();
            async move {
                security
                    .create_connection("mixed", &owner, &serde_json::to_vec(&credential).unwrap())
                    .await
                    .unwrap()
            }
        };
        let user = connect(StoredCredential::OAuth {
            provider: "mixed".into(),
            access_token: "user-token".into(),
            refresh_token: None,
            expires_at: None,
        })
        .await;
        let bot = connect(StoredCredential::ApiKey {
            placement: None,
            scheme: None,
            provider: "mixed".into(),
            key: "Bot bot-token".into(),
        })
        .await;
        let get = |s: &AppState, id: &str, path: &str| {
            let request = signed_request(
                s,
                &owner,
                "GET",
                &format!("/proxy/{id}/mixed{path}"),
                vec![],
            );
            let router = crate::router(s.clone());
            async move { router.oneshot(request).await.unwrap() }
        };

        // The user profile: its OAuth token on the two operations it covers.
        for path in ["/v1/users/@me", "/v1/users/@me/guilds"] {
            let response = get(&s, &user, path).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(
                body_json(response).await["authorization"],
                "Bearer user-token"
            );
        }
        // Bot-only and anonymous-only operations are not in its catalog.
        for path in ["/v1/channels/1/messages", "/v1/public"] {
            assert_eq!(
                get(&s, &user, path).await.status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }

        // The bot profile: the key as declared, never the user's token.
        let mut bot_state = s.clone();
        bot_state.catalog = catalog(json!({"authenticationProfile": "bot"}));
        let response = get(&bot_state, &bot, "/v1/channels/1/messages").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["authorization"], "Bot bot-token");
        assert_eq!(
            get(&bot_state, &bot, "/v1/users/@me/guilds").await.status(),
            StatusCode::NOT_FOUND
        );
        // An OAuth connection made under the user profile sends nothing once
        // the selection is the bot profile, even on an operation both
        // profiles cover.
        expect_error(
            get(&bot_state, &user, "/v1/users/@me").await,
            StatusCode::UNAUTHORIZED,
            "credential_refresh_failed",
        )
        .await;
        // And without a profile selection the mixed document sends nothing.
        let mut unselected = s.clone();
        unselected.catalog = catalog(json!({"oauthSecurityScheme": "userOAuth"}));
        expect_error(
            get(&unselected, &user, "/v1/users/@me").await,
            StatusCode::UNAUTHORIZED,
            "credential_refresh_failed",
        )
        .await;
        expect_error(
            get(&unselected, &bot, "/v1/users/@me").await,
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
        )
        .await;
    }

    /// A platform whose document requires no security, served under an API
    /// base path the way a static host serves it.
    fn no_credential_catalog(address: std::net::SocketAddr) -> crate::catalog::Catalog {
        crate::catalog::Catalog::from_test_document(
            "pets",
            json!({
                "servers": [{"url": format!("http://{address}/demo/api")}],
                "security": [],
                "paths": {"/pets": {"get": {}}}
            }),
            json!({}),
        )
    }

    /// P1-P3 through the whole route: the provider's rate-limit headers and
    /// `Last-Modified` reach the caller, a caller's `If-None-Match` reaches
    /// the provider, and its `Idempotency-Key` only for the operation whose
    /// catalog entry declares one.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_rate_limit_and_conditional_headers_pass_and_idempotency_keys_only_where_declared(
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let echo = |headers: HeaderMap| async move {
            let one = |name: &str| {
                headers
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned)
            };
            (
                [
                    ("x-ratelimit-remaining", "4999"),
                    ("x-ratelimit-reset", "1791370800"),
                    ("ratelimit", "\"hour\";r=4999;t=3600"),
                    ("last-modified", "Wed, 07 Oct 2026 10:00:00 GMT"),
                    ("x-ratelimit-token", "must-not-pass"),
                ],
                Json(json!({
                    "idempotency_key": one("idempotency-key"),
                    "if_none_match": one("if-none-match"),
                })),
            )
        };
        let app = axum::Router::new()
            .route("/api/items", axum::routing::any(echo))
            .route("/api/other", axum::routing::any(echo));
        let _server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let security = security().await;
        let mut s = state(Some(security.clone()));
        s.catalog = crate::catalog::Catalog::from_test_document(
            "pets",
            json!({
                "servers": [{"url": format!("http://{address}/api")}],
                "security": [],
                "paths": {
                    "/items": {"post": {"parameters": [{"in": "header", "name": "Idempotency-Key"}]}},
                    "/other": {"post": {}}
                }
            }),
            json!({}),
        );
        let connect = |owner: Agent| {
            let security = security.clone();
            async move {
                let id = security
                    .create_connection(
                        "pets",
                        &owner.id(),
                        &serde_json::to_vec(&StoredCredential::NoCredential {
                            provider: "pets".into(),
                        })
                        .unwrap(),
                    )
                    .await
                    .unwrap();
                (owner, id)
            }
        };
        let (owner, id) = connect(Agent::new(39)).await;
        let (other, other_id) = connect(Agent::new(40)).await;
        let post_as = |owner: &Agent, id: &str, path: &str| {
            let mut request = signed_request(
                &s,
                owner,
                "POST",
                &format!("/proxy/{id}/pets/api/{path}"),
                vec![],
            );
            let headers = request.headers_mut();
            headers.insert(IDEMPOTENCY_KEY, HeaderValue::from_static("create-1"));
            headers.insert(header::IF_NONE_MATCH, HeaderValue::from_static("\"v1\""));
            crate::router(s.clone()).oneshot(request)
        };
        let post = |path: &str| post_as(&owner, &id, path);

        let response = post("items").await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers().clone();
        assert_eq!(headers["x-ratelimit-remaining"], "4999");
        assert_eq!(headers["x-ratelimit-reset"], "1791370800");
        assert_eq!(headers["ratelimit"], "\"hour\";r=4999;t=3600");
        assert_eq!(
            headers[header::LAST_MODIFIED],
            "Wed, 07 Oct 2026 10:00:00 GMT"
        );
        assert!(!headers.contains_key("x-ratelimit-token"));
        // Never cached, although it carries Last-Modified.
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        let body = body_json(response).await;
        assert_eq!(body["if_none_match"], "\"v1\"");
        // On a no-credential connection the key is namespaced per
        // connection: stable for a retry, different for another tenant
        // sending the same key, and not the caller's key.
        let sent = body["idempotency_key"].as_str().unwrap().to_owned();
        assert_ne!(sent, "create-1");
        assert_eq!(sent, security.connection_idempotency_key(&id, b"create-1"));
        assert_eq!(sent.len(), 43);
        let again = body_json(post("items").await.unwrap()).await;
        assert_eq!(again["idempotency_key"], sent.as_str());
        let theirs = body_json(post_as(&other, &other_id, "items").await.unwrap()).await;
        let theirs = theirs["idempotency_key"].as_str().unwrap();
        assert_ne!(theirs, sent);
        assert_eq!(
            theirs,
            security.connection_idempotency_key(&other_id, b"create-1")
        );

        let body = body_json(post("other").await.unwrap()).await;
        assert_eq!(body["idempotency_key"], serde_json::Value::Null);
        assert_eq!(body["if_none_match"], "\"v1\"");
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_no_credential_connection_forwards_only_catalog_reads_with_no_credential() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/demo/api/pets",
            axum::routing::any(|headers: HeaderMap| async move {
                (
                    [(header::CONTENT_TYPE, "application/octet-stream")],
                    serde_json::to_string(&json!([{
                        "id": 1,
                        "name": "Rex",
                        "authorization": headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()),
                        "signature_forwarded": headers.contains_key("x-atomic-signature"),
                    }]))
                    .unwrap(),
                )
            }),
        );
        let _server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let security = security().await;
        let mut s = state(Some(security.clone()));
        s.catalog = no_credential_catalog(address);
        let owner = Agent::new(37);
        let id = security
            .create_connection(
                "pets",
                &owner.id(),
                &serde_json::to_vec(&StoredCredential::NoCredential {
                    provider: "pets".into(),
                })
                .unwrap(),
            )
            .await
            .unwrap();
        let send =
            |s: AppState, request| async move { crate::router(s).oneshot(request).await.unwrap() };
        let path = format!("/proxy/{id}/pets/demo/api/pets");

        // Signed by the owner: forwarded with nothing attached, and the
        // provider's bytes come back whatever their content type.
        let response = send(s.clone(), signed_request(&s, &owner, "GET", &path, vec![])).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body[0]["name"], "Rex");
        assert_eq!(body[0]["authorization"], serde_json::Value::Null);
        assert_eq!(body[0]["signature_forwarded"], false);

        // Still not an open relay: unsigned, another method, or another
        // path is refused before anything is sent.
        let unsigned = axum::http::Request::builder()
            .uri(&path)
            .body(axum::body::Body::empty())
            .unwrap();
        expect_error(
            send(s.clone(), unsigned).await,
            StatusCode::UNAUTHORIZED,
            "missing_signature",
        )
        .await;
        let post = signed_request(&s, &owner, "POST", &path, b"{}".to_vec());
        assert_eq!(send(s.clone(), post).await.status(), StatusCode::NOT_FOUND);
        let other = format!("/proxy/{id}/pets/demo/api/owners");
        let other = signed_request(&s, &owner, "GET", &other, vec![]);
        assert_eq!(send(s.clone(), other).await.status(), StatusCode::NOT_FOUND);
        let stranger = signed_request(&s, &Agent::new(38), "GET", &path, vec![]);
        expect_error(
            send(s.clone(), stranger).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;

        // A catalog that has since given the platform a scheme: this
        // connection holds nothing to send, so connect again.
        let changed = crate::catalog::Catalog::from_test_document(
            "pets",
            json!({
                "servers": [{"url": format!("http://{address}/demo/api")}],
                "components": {"securitySchemes": {"petsKey": {
                    "type": "apiKey", "in": "header", "name": "X-Api-Key"
                }}},
                "security": [{"petsKey": []}],
                "paths": {"/pets": {"get": {}}}
            }),
            json!({}),
        );
        let mut s2 = s.clone();
        s2.catalog = changed;
        expect_error(
            send(
                s2.clone(),
                signed_request(&s2, &owner, "GET", &path, vec![]),
            )
            .await,
            StatusCode::UNAUTHORIZED,
            "credential_refresh_failed",
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_each_verification_step_fails_closed() {
        let f = fixture(32).await;
        // No signature at all.
        let unsigned = axum::http::Request::builder()
            .uri(f.path())
            .body(axum::body::Body::empty())
            .unwrap();
        expect_error(
            f.send(unsigned).await,
            StatusCode::UNAUTHORIZED,
            "missing_signature",
        )
        .await;
        // A retired connection code.
        let bearer = axum::http::Request::builder()
            .uri(f.path())
            .header(AUTHORIZATION, "Bearer old-connection-code")
            .body(axum::body::Body::empty())
            .unwrap();
        expect_error(
            f.send(bearer).await,
            StatusCode::UNAUTHORIZED,
            "unsupported_authorization",
        )
        .await;
        // Version 1 header.
        let mut v1 = signed_request(&f.state, &f.owner, "GET", &f.path(), vec![]);
        v1.headers_mut().insert(
            crate::signature::VERSION_HEADER,
            HeaderValue::from_static("1"),
        );
        expect_error(
            f.send(v1).await,
            StatusCode::UNAUTHORIZED,
            "unsupported_signature_version",
        )
        .await;
        // Stale timestamp.
        let stale = crate::test_support::signed_request_at(
            &f.state,
            &f.owner,
            "GET",
            &f.path(),
            vec![],
            crate::now_ms() - crate::signature::MAX_SKEW_MS - 1000,
        );
        expect_error(
            f.send(stale).await,
            StatusCode::UNAUTHORIZED,
            "stale_timestamp",
        )
        .await;
        // Tampered body.
        let mut tampered = signed_request(&f.state, &f.owner, "POST", &f.path(), b"{}".to_vec());
        *tampered.body_mut() = axum::body::Body::from(r#"{"x":1}"#);
        expect_error(
            f.send(tampered).await,
            StatusCode::UNAUTHORIZED,
            "bad_signature",
        )
        .await;
        // A signature over the internal (plain-HTTP) URL instead of BASE_URL.
        let internal = crate::test_support::signed_request_for_url(
            &f.owner,
            "GET",
            &f.path(),
            &format!("http://localhost:8080{}", f.path()),
            vec![],
        );
        expect_error(
            f.send(internal).await,
            StatusCode::UNAUTHORIZED,
            "bad_signature",
        )
        .await;
        // The Host header does not matter: the signed URL is built from BASE_URL.
        let mut spoofed_host = signed_request(&f.state, &f.owner, "GET", &f.path(), vec![]);
        spoofed_host
            .headers_mut()
            .insert(header::HOST, HeaderValue::from_static("evil.example"));
        assert_eq!(f.send(spoofed_host).await.status(), StatusCode::OK);
        // Claiming to be the owner while signing with another key.
        let impostor = Agent::new(33);
        let mut claimed = signed_request(&f.state, &impostor, "GET", &f.path(), vec![]);
        claimed.headers_mut().insert(
            crate::signature::AGENT_HEADER,
            HeaderValue::from_str(&f.owner.id()).unwrap(),
        );
        expect_error(
            f.send(claimed).await,
            StatusCode::UNAUTHORIZED,
            "agent_key_mismatch",
        )
        .await;
        // Someone else's key: no standing on this connection.
        expect_error(
            f.get_as(&impostor).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
        // Wrong platform in the path.
        let wrong_platform = signed_request(
            &f.state,
            &f.owner,
            "GET",
            &format!("/proxy/{}/github-issues/workspaces", f.id),
            vec![],
        );
        expect_error(
            f.send(wrong_platform).await,
            StatusCode::FORBIDDEN,
            "platform_mismatch",
        )
        .await;
        // Unknown connection.
        let unknown = signed_request(
            &f.state,
            &f.owner,
            "GET",
            &format!("/proxy/{}/clockify/workspaces", crate::connect::random()),
            vec![],
        );
        expect_error(
            f.send(unknown).await,
            StatusCode::NOT_FOUND,
            "unknown_connection",
        )
        .await;
        // The legacy spelling of the owner's id is the owner.
        let mut legacy = signed_request(&f.state, &f.owner, "GET", &f.path(), vec![]);
        legacy.headers_mut().insert(
            crate::signature::AGENT_HEADER,
            HeaderValue::from_str(&f.owner.legacy_id()).unwrap(),
        );
        assert_eq!(f.send(legacy).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_delegates_and_runtimes_lose_access_the_moment_they_are_revoked() {
        let f = fixture(34).await;
        let app = Agent::new(35);
        let node = Agent::new(36);
        expect_error(f.get_as(&app).await, StatusCode::FORBIDDEN, "not_delegated").await;
        f.security
            .put_delegation(&f.id, &app.id(), Some("Plugin"))
            .await
            .unwrap();
        assert_eq!(f.get_as(&app).await.status(), StatusCode::OK);
        expect_error(
            f.get_as(&node).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
        f.security
            .put_runtime(&f.owner.id(), &node.id(), &app.id(), Some("server"))
            .await
            .unwrap();
        assert_eq!(f.get_as(&node).await.status(), StatusCode::OK);
        // Revoke the app's delegation: the app and its runtime stop at once.
        f.security
            .delete_delegation(&f.id, &app.id())
            .await
            .unwrap();
        expect_error(f.get_as(&app).await, StatusCode::FORBIDDEN, "not_delegated").await;
        expect_error(
            f.get_as(&node).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
        // Restore, then remove only the runtime.
        f.security
            .put_delegation(&f.id, &app.id(), None)
            .await
            .unwrap();
        f.security
            .delete_runtime(&f.owner.id(), &node.id())
            .await
            .unwrap();
        assert_eq!(f.get_as(&app).await.status(), StatusCode::OK);
        expect_error(
            f.get_as(&node).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
        // Deleting the connection ends everyone's access.
        f.security
            .delete_connection(&f.id, &f.owner.id())
            .await
            .unwrap();
        expect_error(
            f.get_as(&f.owner).await,
            StatusCode::NOT_FOUND,
            "unknown_connection",
        )
        .await;
        expect_error(
            f.get_as(&app).await,
            StatusCode::NOT_FOUND,
            "unknown_connection",
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_the_access_policy_is_asked_about_the_owner_on_every_request() {
        let mut f = fixture(37).await;
        let app = Agent::new(38);
        f.security
            .put_delegation(&f.id, &app.id(), None)
            .await
            .unwrap();
        assert_eq!(f.get_as(&app).await.status(), StatusCode::OK);
        f.state.access = std::sync::Arc::new(crate::access::EnvAccessPolicy::new(
            None,
            vec![f.owner.id()],
        ));
        expect_error(
            f.get_as(&f.owner).await,
            StatusCode::FORBIDDEN,
            "access_denied",
        )
        .await;
        // A delegate is judged by its owner's standing, not its own.
        expect_error(f.get_as(&app).await, StatusCode::FORBIDDEN, "access_denied").await;
        f.state.access = std::sync::Arc::new(crate::access::EnvAccessPolicy::new(
            Some(vec![f.owner.legacy_id()]),
            vec![],
        ));
        assert_eq!(f.get_as(&app).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_frame_capability_works_only_with_the_frame_key_and_a_live_delegation() {
        let f = fixture(39).await;
        let app = Agent::new(40);
        let frame = Agent::new(41);
        let token = mint(&f.owner, &f.claims(&app, &frame));
        // No delegation for the app yet.
        expect_error(
            f.frame_get(&token, &frame).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
        f.security
            .put_delegation(&f.id, &app.id(), None)
            .await
            .unwrap();
        assert_eq!(f.frame_get(&token, &frame).await.status(), StatusCode::OK);
        // The capability is reusable within its lifetime, each request freshly signed.
        assert_eq!(f.frame_get(&token, &frame).await.status(), StatusCode::OK);
        // A copied capability used without the frame's key.
        let thief = Agent::new(42);
        expect_error(
            f.frame_get(&token, &thief).await,
            StatusCode::UNAUTHORIZED,
            "capability_key_mismatch",
        )
        .await;
        // ... or with no request signature at all.
        let bare = axum::http::Request::builder()
            .uri(f.path())
            .header(AUTHORIZATION, format!("Capability {token}"))
            .body(axum::body::Body::empty())
            .unwrap();
        expect_error(
            f.send(bare).await,
            StatusCode::UNAUTHORIZED,
            "missing_signature",
        )
        .await;
        // Replaying one of the frame's signed requests.
        let mut request = signed_request(&f.state, &frame, "GET", &f.path(), vec![]);
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Capability {token}")).unwrap(),
        );
        let replay = crate::test_support::clone_request(&request);
        assert_eq!(f.send(request).await.status(), StatusCode::OK);
        expect_error(f.send(replay).await, StatusCode::UNAUTHORIZED, "replayed").await;
        // The owner key itself cannot stand in for the frame key.
        expect_error(
            f.frame_get(&token, &f.owner).await,
            StatusCode::UNAUTHORIZED,
            "capability_key_mismatch",
        )
        .await;
        // Revoking the delegation stops the capability immediately.
        f.security
            .delete_delegation(&f.id, &app.id())
            .await
            .unwrap();
        expect_error(
            f.frame_get(&token, &frame).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_capability_misuse_is_refused_with_a_specific_reason() {
        let f = fixture(43).await;
        let app = Agent::new(44);
        let frame = Agent::new(45);
        f.security
            .put_delegation(&f.id, &app.id(), None)
            .await
            .unwrap();
        type Edit = Box<dyn Fn(&mut Claims)>;
        let cases: Vec<(Edit, StatusCode, &str)> = vec![
            (
                Box::new(|c| c.aud = "https://other-proxy.example".into()),
                StatusCode::UNAUTHORIZED,
                "wrong_audience",
            ),
            (
                Box::new(|c| c.exp = crate::now_secs() - 1),
                StatusCode::UNAUTHORIZED,
                "capability_expired",
            ),
            (
                Box::new(|c| c.exp = crate::now_secs() + crate::capability::MAX_LIFETIME_SECS + 60),
                StatusCode::UNAUTHORIZED,
                "capability_too_long",
            ),
            (
                Box::new(|c| c.platform = "github-issues".into()),
                StatusCode::FORBIDDEN,
                "capability_scope",
            ),
            (
                Box::new(|c| c.connection_id = crate::connect::random()),
                StatusCode::FORBIDDEN,
                "capability_scope",
            ),
            (
                Box::new(|c| c.app = Agent::new(46).id()),
                StatusCode::FORBIDDEN,
                "not_delegated",
            ),
        ];
        for (edit, status, code) in cases {
            let mut claims = f.claims(&app, &frame);
            edit(&mut claims);
            let token = mint(&f.owner, &claims);
            expect_error(f.frame_get(&token, &frame).await, status, code).await;
        }
        // Minted by someone other than the connection owner (even by the
        // delegated app itself).
        let token = mint(&app, &f.claims(&app, &frame));
        expect_error(
            f.frame_get(&token, &frame).await,
            StatusCode::UNAUTHORIZED,
            "invalid_capability",
        )
        .await;
        // #72's v1 bearer capability is gone.
        let v1 = format!(
            "{}.sig",
            base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                format!(
                    r#"{{"v":1,"connection_id":"{}","platform":"clockify","exp":1}}"#,
                    f.id
                )
            )
        );
        expect_error(
            f.frame_get(&v1, &frame).await,
            StatusCode::UNAUTHORIZED,
            "invalid_capability",
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL and fixture OAuth credentials; CI runs it"]
    async fn postgres_concurrent_requests_refresh_an_expired_token_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let token_requests = std::sync::Arc::new(AtomicUsize::new(0));
        let token_counter = token_requests.clone();
        let upstream = axum::Router::new()
            .route(
                "/token",
                axum::routing::post(move |body: Bytes| {
                    let token_counter = token_counter.clone();
                    async move {
                        token_counter.fetch_add(1, Ordering::SeqCst);
                        assert!(String::from_utf8(body.to_vec())
                            .unwrap()
                            .contains("grant_type=refresh_token"));
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        axum::Json(json!({"access_token": "refreshed-token", "expires_in": 3600, "refresh_token": "rotated-refresh"}))
                    }
                }),
            )
            .route(
                "/items",
                axum::routing::get(|headers: HeaderMap| async move {
                    assert_eq!(headers.get(AUTHORIZATION).unwrap(), "Bearer refreshed-token");
                    (
                        [(header::ETAG, "\"v1\""), (header::LINK, "<https://example/items?page=2>; rel=\"next\"")],
                        axum::Json(json!([{"id": 1}])),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let security = security().await;
        let mut s = state(Some(security.clone()));
        s.catalog = crate::catalog::Catalog::from_test_document(
            "github-issues",
            json!({
                "servers": [{"url": upstream_url}],
                "components": {"securitySchemes": {"oauth": {"type": "oauth2", "flows": {
                    "authorizationCode": {
                        "authorizationUrl": "https://auth.example/authorize",
                        "tokenUrl": "https://auth.example/token",
                        "scopes": {"read": "Read items"}
                    }
                }}}},
                "security": [{"oauth": ["read"]}],
                "paths": {"/items": {"get": {}}}
            }),
            json!({}),
        );
        s.test_upstream = Some(upstream_url);
        let owner = Agent::new(47);
        let credential = serde_json::to_vec(&StoredCredential::OAuth {
            provider: "github-issues".into(),
            access_token: "stale-token".into(),
            refresh_token: Some("a-refresh-token".into()),
            expires_at: Some(0),
        })
        .unwrap();
        let id = security
            .create_connection("github-issues", &owner.id(), &credential)
            .await
            .unwrap();
        let path = format!("/proxy/{id}/github-issues/items");
        let (a, b) = tokio::join!(
            crate::router(s.clone()).oneshot(signed_request(&s, &owner, "GET", &path, vec![])),
            crate::router(s.clone()).oneshot(signed_request(&s, &owner, "GET", &path, vec![])),
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.status(), StatusCode::OK);
        assert_eq!(b.status(), StatusCode::OK);
        assert_eq!(a.headers()[header::ETAG], "\"v1\"");
        assert!(a.headers().get(header::LINK).is_some());
        assert_eq!(token_requests.load(Ordering::SeqCst), 1);
        let stored: StoredCredential = serde_json::from_slice(
            &security
                .load_connection(&id)
                .await
                .unwrap()
                .unwrap()
                .credential,
        )
        .unwrap();
        match stored {
            StoredCredential::OAuth {
                access_token,
                refresh_token,
                ..
            } => {
                assert_eq!(access_token, "refreshed-token");
                assert_eq!(refresh_token.as_deref(), Some("rotated-refresh"));
            }
            _ => panic!("expected an OAuth credential"),
        }
        server.abort();
    }
}
