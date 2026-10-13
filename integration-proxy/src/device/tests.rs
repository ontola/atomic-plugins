use super::*;
use crate::{
    agent_id::test_signer::Agent,
    test_support::{self, body_json, signed_request},
};
use axum::{body::Body, http::Request};
use serde_json::Value;
use tower::ServiceExt;

fn config() -> DeviceConfig {
    DeviceConfig {
        clients: [
            ("syncables-cli".into(), "Syncables CLI".into()),
            ("other-cli".into(), "Other CLI".into()),
        ]
        .into(),
        approval_url: Some("http://127.0.0.1:11873".into()),
    }
}
#[test]
fn public_client_config_and_inputs_are_bounded() {
    assert!(config().validate().is_ok());
    let mut bad = config();
    bad.approval_url = None;
    assert!(bad.validate().is_err());
    for url in [
        "http://remote.example/approve",
        "https://u:p@owner.example",
        "https://owner.example/?secret=x",
        "https://owner.example/#fragment",
    ] {
        bad.approval_url = Some(url.into());
        assert!(bad.validate().is_err());
    }
    assert_eq!(user_code("abcde-fghjk").unwrap(), "ABCDEFGHJK");
    for code in ["abcdefghijk", "ABCD0-FGHIJ", "ABC-DEFGHJK---"] {
        assert!(user_code(code).is_err());
    }
    assert_eq!(scopes(None).unwrap(), "connections:read proxy:read");
    assert!(scopes(Some("proxy:write")).is_err());
    assert!(scopes(Some("owner:admin")).is_err());
    assert!(form(&HeaderMap::new(), b"client_id=x").is_err());
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "application/x-www-form-urlencoded".parse().unwrap(),
    );
    assert!(form(&headers, b"client_id=x&client_id=y").is_err());
    let token = secret("lt_access_");
    assert!(valid_secret(&token, "lt_access_"));
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    assert_eq!(bearer(&headers).unwrap(), Some(token.as_str()));
    headers.append(header::AUTHORIZATION, "Bearer retired".parse().unwrap());
    assert!(bearer(&headers).is_err());
}

