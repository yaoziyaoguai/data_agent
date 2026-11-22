use crate::types::{Error, Result};
use reqwest::Url;
use std::{env, net::IpAddr};

/// 内网 HTTP 端点来自部署配置。未配置允许集时，本地运行只允许回环地址。
pub fn http_allowed(url: &Url) -> Result<bool> {
    let configured = match env::var("DATA_AGENT_HTTP_UPSTREAMS") {
        Ok(allowed) => Some(allowed),
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => return Err(Error::new("invalid_input")),
    };
    matches_policy(url, configured.as_deref())
}

fn matches_policy(url: &Url, configured: Option<&str>) -> Result<bool> {
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        return Ok(false);
    }
    let host = url.host_str().ok_or(Error::new("invalid_input"))?;
    let host = host.trim_matches(['[', ']']);
    let address = host.parse::<IpAddr>().ok();
    let Some(allowed) = configured else {
        return Ok(host == "localhost" || address.is_some_and(|ip| ip.is_loopback()));
    };
    let mut matches = false;
    for entry in allowed.split(',').map(str::trim).filter(|v| !v.is_empty()) {
        matches |= match entry.split_once('/') {
            Some((network, prefix)) => {
                let network = network
                    .parse::<IpAddr>()
                    .map_err(|_| Error::new("invalid_input"))?;
                let prefix = prefix
                    .parse::<u32>()
                    .map_err(|_| Error::new("invalid_input"))?;
                let width = if network.is_ipv4() { 32 } else { 128 };
                if prefix > width {
                    return Err(Error::new("invalid_input"));
                }
                address.is_some_and(|ip| {
                    ip.is_ipv4() == network.is_ipv4()
                        && (prefix == 0
                            || bits(ip) >> (width - prefix) == bits(network) >> (width - prefix))
                })
            }
            None => host.eq_ignore_ascii_case(entry.trim_matches(['[', ']'])),
        };
    }
    Ok(matches)
}

fn bits(ip: IpAddr) -> u128 {
    match ip {
        IpAddr::V4(ip) => u128::from(u32::from(ip)),
        IpAddr::V6(ip) => u128::from(ip),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_hosts_and_literal_subnets_control_http_upstreams() {
        let policy = Some("platform,172.22.0.0/24,fd33::/64");
        for url in [
            "http://platform:8080",
            "http://172.22.0.5",
            "http://[fd33::10]",
        ] {
            assert!(matches_policy(&Url::parse(url).unwrap(), policy).unwrap());
        }
        for url in [
            "http://other:8080",
            "http://172.22.1.5",
            "http://name@platform:8080",
        ] {
            assert!(!matches_policy(&Url::parse(url).unwrap(), policy).unwrap());
        }
        let local = Url::parse("http://[::1]:8080").unwrap();
        assert!(matches_policy(&local, None).unwrap());
        assert!(!matches_policy(&local, Some("")).unwrap());
        assert!(matches_policy(&local, Some("::1/129")).is_err());
    }
}
