//! Resolve client addresses only across explicitly trusted proxy hops.
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request};
use axum::http::HeaderMap;
use ipnet::IpNet;

use crate::Error;

const MAX_HEADER_BYTES: usize = 4096;
const MAX_HOPS: usize = 32;

#[derive(Clone, Default)]
pub(crate) struct ClientIps {
    trusted: Arc<[IpNet]>,
}

impl ClientIps {
    pub(crate) fn from_env() -> Result<Self, Error> {
        match std::env::var("I2N_TRUSTED_PROXIES") {
            Ok(value) => Self::parse(&value),
            Err(std::env::VarError::NotPresent) => Ok(Self::default()),
            Err(_) => Err(Error::Config(
                "I2N_TRUSTED_PROXIES must be valid text".into(),
            )),
        }
    }

    pub(crate) fn parse(text: &str) -> Result<Self, Error> {
        let mut trusted = Vec::new();
        if !text.trim().is_empty() {
            for value in text.split(',').map(str::trim) {
                let network = value.parse::<IpNet>().or_else(|_| value.parse::<IpAddr>().map(IpNet::from))
                    .map_err(|_| Error::Config("I2N_TRUSTED_PROXIES must contain comma-separated IP addresses or CIDRs".into()))?;
                trusted.push(network);
            }
        }
        Ok(Self {
            trusted: trusted.into(),
        })
    }

    pub(crate) fn source(&self, request: &Request) -> Option<IpAddr> {
        let peer = canonical(
            request
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()?
                .0
                .ip(),
        );
        if !self.trusted(peer) {
            return Some(peer);
        }
        let headers = request.headers();
        if headers.contains_key("x-forwarded-for") {
            return Some(
                self.chain(peer, headers, "x-forwarded-for", false)
                    .unwrap_or(peer),
            );
        }
        if headers.contains_key("forwarded") {
            return Some(self.chain(peer, headers, "forwarded", true).unwrap_or(peer));
        }
        if headers.contains_key("x-real-ip") {
            let mut values = headers.get_all("x-real-ip").iter();
            let first = values.next()?;
            let ip = if values.next().is_none() && first.as_bytes().len() <= MAX_HEADER_BYTES {
                first.to_str().ok().and_then(parse_address)
            } else {
                None
            };
            return Some(ip.unwrap_or(peer));
        }
        Some(peer)
    }

    fn trusted(&self, ip: IpAddr) -> bool {
        self.trusted.iter().any(|network| network.contains(&ip))
    }

    fn chain(
        &self,
        peer: IpAddr,
        headers: &HeaderMap,
        name: &str,
        forwarded: bool,
    ) -> Option<IpAddr> {
        let mut bytes = 0;
        let mut hops = Vec::new();
        for value in headers.get_all(name) {
            bytes += value.as_bytes().len();
            if bytes > MAX_HEADER_BYTES {
                return None;
            }
            for hop in value.to_str().ok()?.split(',') {
                if hops.len() == MAX_HOPS {
                    return None;
                }
                hops.push(hop.trim());
            }
        }
        let mut ip = peer;
        for hop in hops.into_iter().rev() {
            if !self.trusted(ip) {
                break;
            }
            let address = if forwarded { forwarded_for(hop)? } else { hop };
            ip = parse_address(address)?;
        }
        Some(ip)
    }
}

fn forwarded_for(hop: &str) -> Option<&str> {
    let mut address = None;
    for pair in hop.split(';') {
        let (name, value) = pair.trim().split_once('=')?;
        if name.trim().eq_ignore_ascii_case("for") {
            if address.is_some() {
                return None;
            }
            address = Some(value.trim());
        }
    }
    address
}

fn parse_address(text: &str) -> Option<IpAddr> {
    let text = text.trim();
    let text = if let Some(quoted) = text.strip_prefix('"') {
        quoted.strip_suffix('"')?
    } else {
        text
    };
    let ip = text
        .parse::<IpAddr>()
        .ok()
        .or_else(|| text.parse::<SocketAddr>().ok().map(|address| address.ip()))
        .or_else(|| text.strip_prefix('[')?.strip_suffix(']')?.parse().ok())?;
    Some(canonical(ip))
}

fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        ip => ip,
    }
}

