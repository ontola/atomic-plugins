//! Who is calling: host-signed requests, checked on every operation.
//!
//! Loopback alone is not a boundary: any local process can reach the port and
//! set `x-atomic-installation`. So the host signs every request it sends here
//! as that installation's app agent on the node, with an Atomic version 2
//! request signature (`x-atomic-signature-version: 2`, ontola/atomic-plugins#54)
//! extended to cover the host's own `x-atomic-*` headers:
//!
//! ```text
//! atomic-request-v2
//! {METHOD}
//! {full URL, including query}
//! {timestamp, Unix ms}
//! {sha-256 hex of the body}
//! {name}:{value}      one line per bound header, names lower case, sorted
//! ```
//!
//! The first five lines are exactly atomic_lib's
//! `request_signature_message_v2`. The bound headers are every `x-atomic-*`
//! request header except the five that carry the proof itself
//! ([`PROOF_HEADERS`]); today that is `x-atomic-drive` and
//! `x-atomic-installation`. With no bound headers the message is the plain v2
//! message.
//!
//! A request is accepted only when, in this order:
//! 1. the proof headers are all present and version is `2`;
//! 2. the Ed25519 signature verifies strictly over that message;
//! 3. the timestamp is at most [`MAX_AGE_MS`] old and at most
//!    [`MAX_FUTURE_MS`] ahead;
//! 4. the proof was not seen before within that window (the replay cache);
//! 5. the operator's registry says the claimed installation's app agent is
//!    the one that signed: same agent subject and same public key.
//!
//! Every refusal is a 401, except a registry that cannot be reached (503).
use base64::Engine as _;
use ed25519_dalek::{PublicKey, Signature};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::TryFrom;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// How old a proof may be, in ms: atomic_lib's `AUTH_MAX_AGE_MS`.
pub const MAX_AGE_MS: i64 = 5 * 60 * 1000;
/// How far ahead of this clock a proof may be, in ms: atomic_lib's
/// `ACCEPTABLE_TIME_DIFFERENCE`.
pub const MAX_FUTURE_MS: i64 = 10_000;
/// Replay cache bound. Proofs leave it once their window has passed; a cache
/// still full of live proofs refuses new ones rather than forgetting any.
pub const MAX_SEEN: usize = 100_000;

/// The headers that carry the proof, and so are not signed themselves.
pub const PROOF_HEADERS: [&str; 5] = [
    "x-atomic-agent",
    "x-atomic-public-key",
    "x-atomic-signature",
    "x-atomic-signature-version",
    "x-atomic-timestamp",
];

/// The app agent the host has for an installation on this node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredAgent {
    /// The agent subject, as sent in `x-atomic-agent`.
    pub agent: String,
    /// Base64 Ed25519 public key (either alphabet, padded or not).
    pub public_key: String,
}

/// Where the sidecar learns which agent may speak for an installation. The
/// host serves this (see [`HttpRegistry`]); tests stub it.
pub trait Registry {
    /// `Ok(None)`: the host knows no app agent for this installation.
    fn agent_for(&self, installation: &str) -> Result<Option<RegisteredAgent>, String>;
}

#[derive(Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub kind: &'static str,
    pub detail: String,
}

fn refuse(kind: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        status: 401,
        kind,
        detail: detail.into(),
    }
}

/// What the check needs from an HTTP request.
pub struct Signed<'a> {
    pub method: &'a str,
    /// The full URL the host signed: the sidecar's public URL plus the
    /// request's path and query.
    pub url: &'a str,
    /// Every request header, names in any case.
    pub headers: &'a [(String, String)],
    pub body: &'a [u8],
}

/// Lower-case hex SHA-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The exact bytes the host signs; see the module docs.
pub fn message(
    method: &str,
    url: &str,
    timestamp: i64,
    body_sha256_hex: &str,
    bound: &[(String, String)],
) -> String {
    let mut out = format!(
        "atomic-request-v2\n{}\n{}\n{}\n{}",
        method.to_ascii_uppercase(),
        url,
        timestamp,
        body_sha256_hex
    );
    for (name, value) in bound {
        out.push('\n');
        out.push_str(name);
        out.push(':');
        out.push_str(value);
    }
    out
}

