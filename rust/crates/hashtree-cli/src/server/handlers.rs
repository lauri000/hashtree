use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{header, Response, StatusCode},
    response::{IntoResponse, Json},
};
use bytes::Bytes;
use futures::stream::{self, StreamExt};
use hashtree_core::{from_hex, to_hex, nhash_decode, Cid, HashTree, HashTreeConfig, LinkType, Store};
use hashtree_resolver::{nostr::{NostrRootResolver, NostrResolverConfig}, RootResolver};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use super::auth::AppState;
use super::mime::get_mime_type;
use super::ui::root_page;
use crate::socialgraph;
use crate::webrtc::{ConnectionState, WebRTCState};

pub async fn serve_root() -> impl IntoResponse {
    root_page()
}

pub async fn htree_test() -> impl IntoResponse {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from("ok"))
        .unwrap()
}

async fn list_directory_json(
    state: &AppState,
    cid: &Cid,
    is_immutable: bool,
    is_localhost: bool,
) -> Response<Body> {
    let store = state.store.store_arc();
    let tree = HashTree::new(HashTreeConfig::new(store).public());
    let entries = match tree.list_directory(cid).await {
        Ok(list) => list,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(format!("Error: {}", e)))
                .unwrap();
        }
    };

    let payload = json!({
        "entries": entries.into_iter().map(|entry| {
            json!({
                "name": entry.name,
                "hash": to_hex(&entry.hash),
                "key": entry.key.map(|key| to_hex(&key)),
                "size": entry.size,
                "type": match entry.link_type {
                    LinkType::Blob => "blob",
                    LinkType::File => "file",
                    LinkType::Dir => "dir",
                },
            })
        }).collect::<Vec<_>>(),
    });

    build_json_response(payload, is_immutable, is_localhost)
}

async fn resolve_npub_root(
    key: &str,
    resolver: &NostrRootResolver,
    share_secret: Option<[u8; 32]>,
) -> Result<Cid, hashtree_resolver::ResolverError> {
    if let Some(secret) = share_secret {
        loop {
            if let Some(cid) = resolver.resolve_shared(key, &secret).await? {
                return Ok(cid);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    resolver.resolve_wait(key).await
}

/// Try to fetch a blob from WebRTC peers and upstream Blossom servers, caching locally.
/// Returns true if the blob was fetched and cached, false otherwise.
async fn fetch_and_cache_blob(state: &AppState, hash: &[u8]) -> bool {
    let hash_hex = hex::encode(hash);
    tracing::info!("[htree-fetch] Trying to fetch blob {} from upstream", &hash_hex[..16.min(hash_hex.len())]);

    // Try WebRTC peers first
    if let Some(ref webrtc_state) = state.webrtc_peers {
        tracing::info!("[htree-fetch] Querying WebRTC peers for {}", &hash_hex[..16.min(hash_hex.len())]);
        if let Some((data, peer_id)) = query_webrtc_peers(webrtc_state, &hash_hex).await {
            tracing::info!("[htree-fetch] Got {} bytes from peer {} for {}", data.len(), peer_id, &hash_hex[..16.min(hash_hex.len())]);
            if let Err(e) = state.store.put_blob(&data) {
                tracing::warn!("[htree-fetch] Failed to cache peer data: {}", e);
            }
            return true;
        }
    }

    // Try upstream Blossom servers
    if !state.upstream_blossom.is_empty() {
        tracing::info!("[htree-fetch] Querying {} Blossom servers for {}", state.upstream_blossom.len(), &hash_hex[..16.min(hash_hex.len())]);
        if let Some((data, server)) = query_upstream_blossom(&state.upstream_blossom, &hash_hex).await {
            tracing::info!("[htree-fetch] Got {} bytes from upstream {} for {}", data.len(), server, &hash_hex[..16.min(hash_hex.len())]);
            if let Err(e) = state.store.put_blob(&data) {
                tracing::warn!("[htree-fetch] Failed to cache upstream data: {}", e);
            }
            return true;
        }
        tracing::info!("[htree-fetch] No upstream had {}", &hash_hex[..16.min(hash_hex.len())]);
    } else {
        tracing::info!("[htree-fetch] No upstream Blossom servers configured");
    }

    false
}

async fn htree_nhash_impl(
    State(state): State<AppState>,
    nhash: String,
    path: Option<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    connect_info: axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> Response<Body> {
    let is_localhost = connect_info.0.ip().is_loopback();

    let nhash_data = match nhash_decode(&nhash) {
        Ok(data) => data,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(format!("Invalid nhash: {}", e)))
                .unwrap();
        }
    };

    let mut cid = Cid {
        hash: nhash_data.hash,
        key: nhash_data.decrypt_key,
    };

    if cid.key.is_none() {
        if let Some(k) = parse_hex_key(params.get("k")) {
            cid.key = Some(k);
        }
    }

    let mut effective_path = path.filter(|p| !p.is_empty());
    if effective_path.is_none() && !nhash_data.path.is_empty() {
        effective_path = Some(nhash_data.path.join("/"));
    }

    let store = state.store.store_arc();
    let tree = HashTree::new(HashTreeConfig::new(store).public());

    // If root not in local store, try fetching from upstream
    if tree.get(&cid).await.ok().flatten().is_none() {
        fetch_and_cache_blob(&state, &cid.hash).await;
    }

    let is_dir = tree.is_dir(&cid).await.unwrap_or(false);

    if is_dir {
        if let Some(path) = effective_path.clone() {
            let entry = match tree.resolve_path(&cid, &path).await {
                Ok(Some(entry)) => entry,
                Ok(None) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(Body::from("File not found"))
                        .unwrap();
                }
                Err(e) => {
                    return Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(Body::from(format!("Error: {}", e)))
                        .unwrap();
                }
            };
            return serve_cid_with_range(&state, &entry, headers, true, is_localhost, Some(&path)).await;
        }

        return list_directory_json(&state, &cid, true, is_localhost).await;
    }

    if let Some(path) = effective_path.clone() {
        if path.contains('/') {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from("Not found"))
                .unwrap();
        }
    }

    serve_cid_with_range(&state, &cid, headers, true, is_localhost, effective_path.as_deref()).await
}

