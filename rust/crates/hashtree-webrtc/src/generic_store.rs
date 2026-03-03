//! Generic P2P store using abstract transports
//!
//! This module provides a Store implementation that works with any
//! RelayTransport and PeerConnectionFactory. Both production (real WebRTC)
//! and simulation (mocks) use this same code.

use async_trait::async_trait;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash as _, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, RwLock};

use hashtree_core::{Hash, Store, StoreError};

use crate::peer_selector::{PeerSelector, SelectionStrategy};
use crate::protocol::{
    create_request, create_response, encode_request, encode_response, hash_to_key, parse_message,
    DataMessage,
};
use crate::signaling::SignalingManager;
use crate::transport::{PeerConnectionFactory, RelayTransport, TransportError};
use crate::types::{PeerHTLConfig, SignalingMessage, MAX_HTL};

/// Pending request awaiting response
struct PendingRequest {
    response_tx: oneshot::Sender<Option<Vec<u8>>>,
    started_at: Instant,
    queried_peers: Vec<String>,
}

/// Request dispatch strategy for peer queries.
///
/// `GenericStore` supports two practical modes:
/// - Flood (`usize::MAX` fanout): maximize success/latency at bandwidth cost.
/// - Staged hedging: probe a subset first, then expand.
#[derive(Debug, Clone, Copy)]
pub struct RequestDispatchConfig {
    /// Number of peers queried immediately.
    pub initial_fanout: usize,
    /// Number of additional peers to query on each hedge step.
    pub hedge_fanout: usize,
    /// Total peers allowed for this request.
    pub max_fanout: usize,
    /// Delay between hedge waves (ms). `0` means send all waves immediately.
    pub hedge_interval_ms: u64,
}

impl Default for RequestDispatchConfig {
    fn default() -> Self {
        Self {
            initial_fanout: usize::MAX,
            hedge_fanout: usize::MAX,
            max_fanout: usize::MAX,
            hedge_interval_ms: 0,
        }
    }
}

/// Normalize fanout config against current peer availability.
pub fn normalize_dispatch_config(
    dispatch: RequestDispatchConfig,
    available_peers: usize,
) -> RequestDispatchConfig {
    let mut cfg = dispatch;
    let cap = if cfg.max_fanout == 0 {
        available_peers
    } else {
        cfg.max_fanout.min(available_peers)
    };
    cfg.max_fanout = cap;
    cfg.initial_fanout = if cfg.initial_fanout == 0 {
        1
    } else {
        cfg.initial_fanout.min(cap.max(1))
    };
    cfg.hedge_fanout = if cfg.hedge_fanout == 0 {
        1
    } else {
        cfg.hedge_fanout.min(cap.max(1))
    };
    cfg
}

/// Build wave sizes for staged hedged dispatch.
pub fn build_hedged_wave_plan(peer_count: usize, dispatch: RequestDispatchConfig) -> Vec<usize> {
    if peer_count == 0 {
        return Vec::new();
    }
    let cap = dispatch.max_fanout.min(peer_count);
    if cap == 0 {
        return Vec::new();
    }

    let mut plan = Vec::new();
    let mut sent = 0usize;
    let first = dispatch.initial_fanout.min(cap).max(1);
    plan.push(first);
    sent += first;

    while sent < cap {
        let next = dispatch.hedge_fanout.min(cap - sent).max(1);
        plan.push(next);
        sent += next;
    }
    plan
}

/// Keep selector membership aligned with currently connected peer IDs.
pub async fn sync_selector_peers(selector: &RwLock<PeerSelector>, current_peer_ids: &[String]) {
    let mut selector = selector.write().await;
    let current: HashSet<&str> = current_peer_ids.iter().map(String::as_str).collect();
    let known: Vec<String> = selector.all_stats().map(|s| s.peer_id.clone()).collect();
    for peer_id in known {
        if !current.contains(peer_id.as_str()) {
            selector.remove_peer(&peer_id);
        }
    }
    for peer_id in current_peer_ids {
        selector.add_peer(peer_id.clone());
    }
}