/// The `x-atomic-*` headers the signature covers, lower case and sorted.
/// A bound header sent twice is refused: which copy was signed is ambiguous.
pub fn bound_headers(headers: &[(String, String)]) -> Result<Vec<(String, String)>, Refusal> {
    let mut bound: Vec<(String, String)> = headers
        .iter()
        .map(|(n, v)| (n.to_ascii_lowercase(), v.clone()))
        .filter(|(n, _)| n.starts_with("x-atomic-") && !PROOF_HEADERS.contains(&n.as_str()))
        .collect();
    bound.sort();
    if bound.windows(2).any(|w| w[0].0 == w[1].0) {
        return Err(refuse(
            "ambiguous-header",
            "an x-atomic-* header was sent twice",
        ));
    }
    Ok(bound)
}

/// Both base64 alphabets, padded or not, as atomic_lib's `decode_base64`.
pub fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    let standard: String = value
        .trim_end_matches('=')
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(standard)
        .map_err(|e| e.to_string())
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Result<&'a str, Refusal> {
    let mut found = headers.iter().filter(|(n, _)| n.eq_ignore_ascii_case(name));
    match (found.next(), found.next()) {
        (Some((_, v)), None) => Ok(v),
        (None, _) => Err(refuse(
            "unsigned",
            format!("missing {name}: the sidecar only answers requests the host signed"),
        )),
        (Some(_), Some(_)) => Err(refuse("ambiguous-header", format!("{name} sent twice"))),
    }
}

/// Seen proofs, until their timestamp window has passed.
#[derive(Default)]
pub struct ReplayCache {
    seen: HashMap<Vec<u8>, i64>,
}

impl ReplayCache {
    /// Records the proof; false when it was already seen (or the cache is
    /// full of proofs that are still live).
    fn first_use(&mut self, signature: &[u8], timestamp: i64, now: i64) -> bool {
        if self.seen.contains_key(signature) {
            return false;
        }
        if self.seen.len() >= MAX_SEEN {
            self.seen.retain(|_, expires| *expires >= now);
            if self.seen.len() >= MAX_SEEN {
                return false;
            }
        }
        self.seen.insert(signature.to_vec(), timestamp + MAX_AGE_MS);
        true
    }
}

/// The verified caller: the installation the host vouched for, and the drive
/// it named (both covered by the signature).
#[derive(Debug, PartialEq, Eq)]
pub struct Caller {
    pub installation: String,
    pub drive: Option<String>,
}

/// Every check in the module docs, in that order.
pub fn verify(
    request: &Signed,
    now_ms: i64,
    cache: &mut ReplayCache,
    registry: &dyn Registry,
) -> Result<Caller, Refusal> {
    let headers = request.headers;
    let version = header(headers, "x-atomic-signature-version")?;
    if version != "2" {
        return Err(refuse(
            "signature-version",
            "only x-atomic-signature-version: 2 is accepted",
        ));
    }
    let agent = header(headers, "x-atomic-agent")?;
    let public_key = header(headers, "x-atomic-public-key")?;
    let signature = header(headers, "x-atomic-signature")?;
    let timestamp: i64 = header(headers, "x-atomic-timestamp")?
        .parse()
        .map_err(|_| refuse("bad-timestamp", "x-atomic-timestamp is not an integer"))?;
    let bound = bound_headers(headers)?;
    let installation = bound
        .iter()
        .find(|(n, _)| n == "x-atomic-installation")
        .map(|(_, v)| v.clone())
        .ok_or_else(|| {
            refuse(
                "no-installation",
                "the host did not name an installation (x-atomic-installation)",
            )
        })?;
    let drive = bound
        .iter()
        .find(|(n, _)| n == "x-atomic-drive")
        .map(|(_, v)| v.clone());

    let key_bytes = decode_base64(public_key)
        .map_err(|e| refuse("bad-public-key", format!("x-atomic-public-key: {e}")))?;
    let key = PublicKey::from_bytes(&key_bytes)
        .map_err(|_| refuse("bad-public-key", "not an Ed25519 public key"))?;
    let sig_bytes = decode_base64(signature)
        .map_err(|e| refuse("bad-signature", format!("x-atomic-signature: {e}")))?;
    let sig = Signature::try_from(&sig_bytes[..])
        .map_err(|_| refuse("bad-signature", "not an Ed25519 signature"))?;
    let signed = message(
        request.method,
        request.url,
        timestamp,
        &sha256_hex(request.body),
        &bound,
    );
    key.verify_strict(signed.as_bytes(), &sig).map_err(|_| {
        refuse(
            "bad-signature",
            format!("the signature does not cover this request; the sidecar checked {signed:?}"),
        )
    })?;

    if timestamp < now_ms - MAX_AGE_MS {
        return Err(refuse("expired", "the request signature is too old"));
    }
    if timestamp > now_ms + MAX_FUTURE_MS {
        return Err(refuse(
            "expired",
            "the request signature is from the future",
        ));
    }
    if !cache.first_use(&sig_bytes, timestamp, now_ms) {
        return Err(refuse(
            "replayed",
            "this request signature was already used",
        ));
    }

    let registered = registry.agent_for(&installation).map_err(|e| Refusal {
        status: 503,
        kind: "registry-unavailable",
        detail: format!("could not look up this installation's app agent: {e}"),
    })?;
    let registered = registered.ok_or_else(|| {
        refuse(
            "unknown-installation",
            "the host has no app agent for this installation",
        )
    })?;
    let same_key = decode_base64(&registered.public_key)
        .map(|k| k == key_bytes)
        .unwrap_or(false);
    if registered.agent != agent || !same_key {
        return Err(refuse(
            "wrong-agent",
            "the signing agent is not this installation's app agent",
        ));
    }
    Ok(Caller {
        installation,
        drive,
    })
}