pub async fn htree_nhash(
    State(state): State<AppState>,
    Path(nhash): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    connect_info: axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> impl IntoResponse {
    let full = format!("nhash1{}", nhash);
    htree_nhash_impl(State(state), full, None, Query(params), headers, connect_info).await
}

pub async fn htree_nhash_path(
    State(state): State<AppState>,
    Path((nhash, path)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    connect_info: axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> impl IntoResponse {
    let full = format!("nhash1{}", nhash);
    htree_nhash_impl(
        State(state),
        full,
        Some(path),
        Query(params),
        headers,
        connect_info,
    )
    .await
}

const THUMBNAIL_PATTERNS: &[&str] = &[
    "thumbnail.jpg",
    "thumbnail.webp",
    "thumbnail.png",
    "thumbnail.jpeg",
];

const VIDEO_EXTENSIONS: &[&str] = &[".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v"];

fn is_video_filename(name: &str) -> bool {
    name.starts_with("video.")
        || VIDEO_EXTENSIONS.iter().any(|ext| name.ends_with(ext))
}

fn is_metadata_filename(name: &str) -> bool {
    name.ends_with(".json") || name.ends_with(".txt")
}

fn is_thumbnail_request(path: &str) -> bool {
    path == "thumbnail" || path.ends_with("/thumbnail")
}

async fn resolve_thumbnail_path<S: Store>(
    tree: &HashTree<S>,
    root: &Cid,
    path: &str,
) -> Option<String> {
    if !is_thumbnail_request(path) {
        return None;
    }

    let dir_path = if path == "thumbnail" {
        ""
    } else {
        path.strip_suffix("/thumbnail").unwrap_or("")
    };

    let dir_entry = if dir_path.is_empty() {
        Some(root.clone())
    } else {
        tree.resolve_path(root, dir_path).await.ok().flatten()
    }?;

    let entries = tree.list_directory(&dir_entry).await.ok()?;

    for pattern in THUMBNAIL_PATTERNS {
        if entries.iter().any(|e| e.name == *pattern) {
            return Some(if dir_path.is_empty() {
                (*pattern).to_string()
            } else {
                format!("{}/{}", dir_path, pattern)
            });
        }
    }

    let has_video_file = entries.iter().any(|e| is_video_filename(&e.name));
    if !has_video_file && !entries.is_empty() {
        let mut sorted: Vec<_> = entries.iter().collect();
        sorted.sort_by(|a, b| a.name.cmp(&b.name));

        for entry in sorted.into_iter().take(3) {
            if is_metadata_filename(&entry.name) {
                continue;
            }

            let sub_cid = Cid {
                hash: entry.hash,
                key: entry.key,
            };
            let sub_entries = match tree.list_directory(&sub_cid).await {
                Ok(entries) => entries,
                Err(_) => continue,
            };

            for pattern in THUMBNAIL_PATTERNS {
                if sub_entries.iter().any(|e| e.name == *pattern) {
                    let prefix = if dir_path.is_empty() {
                        entry.name.clone()
                    } else {
                        format!("{}/{}", dir_path, entry.name)
                    };
                    return Some(format!("{}/{}", prefix, pattern));
                }
            }
        }
    }

    None
}

async fn htree_npub_impl(
    State(state): State<AppState>,
    npub: String,
    treename: String,
    path: Option<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    connect_info: axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> Response<Body> {
    let is_localhost = connect_info.0.ip().is_loopback();
    let key = format!("{}/{}", npub, treename);
    let link_key = parse_hex_key(params.get("k"));

    let resolver = match NostrRootResolver::new(resolver_config()).await {
        Ok(r) => r,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(format!("Failed to create resolver: {}", e)))
                .unwrap();
        }
    };

    let resolved = match tokio::time::timeout(
        HTTP_RESOLVER_TIMEOUT,
        resolve_npub_root(&key, &resolver, link_key),
    )
    .await
    {
        Ok(Ok(cid)) => cid,
        Ok(Err(e)) => {
            let _ = resolver.stop().await;
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(format!("Resolution failed: {}", e)))
                .unwrap();
        }
        Err(_) => {
            let _ = resolver.stop().await;
            return Response::builder()
                .status(StatusCode::GATEWAY_TIMEOUT)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from("Resolution timeout"))
                .unwrap();
        }
    };
    let _ = resolver.stop().await;

    let mut cid = resolved;
    if cid.key.is_none() {
        if let Some(k) = link_key {
            cid.key = Some(k);
        }
    }

    let store = state.store.store_arc();
    let tree = HashTree::new(HashTreeConfig::new(store).public());

    // If root not in local store, try fetching from upstream
    if tree.get(&cid).await.ok().flatten().is_none() {
        fetch_and_cache_blob(&state, &cid.hash).await;
    }

    let mut effective_path = path.filter(|p| !p.is_empty());
    if let Some(path) = effective_path.clone() {
        if path == "thumbnail" || path.ends_with("/thumbnail") {
            if let Some(resolved_path) = resolve_thumbnail_path(&tree, &cid, &path).await {
                effective_path = Some(resolved_path);
            }
        }
    }

    let is_dir = tree.is_dir(&cid).await.unwrap_or(false);
    if is_dir {
        if let Some(path) = effective_path.clone() {
            let entry = match tree.resolve_path(&cid, &path).await {
                Ok(Some(entry)) => entry,
                Ok(None) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(Body::from("File not found"))
                        .unwrap();
                }
                Err(e) => {
                    return Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(Body::from(format!("Error: {}", e)))
                        .unwrap();
                }
            };
            return serve_cid_with_range(&state, &entry, headers, false, is_localhost, Some(&path)).await;
        }

        return list_directory_json(&state, &cid, false, is_localhost).await;
    }

    serve_cid_with_range(&state, &cid, headers, false, is_localhost, effective_path.as_deref()).await
}