/// Response behavior profile for simulation/game-theory actors.
///
/// Defaults to honest behavior (always respond correctly, no extra delay).
#[derive(Debug, Clone, Copy)]
pub struct ResponseBehaviorConfig {
    /// Probability that a node drops a response even when it has data.
    pub drop_response_prob: f64,
    /// Probability that a node responds with corrupted payload.
    pub corrupt_response_prob: f64,
    /// Optional response delay to model slow/incompetent peers.
    pub extra_delay_ms: u64,
}

impl Default for ResponseBehaviorConfig {
    fn default() -> Self {
        Self {
            drop_response_prob: 0.0,
            corrupt_response_prob: 0.0,
            extra_delay_ms: 0,
        }
    }
}

impl ResponseBehaviorConfig {
    fn normalized(self) -> Self {
        Self {
            drop_response_prob: self.drop_response_prob.clamp(0.0, 1.0),
            corrupt_response_prob: self.corrupt_response_prob.clamp(0.0, 1.0),
            extra_delay_ms: self.extra_delay_ms,
        }
    }
}

/// Routing policy for request ordering + dispatch fanout.
#[derive(Debug, Clone, Copy)]
pub struct GenericStoreRoutingConfig {
    pub selection_strategy: SelectionStrategy,
    pub fairness_enabled: bool,
    pub dispatch: RequestDispatchConfig,
    pub response_behavior: ResponseBehaviorConfig,
}

impl Default for GenericStoreRoutingConfig {
    fn default() -> Self {
        Self {
            selection_strategy: SelectionStrategy::Weighted,
            fairness_enabled: true,
            dispatch: RequestDispatchConfig::default(),
            response_behavior: ResponseBehaviorConfig::default(),
        }
    }
}

/// Generic P2P store that works with any transport implementation
///
/// This is the shared code between production and simulation.
/// - Production: GenericStore<NostrRelayTransport, RealPeerConnectionFactory>
/// - Simulation: GenericStore<MockRelayTransport, MockConnectionFactory>
pub struct GenericStore<S, R, F>
where
    S: Store + Send + Sync + 'static,
    R: RelayTransport + Send + Sync + 'static,
    F: PeerConnectionFactory + Send + Sync + 'static,
{
    /// Local backing store
    local_store: Arc<S>,
    /// Signaling manager (handles peer discovery and connection)
    signaling: Arc<SignalingManager<R, F>>,
    /// Per-peer HTL config
    htl_configs: RwLock<HashMap<String, PeerHTLConfig>>,
    /// Pending requests we sent
    pending_requests: RwLock<HashMap<String, PendingRequest>>,
    /// Adaptive selector for peer ordering.
    peer_selector: RwLock<PeerSelector>,
    /// Routing/dispatch configuration.
    routing: GenericStoreRoutingConfig,
    /// Request timeout
    request_timeout: Duration,
    /// Debug mode
    debug: bool,
    /// Running flag
    running: RwLock<bool>,
}

