//! WebRTC signaling over Nostr relays
//!
//! Protocol (compatible with hashtree-ts):
//! - All signaling uses ephemeral kind 25050
//! - Hello messages: #l: "hello" tag, broadcast for peer discovery (unencrypted)
//! - Directed signaling (offer, answer, candidate, candidates): NIP-17 style
//!   gift wrap for privacy - wrapped with ephemeral key, #p tag with recipient
//!
//! Security: Directed messages use gift wrapping with ephemeral keys so that
//! relays cannot see the actual sender or correlate messages.

use anyhow::Result;
use async_trait::async_trait;
use hashtree_network::{
    decode_signaling_event, encode_signaling_event, run_hedged_waves, sync_selector_peers,
    ClassifyRequest as SharedClassifyRequest, HedgedWaveAction, IceCandidate as SharedIceCandidate,
    MeshRouter, NostrRelayTransport, PeerLink as SharedPeerLink,
    PeerLinkFactory as SharedPeerLinkFactory, PeerSelector,
    SignalingTransport as SharedSignalingTransport, TransportError as SharedTransportError,
};
use nostr::{Keys, Kind};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex, RwLock};
use tracing::{debug, error, info, warn};

use super::bluetooth::{BluetoothMesh, BluetoothPeerRegistrar, BluetoothRuntimeContext};
use super::cashu::{CashuMintMetadataStore, CashuQuoteState, CashuRoutingConfig, NegotiatedQuote};
use super::local_bus::SharedLocalNostrBus;
use super::multicast::MulticastNostrBus;
use super::peer::{ContentStore, Peer, PendingRequest};
use super::root_events::{
    build_root_filter, hashtree_event_identifier, is_hashtree_labeled_event, pick_latest_event,
    root_event_from_peer, PeerRootEvent,
};
use super::session::MeshPeer;
use super::types::{
    decrement_htl_with_policy, encode_quote_request, encode_request, should_forward_htl,
    validate_mesh_frame, DataQuoteRequest, DataRequest, MeshNostrFrame, MeshNostrPayload,
    PeerDirection, PeerId, PeerPool, PeerStateEvent, PeerStatus, RequestDispatchConfig,
    SignalingMessage, TimedSeenSet, WebRTCConfig, MESH_DEFAULT_HTL, MESH_EVENT_POLICY, WEBRTC_KIND,
};
use super::wifi_aware::{mobile_wifi_aware_bridge, WifiAwareNostrBus, WIFI_AWARE_SOURCE};
use crate::cashu_helper::CashuPaymentClient;
use crate::nostr_relay::NostrRelay;

/// Callback type for classifying peers into pools
pub type PeerClassifier = Arc<dyn Fn(&str) -> PeerPool + Send + Sync>;

/// Active data transport used for a peer session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PeerTransport {
    WebRtc,
    Bluetooth,
}

impl PeerTransport {
    pub const fn as_str(self) -> &'static str {
        match self {
            PeerTransport::WebRtc => "webrtc",
            PeerTransport::Bluetooth => "bluetooth",
        }
    }
}

impl std::fmt::Display for PeerTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str((*self).as_str())
    }
}

fn bluetooth_nostr_only_mode() -> bool {
    matches!(
        std::env::var("HTREE_BLUETOOTH_NOSTR_ONLY").ok().as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES")
    )
}

/// Signaling/discovery path through which a peer was seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PeerSignalPath {
    Relay,
    Multicast,
    WifiAware,
    Bluetooth,
}

impl PeerSignalPath {
    pub const fn as_str(self) -> &'static str {
        match self {
            PeerSignalPath::Relay => "relay",
            PeerSignalPath::Multicast => "multicast",
            PeerSignalPath::WifiAware => WIFI_AWARE_SOURCE,
            PeerSignalPath::Bluetooth => "bluetooth",
        }
    }

    pub fn from_source_name(source: &str) -> Self {
        match source {
            "multicast" => PeerSignalPath::Multicast,
            WIFI_AWARE_SOURCE => PeerSignalPath::WifiAware,
            "bluetooth" => PeerSignalPath::Bluetooth,
            _ => PeerSignalPath::Relay,
        }
    }
}

impl std::fmt::Display for PeerSignalPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str((*self).as_str())
    }
}

/// Connection state for a peer
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectionState {
    Discovered,
    Connecting,
    Connected,
    Failed,
}

impl std::fmt::Display for ConnectionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectionState::Discovered => write!(f, "discovered"),
            ConnectionState::Connecting => write!(f, "connecting"),
            ConnectionState::Connected => write!(f, "connected"),
            ConnectionState::Failed => write!(f, "failed"),
        }
    }
}

/// Peer entry in the manager
pub struct PeerEntry {
    pub peer_id: PeerId,
    pub direction: PeerDirection,
    pub state: ConnectionState,
    pub last_seen: Instant,
    pub peer: Option<MeshPeer>,
    pub pool: PeerPool,
    pub transport: PeerTransport,
    pub signal_paths: BTreeSet<PeerSignalPath>,
    pub bytes_sent: u64,
    pub bytes_received: u64,
}

/// Shared state for the native mesh router.
pub struct WebRTCState {
    pub peers: RwLock<HashMap<String, PeerEntry>>,
    pub connected_count: std::sync::atomic::AtomicUsize,
    /// Total bytes sent across all peers (cumulative)
    pub bytes_sent: std::sync::atomic::AtomicU64,
    /// Total bytes received across all peers (cumulative)
    pub bytes_received: std::sync::atomic::AtomicU64,
    /// Relayless mesh frames received and accepted.
    pub mesh_received: std::sync::atomic::AtomicU64,
    /// Relayless mesh frames forwarded to peers.
    pub mesh_forwarded: std::sync::atomic::AtomicU64,
    /// Relayless mesh frames/events dropped due to dedupe.
    pub mesh_dropped_duplicate: std::sync::atomic::AtomicU64,
    /// Shared peer selector used by live retrieval; aligned with simulation strategies.
    peer_selector: Arc<RwLock<PeerSelector>>,
    /// Hedged dispatch policy for retrieval requests.
    request_dispatch: RequestDispatchConfig,
    /// Retrieval timeout for quote negotiation and single-peer fetches.
    request_timeout: Duration,
    /// Shared Cashu quote negotiation policy/state.
    cashu_quotes: Arc<CashuQuoteState>,
    /// Optional local buses such as multicast or BLE that carry signed Nostr
    /// envelopes for nearby/offline peers.
    local_buses: RwLock<Vec<SharedLocalNostrBus>>,
}
const SEEN_FRAME_CAP: usize = 4096;
const SEEN_FRAME_TTL: Duration = Duration::from_secs(120);
const SEEN_EVENT_CAP: usize = 8192;
const SEEN_EVENT_TTL: Duration = Duration::from_secs(600);

