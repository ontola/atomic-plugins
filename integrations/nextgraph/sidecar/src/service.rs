//! The sidecar's scoped operations, independent of NextGraph itself.
//!
//! Atomic Server reaches this service only through declared
//! `atomic-sidecar:/nextgraph/...` operations (atomic-server branch
//! `claude/plugin-nextgraph-host`). The host strips any `x-atomic-*` header a
//! plugin sets, adds `x-atomic-installation` and `x-atomic-drive` itself, and
//! signs the request as that installation's app agent. Every operation except
//! `/v1/health` is first verified by [crate::auth] (signature, freshness,
//! replay, and that the signer is the installation's registered app agent),
//! then checked here against the operator's scope file:
//! which installation may read, or read and write, which NextGraph document.
//! Nothing is granted by default, and the file is re-read on every request so
//! a revocation takes effect on the next call.
//!
//! Writes are add-only (`INSERT DATA` into the document's default graph) and
//! carry an idempotency key. The acknowledgement is persisted (fsync, then
//! rename) before it is returned; a retry with the same key and body returns
//! the stored acknowledgement instead of writing again, and a key whose write
//! began but whose acknowledgement was never stored is reported as uncertain
//! rather than repeated.
use crate::auth::{self, Registry, ReplayCache, Signed};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Largest request body the sidecar reads.
pub const MAX_BODY_BYTES: usize = 262_144;
/// Largest update text; the plugin caps its own output at the same size.
pub const MAX_UPDATE_BYTES: usize = 131_072;
/// The only query the sidecar runs: the plugin's bounded triple projection.
/// One row more than the plugin accepts, so an oversized document is refused
/// instead of silently truncated.
pub const SELECT: &str = "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 257";

/// What the sidecar needs from a NextGraph session.
pub trait Engine {
    /// A syntactically valid NextGraph document NURI this wallet can open.
    fn check_document(&self, document: &str) -> Result<(), String>;
    /// Refuses anything but `INSERT DATA` into the default graph.
    fn check_insert_only(&self, update: &str) -> Result<(), String>;
    /// SPARQL Results JSON for [`SELECT`] on the document.
    fn query(&mut self, document: &str) -> Result<String, String>;
    /// Applies the update to the document; returns NextGraph commit ids.
    fn update(&mut self, document: &str, update: &str) -> Result<Vec<String>, String>;
    /// Human-readable broker status for `/v1/health`.
    fn broker_status(&self) -> String;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Access {
    Read,
    ReadWrite,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    /// The Atomic installation (or plugin draft) subject the host asserts.
    pub installation: String,
    pub document: String,
    pub access: Access,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scopes {
    #[serde(default)]
    pub grants: Vec<Grant>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    pub key: String,
    pub document: String,
    pub commits: Vec<String>,
    /// Milliseconds since the Unix epoch, when the acknowledgement was stored.
    pub applied_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    /// SHA-256 of the document and update text this key was first used for.
    request: String,
    /// `None` while the write is in progress or its outcome is unknown.
    ack: Option<Ack>,
}

pub struct Request {
    pub method: String,
    /// Path without the query, for routing.
    pub path: String,
    /// The full URL the host signed: the sidecar's public URL, then the
    /// request's path and query exactly as received.
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
}

impl Response {
    fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: value.to_string(),
        }
    }

    fn problem(status: u16, kind: &str, detail: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "application/problem+json",
            body: json!({"type": kind, "status": status, "detail": detail.into()}).to_string(),
        }
    }
}

pub struct Service<E> {
    pub engine: E,
    pub scopes: PathBuf,
    pub acks: PathBuf,
    pub now: fn() -> u64,
    /// Which app agent may speak for an installation (the host's lookup).
    pub registry: Box<dyn Registry>,
    /// Proofs already used, in memory: a restart forgets them, and a proof
    /// captured before a restart could be replayed once within its five
    /// minute window.
    pub replay: ReplayCache,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryBody {
    document: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateBody {
    document: String,
    key: String,
    update: String,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b':'))
}