impl<S, R, F> GenericStore<S, R, F>
where
    S: Store + Send + Sync + 'static,
    R: RelayTransport + Send + Sync + 'static,
    F: PeerConnectionFactory + Send + Sync + 'static,
{
    /// Create a new generic store
    pub fn new(
        local_store: Arc<S>,
        signaling: Arc<SignalingManager<R, F>>,
        request_timeout: Duration,
        debug: bool,
    ) -> Self {
        Self::new_with_routing(
            local_store,
            signaling,
            request_timeout,
            debug,
            Default::default(),
        )
    }

    /// Create a new generic store with explicit routing configuration.
    pub fn new_with_routing(
        local_store: Arc<S>,
        signaling: Arc<SignalingManager<R, F>>,
        request_timeout: Duration,
        debug: bool,
        routing: GenericStoreRoutingConfig,
    ) -> Self {
        let mut selector = PeerSelector::with_strategy(routing.selection_strategy);
        selector.set_fairness(routing.fairness_enabled);
        Self {
            local_store,
            signaling,
            htl_configs: RwLock::new(HashMap::new()),
            pending_requests: RwLock::new(HashMap::new()),
            peer_selector: RwLock::new(selector),
            routing,
            request_timeout,
            debug,
            running: RwLock::new(false),
        }
    }

    /// Start the store (begin listening for messages)
    pub async fn start(&self) -> Result<(), TransportError> {
        *self.running.write().await = true;

        // Send initial hello
        self.signaling.send_hello(vec![]).await?;

        Ok(())
    }

    /// Stop the store
    pub async fn stop(&self) {
        *self.running.write().await = false;
    }

    /// Process incoming signaling message
    pub async fn process_signaling(&self, msg: SignalingMessage) -> Result<(), TransportError> {
        // When a new peer connects, initialize their HTL config
        let peer_id = msg.peer_id().to_string();
        {
            let mut configs = self.htl_configs.write().await;
            if !configs.contains_key(&peer_id) {
                configs.insert(peer_id.clone(), PeerHTLConfig::random());
            }
        }
        self.peer_selector.write().await.add_peer(peer_id);

        self.signaling.handle_message(msg).await
    }

    /// Get signaling manager reference
    pub fn signaling(&self) -> &Arc<SignalingManager<R, F>> {
        &self.signaling
    }

    fn response_behavior(&self) -> ResponseBehaviorConfig {
        self.routing.response_behavior.normalized()
    }

    fn deterministic_actor_draw_for(peer_id: &str, hash: &Hash, salt: u64) -> f64 {
        let mut hasher = DefaultHasher::new();
        peer_id.hash(&mut hasher);
        hash.hash(&mut hasher);
        salt.hash(&mut hasher);
        let v = hasher.finish();
        (v as f64) / (u64::MAX as f64)
    }

    fn deterministic_actor_draw(&self, hash: &Hash, salt: u64) -> f64 {
        Self::deterministic_actor_draw_for(self.signaling.peer_id(), hash, salt)
    }

    fn should_drop_response(&self, hash: &Hash) -> bool {
        let p = self.response_behavior().drop_response_prob;
        if p <= 0.0 {
            return false;
        }
        self.deterministic_actor_draw(hash, 0xD0_D0_D0_D0_D0_D0_D0_D0) < p
    }

    fn should_corrupt_response(&self, hash: &Hash) -> bool {
        let p = self.response_behavior().corrupt_response_prob;
        if p <= 0.0 {
            return false;
        }
        self.deterministic_actor_draw(hash, 0xC0_C0_C0_C0_C0_C0_C0_C0) < p
    }

    async fn send_request_to_peer(&self, peer_id: &str, hash: &Hash) -> bool {
        let channel = match self.signaling.get_channel(peer_id).await {
            Some(c) => c,
            None => return false,
        };

        let htl_config = {
            let configs = self.htl_configs.read().await;
            configs
                .get(peer_id)
                .cloned()
                .unwrap_or_else(PeerHTLConfig::random)
        };

        let send_htl = htl_config.decrement(MAX_HTL);
        let req = create_request(hash, send_htl);
        let request_bytes = encode_request(&req);

        {
            let mut selector = self.peer_selector.write().await;
            selector.record_request(peer_id, request_bytes.len() as u64);
        }

        match channel.send(request_bytes).await {
            Ok(()) => true,
            Err(_) => {
                self.peer_selector.write().await.record_failure(peer_id);
                false
            }
        }
    }

    /// Get peer count
    pub async fn peer_count(&self) -> usize {
        self.signaling.peer_count().await
    }

    /// Check if we need more peers
    pub async fn needs_peers(&self) -> bool {
        self.signaling.needs_peers().await
    }

    /// Re-broadcast hello to refresh discovery as topology changes.
    pub async fn send_hello(&self) -> Result<(), TransportError> {
        self.signaling.send_hello(vec![]).await
    }

    /// Request data from peers
    async fn request_from_peers(&self, hash: &Hash) -> Option<Vec<u8>> {
        let current_peer_ids = self.signaling.peer_ids().await;
        if current_peer_ids.is_empty() {
            return None;
        }
        sync_selector_peers(&self.peer_selector, &current_peer_ids).await;
        let current_set: std::collections::HashSet<&str> =
            current_peer_ids.iter().map(String::as_str).collect();
        let mut ordered_peer_ids = self.peer_selector.write().await.select_peers();
        ordered_peer_ids.retain(|peer_id| current_set.contains(peer_id.as_str()));
        if ordered_peer_ids.is_empty() {
            ordered_peer_ids = current_peer_ids;
            ordered_peer_ids.sort();
        }

        let dispatch = normalize_dispatch_config(self.routing.dispatch, ordered_peer_ids.len());
        let wave_plan = build_hedged_wave_plan(ordered_peer_ids.len(), dispatch);
        if wave_plan.is_empty() {
            return None;
        }

        let hash_key = hash_to_key(hash);
        let (tx, rx) = oneshot::channel();
        self.pending_requests.write().await.insert(
            hash_key.clone(),
            PendingRequest {
                response_tx: tx,
                started_at: Instant::now(),
                queried_peers: Vec::new(),
            },
        );

        let mut sent_total = 0usize;
        let mut next_peer_idx = 0usize;
        let mut rx = rx;
        let deadline = Instant::now() + self.request_timeout;

        for (wave_idx, wave_size) in wave_plan.iter().copied().enumerate() {
            let from = next_peer_idx;
            let to = (next_peer_idx + wave_size).min(ordered_peer_ids.len());
            for peer_id in &ordered_peer_ids[from..to] {
                if self.send_request_to_peer(peer_id, hash).await {
                    sent_total += 1;
                    if let Some(pending) = self.pending_requests.write().await.get_mut(&hash_key) {
                        pending.queried_peers.push(peer_id.clone());
                    }
                }
            }
            next_peer_idx = to;

            if sent_total == 0 {
                if next_peer_idx >= ordered_peer_ids.len() {
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
                wave_idx + 1 == wave_plan.len() || next_peer_idx >= ordered_peer_ids.len();
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
                Ok(Ok(Some(data))) => {
                    if hashtree_core::sha256(&data) == *hash {
                        let _ = self.local_store.put(*hash, data.clone()).await;
                        return Some(data);
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(_)) => break,
                Err(_) => {
                    // Timed wait window expired; send next hedge wave if any.
                }
            }
        }

        if sent_total == 0 {
            let _ = self.pending_requests.write().await.remove(&hash_key);
            return None;
        }

        if let Some(pending) = self.pending_requests.write().await.remove(&hash_key) {
            for peer_id in pending.queried_peers {
                self.peer_selector.write().await.record_timeout(&peer_id);
            }
        }
        None
    }

    async fn complete_pending_response(&self, from_peer: &str, hash_key: String, payload: Vec<u8>) {
        if let Some(pending) = self.pending_requests.write().await.remove(&hash_key) {
            let rtt_ms = pending.started_at.elapsed().as_millis() as u64;
            self.peer_selector.write().await.record_success(
                from_peer,
                rtt_ms,
                payload.len() as u64,
            );
            let _ = pending.response_tx.send(Some(payload));
        }
    }

    async fn handle_response_message(&self, from_peer: &str, res: crate::protocol::DataResponse) {
        let hash_key = hash_to_key(&res.h);
        let hash = match crate::protocol::bytes_to_hash(&res.h) {
            Some(h) => h,
            None => return,
        };

        // Ignore malformed/corrupt payload and keep waiting for a valid response.
        if hashtree_core::sha256(&res.d) != hash {
            self.peer_selector.write().await.record_failure(from_peer);
            if self.debug {
                println!("[GenericStore] Ignoring invalid response payload for {hash_key}");
            }
            return;
        }

        self.complete_pending_response(from_peer, hash_key, res.d)
            .await;
    }

    async fn handle_request_message(&self, from_peer: &str, req: crate::protocol::DataRequest) {
        let hash = match crate::protocol::bytes_to_hash(&req.h) {
            Some(h) => h,
            None => return,
        };

        // Check local store
        if let Ok(Some(mut data)) = self.local_store.get(&hash).await {
            if self.should_drop_response(&hash) {
                if self.debug {
                    println!(
                        "[GenericStore] Dropping response for {} due to actor profile",
                        hash_to_key(&hash)
                    );
                }
                return;
            }

            let behavior = self.response_behavior();
            if behavior.extra_delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(behavior.extra_delay_ms)).await;
            }

            if self.should_corrupt_response(&hash) {
                if data.is_empty() {
                    data.push(0x80);
                } else {
                    data[0] ^= 0x80;
                }
            }

            // Send response
            let res = create_response(&hash, data);
            let response_bytes = encode_response(&res);
            if let Some(channel) = self.signaling.get_channel(from_peer).await {
                let _ = channel.send(response_bytes).await;
            }
        }
        // For now, don't forward - keep it simple
    }

    /// Handle incoming data message
    pub async fn handle_data_message(&self, from_peer: &str, data: &[u8]) {
        let parsed = match parse_message(data) {
            Some(m) => m,
            None => return,
        };

        match parsed {
            DataMessage::Request(req) => {
                self.handle_request_message(from_peer, req).await;
            }
            DataMessage::Response(res) => {
                self.handle_response_message(from_peer, res).await;
            }
        }
    }
}

