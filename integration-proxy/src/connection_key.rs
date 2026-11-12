//! Connection keys the client holds.
//!
//! A connection's provider credential is sealed under a 256-bit key that the
//! proxy does not keep. Every request that needs the credential presents the
//! key in the `x-connection-key` header, in one of two forms:
//!
//! ```text
//! x-connection-key: k1.<base64url, unpadded: the 32 key bytes>
//! x-connection-key: s1.<base64url, unpadded: enc || ciphertext>
//! ```
//!
//! - `k1` is the key itself. It is for a caller that may hold the key: the
//!   owner, and software the owner runs.
//! - `s1` is a **key grant**: the key encrypted to this proxy's grant public
//!   key (`GET /connection-key-grants/key`) with HPKE (RFC 9180) base mode,
//!   DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, `info` =
//!   [`GRANT_INFO`], empty `aad`. `enc` is the 32-byte encapsulated key. The
//!   plaintext is JSON:
//!
//!   ```text
//!   {"v":1,"connection_id":"…","sub":"atomic:agent:…","key":"<base64url>","exp":1700000000}
//!   ```
//!
//!   `sub` is who may present the grant (see [`resolve`]'s `principal`),
//!   `exp` (Unix seconds) is optional. The holder cannot read the key, so a
//!   grant is what a plugin frame gets. Anyone who knows the key can make a
//!   grant; a grant authorises nothing, it only lets the proxy open a
//!   credential for a caller that is authorised some other way.
//!
//! The header is covered by the request signature (see
//! [`crate::signature::message`]). The key and the opened credential live
//! only for the request; nothing here stores either.
//!
//! The grant private key is derived from `ENCRYPTION_KEY`. Whoever steals the
//! database and the server configuration gets that private key but no
//! grants, because grants are never stored; a grant captured elsewhere
//! (from a client, or from a log that should not have recorded it) can then
//! be opened, which is why grants and keys must stay out of logs.
use axum::http::HeaderMap;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hpke::{
    aead::AesGcm256, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable, Kem as _, OpModeR,
    Serializable,
};
use serde::Deserialize;

use crate::api_error::ApiError;
use crate::security::ConnectionKey;

pub const HEADER: &str = "x-connection-key";

/// HPKE `info` for a key grant.
pub const GRANT_INFO: &[u8] = b"integration-proxy-connection-key-grant-v1";

/// Longest header value accepted: a grant with two agent ids and an expiry is
/// under 600 characters.
const MAX_HEADER_LEN: usize = 2048;

type Kem = X25519HkdfSha256;

/// The proxy's HPKE key pair for key grants.
#[derive(Clone)]
pub struct GrantKey {
    private: <Kem as hpke::Kem>::PrivateKey,
    public: <Kem as hpke::Kem>::PublicKey,
}

/// What a grant says, once opened.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    v: u8,
    connection_id: String,
    sub: String,
    key: String,
    #[serde(default)]
    exp: Option<u64>,
}

impl GrantKey {
    /// Derives the key pair from 32 bytes of key material (RFC 9180
    /// `DeriveKeyPair`).
    pub fn derive(ikm: &[u8; 32]) -> Self {
        let (private, public) = Kem::derive_keypair(ikm);
        Self { private, public }
    }

    /// The public key clients encrypt grants to: 32 bytes, base64url,
    /// unpadded.
    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public.to_bytes())
    }

    fn open(&self, sealed: &[u8]) -> Option<Grant> {
        const ENC: usize = 32;
        if sealed.len() <= ENC {
            return None;
        }
        let (enc, ciphertext) = sealed.split_at(ENC);
        let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(enc).ok()?;
        let plaintext = hpke::single_shot_open::<AesGcm256, HkdfSha256, Kem>(
            &OpModeR::Base,
            &self.private,
            &enc,
            GRANT_INFO,
            ciphertext,
            &[],
        )
        .ok()?;
        serde_json::from_slice(&plaintext).ok()
    }
}

fn key_from_base64(value: &str) -> Option<ConnectionKey> {
    let bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(value).ok()?.try_into().ok()?;
    Some(ConnectionKey::from_bytes(bytes))
}

/// Parses a `k1.` key as it appears in a request body (redeem, transfer),
/// where no grant is accepted.
pub fn parse_raw(value: &str) -> Option<ConnectionKey> {
    key_from_base64(value.strip_prefix("k1.")?)
}

