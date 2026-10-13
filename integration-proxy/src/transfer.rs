//! Key rotation (ontola/atomic-plugins#410): `POST /agents/transfer` moves
//! everything an owner agent holds at the proxy to a new agent id.
//!
//! The request is Atomic v2 signed by the **old** agent, like every
//! management call, and its body is `{"to": "<new agent id>", "proof":
//! "<signature>"}`. `proof` is the **new** key's Ed25519 signature (base64,
//! either alphabet) over [`proof_message`]:
//!
//! ```text
//! integration-proxy-agent-transfer-v1
//! {old agent, canonical}
//! {new agent, canonical}
//! {proxy origin}
//! {the outer request's x-atomic-timestamp}
//! ```
//!
//! Binding the old id, the proxy origin and the outer request's timestamp
//! means a proof works for one transfer request only: the outer request is
//! accepted once and within five minutes, and a proof made for another
//! timestamp, another proxy or another old key does not verify.
//!
//! In one SQL statement the old agent's connections and runtimes move to
//! the new id, and the old id is recorded as retired. Delegations are keyed
//! by connection and app agent, so they keep working. Afterwards the old id
//! is refused as the signer of management calls and of `/connect/redeem`;
//! capabilities it signed stop verifying at once, because the connections'
//! owner key changed.
//!
//! Scope: planned rotation, where the user still holds the old key. A lost
//! or compromised key is not handled here (SECURITY.md, "Key rotation").

use std::future::Future;
use std::pin::Pin;

use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::{agent_id, api_error::ApiError, security::TransferError, AppState};

const PROOF_LABEL: &str = "integration-proxy-agent-transfer-v1";

/// The message the new key signs for a transfer.
pub fn proof_message(from: &str, to: &str, origin: &str, timestamp: &str) -> String {
    format!("{PROOF_LABEL}\n{from}\n{to}\n{origin}\n{timestamp}")
}

/// Whether an owner still has open webhook subscriptions, which a transfer
/// would orphan (they are keyed by owner). A transfer is refused while it
/// does. Behind a trait so the webhooks store can answer once its query
/// lands; until then [`NoSubscriptions`] answers.
pub trait OpenSubscriptions: Send + Sync + 'static {
    fn has_open<'a>(
        &'a self,
        owner: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<bool, String>> + Send + 'a>>;
}

/// No webhook subscriptions to check: the answer while the webhooks store
/// exposes no owner query.
pub struct NoSubscriptions;