pub async fn htree_npub(
    State(state): State<AppState>,
    Path((npub, treename)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    connect_info: axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> impl IntoResponse {
    let full = format!("npub1{}", npub);
    htree_npub_impl(
        State(state),
        full,
        treename,
        None,
        Query(params),
        headers,
        connect_info,
    )
    .await
}

pub async fn htree_npub_path(
    State(state): State<AppState>,
    Path((npub, treename, path)): Path<(String, String, String)>,
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    connect_info: axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> impl IntoResponse {
    let full = format!("npub1{}", npub);
    htree_npub_impl(
        State(state),
        full,
        treename,
        Some(path),
        Query(params),
        headers,
        connect_info,
    )
    .await
}

/// Cache-Control header for immutable content-addressed data (1 year)
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// Source of blob data for X-Source header
#[derive(Debug, Clone)]
enum BlobSource {
    Local,
    WebRtcPeer { peer_id: String },
    Upstream { server: String },
}

impl BlobSource {
    fn to_header_value(&self) -> String {
        match self {
            BlobSource::Local => "local".to_string(),
            BlobSource::WebRtcPeer { peer_id } => format!("webrtc:{}", peer_id),
            BlobSource::Upstream { server } => format!("upstream:{}", server),
        }
    }
}

/// Build a blob response with optional X-Source header (only for localhost)
fn build_blob_response(
    data: Vec<u8>,
    source: BlobSource,
    is_localhost: bool,
) -> Response<Body> {
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, data.len())
        .header(header::CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

    if is_localhost {
        builder = builder.header("X-Source", source.to_header_value());
    }

    builder.body(Body::from(data)).unwrap()
}

fn parse_hex_key(value: Option<&String>) -> Option<[u8; 32]> {
    let hex = value?;
    if hex.len() != 64 {
        return None;
    }
    from_hex(hex).ok()
}

fn content_type_for_path(path: Option<&str>) -> &'static str {
    let filename = path.and_then(|p| p.rsplit('/').next()).unwrap_or("");
    if filename.is_empty() {
        return "application/octet-stream";
    }
    get_mime_type(filename)
}

fn build_json_response(
    payload: serde_json::Value,
    is_immutable: bool,
    is_localhost: bool,
) -> Response<Body> {
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if is_immutable {
        builder = builder.header(header::CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL);
    }
    if is_localhost {
        builder = builder.header("X-Source", "local");
    }
    builder.body(Body::from(payload.to_string())).unwrap()
}

async fn serve_cid_with_range(
    state: &AppState,
    cid: &Cid,
    headers: axum::http::HeaderMap,
    is_immutable: bool,
    is_localhost: bool,
    filename_hint: Option<&str>,
) -> Response<Body> {
    let store = state.store.store_arc();
    let tree = HashTree::new(HashTreeConfig::new(store).public());
    let content_type = content_type_for_path(filename_hint);

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    if let Some(range_str) = range_header {
        if let Some(bytes_range) = range_str.strip_prefix("bytes=") {
            let parts: Vec<&str> = bytes_range.split('-').collect();
            if parts.len() == 2 {
                let start = parts[0].parse::<u64>().unwrap_or(0);
                let end_opt = if parts[1].is_empty() {
                    None
                } else {
                    parts[1].parse::<u64>().ok()
                };

                let total_size = match tree.get_size_cid(cid).await {
                    Ok(size) => size,
                    Err(e) => {
                        return Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .body(Body::from(format!("Error: {}", e)))
                            .unwrap();
                    }
                };

                if total_size == 0 || start >= total_size {
                    return Response::builder()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_TYPE, "text/plain")
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(Body::from("Range not satisfiable"))
                        .unwrap();
                }

                let end_inclusive = end_opt.unwrap_or(total_size - 1).min(total_size - 1);
                if end_inclusive < start {
                    return Response::builder()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_TYPE, "text/plain")
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(Body::from("Range not satisfiable"))
                        .unwrap();
                }

                let end_exclusive = end_inclusive.saturating_add(1);
                let data = match tree.read_file_range_cid(cid, start, Some(end_exclusive)).await {
                    Ok(Some(d)) => d,
                    Ok(None) => {
                        return Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .body(Body::from("Not found"))
                            .unwrap();
                    }
                    Err(e) => {
                        return Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .body(Body::from(format!("Error: {}", e)))
                            .unwrap();
                    }
                };

                let content_length = data.len();
                let content_range = format!("bytes {}-{}/{}", start, end_inclusive, total_size);

                let mut builder = Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::CONTENT_LENGTH, content_length)
                    .header(header::CONTENT_RANGE, content_range)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
                if is_immutable {
                    builder = builder.header(header::CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL);
                }
                if is_localhost {
                    builder = builder.header("X-Source", "local");
                }
                return builder.body(Body::from(data)).unwrap();
            }
        }
    }

    let data = match tree.get(cid).await {
        Ok(Some(d)) => d,
        Ok(None) => {
            // Try fetching from upstream
            if fetch_and_cache_blob(state, &cid.hash).await {
                match tree.get(cid).await {
                    Ok(Some(d)) => d,
                    _ => {
                        return Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .body(Body::from("Not found"))
                            .unwrap();
                    }
                }
            } else {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(Body::from("Not found"))
                    .unwrap();
            }
        }
        Err(e) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(format!("Error: {}", e)))
                .unwrap();
        }
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, data.len())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if is_immutable {
        builder = builder.header(header::CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL);
    }
    if is_localhost {
        builder = builder.header("X-Source", "local");
    }

    builder.body(Body::from(data)).unwrap()
}

