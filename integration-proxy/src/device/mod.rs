//! Additional Local Thought client authentication (RFC 8628), independent
//! of provider OAuth and of the retired provider connection codes.
pub(crate) mod store;
#[cfg(test)]
mod tests;

use crate::{api_error::ApiError, AppState};
use axum::{
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::{collections::BTreeMap, net::SocketAddr, time::Duration};

pub const DISCOVERY_SCOPE: &str = "connections:read";
pub const READ_SCOPE: &str = "proxy:read";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Public clients have display names fixed by the operator, never provided
/// by the device. The approval URL is a trusted owner hub using the browser
/// module; registering clients requires an explicit approval integration.
#[derive(Clone, Debug, Default)]
pub struct DeviceConfig {
    pub clients: BTreeMap<String, String>,
    pub approval_url: Option<String>,
}
impl DeviceConfig {
    pub(crate) fn from_env() -> Result<Self, String> {
        let clients = match std::env::var("DEVICE_CLIENTS")
            .ok()
            .filter(|s| !s.trim().is_empty())
        {
            Some(value) => serde_json::from_str(&value).map_err(|_| {
                "DEVICE_CLIENTS must be a JSON object mapping public client ids to display names"
            })?,
            None => BTreeMap::new(),
        };
        let config = Self {
            clients,
            approval_url: std::env::var("DEVICE_APPROVAL_URL")
                .ok()
                .filter(|s| !s.trim().is_empty()),
        };
        config.validate()?;
        Ok(config)
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.clients.len() > 20
            || self.clients.iter().any(|(id, name)| {
                id.is_empty()
                    || id.len() > 80
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                    || name.is_empty()
                    || name.chars().count() > 100
                    || name.chars().any(char::is_control)
            })
        {
            return Err("DEVICE_CLIENTS allows at most 20 clients, with 1..80 ASCII id characters and 1..100 display name characters".into());
        }
        if !self.clients.is_empty() {
            let url = self
                .approval_url
                .as_ref()
                .ok_or("DEVICE_APPROVAL_URL is required when device clients are registered")?;
            let parsed = url::Url::parse(url).map_err(|_| {
                "DEVICE_APPROVAL_URL must be an absolute HTTPS URL (loopback HTTP for development)"
            })?;
            let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
            if !(parsed.scheme() == "https" || parsed.scheme() == "http" && loopback)
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err("DEVICE_APPROVAL_URL must be an absolute HTTPS URL without credentials, query or fragment (loopback HTTP for development)".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct Error {
    code: &'static str,
    status: StatusCode,
}
impl Error {
    fn oauth(code: &'static str) -> Self {
        Self {
            code,
            status: StatusCode::BAD_REQUEST,
        }
    }
    fn invalid_token() -> Self {
        Self {
            code: "invalid_token",
            status: StatusCode::UNAUTHORIZED,
        }
    }
    fn limited() -> Self {
        Self {
            code: "temporarily_unavailable",
            status: StatusCode::TOO_MANY_REQUESTS,
        }
    }
}
impl From<tokio_postgres::Error> for Error {
    fn from(_: tokio_postgres::Error) -> Self {
        Self {
            code: "temporarily_unavailable",
            status: StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}
impl From<String> for Error {
    fn from(_: String) -> Self {
        Self {
            code: "temporarily_unavailable",
            status: StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let mut response = protected((self.status, Json(json!({"error":self.code}))));
        if self.status == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "60".parse().unwrap());
        }
        response
    }
}
fn protected(value: impl IntoResponse) -> Response {
    let mut response = value.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::PRAGMA, "no-cache".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
}
fn enabled(state: &AppState) -> Result<&crate::security::Security, Error> {
    if state.device.clients.is_empty() {
        return Err(Error {
            code: "device_auth_disabled",
            status: StatusCode::NOT_FOUND,
        });
    }
    state.security.as_ref().ok_or(Error {
        code: "temporarily_unavailable",
        status: StatusCode::SERVICE_UNAVAILABLE,
    })
}
fn client<'a>(state: &'a AppState, id: &str) -> Result<&'a str, Error> {
    state
        .device
        .clients
        .get(id)
        .map(String::as_str)
        .ok_or(Error::oauth("invalid_client"))
}
pub(crate) fn secret(prefix: &str) -> String {
    format!("{prefix}{}", crate::connect::random())
}
pub(crate) fn hash(value: &str) -> String {
    crate::signature::sha256_hex(value.as_bytes())
}
pub(crate) fn valid_secret(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|s| {
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}
fn user_code(value: &str) -> Result<String, Error> {
    if value.len() > 11 {
        return Err(Error::oauth("invalid_grant"));
    }
    let normalized = value.replace('-', "").to_ascii_uppercase();
    if normalized.len() != 10
        || !normalized
            .bytes()
            .all(|b| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(&b))
    {
        return Err(Error::oauth("invalid_grant"));
    }
    Ok(normalized)
}
fn scopes(value: Option<&str>) -> Result<String, Error> {
    let mut scopes: Vec<&str> = value
        .unwrap_or("connections:read proxy:read")
        .split_ascii_whitespace()
        .collect();
    if scopes.is_empty()
        || scopes
            .iter()
            .any(|s| *s != DISCOVERY_SCOPE && *s != READ_SCOPE)
    {
        return Err(Error::oauth("invalid_scope"));
    }
    scopes.sort_unstable();
    scopes.dedup();
    Ok(scopes.join(" "))
}
fn form(headers: &HeaderMap, body: &[u8]) -> Result<BTreeMap<String, String>, Error> {
    if body.len() > 8192
        || !headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| s.split(';').next() == Some("application/x-www-form-urlencoded"))
    {
        return Err(Error::oauth("invalid_request"));
    }
    let mut fields = BTreeMap::new();
    for (k, v) in url::form_urlencoded::parse(body) {
        if fields.insert(k.into_owned(), v.into_owned()).is_some() {
            return Err(Error::oauth("invalid_request"));
        }
    }
    Ok(fields)
}
fn field<'a>(fields: &'a BTreeMap<String, String>, name: &str) -> Result<&'a str, Error> {
    fields
        .get(name)
        .map(String::as_str)
        .ok_or(Error::oauth("invalid_request"))
}
async fn limit(
    state: &AppState,
    security: &crate::security::Security,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
    action: &str,
    count: u32,
) -> Result<(), Error> {
    let network = crate::client_addr::client_network(state.trust_forwarded_for, headers, peer);
    let bucket = security.key_check_bucket(&format!("device:{action}"), &network);
    if security
        .take_key_check_allowance(&bucket, count, Duration::from_secs(60))
        .await?
        .is_some()
    {
        return Err(Error::limited());
    }
    Ok(())
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/.well-known/oauth-authorization-server", get(discovery))
        .route("/oauth/device/code", post(authorize))
        .route("/oauth/device/token", post(token))
        .route("/oauth/device/revoke", post(revoke))
        .route("/device", get(page))
        .route("/device/approval.mjs", get(approval_module))
        .route("/device/challenge", post(challenge))
        .route("/device/approve", post(approve))
        .route("/device/sessions", get(sessions))
        .route("/device/sessions/:session_id", delete(revoke_session))
        .layer(DefaultBodyLimit::max(8192))
}
async fn discovery(State(state): State<AppState>) -> Response {
    if let Err(e) = enabled(&state) {
        return e.into_response();
    }
    let base = &state.base_url;
    protected(Json(
        json!({"issuer":base,"device_authorization_endpoint":format!("{base}/oauth/device/code"),"token_endpoint":format!("{base}/oauth/device/token"),"revocation_endpoint":format!("{base}/oauth/device/revoke"),"grant_types_supported":[DEVICE_GRANT,"refresh_token"],"token_endpoint_auth_methods_supported":["none"],"revocation_endpoint_auth_methods_supported":["none"],"scopes_supported":[DISCOVERY_SCOPE,READ_SCOPE],"device_approval_challenge_endpoint":format!("{base}/device/challenge"),"device_approval_endpoint":format!("{base}/device/approve")}),
    ))
}
async fn authorize(
    State(state): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let security=enabled(&state)?;
        limit(&state,security,&headers,peer.map(|p|p.0),"code",20).await?;
        let fields=form(&headers,&body)?;
        let id=field(&fields,"client_id")?;client(&state,id)?;
        let scope=scopes(fields.get("scope").map(String::as_str))?;
        let (device,code)=store::create(security,id,&state.base_url,&scope).await?;
        let verification=format!("{}/device",state.base_url);
        let mut complete=url::Url::parse(&verification).map_err(|_|Error::oauth("invalid_request"))?;
        complete.query_pairs_mut().append_pair("user_code",&code);
        Ok::<_,Error>(protected(Json(json!({"device_code":device,"user_code":code,"verification_uri":verification,"verification_uri_complete":complete.as_str(),"expires_in":600,"interval":5}))))
    }.await;
    result.unwrap_or_else(IntoResponse::into_response)
}
async fn token(
    State(state): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let security = enabled(&state)?;
        limit(&state, security, &headers, peer.map(|p| p.0), "token", 120).await?;
        let fields = form(&headers, &body)?;
        let id = field(&fields, "client_id")?;
        client(&state, id)?;
        if fields.contains_key("client_secret") {
            return Err(Error::oauth("invalid_client"));
        }
        let value = match field(&fields, "grant_type")? {
            DEVICE_GRANT => {
                let code = field(&fields, "device_code")?;
                if !valid_secret(code, "lt_device_") {
                    return Err(Error::oauth("invalid_grant"));
                }
                store::poll(security, code, id, &state.base_url).await?
            }
            "refresh_token" => {
                if fields.contains_key("scope") {
                    return Err(Error::oauth("invalid_scope"));
                }
                let refresh = field(&fields, "refresh_token")?;
                if !valid_secret(refresh, "lt_refresh_") {
                    return Err(Error::oauth("invalid_grant"));
                }
                store::refresh(security, refresh, id, &state.base_url).await?
            }
            _ => return Err(Error::oauth("unsupported_grant_type")),
        };
        Ok::<_, Error>(protected(Json(value)))
    }
    .await;
    result.unwrap_or_else(IntoResponse::into_response)
}
async fn revoke(
    State(state): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let security = enabled(&state)?;
        limit(&state, security, &headers, peer.map(|p| p.0), "revoke", 60).await?;
        let fields = form(&headers, &body)?;
        let id = field(&fields, "client_id")?;
        client(&state, id)?;
        let token = field(&fields, "token")?;
        if valid_secret(token, "lt_access_") || valid_secret(token, "lt_refresh_") {
            store::revoke(security, token, id, &state.base_url).await?;
        }
        Ok::<_, Error>(protected(StatusCode::OK))
    }
    .await;
    result.unwrap_or_else(IntoResponse::into_response)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Code {
    user_code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    challenge: String,
    approve: bool,
    connections: Vec<String>,
}
async fn owner(
    state: &AppState,
    method: &Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<crate::AgentId, ApiError> {
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(ApiError::UnsupportedAuthorization);
    }
    let security = state.security.as_ref().ok_or(ApiError::Unavailable)?;
    let owner = crate::signature::authenticate(state, security, method, uri, headers, body).await?;
    crate::check_access(state, &owner).await?;
    Ok(owner)
}
async fn owner_limit(state: &AppState, owner: &crate::AgentId) -> Result<(), Error> {
    let security = enabled(state)?;
    let bucket = security.key_check_bucket("device:owner", owner.as_str());
    if security
        .take_key_check_allowance(&bucket, 20, Duration::from_secs(60))
        .await?
        .is_some()
    {
        return Err(Error::limited());
    }
    Ok(())
}
async fn challenge(
    State(state): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let security = enabled(&state).map_err(IntoResponse::into_response)?;
        limit(
            &state,
            security,
            &headers,
            peer.map(|p| p.0),
            "approval",
            30,
        )
        .await
        .map_err(IntoResponse::into_response)?;
        let owner = owner(&state, &method, &uri, &headers, &body)
            .await
            .map_err(IntoResponse::into_response)?;
        owner_limit(&state, &owner)
            .await
            .map_err(IntoResponse::into_response)?;
        let request: Code = serde_json::from_slice(&body)
            .map_err(|_| Error::oauth("invalid_request").into_response())?;
        let code = user_code(&request.user_code).map_err(IntoResponse::into_response)?;
        let mut value = store::challenge(security, &code, owner.as_str(), &state.base_url)
            .await
            .map_err(IntoResponse::into_response)?;
        let (connections, _) = security
            .list_for_owner(owner.as_str())
            .await
            .map_err(|_| ApiError::Unavailable.into_response())?;
        value["client_name"] = json!(client(
            &state,
            value["client_id"].as_str().unwrap_or_default()
        )
        .map_err(IntoResponse::into_response)?);
        value["owner"] = json!(owner.as_str());
        value["connections"] = json!(connections
            .into_iter()
            .map(|c| json!({"connection_id":c.connection_id,"platform":c.platform,"label":c.label}))
            .collect::<Vec<_>>());
        Ok::<_, Response>(protected(Json(value)))
    }
    .await;
    result.unwrap_or_else(|r| r)
}
async fn approve(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let security = enabled(&state).map_err(IntoResponse::into_response)?;
        let owner = owner(&state, &method, &uri, &headers, &body)
            .await
            .map_err(IntoResponse::into_response)?;
        owner_limit(&state, &owner)
            .await
            .map_err(IntoResponse::into_response)?;
        let request: Approval = serde_json::from_slice(&body)
            .map_err(|_| Error::oauth("invalid_request").into_response())?;
        if !valid_secret(&request.challenge, "lt_approval_")
            || request.connections.len() > 20
            || request.connections.iter().any(|c| c.len() != 43)
        {
            return Err(Error::oauth("invalid_request").into_response());
        }
        store::approve(
            security,
            &request.challenge,
            owner.as_str(),
            &state.base_url,
            &request.connections,
            request.approve,
        )
        .await
        .map_err(IntoResponse::into_response)?;
        Ok::<_, Response>(protected(Json(json!({"approved":request.approve}))))
    }
    .await;
    result.unwrap_or_else(|r| r)
}
async fn sessions(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let security = enabled(&state).map_err(IntoResponse::into_response)?;
        let owner = owner(&state, &method, &uri, &headers, &body)
            .await
            .map_err(IntoResponse::into_response)?;
        Ok::<_, Response>(protected(Json(
            store::sessions(security, owner.as_str(), &state.base_url)
                .await
                .map_err(IntoResponse::into_response)?,
        )))
    }
    .await;
    result.unwrap_or_else(|r| r)
}
async fn revoke_session(
    State(state): State<AppState>,
    Path(session): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let security = enabled(&state).map_err(IntoResponse::into_response)?;
        let owner = owner(&state, &method, &uri, &headers, &body)
            .await
            .map_err(IntoResponse::into_response)?;
        store::revoke_owned(security, owner.as_str(), &session, &state.base_url)
            .await
            .map_err(IntoResponse::into_response)?;
        Ok::<_, Response>(protected(StatusCode::NO_CONTENT))
    }
    .await;
    result.unwrap_or_else(|r| r)
}
async fn page(
    State(state): State<AppState>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Response {
    if let Err(e) = enabled(&state) {
        return e.into_response();
    }
    let code = query
        .get("user_code")
        .and_then(|v| user_code(v).ok())
        .unwrap_or_default();
    let mut url =
        url::Url::parse(state.device.approval_url.as_deref().unwrap_or_default()).unwrap();
    if !code.is_empty() {
        url.query_pairs_mut().append_pair("user_code", &code);
    }
    // URL comes from validated operator configuration; encode HTML context.
    let escaped = url
        .as_str()
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;");
    let mut response=protected(Html(format!("<!doctype html><meta charset=utf-8><title>Approve a CLI connection</title><h1>Approve a CLI connection</h1><p>Continue in your owner hub to authenticate as your existing Atomic owner, review the client, and select connections. Compare the code with the CLI you started. Approve only a login you initiated.</p><p>User code: <strong>{code}</strong></p><a href=\"{escaped}\">Continue to owner approval</a>")));
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
            .parse()
            .unwrap(),
    );
    response
}
async fn approval_module() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        include_str!("../../static/device-approval.mjs"),
    )
        .into_response()
}

