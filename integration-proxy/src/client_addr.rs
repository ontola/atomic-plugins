//! The client network a key check, or a webhook delivery, is counted
//! against (`KEY_CHECK_LIMIT_PER_HOUR`, `WEBHOOK_INGRESS_LIMIT_PER_NETWORK`,
//! `TRUST_FORWARDED_FOR`).
//!
//! Nothing here is used for anything but those limits: no address is
//! stored, logged or compared otherwise.

use std::net::{IpAddr, SocketAddr};

#[cfg(test)]
use axum::http::HeaderValue;
use axum::http::{header::HeaderName, HeaderMap};

use crate::config::TrustForwardedFor;

const X_FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");

/// The shared network of every check under [`TrustForwardedFor::RightMost`]
/// whose right-most `X-Forwarded-For` entry is missing or not an address.
pub(crate) const UNPARSEABLE: &str = "unparseable";
/// The shared network of every check under [`TrustForwardedFor::None`]
/// without a recorded peer address (e.g. a wrapper that serves `build_app`
/// without connect info).
pub(crate) const UNKNOWN: &str = "unknown";

/// The network a key check counts against, found as `mode` says.
///
/// With [`TrustForwardedFor::None`] that is the peer address's network, or
/// [`UNKNOWN`] when none was recorded.
///
/// With [`TrustForwardedFor::RightMost`] it is the network of the right-most
/// `X-Forwarded-For` entry, which Heroku's router (or the one reverse proxy
/// in front) appends; entries to its left are whatever the client sent and
/// are never read. When that entry is missing or not an address the
/// network is [`UNPARSEABLE`], one fixed bucket: never the peer (behind
/// Heroku a router address that many clients share), never an entry
/// further left. The line is split on bytes and only the last entry is
/// decoded, so a non-UTF-8 byte the client put on the line cannot make
/// the router's entry unreadable.
pub(crate) fn client_network(
    mode: TrustForwardedFor,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> String {
    match mode {
        TrustForwardedFor::None => peer.map_or_else(|| UNKNOWN.to_owned(), |p| network(p.ip())),
        TrustForwardedFor::RightMost => {
            rightmost_forwarded_for(headers).map_or_else(|| UNPARSEABLE.to_owned(), network)
        }
    }
}

/// The last entry of the last `X-Forwarded-For` line, if it is an address
/// (`ip`, `ip:port`, `[ipv6]` or `[ipv6]:port`). A bare zone index
/// (`fe80::1%eth0`) is not accepted; a bracketed numeric zone with a port
/// (`[fe80::1%3]:80`) parses, and only the network's /64 is used.
fn rightmost_forwarded_for(headers: &HeaderMap) -> Option<IpAddr> {
    let last_line = headers.get_all(X_FORWARDED_FOR).iter().next_back()?;
    let last_entry = last_line.as_bytes().rsplit(|&b| b == b',').next()?;
    let entry = std::str::from_utf8(last_entry).ok()?.trim();
    let unbracketed = entry
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(entry);
    unbracketed
        .parse::<IpAddr>()
        .ok()
        .or_else(|| entry.parse::<SocketAddr>().ok().map(|addr| addr.ip()))
}

/// The network the limit counts: an IPv4 address itself, an IPv6 address's
/// /64 (one subscriber usually holds a whole /64), an IPv4-mapped IPv6
/// address as IPv4.
pub(crate) fn network(ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(lines: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for line in lines {
            headers.append(X_FORWARDED_FOR, line.parse().unwrap());
        }
        headers
    }

    fn peer() -> Option<SocketAddr> {
        Some("10.1.2.3:4567".parse().unwrap())
    }

    #[test]
    fn without_trust_only_the_peer_counts() {
        let spoofed = headers(&["203.0.113.9", "198.51.100.7"]);
        assert_eq!(
            client_network(TrustForwardedFor::None, &spoofed, peer()),
            "10.1.2.3"
        );
        assert_eq!(
            client_network(TrustForwardedFor::None, &spoofed, None),
            UNKNOWN
        );
    }

    #[test]
    fn heroku_trusts_only_the_entry_its_router_appended() {
        let at = |lines: Vec<HeaderValue>| {
            let mut map = HeaderMap::new();
            for line in lines {
                map.append(X_FORWARDED_FOR, line);
            }
            client_network(TrustForwardedFor::RightMost, &map, peer())
        };
        let text = |lines: &[&str]| -> Vec<HeaderValue> {
            lines.iter().map(|line| line.parse().unwrap()).collect()
        };
        let raw = |bytes: &[u8]| vec![HeaderValue::from_bytes(bytes).unwrap()];
        // The client sent the first entries; the router appended the last.
        for lines in [
            vec!["198.51.100.7"],
            vec!["203.0.113.9, 198.51.100.7"],
            vec!["203.0.113.9,198.51.100.7"],
            vec!["not an address, 203.0.113.9 , 198.51.100.7"],
            vec!["203.0.113.9", "198.51.100.7"],
            vec!["203.0.113.9, 192.0.2.1", "198.51.100.7"],
            vec!["198.51.100.7:1234"],
        ] {
            assert_eq!(at(text(&lines)), "198.51.100.7", "{lines:?}");
        }
        // A non-UTF-8 byte from the client does not hide the router's entry
        // (before, the whole line failed to decode and the router's own
        // address, shared by everyone, was counted instead).
        for line in [
            &b"\x80, 198.51.100.7"[..],
            &b"\xff\xfe,198.51.100.7"[..],
            &b"203.0.113.9 \x80, 198.51.100.7"[..],
        ] {
            assert_eq!(at(raw(line)), "198.51.100.7", "{line:?}");
        }
        // Never the peer and never an entry further left: a missing or
        // broken last entry is one fixed network.
        for lines in [
            vec![],
            vec!["203.0.113.9,"],
            vec!["203.0.113.9, unknown"],
            vec!["203.0.113.9", ""],
            vec!["203.0.113.9, fe80::1%eth0"],
            vec!["203.0.113.9, [2001:db8::1"],
        ] {
            assert_eq!(at(text(&lines)), UNPARSEABLE, "{lines:?}");
        }
        assert_eq!(at(raw(b"198.51.100.7, \x80")), UNPARSEABLE);
        assert_eq!(at(raw(b"\x80")), UNPARSEABLE);
        // IPv6: bare, bracketed, bracketed with a port.
        for entry in ["2001:db8::1", "[2001:db8::1]", "[2001:db8::1]:443"] {
            assert_eq!(at(text(&[entry])), "2001:db8:0:0::/64", "{entry}");
        }
    }

    #[test]
    fn ipv6_counts_per_64_and_mapped_ipv4_as_ipv4() {
        let ip = |text: &str| text.parse::<IpAddr>().unwrap();
        assert_eq!(network(ip("198.51.100.7")), "198.51.100.7");
        assert_eq!(network(ip("::ffff:198.51.100.7")), "198.51.100.7");
        assert_eq!(network(ip("2001:db8:1:2:3:4:5:6")), "2001:db8:1:2::/64");
        assert_eq!(
            network(ip("2001:db8:1:2:ffff::1")),
            network(ip("2001:db8:1:2::9"))
        );
        assert_ne!(
            network(ip("2001:db8:1:2::1")),
            network(ip("2001:db8:1:3::1"))
        );
    }
}