/// Internal content serving (shared by CID and blossom routes)
///
/// `is_immutable`: if true, adds Cache-Control: immutable header.
/// Use true for content-addressed routes (hash, nhash, blossom SHA256).
/// Use false for mutable routes (npub/ref_name) where the reference can change.
/// `is_localhost`: if true, adds X-Source header for debugging.
async fn serve_content_internal(
    state: &AppState,
    hash: &[u8; 32],
    headers: axum::http::HeaderMap,
    is_immutable: bool,
    is_localhost: bool,
) -> Response<Body> {
    let store = &state.store;

    // Always return raw bytes - no conversion to JSON/HTML
    // This is required for Blossom protocol compatibility

    // Try as file
    // Check for Range header
    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());

    if let Some(range_str) = range_header {
        // Parse Range: bytes=start-end
        if let Some(bytes_range) = range_str.strip_prefix("bytes=") {
            let parts: Vec<&str> = bytes_range.split('-').collect();
            if parts.len() == 2 {
                if let Ok(start) = parts[0].parse::<u64>() {
                    let end = if parts[1].is_empty() {
                        None
                    } else {
                        parts[1].parse::<u64>().ok()
                    };

                    // Content type - hashtree doesn't store filenames, so default to octet-stream
                    let content_type = "application/octet-stream";

                    // Get metadata to determine total size
                    match store.get_file_chunk_metadata(&hash) {
                        Ok(Some(metadata)) => {
                            let total_size = metadata.total_size;

                            if start >= total_size {
                                return Response::builder()
                                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                                    .header(header::CONTENT_TYPE, "text/plain")
                                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                    .body(Body::from("Range not satisfiable"))
                                    .unwrap()
                                    .into_response();
                            }

                            let end_actual = end.unwrap_or(total_size - 1).min(total_size - 1);
                            let content_length = end_actual - start + 1;
                            let content_range = format!("bytes {}-{}/{}", start, end_actual, total_size);

                            // Use streaming for chunked files
                            if metadata.is_chunked {
                                match state.store.clone().stream_file_range_chunks_owned(&hash, start, end_actual) {
                                    Ok(Some(chunks_iter)) => {
                                        let stream = stream::iter(chunks_iter)
                                            .map(|result| result.map(Bytes::from));

                                        let mut builder = Response::builder()
                                            .status(StatusCode::PARTIAL_CONTENT)
                                            .header(header::CONTENT_TYPE, content_type)
                                            .header(header::CONTENT_LENGTH, content_length)
                                            .header(header::CONTENT_RANGE, content_range)
                                            .header(header::ACCEPT_RANGES, "bytes")
                                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
                                        if is_immutable {
                                            builder = builder.header(header::CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL);
                                        }
                                        if is_localhost {
                                            builder = builder.header("X-Source", "local");
                                        }
                                        return builder
                                            .body(Body::from_stream(stream))
                                            .unwrap()
                                            .into_response();
                                    }
                                    Ok(None) => {
                                        return Response::builder()
                                            .status(StatusCode::NOT_FOUND)
                                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                            .body(Body::from("File not found"))
                                            .unwrap()
                                            .into_response();
                                    }
                                    Err(e) => {
                                        return Response::builder()
                                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                            .body(Body::from(format!("Error: {}", e)))
                                            .unwrap()
                                            .into_response();
                                    }
                                }
                            } else {
                                // For small non-chunked files, use buffered approach
                                match store.get_file_range(&hash, start, Some(end_actual)) {
                                    Ok(Some((range_content, _))) => {
                                        let mut builder = Response::builder()
                                            .status(StatusCode::PARTIAL_CONTENT)
                                            .header(header::CONTENT_TYPE, content_type)
                                            .header(header::CONTENT_LENGTH, range_content.len())
                                            .header(header::CONTENT_RANGE, content_range)
                                            .header(header::ACCEPT_RANGES, "bytes")
                                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
                                        if is_immutable {
                                            builder = builder.header(header::CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL);
                                        }
                                        if is_localhost {
                                            builder = builder.header("X-Source", "local");
                                        }
                                        return builder
                                            .body(Body::from(range_content))
                                            .unwrap()
                                            .into_response();
                                    }
                                    Ok(None) => {
                                        return Response::builder()
                                            .status(StatusCode::NOT_FOUND)
                                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                            .body(Body::from("File not found"))
                                            .unwrap()
                                            .into_response();
                                    }
                                    Err(e) => {
                                        return Response::builder()
                                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                            .body(Body::from(format!("Error: {}", e)))
                                            .unwrap()
                                            .into_response();
                                    }
                                }
                            }
                        }
                        Ok(None) => {
                            return Response::builder()
                                .status(StatusCode::NOT_FOUND)
                                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                .body(Body::from("File not found"))
                                .unwrap()
                                .into_response();
                        }
                        Err(e) => {
                            return Response::builder()
                                .status(StatusCode::INTERNAL_SERVER_ERROR)
                                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                .body(Body::from(format!("Error: {}", e)))
                                .unwrap()
                                .into_response();
                        }
                    }
                }
            }
        }
    }

    // Fall back to full file
    match store.get_file(&hash) {
        Ok(Some(content)) => {
            // Content type - hashtree doesn't store filenames, so default to octet-stream
            let content_type = "application/octet-stream";

            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CONTENT_LENGTH, content.len())
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
            if is_immutable {
                builder = builder.header(header::CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL);
            }
            if is_localhost {
                builder = builder.header("X-Source", "local");
            }
            builder
                .body(Body::from(content))
                .unwrap()
                .into_response()
        }
        Ok(None) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from("Not found"))
            .unwrap()
            .into_response(),
        Err(e) => Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from(format!("Error: {}", e)))
            .unwrap()
            .into_response(),
    }
}