fn digest(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

impl<E: Engine> Service<E> {
    pub fn handle(&mut self, request: Request) -> Response {
        if request.body.len() > MAX_BODY_BYTES {
            return Response::problem(413, "too-large", "request body too large");
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/v1/health") => Response::json(
                200,
                json!({"ok": true, "engine": "nextgraph", "broker": self.engine.broker_status()}),
            ),
            ("POST", "/v1/query" | "/v1/update") => {
                let caller = match auth::verify(
                    &Signed {
                        method: &request.method,
                        url: &request.url,
                        headers: &request.headers,
                        body: &request.body,
                    },
                    (self.now)() as i64,
                    &mut self.replay,
                    self.registry.as_ref(),
                ) {
                    Ok(c) => c,
                    Err(r) => return Response::problem(r.status, r.kind, r.detail),
                };
                if request.path == "/v1/query" {
                    self.query(&request, &caller.installation)
                } else {
                    self.update(&request, &caller.installation)
                }
            }
            (_, "/v1/health" | "/v1/query" | "/v1/update") => {
                Response::problem(405, "method-not-allowed", "method not allowed")
            }
            _ => Response::problem(404, "not-found", "no such operation"),
        }
    }

    /// The operator's grant for this installation and document, re-read now.
    fn authorize(
        &self,
        installation: &str,
        document: &str,
        needed: Access,
    ) -> Result<(), Response> {
        let scopes = read_scopes(&self.scopes)
            .map_err(|e| Response::problem(500, "scopes-unreadable", e))?;
        let grant = scopes
            .grants
            .iter()
            .find(|g| g.installation == installation && g.document == document);
        match grant {
            Some(g) if g.access == Access::ReadWrite || needed == Access::Read => Ok(()),
            Some(_) => Err(Response::problem(
                403,
                "read-only-grant",
                "this installation may only read this document",
            )),
            None => Err(Response::problem(
                403,
                "no-grant",
                "the operator has not granted this installation this document",
            )),
        }
    }

    fn query(&mut self, request: &Request, installation: &str) -> Response {
        let body: QueryBody = match serde_json::from_slice(&request.body) {
            Ok(b) => b,
            Err(e) => return Response::problem(400, "bad-request", e.to_string()),
        };
        if let Err(e) = self.engine.check_document(&body.document) {
            return Response::problem(400, "bad-document", e);
        }
        if let Err(r) = self.authorize(installation, &body.document, Access::Read) {
            return r;
        }
        match self.engine.query(&body.document) {
            Ok(results) => Response {
                status: 200,
                content_type: "application/sparql-results+json",
                body: results,
            },
            Err(e) => Response::problem(502, "nextgraph-error", e),
        }
    }

    fn update(&mut self, request: &Request, installation: &str) -> Response {
        let body: UpdateBody = match serde_json::from_slice(&request.body) {
            Ok(b) => b,
            Err(e) => return Response::problem(400, "bad-request", e.to_string()),
        };
        if !valid_key(&body.key) {
            return Response::problem(
                400,
                "bad-key",
                "key must be 1 to 128 ASCII letters, digits, '-', '_', '.' or ':'",
            );
        }
        if body.update.len() > MAX_UPDATE_BYTES {
            return Response::problem(413, "too-large", "update too large");
        }
        if let Err(e) = self.engine.check_document(&body.document) {
            return Response::problem(400, "bad-document", e);
        }
        if let Err(e) = self.engine.check_insert_only(&body.update) {
            return Response::problem(400, "not-insert-data", e);
        }
        if let Err(r) = self.authorize(installation, &body.document, Access::ReadWrite) {
            return r;
        }
        let slot = digest(&[installation, &body.key]);
        let fingerprint = digest(&[&body.document, &body.update]);
        let mut acks = match read_acks(&self.acks) {
            Ok(a) => a,
            Err(e) => return Response::problem(500, "acks-unreadable", e),
        };
        if let Some(entry) = acks.get(&slot) {
            if entry.request != fingerprint {
                return Response::problem(
                    409,
                    "key-reused",
                    "this key was already used for a different update",
                );
            }
            return match &entry.ack {
                Some(ack) => Response::json(200, json!({"ack": ack, "replayed": true})),
                None => Response::problem(
                    409,
                    "outcome-uncertain",
                    "a write with this key started but was never acknowledged; reconcile before retrying",
                ),
            };
        }
        // Reserve the key durably before touching NextGraph: a crash from here
        // on leaves an uncertain entry, never a silent second write.
        acks.insert(
            slot.clone(),
            Entry {
                request: fingerprint.clone(),
                ack: None,
            },
        );
        if let Err(e) = write_acks(&self.acks, &acks) {
            return Response::problem(500, "acks-unwritable", e);
        }
        let commits = match self.engine.update(&body.document, &body.update) {
            Ok(c) => c,
            Err(e) => {
                // NextGraph refused before committing (parse or permission
                // errors are reported before any commit): release the key.
                acks.remove(&slot);
                let _ = write_acks(&self.acks, &acks);
                return Response::problem(502, "nextgraph-error", e);
            }
        };
        let ack = Ack {
            key: body.key,
            document: body.document,
            commits,
            applied_at: (self.now)(),
        };
        acks.insert(
            slot,
            Entry {
                request: fingerprint,
                ack: Some(ack.clone()),
            },
        );
        if let Err(e) = write_acks(&self.acks, &acks) {
            return Response::problem(
                500,
                "ack-unwritable",
                format!("the update was applied but its acknowledgement could not be stored: {e}"),
            );
        }
        Response::json(200, json!({"ack": ack, "replayed": false}))
    }
}