/// The connection key a request presents for `connection_id`.
///
/// `principals` are the identities a grant's `sub` may name for this
/// request: the request's signer, and for a frame the capability's app
/// agent. Call it only after the caller is authorised; an absent header is
/// `connection_key_required`, anything else that does not yield a key for
/// this connection and caller is `invalid_connection_key`.
pub fn resolve(
    headers: &HeaderMap,
    grant_key: &GrantKey,
    connection_id: &str,
    principals: &[&str],
    now_secs: u64,
) -> Result<ConnectionKey, ApiError> {
    let value = headers
        .get(HEADER)
        .ok_or(ApiError::ConnectionKeyRequired)?
        .to_str()
        .map_err(|_| ApiError::InvalidConnectionKey)?;
    if value.len() > MAX_HEADER_LEN {
        return Err(ApiError::InvalidConnectionKey);
    }
    if let Some(sealed) = value.strip_prefix("s1.") {
        let sealed = URL_SAFE_NO_PAD
            .decode(sealed)
            .map_err(|_| ApiError::InvalidConnectionKey)?;
        let grant = grant_key
            .open(&sealed)
            .ok_or(ApiError::InvalidConnectionKey)?;
        let sub = crate::agent_id::parse(&grant.sub).ok_or(ApiError::InvalidConnectionKey)?;
        if grant.v != 1
            || grant.connection_id != connection_id
            || !principals.contains(&sub.as_str())
            || grant.exp.is_some_and(|exp| exp <= now_secs)
        {
            return Err(ApiError::InvalidConnectionKey);
        }
        return key_from_base64(&grant.key).ok_or(ApiError::InvalidConnectionKey);
    }
    parse_raw(value).ok_or(ApiError::InvalidConnectionKey)
}