/// Serve content by CID or blossom SHA256 hash
/// Tries CID first, then falls back to blossom lookup if input looks like SHA256
/// If not found locally, queries connected WebSocket/WebRTC peers
pub async fn serve_content_or_blob(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    connect_info: axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> impl IntoResponse {
    let is_localhost = connect_info.0.ip().is_loopback();
    let _client_ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| connect_info.0.ip().to_string());
    // Parse potential extension for blossom
    let (hash_part, _ext) = if let Some(dot_pos) = id.rfind('.') {
        (&id[..dot_pos], Some(&id[dot_pos..]))
    } else {
        (id.as_str(), None)
    };

    // Check if it looks like a SHA256 hash (64 hex chars)
    let is_sha256 = hash_part.len() == 64 && hash_part.chars().all(|c| c.is_ascii_hexdigit());

    // Try raw blob lookup first (for hashtree chunks / git objects)
    // This takes priority over file tree serving to avoid returning reassembled
    // file content when the caller expects raw chunk data
    if is_sha256 {
        let hash_hex = hash_part.to_lowercase();
        if let Ok(hash_bytes) = from_hex(&hash_hex) {
            if let Ok(Some(data)) = state.store.get_blob(&hash_bytes) {
                return build_blob_response(data, BlobSource::Local, is_localhost).into_response();
            }
        }
    }

    // Try file tree lookup (serves reassembled file content)
    // (hashtree hashes are 64 hex chars, same as blossom SHA256)
    if let Ok(hash) = from_hex(&id) {
        if state.store.get_file_chunk_metadata(&hash).ok().flatten().is_some() {
            return serve_content_internal(&state, &hash, headers, true, is_localhost).await;
        }
    }

    // Not found locally - try querying connected WebRTC peers
    if is_sha256 {
        let hash_hex = hash_part.to_lowercase();

        // Try WebRTC peers first
        if let Some(ref webrtc_state) = state.webrtc_peers {
            tracing::info!("Hash {} not found locally, querying WebRTC peers", &hash_hex[..16.min(hash_hex.len())]);

            // Query connected WebRTC peers
            if let Some((data, peer_id)) = query_webrtc_peers(webrtc_state, &hash_hex).await {
                // Cache locally for future requests
                if let Err(e) = state.store.put_blob(&data) {
                    tracing::warn!("Failed to cache peer data: {}", e);
                }

                return build_blob_response(data, BlobSource::WebRtcPeer { peer_id }, is_localhost).into_response();
            }
        }

        // Try upstream Blossom servers
        if !state.upstream_blossom.is_empty() {
            tracing::info!("Hash {} not found via WebRTC, trying upstream Blossom", &hash_hex[..16.min(hash_hex.len())]);

            if let Some((data, server)) = query_upstream_blossom(&state.upstream_blossom, &hash_hex).await {
                // Cache locally for future requests
                if let Err(e) = state.store.put_blob(&data) {
                    tracing::warn!("Failed to cache upstream data: {}", e);
                }

                return build_blob_response(data, BlobSource::Upstream { server }, is_localhost).into_response();
            }
        }
    }

    // Not found anywhere
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from("Not found"))
        .unwrap()
        .into_response()
}

/// Serve content by npub/ref_name (Nostr resolver)
/// Route: /npub1... (the "npub1" prefix is matched by the route, :rest captures pubkey remainder + /ref)
pub async fn serve_npub(
    State(state): State<AppState>,
    Path(rest): Path<String>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    // Reconstruct full key: "npub1" + rest (e.g., "abc.../mydata")
    let key = format!("npub1{}", rest);

    // Validate format: must have a / for ref name
    if !key.contains('/') {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from("Missing ref name: use /npub1.../ref_name"))
            .unwrap()
            .into_response();
    }

    let resolver = match NostrRootResolver::new(resolver_config()).await {
        Ok(r) => r,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(format!("Failed to create resolver: {}", e)))
                .unwrap()
                .into_response();
        }
    };

    // npub routes are mutable - the reference can change over time
    match tokio::time::timeout(HTTP_RESOLVER_TIMEOUT, resolver.resolve_wait(&key)).await {
        Ok(Ok(cid)) => {
            let _ = resolver.stop().await;
            serve_content_internal(&state, &cid.hash, headers, false, false).await
        }
        Ok(Err(e)) => {
            let _ = resolver.stop().await;
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(format!("Resolution failed: {}", e)))
                .unwrap()
                .into_response()
        }
        Err(_) => {
            let _ = resolver.stop().await;
            Response::builder()
                .status(StatusCode::GATEWAY_TIMEOUT)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from("Resolution timeout"))
                .unwrap()
                .into_response()
        }
    }
}

pub async fn upload_file(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let store = &state.store;
    let mut temp_file_path: Option<std::path::PathBuf> = None;
    let mut file_name_final: Option<String> = None;
    let temp_dir = tempfile::tempdir().unwrap();

    while let Some(mut field) = multipart.next_field().await.unwrap_or(None) {
        let name = field.name().unwrap_or("").to_string();

        if name == "file" {
            let file_name = field.file_name().unwrap_or("upload").to_string();
            let temp_file = temp_dir.path().join(&file_name);

            // Stream directly to disk instead of loading into memory
            let mut file = tokio::fs::File::create(&temp_file).await.unwrap();

            while let Some(chunk) = field.next().await {
                if let Ok(data) = chunk {
                    file.write_all(&data).await.unwrap();
                }
            }

            file.flush().await.unwrap();
            temp_file_path = Some(temp_file);
            file_name_final = Some(file_name);
            break;
        }
    }

    let (temp_file, file_name) = match (temp_file_path, file_name_final) {
        (Some(path), Some(name)) => (path, name),
        _ => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from("No file provided"))
                .unwrap();
        }
    };

    // Use streaming upload for files > 10MB
    let file_size = std::fs::metadata(&temp_file).ok().map(|m| m.len()).unwrap_or(0);
    let use_streaming = file_size > 10 * 1024 * 1024;

    let cid_result = if use_streaming {
        // Streaming upload with progress callbacks
        let file = std::fs::File::open(&temp_file).unwrap();
        store.upload_file_stream(file, file_name, |_intermediate_cid| {
            // Could log progress here or publish to websocket
        })
    } else {
        // Regular upload for small files
        store.upload_file(&temp_file)
    };

    // Upload and get CID
    match cid_result {
        Ok(cid) => {
            let json = json!({
                "success": true,
                "cid": cid
            });
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json.to_string()))
                .unwrap()
        }
        Err(e) => {
            let json = json!({
                "success": false,
                "error": e.to_string()
            });
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json.to_string()))
                .unwrap()
        }
    }
}

pub async fn list_pins(State(state): State<AppState>) -> impl IntoResponse {
    let store = &state.store;
    match store.list_pins_with_names() {
        Ok(pins) => Json(json!({
            "pins": pins.iter().map(|p| json!({
                "cid": p.cid,
                "name": p.name,
                "is_directory": p.is_directory
            })).collect::<Vec<_>>()
        })),
        Err(e) => Json(json!({
            "error": e.to_string()
        })),
    }
}