pub fn read_scopes(path: &Path) -> Result<Scopes, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("scope file: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Scopes::default()),
        Err(e) => Err(format!("scope file: {e}")),
    }
}

fn read_acks(path: &Path) -> Result<BTreeMap<String, Entry>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("ack store: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(format!("ack store: {e}")),
    }
}

/// Writes `value` to `path` so that a crash leaves either the old or the new
/// file, never a partial one.
pub fn write_durably(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        if let Ok(dir) = fs::File::open(dir) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

fn write_acks(path: &Path, acks: &BTreeMap<String, Entry>) -> Result<(), String> {
    write_durably(
        path,
        &serde_json::to_vec_pretty(acks).map_err(|e| e.to_string())?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::tests::{keypair, sign, Stub, NOW};

    const DOC: &str = "did:ng:o:doc";
    const OTHER: &str = "did:ng:o:other";
    const INSTALLATION: &str = "http://localhost:9883/installation";

    #[derive(Default)]
    struct Fake {
        writes: Vec<(String, String)>,
        fail_update: bool,
    }

    impl Engine for Fake {
        fn check_document(&self, document: &str) -> Result<(), String> {
            document
                .starts_with("did:ng:")
                .then_some(())
                .ok_or_else(|| "not a NURI".to_string())
        }
        fn check_insert_only(&self, update: &str) -> Result<(), String> {
            update
                .starts_with("INSERT DATA")
                .then_some(())
                .ok_or_else(|| "only INSERT DATA".to_string())
        }
        fn query(&mut self, _: &str) -> Result<String, String> {
            Ok(r#"{"head":{"vars":["s","p","o"]},"results":{"bindings":[]}}"#.into())
        }
        fn update(&mut self, document: &str, update: &str) -> Result<Vec<String>, String> {
            if self.fail_update {
                return Err("refused".into());
            }
            self.writes.push((document.into(), update.into()));
            Ok(vec![format!("commit-{}", self.writes.len())])
        }
        fn broker_status(&self) -> String {
            "offline".into()
        }
    }

    fn service(name: &str, grants: Value) -> Service<Fake> {
        let dir = std::env::temp_dir().join(format!(
            "ng-atomic-sidecar-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("scopes.json"),
            json!({"grants": grants}).to_string(),
        )
        .unwrap();
        Service {
            engine: Fake::default(),
            scopes: dir.join("scopes.json"),
            acks: dir.join("acks.json"),
            now: || NOW as u64,
            registry: registry(),
            replay: ReplayCache::default(),
        }
    }

    /// The host's lookup: both test installations have their own app agent.
    fn registry() -> Box<dyn Registry> {
        let mut stub = Stub::one(INSTALLATION, &keypair(1));
        stub.0
            .extend(Stub::one("http://localhost:9883/other", &keypair(3)).0);
        Box::new(stub)
    }

    /// A request as the host sends it: signed by the installation's agent.
    /// `None` is an unsigned request from some other local process.
    fn post(path: &str, installation: Option<&str>, body: Value) -> Request {
        let url = format!("http://127.0.0.1:14480{path}");
        let body = body.to_string().into_bytes();
        let headers = match installation {
            Some(i) => {
                let seed = if i == INSTALLATION { 1 } else { 3 };
                let ts = NOW - rand_offset();
                sign(&keypair(seed), "POST", &url, &body, i, ts)
            }
            None => vec![],
        };
        Request {
            method: "POST".into(),
            path: path.into(),
            url,
            headers,
            body,
        }
    }

    /// Distinct timestamps, so repeated identical requests carry distinct
    /// proofs, as a host signing each request afresh would.
    fn rand_offset() -> i64 {
        use std::sync::atomic::{AtomicI64, Ordering};
        static N: AtomicI64 = AtomicI64::new(0);
        N.fetch_add(1, Ordering::Relaxed)
    }

    fn update(key: &str, text: &str) -> Request {
        post(
            "/v1/update",
            Some(INSTALLATION),
            json!({"document": DOC, "key": key, "update": text}),
        )
    }

    #[test]
    fn nothing_is_granted_by_default() {
        let mut s = service("default", json!([]));
        let r = s.handle(post(
            "/v1/query",
            Some(INSTALLATION),
            json!({"document": DOC}),
        ));
        assert_eq!(r.status, 403, "{}", r.body);
        let r = s.handle(post("/v1/query", None, json!({"document": DOC})));
        assert_eq!(r.status, 401, "{}", r.body);
    }

    #[test]
    fn a_read_grant_reads_only_its_document() {
        let mut s = service(
            "read",
            json!([{"installation": INSTALLATION, "document": DOC, "access": "read"}]),
        );
        let r = s.handle(post(
            "/v1/query",
            Some(INSTALLATION),
            json!({"document": DOC}),
        ));
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.content_type, "application/sparql-results+json");
        let r = s.handle(post(
            "/v1/query",
            Some(INSTALLATION),
            json!({"document": OTHER}),
        ));
        assert_eq!(r.status, 403);
        let r = s.handle(post(
            "/v1/query",
            Some("http://localhost:9883/other"),
            json!({"document": DOC}),
        ));
        assert_eq!(r.status, 403);
        let r = s.handle(update("k1", "INSERT DATA { <a:b> <a:c> <a:d> }"));
        assert_eq!(r.status, 403, "{}", r.body);
        assert!(s.engine.writes.is_empty());
    }

    #[test]
    fn revocation_takes_effect_on_the_next_request() {
        let mut s = service(
            "revoke",
            json!([{"installation": INSTALLATION, "document": DOC, "access": "read"}]),
        );
        let q = || post("/v1/query", Some(INSTALLATION), json!({"document": DOC}));
        assert_eq!(s.handle(q()).status, 200);
        fs::write(&s.scopes, r#"{"grants":[]}"#).unwrap();
        assert_eq!(s.handle(q()).status, 403);
    }

    #[test]
    fn a_retried_write_returns_the_stored_ack_without_writing_again() {
        let mut s = service(
            "retry",
            json!([{"installation": INSTALLATION, "document": DOC, "access": "read-write"}]),
        );
        let text = "INSERT DATA { <a:b> <a:c> \"1\" }";
        let first = s.handle(update("export-1", text));
        assert_eq!(first.status, 200, "{}", first.body);
        let first: Value = serde_json::from_str(&first.body).unwrap();
        assert_eq!(first["replayed"], false);
        assert_eq!(first["ack"]["commits"], json!(["commit-1"]));

        let again = s.handle(update("export-1", text));
        let again: Value = serde_json::from_str(&again.body).unwrap();
        assert_eq!(again["replayed"], true);
        assert_eq!(again["ack"], first["ack"]);
        assert_eq!(s.engine.writes.len(), 1);

        // The same key for another update is refused, not applied.
        let reused = s.handle(update("export-1", "INSERT DATA { <a:b> <a:c> \"2\" }"));
        assert_eq!(reused.status, 409);
        assert_eq!(s.engine.writes.len(), 1);
    }

    #[test]
    fn acks_survive_a_restart() {
        let mut s = service(
            "restart",
            json!([{"installation": INSTALLATION, "document": DOC, "access": "read-write"}]),
        );
        let text = "INSERT DATA { <a:b> <a:c> \"1\" }";
        assert_eq!(s.handle(update("k", text)).status, 200);
        let mut restarted = Service {
            engine: Fake::default(),
            scopes: s.scopes.clone(),
            acks: s.acks.clone(),
            now: || NOW as u64,
            registry: registry(),
            replay: ReplayCache::default(),
        };
        let r = restarted.handle(update("k", text));
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"replayed\":true"));
        assert!(restarted.engine.writes.is_empty());
    }

    #[test]
    fn an_unacknowledged_write_is_uncertain_not_repeated() {
        let mut s = service(
            "uncertain",
            json!([{"installation": INSTALLATION, "document": DOC, "access": "read-write"}]),
        );
        let text = "INSERT DATA { <a:b> <a:c> \"1\" }";
        // What a crash between the NextGraph commit and the ack leaves behind.
        let slot = digest(&[INSTALLATION, "k"]);
        let mut acks = BTreeMap::new();
        acks.insert(
            slot,
            Entry {
                request: digest(&[DOC, text]),
                ack: None,
            },
        );
        write_acks(&s.acks, &acks).unwrap();
        let r = s.handle(update("k", text));
        assert_eq!(r.status, 409);
        assert!(r.body.contains("outcome-uncertain"));
        assert!(s.engine.writes.is_empty());
    }

    #[test]
    fn a_refused_write_releases_its_key() {
        let mut s = service(
            "refused",
            json!([{"installation": INSTALLATION, "document": DOC, "access": "read-write"}]),
        );
        s.engine.fail_update = true;
        let text = "INSERT DATA { <a:b> <a:c> \"1\" }";
        assert_eq!(s.handle(update("k", text)).status, 502);
        s.engine.fail_update = false;
        assert_eq!(s.handle(update("k", text)).status, 200);
    }

    #[test]
    fn malformed_requests_are_refused_before_any_write() {
        let mut s = service(
            "malformed",
            json!([{"installation": INSTALLATION, "document": DOC, "access": "read-write"}]),
        );
        for (key, text) in [
            ("", "INSERT DATA {}"),
            ("has space", "INSERT DATA {}"),
            ("k", "DELETE WHERE { ?s ?p ?o }"),
        ] {
            assert_eq!(s.handle(update(key, text)).status, 400, "{key} {text}");
        }
        let big = format!("INSERT DATA {{ {} }}", "x".repeat(MAX_UPDATE_BYTES));
        assert_eq!(s.handle(update("k", &big)).status, 413);
        let r = s.handle(post(
            "/v1/update",
            Some(INSTALLATION),
            json!({"document": DOC, "key": "k", "update": "INSERT DATA {}", "graph": "x"}),
        ));
        assert_eq!(r.status, 400);
        assert!(s.engine.writes.is_empty());
        assert_eq!(
            s.handle(Request {
                method: "GET".into(),
                path: "/v1/update".into(),
                url: "http://127.0.0.1:14480/v1/update".into(),
                headers: vec![],
                body: vec![],
            })
            .status,
            405
        );
    }
}