#[async_trait]
impl<S, R, F> Store for GenericStore<S, R, F>
where
    S: Store + Send + Sync + 'static,
    R: RelayTransport + Send + Sync + 'static,
    F: PeerConnectionFactory + Send + Sync + 'static,
{
    async fn put(&self, hash: Hash, data: Vec<u8>) -> Result<bool, StoreError> {
        self.local_store.put(hash, data).await
    }

    async fn get(&self, hash: &Hash) -> Result<Option<Vec<u8>>, StoreError> {
        // Try local first
        if let Some(data) = self.local_store.get(hash).await? {
            return Ok(Some(data));
        }

        // Try peers
        Ok(self.request_from_peers(hash).await)
    }

    async fn has(&self, hash: &Hash) -> Result<bool, StoreError> {
        self.local_store.has(hash).await
    }

    async fn delete(&self, hash: &Hash) -> Result<bool, StoreError> {
        self.local_store.delete(hash).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hashtree_core::MemoryStore;

    type TestStore = GenericStore<
        MemoryStore,
        crate::mock::MockRelayTransport,
        crate::mock::MockConnectionFactory,
    >;

    #[test]
    fn test_hedged_wave_plan_flood_all() {
        let plan = build_hedged_wave_plan(7, RequestDispatchConfig::default());
        assert_eq!(plan, vec![7]);
    }

    #[test]
    fn test_hedged_wave_plan_staged() {
        let plan = build_hedged_wave_plan(
            10,
            RequestDispatchConfig {
                initial_fanout: 2,
                hedge_fanout: 3,
                max_fanout: 8,
                hedge_interval_ms: 25,
            },
        );
        assert_eq!(plan, vec![2, 3, 3]);
    }

    #[test]
    fn test_response_behavior_normalization_clamps_probs() {
        let raw = ResponseBehaviorConfig {
            drop_response_prob: -1.5,
            corrupt_response_prob: 9.0,
            extra_delay_ms: 12,
        };
        let normalized = raw.normalized();
        assert_eq!(normalized.drop_response_prob, 0.0);
        assert_eq!(normalized.corrupt_response_prob, 1.0);
        assert_eq!(normalized.extra_delay_ms, 12);
    }

    #[test]
    fn test_actor_draw_is_deterministic_per_peer_hash_and_salt() {
        let hash = hashtree_core::sha256(b"deterministic");
        let a = TestStore::deterministic_actor_draw_for("peer-a", &hash, 7);
        let b = TestStore::deterministic_actor_draw_for("peer-a", &hash, 7);
        assert!((a - b).abs() < f64::EPSILON);
    }
}

/// Type alias for simulation store
pub type SimStore<S> =
    GenericStore<S, crate::mock::MockRelayTransport, crate::mock::MockConnectionFactory>;

/// Type alias for production store (using real WebRTC)
pub type ProductionStore<S> = GenericStore<
    S,
    crate::nostr::NostrRelayTransport,
    crate::real_factory::RealPeerConnectionFactory,
>;
