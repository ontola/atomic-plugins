//! Delivery verification (Webhook Deliveries §4.2.1): HMAC-SHA256 over the
//! exact bytes received, compared in constant time, before anything in the
//! body is read.

use axum::http::HeaderMap;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};

use super::metadata::{Encoding, Profile};

/// Why a delivery was refused. Logged as a class only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    Secret,
    Signature,
    Timestamp,
    Mismatch,
}

/// The one value of a header: refused when missing, repeated or not
/// visible ASCII.
pub fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    value.to_str().ok()
}

fn decode(profile: &Profile, value: &str) -> Option<Vec<u8>> {
    let encoded = value.strip_prefix(profile.prefix.as_str())?;
    match profile.encoding {
        Encoding::Hex => {
            if encoded.len() != 64 || !encoded.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            (0..32)
                .map(|i| u8::from_str_radix(encoded.get(2 * i..2 * i + 2)?, 16).ok())
                .collect()
        }
        Encoding::Base64 => STANDARD.decode(encoded).ok().filter(|mac| mac.len() == 32),
    }
}

/// Verifies `body` as received against the profile and secret, at
/// `now_secs`. Nothing about the body is looked at.
pub fn verify(
    profile: &Profile,
    headers: &HeaderMap,
    body: &[u8],
    secret: &[u8],
    now_secs: u64,
) -> Result<(), Refused> {
    if secret.len() < profile.min_secret_bytes {
        return Err(Refused::Secret);
    }
    let signature = single_header(headers, &profile.signature_header)
        .and_then(|value| decode(profile, value))
        .ok_or(Refused::Signature)?;
    let mut mac =
        <Hmac<sha2::Sha256> as Mac>::new_from_slice(secret).expect("HMAC accepts any key length");
    if let Some((name, tolerance)) = &profile.timestamp {
        let stamp = single_header(headers, name).ok_or(Refused::Timestamp)?;
        if stamp.is_empty() || stamp.len() > 12 || !stamp.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Refused::Timestamp);
        }
        let seconds: u64 = stamp.parse().map_err(|_| Refused::Timestamp)?;
        if seconds.abs_diff(now_secs) > *tolerance {
            return Err(Refused::Timestamp);
        }
        mac.update(stamp.as_bytes());
        mac.update(b".");
    }
    mac.update(body);
    // `verify_slice` compares in constant time.
    mac.verify_slice(&signature).map_err(|_| Refused::Mismatch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webhooks::metadata::Deliveries;
    use axum::http::{HeaderName, HeaderValue};

    // Invented for the spec's fixtures; never configured anywhere.
    const GITHUB_FIXTURE_SECRET: &[u8] = b"fixture-only-github-app-secret-not-real-0000";
    const TRACKER_HOOK_SECRET: &[u8] = b"fixture-only-project-hook-secret-not-real-00";
    const FIXTURE_NOW: u64 = 1_791_460_800;

    pub(crate) fn examples() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../openapi-extensions/spec/webhook-deliveries/examples")
    }

    pub(crate) fn fixture_delivery(name: &str) -> (HeaderMap, Vec<u8>) {
        let data: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(examples().join(name)).unwrap()).unwrap();
        let mut headers = HeaderMap::new();
        for pair in data["headers"].as_array().unwrap() {
            headers.append(
                HeaderName::from_bytes(pair[0].as_str().unwrap().as_bytes()).unwrap(),
                HeaderValue::from_str(pair[1].as_str().unwrap()).unwrap(),
            );
        }
        (headers, data["body"].as_str().unwrap().as_bytes().to_vec())
    }

    fn document(name: &str) -> Deliveries {
        let text = std::fs::read_to_string(examples().join(name)).unwrap();
        Deliveries::from_document(&serde_yaml::from_str(&text).unwrap()).unwrap()
    }

    #[test]
    fn the_synthetic_github_fixture_verifies_over_its_raw_body() {
        let deliveries = document("github-fixture.yaml");
        let profile = &deliveries.profiles["githubApp"];
        let (headers, body) = fixture_delivery("github-deliveries/issues-edited.json");
        verify(profile, &headers, &body, GITHUB_FIXTURE_SECRET, FIXTURE_NOW).unwrap();
        // Re-serialized, the same JSON no longer verifies.
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let pretty = serde_json::to_vec_pretty(&parsed).unwrap();
        assert_eq!(
            verify(
                profile,
                &headers,
                &pretty,
                GITHUB_FIXTURE_SECRET,
                FIXTURE_NOW
            ),
            Err(Refused::Mismatch)
        );
        assert_eq!(
            verify(
                profile,
                &headers,
                &body,
                b"another-fixture-secret-that-is-also-fake-00",
                FIXTURE_NOW
            ),
            Err(Refused::Mismatch)
        );
        assert_eq!(
            verify(profile, &headers, &body, b"short", FIXTURE_NOW),
            Err(Refused::Secret)
        );
    }

    #[test]
    fn missing_repeated_or_malformed_signatures_are_refused() {
        let deliveries = document("github-fixture.yaml");
        let profile = &deliveries.profiles["githubApp"];
        let (headers, body) = fixture_delivery("github-deliveries/issues-edited.json");
        let signature = headers
            .get("x-hub-signature-256")
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let with = |value: Option<&str>, repeat: bool| {
            let mut h = headers.clone();
            h.remove("x-hub-signature-256");
            if let Some(value) = value {
                h.append("x-hub-signature-256", HeaderValue::from_str(value).unwrap());
                if repeat {
                    h.append("x-hub-signature-256", HeaderValue::from_str(value).unwrap());
                }
            }
            h
        };
        for (case, repeat) in [
            (None, false),
            (Some(signature.as_str()), true),
            (Some(&signature[7..]), false),
            (Some(&signature[..signature.len() - 2]), false),
            (Some(&format!("sha1={}", &signature[7..])), false),
            (Some(&format!("sha256={}", "zz".repeat(32))), false),
        ] {
            assert_eq!(
                verify(
                    profile,
                    &with(case, repeat),
                    &body,
                    GITHUB_FIXTURE_SECRET,
                    FIXTURE_NOW
                ),
                Err(Refused::Signature),
                "{case:?} repeated={repeat}"
            );
        }
        let upper = format!("sha256={}", signature[7..].to_ascii_uppercase());
        verify(
            profile,
            &with(Some(&upper), false),
            &body,
            GITHUB_FIXTURE_SECRET,
            FIXTURE_NOW,
        )
        .unwrap();
    }

    #[test]
    fn a_signed_timestamp_bounds_replay() {
        let deliveries = document("tracker.yaml");
        let profile = &deliveries.profiles["projectHook"];
        let (headers, body) = fixture_delivery("tracker-deliveries/task-updated-project-hook.json");
        for now in [FIXTURE_NOW - 300, FIXTURE_NOW, FIXTURE_NOW + 300] {
            verify(profile, &headers, &body, TRACKER_HOOK_SECRET, now).unwrap();
        }
        for now in [FIXTURE_NOW - 301, FIXTURE_NOW + 301] {
            assert_eq!(
                verify(profile, &headers, &body, TRACKER_HOOK_SECRET, now),
                Err(Refused::Timestamp)
            );
        }
        for stamp in ["1791460801", "+1791460800", "0001791460800", "1791460800.0"] {
            let mut h = headers.clone();
            h.insert("tracker-timestamp", HeaderValue::from_str(stamp).unwrap());
            assert!(
                verify(profile, &h, &body, TRACKER_HOOK_SECRET, FIXTURE_NOW).is_err(),
                "{stamp}"
            );
        }
    }
}