/// IPv6 privacy-address rotation within a subnet must not reset the budget.
pub(crate) fn rate_key(ip: Option<IpAddr>) -> Option<IpAddr> {
    ip.map(canonical).map(|ip| match ip {
        IpAddr::V6(ip) => IpAddr::V6((u128::from(ip) & (u128::MAX << 64)).into()),
        ip => ip,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{HeaderValue, Request as HttpRequest};

    fn request(peer: Option<&str>, headers: &[(&str, &str)]) -> Request {
        let mut request = HttpRequest::builder().uri("/").body(Body::empty()).unwrap();
        if let Some(peer) = peer {
            request
                .extensions_mut()
                .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
        }
        for (name, value) in headers {
            request.headers_mut().append(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        request
    }

    #[test]
    fn proxy_configuration_requires_explicit_valid_ips_or_cidrs() {
        for input in [
            "bad",
            "127.0.0.1,",
            "0.0.0.0/33",
            "::1/129",
            "https://proxy",
            "127.0.0.1:80",
        ] {
            assert!(ClientIps::parse(input).is_err(), "{input}");
        }
        assert!(!ClientIps::default().trusted("127.0.0.1".parse().unwrap()));
        let ips = ClientIps::parse("127.0.0.1, ::1/128, 10.0.0.0/8").unwrap();
        assert!(ips.trusted("127.0.0.1".parse().unwrap()));
        assert!(ips.trusted("10.1.2.3".parse().unwrap()));
        assert!(!ips.trusted("198.51.100.1".parse().unwrap()));
    }

    #[test]
    fn trusted_chains_stop_at_first_untrusted_hop_and_respect_precedence() {
        let ips = ClientIps::parse("127.0.0.1,10.0.0.0/8,2001:db8:1::/64").unwrap();
        for (headers, expected) in [
            (
                vec![("x-forwarded-for", "spoofed, 198.51.100.7, 10.0.0.1")],
                "198.51.100.7",
            ),
            (
                vec![
                    ("x-forwarded-for", "198.51.100.7"),
                    ("x-forwarded-for", "10.0.0.1"),
                ],
                "198.51.100.7",
            ),
            (
                vec![(
                    "forwarded",
                    "for=198.51.100.7;proto=https, For=\"[2001:db8:1::1]:1234\"",
                )],
                "198.51.100.7",
            ),
            (vec![("x-real-ip", "198.51.100.7:1234")], "198.51.100.7"),
            (vec![("x-real-ip", "[2001:db8:2::7]")], "2001:db8:2::7"),
            (
                vec![("x-forwarded-for", "[2001:db8:2::7]:1234")],
                "2001:db8:2::7",
            ),
            (
                vec![("x-forwarded-for", "::ffff:198.51.100.7")],
                "198.51.100.7",
            ),
            (
                vec![
                    ("x-forwarded-for", "198.51.100.7"),
                    ("forwarded", "for=192.0.2.1"),
                    ("x-real-ip", "192.0.2.2"),
                ],
                "198.51.100.7",
            ),
        ] {
            assert_eq!(
                ips.source(&request(Some("127.0.0.1:1234"), &headers)),
                Some(expected.parse().unwrap()),
                "{headers:?}"
            );
        }
    }

    #[test]
    fn malformed_or_untrusted_headers_never_supply_a_client_identity() {
        let ips = ClientIps::parse("127.0.0.1").unwrap();
        for headers in [
            vec![
                ("x-forwarded-for", "garbage"),
                ("x-real-ip", "198.51.100.7"),
            ],
            vec![("x-forwarded-for", "198.51.100.7,")],
            vec![("forwarded", "for=unknown")],
            vec![("forwarded", "for=_hidden")],
            vec![("forwarded", "for=198.51.100.7;for=192.0.2.1")],
            vec![("forwarded", "proto=https")],
            vec![("x-real-ip", "198.51.100.7, 192.0.2.1")],
            vec![("x-real-ip", "198.51.100.7"), ("x-real-ip", "192.0.2.1")],
            vec![("cf-connecting-ip", "198.51.100.7")],
        ] {
            assert_eq!(
                ips.source(&request(Some("127.0.0.1:1234"), &headers)),
                Some("127.0.0.1".parse().unwrap())
            );
        }
        let oversized = "x".repeat(MAX_HEADER_BYTES + 1);
        let too_many = std::iter::repeat_n("10.0.0.1", MAX_HOPS + 1)
            .collect::<Vec<_>>()
            .join(",");
        for value in [&oversized, &too_many] {
            assert_eq!(
                ips.source(&request(
                    Some("127.0.0.1:1234"),
                    &[("x-forwarded-for", value)]
                )),
                Some("127.0.0.1".parse().unwrap())
            );
        }
        let headers = [("x-forwarded-for", "198.51.100.7")];
        assert_eq!(
            ips.source(&request(Some("192.0.2.1:1234"), &headers)),
            Some("192.0.2.1".parse().unwrap())
        );
        assert_eq!(ips.source(&request(None, &headers)), None);
        assert_eq!(
            ClientIps::default().source(&request(Some("[::ffff:192.0.2.1]:1234"), &headers)),
            Some("192.0.2.1".parse().unwrap())
        );
    }

    #[test]
    fn ipv6_privacy_addresses_share_a_subnet_budget_and_mapped_ipv4_stays_ipv4() {
        assert_eq!(
            rate_key(Some("2001:db8:1:2::1".parse().unwrap())),
            rate_key(Some("2001:db8:1:2::ffff".parse().unwrap()))
        );
        assert_ne!(
            rate_key(Some("2001:db8:1:2::1".parse().unwrap())),
            rate_key(Some("2001:db8:1:3::1".parse().unwrap()))
        );
        assert_eq!(
            rate_key(Some("::ffff:192.0.2.1".parse().unwrap())),
            Some("192.0.2.1".parse().unwrap())
        );
    }
}
