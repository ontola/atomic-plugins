//! The webhook routes end to end: signed consumer requests and signed
//! provider deliveries through the real router, against PostgreSQL and a
//! stand-in provider. Ignored without `TEST_DATABASE_URL`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    body::Body,
    extract::{Path, State as AxumState},
    http::{HeaderMap, Request, StatusCode},
    response::IntoResponse,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::{Policy, Store, Webhooks};
use crate::agent_id::test_signer::Agent;
use crate::security::tests::{admin, test_database_url, TEST_KEY};
use crate::security::Security;
use crate::test_support::{body_json, signed_request};
use crate::AppState;

// Invented for these tests; never configured anywhere.
const TRACKER_SECRET: &[u8] = b"fixture-only-tracker-app-secret-not-real-000";
const GITHUB_FIXTURE_SECRET: &[u8] = b"fixture-only-github-app-secret-not-real-0000";

/// What the stand-in provider lets each API key read: key -> source ids.
type Grants = Arc<Mutex<HashMap<String, HashSet<String>>>>;

/// Hook deletions the stand-in provider received: `project/hook`.
static DELETED_HOOKS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn examples() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../openapi-extensions/spec/webhook-deliveries/examples")
}

/// A spec example as a catalog document, served by `address` and needing
/// an API key: generic additions only, the declaration is the example's.
fn document(name: &str, address: std::net::SocketAddr) -> Value {
    let mut document: Value =
        serde_yaml::from_str(&std::fs::read_to_string(examples().join(name)).unwrap()).unwrap();
    document["servers"] = json!([{"url": format!("http://{address}")}]);
    document["components"]["securitySchemes"] =
        json!({"key": {"type": "apiKey", "in": "header", "name": "X-Api-Key"}});
    document["security"] = json!([{"key": []}]);
    document
}

async fn provider(grants: Grants) -> std::net::SocketAddr {
    async fn read(
        AxumState(grants): AxumState<Grants>,
        headers: HeaderMap,
        id: String,
        numeric: Option<u64>,
    ) -> axum::response::Response {
        let key = headers
            .get("x-api-key")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let allowed = grants
            .lock()
            .unwrap()
            .get(&key)
            .is_some_and(|ids| ids.contains(&id));
        if !allowed {
            return StatusCode::NOT_FOUND.into_response();
        }
        match numeric {
            Some(n) => Json(json!({"id": n})).into_response(),
            None => Json(json!({"id": id})).into_response(),
        }
    }
    let app = axum::Router::new()
        .route(
            "/projects/:id",
            axum::routing::get(
                |state: AxumState<Grants>, headers: HeaderMap, Path(id): Path<String>| async move {
                    read(state, headers, id, None).await
                },
            ),
        )
        .route(
            "/projects/:id/webhooks",
            axum::routing::get(|| async {
                // Another receiver's hook, and the one created for ours.
                Json(json!([
                    {"id": "wh-other", "target": "https://elsewhere.example/hook"},
                    {"id": "wh-found", "target": "https://proxy.example/webhooks/fixture-endpoint"}
                ]))
            }),
        )
        .route(
            "/projects/:id/webhooks/:hook",
            axum::routing::delete(|Path((id, hook)): Path<(String, String)>| async move {
                DELETED_HOOKS.lock().unwrap().push(format!("{id}/{hook}"));
                StatusCode::NO_CONTENT
            }),
        )
        .route(
            "/repos/:owner/:repo",
            axum::routing::get(
                |state: AxumState<Grants>,
                 headers: HeaderMap,
                 Path((owner, repo)): Path<(String, String)>| async move {
                    // The synthetic fixture's repository has id 2000002.
                    let id = format!("{owner}/{repo}");
                    read(state, headers, id, Some(2_000_002)).await
                },
            ),
        )
        .with_state(grants);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    address
}

fn small() -> Policy {
    let mut policy = Policy::pilot(1 << 20);
    policy.subscription_max_pending_events = 10;
    policy.subscription_max_pending_bytes = 4096;
    policy.owner_max_pending_bytes = 8192;
    policy.owner_max_pending_references = 15;
    policy.owner_max_live_subscriptions = 3;
    policy.max_verified_bytes = 4096;
    policy.max_body_bytes = 1024;
    policy
}

struct Env {
    state: AppState,
    security: Security,
    store: Arc<Store>,
    grants: Grants,
    schema: String,
    tag: String,
}

async fn env_for(platform: &str, example: &str, secret: &[u8], policy: Policy) -> Env {
    let schema = format!("webhook_routes_{:016x}", rand::random::<u64>());
    admin()
        .await
        .batch_execute(&format!("CREATE SCHEMA \"{schema}\""))
        .await
        .unwrap();
    let tag = format!("routes_{:016x}", rand::random::<u64>());
    let mut url = url::Url::parse(&test_database_url()).unwrap();
    url.query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={schema}"))
        .append_pair("application_name", &tag);
    let security = Security::connect(url.as_str(), TEST_KEY).await.unwrap();
    let store = Arc::new(
        Store::connect(url.as_str(), &security, policy)
            .await
            .unwrap(),
    );
    let grants: Grants = Arc::default();
    let address = provider(grants.clone()).await;
    let mut state = crate::test_support::state(Some(security.clone()));
    state.catalog = crate::catalog::Catalog::from_test_document(
        platform,
        document(example, address),
        json!({}),
    );
    state.webhooks = Some(Arc::new(Webhooks::new(
        store.clone(),
        BTreeMap::from([(platform.to_owned(), secret.to_vec())]),
    )));
    Env {
        state,
        security,
        store,
        grants,
        schema,
        tag,
    }
}

async fn env(policy: Policy) -> Env {
    env_for("tracker", "tracker.yaml", TRACKER_SECRET, policy).await
}

impl Env {
    async fn send(&self, request: Request<Body>) -> axum::response::Response {
        crate::router(self.state.clone())
            .oneshot(request)
            .await
            .unwrap()
    }

