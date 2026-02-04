use axum::{
    body::Body,
    extract::State,
    http::{header, Request, Response, StatusCode},
    middleware::Next,
    extract::ws::Message,
};
use crate::socialgraph;
use crate::nostr_relay::NostrRelay;
use crate::storage::HashtreeStore;
use crate::webrtc::WebRTCState;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, atomic::{AtomicU32, AtomicU64, Ordering}};
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsProtocol {
    HashtreeJson,
    HashtreeMsgpack,
    Unknown,
}

pub struct PendingRequest {
    pub origin_id: u64,
    pub hash: String,
    pub found: bool,
    pub origin_protocol: WsProtocol,
}

pub struct WsRelayState {
    pub clients: Mutex<HashMap<u64, mpsc::UnboundedSender<Message>>>,
    pub pending: Mutex<HashMap<(u64, u32), PendingRequest>>,
    pub client_protocols: Mutex<HashMap<u64, WsProtocol>>,
    pub next_client_id: AtomicU64,
    pub next_request_id: AtomicU32,
}

impl WsRelayState {
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            client_protocols: Mutex::new(HashMap::new()),
            next_client_id: AtomicU64::new(1),
            next_request_id: AtomicU32::new(1),
        }
    }

    pub fn next_id(&self) -> u64 {
        self.next_client_id.fetch_add(1, Ordering::SeqCst)
    }

    pub fn next_request_id(&self) -> u32 {
        self.next_request_id.fetch_add(1, Ordering::SeqCst)
    }
}

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<HashtreeStore>,
    pub auth: Option<AuthCredentials>,
    /// WebRTC peer state for forwarding requests to connected P2P peers
    pub webrtc_peers: Option<Arc<WebRTCState>>,
    /// WebSocket relay state for /ws clients
    pub ws_relay: Arc<WsRelayState>,
    /// Maximum upload size in bytes for Blossom uploads (default: 5 MB)
    pub max_upload_bytes: usize,
    /// Allow anyone with valid Nostr auth to write (default: true)
    /// When false, only allowed_pubkeys can write
    pub public_writes: bool,
    /// Pubkeys allowed to write (hex format, from config allowed_npubs)
    pub allowed_pubkeys: HashSet<String>,
    /// Upstream Blossom servers for cascade fetching
    pub upstream_blossom: Vec<String>,
    /// Social graph access control (nostrdb-backed when feature enabled)
    pub social_graph: Option<Arc<socialgraph::SocialGraphAccessControl>>,
    /// Social graph nostrdb handle for snapshot export
    pub social_graph_ndb: Option<Arc<socialgraph::Ndb>>,
    /// Social graph root pubkey bytes for snapshot export
    pub social_graph_root: Option<[u8; 32]>,
    /// Allow public access to social graph snapshot endpoint
    pub socialgraph_snapshot_public: bool,
    /// Nostr relay state for /ws and WebRTC Nostr messages
    pub nostr_relay: Option<Arc<NostrRelay>>,
}

#[derive(Clone)]
pub struct AuthCredentials {
    pub username: String,
    pub password: String,
}

/// Auth middleware - validates HTTP Basic Auth
pub async fn auth_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response<Body>, StatusCode> {
    // If auth is not enabled, allow request
    let Some(auth) = &state.auth else {
        return Ok(next.run(request).await);
    };

    // Check Authorization header
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    let authorized = if let Some(header_value) = auth_header {
        if let Some(credentials) = header_value.strip_prefix("Basic ") {
            use base64::Engine;
            let engine = base64::engine::general_purpose::STANDARD;
            if let Ok(decoded) = engine.decode(credentials) {
                if let Ok(decoded_str) = String::from_utf8(decoded) {
                    let expected = format!("{}:{}", auth.username, auth.password);
                    decoded_str == expected
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        }
    } else {
        false
    };

    if authorized {
        Ok(next.run(request).await)
    } else {
        Ok(Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header(header::WWW_AUTHENTICATE, "Basic realm=\"hashtree\"")
            .body(Body::from("Unauthorized"))
            .unwrap())
    }
}
