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
use futures::{SinkExt, StreamExt};
use hashtree_webrtc::{
    build_hedged_wave_plan, normalize_dispatch_config, sync_selector_peers, PeerSelector,
};
use nostr::{
    nips::nip44, Alphabet, ClientMessage, EventBuilder, Filter, JsonUtil, Keys, Kind, PublicKey,
    RelayMessage, SingleLetterTag, Tag,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info, warn};

use super::cashu::{CashuMintMetadataStore, CashuQuoteState, CashuRoutingConfig, NegotiatedQuote};
use super::peer::{ContentStore, Peer, PendingRequest};
use super::types::{
    decrement_htl_with_policy, encode_quote_request, encode_request, should_forward_htl,
    validate_mesh_frame, DataQuoteRequest, DataRequest, MeshNostrFrame, MeshNostrPayload,
    PeerDirection, PeerId, PeerPool, PeerStateEvent, PeerStatus, RequestDispatchConfig,
    SignalingMessage, TimedSeenSet, WebRTCConfig, HELLO_TAG, MESH_DEFAULT_HTL, MESH_EVENT_POLICY,
    WEBRTC_KIND,
};
use crate::cashu_helper::CashuPaymentClient;
use crate::nostr_relay::NostrRelay;

/// Callback type for classifying peers into pools
pub type PeerClassifier = Arc<dyn Fn(&str) -> PeerPool + Send + Sync>;

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
    pub peer: Option<Peer>,
    pub pool: PeerPool,
    pub bytes_sent: u64,
    pub bytes_received: u64,
}

/// Shared state for WebRTC manager
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
}

#[derive(Debug, Clone)]
pub struct PeerRootEvent {
    pub hash: String,
    pub key: Option<String>,
    pub encrypted_key: Option<String>,
    pub self_encrypted_key: Option<String>,
    pub event_id: String,
    pub created_at: u64,
    pub peer_id: String,
}

const HASHTREE_KIND: u16 = 30078;
const HASHTREE_LABEL: &str = "hashtree";
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

fn hashtree_event_identifier(event: &nostr::Event) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let slice = tag.as_slice();
        if slice.len() >= 2 && slice[0].as_str() == "d" {
            Some(slice[1].to_string())
        } else {
            None
        }
    })
}

fn is_hashtree_labeled_event(event: &nostr::Event) -> bool {
    event.tags.iter().any(|tag| {
        let slice = tag.as_slice();
        slice.len() >= 2 && slice[0].as_str() == "l" && slice[1].as_str() == HASHTREE_LABEL
    })
}

fn pick_latest_event<'a, I>(events: I) -> Option<&'a nostr::Event>
where
    I: IntoIterator<Item = &'a nostr::Event>,
{
    events.into_iter().max_by(|a, b| {
        let ordering = a.created_at.cmp(&b.created_at);
        if ordering == std::cmp::Ordering::Equal {
            a.id.cmp(&b.id)
        } else {
            ordering
        }
    })
}