impl OpenSubscriptions for NoSubscriptions {
    fn has_open<'a>(
        &'a self,
        _owner: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<bool, String>> + Send + 'a>> {
        Box::pin(async { Ok(false) })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferBody {
    to: String,
    proof: String,
}

/// `POST /agents/transfer`
pub async fn transfer(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut response = transfer_inner(&state, &method, &uri, &headers, &body)
        .await
        .unwrap_or_else(IntoResponse::into_response);
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    response
}

async fn transfer_inner(
    state: &AppState,
    method: &Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Response, ApiError> {
    let security = state.security.as_ref().ok_or(ApiError::Unavailable)?;
    let from = crate::signature::authenticate(state, security, method, uri, headers, body).await?;
    crate::refuse_retired(security, &from).await?;
    crate::check_access(state, &from).await?;
    let request: TransferBody = serde_json::from_slice(body)
        .map_err(|_| ApiError::BadRequest("body must be {\"to\", \"proof\"}"))?;
    let to = agent_id::parse(&request.to)
        .ok_or(ApiError::BadRequest("to must be an atomic:agent id"))?;
    if to == from {
        return Err(ApiError::BadRequest("to must be another agent"));
    }
    // `authenticate` checked the timestamp is present, well formed and
    // within five minutes.
    let timestamp = headers
        .get(crate::signature::TIMESTAMP_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::MissingSignature)?;
    let message = proof_message(from.as_str(), to.as_str(), &state.public_origin, timestamp);
    if !to.verify(message.as_bytes(), &request.proof) {
        return Err(ApiError::InvalidTransferProof);
    }
    crate::refuse_retired(security, &to).await?;
    crate::check_access(state, &to).await?;
    if state
        .subscriptions
        .has_open(from.as_str())
        .await
        .map_err(|_| ApiError::Unavailable)?
    {
        return Err(ApiError::TransferBlocked);
    }
    let moved = security
        .transfer_owner(from.as_str(), to.as_str())
        .await
        .map_err(|error| match error {
            TransferError::Retired => ApiError::AgentRetired,
            TransferError::Conflict => ApiError::TransferConflict,
            TransferError::Database(error) => {
                tracing::warn!(%error, "agent transfer failed");
                ApiError::Unavailable
            }
        })?;
    tracing::info!(
        connections = moved.connections,
        runtimes = moved.runtimes,
        "agent transferred"
    );
    Ok(Json(serde_json::json!({
        "from": from.as_str(),
        "to": to.as_str(),
        "connections": moved.connections,
        "runtimes": moved.runtimes,
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_id::test_signer::Agent;
    use crate::test_support::{
        body_json, security, signed_request, signed_request_at, state, unique_now_ms, PUBLIC_ORIGIN,
    };
    use axum::http::StatusCode;
    use tower::ServiceExt;

    /// A fresh agent per call. Transfers retire agents for good in the shared
    /// test database, so these tests never use the fixed seeds other tests
    /// share (`Agent::new`).
    fn fresh() -> Agent {
        use sha2::Digest;
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seed: [u8; 32] = sha2::Sha256::digest(format!(
            "transfer-test {} {} {}",
            std::process::id(),
            crate::now_ms(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ))
        .into();
        Agent(ed25519_dalek::SigningKey::from_bytes(&seed))
    }

    fn transfer_request(
        s: &AppState,
        from: &Agent,
        to: &Agent,
        origin: &str,
        proof_timestamp: u64,
        request_timestamp: u64,
    ) -> axum::http::Request<axum::body::Body> {
        let proof = to.sign(
            proof_message(&from.id(), &to.id(), origin, &proof_timestamp.to_string()).as_bytes(),
        );
        let body = serde_json::to_vec(&serde_json::json!({"to": to.id(), "proof": proof})).unwrap();
        signed_request_at(s, from, "POST", "/agents/transfer", body, request_timestamp)
    }

    async fn send(s: &AppState, request: axum::http::Request<axum::body::Body>) -> Response {
        crate::router(s.clone()).oneshot(request).await.unwrap()
    }

    async fn expect(response: Response, status: StatusCode, code: &str) {
        assert_eq!(response.status(), status, "expected {code}");
        assert_eq!(body_json(response).await["error"], code);
    }

    async fn owners(security: &crate::security::Security, ids: &[&str]) -> Vec<String> {
        let mut out = Vec::new();
        for id in ids {
            out.push(security.load_connection(id).await.unwrap().unwrap().owner);
        }
        out
    }

    /// One owner with two connections, one of them delegated to an app,
    /// and a runtime of that app.
    struct World {
        s: AppState,
        security: crate::security::Security,
        old: Agent,
        new: Agent,
        app: Agent,
        node: Agent,
        ids: Vec<String>,
    }

    async fn world() -> World {
        let security = security().await;
        let s = state(Some(security.clone()));
        let (old, new, app, node) = (fresh(), fresh(), fresh(), fresh());
        let mut ids = Vec::new();
        for _ in 0..2 {
            ids.push(
                security
                    .create_connection(
                        "github-issues",
                        &old.id(),
                        &serde_json::to_vec(&crate::proxy::StoredCredential::OAuth {
                            provider: "github-issues".into(),
                            access_token: "token".into(),
                            refresh_token: None,
                            expires_at: None,
                        })
                        .unwrap(),
                    )
                    .await
                    .unwrap(),
            );
        }
        security
            .put_delegation(&ids[0], &app.id(), Some("Plugin"))
            .await
            .unwrap();
        security
            .put_runtime(&old.id(), &node.id(), &app.id(), Some("server"))
            .await
            .unwrap();
        World {
            s,
            security,
            old,
            new,
            app,
            node,
            ids,
        }
    }

    impl World {
        fn transfer(&self, origin: &str) -> axum::http::Request<axum::body::Body> {
            let now = unique_now_ms();
            transfer_request(&self.s, &self.old, &self.new, origin, now, now)
        }
        async fn list_as(&self, agent: &Agent) -> Response {
            send(
                &self.s,
                signed_request(&self.s, agent, "GET", "/connections", vec![]),
            )
            .await
        }
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_transfer_moves_connections_and_runtimes_and_retires_the_old_id() {
        let w = world().await;
        let ids: Vec<&str> = w.ids.iter().map(String::as_str).collect();
        let response = send(&w.s, w.transfer(PUBLIC_ORIGIN)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body = body_json(response).await;
        assert_eq!(body["from"], w.old.id());
        assert_eq!(body["to"], w.new.id());
        assert_eq!(body["connections"], 2);
        assert_eq!(body["runtimes"], 1);
        assert_eq!(
            owners(&w.security, &ids).await,
            vec![w.new.id(), w.new.id()]
        );

        // The new owner sees both connections, the delegation and the runtime.
        let listed = body_json(w.list_as(&w.new).await).await;
        assert_eq!(listed["connections"].as_array().unwrap().len(), 2);
        assert_eq!(listed["runtimes"][0]["agent"], w.node.id());
        let delegated = listed["connections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["connection_id"] == w.ids[0])
            .unwrap();
        assert_eq!(delegated["delegations"][0]["agent"], w.app.id());
        // The app and its runtime still stand towards the moved connection.
        assert!(matches!(
            w.security
                .standing(&w.ids[0], &w.new.id(), &w.app.id())
                .await
                .unwrap(),
            crate::security::Standing::Delegate
        ));
        assert!(matches!(
            w.security
                .standing(&w.ids[0], &w.new.id(), &w.node.id())
                .await
                .unwrap(),
            crate::security::Standing::Runtime { app } if app == w.app.id()
        ));

        // The old id is refused as a management signer, as a redeemer, and
        // as a transferer; its capabilities no longer verify.
        expect(
            w.list_as(&w.old).await,
            StatusCode::FORBIDDEN,
            "agent_retired",
        )
        .await;
        let redeem = signed_request(&w.s, &w.old, "POST", "/connect/redeem", b"{}".to_vec());
        expect(
            send(&w.s, redeem).await,
            StatusCode::FORBIDDEN,
            "agent_retired",
        )
        .await;
        expect(
            send(&w.s, w.transfer(PUBLIC_ORIGIN)).await,
            StatusCode::FORBIDDEN,
            "agent_retired",
        )
        .await;
        let frame = fresh();
        let token = crate::capability::mint(
            &w.old,
            &crate::capability::Claims {
                v: 2,
                connection_id: w.ids[0].clone(),
                platform: "github-issues".into(),
                aud: PUBLIC_ORIGIN.into(),
                app: w.app.id(),
                cnf: frame.id(),
                exp: crate::now_secs() + 600,
            },
        );
        let mut request = signed_request(
            &w.s,
            &frame,
            "GET",
            &format!("/proxy/{}/github-issues/records", w.ids[0]),
            vec![],
        );
        request.headers_mut().insert(
            axum::http::header::AUTHORIZATION,
            format!("Capability {token}").parse().unwrap(),
        );
        expect(
            send(&w.s, request).await,
            StatusCode::UNAUTHORIZED,
            "invalid_capability",
        )
        .await;

        // Nobody can transfer to the retired id either.
        let other = fresh();
        let now = unique_now_ms();
        expect(
            send(
                &w.s,
                transfer_request(&w.s, &other, &w.old, PUBLIC_ORIGIN, now, now),
            )
            .await,
            StatusCode::FORBIDDEN,
            "agent_retired",
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_proof_works_for_one_request_one_proxy_and_one_timestamp() {
        let w = world().await;
        let ids: Vec<&str> = w.ids.iter().map(String::as_str).collect();
        let unchanged =
            || async { owners(&w.security, &ids).await == vec![w.old.id(), w.old.id()] };

        // A proof for another proxy.
        expect(
            send(&w.s, w.transfer("https://other-proxy.example")).await,
            StatusCode::UNAUTHORIZED,
            "invalid_transfer_proof",
        )
        .await;
        // A proof reused from an earlier request: made for another timestamp.
        let earlier = unique_now_ms();
        let later = unique_now_ms();
        expect(
            send(
                &w.s,
                transfer_request(&w.s, &w.old, &w.new, PUBLIC_ORIGIN, earlier, later),
            )
            .await,
            StatusCode::UNAUTHORIZED,
            "invalid_transfer_proof",
        )
        .await;
        // A proof signed by a key other than the new one.
        let now = unique_now_ms();
        let message = proof_message(&w.old.id(), &w.new.id(), PUBLIC_ORIGIN, &now.to_string());
        let body = serde_json::json!({
            "to": w.new.id(),
            "proof": fresh().sign(message.as_bytes()),
        });
        let request = signed_request_at(
            &w.s,
            &w.old,
            "POST",
            "/agents/transfer",
            serde_json::to_vec(&body).unwrap(),
            now,
        );
        expect(
            send(&w.s, request).await,
            StatusCode::UNAUTHORIZED,
            "invalid_transfer_proof",
        )
        .await;
        // A stale outer request, proof and all.
        let stale = crate::now_ms() - 10 * 60 * 1000;
        expect(
            send(
                &w.s,
                transfer_request(&w.s, &w.old, &w.new, PUBLIC_ORIGIN, stale, stale),
            )
            .await,
            StatusCode::UNAUTHORIZED,
            "stale_timestamp",
        )
        .await;
        // To itself.
        let now = unique_now_ms();
        expect(
            send(
                &w.s,
                transfer_request(&w.s, &w.old, &w.old, PUBLIC_ORIGIN, now, now),
            )
            .await,
            StatusCode::BAD_REQUEST,
            "bad_request",
        )
        .await;
        assert!(unchanged().await);

        // A valid request goes through once; the identical request again is
        // a replay.
        let request = w.transfer(PUBLIC_ORIGIN);
        let replay = crate::test_support::clone_request(&request);
        assert_eq!(send(&w.s, request).await.status(), StatusCode::OK);
        expect(
            send(&w.s, replay).await,
            StatusCode::UNAUTHORIZED,
            "replayed",
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_transfer_is_refused_whole_by_access_policy_subscriptions_and_conflicts() {
        let w = world().await;
        let ids: Vec<&str> = w.ids.iter().map(String::as_str).collect();
        let unchanged = || async {
            owners(&w.security, &ids).await == vec![w.old.id(), w.old.id()]
                && !w.security.is_retired(&w.old.id()).await.unwrap()
        };

        // The access policy does not admit the new id.
        let mut closed = w.s.clone();
        closed.access = std::sync::Arc::new(crate::access::EnvAccessPolicy::new(
            Some(vec![w.old.id()]),
            vec![],
        ));
        let now = unique_now_ms();
        expect(
            send(
                &closed,
                transfer_request(&closed, &w.old, &w.new, PUBLIC_ORIGIN, now, now),
            )
            .await,
            StatusCode::FORBIDDEN,
            "access_denied",
        )
        .await;
        assert!(unchanged().await);

        // Open webhook subscriptions block it.
        struct Open;
        impl OpenSubscriptions for Open {
            fn has_open<'a>(
                &'a self,
                _owner: &'a str,
            ) -> Pin<Box<dyn Future<Output = Result<bool, String>> + Send + 'a>> {
                Box::pin(async { Ok(true) })
            }
        }
        let mut blocked = w.s.clone();
        blocked.subscriptions = std::sync::Arc::new(Open);
        let now = unique_now_ms();
        expect(
            send(
                &blocked,
                transfer_request(&blocked, &w.old, &w.new, PUBLIC_ORIGIN, now, now),
            )
            .await,
            StatusCode::CONFLICT,
            "transfer_blocked",
        )
        .await;
        assert!(unchanged().await);

        // The new id already has a runtime for the same node agent: the
        // statement fails and nothing moves, the old id included.
        w.security
            .put_runtime(&w.new.id(), &w.node.id(), &w.app.id(), None)
            .await
            .unwrap();
        expect(
            send(&w.s, w.transfer(PUBLIC_ORIGIN)).await,
            StatusCode::CONFLICT,
            "transfer_conflict",
        )
        .await;
        assert!(unchanged().await);
        assert_eq!(w.list_as(&w.old).await.status(), StatusCode::OK);
    }
}
