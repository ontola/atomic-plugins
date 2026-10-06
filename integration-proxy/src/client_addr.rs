//! The client network a key check is counted against
//! (`KEY_CHECK_LIMIT_PER_HOUR`, `TRUST_FORWARDED_FOR`).
//!
//! Nothing here is used for anything but that limit: no address is stored,
//! logged or compared otherwise.

use std::net::{IpAddr, SocketAddr};

use axum::http::{header::HeaderName, HeaderMap};

use crate::config::TrustForwardedFor;

const X_FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");

/// The client's address as `mode` says to find it, or `None` when it cannot
/// be told (no peer address was recorded, e.g. a wrapper that serves
/// `build_app` without connect info).
///
/// With [`TrustForwardedFor::RightMost`] that is the right-most
/// `X-Forwarded-For` entry, which Heroku's router (or the one reverse proxy
/// in front) appends; entries to its
/// left are whatever the client sent and are never read. When the
/// right-most entry is missing or not an address, the peer address is used,
/// never an entry further left.
pub(crate) fn client_ip(
    mode: TrustForwardedFor,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Option<IpAddr> {
    let peer = peer.map(|peer| peer.ip());
    match mode {
        TrustForwardedFor::None => peer,
        TrustForwardedFor::RightMost => rightmost_forwarded_for(headers).or(peer),
    }
}

/// The last entry of the last `X-Forwarded-For` line, if it is an address.
fn rightmost_forwarded_for(headers: &HeaderMap) -> Option<IpAddr> {
    let last_line = headers.get_all(X_FORWARDED_FOR).iter().next_back()?;
    let entry = last_line.to_str().ok()?.rsplit(',').next()?.trim();
    entry
        .parse::<IpAddr>()
        .ok()
        .or_else(|| entry.parse::<SocketAddr>().ok().map(|addr| addr.ip()))
}

/// The network the limit counts: an IPv4 address itself, an IPv6 address's
/// /64 (one subscriber usually holds a whole /64), an IPv4-mapped IPv6
/// address as IPv4. `None` is one shared network, `unknown`.
pub(crate) fn network(ip: Option<IpAddr>) -> String {
    match ip.map(|ip| ip.to_canonical()) {
        Some(IpAddr::V4(v4)) => v4.to_string(),
        Some(IpAddr::V6(v6)) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
        None => "unknown".to_owned(),
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
            client_ip(TrustForwardedFor::None, &spoofed, peer()),
            Some("10.1.2.3".parse().unwrap())
        );
        assert_eq!(client_ip(TrustForwardedFor::None, &spoofed, None), None);
    }

    #[test]
    fn heroku_trusts_only_the_entry_its_router_appended() {
        let heroku = TrustForwardedFor::RightMost;
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
            assert_eq!(
                client_ip(heroku, &headers(&lines), peer()),
                Some("198.51.100.7".parse().unwrap()),
                "{lines:?}"
            );
        }
        // Never an entry further left: a broken last entry means the peer.
        for lines in [
            vec![],
            vec!["203.0.113.9,"],
            vec!["203.0.113.9, unknown"],
            vec!["203.0.113.9", ""],
        ] {
            assert_eq!(
                client_ip(heroku, &headers(&lines), peer()),
                Some("10.1.2.3".parse().unwrap()),
                "{lines:?}"
            );
        }
        assert_eq!(
            client_ip(heroku, &headers(&["2001:db8::1"]), peer()),
            Some("2001:db8::1".parse().unwrap())
        );
        assert_eq!(
            client_ip(heroku, &headers(&["[2001:db8::1]:443"]), peer()),
            Some("2001:db8::1".parse().unwrap())
        );
    }

    #[test]
    fn ipv6_counts_per_64_and_mapped_ipv4_as_ipv4() {
        let ip = |text: &str| Some(text.parse::<IpAddr>().unwrap());
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
        assert_eq!(network(None), "unknown");
    }
}
