//! htree:// URI scheme handler
//!
//! Handles htree:// protocol requests from Tauri webviews.
//! Instead of duplicating the CombinedStore / tree resolution logic,
//! this handler proxies content requests to the embedded daemon HTTP server.
//!
//! Supported URL formats:
//! 1. NIP-07 API: htree://nip07/ (for child webview signing)
//! 2. Host-based nhash: htree://nhash1abc.../path
//! 3. Host-based npub: htree://npub1xyz.treename/path
//! 4. Legacy path-based: htree:///htree/nhash1.../path

use once_cell::sync::OnceCell;
use tracing::{debug, error, info};

use crate::nip07;

/// Global daemon port - set when daemon starts
static DAEMON_PORT: OnceCell<u16> = OnceCell::new();
static SELF_NPUB: OnceCell<String> = OnceCell::new();

pub fn set_daemon_port(port: u16) {
    let _ = DAEMON_PORT.set(port);
}

pub fn get_daemon_port() -> Option<u16> {
    DAEMON_PORT.get().copied()
}

pub fn set_self_npub(npub: String) {
    let _ = SELF_NPUB.set(npub);
}

pub fn get_self_npub() -> Option<&'static str> {
    SELF_NPUB.get().map(String::as_str)
}

/// Tauri command to get the htree server URL
#[tauri::command]
pub fn get_htree_server_url() -> Option<String> {
    let port = DAEMON_PORT.get().copied().unwrap_or(21417);
    Some(format!("http://127.0.0.1:{}", port))
}

/// Resolve htree:// URL to internal path for daemon proxy
fn resolve_htree_url_to_path(
    host: &str,
    raw_path: &str,
    self_npub: Option<&str>,
) -> Result<String, String> {
    // Strip bare root "/" so we don't get a trailing slash
    let path_suffix = if raw_path == "/" { "" } else { raw_path };
    if host.starts_with("nhash1") {
        Ok(format!("/{}{}", host, path_suffix))
    } else if host == "self" {
        let npub = self_npub.ok_or_else(|| "self identity is not available".to_string())?;
        Ok(format!("/{}{}", npub, path_suffix))
    } else if host.starts_with("npub1") {
        // npub is always 63 chars (npub1 + 58 bech32 chars)
        if host.len() > 63 && host.chars().nth(63) == Some('.') {
            let npub = &host[..63];
            let treename = &host[64..];
            Ok(format!("/{}/{}{}", npub, treename, path_suffix))
        } else {
            Ok(format!("/{}{}", host, path_suffix))
        }
    } else {
        // Legacy path-based format: strip /htree/ prefix
        Ok(raw_path
            .strip_prefix("/htree/")
            .or_else(|| raw_path.strip_prefix("/htree"))
            .unwrap_or(raw_path)
            .to_string())
    }
}

/// Proxy a content request to the embedded daemon HTTP server
fn proxy_to_daemon(
    path_and_query: &str,
    range_header: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    let port = match DAEMON_PORT.get() {
        Some(p) => *p,
        None => {
            return tauri::http::Response::builder()
                .status(503)
                .header("content-type", "text/plain")
                .body(b"Daemon not started yet".to_vec())
                .unwrap();
        }
    };

    let url = format!(
        "http://127.0.0.1:{}/htree/{}",
        port,
        path_and_query.trim_start_matches('/')
    );
    debug!("Proxying htree:// request to daemon: {}", url);

    // Use blocking reqwest since protocol handlers are synchronous
    let client = reqwest::blocking::Client::new();
    let mut request = client.get(&url);
    if let Some(range) = range_header {
        request = request.header("range", range);
    }

    match request.send() {
        Ok(response) => {
            let status = response.status().as_u16();
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            let content_length = response
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let content_range = response
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let accept_ranges = response
                .headers()
                .get("accept-ranges")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            let body = response.bytes().unwrap_or_default().to_vec();

            let mut builder = tauri::http::Response::builder()
                .status(status)
                .header("content-type", content_type);

            if let Some(cl) = content_length {
                builder = builder.header("content-length", cl);
            }
            if let Some(cr) = content_range {
                builder = builder.header("content-range", cr);
            }
            if let Some(ar) = accept_ranges {
                builder = builder.header("accept-ranges", ar);
            }

            builder.body(body).unwrap()
        }
        Err(e) => {
            error!("Daemon proxy error for {}: {}", path_and_query, e);
            tauri::http::Response::builder()
                .status(502)
                .header("content-type", "text/plain")
                .body(format!("Daemon proxy error: {}", e).into_bytes())
                .unwrap()
        }
    }
}

