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
    InvalidTransferProof,
    // 403: the caller is known but not allowed.
    NotOwner,
    NotDelegated,
    CapabilityScope,
    AccessDenied(String),
    PlatformMismatch,
    /// The signer was retired by a key transfer (#410).
    AgentRetired,
    // 409
    /// The old owner still has open webhook subscriptions.
    TransferBlocked,
    /// The transfer would collide with what the new id already holds.
    TransferConflict,
    // 404
    UnknownConnection,
    // 400
    BadRequest(&'static str),
    InvalidHandoff,
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
            | CredentialRefreshFailed
            | InvalidTransferProof => StatusCode::UNAUTHORIZED,
            NotOwner | NotDelegated | CapabilityScope | AccessDenied(_) | PlatformMismatch
            | AgentRetired => StatusCode::FORBIDDEN,
            TransferBlocked | TransferConflict => StatusCode::CONFLICT,
            UnknownConnection => StatusCode::NOT_FOUND,
            BadRequest(_) | InvalidHandoff => StatusCode::BAD_REQUEST,
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
            InvalidTransferProof => "invalid_transfer_proof",
            AgentRetired => "agent_retired",
            TransferBlocked => "transfer_blocked",
            TransferConflict => "transfer_conflict",
            NotOwner => "not_owner",
            NotDelegated => "not_delegated",
            CapabilityScope => "capability_scope",
            AccessDenied(_) => "access_denied",
            PlatformMismatch => "platform_mismatch",
            UnknownConnection => "unknown_connection",
            BadRequest(_) => "bad_request",
            InvalidHandoff => "invalid_handoff",
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
            InvalidTransferProof => "proof is not the new agent's signature over this transfer (old id, new id, this proxy's origin and this request's timestamp)".into(),
            AgentRetired => "this agent id was transferred to another one and can no longer own connections".into(),
            TransferBlocked => "the agent still has open webhook subscriptions; delete them before transferring".into(),
            TransferConflict => "the new agent already holds something the transfer would move (a runtime with the same agent); nothing was moved".into(),
            NotOwner => "only the connection's owner may do this".into(),
            NotDelegated => "the signing agent has no delegation for this connection".into(),
            CapabilityScope => "the capability is for a different connection or platform".into(),
            AccessDenied(reason) => format!("this agent may not use the proxy: {reason}"),
            PlatformMismatch => "the connection is for a different platform".into(),
            UnknownConnection => "no such connection; it was deleted, expired after 90 idle days, or never existed".into(),
            BadRequest(message) => (*message).into(),
            InvalidHandoff => "invalid or expired connection code".into(),
            Unavailable => "the proxy's database is unavailable".into(),
            Internal => "internal error".into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status(),
            Json(serde_json::json!({"error": self.code(), "message": self.message()})),
        )
            .into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        response
    }
}