/// Test-only: what a client does to make a grant.
#[cfg(test)]
pub fn seal_for_tests(
    public_key: &str,
    connection_id: &str,
    sub: &str,
    key: &ConnectionKey,
    exp: Option<u64>,
) -> String {
    use hpke::OpModeS;
    let public =
        <Kem as hpke::Kem>::PublicKey::from_bytes(&URL_SAFE_NO_PAD.decode(public_key).unwrap())
            .unwrap();
    let mut grant = serde_json::json!({
        "v": 1,
        "connection_id": connection_id,
        "sub": sub,
        "key": key.to_base64_for_tests(),
    });
    if let Some(exp) = exp {
        grant["exp"] = exp.into();
    }
    let (enc, ciphertext) = hpke::single_shot_seal::<AesGcm256, HkdfSha256, Kem, _>(
        &OpModeS::Base,
        &public,
        GRANT_INFO,
        &serde_json::to_vec(&grant).unwrap(),
        &[],
        &mut rand_core::UnwrapErr(rand_core::OsRng),
    )
    .unwrap();
    let mut sealed = enc.to_bytes().to_vec();
    sealed.extend_from_slice(&ciphertext);
    format!("s1.{}", URL_SAFE_NO_PAD.encode(sealed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_id::test_signer::Agent;
    use axum::http::HeaderValue;

    const CONNECTION: &str = "0123456789012345678901234567890123456789abc";

    fn headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HEADER, HeaderValue::from_str(value).unwrap());
        headers
    }

    fn raw(key: &ConnectionKey) -> String {
        format!("k1.{}", key.to_base64_for_tests())
    }

    #[test]
    fn a_raw_key_is_32_bytes_of_unpadded_base64url_and_nothing_else() {
        let grant_key = GrantKey::derive(&[1; 32]);
        let key = ConnectionKey::from_bytes([9; 32]);
        let resolved = resolve(&headers(&raw(&key)), &grant_key, CONNECTION, &[], 0).unwrap();
        assert_eq!(resolved.to_base64_for_tests(), key.to_base64_for_tests());

        assert_eq!(
            resolve(&HeaderMap::new(), &grant_key, CONNECTION, &[], 0).unwrap_err(),
            ApiError::ConnectionKeyRequired
        );
        let short = format!("k1.{}", URL_SAFE_NO_PAD.encode([9u8; 31]));
        let long = format!("k1.{}", URL_SAFE_NO_PAD.encode([9u8; 33]));
        let padded = format!("{}=", raw(&key));
        let bare = key.to_base64_for_tests();
        let oversized = format!("s1.{}", "A".repeat(MAX_HEADER_LEN));
        for bad in [
            "", "k1.", "k2.AAAA", &short, &long, &padded, &bare, &oversized,
        ] {
            assert_eq!(
                resolve(&headers(bad), &grant_key, CONNECTION, &[], 0).unwrap_err(),
                ApiError::InvalidConnectionKey,
                "{bad}"
            );
        }
    }

    #[test]
    fn a_grant_opens_only_for_its_proxy_connection_holder_and_lifetime() {
        let grant_key = GrantKey::derive(&[1; 32]);
        let key = ConnectionKey::from_bytes([9; 32]);
        let app = Agent::new(3);
        let other = Agent::new(4);
        let (app_id, other_id) = (app.id(), other.id());
        let grant = seal_for_tests(
            &grant_key.public_key(),
            CONNECTION,
            &app_id,
            &key,
            Some(100),
        );

        let resolved = resolve(&headers(&grant), &grant_key, CONNECTION, &[&app_id], 99).unwrap();
        assert_eq!(resolved.to_base64_for_tests(), key.to_base64_for_tests());
        // Each grant is encrypted afresh.
        assert_ne!(
            grant,
            seal_for_tests(
                &grant_key.public_key(),
                CONNECTION,
                &app_id,
                &key,
                Some(100)
            )
        );

        let invalid = |headers: &HeaderMap, proxy: &GrantKey, connection, who: &[&str], now| {
            assert_eq!(
                resolve(headers, proxy, connection, who, now).unwrap_err(),
                ApiError::InvalidConnectionKey
            );
        };
        // Another caller, another connection, expired, another proxy.
        invalid(&headers(&grant), &grant_key, CONNECTION, &[&other_id], 99);
        invalid(&headers(&grant), &grant_key, CONNECTION, &[], 99);
        let elsewhere = "9876543210987654321098765432109876543210abc";
        invalid(&headers(&grant), &grant_key, elsewhere, &[&app_id], 99);
        invalid(&headers(&grant), &grant_key, CONNECTION, &[&app_id], 100);
        invalid(
            &headers(&grant),
            &GrantKey::derive(&[2; 32]),
            CONNECTION,
            &[&app_id],
            99,
        );
        // Altered in transit.
        let mut altered = grant.clone().into_bytes();
        let last = altered.len() - 1;
        altered[last] = if altered[last] == b'A' { b'B' } else { b'A' };
        let altered = String::from_utf8(altered).unwrap();
        invalid(&headers(&altered), &grant_key, CONNECTION, &[&app_id], 99);

        // Without an expiry a grant lasts until the key changes.
        let lasting = seal_for_tests(&grant_key.public_key(), CONNECTION, &app_id, &key, None);
        assert!(resolve(
            &headers(&lasting),
            &grant_key,
            CONNECTION,
            &[&app_id],
            u64::MAX
        )
        .is_ok());
        // `sub` is matched as a canonical agent id, whichever spelling it has.
        let legacy = app_id.replace("atomic:agent:", "did:ad:agent:");
        let spelled = seal_for_tests(&grant_key.public_key(), CONNECTION, &legacy, &key, None);
        assert!(resolve(&headers(&spelled), &grant_key, CONNECTION, &[&app_id], 0).is_ok());
    }

    /// A grant sealed by atomic-server's data browser
    /// (`browser/data-browser/src/helpers/connectionKeys.ts`, `hpkeSeal` with
    /// a fixed ephemeral key of 32 bytes of 0x02) to the grant key derived
    /// from 32 bytes of 0x01, so both implementations agree on the wire.
    #[test]
    fn a_grant_sealed_by_the_data_browser_opens_here() {
        const FROM_TYPESCRIPT: &str = "s1.zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVloOPsbna7DHyyDtYO13PMaCbQtL-3wYlFWuoVuIC5gf55v1-wPBoVE4Wq5TxeODz5PoFsFf-0qg5BzSzHAsLs9Hoa30M_jY1m8tV-5ywob-LkaKRQ2Kb_MYwJOcKFZTzK_K7P8czU99FadadyQ-C1EOLk3HGFMOyN4-kWw-RxYg6EFx9FHsM2_SFbKj4aVWLf04M1xZry83Prmc-v1N-7dzhpWSXaBYyH4XTlqNDUA2I8udjMkvluVChUjO8TvV1lYTXayANe_dv25ygQbm6xTAqDwECJ8Clvsc7g";
        let grant_key = GrantKey::derive(&[1; 32]);
        assert_eq!(
            grant_key.public_key(),
            "QYUjIP82dJX6UiyUy4OvOR5OiQGDknJbvyCY3ZMbxCQ"
        );
        let sub = "atomic:agent:O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik";
        let key = resolve(
            &headers(FROM_TYPESCRIPT),
            &grant_key,
            CONNECTION,
            &[sub],
            1_790_000_599,
        )
        .unwrap();
        assert_eq!(
            key.to_base64_for_tests(),
            ConnectionKey::from_bytes([9; 32]).to_base64_for_tests()
        );
        assert_eq!(
            resolve(
                &headers(FROM_TYPESCRIPT),
                &grant_key,
                CONNECTION,
                &[sub],
                1_790_000_600
            )
            .unwrap_err(),
            ApiError::InvalidConnectionKey
        );
    }

    #[test]
    fn the_grant_key_pair_is_stable_for_one_secret_and_differs_between_secrets() {
        assert_eq!(
            GrantKey::derive(&[1; 32]).public_key(),
            GrantKey::derive(&[1; 32]).public_key()
        );
        assert_ne!(
            GrantKey::derive(&[1; 32]).public_key(),
            GrantKey::derive(&[2; 32]).public_key()
        );
        assert_eq!(GrantKey::derive(&[1; 32]).public_key().len(), 43);
    }
}