    /// A connection for `agent` holding API key `key`, which may read `ids`.
    async fn connection(&self, platform: &str, agent: &Agent, key: &str, ids: &[&str]) -> String {
        self.grants.lock().unwrap().insert(
            key.to_owned(),
            ids.iter().map(|id| (*id).to_owned()).collect(),
        );
        let credential = json!({"kind": "api_key", "provider": platform, "key": key});
        self.security
            .create_connection(
                platform,
                &agent.id(),
                &serde_json::to_vec(&credential).unwrap(),
            )
            .await
            .unwrap()
    }

    async fn subscribe(
        &self,
        agent: &Agent,
        connection: &str,
        source: &str,
        parameters: Value,
        events: Value,
    ) -> axum::response::Response {
        let body = json!({"source": source, "parameters": parameters, "events": events});
        self.send(signed_request(
            &self.state,
            agent,
            "POST",
            &format!("/connections/{connection}/subscriptions"),
            serde_json::to_vec(&body).unwrap(),
        ))
        .await
    }

    async fn subscribe_project(&self, agent: &Agent, connection: &str, project: &str) -> Value {
        let response = self
            .subscribe(
                agent,
                connection,
                "project",
                json!({"projectId": project}),
                json!(["task"]),
            )
            .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        body_json(response).await
    }

    async fn endpoint(&self, platform: &str) -> String {
        self.store
            .ensure_shared_hook(platform, super::store::now())
            .await
            .unwrap()
            .endpoint_id
    }

    fn signed_delivery(&self, endpoint: &str, id: &str, body: &[u8]) -> Request<Body> {
        let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(TRACKER_SECRET).unwrap();
        mac.update(body);
        let signature: String = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Request::post(format!("/webhooks/{endpoint}"))
            .header("Tracker-Delivery", id)
            .header("Tracker-Signature", format!("v1={signature}"))
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_vec()))
            .unwrap()
    }

    async fn deliver(&self, endpoint: &str, id: &str, project: &str) -> StatusCode {
        let body = task(project, "t/1");
        self.send(self.signed_delivery(endpoint, id, &body))
            .await
            .status()
    }

    async fn get(&self, agent: &Agent, path: &str) -> axum::response::Response {
        self.send(signed_request(&self.state, agent, "GET", path, vec![]))
            .await
    }

    async fn post(&self, agent: &Agent, path: &str, body: Value) -> axum::response::Response {
        self.send(signed_request(
            &self.state,
            agent,
            "POST",
            path,
            serde_json::to_vec(&body).unwrap(),
        ))
        .await
    }

    async fn count(&self, query: &str) -> i64 {
        let mut url = url::Url::parse(&test_database_url()).unwrap();
        url.query_pairs_mut()
            .append_pair("options", &format!("-csearch_path={}", self.schema));
        let (client, connection) = tokio_postgres::connect(url.as_str(), tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(connection);
        client.query_one(query, &[]).await.unwrap().get(0)
    }

    async fn drop_schema(self) {
        drop(self.state);
        let _ = admin()
            .await
            .batch_execute(&format!("DROP SCHEMA \"{}\" CASCADE", self.schema))
            .await;
    }
}

fn task(project: &str, task_id: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "kind": "task", "change": "updated",
        "project": {"id": project, "workspace": "w-1"},
        "task": {"id": task_id, "title": "Fixture task"}
    }))
    .unwrap()
}

fn id(subscription: &Value) -> String {
    subscription["id"].as_str().unwrap().to_owned()
}

// --- the whole flow --------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn subscribe_receive_fetch_acknowledge_reconcile() {
    let env = env(small()).await;
    let alice = Agent::new(81);
    let connection = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    let subscription = env.subscribe_project(&alice, &connection, "p-100").await;
    assert_eq!(subscription["state"], "needs-reconciliation");
    assert_eq!(
        subscription["source"],
        json!({"kind": "project", "key": "p-100"})
    );
    let sub = id(&subscription);

    let endpoint = env.endpoint("tracker").await;
    let body = task("p-100", "t/7");
    let response = env.send(env.signed_delivery(&endpoint, "d-1", &body)).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let page = body_json(
        env.get(&alice, &format!("/subscriptions/{sub}/events"))
            .await,
    )
    .await;
    let event = &page["events"][0];
    assert_eq!(event["deliveryId"], "d-1");
    assert_eq!(event["eventType"], "task");
    assert_eq!(event["action"], "updated");
    assert_eq!(
        STANDARD
            .decode(event["payload"]["body"].as_str().unwrap())
            .unwrap(),
        body
    );
    assert!(
        event.get("headers").is_none(),
        "no provider header is passed on"
    );

    let acknowledged = env
        .post(
            &alice,
            &format!("/subscriptions/{sub}/ack"),
            json!({"generation": page["generation"], "cursor": event["cursor"]}),
        )
        .await;
    assert_eq!(acknowledged.status(), StatusCode::OK);
    let reconciliation = &subscription["reconciliationRequired"];
    let done = env
        .post(
            &alice,
            &format!("/subscriptions/{sub}/reconciled"),
            json!({"generation": reconciliation["generation"], "barrier": reconciliation["barrier"]}),
        )
        .await;
    assert_eq!(done.status(), StatusCode::OK);
    assert_eq!(body_json(done).await["state"], "active");
    let renewed = env
        .post(&alice, &format!("/subscriptions/{sub}/renew"), json!({}))
        .await;
    assert_eq!(renewed.status(), StatusCode::OK);
    let deleted = env
        .send(signed_request(
            &env.state,
            &alice,
            "DELETE",
            &format!("/subscriptions/{sub}"),
            vec![],
        ))
        .await;
    assert_eq!(body_json(deleted).await["state"], "closed");
    let gone = env.get(&alice, &format!("/subscriptions/{sub}")).await;
    assert_eq!(gone.status(), StatusCode::GONE);
    assert_eq!(body_json(gone).await["action"], "resubscribe");
    env.drop_schema().await;
}