pub async fn pin_cid(
    State(state): State<AppState>,
    Path(cid): Path<String>,
) -> impl IntoResponse {
    let hash = match from_hex(&cid) {
        Ok(h) => h,
        Err(e) => return Json(json!({
            "success": false,
            "error": format!("Invalid CID format: {}", e)
        })),
    };
    let store = &state.store;
    match store.pin(&hash) {
        Ok(_) => Json(json!({
            "success": true,
            "cid": cid
        })),
        Err(e) => Json(json!({
            "success": false,
            "error": e.to_string()
        })),
    }
}

pub async fn unpin_cid(
    State(state): State<AppState>,
    Path(cid): Path<String>,
) -> impl IntoResponse {
    let hash = match from_hex(&cid) {
        Ok(h) => h,
        Err(e) => return Json(json!({
            "success": false,
            "error": format!("Invalid CID format: {}", e)
        })),
    };
    let store = &state.store;
    match store.unpin(&hash) {
        Ok(_) => Json(json!({
            "success": true,
            "cid": cid
        })),
        Err(e) => Json(json!({
            "success": false,
            "error": e.to_string()
        })),
    }
}

pub async fn storage_stats(State(state): State<AppState>) -> impl IntoResponse {
    let store = &state.store;
    match store.get_storage_stats() {
        Ok(stats) => Json(json!({
            "total_dags": stats.total_dags,
            "pinned_dags": stats.pinned_dags,
            "total_bytes": stats.total_bytes,
        })),
        Err(e) => Json(json!({
            "error": e.to_string()
        })),
    }
}

/// Health check endpoint - minimal overhead, just returns ok
pub async fn health_check() -> impl IntoResponse {
    // Minimal health check - if we can respond, we're alive
    // Storage checks would be heavier and DDoS-able
    Response::builder()
        .status(StatusCode::OK)
        .body(Body::from("ok"))
        .unwrap()
}

/// Get connected WebRTC peers
pub async fn webrtc_peers(State(state): State<AppState>) -> impl IntoResponse {
    use crate::webrtc::ConnectionState;

    let Some(ref webrtc_state) = state.webrtc_peers else {
        return Json(json!({
            "enabled": false,
            "peers": []
        }));
    };

    let peers = webrtc_state.peers.read().await;
    let peer_list: Vec<_> = peers.iter().map(|(id, entry)| {
        let rtc_state = entry.peer.as_ref().map(|p| format!("{:?}", p.state()));
        json!({
            "id": id,
            "pubkey": entry.peer_id.pubkey,
            "state": format!("{:?}", entry.state),
            "rtc_state": rtc_state,
            "pool": format!("{:?}", entry.pool),
            "connected": entry.state == ConnectionState::Connected,
            "has_data_channel": entry.peer.as_ref().map(|p| p.has_data_channel()).unwrap_or(false),
        })
    }).collect();

    Json(json!({
        "enabled": true,
        "total": peers.len(),
        "connected": peer_list.iter().filter(|p| p["connected"].as_bool().unwrap_or(false)).count(),
        "with_data_channel": peer_list.iter().filter(|p| p["has_data_channel"].as_bool().unwrap_or(false)).count(),
        "peers": peer_list
    }))
}

/// Daemon status endpoint - localhost only
pub async fn daemon_status(
    State(state): State<AppState>,
    connect_info: axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> impl IntoResponse {
    // Only allow localhost
    let ip = connect_info.0.ip();
    if !ip.is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "localhost only"}))).into_response();
    }

    // Storage stats
    let storage = match state.store.get_storage_stats() {
        Ok(stats) => json!({
            "total_dags": stats.total_dags,
            "pinned_dags": stats.pinned_dags,
            "total_bytes": stats.total_bytes,
        }),
        Err(e) => json!({"error": e.to_string()}),
    };

    // WebRTC peers
    let webrtc = if let Some(ref webrtc_state) = state.webrtc_peers {
        let peers = webrtc_state.peers.read().await;
        let connected = peers.values()
            .filter(|e| e.state == ConnectionState::Connected)
            .count();
        let with_data_channel = peers.values()
            .filter(|e| e.state == ConnectionState::Connected
                && e.peer.as_ref().map(|p| p.has_data_channel()).unwrap_or(false))
            .count();
        let (bytes_sent, bytes_received) = webrtc_state.get_bandwidth();
        // Per-peer stats
        let peer_stats: Vec<_> = peers.values()
            .map(|e| json!({
                "peer_id": e.peer_id.short(),
                "pubkey": e.peer_id.pubkey.clone(),
                "bytes_sent": e.bytes_sent,
                "bytes_received": e.bytes_received,
            }))
            .collect();
        json!({
            "enabled": true,
            "total_peers": peers.len(),
            "connected": connected,
            "with_data_channel": with_data_channel,
            "bytes_sent": bytes_sent,
            "bytes_received": bytes_received,
            "peers": peer_stats,
        })
    } else {
        json!({"enabled": false})
    };

    // Upstream servers
    let upstream = json!({
        "blossom_servers": state.upstream_blossom.len(),
    });

    Json(json!({
        "status": "running",
        "storage": storage,
        "webrtc": webrtc,
        "upstream": upstream,
    })).into_response()
}

pub async fn garbage_collect(State(state): State<AppState>) -> impl IntoResponse {
    let store = &state.store;
    match store.gc() {
        Ok(gc_stats) => Json(json!({
            "deleted_dags": gc_stats.deleted_dags,
            "freed_bytes": gc_stats.freed_bytes
        })),
        Err(e) => Json(json!({
            "error": e.to_string()
        })),
    }
}

pub async fn socialgraph_stats(State(state): State<AppState>) -> impl IntoResponse {
    match &state.social_graph {
        Some(sg) => {
            let stats = sg.stats();
            Json(json!(stats))
        }
        None => Json(json!({
            "enabled": false,
            "message": "Social graph not active"
        })),
    }
}

#[derive(Debug, Deserialize)]
pub struct SocialGraphSnapshotQuery {
    #[serde(rename = "maxNodes")]
    pub max_nodes: Option<usize>,
    #[serde(rename = "maxEdges")]
    pub max_edges: Option<usize>,
    #[serde(rename = "maxDistance")]
    pub max_distance: Option<u32>,
    #[serde(rename = "maxEdgesPerNode")]
    pub max_edges_per_node: Option<usize>,
}

