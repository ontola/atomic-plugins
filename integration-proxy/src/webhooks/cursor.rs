//! Opaque generations and cursors (`webhook-subscriptions` §4.2).
//!
//! A cursor is base64url of its generation and position (8 bytes each,
//! big-endian) and the first 16 bytes of an HMAC-SHA256 over the
//! subscription id, generation and position, under a subkey of
//! `ENCRYPTION_KEY`. A consumer cannot edit one into a position it was not
//! given, or carry one to another subscription; whether a position was
//! returned yet is checked against the subscription row as well.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};

pub const SUBKEY_LABEL: &[u8] = b"integration-proxy-webhook-cursor-v1";
const MAC_BYTES: usize = 16;

#[derive(Clone)]
pub struct CursorKey([u8; 32]);

impl CursorKey {
    pub fn new(key: [u8; 32]) -> Self {
        Self(key)
    }

    fn mac(&self, subscription: &str, generation: i64, seq: i64) -> Hmac<sha2::Sha256> {
        let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(&self.0)
            .expect("HMAC accepts any key length");
        mac.update(subscription.as_bytes());
        mac.update(b"\0");
        mac.update(&generation.to_be_bytes());
        mac.update(&seq.to_be_bytes());
        mac
    }

    pub fn encode(&self, subscription: &str, generation: i64, seq: i64) -> String {
        let tag = self
            .mac(subscription, generation, seq)
            .finalize()
            .into_bytes();
        let mut bytes = Vec::with_capacity(16 + MAC_BYTES);
        bytes.extend_from_slice(&generation.to_be_bytes());
        bytes.extend_from_slice(&seq.to_be_bytes());
        bytes.extend_from_slice(&tag[..MAC_BYTES]);
        URL_SAFE_NO_PAD.encode(bytes)
    }

    /// `(generation, position)`, if this key issued `cursor` for
    /// `subscription`. The tag is compared in constant time.
    pub fn decode(&self, subscription: &str, cursor: &str) -> Option<(i64, i64)> {
        if cursor.len() > 64 {
            return None;
        }
        let bytes = URL_SAFE_NO_PAD.decode(cursor).ok()?;
        if bytes.len() != 16 + MAC_BYTES {
            return None;
        }
        let generation = i64::from_be_bytes(bytes[..8].try_into().ok()?);
        let seq = i64::from_be_bytes(bytes[8..16].try_into().ok()?);
        if generation < 1 || seq < 0 {
            return None;
        }
        self.mac(subscription, generation, seq)
            .verify_truncated_left(&bytes[16..])
            .ok()?;
        Some((generation, seq))
    }
}

/// The opaque form of a generation number. Generations are not secret;
/// the receiver checks every one against the subscription row.
pub fn generation_token(generation: i64) -> String {
    format!("g{generation}")
}

pub fn parse_generation(token: &str) -> Option<i64> {
    let digits = token.strip_prefix('g')?;
    if digits.is_empty() || digits.len() > 18 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|generation| *generation >= 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_round_trip_and_refuse_edits_and_other_subscriptions() {
        let key = CursorKey::new([7; 32]);
        let cursor = key.encode("sub-a", 3, 42);
        assert!(cursor
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_eq!(key.decode("sub-a", &cursor), Some((3, 42)));
        assert_eq!(key.decode("sub-b", &cursor), None);
        assert_eq!(CursorKey::new([8; 32]).decode("sub-a", &cursor), None);

        // Moving the position forward without the key is refused.
        let mut bytes = URL_SAFE_NO_PAD.decode(&cursor).unwrap();
        bytes[15] += 1;
        assert_eq!(key.decode("sub-a", &URL_SAFE_NO_PAD.encode(&bytes)), None);
        // A truncated tag is refused rather than checked on fewer bytes.
        bytes[15] -= 1;
        bytes.truncate(24);
        assert_eq!(key.decode("sub-a", &URL_SAFE_NO_PAD.encode(&bytes)), None);
        for junk in ["", "!!", "g1", &"A".repeat(65)] {
            assert_eq!(key.decode("sub-a", junk), None, "{junk}");
        }
    }

    #[test]
    fn generation_tokens() {
        assert_eq!(generation_token(1), "g1");
        assert_eq!(parse_generation("g12"), Some(12));
        for invalid in [
            "",
            "g",
            "g0",
            "g-1",
            "12",
            "g1x",
            "G1",
            "g+1",
            "g9999999999999999999",
        ] {
            assert_eq!(parse_generation(invalid), None, "{invalid}");
        }
    }
}