/// The synthetic GitHub fixtures, replayed through the same generic code:
/// the document is the spec's fixture, the deliveries are its signed files.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn the_synthetic_github_fixtures_pass_through_the_generic_path() {
    let env = env_for(
        "github-fixture",
        "github-fixture.yaml",
        GITHUB_FIXTURE_SECRET,
        Policy::pilot(1 << 30),
    )
    .await;
    let alice = Agent::new(82);
    let connection = env
        .connection(
            "github-fixture",
            &alice,
            "key-g",
            &["fixture-owner/fixture-repo"],
        )
        .await;
    let response = env
        .subscribe(
            &alice,
            &connection,
            "repository",
            json!({"owner": "fixture-owner", "repo": "fixture-repo"}),
            json!(["issues"]),
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let subscription = body_json(response).await;
    assert_eq!(
        subscription["source"]["key"], "2000002",
        "the key comes from the provider's answer"
    );
    let endpoint = env.endpoint("github-fixture").await;
    let replay = |name: &str| {
        let data: Value =
            serde_json::from_str(&std::fs::read_to_string(examples().join(name)).unwrap()).unwrap();
        let mut request = Request::post(format!("/webhooks/{endpoint}"));
        for pair in data["headers"].as_array().unwrap() {
            request = request.header(pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        }
        request
            .body(Body::from(data["body"].as_str().unwrap().to_owned()))
            .unwrap()
    };
    let response = env
        .send(replay("github-deliveries/issues-edited.json"))
        .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let sub = id(&subscription);
    let page = body_json(
        env.get(&alice, &format!("/subscriptions/{sub}/events"))
            .await,
    )
    .await;
    assert_eq!(
        page["events"][0]["deliveryId"],
        "00000000-0000-4000-8000-000000000001"
    );
    assert_eq!(page["events"][0]["action"], "edited");
    // The repository's removal from the installation suspends the binding.
    let response = env
        .send(replay(
            "github-deliveries/installation-repositories-removed.json",
        ))
        .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_subscriptions WHERE suspended")
            .await,
        1
    );
    env.drop_schema().await;
}

// --- isolation and access ----------------------------------------------------------------

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn deliveries_reach_only_subscriptions_with_access_to_their_source() {
    let env = env(small()).await;
    let alice = Agent::new(83);
    let bob = Agent::new(84);
    let ac = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    let bc = env.connection("tracker", &bob, "key-b", &["p-200"]).await;
    let a = id(&env.subscribe_project(&alice, &ac, "p-100").await);
    let b = id(&env.subscribe_project(&bob, &bc, "p-200").await);

    // Bob's key cannot read p-100, so he cannot subscribe to it, and the
    // shared hook does not make him see it.
    let refused = env
        .subscribe(
            &bob,
            &bc,
            "project",
            json!({"projectId": "p-100"}),
            json!(["task"]),
        )
        .await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let endpoint = env.endpoint("tracker").await;
    assert_eq!(
        env.deliver(&endpoint, "d-1", "p-100").await,
        StatusCode::NO_CONTENT
    );
    let alice_page = body_json(env.get(&alice, &format!("/subscriptions/{a}/events")).await).await;
    let bob_page = body_json(env.get(&bob, &format!("/subscriptions/{b}/events")).await).await;
    assert_eq!(alice_page["events"].as_array().unwrap().len(), 1);
    assert_eq!(bob_page["events"].as_array().unwrap().len(), 0);
    // Bob cannot read Alice's subscription, nor use his own connection's
    // id to subscribe as Alice.
    assert_eq!(
        env.get(&bob, &format!("/subscriptions/{a}/events"))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        env.subscribe(
            &bob,
            &ac,
            "project",
            json!({"projectId": "p-100"}),
            json!(["task"])
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    // Access parameters are one path segment each: `../p-100` is sent
    // encoded, as one segment the provider does not know; `..` and a
    // missing parameter are refused before any call.
    let encoded = env
        .subscribe(
            &alice,
            &ac,
            "project",
            json!({"projectId": "../p-100"}),
            json!(["task"]),
        )
        .await;
    assert_eq!(encoded.status(), StatusCode::FORBIDDEN);
    for parameters in [
        json!({"projectId": ".."}),
        json!({"projectId": "."}),
        json!({}),
    ] {
        let response = env
            .subscribe(&alice, &ac, "project", parameters, json!(["task"]))
            .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    // Only declared events of the source kind.
    let response = env
        .subscribe(
            &alice,
            &ac,
            "project",
            json!({"projectId": "p-100"}),
            json!(["unknown"]),
        )
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    env.drop_schema().await;
}

/// A revocation suspends the binding; deliveries meanwhile are not routed;
/// the next fetch re-runs the access check: a failure closes, a pass
/// resumes with an `access-suspended` gap.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_revocation_suspends_until_the_access_check_decides() {
    let env = env(small()).await;
    let alice = Agent::new(85);
    let bob = Agent::new(86);
    let ac = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    let bc = env.connection("tracker", &bob, "key-b", &["p-100"]).await;
    let a = id(&env.subscribe_project(&alice, &ac, "p-100").await);
    let b = id(&env.subscribe_project(&bob, &bc, "p-100").await);
    let endpoint = env.endpoint("tracker").await;
    let revocation = serde_json::to_vec(&json!({
        "kind": "access", "change": "revoked", "projects": [{"id": "p-100"}]
    }))
    .unwrap();
    assert_eq!(
        env.send(env.signed_delivery(&endpoint, "r-1", &revocation))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        env.deliver(&endpoint, "d-1", "p-100").await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_event_refs").await,
        0,
        "nobody suspended gets it"
    );

    // Alice really lost access; Bob did not.
    env.grants
        .lock()
        .unwrap()
        .insert("key-a".into(), HashSet::new());
    let closed = env.get(&alice, &format!("/subscriptions/{a}/events")).await;
    assert_eq!(closed.status(), StatusCode::GONE);
    assert_eq!(body_json(closed).await["gap"]["reason"], "access-denied");
    let resumed = env.get(&bob, &format!("/subscriptions/{b}/events")).await;
    assert_eq!(resumed.status(), StatusCode::OK);
    assert_eq!(
        body_json(resumed).await["reconciliationRequired"]["gap"]["reason"],
        "access-suspended"
    );
    env.drop_schema().await;
}

/// Removing a delegation stops a delegate's reads at once; deleting the
/// connection ends its subscriptions in the same transaction.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn standing_and_connection_deletion_end_subscriptions() {
    let env = env(small()).await;
    let owner = Agent::new(87);
    let app = Agent::new(88);
    let connection = env
        .connection("tracker", &owner, "key-o", &["p-100", "p-200"])
        .await;
    env.security
        .put_delegation(&connection, &app.id(), None)
        .await
        .unwrap();
    let delegated = id(&env.subscribe_project(&app, &connection, "p-100").await);
    let own = id(&env.subscribe_project(&owner, &connection, "p-200").await);
    assert!(env
        .security
        .delete_delegation(&connection, &app.id())
        .await
        .unwrap());
    let refused = env
        .get(&app, &format!("/subscriptions/{delegated}/events"))
        .await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        env.count(
            "SELECT count(*) FROM webhook_subscriptions WHERE closed_reason = 'standing-lost'"
        )
        .await,
        1
    );
    let deleted = env
        .send(signed_request(
            &env.state,
            &owner,
            "DELETE",
            &format!("/connections/{connection}"),
            vec![],
        ))
        .await;
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        env.count(
            "SELECT count(*) FROM webhook_subscriptions WHERE closed_reason = 'connection-deleted'"
        )
        .await,
        1,
        "ended in the deleting transaction, no sweep needed"
    );
    let _ = own;
    env.drop_schema().await;
}