fn root_event_from_peer(
    event: &nostr::Event,
    peer_id: &str,
    tree_name: &str,
) -> Option<PeerRootEvent> {
    if hashtree_event_identifier(event).as_deref() != Some(tree_name)
        || !is_hashtree_labeled_event(event)
    {
        return None;
    }

    let mut key = None;
    let mut encrypted_key = None;
    let mut self_encrypted_key = None;
    let mut hash_tag = None;

    for tag in &event.tags {
        let slice = tag.as_slice();
        if slice.len() < 2 {
            continue;
        }
        match slice[0].as_str() {
            "hash" => hash_tag = Some(slice[1].to_string()),
            "key" => key = Some(slice[1].to_string()),
            "encryptedKey" => encrypted_key = Some(slice[1].to_string()),
            "selfEncryptedKey" => self_encrypted_key = Some(slice[1].to_string()),
            _ => {}
        }
    }

    let hash = hash_tag.or_else(|| {
        if event.content.is_empty() {
            None
        } else {
            Some(event.content.clone())
        }
    })?;

    Some(PeerRootEvent {
        hash,
        key,
        encrypted_key,
        self_encrypted_key,
        event_id: event.id.to_hex(),
        created_at: event.created_at.as_u64(),
        peer_id: peer_id.to_string(),
    })
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
        use tokio::sync::oneshot::error::TryRecvError;

        let peers = self.peers.read().await;

        // Collect connected peers with data channels
        // We need to collect the Arc references first, then acquire locks outside the iterator
        let peer_refs: Vec<_> = peers
            .values()
            .filter(|p| p.state == ConnectionState::Connected && p.peer.is_some())
            .filter_map(|p| {
                p.peer.as_ref().map(|peer| {
                    (
                        p.peer_id.to_string(),
                        peer.data_channel.clone(),
                        peer.pending_requests.clone(),
                    )
                })
            })
            .collect();

        drop(peers); // Release the read lock

        // Now acquire locks and filter to peers with active data channels
        let mut connected_peers: Vec<ConnectedPeer> = Vec::new();
        for (peer_id, dc_mutex, pending) in peer_refs {
            let dc_guard = dc_mutex.lock().await;
            if let Some(dc) = dc_guard.as_ref() {
                connected_peers.push((peer_id, pending, dc.clone()));
            }
        }

        if connected_peers.is_empty() {
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

        let connected_peer_ids: Vec<String> = connected_peers
            .iter()
            .map(|(peer_id, _, _)| peer_id.clone())
            .collect();
        sync_selector_peers(self.peer_selector.as_ref(), &connected_peer_ids).await;

        let ordered_peer_ids = self.peer_selector.write().await.select_peers();
        let mut by_peer: HashMap<
            String,
            (
                PendingRequestsMap,
                Arc<webrtc::data_channel::RTCDataChannel>,
            ),
        > = connected_peers
            .into_iter()
            .map(|(peer_id, pending, dc)| (peer_id, (pending, dc)))
            .collect();

        let mut ordered_peers: Vec<ConnectedPeer> = Vec::new();
        for peer_id in ordered_peer_ids {
            if let Some((pending, dc)) = by_peer.remove(&peer_id) {
                ordered_peers.push((peer_id, pending, dc));
            }
        }
        for (peer_id, (pending, dc)) in by_peer {
            ordered_peers.push((peer_id, pending, dc));
        }

        let dispatch = normalize_dispatch_config(self.request_dispatch, ordered_peers.len());
        let wave_plan = build_hedged_wave_plan(ordered_peers.len(), dispatch);
        if wave_plan.is_empty() {
            return None;
        }

        debug!(
            "Querying {} peers for {} (strategy order + hedged waves {:?})",
            ordered_peers.len(),
            &hash_hex[..8.min(hash_hex.len())],
            wave_plan
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
                    &ordered_peers,
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
                        &ordered_peers,
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
        let wait_window = Duration::from_millis(dispatch.hedge_interval_ms.max(1));

        let mut next_peer_idx = 0usize;
        for wave_size in wave_plan {
            let from = next_peer_idx;
            let to = (next_peer_idx + wave_size).min(ordered_peers.len());
            next_peer_idx = to;

            let mut outstanding: Vec<(
                String,
                Arc<Mutex<HashMap<String, PendingRequest>>>,
                Instant,
                tokio::sync::oneshot::Receiver<Option<Vec<u8>>>,
            )> = Vec::new();

            for (peer_id, pending_requests, dc) in &ordered_peers[from..to] {
                let (tx, rx) = tokio::sync::oneshot::channel();
                {
                    let mut pending = pending_requests.lock().await;
                    pending.insert(
                        hash_hex.to_string(),
                        PendingRequest::standard(hash_bytes.clone(), tx),
                    );
                }

                if dc.send(&bytes::Bytes::copy_from_slice(&wire)).await.is_ok() {
                    self.record_sent(peer_id, wire_len).await;
                    self.peer_selector
                        .write()
                        .await
                        .record_request(peer_id, wire_len);
                    outstanding.push((
                        peer_id.clone(),
                        pending_requests.clone(),
                        Instant::now(),
                        rx,
                    ));
                } else {
                    let mut pending = pending_requests.lock().await;
                    pending.remove(hash_hex);
                    self.peer_selector.write().await.record_failure(peer_id);
                }
            }

            if outstanding.is_empty() {
                continue;
            }

            let deadline = Instant::now() + wait_window;
            let mut success: Option<(String, Vec<u8>, u64)> = None;
            while !outstanding.is_empty() && Instant::now() < deadline {
                let mut i = 0usize;
                while i < outstanding.len() {
                    let mut drop_entry = false;
                    let (peer_id, pending_requests, sent_at, rx) = &mut outstanding[i];
                    match rx.try_recv() {
                        Ok(Some(data)) => {
                            let rtt_ms = sent_at.elapsed().as_millis() as u64;
                            if hashtree_core::sha256(&data) == expected_hash {
                                success = Some((peer_id.clone(), data, rtt_ms));
                                break;
                            }
                            self.peer_selector.write().await.record_failure(peer_id);
                            let mut pending = pending_requests.lock().await;
                            pending.remove(hash_hex);
                            drop_entry = true;
                        }
                        Ok(None) => {
                            let mut pending = pending_requests.lock().await;
                            pending.remove(hash_hex);
                            drop_entry = true;
                        }
                        Err(TryRecvError::Closed) => {
                            let mut pending = pending_requests.lock().await;
                            pending.remove(hash_hex);
                            drop_entry = true;
                        }
                        Err(TryRecvError::Empty) => {}
                    }

                    if drop_entry {
                        outstanding.swap_remove(i);
                    } else {
                        i += 1;
                    }
                }

                if success.is_some() {
                    break;
                }

                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10).min(deadline - now)).await;
            }

            if let Some((peer_id, data, rtt_ms)) = success {
                self.record_received(&peer_id, data.len() as u64).await;
                self.peer_selector.write().await.record_success(
                    &peer_id,
                    rtt_ms,
                    data.len() as u64,
                );

                for (other_peer_id, pending_requests, _, _) in outstanding {
                    if other_peer_id != peer_id {
                        let mut pending = pending_requests.lock().await;
                        pending.remove(hash_hex);
                    }
                }

                debug!(
                    "Got response from peer {} for {}",
                    peer_id,
                    &hash_hex[..8.min(hash_hex.len())]
                );
                return Some((data, peer_id));
            }

            for (peer_id, pending_requests, _, _) in outstanding {
                let mut pending = pending_requests.lock().await;
                pending.remove(hash_hex);
                self.peer_selector.write().await.record_timeout(&peer_id);
            }
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

        let dispatch = normalize_dispatch_config(self.request_dispatch, ordered_peers.len());
        let wave_plan = build_hedged_wave_plan(ordered_peers.len(), dispatch);
        if wave_plan.is_empty() {
            return None;
        }

        let hash_hex = hex::encode(hash_bytes);
        let mut rx = self
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
        let deadline = Instant::now() + self.request_timeout;
        let mut sent_total = 0usize;
        let mut next_peer_idx = 0usize;

        for (wave_idx, wave_size) in wave_plan.iter().copied().enumerate() {
            let from = next_peer_idx;
            let to = (next_peer_idx + wave_size).min(ordered_peers.len());
            for (_, _, dc) in &ordered_peers[from..to] {
                if dc.send(&bytes::Bytes::copy_from_slice(&wire)).await.is_ok() {
                    sent_total += 1;
                }
            }
            next_peer_idx = to;

            if sent_total == 0 {
                if next_peer_idx >= ordered_peers.len() {
                    break;
                }
                continue;
            }

            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(now);
            let is_last_wave =
                wave_idx + 1 == wave_plan.len() || next_peer_idx >= ordered_peers.len();
            let wait = if is_last_wave {
                remaining
            } else if dispatch.hedge_interval_ms == 0 {
                Duration::ZERO
            } else {
                Duration::from_millis(dispatch.hedge_interval_ms).min(remaining)
            };

            if wait.is_zero() {
                continue;
            }

            match tokio::time::timeout(wait, &mut rx).await {
                Ok(Ok(Some(quote))) => {
                    self.cashu_quotes.clear_pending_quote(&hash_hex).await;
                    return Some(quote);
                }
                Ok(Ok(None)) | Ok(Err(_)) => break,
                Err(_) => {}
            }
        }

        self.cashu_quotes.clear_pending_quote(&hash_hex).await;
        None
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
        let author = PublicKey::from_hex(owner_pubkey).ok()?;
        let filter = Filter::new()
            .kind(Kind::Custom(HASHTREE_KIND))
            .author(author)
            .custom_tag(
                SingleLetterTag::lowercase(Alphabet::D),
                vec![tree_name.to_string()],
            )
            .custom_tag(
                SingleLetterTag::lowercase(Alphabet::L),
                vec![HASHTREE_LABEL.to_string()],
            )
            .limit(50);

        let peers = self.peers.read().await;
        for entry in peers.values() {
            if entry.state != ConnectionState::Connected {
                continue;
            }
            let Some(peer) = entry.peer.as_ref() else {
                continue;
            };
            if !peer.has_data_channel() {
                continue;
            }

            debug!(
                "Querying peer {} for root event {}/{}",
                entry.peer_id.short(),
                owner_pubkey,
                tree_name
            );
            let events = match peer
                .query_nostr_events(vec![filter.clone()], per_peer_timeout)
                .await
            {
                Ok(events) => events,
                Err(e) => {
                    debug!(
                        "Peer {} Nostr query failed for {}/{}: {}",
                        entry.peer_id.short(),
                        owner_pubkey,
                        tree_name,
                        e
                    );
                    continue;
                }
            };
            debug!(
                "Peer {} returned {} Nostr event(s) for {}/{}",
                entry.peer_id.short(),
                events.len(),
                owner_pubkey,
                tree_name
            );

            let latest = pick_latest_event(events.iter().filter(|event| {
                hashtree_event_identifier(event).as_deref() == Some(tree_name)
                    && is_hashtree_labeled_event(event)
            }));
            if let Some(event) = latest {
                if let Some(root) = root_event_from_peer(event, &entry.peer_id.short(), tree_name) {
                    debug!(
                        "Resolved {}/{} via peer {} event {}",
                        owner_pubkey,
                        tree_name,
                        entry.peer_id.short(),
                        event.id.to_hex()
                    );
                    return Some(root);
                }
            }
        }

        None
    }
}

