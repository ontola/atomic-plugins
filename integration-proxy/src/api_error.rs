//! Machine-readable errors for signed API calls: `{"error": <code>,
//! "message": <text>}`. Clients branch on `error` (for example a plugin
//! frame asks its page for a new capability on `capability_expired`); the
//! message is for people and may change.
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    // 401: who is calling could not be established.
    MissingSignature,
    UnsupportedSignatureVersion,
    InvalidAgent,
    AgentKeyMismatch,
    StaleTimestamp,
    BadSignature,
    Replayed,
    InvalidCapability,
    CapabilityExpired,
    CapabilityTooLong,
    WrongAudience,
    CapabilityKeyMismatch,
    UnsupportedAuthorization,
    CredentialRefreshFailed,
    // 403: the caller is known but not allowed.
    NotOwner,
    NotDelegated,
    CapabilityScope,
    AccessDenied(String),
    PlatformMismatch,
    // 404
    UnknownConnection,
    // 400
    BadRequest(&'static str),
    InvalidHandoff,
    // 429: over `PROXY_LIMIT_PER_OWNER_PER_MINUTE`; retry after this long.
    RateLimited(std::time::Duration),
    // 5xx
    Unavailable,
    Internal,
}

impl ApiError {
    pub fn status(&self) -> StatusCode {
        use ApiError::*;
        match self {
            MissingSignature
            | UnsupportedSignatureVersion
            | InvalidAgent
            | AgentKeyMismatch
            | StaleTimestamp
            | BadSignature
            | Replayed
            | InvalidCapability
            | CapabilityExpired
            | CapabilityTooLong
            | WrongAudience
            | CapabilityKeyMismatch
            | UnsupportedAuthorization
            | CredentialRefreshFailed => StatusCode::UNAUTHORIZED,
            NotOwner | NotDelegated | CapabilityScope | AccessDenied(_) | PlatformMismatch => {
                StatusCode::FORBIDDEN
            }
            UnknownConnection => StatusCode::NOT_FOUND,
            BadRequest(_) | InvalidHandoff => StatusCode::BAD_REQUEST,
            RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn code(&self) -> &'static str {
        use ApiError::*;
        match self {
            MissingSignature => "missing_signature",
            UnsupportedSignatureVersion => "unsupported_signature_version",
            InvalidAgent => "invalid_agent",
            AgentKeyMismatch => "agent_key_mismatch",
            StaleTimestamp => "stale_timestamp",
            BadSignature => "bad_signature",
            Replayed => "replayed",
            InvalidCapability => "invalid_capability",
            CapabilityExpired => "capability_expired",
            CapabilityTooLong => "capability_too_long",
            WrongAudience => "wrong_audience",
            CapabilityKeyMismatch => "capability_key_mismatch",
            UnsupportedAuthorization => "unsupported_authorization",
            CredentialRefreshFailed => "credential_refresh_failed",
            NotOwner => "not_owner",
            NotDelegated => "not_delegated",
            CapabilityScope => "capability_scope",
            AccessDenied(_) => "access_denied",
            PlatformMismatch => "platform_mismatch",
            UnknownConnection => "unknown_connection",
            BadRequest(_) => "bad_request",
            InvalidHandoff => "invalid_handoff",
            RateLimited(_) => "rate_limited",
            Unavailable => "unavailable",
            Internal => "internal",
        }
    }

    pub fn message(&self) -> String {
        use ApiError::*;
        match self {
            MissingSignature => "this endpoint requires an Atomic v2 request signature (x-atomic-agent, x-atomic-public-key, x-atomic-timestamp, x-atomic-signature)".into(),
            UnsupportedSignatureVersion => "x-atomic-signature-version must be 2".into(),
            InvalidAgent => "x-atomic-agent or x-atomic-public-key is not a valid atomic:agent id".into(),
            AgentKeyMismatch => "x-atomic-agent is not the agent of x-atomic-public-key".into(),
            StaleTimestamp => "x-atomic-timestamp is missing, malformed, or more than 5 minutes from the proxy's clock".into(),
            BadSignature => "x-atomic-signature does not verify over the atomic-request-v2 message".into(),
            Replayed => "this signed request was already used".into(),
            InvalidCapability => "the capability is malformed or not signed by the connection's owner".into(),
            CapabilityExpired => "the capability has expired; request a new one".into(),
            CapabilityTooLong => "the capability is valid for more than 15 minutes".into(),
            WrongAudience => "the capability is for a different proxy".into(),
            CapabilityKeyMismatch => "the request is not signed by the capability's cnf key".into(),
            UnsupportedAuthorization => "the only Authorization scheme accepted is Capability; connection codes (Bearer) were retired".into(),
            CredentialRefreshFailed => "the provider refused to refresh this connection's token; connect again".into(),
            NotOwner => "only the connection's owner may do this".into(),
            NotDelegated => "the signing agent has no delegation for this connection".into(),
            CapabilityScope => "the capability is for a different connection or platform".into(),
            AccessDenied(reason) => format!("this agent may not use the proxy: {reason}"),
            PlatformMismatch => "the connection is for a different platform".into(),
            UnknownConnection => "no such connection; it was deleted, expired after 90 idle days, or never existed".into(),
            BadRequest(message) => (*message).into(),
            InvalidHandoff => "invalid or expired connection code".into(),
            RateLimited(_) => "this connection's owner made too many proxied requests in the last minute; retry after Retry-After seconds".into(),
            Unavailable => "the proxy's database is unavailable".into(),
            Internal => "internal error".into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let retry_after = match &self {
            ApiError::RateLimited(retry) => Some(retry.as_secs().max(1)),
            _ => None,
        };
        let mut response = (
            self.status(),
            Json(serde_json::json!({"error": self.code(), "message": self.message()})),
        )
            .into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        if let Some(seconds) = retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, seconds.into());
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limited_is_a_429_with_retry_after_in_whole_seconds() {
        for (retry, header) in [(1500, "1"), (40_000, "40"), (0, "1")] {
            let response =
                ApiError::RateLimited(std::time::Duration::from_millis(retry)).into_response();
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(response.headers()[header::RETRY_AFTER], header);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        }
        assert!(!ApiError::NotOwner
            .into_response()
            .headers()
            .contains_key(header::RETRY_AFTER));
    }
}