// --- the receiver's refusals -------------------------------------------------------------

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn tampered_reserialized_or_ambiguous_deliveries_are_refused() {
    let env = env(small()).await;
    let alice = Agent::new(89);
    let connection = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    env.subscribe_project(&alice, &connection, "p-100").await;
    let endpoint = env.endpoint("tracker").await;
    let body = task("p-100", "t/1");

    let mut tampered = env.signed_delivery(&endpoint, "d-1", &body);
    *tampered.body_mut() = Body::from(task("p-100", "t/2"));
    assert_eq!(env.send(tampered).await.status(), StatusCode::UNAUTHORIZED);

    let pretty =
        serde_json::to_vec_pretty(&serde_json::from_slice::<Value>(&body).unwrap()).unwrap();
    let mut reserialized = env.signed_delivery(&endpoint, "d-1", &body);
    *reserialized.body_mut() = Body::from(pretty);
    assert_eq!(
        env.send(reserialized).await.status(),
        StatusCode::UNAUTHORIZED
    );

    let mut repeated = env.signed_delivery(&endpoint, "d-1", &body);
    let signature = repeated.headers()["tracker-signature"].clone();
    repeated
        .headers_mut()
        .append("tracker-signature", signature);
    assert_eq!(env.send(repeated).await.status(), StatusCode::UNAUTHORIZED);

    let mut two_ids = env.signed_delivery(&endpoint, "d-1", &body);
    two_ids
        .headers_mut()
        .append("tracker-delivery", "d-2".parse().unwrap());
    assert_eq!(env.send(two_ids).await.status(), StatusCode::BAD_REQUEST);

    let unknown = env.signed_delivery(&"x".repeat(43), "d-1", &body);
    assert_eq!(env.send(unknown).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_receipts").await,
        0,
        "a refusal writes nothing"
    );
    assert_eq!(env.count("SELECT count(*) FROM webhook_payloads").await, 0);

    // A platform without a configured secret refuses every delivery.
    let mut unconfigured = env.state.clone();
    unconfigured.webhooks = Some(Arc::new(Webhooks::new(env.store.clone(), BTreeMap::new())));
    let response = crate::router(unconfigured)
        .oneshot(env.signed_delivery(&endpoint, "d-1", &body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    env.drop_schema().await;
}

/// Over the verification cap: refused unread. Between the retention and
/// the verification cap: routed, recorded as an `oversized-delivery` gap.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn oversized_deliveries() {
    let env = env(small()).await;
    let alice = Agent::new(90);
    let connection = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    let sub = id(&env.subscribe_project(&alice, &connection, "p-100").await);
    let endpoint = env.endpoint("tracker").await;
    let padded = |size: usize| {
        let mut value: Value = serde_json::from_slice(&task("p-100", "t/1")).unwrap();
        value["pad"] = json!("x".repeat(size));
        serde_json::to_vec(&value).unwrap()
    };
    let huge = padded(5000);
    assert_eq!(
        env.send(env.signed_delivery(&endpoint, "big", &huge))
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(env.count("SELECT count(*) FROM webhook_receipts").await, 0);
    let large = padded(2000);
    assert_eq!(
        env.send(env.signed_delivery(&endpoint, "large", &large))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let page = body_json(
        env.get(&alice, &format!("/subscriptions/{sub}/events"))
            .await,
    )
    .await;
    assert_eq!(page["events"].as_array().unwrap().len(), 0);
    assert_eq!(
        page["reconciliationRequired"]["gap"]["reason"],
        "oversized-delivery"
    );
    env.drop_schema().await;
}

/// The database fails before the delivery commits: no 2xx, nothing kept,
/// and the provider's retry is accepted as new.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_database_failure_before_commit_is_never_acknowledged() {
    let env = env(small()).await;
    let alice = Agent::new(91);
    let connection = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    env.subscribe_project(&alice, &connection, "p-100").await;
    let endpoint = env.endpoint("tracker").await;
    env.store
        .fail_before_commit
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        env.deliver(&endpoint, "d-1", "p-100").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    env.store
        .fail_before_commit
        .store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(env.count("SELECT count(*) FROM webhook_receipts").await, 0);
    assert_eq!(
        env.deliver(&endpoint, "d-1", "p-100").await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_event_refs").await,
        1
    );
    // The connection is killed while the delivery waits for a lock.
    let admin = admin().await;
    let mut url = url::Url::parse(&test_database_url()).unwrap();
    url.query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={}", env.schema));
    let (mut blocker, driver) = tokio_postgres::connect(url.as_str(), tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(driver);
    let lock = blocker.transaction().await.unwrap();
    lock.batch_execute("LOCK TABLE webhook_deployment_usage IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let state = env.state.clone();
    let request = env.signed_delivery(&endpoint, "d-2", &task("p-100", "t/2"));
    let pending = tokio::spawn(async move { crate::router(state).oneshot(request).await.unwrap() });
    let mut terminated = 0;
    for _ in 0..100 {
        terminated = admin
            .execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE application_name = $1 AND wait_event_type = 'Lock'",
                &[&env.tag],
            )
            .await
            .unwrap();
        if terminated > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(terminated > 0);
    assert_eq!(
        pending.await.unwrap().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    lock.rollback().await.unwrap();
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_event_refs").await,
        1
    );
    assert_eq!(
        env.deliver(&endpoint, "d-2", "p-100").await,
        StatusCode::NO_CONTENT
    );
    env.drop_schema().await;
}

// --- consumption -------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_long_poll_wakes_when_a_delivery_is_stored() {
    let env = env(small()).await;
    let alice = Agent::new(92);
    let connection = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    let subscription = env.subscribe_project(&alice, &connection, "p-100").await;
    let sub = id(&subscription);
    let reconciliation = &subscription["reconciliationRequired"];
    env.post(
        &alice,
        &format!("/subscriptions/{sub}/reconciled"),
        json!({"generation": reconciliation["generation"], "barrier": reconciliation["barrier"]}),
    )
    .await;
    let endpoint = env.endpoint("tracker").await;
    let request = signed_request(
        &env.state,
        &alice,
        "GET",
        &format!("/subscriptions/{sub}/events?wait=20"),
        vec![],
    );
    let state = env.state.clone();
    let started = std::time::Instant::now();
    let poll = tokio::spawn(async move { crate::router(state).oneshot(request).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!poll.is_finished(), "it waits while there is nothing");
    assert_eq!(
        env.deliver(&endpoint, "d-1", "p-100").await,
        StatusCode::NO_CONTENT
    );
    let page = body_json(poll.await.unwrap()).await;
    assert_eq!(page["events"].as_array().unwrap().len(), 1);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "woken, not timed out"
    );
    env.drop_schema().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn forged_future_and_obsolete_cursors_are_refused_on_the_routes() {
    let env = env(small()).await;
    let alice = Agent::new(93);
    let connection = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    let sub = id(&env.subscribe_project(&alice, &connection, "p-100").await);
    let endpoint = env.endpoint("tracker").await;
    for n in 0..3 {
        env.deliver(&endpoint, &format!("d-{n}"), "p-100").await;
    }
    let page = body_json(
        env.get(&alice, &format!("/subscriptions/{sub}/events?limit=1"))
            .await,
    )
    .await;
    let cursor = page["events"][0]["cursor"].as_str().unwrap().to_owned();
    let key =
        super::cursor::CursorKey::new(env.security.derive_subkey(super::cursor::SUBKEY_LABEL));
    let cases = [
        (
            json!({"generation": "g1", "cursor": super::cursor::CursorKey::new([3; 32]).encode(&sub, 1, 1)}),
            "cursor-not-issued",
        ),
        (
            json!({"generation": "g1", "cursor": key.encode(&sub, 1, 3)}),
            "cursor-ahead",
        ),
        (
            json!({"generation": "g1", "cursor": key.encode(&sub, 9, 1)}),
            "obsolete-generation",
        ),
        (
            json!({"generation": "g2", "cursor": cursor}),
            "obsolete-generation",
        ),
    ];
    for (body, code) in cases {
        let response = env
            .post(&alice, &format!("/subscriptions/{sub}/ack"), body)
            .await;
        assert_eq!(response.status(), StatusCode::CONFLICT, "{code}");
        assert_eq!(body_json(response).await["code"], code);
    }
    let response = env
        .get(
            &alice,
            &format!(
                "/subscriptions/{sub}/events?after={}",
                key.encode(&sub, 1, 3)
            ),
        )
        .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    env.drop_schema().await;
}

/// Concurrent signed subscriptions stop exactly at the owner's quota.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn concurrent_subscriptions_through_the_routes_stop_at_the_quota() {
    let env = env(small()).await;
    let alice = Agent::new(94);
    let projects: Vec<String> = (0..10).map(|n| format!("p-{n}")).collect();
    let ids: Vec<&str> = projects.iter().map(String::as_str).collect();
    let connection = env.connection("tracker", &alice, "key-a", &ids).await;
    let mut tasks = tokio::task::JoinSet::new();
    for project in &projects {
        let body =
            json!({"source": "project", "parameters": {"projectId": project}, "events": ["task"]});
        let request = signed_request(
            &env.state,
            &alice,
            "POST",
            &format!("/connections/{connection}/subscriptions"),
            serde_json::to_vec(&body).unwrap(),
        );
        let state = env.state.clone();
        tasks.spawn(async move {
            crate::router(state)
                .oneshot(request)
                .await
                .unwrap()
                .status()
        });
    }
    let mut created = 0;
    while let Some(status) = tasks.join_next().await {
        match status.unwrap() {
            StatusCode::CREATED => created += 1,
            StatusCode::TOO_MANY_REQUESTS => {}
            other => panic!("{other}"),
        }
    }
    assert_eq!(created, 3);
    env.drop_schema().await;
}

/// With the inbox off, none of the routes exists.
#[tokio::test]
async fn no_webhook_route_exists_when_disabled() {
    let router = crate::test_support::router_without_database();
    for (method, path) in [
        (
            "POST",
            "/webhooks/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
        ("GET", "/subscriptions/x"),
        ("POST", "/subscriptions/x/ack"),
        ("POST", "/connections/x/subscriptions"),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            matches!(
                response.status(),
                StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
            ),
            "{method} {path}: {}",
            response.status()
        );
    }
}

/// A dedicated hook's cleanup re-runs the managing connection's access
/// check with the hook's recorded parameters, requires the bound key, and
/// only then sends the allowlisted delete.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn hook_cleanup_rechecks_access_before_deleting() {
    use super::cleanup::HookDeleter as _;
    use super::provider::ProviderHookDeleter;
    let env = env(small()).await;
    let alice = Agent::new(95);
    let connection = env
        .connection("tracker", &alice, "key-del", &["p-del", "p-moved"])
        .await;
    let deleter = ProviderHookDeleter {
        state: env.state.clone(),
    };
    let hook = |key: &str, provider: &str| super::store::HookToDelete {
        hook_id: "fixture-hook".into(),
        endpoint_id: "fixture-endpoint".into(),
        platform: "tracker".into(),
        source_kind: "project".into(),
        source_key: key.into(),
        access_parameters: serde_json::to_string(&json!({"projectId": key})).unwrap(),
        provider_hook_id: Some(provider.into()),
        management_connection_id: Some(connection.clone()),
    };
    deleter.delete(&hook("p-del", "wh-1")).await.unwrap();
    assert!(DELETED_HOOKS
        .lock()
        .unwrap()
        .contains(&"p-del/wh-1".to_owned()));

    // Provisioning ended before the provider's answer: the hook is found by
    // its endpoint URL in the declared list, and only that one is deleted.
    let mut unanswered = hook("p-del", "unused");
    unanswered.provider_hook_id = None;
    deleter.delete(&unanswered).await.unwrap();
    let deleted = DELETED_HOOKS.lock().unwrap().clone();
    assert!(deleted.contains(&"p-del/wh-found".to_owned()));
    assert!(!deleted.iter().any(|d| d.ends_with("wh-other")));
    // Not listed: nothing was created, nothing to delete.
    let mut never = hook("p-del", "unused");
    never.provider_hook_id = None;
    never.endpoint_id = "never-created".into();
    deleter.delete(&never).await.unwrap();

    // The source answers with another key now (renamed, name reused): no
    // delete is sent.
    let mut moved = hook("p-moved", "wh-2");
    moved.source_key = "p-other".into();
    assert_eq!(
        deleter.delete(&moved).await,
        Err(super::cleanup::CleanupError::Permanent(
            "access-check-failed"
        ))
    );
    // Access lost: no delete either.
    env.grants
        .lock()
        .unwrap()
        .insert("key-del".into(), HashSet::new());
    assert_eq!(
        deleter.delete(&hook("p-del", "wh-3")).await,
        Err(super::cleanup::CleanupError::Permanent(
            "access-check-failed"
        ))
    );
    let mut orphan = hook("p-del", "wh-4");
    orphan.management_connection_id = None;
    assert_eq!(
        deleter.delete(&orphan).await,
        Err(super::cleanup::CleanupError::Permanent(
            "no-managing-connection"
        ))
    );
    let deleted = DELETED_HOOKS.lock().unwrap().clone();
    assert!(!deleted
        .iter()
        .any(|d| d.ends_with("wh-2") || d.ends_with("wh-3") || d.ends_with("wh-4")));
    env.drop_schema().await;
}

// --- review of #394 --------------------------------------------------------------------

/// A request body that never arrives.
fn never_ending() -> Body {
    Body::from_stream(futures_util::stream::pending::<
        Result<axum::body::Bytes, std::io::Error>,
    >())
}

/// The webhooks state with another ingress gate.
fn with_gate(env: &Env, change: impl FnOnce(&mut super::IngressGate)) -> AppState {
    let mut webhooks = Webhooks::new(
        env.store.clone(),
        BTreeMap::from([("tracker".to_owned(), TRACKER_SECRET.to_vec())]),
    );
    change(&mut webhooks.gate);
    let mut state = env.state.clone();
    state.webhooks = Some(Arc::new(webhooks));
    state
}

/// B1: nothing is read before the endpoint is known and the declared
/// length fits; a body is read only within a timeout and by a bounded
/// number of requests at once.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn ingress_reads_no_body_before_its_checks_and_bounds_what_it_reads() {
    let env = env(small()).await;
    let alice = Agent::new(99);
    let connection = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    env.subscribe_project(&alice, &connection, "p-100").await;
    let endpoint = env.endpoint("tracker").await;
    let quick = Duration::from_secs(2);

    // Unknown or malformed endpoints answer without reading the body.
    for path in [
        format!("/webhooks/{}", "A".repeat(43)),
        "/webhooks/short".into(),
        format!("/webhooks/{}", "!".repeat(43)),
    ] {
        let request = Request::post(path).body(never_ending()).unwrap();
        let response = tokio::time::timeout(quick, env.send(request))
            .await
            .expect("answered without reading");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    // A declared length over the cap: 413 at once.
    let request = Request::post(format!("/webhooks/{endpoint}"))
        .header("content-length", "30000000")
        .body(never_ending())
        .unwrap();
    let response = tokio::time::timeout(quick, env.send(request))
        .await
        .expect("answered at once");
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    // An undeclared length over the cap: refused once the cap is passed.
    let chunks = futures_util::stream::iter(
        (0..10).map(|_| Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![b'x'; 1000]))),
    );
    let request = Request::post(format!("/webhooks/{endpoint}"))
        .body(Body::from_stream(chunks))
        .unwrap();
    assert_eq!(
        env.send(request).await.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );

    // A slow upload is cut off by the read timeout.
    let state = with_gate(&env, |gate| gate.read_timeout = Duration::from_millis(300));
    let request = Request::post(format!("/webhooks/{endpoint}"))
        .body(never_ending())
        .unwrap();
    let response = tokio::time::timeout(quick, crate::router(state).oneshot(request))
        .await
        .expect("timed out by the gate")
        .unwrap();
    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);

    // With every read slot taken by slow uploads, the next one is refused
    // after a short wait instead of being buffered.
    let state = with_gate(&env, |gate| {
        gate.reads = tokio::sync::Semaphore::new(1);
        gate.wait = Duration::from_millis(200);
    });
    let slow = {
        let state = state.clone();
        let request = Request::post(format!("/webhooks/{endpoint}"))
            .body(never_ending())
            .unwrap();
        tokio::spawn(async move { crate::router(state).oneshot(request).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let request = env.signed_delivery(&endpoint, "d-1", &task("p-100", "t/1"));
    let response = crate::router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    slow.abort();
    assert_eq!(env.count("SELECT count(*) FROM webhook_receipts").await, 0);
    env.drop_schema().await;
}

/// B1: with every inbox connection busy, requests fail after a bounded
/// wait instead of queueing without end.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_busy_inbox_pool_answers_503_after_a_bounded_wait() {
    let env = env(small()).await;
    let alice = Agent::new(100);
    let connection = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    let sub = id(&env.subscribe_project(&alice, &connection, "p-100").await);
    let endpoint = env.endpoint("tracker").await;
    let held = [
        env.store.hold_connection().await,
        env.store.hold_connection().await,
        env.store.hold_connection().await,
        env.store.hold_connection().await,
    ];
    let started = std::time::Instant::now();
    let response = env.get(&alice, &format!("/subscriptions/{sub}")).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let response = env
        .send(env.signed_delivery(&endpoint, "d-1", &task("p-100", "t/1")))
        .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(started.elapsed() < Duration::from_secs(15));
    drop(held);
    assert_eq!(
        env.deliver(&endpoint, "d-1", "p-100").await,
        StatusCode::NO_CONTENT
    );
    env.drop_schema().await;
}

/// N1: a long poll is woken by its own subscription's deliveries only, and
/// waiting polls are capped per consumer.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn long_polls_wake_per_subscription_and_are_capped() {
    let env = env(small()).await;
    let alice = Agent::new(101);
    let connection = env
        .connection("tracker", &alice, "key-a", &["p-1", "p-2"])
        .await;
    let mut ids = Vec::new();
    for project in ["p-1", "p-2"] {
        let subscription = env.subscribe_project(&alice, &connection, project).await;
        let reconciliation = &subscription["reconciliationRequired"];
        let sub = id(&subscription);
        env.post(
            &alice,
            &format!("/subscriptions/{sub}/reconciled"),
            json!({"generation": reconciliation["generation"], "barrier": reconciliation["barrier"]}),
        )
        .await;
        ids.push(sub);
    }
    let endpoint = env.endpoint("tracker").await;
    let poll = |sub: &str| {
        let request = signed_request(
            &env.state,
            &alice,
            "GET",
            &format!("/subscriptions/{sub}/events?wait=20"),
            vec![],
        );
        let state = env.state.clone();
        tokio::spawn(async move { crate::router(state).oneshot(request).await.unwrap() })
    };
    let first = poll(&ids[0]);
    tokio::time::sleep(Duration::from_millis(300)).await;
    // A delivery to the other subscription does not wake it.
    assert_eq!(
        env.deliver(&endpoint, "d-2", "p-2").await,
        StatusCode::NO_CONTENT
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!first.is_finished());
    assert_eq!(
        env.deliver(&endpoint, "d-1", "p-1").await,
        StatusCode::NO_CONTENT
    );
    let page = body_json(
        tokio::time::timeout(Duration::from_secs(5), first)
            .await
            .unwrap()
            .unwrap(),
    )
    .await;
    assert_eq!(page["events"][0]["deliveryId"], "d-1");
    // Acknowledged, so the next polls have nothing and wait.
    let acknowledged = env
        .post(
            &alice,
            &format!("/subscriptions/{}/ack", ids[0]),
            json!({"generation": page["generation"], "cursor": page["events"][0]["cursor"]}),
        )
        .await;
    assert_eq!(acknowledged.status(), StatusCode::OK);

    // Four waiting polls of one consumer; a fifth is told to retry.
    let waiting: Vec<_> = (0..4).map(|_| poll(&ids[0])).collect();
    let waiters =
        |webhooks: &Webhooks| -> usize { webhooks.waiting.lock().unwrap().values().sum() };
    let webhooks = env.state.webhooks.clone().unwrap();
    eventually("four polls waiting", || waiters(&webhooks) == 4).await;
    let started = std::time::Instant::now();
    let extra = poll(&ids[0]).await.unwrap();
    assert_eq!(extra.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(extra.headers().contains_key("retry-after"));
    assert!(started.elapsed() < Duration::from_secs(5), "not waiting");
    // Cancelled polls (clients gone) leave no wakeup behind.
    assert_eq!(env.store.waiter_count(), 1);
    for task in waiting {
        task.abort();
    }
    eventually("no wakeup left", || env.store.waiter_count() == 0).await;
    assert_eq!(waiters(&webhooks), 0);
    env.drop_schema().await;
}

/// N3: a subscription created while its connection is being deleted never
/// outlives the deletion.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_subscription_racing_its_connections_deletion_does_not_outlive_it() {
    let env = env(Policy::pilot(1 << 30)).await;
    for round in 0..10u8 {
        let owner = Agent::new(110 + round);
        let connection = env
            .connection("tracker", &owner, &format!("key-{round}"), &["p-1"])
            .await;
        let body =
            json!({"source": "project", "parameters": {"projectId": "p-1"}, "events": ["task"]});
        let subscribe = signed_request(
            &env.state,
            &owner,
            "POST",
            &format!("/connections/{connection}/subscriptions"),
            serde_json::to_vec(&body).unwrap(),
        );
        let delete = signed_request(
            &env.state,
            &owner,
            "DELETE",
            &format!("/connections/{connection}"),
            vec![],
        );
        let (a, b) = (env.state.clone(), env.state.clone());
        let (_created, deleted) = tokio::join!(
            async move { crate::router(a).oneshot(subscribe).await.unwrap() },
            async move { crate::router(b).oneshot(delete).await.unwrap() },
        );
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        let live = env
            .count(&format!(
                "SELECT count(*) FROM webhook_subscriptions WHERE connection_id = '{connection}'
                 AND state IN ('provisioning', 'needs-reconciliation', 'active')"
            ))
            .await;
        assert_eq!(live, 0, "round {round}");
    }
    env.drop_schema().await;
}

