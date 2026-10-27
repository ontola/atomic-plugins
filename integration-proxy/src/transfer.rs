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
    crate::check_access(state, &to).await?;
    let moved = security
        .transfer_owner(from.as_str(), to.as_str())
        .await
        .map_err(|error| match error {
            TransferError::Retired => ApiError::AgentRetired,
            TransferError::Blocked => ApiError::TransferBlocked,
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
            .put_delegation(&ids[0], &old.id(), &app.id(), Some("Plugin"))
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

        // (Open webhook subscriptions: webhooks::tests::
        // a_key_transfer_waits_for_the_owners_subscriptions_to_close.)

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

    async fn owned_by_retired(security: &crate::security::Security, ids: &[String]) -> usize {
        let mut count = 0;
        for id in ids {
            let owner = security.load_connection(id).await.unwrap().unwrap().owner;
            if security.is_retired(&owner).await.unwrap() {
                count += 1;
            }
        }
        count
    }

    /// B1 (security review of #551): A→B and B→C on two database
    /// connections at once. They share B's lock, so they run one after the
    /// other: either both apply (everything ends with C) or the second
    /// finds B retired. Never does a connection end up owned by a retired
    /// id. Repeated to give the race a chance.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_concurrent_chained_transfers_never_strand_a_connection() {
        let one = security().await;
        let two = security().await;
        for _ in 0..20 {
            let (a, b, c) = (fresh().id(), fresh().id(), fresh().id());
            let mut ids = Vec::new();
            for owner in [&a, &b] {
                ids.push(
                    one.create_connection("github-issues", owner, b"{}")
                        .await
                        .unwrap(),
                );
            }
            let (first, second) =
                tokio::join!(one.transfer_owner(&a, &b), two.transfer_owner(&b, &c));
            assert!(first.is_ok() || second.is_ok());
            if first.is_err() {
                assert!(matches!(
                    first,
                    Err(crate::security::TransferError::Retired)
                ));
            }
            assert_eq!(owned_by_retired(&one, &ids).await, 0);
        }
    }

    /// B1: a connection created for, a runtime registered by, or a
    /// delegation added by the old owner while its transfer runs either
    /// lands before the move (and moves with it) or is refused as retired.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_owner_writes_racing_a_transfer_are_moved_or_refused() {
        let one = security().await;
        let two = security().await;
        for _ in 0..20 {
            let (old, new, app, node) = (fresh().id(), fresh().id(), fresh().id(), fresh().id());
            let existing = one
                .create_connection("github-issues", &old, b"{}")
                .await
                .unwrap();
            let (moved, created, runtime, delegated) = tokio::join!(
                one.transfer_owner(&old, &new),
                two.create_connection("github-issues", &old, b"{}"),
                two.put_runtime(&old, &node, &app, None),
                two.put_delegation(&existing, &old, &app, None),
            );
            moved.unwrap();
            fn retired<T>(result: &Result<T, String>) -> bool {
                match result {
                    Ok(_) => false,
                    Err(error) => {
                        assert_eq!(error, crate::security::OWNER_RETIRED);
                        true
                    }
                }
            }
            let mut ids = vec![existing.clone()];
            if let Ok(id) = &created {
                ids.push(id.clone());
            }
            retired(&created);
            assert_eq!(owned_by_retired(&one, &ids).await, 0);
            // A runtime either moved to the new owner or was refused.
            if !retired(&runtime) {
                let (_, runtimes) = one.list_for_owner(&new).await.unwrap();
                assert_eq!(runtimes.len(), 1);
            }
            // A delegation either landed before the move or was refused:
            // never on a connection the old id no longer owns.
            if !retired(&delegated) && delegated == Ok(true) {
                assert!(one.is_delegated(&existing, &app).await.unwrap());
            }
            let (left, _) = one.list_for_owner(&old).await.unwrap();
            assert!(left.is_empty());
        }
    }

    /// B2: a connection that still names a retired owner (as a stranded row
    /// would) is refused through `/proxy`, whether the old key signs as
    /// owner or mints a capability for a frame, and the refusal does not
    /// keep it alive.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_retired_owner_cannot_use_a_stranded_connection() {
        let w = world().await;
        assert_eq!(
            send(&w.s, w.transfer(PUBLIC_ORIGIN)).await.status(),
            StatusCode::OK
        );
        w.security
            .force_owner_for_tests(&w.ids[1], &w.old.id())
            .await;
        let path = format!("/proxy/{}/github-issues/records", w.ids[1]);
        expect(
            send(&w.s, signed_request(&w.s, &w.old, "GET", &path, vec![])).await,
            StatusCode::FORBIDDEN,
            "agent_retired",
        )
        .await;
        let frame = fresh();
        w.security
            .force_delegation_for_tests(&w.ids[1], &w.app.id())
            .await;
        let token = crate::capability::mint(
            &w.old,
            &crate::capability::Claims {
                v: 2,
                connection_id: w.ids[1].clone(),
                platform: "github-issues".into(),
                aud: PUBLIC_ORIGIN.into(),
                app: w.app.id(),
                cnf: frame.id(),
                exp: crate::now_secs() + 600,
            },
        );
        let mut request = signed_request(&w.s, &frame, "GET", &path, vec![]);
        request.headers_mut().insert(
            axum::http::header::AUTHORIZATION,
            format!("Capability {token}").parse().unwrap(),
        );
        expect(
            send(&w.s, request).await,
            StatusCode::FORBIDDEN,
            "agent_retired",
        )
        .await;
    }

    /// A database failure inside a transfer answers `503 unavailable` with
    /// the fixed message only: the server's message and SQLSTATE, which can
    /// name tables, columns and values, go to the log, never to the caller.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_database_failure_reaches_the_caller_without_server_detail() {
        let admin = crate::security::tests::admin().await;
        let schema = format!("transfer_fail_{:016x}", rand::random::<u64>());
        admin
            .batch_execute(&format!("CREATE SCHEMA \"{schema}\""))
            .await
            .unwrap();
        let mut url = url::Url::parse(&crate::security::tests::test_database_url()).unwrap();
        url.query_pairs_mut()
            .append_pair("options", &format!("-csearch_path={schema}"));
        let security =
            crate::security::Security::connect(url.as_str(), crate::security::tests::TEST_KEY)
                .await
                .unwrap();
        admin
            .batch_execute(&format!("DROP TABLE \"{schema}\".retired_agents"))
            .await
            .unwrap();
        let s = state(Some(security));
        let (old, new) = (fresh(), fresh());
        let now = unique_now_ms();
        let response = send(
            &s,
            transfer_request(&s, &old, &new, PUBLIC_ORIGIN, now, now),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let body = String::from_utf8_lossy(&body);
        assert!(body.contains("\"unavailable\""), "{body}");
        for detail in ["retired_agents", "42P01", "does not exist", "relation"] {
            assert!(!body.contains(detail), "{detail} in {body}");
        }
        drop(s);
        admin
            .batch_execute(&format!("DROP SCHEMA \"{schema}\" CASCADE"))
            .await
            .unwrap();
    }
}