/// Looks the app agent up on the host:
/// `GET {base}/plugin-runtime?installation={urlencoded}` answering
/// `{"agent": "...", "publicKey": "..."}`, or 404 when there is none.
/// Plain HTTP/1.0 on purpose: the host is on loopback or a private Docker
/// network, and this keeps an HTTP client stack out of the sidecar.
pub struct HttpRegistry {
    /// `http://host:port`, no trailing slash.
    pub base: String,
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b => format!("%{b:02X}"),
        })
        .collect()
}

impl Registry for HttpRegistry {
    fn agent_for(&self, installation: &str) -> Result<Option<RegisteredAgent>, String> {
        let authority = self
            .base
            .strip_prefix("http://")
            .ok_or("--atomic-server must be an http:// URL")?
            .trim_end_matches('/');
        let mut stream = TcpStream::connect(authority).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|e| e.to_string())?;
        write!(
            stream,
            "GET /plugin-runtime?installation={} HTTP/1.0\r\nHost: {authority}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
            percent_encode(installation)
        )
        .map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        stream
            .take(1_048_576)
            .read_to_end(&mut raw)
            .map_err(|e| e.to_string())?;
        let raw = String::from_utf8_lossy(&raw);
        let (head, body) = raw.split_once("\r\n\r\n").ok_or("malformed response")?;
        let status: u16 = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .ok_or("malformed status line")?;
        match status {
            200 => {}
            404 => return Ok(None),
            s => return Err(format!("the host answered {s}")),
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Answer {
            agent: String,
            public_key: String,
        }
        let answer: Answer = serde_json::from_str(body).map_err(|e| e.to_string())?;
        Ok(Some(RegisteredAgent {
            agent: answer.agent,
            public_key: answer.public_key,
        }))
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ed25519_dalek::{Keypair, SecretKey, Signer};

    pub const INSTALLATION: &str = "http://localhost:9883/installation";
    pub const DRIVE: &str = "http://localhost:9883/drive";
    pub const URL: &str = "http://127.0.0.1:14480/v1/query";
    pub const NOW: i64 = 1_700_000_000_000;

    pub fn keypair(seed: u8) -> Keypair {
        let secret = SecretKey::from_bytes(&[seed; 32]).unwrap();
        let public = PublicKey::from(&secret);
        Keypair { secret, public }
    }

    pub fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    pub fn agent_of(keys: &Keypair) -> String {
        format!("did:ad:agent:{}", b64(keys.public.as_bytes()))
    }

    /// What the host sends: the bound headers plus a v2 proof over them.
    pub fn sign(
        keys: &Keypair,
        method: &str,
        url: &str,
        body: &[u8],
        installation: &str,
        timestamp: i64,
    ) -> Vec<(String, String)> {
        let bound = vec![
            ("x-atomic-drive".to_string(), DRIVE.to_string()),
            (
                "x-atomic-installation".to_string(),
                installation.to_string(),
            ),
        ];
        let msg = message(method, url, timestamp, &sha256_hex(body), &bound);
        let mut headers = bound;
        headers.extend([
            ("X-Atomic-Agent".into(), agent_of(keys)),
            ("x-atomic-public-key".into(), b64(keys.public.as_bytes())),
            (
                "x-atomic-signature".into(),
                b64(&keys.sign(msg.as_bytes()).to_bytes()),
            ),
            ("x-atomic-timestamp".into(), timestamp.to_string()),
            ("x-atomic-signature-version".into(), "2".into()),
            ("content-type".into(), "application/json".into()),
        ]);
        headers
    }

    /// Stub for the host's lookup: one installation, one agent.
    pub struct Stub(pub Vec<(String, RegisteredAgent)>);

    impl Stub {
        pub fn one(installation: &str, keys: &Keypair) -> Self {
            Stub(vec![(
                installation.to_string(),
                RegisteredAgent {
                    agent: agent_of(keys),
                    public_key: b64(keys.public.as_bytes()),
                },
            )])
        }
    }

    impl Registry for Stub {
        fn agent_for(&self, installation: &str) -> Result<Option<RegisteredAgent>, String> {
            Ok(self
                .0
                .iter()
                .find(|(i, _)| i == installation)
                .map(|(_, a)| a.clone()))
        }
    }

    const BODY: &[u8] = br#"{"document":"did:ng:o:doc"}"#;

    fn check(
        headers: &[(String, String)],
        body: &[u8],
        cache: &mut ReplayCache,
    ) -> Result<Caller, Refusal> {
        let keys = keypair(1);
        verify(
            &Signed {
                method: "POST",
                url: URL,
                headers,
                body,
            },
            NOW,
            cache,
            &Stub::one(INSTALLATION, &keys),
        )
    }

    fn kind(r: Result<Caller, Refusal>) -> (u16, &'static str) {
        let r = r.expect_err("should be refused");
        (r.status, r.kind)
    }

    #[test]
    fn a_good_signature_names_the_installation_and_drive() {
        let headers = sign(&keypair(1), "POST", URL, BODY, INSTALLATION, NOW - 1000);
        let caller = check(&headers, BODY, &mut ReplayCache::default()).unwrap();
        assert_eq!(
            caller,
            Caller {
                installation: INSTALLATION.into(),
                drive: Some(DRIVE.into())
            }
        );
    }

    #[test]
    fn an_unsigned_request_is_refused() {
        let headers = vec![(
            "x-atomic-installation".to_string(),
            INSTALLATION.to_string(),
        )];
        assert_eq!(
            kind(check(&headers, BODY, &mut ReplayCache::default())),
            (401, "unsigned")
        );
    }

    #[test]
    fn a_tampered_body_is_refused() {
        let headers = sign(&keypair(1), "POST", URL, BODY, INSTALLATION, NOW);
        let other = br#"{"document":"did:ng:o:other"}"#;
        assert_eq!(
            kind(check(&headers, other, &mut ReplayCache::default())),
            (401, "bad-signature")
        );
    }

    #[test]
    fn a_tampered_installation_or_drive_is_refused() {
        let signed = sign(&keypair(1), "POST", URL, BODY, INSTALLATION, NOW);
        for (name, value) in [
            ("x-atomic-installation", "http://localhost:9883/other"),
            ("x-atomic-drive", "http://localhost:9883/other-drive"),
        ] {
            let mut headers = signed.clone();
            headers.iter_mut().find(|(n, _)| n == name).unwrap().1 = value.into();
            assert_eq!(
                kind(check(&headers, BODY, &mut ReplayCache::default())),
                (401, "bad-signature"),
                "{name}"
            );
        }
        // An added x-atomic-* header is covered too, and a doubled one refused.
        let mut added = signed.clone();
        added.push(("x-atomic-extra".into(), "1".into()));
        assert_eq!(
            kind(check(&added, BODY, &mut ReplayCache::default())),
            (401, "bad-signature")
        );
        let mut doubled = signed;
        doubled.push(("X-Atomic-Installation".into(), INSTALLATION.into()));
        assert_eq!(
            kind(check(&doubled, BODY, &mut ReplayCache::default())),
            (401, "ambiguous-header")
        );
    }

    #[test]
    fn a_tampered_method_or_url_is_refused() {
        let headers = sign(
            &keypair(1),
            "POST",
            "http://127.0.0.1:14480/v1/update",
            BODY,
            INSTALLATION,
            NOW,
        );
        assert_eq!(
            kind(check(&headers, BODY, &mut ReplayCache::default())),
            (401, "bad-signature")
        );
        let headers = sign(&keypair(1), "GET", URL, BODY, INSTALLATION, NOW);
        assert_eq!(
            kind(check(&headers, BODY, &mut ReplayCache::default())),
            (401, "bad-signature")
        );
    }

    #[test]
    fn a_replayed_proof_is_refused() {
        let mut cache = ReplayCache::default();
        let headers = sign(&keypair(1), "POST", URL, BODY, INSTALLATION, NOW);
        assert!(check(&headers, BODY, &mut cache).is_ok());
        assert_eq!(kind(check(&headers, BODY, &mut cache)), (401, "replayed"));
        // A fresh proof for the same request is fine.
        let fresh = sign(&keypair(1), "POST", URL, BODY, INSTALLATION, NOW + 1);
        assert!(check(&fresh, BODY, &mut cache).is_ok());
    }

    #[test]
    fn another_agent_cannot_speak_for_the_installation() {
        // Validly signed, but by an agent that is not this installation's.
        let headers = sign(&keypair(2), "POST", URL, BODY, INSTALLATION, NOW);
        assert_eq!(
            kind(check(&headers, BODY, &mut ReplayCache::default())),
            (401, "wrong-agent")
        );
        // The right agent claiming an installation it is not registered for.
        let headers = sign(
            &keypair(1),
            "POST",
            URL,
            BODY,
            "http://localhost:9883/other",
            NOW,
        );
        assert_eq!(
            kind(check(&headers, BODY, &mut ReplayCache::default())),
            (401, "unknown-installation")
        );
        // The right agent subject with another key.
        let mut headers = sign(&keypair(2), "POST", URL, BODY, INSTALLATION, NOW);
        headers
            .iter_mut()
            .find(|(n, _)| n.eq_ignore_ascii_case("x-atomic-agent"))
            .unwrap()
            .1 = agent_of(&keypair(1));
        assert_eq!(
            kind(check(&headers, BODY, &mut ReplayCache::default())),
            (401, "wrong-agent")
        );
    }

    #[test]
    fn an_expired_or_future_timestamp_is_refused() {
        for ts in [NOW - MAX_AGE_MS - 1, NOW + MAX_FUTURE_MS + 1] {
            let headers = sign(&keypair(1), "POST", URL, BODY, INSTALLATION, ts);
            assert_eq!(
                kind(check(&headers, BODY, &mut ReplayCache::default())),
                (401, "expired"),
                "{ts}"
            );
        }
    }

    #[test]
    fn version_1_is_not_accepted() {
        let mut headers = sign(&keypair(1), "POST", URL, BODY, INSTALLATION, NOW);
        headers
            .iter_mut()
            .find(|(n, _)| n == "x-atomic-signature-version")
            .unwrap()
            .1 = "1".into();
        assert_eq!(
            kind(check(&headers, BODY, &mut ReplayCache::default())),
            (401, "signature-version")
        );
    }

    #[test]
    fn a_registry_failure_is_503_not_a_pass() {
        struct Down;
        impl Registry for Down {
            fn agent_for(&self, _: &str) -> Result<Option<RegisteredAgent>, String> {
                Err("connection refused".into())
            }
        }
        let headers = sign(&keypair(1), "POST", URL, BODY, INSTALLATION, NOW);
        let r = verify(
            &Signed {
                method: "POST",
                url: URL,
                headers: &headers,
                body: BODY,
            },
            NOW,
            &mut ReplayCache::default(),
            &Down,
        );
        assert_eq!(kind(r), (503, "registry-unavailable"));
    }

    /// A golden message and signature for the host side to reproduce: key
    /// seed [1; 32], the request below. Printed with
    /// `cargo test golden -- --nocapture`.
    #[test]
    fn golden_vector() {
        let keys = keypair(1);
        let bound = vec![
            ("x-atomic-drive".to_string(), DRIVE.to_string()),
            (
                "x-atomic-installation".to_string(),
                INSTALLATION.to_string(),
            ),
        ];
        let msg = message("post", URL, NOW, &sha256_hex(BODY), &bound);
        assert_eq!(
            msg,
            format!(
                "atomic-request-v2\nPOST\n{URL}\n{NOW}\n{}\nx-atomic-drive:{DRIVE}\nx-atomic-installation:{INSTALLATION}",
                sha256_hex(BODY)
            )
        );
        println!(
            "public key {}\nmessage {msg:?}\nsignature {}",
            b64(keys.public.as_bytes()),
            b64(&keys.sign(msg.as_bytes()).to_bytes())
        );
    }
}