/// A former consumer reads nothing once it lost standing, not even the
/// closed subscription.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn a_former_consumer_cannot_read_a_closed_subscription() {
    let env = env(small()).await;
    let owner = Agent::new(102);
    let app = Agent::new(103);
    let connection = env.connection("tracker", &owner, "key-o", &["p-1"]).await;
    env.security
        .put_delegation(&connection, &app.id(), None)
        .await
        .unwrap();
    let sub = id(&env.subscribe_project(&app, &connection, "p-1").await);
    let deleted = env
        .send(signed_request(
            &env.state,
            &app,
            "DELETE",
            &format!("/subscriptions/{sub}"),
            vec![],
        ))
        .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert!(env
        .security
        .delete_delegation(&connection, &app.id())
        .await
        .unwrap());
    let response = env.get(&app, &format!("/subscriptions/{sub}")).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    env.drop_schema().await;
}

/// A broken upload is a 400, not a 413; one endpoint cannot hold every read
/// slot.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn broken_uploads_and_the_per_endpoint_read_cap() {
    let env = env(small()).await;
    let alice = Agent::new(104);
    let connection = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    env.subscribe_project(&alice, &connection, "p-100").await;
    let endpoint = env.endpoint("tracker").await;
    let broken = futures_util::stream::iter([
        Ok(axum::body::Bytes::from_static(b"{\"kind\"")),
        Err(std::io::Error::other("connection reset")),
    ]);
    let request = Request::post(format!("/webhooks/{endpoint}"))
        .body(Body::from_stream(broken))
        .unwrap();
    assert_eq!(env.send(request).await.status(), StatusCode::BAD_REQUEST);

    let state = with_gate(&env, |gate| {
        gate.reads_per_endpoint = 1;
        gate.wait = Duration::from_millis(200);
    });
    let slow = {
        let state = state.clone();
        let request = Request::post(format!("/webhooks/{endpoint}"))
            .body(never_ending())
            .unwrap();
        tokio::spawn(async move { crate::router(state).oneshot(request).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let request = env.signed_delivery(&endpoint, "d-1", &task("p-100", "t/1"));
    let response = crate::router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "the endpoint's one read slot is taken"
    );
    slow.abort();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let request = env.signed_delivery(&endpoint, "d-1", &task("p-100", "t/1"));
    assert_eq!(
        crate::router(state)
            .oneshot(request)
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT,
        "released when the slow upload went away"
    );
    env.drop_schema().await;
}

fn with_limits(env: &Env, endpoint: u32, network: u32, owner: u32) -> AppState {
    let config = crate::config::WebhookConfig {
        ingress_per_endpoint_per_minute: endpoint,
        ingress_per_network_per_minute: network,
        subscribe_per_owner_per_hour: owner,
        ..Default::default()
    };
    let mut state = env.state.clone();
    state.webhooks = Some(Arc::new(Webhooks::with_limits(
        env.store.clone(),
        BTreeMap::from([("tracker".to_owned(), TRACKER_SECRET.to_vec())]),
        super::limits::Limits::from_config(&config),
    )));
    state
}

/// Ingress limits (review of the rate-limits PR): a network is limited
/// only by its refused requests, so verified deliveries from a provider's
/// few addresses never use it up; an endpoint is limited only once it is
/// known to exist, so random ids never take its window.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn ingress_limits_count_refusals_per_network_and_real_endpoints_only() {
    let mut env = env(small()).await;
    let alice = Agent::new(96);
    let connection = env.connection("tracker", &alice, "key-a", &["p-100"]).await;
    env.subscribe_project(&alice, &connection, "p-100").await;
    let endpoint = env.endpoint("tracker").await;
    env.state.trust_forwarded_for = crate::config::TrustForwardedFor::RightMost;
    let state = with_limits(&env, 5, 2, 20);
    let from = |network: &str, request: Request<Body>| {
        let mut request = request;
        request
            .headers_mut()
            .insert("x-forwarded-for", network.parse().unwrap());
        request
    };
    let delivery = |id: &str| env.signed_delivery(&endpoint, id, &task("p-100", id));
    let send = |request: Request<Body>| {
        let state = state.clone();
        async move { crate::router(state).oneshot(request).await.unwrap() }
    };
    // The provider's address: verified deliveries do not count against it.
    for id in ["a1", "a2", "a3"] {
        assert_eq!(
            send(from("192.0.2.1", delivery(id))).await.status(),
            StatusCode::NO_CONTENT
        );
    }
    // A sender of junk is limited after two refusals, valid or not.
    let junk = || {
        let mut request = delivery("j");
        request
            .headers_mut()
            .insert("tracker-signature", "v1=00".parse().unwrap());
        from("198.51.100.66", request)
    };
    assert_eq!(send(junk()).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(send(junk()).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(send(junk()).await.status(), StatusCode::TOO_MANY_REQUESTS);

    // The endpoint's own window (5: three deliveries, two refusals) is used up.
    let limited = send(from("192.0.2.1", delivery("a4"))).await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));

    // Random endpoint ids, from many networks, are refused without taking
    // a key of the endpoint limiter.
    for n in 0..50 {
        let random = format!("{:0>43}", n);
        let request = Request::post(format!("/webhooks/{random}"))
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(
            send(from(&format!("203.0.113.{n}"), request))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    let webhooks = state.webhooks.clone().unwrap();
    assert_eq!(webhooks.limits.ingress_per_endpoint.tracked(), 1);
    assert_eq!(
        env.count("SELECT count(*) FROM webhook_event_refs").await,
        3
    );
    env.drop_schema().await;
}

/// Subscription requests are limited per owner before the access check
/// reaches the provider.
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
async fn subscribing_is_rate_limited_per_owner() {
    let env = env(small()).await;
    let alice = Agent::new(97);
    let bob = Agent::new(98);
    let ac = env
        .connection("tracker", &alice, "key-a", &["p-1", "p-2", "p-3"])
        .await;
    let bc = env.connection("tracker", &bob, "key-b", &["p-9"]).await;
    let state = with_limits(&env, 600, 120, 2);
    let subscribe = |agent: &Agent, connection: &str, project: &str| {
        let body =
            json!({"source": "project", "parameters": {"projectId": project}, "events": ["task"]});
        signed_request(
            &state,
            agent,
            "POST",
            &format!("/connections/{connection}/subscriptions"),
            serde_json::to_vec(&body).unwrap(),
        )
    };
    let send = |request: Request<Body>| {
        let state = state.clone();
        async move { crate::router(state).oneshot(request).await.unwrap() }
    };
    assert_eq!(
        send(subscribe(&alice, &ac, "p-1")).await.status(),
        StatusCode::CREATED
    );
    // A refused access check counts as well: it reached the provider.
    assert_eq!(
        send(subscribe(&alice, &ac, "p-404")).await.status(),
        StatusCode::FORBIDDEN
    );
    let limited = send(subscribe(&alice, &ac, "p-3")).await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
    assert_eq!(
        send(subscribe(&bob, &bc, "p-9")).await.status(),
        StatusCode::CREATED
    );
    env.drop_schema().await;
}

/// Waits up to ten seconds for `condition`, checking every 20 ms.
async fn eventually(what: &str, condition: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for: {what}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