pub async fn socialgraph_snapshot(
    State(state): State<AppState>,
    Query(params): Query<SocialGraphSnapshotQuery>,
    connect_info: axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> impl IntoResponse {
    let ip = connect_info.0.ip();
    if !state.socialgraph_snapshot_public && !ip.is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "localhost only"}))).into_response();
    }

    let ndb = match &state.social_graph_ndb {
        Some(ndb) => Arc::clone(ndb),
        None => {
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "social graph not initialized"}))).into_response();
        }
    };
    let root = match state.social_graph_root {
        Some(root) => root,
        None => {
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "social graph root missing"}))).into_response();
        }
    };

    let options = socialgraph::snapshot::SnapshotOptions {
        max_nodes: params.max_nodes,
        max_edges: params.max_edges,
        max_distance: params.max_distance,
        max_edges_per_node: params.max_edges_per_node,
    };

    let chunks = match tokio::task::spawn_blocking(move || {
        socialgraph::snapshot::build_snapshot_chunks(&ndb, &root, &options)
    }).await {
        Ok(Ok(chunks)) => chunks,
        Ok(Err(err)) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(format!("Error generating snapshot: {err}")))
                .unwrap();
        }
        Err(err) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(format!("Error generating snapshot: {err}")))
                .unwrap();
        }
    };

    let stream = stream::iter(chunks.into_iter().map(Ok::<Bytes, std::io::Error>));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, "attachment; filename=\"social-graph.bin\"")
        .header(header::CACHE_CONTROL, "public, max-age=60, stale-while-revalidate=60")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from_stream(stream))
        .unwrap()
}

pub async fn follow_distance(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> impl IntoResponse {
    if pubkey.len() != 64 || !pubkey.chars().all(|c| c.is_ascii_hexdigit()) {
        return Json(json!({
            "error": "Invalid pubkey format (expected 64 hex chars)"
        }));
    }

    match &state.social_graph {
        Some(sg) => {
            let allowed = sg.check_write_access(&pubkey);
            Json(json!({
                "pubkey": pubkey,
                "write_access": allowed,
            }))
        }
        None => Json(json!({
            "pubkey": pubkey,
            "error": "Social graph not active",
        })),
    }
}

/// Timeout for HTTP resolver requests
const HTTP_RESOLVER_TIMEOUT: Duration = Duration::from_secs(10);

/// Create resolver config with HTTP timeout
fn resolver_config() -> NostrResolverConfig {
    NostrResolverConfig {
        resolve_timeout: HTTP_RESOLVER_TIMEOUT,
        ..Default::default()
    }
}

/// Resolve npub/treename to hash and serve content
/// Route: /n/:pubkey/:treename or /n/:pubkey/:treename/*path
pub async fn resolve_and_serve(
    State(state): State<AppState>,
    Path(params): Path<(String, String)>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let (pubkey, treename) = params;
    let key = format!("{}/{}", pubkey, treename);

    let resolver = match NostrRootResolver::new(resolver_config()).await {
        Ok(r) => r,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(json!({
                    "error": format!("Failed to create resolver: {}", e),
                    "key": key
                }).to_string()))
                .unwrap()
                .into_response();
        }
    };

    // Use resolve_wait with timeout - waits for key to appear
    // This is a mutable route (npub/treename can change over time)
    match tokio::time::timeout(HTTP_RESOLVER_TIMEOUT, resolver.resolve_wait(&key)).await {
        Ok(Ok(cid)) => {
            let _ = resolver.stop().await;
            serve_content_internal(&state, &cid.hash, headers, false, false).await
        }
        Ok(Err(e)) => {
            let _ = resolver.stop().await;
            Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(json!({
                    "error": e.to_string(),
                    "key": key
                }).to_string()))
                .unwrap()
                .into_response()
        }
        Err(_) => {
            let _ = resolver.stop().await;
            Response::builder()
                .status(StatusCode::GATEWAY_TIMEOUT)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(json!({
                    "error": "Resolution timeout",
                    "key": key
                }).to_string()))
                .unwrap()
                .into_response()
        }
    }
}

/// API endpoint to resolve npub/treename to hash (returns JSON)
pub async fn resolve_to_hash(
    Path(params): Path<(String, String)>,
) -> impl IntoResponse {
    let (pubkey, treename) = params;
    let key = format!("{}/{}", pubkey, treename);

    let resolver = match NostrRootResolver::new(resolver_config()).await {
        Ok(r) => r,
        Err(e) => {
            return Json(json!({
                "error": format!("Failed to create resolver: {}", e),
                "key": key
            }));
        }
    };

    let result = match tokio::time::timeout(HTTP_RESOLVER_TIMEOUT, resolver.resolve_wait(&key)).await {
        Ok(Ok(cid)) => {
            Json(json!({
                "key": key,
                "hash": to_hex(&cid.hash),
                "cid": cid.to_string()
            }))
        }
        Ok(Err(e)) => {
            Json(json!({
                "error": e.to_string(),
                "key": key
            }))
        }
        Err(_) => {
            Json(json!({
                "error": "Resolution timeout",
                "key": key
            }))
        }
    };

    let _ = resolver.stop().await;
    result
}

/// List all trees for a pubkey
pub async fn list_trees(
    Path(pubkey): Path<String>,
) -> impl IntoResponse {
    let resolver = match NostrRootResolver::new(resolver_config()).await {
        Ok(r) => r,
        Err(e) => {
            return Json(json!({
                "error": format!("Failed to create resolver: {}", e),
                "pubkey": pubkey
            }));
        }
    };

    // list() uses the configured timeout internally
    let result = match resolver.list(&pubkey).await {
        Ok(entries) => {
            Json(json!({
                "pubkey": pubkey,
                "trees": entries.iter().map(|e| json!({
                    "name": e.key.split('/').last().unwrap_or(&e.key),
                    "hash": to_hex(&e.cid.hash),
                    "cid": e.cid.to_string()
                })).collect::<Vec<_>>()
            }))
        }
        Err(e) => {
            Json(json!({
                "error": e.to_string(),
                "pubkey": pubkey
            }))
        }
    };

    let _ = resolver.stop().await;
    result
}