/// WebRTC manager handles peer discovery and connection management
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
    /// Channel for peer state events (connection success/failure)
    state_event_tx: mpsc::Sender<PeerStateEvent>,
    state_event_rx: Option<mpsc::Receiver<PeerStateEvent>>,
    /// Channel for relayless mesh signaling frames received from peers.
    mesh_frame_tx: mpsc::Sender<(PeerId, MeshNostrFrame)>,
    mesh_frame_rx: Option<mpsc::Receiver<(PeerId, MeshNostrFrame)>>,
    seen_frame_ids: Arc<Mutex<TimedSeenSet>>,
    seen_event_ids: Arc<Mutex<TimedSeenSet>>,
}

impl WebRTCManager {
    /// Create a new WebRTC manager
    pub fn new(keys: Keys, config: WebRTCConfig) -> Self {
        let pubkey = keys.public_key().to_hex();
        let my_peer_id = PeerId::new(pubkey, None);
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
            state_event_tx,
            state_event_rx: Some(state_event_rx),
            mesh_frame_tx,
            mesh_frame_rx: Some(mesh_frame_rx),
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

    /// Check if we can accept a peer in a given pool
    fn can_accept_peer(&self, pool: PeerPool, pool_counts: &(usize, usize, usize, usize)) -> bool {
        let (_, follows_active, _, other_active) = *pool_counts;
        match pool {
            PeerPool::Follows => follows_active < self.config.pools.follows.max_connections,
            PeerPool::Other => other_active < self.config.pools.other.max_connections,
        }
    }

    /// Check if a pool is satisfied
    #[allow(dead_code)]
    fn is_pool_satisfied(
        &self,
        pool: PeerPool,
        pool_counts: &(usize, usize, usize, usize),
    ) -> bool {
        let (follows_connected, _, other_connected, _) = *pool_counts;
        match pool {
            PeerPool::Follows => {
                follows_connected >= self.config.pools.follows.satisfied_connections
            }
            PeerPool::Other => other_connected >= self.config.pools.other.satisfied_connections,
        }
    }

    /// Check if both pools are satisfied
    #[allow(dead_code)]
    fn is_satisfied(&self, pool_counts: &(usize, usize, usize, usize)) -> bool {
        self.is_pool_satisfied(PeerPool::Follows, pool_counts)
            && self.is_pool_satisfied(PeerPool::Other, pool_counts)
    }

    /// Check if we should initiate connection (tie-breaking)
    /// Lower UUID initiates - same as iris-client/hashtree-ts
    fn should_initiate(&self, their_uuid: &str) -> bool {
        self.my_peer_id.uuid < their_uuid.to_string()
    }

    /// Start the WebRTC manager - connects to relays and handles signaling
    pub async fn run(&mut self) -> Result<()> {
        info!(
            "Starting WebRTC manager with peer ID: {}",
            self.my_peer_id.short()
        );

        let (event_tx, mut event_rx) = mpsc::channel::<(String, nostr::Event)>(100);

        // Take the signaling receiver
        let mut signaling_rx = self
            .signaling_rx
            .take()
            .expect("signaling_rx already taken");

        // Take the state event receiver
        let mut state_event_rx = self
            .state_event_rx
            .take()
            .expect("state_event_rx already taken");
        let mut mesh_frame_rx = self
            .mesh_frame_rx
            .take()
            .expect("mesh_frame_rx already taken");

        // Create a shared write channel for all relay tasks
        let (relay_write_tx, _) = tokio::sync::broadcast::channel::<SignalingMessage>(100);

        // Spawn relay connections
        for relay_url in &self.config.relays {
            let url = relay_url.clone();
            let event_tx = event_tx.clone();
            let shutdown_rx = self.shutdown_rx.clone();
            let keys = self.keys.clone();
            let relay_write_rx = relay_write_tx.subscribe();

            tokio::spawn(async move {
                if let Err(e) =
                    Self::relay_task(url.clone(), event_tx, shutdown_rx, keys, relay_write_rx).await
                {
                    error!("Relay {} error: {}", url, e);
                }
            });
        }

        // Process incoming events and outgoing signaling messages
        let mut shutdown_rx = self.shutdown_rx.clone();
        // Cleanup interval - run every 30 seconds as a fallback (not for real-time sync)
        let mut cleanup_interval = tokio::time::interval(Duration::from_secs(30));
        let mut hello_ticker =
            tokio::time::interval(Duration::from_millis(self.config.hello_interval_ms));
        self.dispatch_signaling_message(
            SignalingMessage::hello(&self.my_peer_id.uuid),
            &relay_write_tx,
        )
        .await;
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        info!("WebRTC manager shutting down");
                        break;
                    }
                }
                Some((relay, event)) = event_rx.recv() => {
                    if let Err(e) = self.handle_event(&relay, &event, &relay_write_tx).await {
                        debug!("Error handling event from {}: {}", relay, e);
                    }
                }
                Some(msg) = signaling_rx.recv() => {
                    self.dispatch_signaling_message(msg, &relay_write_tx).await;
                }
                Some(event) = state_event_rx.recv() => {
                    // Handle peer state events (connected, failed, disconnected)
                    self.handle_peer_state_event(event, &relay_write_tx).await;
                }
                Some((from_peer_id, frame)) = mesh_frame_rx.recv() => {
                    self.handle_mesh_frame(from_peer_id, frame, &relay_write_tx).await;
                }
                _ = hello_ticker.tick() => {
                    self.dispatch_signaling_message(
                        SignalingMessage::hello(&self.my_peer_id.uuid),
                        &relay_write_tx,
                    ).await;
                }
                _ = cleanup_interval.tick() => {
                    // Periodic cleanup of stale peers and state sync (fallback)
                    self.cleanup_stale_peers().await;
                }
            }
        }

        Ok(())
    }

    /// Connect to a single relay and handle messages
    async fn relay_task(
        url: String,
        event_tx: mpsc::Sender<(String, nostr::Event)>,
        mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
        keys: Keys,
        mut signaling_rx: tokio::sync::broadcast::Receiver<SignalingMessage>,
    ) -> Result<()> {
        info!("Connecting to relay: {}", url);

        let (ws_stream, _) = connect_async(&url).await?;
        let (mut write, mut read) = ws_stream.split();

        // Subscribe to webrtc events - two filters:
        // 1. Hello messages: kind 25050 with #l: "hello" tag
        // 2. Directed messages: kind 25050 with #p tag (our pubkey)
        let hello_filter = Filter::new()
            .kind(Kind::Ephemeral(WEBRTC_KIND as u16))
            .custom_tag(
                nostr::SingleLetterTag::lowercase(nostr::Alphabet::L),
                vec![HELLO_TAG],
            )
            .since(nostr::Timestamp::now() - Duration::from_secs(60));

        let directed_filter = Filter::new()
            .kind(Kind::Ephemeral(WEBRTC_KIND as u16))
            .custom_tag(
                nostr::SingleLetterTag::lowercase(nostr::Alphabet::P),
                vec![keys.public_key().to_hex()],
            )
            .since(nostr::Timestamp::now() - Duration::from_secs(60));

        let sub_id = nostr::SubscriptionId::generate();
        let sub_msg = ClientMessage::req(sub_id.clone(), vec![hello_filter, directed_filter]);
        write.send(Message::Text(sub_msg.as_json().into())).await?;

        info!(
            "Subscribed to {} for WebRTC events (kind {})",
            url, WEBRTC_KIND
        );

        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
                // Handle outgoing signaling messages
                Ok(signaling_msg) = signaling_rx.recv() => {
                    info!("Sending {} via {}", signaling_msg.msg_type(), url);
                    if let Ok(event) = Self::create_signaling_event(&keys, &signaling_msg).await {
                        let event_id = event.id.to_string();
                        let msg = ClientMessage::event(event);
                        if write.send(Message::Text(msg.as_json().into())).await.is_ok() {
                            info!("Sent {} to {} (event id: {})", signaling_msg.msg_type(), url, &event_id[..16]);
                        }
                    }
                }
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(relay_msg) = RelayMessage::from_json(&text) {
                                if let RelayMessage::Event { event, .. } = relay_msg {
                                    let _ = event_tx.send((url.clone(), *event)).await;
                                }
                            }
                        }
                        Some(Err(e)) => {
                            error!("WebSocket error from {}: {}", url, e);
                            break;
                        }
                        None => {
                            warn!("WebSocket closed: {}", url);
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        Ok(())
    }

    async fn mark_seen_frame_id(&self, frame_id: String) -> bool {
        let mut seen = self.seen_frame_ids.lock().await;
        seen.insert_if_new(frame_id)
    }

    async fn mark_seen_event_id(&self, event_id: String) -> bool {
        let mut seen = self.seen_event_ids.lock().await;
        seen.insert_if_new(event_id)
    }

    async fn dispatch_signaling_message(
        &self,
        msg: SignalingMessage,
        relay_write_tx: &tokio::sync::broadcast::Sender<SignalingMessage>,
    ) {
        if relay_write_tx.send(msg.clone()).is_err() {
            debug!(
                "No relay subscribers for signaling message {}",
                msg.msg_type()
            );
        }

        let event = match Self::create_signaling_event(&self.keys, &msg).await {
            Ok(event) => event,
            Err(e) => {
                debug!("Failed to create signaling event for mesh dispatch: {}", e);
                return;
            }
        };

        let mut frame =
            MeshNostrFrame::new_event(event, &self.my_peer_id.to_string(), MESH_DEFAULT_HTL);
        if !self.mark_seen_frame_id(frame.frame_id.clone()).await {
            self.state.record_mesh_duplicate_drop();
            return;
        }
        if !self.mark_seen_event_id(frame.event().id.to_hex()).await {
            self.state.record_mesh_duplicate_drop();
            return;
        }

        // Keep the sender peer id stable even if this is forwarded later.
        frame.sender_peer_id = self.my_peer_id.to_string();
        let forwarded = self.forward_mesh_frame(&frame, None).await;
        if forwarded > 0 {
            self.state.record_mesh_forwarded(forwarded as u64);
        }
    }

    async fn forward_mesh_frame(
        &self,
        frame: &MeshNostrFrame,
        exclude_peer_id: Option<&str>,
    ) -> usize {
        let peers = self.state.peers.read().await;
        let peer_refs: Vec<_> = peers
            .values()
            .filter(|entry| entry.state == ConnectionState::Connected)
            .filter(|entry| {
                entry
                    .peer
                    .as_ref()
                    .map(|peer| peer.has_data_channel())
                    .unwrap_or(false)
            })
            .filter(|entry| {
                exclude_peer_id
                    .map(|exclude| exclude != entry.peer_id.to_string())
                    .unwrap_or(true)
            })
            .filter_map(|entry| {
                entry.peer.as_ref().map(|peer| {
                    (
                        entry.peer_id.to_string(),
                        entry.peer_id.short(),
                        peer.data_channel.clone(),
                        peer.htl_config().clone(),
                    )
                })
            })
            .collect();
        drop(peers);

        let mut forwarded = 0usize;
        for (_peer_key, peer_short, dc_mutex, htl_cfg) in peer_refs {
            let next_htl = decrement_htl_with_policy(frame.htl, &MESH_EVENT_POLICY, &htl_cfg);
            if !should_forward_htl(next_htl) {
                continue;
            }

            let mut outbound = frame.clone();
            outbound.htl = next_htl;
            let text = match serde_json::to_string(&outbound) {
                Ok(text) => text,
                Err(e) => {
                    debug!("Failed to serialize mesh frame for {}: {}", peer_short, e);
                    continue;
                }
            };

            let dc_guard = dc_mutex.lock().await;
            let Some(dc) = dc_guard.as_ref() else {
                continue;
            };
            if dc.ready_state()
                != webrtc::data_channel::data_channel_state::RTCDataChannelState::Open
            {
                continue;
            }
            if dc.send_text(text).await.is_ok() {
                forwarded += 1;
            }
        }

        forwarded
    }

    async fn handle_mesh_frame(
        &self,
        from_peer_id: PeerId,
        frame: MeshNostrFrame,
        relay_write_tx: &tokio::sync::broadcast::Sender<SignalingMessage>,
    ) {
        if let Err(reason) = validate_mesh_frame(&frame) {
            debug!(
                "Ignoring mesh frame from {} (invalid: {})",
                from_peer_id.short(),
                reason
            );
            return;
        }

        if !self.mark_seen_frame_id(frame.frame_id.clone()).await {
            self.state.record_mesh_duplicate_drop();
            return;
        }

        let event = match &frame.payload {
            MeshNostrPayload::Event { event } => event.clone(),
        };

        if !self.mark_seen_event_id(event.id.to_hex()).await {
            self.state.record_mesh_duplicate_drop();
            return;
        }

        if event.verify().is_err() {
            debug!(
                "Ignoring mesh event from {} due to invalid signature",
                from_peer_id.short()
            );
            return;
        }

        self.state.record_mesh_received();

        if let Err(e) = self.handle_event("mesh", &event, relay_write_tx).await {
            debug!(
                "Error handling mesh event from {}: {}",
                from_peer_id.short(),
                e
            );
        }

        let forwarded = self
            .forward_mesh_frame(&frame, Some(&from_peer_id.to_string()))
            .await;
        if forwarded > 0 {
            self.state.record_mesh_forwarded(forwarded as u64);
        }
    }

    /// Create a signaling event
    ///
    /// For directed messages (offer, answer, candidate, candidates), use NIP-17 style
    /// gift wrapping with ephemeral keys for privacy.
    /// Hello messages use kind 25050 with #l: "hello" tag and peerId.
    async fn create_signaling_event(keys: &Keys, msg: &SignalingMessage) -> Result<nostr::Event> {
        // Check if message has a recipient (needs gift wrapping)
        if let Some(recipient_str) = msg.recipient() {
            // Parse recipient to get their pubkey
            if let Some(peer_id) = PeerId::from_string(recipient_str) {
                let recipient_pubkey = PublicKey::from_hex(&peer_id.pubkey)?;

                // Create seal with sender's actual pubkey (the "rumor")
                let seal = serde_json::json!({
                    "pubkey": keys.public_key().to_hex(),
                    "kind": WEBRTC_KIND,
                    "content": serde_json::to_string(msg)?,
                    "tags": []
                });

                // Generate ephemeral keypair for the wrapper
                let ephemeral_keys = Keys::generate();

                // Encrypt the seal for the recipient using ephemeral key (NIP-44)
                let encrypted_content = nip44::encrypt(
                    ephemeral_keys.secret_key(),
                    &recipient_pubkey,
                    &seal.to_string(),
                    nip44::Version::V2,
                )?;

                // Create wrapper event with ephemeral key
                let created_at = nostr::Timestamp::now();
                let expiration = created_at + Duration::from_secs(5 * 60); // 5 minutes

                let tags = vec![
                    Tag::parse(&["p", &recipient_pubkey.to_hex()])?,
                    Tag::parse(&["expiration", &expiration.as_u64().to_string()])?,
                ];

                let event =
                    EventBuilder::new(Kind::Ephemeral(WEBRTC_KIND as u16), encrypted_content, tags)
                        .to_event(&ephemeral_keys)?;

                return Ok(event);
            }
        }

        // Hello messages - kind 25050 with #l: "hello" tag and peerId
        let tags = vec![
            Tag::parse(&["l", HELLO_TAG])?,
            Tag::parse(&["peerId", msg.peer_id()])?,
        ];

        let event =
            EventBuilder::new(Kind::Ephemeral(WEBRTC_KIND as u16), "", tags).to_event(keys)?;

        Ok(event)
    }

    /// Handle an incoming event
    ///
    /// Messages may be:
    /// 1. Hello messages: kind 25050 with #l: "hello" tag and peerId
    /// 2. Gift-wrapped directed messages: kind 25050 with #p tag, encrypted with ephemeral key
    async fn handle_event(
        &self,
        relay: &str,
        event: &nostr::Event,
        relay_write_tx: &tokio::sync::broadcast::Sender<SignalingMessage>,
    ) -> Result<()> {
        // Must be kind 25050
        if event.kind != Kind::Ephemeral(WEBRTC_KIND as u16) {
            return Ok(());
        }

        // Helper to get tag value
        let get_tag = |name: &str| -> Option<String> {
            event.tags.iter().find_map(|tag| {
                let v: Vec<String> = tag.clone().to_vec();
                if v.len() >= 2 && v[0] == name {
                    Some(v[1].clone())
                } else {
                    None
                }
            })
        };

        // Check if this is a hello message (#l: "hello" tag)
        let l_tag = get_tag("l");
        if l_tag.as_deref() == Some(HELLO_TAG) {
            let sender_pubkey = event.pubkey.to_hex();

            // Skip our own hello messages
            if sender_pubkey == self.my_peer_id.pubkey {
                return Ok(());
            }

            if let Some(their_uuid) = get_tag("peerId") {
                debug!("Received hello from {} via {}", &sender_pubkey[..8], relay);
                self.handle_hello(&sender_pubkey, &their_uuid, relay_write_tx)
                    .await?;
            }
            return Ok(());
        }

        // Check if this is a directed message for us (#p tag with our pubkey)
        let p_tag = get_tag("p");
        if p_tag.as_deref() != Some(&self.keys.public_key().to_hex()) {
            // Not for us - ignore silently
            return Ok(());
        }

        // Gift-wrapped directed message - decrypt using our key and ephemeral sender's pubkey
        if event.content.is_empty() {
            return Ok(());
        }

        // Try to unwrap the gift - decrypt with our key and the ephemeral sender's pubkey
        let seal: serde_json::Value =
            match nip44::decrypt(self.keys.secret_key(), &event.pubkey, &event.content) {
                Ok(plaintext) => match serde_json::from_str(&plaintext) {
                    Ok(v) => v,
                    Err(_) => return Ok(()),
                },
                Err(_) => {
                    // Can't decrypt - not for us or invalid
                    return Ok(());
                }
            };

        // Extract the actual sender's pubkey and content from the seal
        let sender_pubkey = seal
            .get("pubkey")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Missing pubkey in seal"))?;

        // Skip our own messages
        if sender_pubkey == self.my_peer_id.pubkey {
            return Ok(());
        }

        let content = seal
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Missing content in seal"))?;

        let raw_msg: serde_json::Value = serde_json::from_str(content)?;
        let msg_type = raw_msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Support hashtree-ts format: { type, peerId, targetPeerId, sdp/candidate/candidates }
        if raw_msg.get("targetPeerId").is_some() {
            let target_peer = raw_msg
                .get("targetPeerId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if target_peer != self.my_peer_id.to_string() {
                return Ok(());
            }

            let peer_id = raw_msg.get("peerId").and_then(|v| v.as_str()).unwrap_or("");
            let their_uuid = peer_id.split(':').nth(1).unwrap_or(peer_id);

            match msg_type {
                "offer" => {
                    let sdp = raw_msg
                        .get("sdp")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| anyhow::anyhow!("Missing SDP in offer"))?;
                    let offer = serde_json::json!({ "type": "offer", "sdp": sdp });
                    self.handle_offer(&sender_pubkey, their_uuid, offer, relay_write_tx)
                        .await?;
                }
                "answer" => {
                    let sdp = raw_msg
                        .get("sdp")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| anyhow::anyhow!("Missing SDP in answer"))?;
                    let answer = serde_json::json!({ "type": "answer", "sdp": sdp });
                    self.handle_answer(&sender_pubkey, their_uuid, answer)
                        .await?;
                }
                "candidate" => {
                    let candidate = raw_msg
                        .get("candidate")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !candidate.is_empty() {
                        let candidate_json = serde_json::json!({
                            "candidate": candidate,
                            "sdpMid": raw_msg.get("sdpMid"),
                            "sdpMLineIndex": raw_msg.get("sdpMLineIndex"),
                        });
                        self.handle_candidate(&sender_pubkey, their_uuid, candidate_json)
                            .await?;
                    }
                }
                "candidates" => {
                    let candidates = raw_msg
                        .get("candidates")
                        .and_then(|v| v.as_array())
                        .map(|entries| {
                            entries
                                .iter()
                                .filter_map(|entry| {
                                    if let Some(candidate_str) = entry
                                        .get("candidate")
                                        .and_then(|v| v.as_str())
                                        .or_else(|| entry.as_str())
                                    {
                                        Some(serde_json::json!({
                                            "candidate": candidate_str,
                                            "sdpMid": entry.get("sdpMid"),
                                            "sdpMLineIndex": entry.get("sdpMLineIndex"),
                                        }))
                                    } else {
                                        None
                                    }
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    self.handle_candidates(&sender_pubkey, their_uuid, candidates)
                        .await?;
                }
                _ => {}
            }

            return Ok(());
        }

        let msg: SignalingMessage = serde_json::from_value(raw_msg)?;

        debug!(
            "Received {} from {} via {} (gift-wrapped)",
            msg.msg_type(),
            &sender_pubkey[..8],
            relay
        );

        match msg {
            SignalingMessage::Hello { .. } => {
                // Hello messages should come via tags, not gift wrap
                return Ok(());
            }
            SignalingMessage::Offer {
                recipient,
                peer_id: their_uuid,
                offer,
            } => {
                if recipient != self.my_peer_id.to_string() {
                    return Ok(()); // Not for us
                }
                if let Err(e) = self
                    .handle_offer(&sender_pubkey, &their_uuid, offer, relay_write_tx)
                    .await
                {
                    error!(
                        "handle_offer FAILED: sender={}, uuid={}, error={:?}",
                        &sender_pubkey[..8.min(sender_pubkey.len())],
                        their_uuid,
                        e
                    );
                    return Err(e);
                }
            }
            SignalingMessage::Answer {
                recipient,
                peer_id: their_uuid,
                answer,
            } => {
                if recipient != self.my_peer_id.to_string() {
                    return Ok(());
                }
                self.handle_answer(&sender_pubkey, &their_uuid, answer)
                    .await?;
            }
            SignalingMessage::Candidate {
                recipient,
                peer_id: their_uuid,
                candidate,
            } => {
                if recipient != self.my_peer_id.to_string() {
                    return Ok(());
                }
                self.handle_candidate(&sender_pubkey, &their_uuid, candidate)
                    .await?;
            }
            SignalingMessage::Candidates {
                recipient,
                peer_id: their_uuid,
                candidates,
            } => {
                if recipient != self.my_peer_id.to_string() {
                    return Ok(());
                }
                self.handle_candidates(&sender_pubkey, &their_uuid, candidates)
                    .await?;
            }
        }

        Ok(())
    }

    /// Handle incoming hello message
    async fn handle_hello(
        &self,
        sender_pubkey: &str,
        their_uuid: &str,
        relay_write_tx: &tokio::sync::broadcast::Sender<SignalingMessage>,
    ) -> Result<()> {
        let full_peer_id = PeerId::new(sender_pubkey.to_string(), Some(their_uuid.to_string()));
        let peer_key = full_peer_id.to_string();
        let mut already_discovered = false;

        // Check if we already have this peer
        {
            let peers = self.state.peers.read().await;
            if let Some(entry) = peers.get(&peer_key) {
                // Already connected or connecting, just update last_seen
                if entry.state == ConnectionState::Connected
                    || entry.state == ConnectionState::Connecting
                {
                    return Ok(());
                }
                already_discovered = true;
            }
        }

        // Classify the peer into a pool
        let pool = (self.peer_classifier)(sender_pubkey);

        // Check pool limits
        let pool_counts = self.get_pool_counts().await;
        if !self.can_accept_peer(pool, &pool_counts) {
            debug!(
                "Ignoring hello from {} - pool {:?} is full",
                full_peer_id.short(),
                pool
            );
            return Ok(());
        }

        // Decide if we should initiate based on tie-breaking
        let should_initiate = self.should_initiate(their_uuid);

        // If pool is already satisfied, don't initiate new outbound connections
        // This reserves space for inbound connections
        let pool_satisfied = self.is_pool_satisfied(pool, &pool_counts);
        let will_initiate = should_initiate && !pool_satisfied;

        info!(
            "Discovered peer: {} (pool: {:?}, initiate: {}, pool_satisfied: {})",
            full_peer_id.short(),
            pool,
            will_initiate,
            pool_satisfied
        );

        // If we're not initiating and pool is satisfied, don't even add to discovered
        // (we won't accept their offer either since pool check happens in handle_offer)
        if !will_initiate && pool_satisfied {
            debug!(
                "Pool {:?} is satisfied, not tracking peer {}",
                pool,
                full_peer_id.short()
            );
            return Ok(());
        }

        // Create peer entry with pool assignment
        {
            let mut peers = self.state.peers.write().await;
            peers.insert(
                peer_key.clone(),
                PeerEntry {
                    peer_id: full_peer_id.clone(),
                    direction: if will_initiate {
                        PeerDirection::Outbound
                    } else {
                        PeerDirection::Inbound
                    },
                    state: ConnectionState::Discovered,
                    last_seen: Instant::now(),
                    peer: None,
                    pool,
                    bytes_sent: 0,
                    bytes_received: 0,
                },
            );
        }

        // If we discovered a peer but are not the initiator, send one immediate hello
        // to accelerate reciprocal discovery over relayless mesh paths.
        if !will_initiate && !already_discovered {
            self.dispatch_signaling_message(
                SignalingMessage::hello(&self.my_peer_id.uuid),
                relay_write_tx,
            )
            .await;
        }

        // If we should initiate, create offer
        if will_initiate {
            self.initiate_connection(&full_peer_id, pool, relay_write_tx)
                .await?;
        }

        Ok(())
    }

    /// Initiate a connection to a peer (create and send offer)
    async fn initiate_connection(
        &self,
        peer_id: &PeerId,
        pool: PeerPool,
        relay_write_tx: &tokio::sync::broadcast::Sender<SignalingMessage>,
    ) -> Result<()> {
        let peer_key = peer_id.to_string();

        info!(
            "Initiating connection to {} (pool: {:?})",
            peer_id.short(),
            pool
        );

        // Create peer connection with content store and state events
        let mut peer = Peer::new_with_store_and_events(
            peer_id.clone(),
            PeerDirection::Outbound,
            self.my_peer_id.clone(),
            self.signaling_tx.clone(),
            self.config.stun_servers.clone(),
            self.store.clone(),
            Some(self.state_event_tx.clone()),
            self.nostr_relay.clone(),
            Some(self.mesh_frame_tx.clone()),
            Some(self.state.cashu_quotes.clone()),
        )
        .await?;

        peer.setup_handlers().await?;

        // Create offer
        let offer = peer.connect().await?;

        // Update state
        {
            let mut peers = self.state.peers.write().await;
            if let Some(entry) = peers.get_mut(&peer_key) {
                entry.state = ConnectionState::Connecting;
                entry.peer = Some(peer);
                entry.pool = pool;
            }
        }

        // Send offer
        let offer_msg = SignalingMessage::Offer {
            offer,
            recipient: peer_id.to_string(),
            peer_id: self.my_peer_id.uuid.clone(),
        };
        self.dispatch_signaling_message(offer_msg, relay_write_tx)
            .await;

        info!("Sent offer to {}", peer_id.short());

        Ok(())
    }

    /// Handle incoming offer
    async fn handle_offer(
        &self,
        sender_pubkey: &str,
        their_uuid: &str,
        offer: serde_json::Value,
        relay_write_tx: &tokio::sync::broadcast::Sender<SignalingMessage>,
    ) -> Result<()> {
        debug!(
            "handle_offer ENTRY: sender={}, uuid={}",
            &sender_pubkey[..8.min(sender_pubkey.len())],
            their_uuid
        );
        let full_peer_id = PeerId::new(sender_pubkey.to_string(), Some(their_uuid.to_string()));
        let peer_key = full_peer_id.to_string();

        // Classify the peer into a pool
        let pool = (self.peer_classifier)(sender_pubkey);

        info!(
            "Received offer from {} (pool: {:?})",
            full_peer_id.short(),
            pool
        );

        // Check if we already have this peer with an actual connection
        {
            let peers = self.state.peers.read().await;
            debug!(
                "Checking for existing peer, peer_key: {}, known_peers: {}",
                peer_key,
                peers.len()
            );
            if let Some(entry) = peers.get(&peer_key) {
                // Only skip if we have an actual peer connection (not just discovered)
                if entry.peer.is_some() {
                    debug!(
                        "Already have peer {} with connection, skipping offer",
                        full_peer_id.short()
                    );
                    return Ok(());
                }
                debug!(
                    "Peer {} exists but has no connection, proceeding",
                    full_peer_id.short()
                );
            } else {
                debug!(
                    "Peer {} not found in peers map, will create new entry",
                    full_peer_id.short()
                );
            }
        }

        // Check pool limits
        let pool_counts = self.get_pool_counts().await;
        debug!(
            "Pool counts: {:?}, checking can_accept_peer for {:?}",
            pool_counts, pool
        );
        if !self.can_accept_peer(pool, &pool_counts) {
            warn!(
                "Rejecting offer from {} - pool {:?} is full",
                full_peer_id.short(),
                pool
            );
            return Ok(());
        }
        debug!("Pool check passed for {}", full_peer_id.short());

        // Create peer connection with content store and state events
        debug!("Creating peer connection for {}", full_peer_id.short());
        let mut peer = Peer::new_with_store_and_events(
            full_peer_id.clone(),
            PeerDirection::Inbound,
            self.my_peer_id.clone(),
            self.signaling_tx.clone(),
            self.config.stun_servers.clone(),
            self.store.clone(),
            Some(self.state_event_tx.clone()),
            self.nostr_relay.clone(),
            Some(self.mesh_frame_tx.clone()),
            Some(self.state.cashu_quotes.clone()),
        )
        .await?;
        debug!("Peer connection created for {}", full_peer_id.short());

        peer.setup_handlers().await?;
        debug!("Handlers set up for {}", full_peer_id.short());

        // Handle offer and create answer
        let answer = peer.handle_offer(offer).await?;
        debug!("Answer created for {}", full_peer_id.short());

        // Update state
        {
            let mut peers = self.state.peers.write().await;
            peers.insert(
                peer_key,
                PeerEntry {
                    peer_id: full_peer_id.clone(),
                    direction: PeerDirection::Inbound,
                    state: ConnectionState::Connecting,
                    last_seen: Instant::now(),
                    peer: Some(peer),
                    pool,
                    bytes_sent: 0,
                    bytes_received: 0,
                },
            );
        }

        // Send answer
        // Note: peer_id is just the UUID, not full pubkey:uuid
        // The recipient will construct full peer_id from sender pubkey + this UUID
        let answer_msg = SignalingMessage::Answer {
            answer,
            recipient: full_peer_id.to_string(),
            peer_id: self.my_peer_id.uuid.clone(),
        };
        self.dispatch_signaling_message(answer_msg, relay_write_tx)
            .await;
        info!("Sent answer to {}", full_peer_id.short());

        Ok(())
    }

    /// Handle incoming answer
    async fn handle_answer(
        &self,
        sender_pubkey: &str,
        their_uuid: &str,
        answer: serde_json::Value,
    ) -> Result<()> {
        let full_peer_id = PeerId::new(sender_pubkey.to_string(), Some(their_uuid.to_string()));
        let peer_key = full_peer_id.to_string();

        info!("Received answer from {}", full_peer_id.short());

        let mut peers = self.state.peers.write().await;
        if let Some(entry) = peers.get_mut(&peer_key) {
            // Skip if already connected - duplicate answers from multiple relays
            if entry.state == ConnectionState::Connected {
                debug!(
                    "Ignoring duplicate answer from {} - already connected",
                    full_peer_id.short()
                );
                return Ok(());
            }
            if let Some(ref mut peer) = entry.peer {
                // Check WebRTC signaling state before applying answer
                use webrtc::peer_connection::signaling_state::RTCSignalingState;
                let signaling_state = peer.signaling_state();
                if signaling_state != RTCSignalingState::HaveLocalOffer {
                    debug!(
                        "Ignoring answer from {} - signaling state is {:?}, not HaveLocalOffer",
                        full_peer_id.short(),
                        signaling_state
                    );
                    return Ok(());
                }
                peer.handle_answer(answer).await?;
                info!("Applied answer from {}", full_peer_id.short());
            } else {
                debug!("Peer {} has no connection object", full_peer_id.short());
            }
        } else {
            debug!("No peer found for key: {}", peer_key);
        }

        Ok(())
    }

    /// Handle incoming ICE candidate
    async fn handle_candidate(
        &self,
        sender_pubkey: &str,
        their_uuid: &str,
        candidate: serde_json::Value,
    ) -> Result<()> {
        let full_peer_id = PeerId::new(sender_pubkey.to_string(), Some(their_uuid.to_string()));
        let peer_key = full_peer_id.to_string();

        info!("Received ICE candidate from {}", full_peer_id.short());

        let mut peers = self.state.peers.write().await;
        if let Some(entry) = peers.get_mut(&peer_key) {
            if let Some(ref mut peer) = entry.peer {
                peer.handle_candidate(candidate).await?;
            }
        }

        Ok(())
    }

    /// Handle batched ICE candidates
    async fn handle_candidates(
        &self,
        sender_pubkey: &str,
        their_uuid: &str,
        candidates: Vec<serde_json::Value>,
    ) -> Result<()> {
        let full_peer_id = PeerId::new(sender_pubkey.to_string(), Some(their_uuid.to_string()));
        let peer_key = full_peer_id.to_string();

        debug!(
            "Received {} candidates from {}",
            candidates.len(),
            full_peer_id.short()
        );

        let mut peers = self.state.peers.write().await;
        if let Some(entry) = peers.get_mut(&peer_key) {
            if let Some(ref mut peer) = entry.peer {
                for candidate in candidates {
                    if let Err(e) = peer.handle_candidate(candidate).await {
                        debug!("Failed to add candidate: {}", e);
                    }
                }
            }
        }

        Ok(())
    }

    /// Handle peer state change events from peer connections
    async fn handle_peer_state_event(
        &self,
        event: PeerStateEvent,
        relay_write_tx: &tokio::sync::broadcast::Sender<SignalingMessage>,
    ) {
        match event {
            PeerStateEvent::Connected(peer_id) => {
                let peer_key = peer_id.to_string();
                let mut emit_hello = false;
                let mut peers = self.state.peers.write().await;
                if let Some(entry) = peers.get_mut(&peer_key) {
                    if entry.state != ConnectionState::Connected {
                        info!("Peer {} connected (via state event)", peer_id.short());
                        entry.state = ConnectionState::Connected;
                        emit_hello = true;
                        // Update connected count
                        self.state
                            .connected_count
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                }
                drop(peers);
                if emit_hello {
                    self.dispatch_signaling_message(
                        SignalingMessage::hello(&self.my_peer_id.uuid),
                        relay_write_tx,
                    )
                    .await;
                }
            }
            PeerStateEvent::Failed(peer_id) => {
                let peer_key = peer_id.to_string();
                info!(
                    "Peer {} connection failed - removing from pool",
                    peer_id.short()
                );
                let mut peers = self.state.peers.write().await;
                if let Some(entry) = peers.remove(&peer_key) {
                    // Decrement connected count if was connected
                    if entry.state == ConnectionState::Connected {
                        self.state
                            .connected_count
                            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    // Close the peer connection if it exists
                    if let Some(peer) = entry.peer {
                        let _ = peer.close().await;
                    }
                }
            }
            PeerStateEvent::Disconnected(peer_id) => {
                let peer_key = peer_id.to_string();
                info!("Peer {} disconnected - removing from pool", peer_id.short());
                let mut peers = self.state.peers.write().await;
                if let Some(entry) = peers.remove(&peer_key) {
                    // Decrement connected count if was connected
                    if entry.state == ConnectionState::Connected {
                        self.state
                            .connected_count
                            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    // Close the peer connection if it exists
                    if let Some(peer) = entry.peer {
                        let _ = peer.close().await;
                    }
                }
            }
        }
    }

    /// Cleanup stale peers and sync connection states (fallback, runs every 30s)
    async fn cleanup_stale_peers(&self) {
        let mut peers = self.state.peers.write().await;
        let mut connected_count = 0;
        let mut to_remove = Vec::new();
        let stale_timeout = Duration::from_secs(60); // Remove peers stuck in Discovered/Connecting for 60s

        for (key, entry) in peers.iter_mut() {
            if let Some(ref peer) = entry.peer {
                // Sync connected state as fallback (in case event was missed)
                if peer.is_connected() {
                    if entry.state != ConnectionState::Connected {
                        info!(
                            "Peer {} is now connected (sync fallback)",
                            entry.peer_id.short()
                        );
                        entry.state = ConnectionState::Connected;
                    }
                    connected_count += 1;
                } else if entry.state == ConnectionState::Connecting
                    && entry.last_seen.elapsed() > stale_timeout
                {
                    // Peer stuck in Connecting for too long - mark for removal
                    info!(
                        "Removing stale peer {} (stuck in Connecting for {:?})",
                        entry.peer_id.short(),
                        entry.last_seen.elapsed()
                    );
                    to_remove.push(key.clone());
                }
            } else if entry.state == ConnectionState::Discovered
                && entry.last_seen.elapsed() > stale_timeout
            {
                // Discovered peer with no actual connection - remove
                debug!("Removing stale discovered peer {}", entry.peer_id.short());
                to_remove.push(key.clone());
            }
        }

        // Remove stale peers
        for key in to_remove {
            if let Some(entry) = peers.remove(&key) {
                if let Some(peer) = entry.peer {
                    let _ = peer.close().await;
                }
            }
        }

        self.state
            .connected_count
            .store(connected_count, std::sync::atomic::Ordering::Relaxed);
    }
}

// Keep the old PeerState for backward compatibility with tests
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct PeerState {
    pub peer_id: PeerId,
    pub direction: PeerDirection,
    pub state: String,
    pub last_seen: Instant,
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Tag};

    #[test]
    fn root_event_from_peer_extracts_tags() {
        let keys = Keys::generate();
        let hash = "ab".repeat(32);
        let event = EventBuilder::new(
            Kind::Custom(HASHTREE_KIND),
            "",
            [
                Tag::parse(&["d", "repo"]).unwrap(),
                Tag::parse(&["l", HASHTREE_LABEL]).unwrap(),
                Tag::parse(&["hash", &hash]).unwrap(),
                Tag::parse(&["encryptedKey", &"11".repeat(32)]).unwrap(),
            ],
        )
        .to_event(&keys)
        .unwrap();

        let parsed = root_event_from_peer(&event, "peer-a", "repo").unwrap();
        let expected_encrypted = "11".repeat(32);
        assert_eq!(parsed.hash, hash);
        assert_eq!(parsed.peer_id, "peer-a");
        assert_eq!(
            parsed.encrypted_key.as_deref(),
            Some(expected_encrypted.as_str())
        );
        assert!(parsed.key.is_none());
    }

    #[test]
    fn pick_latest_event_prefers_higher_event_id_on_timestamp_tie() {
        let keys = Keys::generate();
        let created_at = nostr::Timestamp::from_secs(1_700_000_000);
        let event_a = EventBuilder::new(Kind::Custom(HASHTREE_KIND), "", [])
            .custom_created_at(created_at)
            .to_event(&keys)
            .unwrap();
        let event_b = EventBuilder::new(Kind::Custom(HASHTREE_KIND), "", [])
            .custom_created_at(created_at)
            .to_event(&keys)
            .unwrap();

        let expected = if event_a.id > event_b.id {
            event_a.id
        } else {
            event_b.id
        };
        let picked = pick_latest_event([&event_a, &event_b]).unwrap();
        assert_eq!(picked.id, expected);
    }

    #[test]
    fn test_formal_timed_seen_set_rejects_duplicates() {
        let mut seen = TimedSeenSet::new(4, Duration::from_secs(60));
        assert!(seen.insert_if_new("frame-1".to_string()));
        assert!(!seen.insert_if_new("frame-1".to_string()));
        assert!(seen.insert_if_new("frame-2".to_string()));
    }

    #[test]
    fn test_formal_timed_seen_set_evicts_oldest_when_capacity_exceeded() {
        let mut seen = TimedSeenSet::new(2, Duration::from_secs(60));
        assert!(seen.insert_if_new("a".to_string()));
        assert!(seen.insert_if_new("b".to_string()));
        assert!(seen.insert_if_new("c".to_string()));

        // "a" should be evicted due to cap=2, so re-insert becomes new again.
        assert!(seen.insert_if_new("a".to_string()));
        assert!(!seen.insert_if_new("a".to_string()));
    }

    #[test]
    fn test_request_dispatch_normalization_caps_to_available_peers() {
        let normalized = normalize_dispatch_config(
            RequestDispatchConfig {
                initial_fanout: 8,
                hedge_fanout: 6,
                max_fanout: 5,
                hedge_interval_ms: 120,
            },
            3,
        );
        assert_eq!(normalized.max_fanout, 3);
        assert_eq!(normalized.initial_fanout, 3);
        assert_eq!(normalized.hedge_fanout, 3);
    }

    #[test]
    fn test_hedged_wave_plan_matches_dispatch_policy() {
        let plan = build_hedged_wave_plan(
            7,
            RequestDispatchConfig {
                initial_fanout: 2,
                hedge_fanout: 3,
                max_fanout: 6,
                hedge_interval_ms: 120,
            },
        );
        assert_eq!(plan, vec![2, 3, 1]);
    }
}