/// Handle htree:// URI scheme protocol requests
pub fn handle_htree_protocol<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let uri = request.uri();
    let host = uri.host().unwrap_or("");
    let raw_path = uri.path();
    let raw_query = uri.query();

    // Handle NIP-07 API requests (htree://nip07/...)
    if host == "nip07" {
        return nip07::handle_nip07_protocol_request(request);
    }

    // Determine path based on URL format
    let resolved_path = match resolve_htree_url_to_path(host, raw_path, get_self_npub()) {
        Ok(path) => path,
        Err(error) => {
            return tauri::http::Response::builder()
                .status(503)
                .header("content-type", "text/plain")
                .body(error.into_bytes())
                .unwrap();
        }
    };

    let path = resolved_path.as_str();
    let path_and_query = if let Some(query) = raw_query {
        format!("{}?{}", path, query)
    } else {
        path.to_string()
    };

    let range_header = request.headers().get("range").and_then(|v| v.to_str().ok());

    info!(
        "htree:// protocol request: host={}, path={}",
        host, path_and_query
    );

    proxy_to_daemon(&path_and_query, range_header)
}

/// Cache tree roots from the frontend for faster resolution.
#[tauri::command]
pub fn cache_tree_root(
    npub: String,
    tree_name: String,
    hash: String,
    key: Option<String>,
    visibility: Option<String>,
) -> Result<(), String> {
    // Forward to daemon's cache if available
    let port = DAEMON_PORT.get().copied().unwrap_or(21417);
    let url = format!("http://127.0.0.1:{}/api/cache-tree-root", port);

    // Fire and forget - best effort cache update
    let body = serde_json::json!({
        "npub": npub,
        "treeName": tree_name,
        "hash": hash,
        "key": key,
        "visibility": visibility.unwrap_or_else(|| "public".to_string()),
    });

    std::thread::spawn(move || {
        let client = reqwest::blocking::Client::new();
        let _ = client.post(&url).json(&body).send();
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_htree_url_to_path_nhash_host() {
        let path = resolve_htree_url_to_path("nhash1abc123xyz", "/index.html", None).unwrap();
        assert_eq!(path, "/nhash1abc123xyz/index.html");
    }

    #[test]
    fn test_resolve_htree_url_to_path_nhash_root() {
        // Root path "/" should not produce trailing slash
        let path = resolve_htree_url_to_path("nhash1abc123xyz", "/", None).unwrap();
        assert_eq!(path, "/nhash1abc123xyz");
    }

    #[test]
    fn test_resolve_htree_url_to_path_npub_host() {
        let npub = "npub1abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuv";
        let host = format!("{}.public", npub);
        let path = resolve_htree_url_to_path(&host, "/index.html", None).unwrap();
        assert_eq!(path, format!("/{}/public/index.html", npub));
    }

    #[test]
    fn test_resolve_htree_url_to_path_legacy_format() {
        let path = resolve_htree_url_to_path("", "/htree/nhash1abc123/index.html", None).unwrap();
        assert_eq!(path, "nhash1abc123/index.html");
    }

    #[test]
    fn test_resolve_htree_url_to_path_self_host() {
        let path = resolve_htree_url_to_path("self", "/video/index.html", Some("npub1owner"))
            .unwrap();
        assert_eq!(path, "/npub1owner/video/index.html");
    }

    #[test]
    fn test_resolve_htree_url_to_path_self_host_requires_identity() {
        let err = resolve_htree_url_to_path("self", "/video/index.html", None)
            .expect_err("self should require identity");
        assert!(err.contains("self identity"));
    }
}