type PendingRequestsMap = Arc<Mutex<HashMap<String, PendingRequest>>>;
type ConnectedPeer = (
    String,
    PendingRequestsMap,
    Arc<webrtc::data_channel::RTCDataChannel>,
);
type ConnectedSession = (String, MeshPeer, PeerTransport);
type SharedProductionRouter = MeshRouter<RouterSignalingBridge, SharedRouterPeerFactory>;

async fn remember_peer_signal_path(state: &WebRTCState, peer_id: &str, source: &str) {
    if let Some(entry) = state.peers.write().await.get_mut(peer_id) {
        entry
            .signal_paths
            .insert(PeerSignalPath::from_source_name(source));
    }
}

#[derive(Clone)]
struct RouterSignalingBridge {
    peer_id: String,
    signaling_tx: mpsc::Sender<SignalingMessage>,
}

impl RouterSignalingBridge {
    fn new(peer_id: String, signaling_tx: mpsc::Sender<SignalingMessage>) -> Self {
        Self {
            peer_id,
            signaling_tx,
        }
    }
}

#[async_trait]
impl SharedSignalingTransport for RouterSignalingBridge {
    async fn connect(&self, _relays: &[String]) -> Result<(), SharedTransportError> {
        Ok(())
    }

    async fn disconnect(&self) {}

    async fn publish(&self, msg: SignalingMessage) -> Result<(), SharedTransportError> {
        self.signaling_tx
            .send(msg)
            .await
            .map_err(|e| SharedTransportError::SendFailed(e.to_string()))
    }

    async fn recv(&self) -> Option<SignalingMessage> {
        None
    }

    fn try_recv(&self) -> Option<SignalingMessage> {
        None
    }

    fn peer_id(&self) -> &str {
        &self.peer_id
    }
}

struct SharedRouterPeerFactory {
    my_peer_id: PeerId,
    signaling_tx: mpsc::Sender<SignalingMessage>,
    stun_servers: Vec<String>,
    store: Option<Arc<dyn ContentStore>>,
    state: Arc<WebRTCState>,
    state_event_tx: mpsc::Sender<PeerStateEvent>,
    nostr_relay: Option<Arc<NostrRelay>>,
    mesh_frame_tx: mpsc::Sender<(PeerId, MeshNostrFrame)>,
    peer_classifier: PeerClassifier,
    peers: RwLock<HashMap<String, Arc<Peer>>>,
}

impl SharedRouterPeerFactory {
    fn new(
        my_peer_id: PeerId,
        signaling_tx: mpsc::Sender<SignalingMessage>,
        stun_servers: Vec<String>,
        store: Option<Arc<dyn ContentStore>>,
        state: Arc<WebRTCState>,
        state_event_tx: mpsc::Sender<PeerStateEvent>,
        nostr_relay: Option<Arc<NostrRelay>>,
        mesh_frame_tx: mpsc::Sender<(PeerId, MeshNostrFrame)>,
        peer_classifier: PeerClassifier,
    ) -> Self {
        Self {
            my_peer_id,
            signaling_tx,
            stun_servers,
            store,
            state,
            state_event_tx,
            nostr_relay,
            mesh_frame_tx,
            peer_classifier,
            peers: RwLock::new(HashMap::new()),
        }
    }

    async fn register_peer(&self, peer_id: PeerId, direction: PeerDirection, peer: Arc<Peer>) {
        let peer_key = peer_id.to_string();
        let pool = (self.peer_classifier)(&peer_id.pubkey);
        self.peers
            .write()
            .await
            .insert(peer_key.clone(), peer.clone());

        let mut peers = self.state.peers.write().await;
        peers.insert(
            peer_key,
            PeerEntry {
                peer_id,
                direction,
                state: ConnectionState::Connecting,
                last_seen: Instant::now(),
                peer: Some(MeshPeer::WebRtc(peer)),
                pool,
                transport: PeerTransport::WebRtc,
                signal_paths: BTreeSet::from([PeerSignalPath::Relay]),
                bytes_sent: 0,
                bytes_received: 0,
            },
        );
    }

    async fn create_peer(
        &self,
        peer_id: PeerId,
        direction: PeerDirection,
    ) -> Result<Peer, SharedTransportError> {
        Peer::new_with_store_and_events(
            peer_id,
            direction,
            self.my_peer_id.clone(),
            self.signaling_tx.clone(),
            self.stun_servers.clone(),
            self.store.clone(),
            Some(self.state_event_tx.clone()),
            self.nostr_relay.clone(),
            Some(self.mesh_frame_tx.clone()),
            Some(self.state.cashu_quotes.clone()),
        )
        .await
        .map_err(|e| SharedTransportError::ConnectionFailed(e.to_string()))
    }
}