/// Query connected WebRTC peers for content by hash
/// Returns the first successful response with peer_id, or None if no peer has it
async fn query_webrtc_peers(webrtc_state: &Arc<WebRTCState>, hash_hex: &str) -> Option<(Vec<u8>, String)> {
    let peers = webrtc_state.peers.read().await;

    // Collect connected peers that have data channels
    let connected_peers: Vec<_> = peers
        .values()
        .filter(|entry| {
            entry.state == ConnectionState::Connected
                && entry.peer.as_ref().map(|p| p.has_data_channel()).unwrap_or(false)
        })
        .collect();

    if connected_peers.is_empty() {
        tracing::debug!("No connected WebRTC peers with data channels to query");
        return None;
    }

    tracing::debug!(
        "Querying {} connected WebRTC peers for {}",
        connected_peers.len(),
        &hash_hex[..16.min(hash_hex.len())]
    );

    // Query peers sequentially (could be parallelized with timeout)
    for entry in connected_peers {
        if let Some(ref peer) = entry.peer {
            match peer.request(hash_hex).await {
                Ok(Some(data)) => {
                    let peer_id = entry.peer_id.short();
                    tracing::info!(
                        "Got {} bytes from peer {} for hash {}",
                        data.len(),
                        peer_id,
                        &hash_hex[..16.min(hash_hex.len())]
                    );
                    return Some((data, peer_id.to_string()));
                }
                Ok(None) => {
                    tracing::debug!(
                        "Peer {} doesn't have hash {}",
                        entry.peer_id.short(),
                        &hash_hex[..16.min(hash_hex.len())]
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "Error querying peer {} for {}: {}",
                        entry.peer_id.short(),
                        &hash_hex[..16.min(hash_hex.len())],
                        e
                    );
                }
            }
        }
    }

    None
}

/// Query upstream Blossom servers for content by hash
/// Returns the first successful response with server URL, or None if not found
async fn query_upstream_blossom(servers: &[String], hash_hex: &str) -> Option<(Vec<u8>, String)> {
    use sha2::{Digest, Sha256};

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;

    for server in servers {
        let url = format!("{}/{}", server.trim_end_matches('/'), hash_hex);
        tracing::debug!("Trying upstream Blossom: {}", url);

        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(bytes) = resp.bytes().await {
                    // Verify hash matches
                    let mut hasher = Sha256::new();
                    hasher.update(&bytes);
                    let computed = hex::encode(hasher.finalize());

                    if computed == hash_hex {
                        tracing::info!(
                            "Got {} bytes from upstream {} for hash {}",
                            bytes.len(),
                            server,
                            &hash_hex[..16.min(hash_hex.len())]
                        );
                        return Some((bytes.to_vec(), server.clone()));
                    } else {
                        tracing::warn!(
                            "Hash mismatch from {}: expected {}, got {}",
                            server,
                            &hash_hex[..16.min(hash_hex.len())],
                            &computed[..16.min(computed.len())]
                        );
                    }
                }
            }
            Ok(resp) => {
                tracing::debug!("Upstream {} returned {}", server, resp.status());
            }
            Err(e) => {
                tracing::debug!("Upstream {} error: {}", server, e);
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use hashtree_core::{DirEntry, MemoryStore};

    #[tokio::test]
    async fn test_query_upstream_blossom_no_servers() {
        let servers: Vec<String> = vec![];
        let result = query_upstream_blossom(&servers, "abc123").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_query_upstream_blossom_invalid_server() {
        let servers = vec!["http://localhost:99999".to_string()];
        let result = query_upstream_blossom(&servers, "abc123").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_query_upstream_blossom_hash_format() {
        // Test with valid SHA256 hash format but non-existent server
        let servers = vec!["http://localhost:99999".to_string()];
        let hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let result = query_upstream_blossom(&servers, hash).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn resolve_thumbnail_path_prefers_root_thumbnail() {
        let store = Arc::new(MemoryStore::new());
        let tree = HashTree::new(HashTreeConfig::new(store));

        let (thumb_cid, _size) = tree.put(b"thumb").await.unwrap();
        let root_cid = tree
            .put_directory(vec![
                DirEntry::from_cid("thumbnail.jpg", &thumb_cid)
                    .with_link_type(LinkType::File),
            ])
            .await
            .unwrap();

        let resolved = resolve_thumbnail_path(&tree, &root_cid, "thumbnail").await;
        assert_eq!(resolved.as_deref(), Some("thumbnail.jpg"));
    }

    #[tokio::test]
    async fn resolve_thumbnail_path_falls_back_to_subdir() {
        let store = Arc::new(MemoryStore::new());
        let tree = HashTree::new(HashTreeConfig::new(store));

        let (thumb_cid, _size) = tree.put(b"thumb").await.unwrap();
        let subdir_cid = tree
            .put_directory(vec![
                DirEntry::from_cid("thumbnail.png", &thumb_cid)
                    .with_link_type(LinkType::File),
            ])
            .await
            .unwrap();

        let (meta_cid, _size) = tree.put(b"{}").await.unwrap();
        let root_cid = tree
            .put_directory(vec![
                DirEntry::from_cid("clip", &subdir_cid)
                    .with_link_type(LinkType::Dir),
                DirEntry::from_cid("meta.json", &meta_cid)
                    .with_link_type(LinkType::File),
            ])
            .await
            .unwrap();

        let resolved = resolve_thumbnail_path(&tree, &root_cid, "thumbnail").await;
        assert_eq!(resolved.as_deref(), Some("clip/thumbnail.png"));
    }

    #[test]
    fn content_type_for_path_uses_extension() {
        assert_eq!(content_type_for_path(Some("dir/video.mp4")), "video/mp4");
        assert_eq!(content_type_for_path(Some("image.jpeg")), "image/jpeg");
        assert_eq!(content_type_for_path(None), "application/octet-stream");
    }
}