/// Recognizes only new, namespaced Local Thought access tokens. A retired
/// Bearer connection code stays unsupported and never falls back to signing.
pub(crate) fn bearer(headers: &HeaderMap) -> Result<Option<&str>, ApiError> {
    if headers.get_all(header::AUTHORIZATION).iter().count() > 1 {
        return Err(ApiError::UnsupportedAuthorization);
    }
    let Some(value) = headers.get(header::AUTHORIZATION) else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| ApiError::UnsupportedAuthorization)?;
    let Some((scheme, token)) = value.split_once(' ') else {
        return Err(ApiError::UnsupportedAuthorization);
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Ok(None);
    }
    if !valid_secret(token, "lt_access_") {
        return Err(ApiError::UnsupportedAuthorization);
    }
    Ok(Some(token))
}
pub(crate) async fn principal(state: &AppState, token: &str) -> Result<store::Principal, ApiError> {
    let security = enabled(state).map_err(|e| {
        if e.status == StatusCode::SERVICE_UNAVAILABLE {
            ApiError::Unavailable
        } else {
            ApiError::InvalidToken
        }
    })?;
    let principal = store::authenticate(security, token, &state.base_url)
        .await
        .map_err(|e| {
            if e.status == StatusCode::SERVICE_UNAVAILABLE {
                ApiError::Unavailable
            } else {
                ApiError::InvalidToken
            }
        })?;
    if !state.device.clients.contains_key(&principal.client_id) {
        return Err(ApiError::InvalidToken);
    }
    crate::check_access(state, &principal.owner).await?;
    Ok(principal)
}

pub(crate) async fn connections(state: &AppState, token: &str) -> Result<Response, ApiError> {
    let principal = principal(state, token).await?;
    if !principal
        .scope
        .split_ascii_whitespace()
        .any(|s| s == DISCOVERY_SCOPE)
    {
        return Err(ApiError::TokenScope);
    }
    let security = state.security.as_ref().ok_or(ApiError::Unavailable)?;
    let (connections, _) = security
        .list_for_owner(principal.owner.as_str())
        .await
        .map_err(|_| ApiError::Unavailable)?;
    let connections:Vec<_>=connections.into_iter().filter(|c|principal.connections.contains(&c.connection_id)).map(|c|json!({"connection_id":c.connection_id,"platform":c.platform,"owner":c.owner,"label":c.label})).collect();
    Ok(protected(Json(
        json!({"owner":principal.owner.as_str(),"client_id":principal.client_id,"session_id":principal.session_id,"connections":connections}),
    )))
}