#[async_trait]
impl SharedPeerLinkFactory for SharedRouterPeerFactory {
    async fn create_offer(
        &self,
        target_peer_id: &str,
    ) -> Result<(Arc<dyn SharedPeerLink>, String), SharedTransportError> {
        let target_peer = PeerId::from_string(target_peer_id).ok_or_else(|| {
            SharedTransportError::ConnectionFailed(format!("invalid peer id {target_peer_id}"))
        })?;
        let peer = Arc::new(
            self.create_peer(target_peer.clone(), PeerDirection::Outbound)
                .await?,
        );
        peer.setup_handlers()
            .await
            .map_err(|e| SharedTransportError::ConnectionFailed(e.to_string()))?;
        let offer = peer
            .connect()
            .await
            .map_err(|e| SharedTransportError::ConnectionFailed(e.to_string()))?;
        let sdp = offer
            .get("sdp")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                SharedTransportError::ConnectionFailed("missing SDP in CLI peer offer".to_string())
            })?
            .to_string();
        self.register_peer(target_peer, PeerDirection::Outbound, peer.clone())
            .await;
        Ok((peer as Arc<dyn SharedPeerLink>, sdp))
    }

    async fn accept_offer(
        &self,
        from_peer_id: &str,
        offer_sdp: &str,
    ) -> Result<(Arc<dyn SharedPeerLink>, String), SharedTransportError> {
        let from_peer = PeerId::from_string(from_peer_id).ok_or_else(|| {
            SharedTransportError::ConnectionFailed(format!("invalid peer id {from_peer_id}"))
        })?;
        let peer = Arc::new(
            self.create_peer(from_peer.clone(), PeerDirection::Inbound)
                .await?,
        );
        peer.setup_handlers()
            .await
            .map_err(|e| SharedTransportError::ConnectionFailed(e.to_string()))?;
        let answer = peer
            .handle_offer(serde_json::json!({ "type": "offer", "sdp": offer_sdp }))
            .await
            .map_err(|e| SharedTransportError::ConnectionFailed(e.to_string()))?;
        let sdp = answer
            .get("sdp")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                SharedTransportError::ConnectionFailed("missing SDP in CLI peer answer".to_string())
            })?
            .to_string();
        self.register_peer(from_peer, PeerDirection::Inbound, peer.clone())
            .await;
        Ok((peer as Arc<dyn SharedPeerLink>, sdp))
    }

    async fn handle_answer(
        &self,
        target_peer_id: &str,
        answer_sdp: &str,
    ) -> Result<Arc<dyn SharedPeerLink>, SharedTransportError> {
        let peer = self
            .peers
            .read()
            .await
            .get(target_peer_id)
            .cloned()
            .ok_or_else(|| {
                SharedTransportError::ConnectionFailed(format!(
                    "missing outbound peer for {target_peer_id}"
                ))
            })?;
        peer.handle_answer(serde_json::json!({ "type": "answer", "sdp": answer_sdp }))
            .await
            .map_err(|e| SharedTransportError::ConnectionFailed(e.to_string()))?;
        Ok(peer as Arc<dyn SharedPeerLink>)
    }

    async fn handle_candidate(
        &self,
        peer_id: &str,
        candidate: SharedIceCandidate,
    ) -> Result<(), SharedTransportError> {
        let peer = self.peers.read().await.get(peer_id).cloned();
        if let Some(peer) = peer {
            peer.handle_candidate(serde_json::json!({
                "candidate": candidate.candidate,
                "sdpMLineIndex": candidate.sdp_m_line_index,
                "sdpMid": candidate.sdp_mid,
            }))
            .await
            .map_err(|e| SharedTransportError::ConnectionFailed(e.to_string()))?;
        }
        Ok(())
    }

    async fn remove_peer(&self, peer_id: &str) -> Result<(), SharedTransportError> {
        self.peers.write().await.remove(peer_id);
        Ok(())
    }
}

impl WebRTCState {
    pub fn new() -> Self {
        let cfg = WebRTCConfig::default();
        Self::new_with_routing_and_cashu(
            cfg.request_selection_strategy,
            cfg.request_fairness_enabled,
            cfg.request_dispatch,
            Duration::from_millis(cfg.message_timeout_ms),
            CashuRoutingConfig::default(),
            None,
            None,
        )
    }

    pub fn new_with_routing(
        selection_strategy: super::types::SelectionStrategy,
        fairness_enabled: bool,
        request_dispatch: RequestDispatchConfig,
    ) -> Self {
        let cfg = WebRTCConfig::default();
        Self::new_with_routing_and_cashu(
            selection_strategy,
            fairness_enabled,
            request_dispatch,
            Duration::from_millis(cfg.message_timeout_ms),
            CashuRoutingConfig::default(),
            None,
            None,
        )
    }

    pub fn new_with_routing_and_cashu(
        selection_strategy: super::types::SelectionStrategy,
        fairness_enabled: bool,
        request_dispatch: RequestDispatchConfig,
        request_timeout: Duration,
        cashu_routing: CashuRoutingConfig,
        payment_client: Option<Arc<dyn CashuPaymentClient>>,
        mint_metadata: Option<Arc<CashuMintMetadataStore>>,
    ) -> Self {
        let mut selector = PeerSelector::with_strategy(selection_strategy);
        selector.set_fairness(fairness_enabled);
        let peer_selector = Arc::new(RwLock::new(selector));
        let cashu_quotes = Arc::new(if let Some(mint_metadata) = mint_metadata {
            CashuQuoteState::new_with_mint_metadata(
                cashu_routing,
                peer_selector.clone(),
                payment_client,
                mint_metadata,
            )
        } else {
            CashuQuoteState::new(cashu_routing, peer_selector.clone(), payment_client)
        });
        Self {
            peers: RwLock::new(HashMap::new()),
            connected_count: std::sync::atomic::AtomicUsize::new(0),
            bytes_sent: std::sync::atomic::AtomicU64::new(0),
            bytes_received: std::sync::atomic::AtomicU64::new(0),
            mesh_received: std::sync::atomic::AtomicU64::new(0),
            mesh_forwarded: std::sync::atomic::AtomicU64::new(0),
            mesh_dropped_duplicate: std::sync::atomic::AtomicU64::new(0),
            peer_selector,
            request_dispatch,
            request_timeout,
            cashu_quotes,
            local_buses: RwLock::new(Vec::new()),
        }
    }

    pub async fn set_local_buses(&self, buses: Vec<SharedLocalNostrBus>) {
        *self.local_buses.write().await = buses;
    }

    pub async fn add_local_bus(&self, bus: SharedLocalNostrBus) {
        self.local_buses.write().await.push(bus);
    }