struct Fixture {
    state: AppState,
    security: crate::security::Security,
    owner: Agent,
    connection: String,
}
impl Fixture {
    async fn new(seed: u8) -> Self {
        let security = test_support::security().await;
        let owner = Agent::new(seed);
        let credential = serde_json::to_vec(&crate::proxy::StoredCredential::HttpBearer {
            provider: "service".into(),
            token: "invented-provider-value".into(),
            scheme: None,
        })
        .unwrap();
        let connection = security
            .create_connection("service", &owner.id(), &credential)
            .await
            .unwrap();
        let mut state = test_support::state(Some(security.clone()));
        state.device = config();
        Self {
            state,
            security,
            owner,
            connection,
        }
    }
    async fn create(&self, scope: &str) -> (String, String) {
        store::create(&self.security, "syncables-cli", &self.state.base_url, scope)
            .await
            .unwrap()
    }
    async fn challenge(&self, code: &str) -> Value {
        store::challenge(
            &self.security,
            &user_code(code).unwrap(),
            &self.owner.id(),
            &self.state.base_url,
        )
        .await
        .unwrap()
    }
    async fn ready(&self, device: &str) {
        self.security
            .client()
            .await
            .execute(
                "UPDATE device_grants SET next_poll=NOW()-INTERVAL '1 second' WHERE device_hash=$1",
                &[&hash(device)],
            )
            .await
            .unwrap();
    }
    async fn grant(&self, scope: &str) -> Value {
        let (device, code) = self.create(scope).await;
        let challenge = self.challenge(&code).await;
        store::approve(
            &self.security,
            challenge["challenge"].as_str().unwrap(),
            &self.owner.id(),
            &self.state.base_url,
            std::slice::from_ref(&self.connection),
            true,
        )
        .await
        .unwrap();
        self.ready(&device).await;
        store::poll(
            &self.security,
            &device,
            "syncables-cli",
            &self.state.base_url,
        )
        .await
        .unwrap()
    }
    async fn send(&self, request: Request<Body>) -> Response {
        crate::router(self.state.clone())
            .oneshot(request)
            .await
            .unwrap()
    }
    fn signed(&self, path: &str, body: Value) -> Request<Body> {
        signed_request(
            &self.state,
            &self.owner,
            "POST",
            path,
            serde_json::to_vec(&body).unwrap(),
        )
    }
    async fn bearer(&self, token: &str, method: &str, path: &str) -> Response {
        self.send(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn polling_handles_pending_slow_down_denial_expiry_and_client_binding() {
    let f = Fixture::new(201).await;
    let (device, code) = f.create("connections:read proxy:read").await;
    let poll = || store::poll(&f.security, &device, "syncables-cli", &f.state.base_url);
    assert_eq!(poll().await.unwrap_err().code, "slow_down");
    let interval: i32 = f
        .security
        .client()
        .await
        .query_one(
            "SELECT interval_secs FROM device_grants WHERE device_hash=$1",
            &[&hash(&device)],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(interval, 10);
    f.ready(&device).await;
    assert_eq!(poll().await.unwrap_err().code, "authorization_pending");
    assert_eq!(
        store::poll(&f.security, &device, "other-cli", &f.state.base_url)
            .await
            .unwrap_err()
            .code,
        "invalid_grant"
    );
    assert_eq!(
        store::poll(
            &f.security,
            &device,
            "syncables-cli",
            "https://another.example"
        )
        .await
        .unwrap_err()
        .code,
        "invalid_grant"
    );
    let challenge = f.challenge(&code).await;
    store::approve(
        &f.security,
        challenge["challenge"].as_str().unwrap(),
        &f.owner.id(),
        &f.state.base_url,
        &[],
        false,
    )
    .await
    .unwrap();
    assert_eq!(poll().await.unwrap_err().code, "access_denied");
    f.security
        .client()
        .await
        .execute(
            "UPDATE device_grants SET expires_at=NOW()-INTERVAL '1 second' WHERE device_hash=$1",
            &[&hash(&device)],
        )
        .await
        .unwrap();
    assert_eq!(poll().await.unwrap_err().code, "expired_token");
    let row = f
        .security
        .client()
        .await
        .query_one(
            "SELECT device_hash,user_hash FROM device_grants WHERE device_hash=$1",
            &[&hash(&device)],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, String>(0).len(), 64);
    assert_eq!(row.get::<_, String>(1).len(), 64);
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn browser_approval_requires_owner_signature_and_exact_challenge_and_selection() {
    let f = Fixture::new(202).await;
    let (_device, code) = f.create("connections:read proxy:read").await;
    let unsigned = Request::builder()
        .method("POST")
        .uri("/device/challenge")
        .body(Body::from(
            json!({"user_code":code,"owner":f.owner.id()}).to_string(),
        ))
        .unwrap();
    let denied = f.send(unsigned).await;
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let response = f
        .send(f.signed("/device/challenge", json!({"user_code":code})))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let challenge = body_json(response).await;
    assert_eq!(challenge["owner"], f.owner.id());
    assert_eq!(challenge["client_name"], "Syncables CLI");
    assert!(challenge["connections"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["connection_id"] == f.connection));
    let another = Agent::new(203);
    let foreign = f
        .security
        .create_connection("service", &another.id(), b"{}")
        .await
        .unwrap();
    let value = json!({"challenge":challenge["challenge"],"approve":true,"connections":[foreign]});
    let response = f.send(f.signed("/device/approve", value)).await;
    assert_eq!(body_json(response).await["error"], "access_denied");
    let value =
        json!({"challenge":challenge["challenge"],"approve":true,"connections":[f.connection]});
    let response = f
        .send(signed_request(
            &f.state,
            &another,
            "POST",
            "/device/approve",
            serde_json::to_vec(&value).unwrap(),
        ))
        .await;
    assert_eq!(body_json(response).await["error"], "invalid_grant");
    let response = f.send(f.signed("/device/approve", value.clone())).await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = f.send(f.signed("/device/approve", value)).await;
    assert_eq!(body_json(response).await["error"], "invalid_grant");
    // Challenge expiry is evaluated against the database clock.
    let (_, code) = f.create("proxy:read").await;
    let challenge = f.challenge(&code).await;
    f.security.client().await.execute("UPDATE device_approval_challenges SET expires_at=NOW()-INTERVAL '1 second' WHERE challenge_hash=$1",&[&hash(challenge["challenge"].as_str().unwrap())]).await.unwrap();
    assert_eq!(
        store::approve(
            &f.security,
            challenge["challenge"].as_str().unwrap(),
            &f.owner.id(),
            &f.state.base_url,
            std::slice::from_ref(&f.connection),
            true
        )
        .await
        .unwrap_err()
        .code,
        "invalid_grant"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn two_instances_approve_and_redeem_a_grant_once() {
    let f = Fixture::new(204).await;
    let other = test_support::security().await;
    let (device, code) = f.create("connections:read proxy:read").await;
    let challenge = f.challenge(&code).await;
    let challenge = challenge["challenge"].as_str().unwrap();
    let selected = vec![f.connection.clone()];
    let owner = f.owner.id();
    let (a, b) = tokio::join!(
        store::approve(
            &f.security,
            challenge,
            &owner,
            &f.state.base_url,
            &selected,
            true
        ),
        store::approve(
            &other,
            challenge,
            &owner,
            &f.state.base_url,
            &selected,
            true
        )
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    f.ready(&device).await;
    let (a, b) = tokio::join!(
        store::poll(&f.security, &device, "syncables-cli", &f.state.base_url),
        store::poll(&other, &device, "syncables-cli", &f.state.base_url)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let winner = a.or(b).unwrap();
    let principal = store::authenticate(
        &other,
        winner["access_token"].as_str().unwrap(),
        &f.state.base_url,
    )
    .await
    .unwrap();
    assert_eq!(principal.owner.as_str(), owner);
    assert_eq!(principal.connections, selected);
    let count: i64 = f
        .security
        .client()
        .await
        .query_one(
            "SELECT COUNT(*) FROM device_sessions WHERE session_id=$1",
            &[&principal.session_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn refresh_rotation_reuse_and_revocation_work_across_instances() {
    let f = Fixture::new(205).await;
    let other = test_support::security().await;
    let first = f.grant("connections:read proxy:read").await;
    let refresh = first["refresh_token"].as_str().unwrap();
    assert_eq!(
        store::refresh(&other, refresh, "other-cli", &f.state.base_url)
            .await
            .unwrap_err()
            .code,
        "invalid_grant"
    );
    let second = store::refresh(&other, refresh, "syncables-cli", &f.state.base_url)
        .await
        .unwrap();
    assert!(store::authenticate(
        &f.security,
        first["access_token"].as_str().unwrap(),
        &f.state.base_url
    )
    .await
    .is_err());
    assert!(store::authenticate(
        &f.security,
        second["access_token"].as_str().unwrap(),
        &f.state.base_url
    )
    .await
    .is_ok());
    assert_eq!(
        store::refresh(&f.security, refresh, "syncables-cli", &f.state.base_url)
            .await
            .unwrap_err()
            .code,
        "invalid_grant"
    );
    assert!(store::authenticate(
        &other,
        second["access_token"].as_str().unwrap(),
        &f.state.base_url
    )
    .await
    .is_err());
    let first = f.grant("proxy:read").await;
    let refresh = first["refresh_token"].as_str().unwrap();
    let (a, b) = tokio::join!(
        store::refresh(&f.security, refresh, "syncables-cli", &f.state.base_url),
        store::refresh(&other, refresh, "syncables-cli", &f.state.base_url)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let winner = a.or(b).unwrap();
    assert!(store::authenticate(
        &f.security,
        winner["access_token"].as_str().unwrap(),
        &f.state.base_url
    )
    .await
    .is_err());
    let first = f.grant("proxy:read").await;
    store::revoke(
        &other,
        first["refresh_token"].as_str().unwrap(),
        "syncables-cli",
        &f.state.base_url,
    )
    .await
    .unwrap();
    assert!(store::authenticate(
        &f.security,
        first["access_token"].as_str().unwrap(),
        &f.state.base_url
    )
    .await
    .is_err());
    assert!(store::refresh(
        &f.security,
        first["refresh_token"].as_str().unwrap(),
        "syncables-cli",
        &f.state.base_url
    )
    .await
    .is_err());
    // Individual owner revocation leaves another session usable.
    let a = f.grant("proxy:read").await;
    let b = f.grant("proxy:read").await;
    store::revoke_owned(
        &other,
        &f.owner.id(),
        a["session_id"].as_str().unwrap(),
        &f.state.base_url,
    )
    .await
    .unwrap();
    assert!(store::authenticate(
        &f.security,
        a["access_token"].as_str().unwrap(),
        &f.state.base_url
    )
    .await
    .is_err());
    assert!(store::authenticate(
        &f.security,
        b["access_token"].as_str().unwrap(),
        &f.state.base_url
    )
    .await
    .is_ok());
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn tokens_are_read_only_connection_scoped_and_never_forwarded_to_the_provider() {
    let mut f = Fixture::new(206).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = Router::new().route(
        "/records",
        axum::routing::any(|headers: HeaderMap| async move {
            assert_eq!(
                headers[header::AUTHORIZATION],
                "Bearer invented-provider-value"
            );
            Json(json!({"records":[{"id":"invented-record"}]}))
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    f.state.catalog = crate::catalog::Catalog::from_test_document(
        "service",
        json!({"servers":[{"url":format!("http://{address}")}],"components":{"securitySchemes":{"auth":{"type":"http","scheme":"bearer"}}},"security":[{"auth":[]}],"paths":{"/records":{"get":{},"post":{},"delete":{}}}}),
        json!({}),
    );
    let grant = f.grant("connections:read proxy:read").await;
    let token = grant["access_token"].as_str().unwrap();
    let response = f.bearer(token, "GET", "/connections").await;
    assert_eq!(response.status(), StatusCode::OK);
    let list = body_json(response).await;
    assert_eq!(list["owner"], f.owner.id());
    assert_eq!(list["connections"].as_array().unwrap().len(), 1);
    assert!(list.get("runtimes").is_none());
    assert!(list["connections"][0].get("delegations").is_none());
    let path = format!("/proxy/{}/service/records", f.connection);
    let response = f.bearer(token, "GET", &path).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_json(response).await.get("records").is_some());
    for method in ["POST", "DELETE", "PATCH", "PUT"] {
        let response = f.bearer(token, method, &path).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(body_json(response).await["error"], "insufficient_scope");
    }
    for (method, path) in [
        ("DELETE", format!("/connections/{}", f.connection)),
        ("POST", format!("/connections/{}/agents", f.connection)),
        ("POST", "/runtimes".into()),
        ("GET", "/device/sessions".into()),
    ] {
        assert_eq!(
            f.bearer(token, method, &path).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let extra = f
        .security
        .create_connection("service", &f.owner.id(), b"{}")
        .await
        .unwrap();
    assert_eq!(
        f.bearer(token, "GET", &format!("/proxy/{extra}/service/records"))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let stranger = Agent::new(207);
    let foreign = f
        .security
        .create_connection("service", &stranger.id(), b"{}")
        .await
        .unwrap();
    assert_eq!(
        f.bearer(token, "GET", &format!("/proxy/{foreign}/service/records"))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let mut revoked_state = f.state.clone();
    revoked_state.access =
        std::sync::Arc::new(crate::EnvAccessPolicy::new(None, vec![f.owner.id()]));
    let response = crate::device::connections(&revoked_state, token)
        .await
        .unwrap_err();
    assert!(matches!(response, ApiError::AccessDenied(_)));
    assert!(
        store::authenticate(&f.security, token, "https://other.example")
            .await
            .is_err()
    );
    // Live connection ownership/expiry is read on every request, independent
    // of the session's original approval snapshot.
    f.security
        .delete_connection(&f.connection, &f.owner.id())
        .await
        .unwrap();
    assert_eq!(
        f.bearer(token, "GET", &path).await.status(),
        StatusCode::NOT_FOUND
    );
    let response = f.bearer(token, "GET", "/connections").await;
    assert_eq!(body_json(response).await["connections"], json!([]));
    server.abort();
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn permissions_expiry_and_unregistered_client_are_enforced() {
    let f = Fixture::new(208).await;
    let discovery = f.grant("connections:read").await;
    let token = discovery["access_token"].as_str().unwrap();
    let principal = store::authenticate(&f.security, token, &f.state.base_url)
        .await
        .unwrap();
    assert!(!store::may_read(&principal, &f.connection, &Method::GET));
    let read = f.grant("proxy:read").await;
    let token = read["access_token"].as_str().unwrap();
    assert_eq!(
        f.bearer(token, "GET", "/connections").await.status(),
        StatusCode::FORBIDDEN
    );
    let mut disabled = f.state.clone();
    disabled.device.clients.remove("syncables-cli");
    assert!(crate::device::principal(&disabled, token).await.is_err());
    f.security.client().await.execute("UPDATE device_access_tokens SET expires_at=NOW()-INTERVAL '1 second' WHERE token_hash=$1",&[&hash(token)]).await.unwrap();
    assert!(store::authenticate(&f.security, token, &f.state.base_url)
        .await
        .is_err());
    f.security
        .client()
        .await
        .execute(
            "UPDATE device_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE session_id=$1",
            &[&read["session_id"].as_str().unwrap()],
        )
        .await
        .unwrap();
    assert_eq!(
        store::refresh(
            &f.security,
            read["refresh_token"].as_str().unwrap(),
            "syncables-cli",
            &f.state.base_url
        )
        .await
        .unwrap_err()
        .code,
        "invalid_grant"
    );
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn discovery_forms_and_brute_force_limits_match_the_public_cli_contract() {
    let f = Fixture::new(209).await;
    let response = f
        .send(
            Request::builder()
                .uri("/.well-known/oauth-authorization-server")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    let metadata = body_json(response).await;
    assert_eq!(metadata["issuer"], f.state.base_url);
    assert_eq!(
        metadata["token_endpoint_auth_methods_supported"],
        json!(["none"])
    );
    // This network bucket is private to this test; untrusted XFF is ignored.
    let request = || {
        Request::builder()
            .method("POST")
            .uri("/oauth/device/code")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .extension(ConnectInfo(
                "192.0.2.209:1234".parse::<SocketAddr>().unwrap(),
            ))
            .body(Body::from(
                "client_id=syncables-cli&scope=connections%3Aread+proxy%3Aread",
            ))
            .unwrap()
    };
    for _ in 0..20 {
        let response = f.send(request()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let grant = body_json(response).await;
        assert_eq!(grant["interval"], 5);
        assert_eq!(grant["expires_in"], 600);
        assert!(grant["verification_uri_complete"]
            .as_str()
            .unwrap()
            .contains("user_code="));
    }
    let response = f.send(request()).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()[header::RETRY_AFTER], "60");
    let response = test_support::router_without_database()
        .oneshot(
            Request::builder()
                .uri("/.well-known/oauth-authorization-server")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
