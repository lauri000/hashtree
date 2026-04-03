use super::resolve_virtual_tree_host;
use axum::http::{header, HeaderMap};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum VirtualTreeRoot {
    Immutable { nhash: String },
    Mutable { npub: String, treename: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ParsedMutableHtreeRequestPath {
    pub npub: String,
    pub treename: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ParsedTreeRequestPath {
    pub pubkey: String,
    pub treename: String,
    pub path: Option<String>,
}

pub(super) fn request_virtual_tree_root(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(resolve_virtual_tree_host)
}

pub(super) fn parse_virtual_tree_root(root: &str) -> Option<VirtualTreeRoot> {
    if let Some(parsed) = parse_mutable_htree_request_path(root) {
        if parsed.path.is_none() {
            return Some(VirtualTreeRoot::Mutable {
                npub: parsed.npub,
                treename: parsed.treename,
            });
        }
    }

    let parsed = reqwest::Url::parse(&format!("http://virtual-host{}", root)).ok()?;
    let segments: Vec<String> = parsed
        .path_segments()?
        .map(|segment| segment.to_string())
        .collect();

    match segments.as_slice() {
        [prefix, nhash] if prefix == "htree" && nhash.starts_with("nhash1") => {
            Some(VirtualTreeRoot::Immutable {
                nhash: nhash.clone(),
            })
        }
        [prefix, npub, treename]
            if prefix == "htree" && npub.starts_with("npub1") && !treename.is_empty() =>
        {
            Some(VirtualTreeRoot::Mutable {
                npub: npub.clone(),
                treename: treename.clone(),
            })
        }
        _ => None,
    }
}

pub(super) fn should_fallback_to_virtual_host_index(
    requested_path: Option<&str>,
    headers: &HeaderMap,
) -> bool {
    let accepts_html = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("text/html"))
        .unwrap_or(false);

    if !accepts_html {
        return false;
    }

    let Some(path) = requested_path else {
        return true;
    };

    let tail = path.rsplit('/').next().unwrap_or(path);
    !tail.contains('.')
}

fn decode_uri_path_segment(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = bytes[index + 1] as char;
            let lo = bytes[index + 2] as char;
            if let (Some(hi), Some(lo)) = (hi.to_digit(16), lo.to_digit(16)) {
                decoded.push(((hi << 4) | lo) as u8);
                index += 3;
                continue;
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8(decoded).unwrap_or_else(|_| segment.to_string())
}

fn parse_request_path_segments(raw_path: &str) -> Option<Vec<String>> {
    let parsed = reqwest::Url::parse(&format!("http://htree{}", raw_path)).ok()?;
    Some(
        parsed
            .path_segments()?
            .map(decode_uri_path_segment)
            .collect(),
    )
}

fn parse_tree_request_segments(
    segments: &[String],
    prefix: &[&str],
) -> Option<ParsedTreeRequestPath> {
    if segments.len() < prefix.len() + 2 {
        return None;
    }
    if !segments
        .iter()
        .zip(prefix.iter())
        .all(|(segment, expected)| segment == expected)
    {
        return None;
    }

    let pubkey = segments.get(prefix.len())?.clone();
    let treename = segments.get(prefix.len() + 1)?.clone();
    if pubkey.is_empty() || treename.is_empty() {
        return None;
    }

    let path = (segments.len() > prefix.len() + 2)
        .then(|| segments[prefix.len() + 2..].join("/"))
        .filter(|value| !value.is_empty());

    Some(ParsedTreeRequestPath {
        pubkey,
        treename,
        path,
    })
}

fn parse_tree_request(raw_path: &str, prefix: &[&str]) -> Option<ParsedTreeRequestPath> {
    let segments = parse_request_path_segments(raw_path)?;
    parse_tree_request_segments(&segments, prefix)
}

pub(super) fn parse_mutable_htree_request_path(
    raw_path: &str,
) -> Option<ParsedMutableHtreeRequestPath> {
    let parsed = parse_tree_request(raw_path, &["htree"])?;
    if !parsed.pubkey.starts_with("npub1") {
        return None;
    }

    Some(ParsedMutableHtreeRequestPath {
        npub: parsed.pubkey,
        treename: parsed.treename,
        path: parsed.path,
    })
}

pub(super) fn parse_resolve_request_path(raw_path: &str) -> Option<ParsedTreeRequestPath> {
    parse_tree_request(raw_path, &["n"])
}

pub(super) fn parse_api_resolve_request_path(raw_path: &str) -> Option<ParsedTreeRequestPath> {
    let segments = parse_request_path_segments(raw_path)?;
    parse_tree_request_segments(&segments, &["api", "resolve"])
        .or_else(|| parse_tree_request_segments(&segments, &["api", "nostr", "resolve"]))
}

pub(super) fn parse_bare_npub_request_path(
    raw_path: &str,
) -> Option<ParsedMutableHtreeRequestPath> {
    let parsed = parse_tree_request(raw_path, &[])?;
    if !parsed.pubkey.starts_with("npub1") {
        return None;
    }

    Some(ParsedMutableHtreeRequestPath {
        npub: parsed.pubkey,
        treename: parsed.treename,
        path: parsed.path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    #[test]
    fn parse_mutable_htree_request_path_decodes_tree_names_with_slashes() {
        assert_eq!(
            parse_mutable_htree_request_path(
                "/htree/npub1example/releases%2Fnostr-vpn/v0.3.0/assets/nostr-vpn-v0.3.0-macos-arm64.zip"
            ),
            Some(ParsedMutableHtreeRequestPath {
                npub: "npub1example".to_string(),
                treename: "releases/nostr-vpn".to_string(),
                path: Some("v0.3.0/assets/nostr-vpn-v0.3.0-macos-arm64.zip".to_string()),
            })
        );
    }

    #[test]
    fn parse_api_resolve_request_path_decodes_tree_names_with_slashes() {
        assert_eq!(
            parse_api_resolve_request_path("/api/resolve/npub1example/releases%2Fnostr-vpn"),
            Some(ParsedTreeRequestPath {
                pubkey: "npub1example".to_string(),
                treename: "releases/nostr-vpn".to_string(),
                path: None,
            })
        );
    }

    #[test]
    fn parse_bare_npub_request_path_decodes_tree_names_with_slashes() {
        assert_eq!(
            parse_bare_npub_request_path("/npub1example/releases%2Fnostr-vpn/latest"),
            Some(ParsedMutableHtreeRequestPath {
                npub: "npub1example".to_string(),
                treename: "releases/nostr-vpn".to_string(),
                path: Some("latest".to_string()),
            })
        );
    }

    #[test]
    fn parse_virtual_tree_root_accepts_immutable_and_mutable_roots() {
        assert_eq!(
            parse_virtual_tree_root("/htree/nhash1example"),
            Some(VirtualTreeRoot::Immutable {
                nhash: "nhash1example".to_string(),
            })
        );

        assert_eq!(
            parse_virtual_tree_root("/htree/npub1example/releases"),
            Some(VirtualTreeRoot::Mutable {
                npub: "npub1example".to_string(),
                treename: "releases".to_string(),
            })
        );
    }

    #[test]
    fn should_fallback_to_virtual_host_index_requires_html_and_extensionless_paths() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, "text/html".parse().unwrap());

        assert!(should_fallback_to_virtual_host_index(None, &headers));
        assert!(should_fallback_to_virtual_host_index(
            Some("/users/npub1example"),
            &headers
        ));
        assert!(!should_fallback_to_virtual_host_index(
            Some("/assets/main.js"),
            &headers
        ));
        headers.insert(header::ACCEPT, "application/json".parse().unwrap());
        assert!(!should_fallback_to_virtual_host_index(None, &headers));
    }
}