    pub async fn set_multicast_bus(&self, bus: Option<Arc<MulticastNostrBus>>) {
        let buses = bus
            .into_iter()
            .map(|bus| bus as SharedLocalNostrBus)
            .collect();
        self.set_local_buses(buses).await;
    }

    /// Drop all live peer sessions and clear topology-specific state while
    /// keeping cumulative bandwidth counters intact.
    pub async fn reset_runtime_state(&self) {
        self.set_local_buses(Vec::new()).await;
        let peers = {
            let mut peers = self.peers.write().await;
            std::mem::take(&mut *peers)
        };
        self.connected_count
            .store(0, std::sync::atomic::Ordering::Relaxed);
        for entry in peers.into_values() {
            if let Some(peer) = entry.peer {
                let _ = peer.close().await;
            }
        }
    }

    /// Get current bandwidth stats (bytes sent/received)
    pub fn get_bandwidth(&self) -> (u64, u64) {
        (
            self.bytes_sent.load(std::sync::atomic::Ordering::Relaxed),
            self.bytes_received
                .load(std::sync::atomic::Ordering::Relaxed),
        )
    }

    pub fn get_mesh_stats(&self) -> (u64, u64, u64) {
        (
            self.mesh_received
                .load(std::sync::atomic::Ordering::Relaxed),
            self.mesh_forwarded
                .load(std::sync::atomic::Ordering::Relaxed),
            self.mesh_dropped_duplicate
                .load(std::sync::atomic::Ordering::Relaxed),
        )
    }

    pub fn record_mesh_received(&self) {
        self.mesh_received
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn record_mesh_forwarded(&self, count: u64) {
        self.mesh_forwarded
            .fetch_add(count, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn record_mesh_duplicate_drop(&self) {
        self.mesh_dropped_duplicate
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// Record bytes sent (global + per-peer)
    pub async fn record_sent(&self, peer_id: &str, bytes: u64) {
        self.bytes_sent
            .fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
        if let Some(entry) = self.peers.write().await.get_mut(peer_id) {
            entry.bytes_sent += bytes;
        }
    }

    /// Record bytes received (global + per-peer)
    pub async fn record_received(&self, peer_id: &str, bytes: u64) {
        self.bytes_received
            .fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
        if let Some(entry) = self.peers.write().await.get_mut(peer_id) {
            entry.bytes_received += bytes;
        }
    }

    /// Request content by hash from connected peers
    /// Queries peers in adaptive selector order with hedged fanout waves.
    /// Returns the first successful response, or None if no peer has it
    pub async fn request_from_peers(&self, hash_hex: &str) -> Option<Vec<u8>> {
        self.request_from_peers_with_source(hash_hex)
            .await
            .map(|(data, _peer_id)| data)
    }

    /// Request content by hash from connected peers, returning data and source peer.
    pub async fn request_from_peers_with_source(
        &self,
        hash_hex: &str,
    ) -> Option<(Vec<u8>, String)> {
        use super::types::BLOB_REQUEST_POLICY;

        let peers = self.peers.read().await;

        let peer_refs: Vec<_> = peers
            .values()
            .filter(|p| p.state == ConnectionState::Connected && p.peer.is_some())
            .filter_map(|p| {
                p.peer
                    .clone()
                    .map(|peer| (p.peer_id.to_string(), peer, p.transport))
            })
            .collect();

        drop(peers); // Release the read lock

        let mut connected_peers: Vec<ConnectedPeer> = Vec::new();
        let mut connected_sessions: Vec<ConnectedSession> = Vec::new();
        for (peer_id, peer, transport) in peer_refs {
            if !peer.is_ready() {
                continue;
            }
            if bluetooth_nostr_only_mode() && transport == PeerTransport::Bluetooth {
                continue;
            }
            if let Some(webrtc_peer) = peer.as_webrtc() {
                let dc_guard = webrtc_peer.data_channel.lock().await;
                if let Some(dc) = dc_guard.as_ref() {
                    connected_peers.push((
                        peer_id.clone(),
                        webrtc_peer.pending_requests.clone(),
                        dc.clone(),
                    ));
                }
            }
            connected_sessions.push((peer_id, peer, transport));
        }

        if connected_sessions.is_empty() {
            debug!(
                "No connected peers to query for {}",
                &hash_hex[..8.min(hash_hex.len())]
            );
            return None;
        }

        // Convert hex to binary hash once
        let hash_bytes = match hex::decode(hash_hex) {
            Ok(b) => b,
            Err(_) => return None,
        };

        let expected_hash: [u8; 32] = match hash_bytes.as_slice().try_into() {
            Ok(h) => h,
            Err(_) => {
                debug!(
                    "Invalid hash length {}, expected 32 bytes",
                    hash_bytes.len()
                );
                return None;
            }
        };

        let connected_peer_ids: Vec<String> = connected_sessions
            .iter()
            .map(|(peer_id, _, _)| peer_id.clone())
            .collect();
        sync_selector_peers(self.peer_selector.as_ref(), &connected_peer_ids).await;

        let ordered_peer_ids = self.peer_selector.write().await.select_peers();
        let mut quote_by_peer: HashMap<
            String,
            (
                PendingRequestsMap,
                Arc<webrtc::data_channel::RTCDataChannel>,
            ),
        > = connected_peers
            .iter()
            .cloned()
            .map(|(peer_id, pending, dc)| (peer_id, (pending, dc)))
            .collect();
        let mut ordered_quote_peers: Vec<ConnectedPeer> = Vec::new();
        for peer_id in &ordered_peer_ids {
            if let Some((pending, dc)) = quote_by_peer.remove(peer_id) {
                ordered_quote_peers.push((peer_id.clone(), pending, dc));
            }
        }
        for (peer_id, (pending, dc)) in quote_by_peer {
            ordered_quote_peers.push((peer_id, pending, dc));
        }

        let mut by_peer: HashMap<String, (MeshPeer, PeerTransport)> = connected_sessions
            .into_iter()
            .map(|(peer_id, peer, transport)| (peer_id, (peer, transport)))
            .collect();

        let mut ordered_peers: Vec<ConnectedSession> = Vec::new();
        for peer_id in ordered_peer_ids {
            if let Some((peer, transport)) = by_peer.remove(&peer_id) {
                ordered_peers.push((peer_id, peer, transport));
            }
        }
        for (peer_id, (peer, transport)) in by_peer {
            ordered_peers.push((peer_id, peer, transport));
        }

        debug!(
            "Querying {} peers for {} with shared hedged scheduler",
            ordered_peers.len(),
            &hash_hex[..8.min(hash_hex.len())],
        );

        if let Some((requested_mint, payment_sat, quote_ttl_ms)) =
            self.cashu_quotes.requester_quote_terms().await
        {
            if let Some(quote) = self
                .request_quote_from_peers(
                    &hash_bytes,
                    requested_mint,
                    payment_sat,
                    quote_ttl_ms,
                    &ordered_quote_peers,
                )
                .await
            {
                if let Some(data) = self
                    .request_from_single_peer(
                        hash_hex,
                        &hash_bytes,
                        expected_hash,
                        &quote.peer_id,
                        Some(&quote),
                        &ordered_quote_peers,
                    )
                    .await
                {
                    debug!(
                        "Got quoted response from peer {} for {}",
                        quote.peer_id,
                        &hash_hex[..8.min(hash_hex.len())]
                    );
                    return Some((data, quote.peer_id));
                }
            }
        }

        let request = DataRequest {
            h: hash_bytes.clone(),
            htl: BLOB_REQUEST_POLICY.max_htl,
            q: None,
        };
        let wire = match encode_request(&request) {
            Ok(w) => w,
            Err(_) => return None,
        };
        let wire_len = wire.len() as u64;
        let current_result_rx = Arc::new(Mutex::new(None));
        if let Some((data, peer_id)) = run_hedged_waves(
            ordered_peers.len(),
            self.request_dispatch,
            self.request_timeout,
            |range| {
                let wave_peers = ordered_peers[range].to_vec();
                let (result_tx, result_rx) =
                    mpsc::channel::<(String, Instant, Result<Option<Vec<u8>>>)>(wave_peers.len());
                let current_result_rx = current_result_rx.clone();
                let hash_hex = hash_hex.to_string();
                async move {
                    *current_result_rx.lock().await = Some(result_rx);
                    let sent = wave_peers.len();
                    for (peer_id, peer, transport) in wave_peers {
                        if transport != PeerTransport::Bluetooth {
                            self.record_sent(&peer_id, wire_len).await;
                        }
                        self.peer_selector
                            .write()
                            .await
                            .record_request(&peer_id, wire_len);

                        let result_tx = result_tx.clone();
                        let peer_id_for_task = peer_id.clone();
                        let peer = peer.clone();
                        let hash_hex = hash_hex.clone();
                        let per_request_timeout = self.request_timeout;
                        tokio::spawn(async move {
                            let started = Instant::now();
                            let result = peer.request(&hash_hex, per_request_timeout).await;
                            let _ = result_tx.send((peer_id_for_task, started, result)).await;
                        });
                    }
                    drop(result_tx);
                    sent
                }
            },
            |wait| {
                let current_result_rx = current_result_rx.clone();
                async move {
                    let mut current_result_rx = current_result_rx.lock().await;
                    let Some(result_rx) = current_result_rx.as_mut() else {
                        return HedgedWaveAction::Abort;
                    };
                    let deadline = Instant::now() + wait;
                    loop {
                        let now = Instant::now();
                        if now >= deadline {
                            return HedgedWaveAction::Continue;
                        }
                        let remaining = deadline.saturating_duration_since(now);
                        match tokio::time::timeout(remaining, result_rx.recv()).await {
                            Ok(Some((peer_id, started, Ok(Some(data))))) => {
                                let rtt_ms = started.elapsed().as_millis() as u64;
                                if hashtree_core::sha256(&data) == expected_hash {
                                    let should_record = {
                                        let peers = self.peers.read().await;
                                        peers
                                            .get(&peer_id)
                                            .map(|entry| {
                                                entry.transport != PeerTransport::Bluetooth
                                            })
                                            .unwrap_or(true)
                                    };
                                    if should_record {
                                        self.record_received(&peer_id, data.len() as u64).await;
                                    }
                                    self.peer_selector.write().await.record_success(
                                        &peer_id,
                                        rtt_ms,
                                        data.len() as u64,
                                    );
                                    return HedgedWaveAction::Success((data, peer_id));
                                }
                                self.peer_selector.write().await.record_failure(&peer_id);
                            }
                            Ok(Some((peer_id, _, Ok(None)))) | Ok(Some((peer_id, _, Err(_)))) => {
                                self.peer_selector.write().await.record_timeout(&peer_id);
                            }
                            Ok(None) | Err(_) => return HedgedWaveAction::Continue,
                        }
                    }
                }
            },
        )
        .await
        {
            debug!(
                "Got response from peer {} for {}",
                peer_id,
                &hash_hex[..8.min(hash_hex.len())]
            );
            return Some((data, peer_id));
        }

        debug!(
            "No peer had data for {}",
            &hash_hex[..8.min(hash_hex.len())]
        );
        None
    }

    async fn request_quote_from_peers(
        &self,
        hash_bytes: &[u8],
        requested_mint: String,
        payment_sat: u64,
        quote_ttl_ms: u32,
        ordered_peers: &[ConnectedPeer],
    ) -> Option<NegotiatedQuote> {
        if ordered_peers.is_empty() || quote_ttl_ms == 0 {
            return None;
        }

        let hash_hex = hex::encode(hash_bytes);
        let rx = self
            .cashu_quotes
            .register_pending_quote(hash_hex.clone(), Some(requested_mint.clone()), payment_sat)
            .await;
        let quote_request = DataQuoteRequest {
            h: hash_bytes.to_vec(),
            p: payment_sat,
            t: quote_ttl_ms,
            m: Some(requested_mint),
        };
        let wire = match encode_quote_request(&quote_request) {
            Ok(wire) => wire,
            Err(_) => {
                self.cashu_quotes.clear_pending_quote(&hash_hex).await;
                return None;
            }
        };
        let rx = Arc::new(Mutex::new(rx));
        let result = run_hedged_waves(
            ordered_peers.len(),
            self.request_dispatch,
            self.request_timeout,
            |range| {
                let wave_peers = ordered_peers[range].to_vec();
                let wire = wire.clone();
                async move {
                    let mut sent = 0usize;
                    for (_, _, dc) in wave_peers {
                        if dc.send(&bytes::Bytes::copy_from_slice(&wire)).await.is_ok() {
                            sent += 1;
                        }
                    }
                    sent
                }
            },
            |wait| {
                let rx = rx.clone();
                async move {
                    let mut rx = rx.lock().await;
                    match tokio::time::timeout(wait, &mut *rx).await {
                        Ok(Ok(Some(quote))) => HedgedWaveAction::Success(quote),
                        Ok(Ok(None)) | Ok(Err(_)) => HedgedWaveAction::Abort,
                        Err(_) => HedgedWaveAction::Continue,
                    }
                }
            },
        )
        .await;

        self.cashu_quotes.clear_pending_quote(&hash_hex).await;
        result
    }

    async fn request_from_single_peer(
        &self,
        hash_hex: &str,
        hash_bytes: &[u8],
        expected_hash: [u8; 32],
        target_peer_id: &str,
        quote: Option<&NegotiatedQuote>,
        ordered_peers: &[ConnectedPeer],
    ) -> Option<Vec<u8>> {
        use super::types::BLOB_REQUEST_POLICY;

        let (pending_requests, dc) = ordered_peers
            .iter()
            .find(|(peer_id, _, _)| peer_id == target_peer_id)
            .map(|(_, pending_requests, dc)| (pending_requests.clone(), dc.clone()))?;

        let request = DataRequest {
            h: hash_bytes.to_vec(),
            htl: BLOB_REQUEST_POLICY.max_htl,
            q: quote.map(|quote| quote.quote_id),
        };
        let wire = encode_request(&request).ok()?;
        let wire_len = wire.len() as u64;
        let sent_at = Instant::now();
        let (tx, mut rx) = tokio::sync::oneshot::channel();

        {
            let mut pending = pending_requests.lock().await;
            pending.insert(
                hash_hex.to_string(),
                if let Some(quote) = quote {
                    PendingRequest::quoted(
                        hash_bytes.to_vec(),
                        tx,
                        quote.quote_id,
                        quote.mint_url.clone().unwrap_or_default(),
                        quote.payment_sat,
                    )
                } else {
                    PendingRequest::standard(hash_bytes.to_vec(), tx)
                },
            );
        }

        if dc
            .send(&bytes::Bytes::copy_from_slice(&wire))
            .await
            .is_err()
        {
            let mut pending = pending_requests.lock().await;
            pending.remove(hash_hex);
            self.peer_selector
                .write()
                .await
                .record_failure(target_peer_id);
            return None;
        }

        self.record_sent(target_peer_id, wire_len).await;
        self.peer_selector
            .write()
            .await
            .record_request(target_peer_id, wire_len);

        let wait_timeout = if let Some(quote) = quote {
            let multiplier = quote.payment_sat.clamp(1, 32) as u128;
            let extra_ms = self
                .cashu_quotes
                .settlement_timeout()
                .as_millis()
                .saturating_mul(multiplier);
            self.request_timeout + Duration::from_millis(extra_ms.min(u64::MAX as u128) as u64)
        } else {
            self.request_timeout
        };

        match tokio::time::timeout(wait_timeout, &mut rx).await {
            Ok(Ok(Some(data))) if hashtree_core::sha256(&data) == expected_hash => {
                let rtt_ms = sent_at.elapsed().as_millis() as u64;
                self.record_received(target_peer_id, data.len() as u64)
                    .await;
                self.peer_selector.write().await.record_success(
                    target_peer_id,
                    rtt_ms,
                    data.len() as u64,
                );
                Some(data)
            }
            Ok(Ok(Some(_))) => {
                self.peer_selector
                    .write()
                    .await
                    .record_failure(target_peer_id);
                let pending = pending_requests.lock().await.remove(hash_hex);
                if let Some(pending) = pending {
                    if let Some(quoted) = pending.quoted {
                        if let Some(in_flight) = quoted.in_flight_payment {
                            let _ = self
                                .cashu_quotes
                                .revoke_payment_token(&in_flight.mint_url, &in_flight.operation_id)
                                .await;
                        }
                    }
                }
                None
            }
            Ok(Ok(None)) | Ok(Err(_)) | Err(_) => {
                let pending = pending_requests.lock().await.remove(hash_hex);
                if let Some(pending) = pending {
                    if let Some(quoted) = pending.quoted {
                        if let Some(in_flight) = quoted.in_flight_payment {
                            let _ = self
                                .cashu_quotes
                                .revoke_payment_token(&in_flight.mint_url, &in_flight.operation_id)
                                .await;
                        }
                    }
                }
                self.peer_selector
                    .write()
                    .await
                    .record_timeout(target_peer_id);
                None
            }
        }
    }

    /// Resolve a hashtree root event through connected peers using Nostr REQ/EOSE over WebRTC.
    pub async fn resolve_root_from_peers(
        &self,
        owner_pubkey: &str,
        tree_name: &str,
        per_peer_timeout: Duration,
    ) -> Option<PeerRootEvent> {
        let filter = build_root_filter(owner_pubkey, tree_name)?;

        let peer_refs: Vec<_> = {
            let peers = self.peers.read().await;
            peers
                .values()
                .filter(|entry| entry.state == ConnectionState::Connected)
                .filter(|entry| {
                    !bluetooth_nostr_only_mode() || entry.transport != PeerTransport::Bluetooth
                })
                .filter_map(|entry| {
                    let peer = entry.peer.as_ref()?;
                    if !peer.is_ready() {
                        return None;
                    }
                    Some((entry.peer_id.short(), peer.clone()))
                })
                .collect()
        };

        for (peer_short, peer) in peer_refs {
            debug!(
                "Querying peer {} for root event {}/{}",
                peer_short, owner_pubkey, tree_name
            );
            let events = match peer
                .query_nostr_events(vec![filter.clone()], per_peer_timeout)
                .await
            {
                Ok(events) => events,
                Err(e) => {
                    debug!(
                        "Peer {} Nostr query failed for {}/{}: {}",
                        peer_short, owner_pubkey, tree_name, e
                    );
                    continue;
                }
            };
            debug!(
                "Peer {} returned {} Nostr event(s) for {}/{}",
                peer_short,
                events.len(),
                owner_pubkey,
                tree_name
            );

            let latest = pick_latest_event(events.iter().filter(|event| {
                hashtree_event_identifier(event).as_deref() == Some(tree_name)
                    && is_hashtree_labeled_event(event)
            }));
            if let Some(event) = latest {
                if let Some(root) = root_event_from_peer(event, &peer_short, tree_name) {
                    debug!(
                        "Resolved {}/{} via peer {} event {}",
                        owner_pubkey,
                        tree_name,
                        peer_short,
                        event.id.to_hex()
                    );
                    return Some(root);
                }
            }
        }

        None
    }

    pub async fn resolve_root_from_local_buses_with_source(
        &self,
        owner_pubkey: &str,
        tree_name: &str,
        timeout: Duration,
    ) -> Option<(&'static str, PeerRootEvent)> {
        let buses = self.local_buses.read().await.clone();
        for bus in buses {
            if let Some(root) = bus.query_root(owner_pubkey, tree_name, timeout).await {
                return Some((bus.source_name(), root));
            }
        }
        None
    }

    pub async fn resolve_root_from_local_buses(
        &self,
        owner_pubkey: &str,
        tree_name: &str,
        timeout: Duration,
    ) -> Option<PeerRootEvent> {
        self.resolve_root_from_local_buses_with_source(owner_pubkey, tree_name, timeout)
            .await
            .map(|(_, root)| root)
    }

    pub async fn resolve_root_from_multicast(
        &self,
        owner_pubkey: &str,
        tree_name: &str,
        timeout: Duration,
    ) -> Option<PeerRootEvent> {
        self.resolve_root_from_local_buses(owner_pubkey, tree_name, timeout)
            .await
    }
}

impl Default for WebRTCState {
    fn default() -> Self {
        Self::new()
    }
}

/// Native mesh manager handles peer discovery and transport fan-out.
pub struct WebRTCManager {
    config: WebRTCConfig,
    my_peer_id: PeerId,
    keys: Keys,
    state: Arc<WebRTCState>,
    shutdown: Arc<tokio::sync::watch::Sender<bool>>,
    shutdown_rx: tokio::sync::watch::Receiver<bool>,
    /// Channel to send signaling messages to relays
    signaling_tx: mpsc::Sender<SignalingMessage>,
    signaling_rx: Option<mpsc::Receiver<SignalingMessage>>,
    /// Optional content store for serving hash requests
    store: Option<Arc<dyn ContentStore>>,
    /// Peer classifier for pool assignment
    peer_classifier: PeerClassifier,
    /// Optional Nostr relay for data-channel relay messages
    nostr_relay: Option<Arc<NostrRelay>>,
    local_buses: Vec<SharedLocalNostrBus>,
    /// Channel for peer state events (connection success/failure)
    state_event_tx: mpsc::Sender<PeerStateEvent>,
    state_event_rx: Option<mpsc::Receiver<PeerStateEvent>>,
    /// Channel for relayless mesh signaling frames received from peers.
    mesh_frame_tx: mpsc::Sender<(PeerId, MeshNostrFrame)>,
    mesh_frame_rx: Option<mpsc::Receiver<(PeerId, MeshNostrFrame)>>,
    shared_router: Option<Arc<SharedProductionRouter>>,
    seen_frame_ids: Arc<Mutex<TimedSeenSet>>,
    seen_event_ids: Arc<Mutex<TimedSeenSet>>,
}

impl WebRTCManager {
    /// Create a new WebRTC manager
    pub fn new(keys: Keys, config: WebRTCConfig) -> Self {
        let pubkey = keys.public_key().to_hex();
        let my_peer_id = PeerId::new(pubkey);
        let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
        let (signaling_tx, signaling_rx) = mpsc::channel(100);
        let (state_event_tx, state_event_rx) = mpsc::channel(100);
        let (mesh_frame_tx, mesh_frame_rx) = mpsc::channel(256);
        let state = Arc::new(WebRTCState::new_with_routing_and_cashu(
            config.request_selection_strategy,
            config.request_fairness_enabled,
            config.request_dispatch,
            Duration::from_millis(config.message_timeout_ms),
            CashuRoutingConfig::default(),
            None,
            None,
        ));

        // Default classifier: all peers go to 'other' pool
        let peer_classifier: PeerClassifier = Arc::new(|_| PeerPool::Other);

        Self {
            config,
            my_peer_id,
            keys,
            state,
            shutdown: Arc::new(shutdown),
            shutdown_rx,
            signaling_tx,
            signaling_rx: Some(signaling_rx),
            store: None,
            peer_classifier,
            nostr_relay: None,
            local_buses: Vec::new(),
            state_event_tx,
            state_event_rx: Some(state_event_rx),
            mesh_frame_tx,
            mesh_frame_rx: Some(mesh_frame_rx),
            shared_router: None,
            seen_frame_ids: Arc::new(Mutex::new(TimedSeenSet::new(
                SEEN_FRAME_CAP,
                SEEN_FRAME_TTL,
            ))),
            seen_event_ids: Arc::new(Mutex::new(TimedSeenSet::new(
                SEEN_EVENT_CAP,
                SEEN_EVENT_TTL,
            ))),
        }
    }

    /// Create a new WebRTC manager reusing an existing shared state object.
    pub fn new_with_state(keys: Keys, config: WebRTCConfig, state: Arc<WebRTCState>) -> Self {
        let mut manager = Self::new(keys, config);
        manager.state = state;
        manager
    }

    /// Create a new WebRTC manager with a peer classifier
    pub fn new_with_classifier(
        keys: Keys,
        config: WebRTCConfig,
        classifier: PeerClassifier,
    ) -> Self {
        let mut manager = Self::new(keys, config);
        manager.peer_classifier = classifier;
        manager
    }

    /// Create a new WebRTC manager with a content store for serving hash requests
    pub fn new_with_store(keys: Keys, config: WebRTCConfig, store: Arc<dyn ContentStore>) -> Self {
        let mut manager = Self::new(keys, config);
        manager.store = Some(store);
        manager
    }

    /// Create a new WebRTC manager with store and classifier
    pub fn new_with_store_and_classifier(
        keys: Keys,
        config: WebRTCConfig,
        store: Arc<dyn ContentStore>,
        classifier: PeerClassifier,
    ) -> Self {
        Self::new_with_store_and_classifier_and_cashu(
            keys,
            config,
            store,
            classifier,
            CashuRoutingConfig::default(),
            None,
            None,
        )
    }

    pub fn new_with_state_and_store_and_classifier(
        keys: Keys,
        config: WebRTCConfig,
        state: Arc<WebRTCState>,
        store: Arc<dyn ContentStore>,
        classifier: PeerClassifier,
    ) -> Self {
        let mut manager = Self::new_with_state(keys, config, state);
        manager.store = Some(store);
        manager.peer_classifier = classifier;
        manager
    }

    pub fn new_with_store_and_classifier_and_cashu(
        keys: Keys,
        config: WebRTCConfig,
        store: Arc<dyn ContentStore>,
        classifier: PeerClassifier,
        cashu_routing: CashuRoutingConfig,
        payment_client: Option<Arc<dyn CashuPaymentClient>>,
        mint_metadata: Option<Arc<CashuMintMetadataStore>>,
    ) -> Self {
        let mut manager = Self::new(keys, config);
        manager.state = Arc::new(WebRTCState::new_with_routing_and_cashu(
            manager.config.request_selection_strategy,
            manager.config.request_fairness_enabled,
            manager.config.request_dispatch,
            Duration::from_millis(manager.config.message_timeout_ms),
            cashu_routing,
            payment_client,
            mint_metadata,
        ));
        manager.store = Some(store);
        manager.peer_classifier = classifier;
        manager
    }

    /// Set the content store for serving hash requests
    pub fn set_store(&mut self, store: Arc<dyn ContentStore>) {
        self.store = Some(store);
    }

    /// Set the peer classifier
    pub fn set_peer_classifier(&mut self, classifier: PeerClassifier) {
        self.peer_classifier = classifier;
    }

    /// Set the Nostr relay for data-channel relay messages
    pub fn set_nostr_relay(&mut self, relay: Arc<NostrRelay>) {
        self.nostr_relay = Some(relay);
    }

    /// Get my peer ID
    pub fn my_peer_id(&self) -> &PeerId {
        &self.my_peer_id
    }

    /// Get shared state for external access
    pub fn state(&self) -> Arc<WebRTCState> {
        self.state.clone()
    }

    /// Cloneable shutdown handle for external lifecycle control.
    pub fn shutdown_signal(&self) -> Arc<tokio::sync::watch::Sender<bool>> {
        self.shutdown.clone()
    }

    /// Signal shutdown
    pub fn shutdown(&self) {
        let _ = self.shutdown.send(true);
    }

    /// Get connected peer count
    pub async fn connected_count(&self) -> usize {
        self.state
            .connected_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Get all peer statuses
    pub async fn peer_statuses(&self) -> Vec<PeerStatus> {
        self.state
            .peers
            .read()
            .await
            .values()
            .map(|p| PeerStatus {
                peer_id: p.peer_id.to_string(),
                pubkey: p.peer_id.pubkey.clone(),
                state: p.state.to_string(),
                direction: p.direction,
                connected_at: Some(p.last_seen),
                pool: p.pool,
            })
            .collect()
    }

    /// Get pool counts
    /// Returns (follows_connected, follows_active, other_connected, other_active)
    /// "active" = Connected or Connecting (excludes Discovered and Failed)
    pub async fn get_pool_counts(&self) -> (usize, usize, usize, usize) {
        let peers = self.state.peers.read().await;
        let mut follows_connected = 0;
        let mut follows_active = 0;
        let mut other_connected = 0;
        let mut other_active = 0;

        for entry in peers.values() {
            // Only count Connected or Connecting as "active" connections
            // Discovered peers are just seen hellos, not real connections
            let is_active = entry.state == ConnectionState::Connected
                || entry.state == ConnectionState::Connecting;

            match entry.pool {
                PeerPool::Follows => {
                    if is_active {
                        follows_active += 1;
                    }
                    if entry.state == ConnectionState::Connected {
                        follows_connected += 1;
                    }
                }
                PeerPool::Other => {
                    if is_active {
                        other_active += 1;
                    }
                    if entry.state == ConnectionState::Connected {
                        other_connected += 1;
                    }
                }
            }
        }

        (
            follows_connected,
            follows_active,
            other_connected,
            other_active,
        )
    }

    fn local_bus_max_peers(&self, source: &str) -> Option<usize> {
        match source {
            "multicast" => Some(self.config.multicast.max_peers),
            WIFI_AWARE_SOURCE => Some(self.config.wifi_aware.max_peers),
            _ => None,
        }
    }

    fn can_track_local_bus_peer(
        &self,
        source: &str,
        peer_key: &str,
        peers: &HashMap<String, PeerEntry>,
    ) -> bool {
        let Some(max_peers) = self.local_bus_max_peers(source) else {
            return true;
        };
        if peers.contains_key(peer_key) {
            return true;
        }
        if max_peers == 0 {
            return false;
        }
        let signal_path = PeerSignalPath::from_source_name(source);
        peers
            .values()
            .filter(|entry| {
                entry.signal_paths.contains(&signal_path) && entry.state != ConnectionState::Failed
            })
            .count()
            < max_peers
    }
}

mod runtime;
