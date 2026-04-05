use super::*;

impl WebRTCManager {
    /// Start the native peer router - connects transports and handles signaling.
    pub async fn run(&mut self) -> Result<()> {
        info!(
            "Starting peer router with peer ID: {}",
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

        if self.config.bluetooth.is_enabled() {
            let bluetooth = BluetoothMesh::new(self.config.bluetooth.clone());
            let context = BluetoothRuntimeContext {
                my_peer_id: self.my_peer_id.clone(),
                store: if bluetooth_nostr_only_mode() {
                    None
                } else {
                    self.store.clone()
                },
                nostr_relay: self.nostr_relay.clone(),
                mesh_frame_tx: self.mesh_frame_tx.clone(),
                registrar: BluetoothPeerRegistrar::new(
                    self.state.clone(),
                    self.peer_classifier.clone(),
                    self.config.pools.clone(),
                    self.config.bluetooth.max_peers,
                ),
            };
            let _ = bluetooth.start(context).await;
        }

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

        if self.config.multicast.is_enabled() {
            if let Some(relay) = self.nostr_relay.clone() {
                match MulticastNostrBus::bind(
                    self.config.multicast.clone(),
                    self.keys.clone(),
                    relay,
                )
                .await
                {
                    Ok(bus) => {
                        let local_bus: SharedLocalNostrBus = bus.clone();
                        self.state.add_local_bus(local_bus.clone()).await;
                        self.local_buses.push(local_bus);
                        let shutdown_rx = self.shutdown_rx.clone();
                        let signaling_tx = event_tx.clone();
                        tokio::spawn(async move {
                            if let Err(err) = bus.run(shutdown_rx, signaling_tx).await {
                                error!("Multicast bus error: {}", err);
                            }
                        });
                    }
                    Err(err) => {
                        warn!("Failed to start multicast bus: {}", err);
                    }
                }
            } else {
                warn!("Multicast enabled but Nostr relay is unavailable");
            }
        }

        if self.config.wifi_aware.is_enabled() {
            if let Some(relay) = self.nostr_relay.clone() {
                if let Some(bridge) = mobile_wifi_aware_bridge() {
                    let bus = WifiAwareNostrBus::new(
                        self.config.wifi_aware.clone(),
                        self.keys.clone(),
                        relay,
                        bridge,
                    );
                    let local_bus: SharedLocalNostrBus = bus.clone();
                    self.state.add_local_bus(local_bus.clone()).await;
                    self.local_buses.push(local_bus);
                    let shutdown_rx = self.shutdown_rx.clone();
                    let signaling_tx = event_tx.clone();
                    let local_peer_id = self.my_peer_id.to_string();
                    tokio::spawn(async move {
                        if let Err(err) = bus.run(local_peer_id, shutdown_rx, signaling_tx).await {
                            error!("Wi-Fi Aware bus error: {}", err);
                        }
                    });
                } else {
                    warn!("Wi-Fi Aware enabled but no mobile bridge is installed");
                }
            } else {
                warn!("Wi-Fi Aware enabled but Nostr relay is unavailable");
            }
        }

        if self.config.signaling_enabled {
            let transport = Arc::new(RouterSignalingBridge::new(
                self.my_peer_id.to_string(),
                self.signaling_tx.clone(),
            ));
            let factory = Arc::new(SharedRouterPeerFactory::new(
                self.my_peer_id.clone(),
                self.signaling_tx.clone(),
                self.config.stun_servers.clone(),
                self.store.clone(),
                self.state.clone(),
                self.state_event_tx.clone(),
                self.nostr_relay.clone(),
                self.mesh_frame_tx.clone(),
                self.peer_classifier.clone(),
            ));
            let (classifier_tx, mut classifier_rx) = mpsc::channel::<SharedClassifyRequest>(32);
            let classifier = self.peer_classifier.clone();
            tokio::spawn(async move {
                while let Some(request) = classifier_rx.recv().await {
                    let _ = request.response.send(classifier(&request.pubkey));
                }
            });

            let mut router = MeshRouter::new(
                self.my_peer_id.to_string(),
                transport,
                factory.clone(),
                self.config.pools.clone(),
                self.config.debug,
            );
            router.set_classifier(classifier_tx);
            self.shared_router = Some(Arc::new(router));
        }

        // Process incoming events and outgoing signaling messages
        let mut shutdown_rx = self.shutdown_rx.clone();
        // Cleanup interval - run every 30 seconds as a fallback (not for real-time sync)
        let mut cleanup_interval = tokio::time::interval(Duration::from_secs(30));
        let mut hello_ticker =
            tokio::time::interval(Duration::from_millis(self.config.hello_interval_ms));
        if self.config.signaling_enabled {
            if let Some(shared_router) = self.shared_router.as_ref() {
                let _ = shared_router.send_hello(Vec::new()).await;
            } else {
                self.dispatch_signaling_message(self.local_hello_message(), &relay_write_tx)
                    .await;
            }
        }
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        info!("WebRTC manager shutting down");
                        break;
                    }
                }
                Some((relay, event)) = event_rx.recv() => {
                    if let Err(e) = self
                        .handle_event(&relay, &event, self.shared_router.as_ref())
                        .await
                    {
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
                    self.handle_mesh_frame(from_peer_id, frame).await;
                }
                _ = hello_ticker.tick(), if self.config.signaling_enabled => {
                    if let Some(shared_router) = self.shared_router.as_ref() {
                        let _ = shared_router.send_hello(Vec::new()).await;
                    } else {
                        self.dispatch_signaling_message(self.local_hello_message(), &relay_write_tx)
                            .await;
                    }
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
        write.send(Message::Text(sub_msg.as_json())).await?;

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
                        if write.send(Message::Text(msg.as_json())).await.is_ok() {
                            info!("Sent {} to {} (event id: {})", signaling_msg.msg_type(), url, &event_id[..16]);
                        }
                    }
                }
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(RelayMessage::Event { event, .. }) =
                                RelayMessage::from_json(&text)
                            {
                                let _ = event_tx.send((url.clone(), *event)).await;
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
        if !self.config.signaling_enabled {
            debug!(
                "Skipping signaling message {} because WebRTC signaling is disabled",
                msg.msg_type()
            );
            return;
        }

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

        for bus in &self.local_buses {
            if let Err(err) = bus.broadcast_event(&event).await {
                debug!(
                    "Failed to broadcast signaling event over {} ({}): {}",
                    bus.source_name(),
                    msg.msg_type(),
                    err
                );
            }
        }

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
                    .map(|peer| peer.is_ready())
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
                        peer.clone(),
                        peer.htl_config(),
                    )
                })
            })
            .collect();
        drop(peers);

        let mut forwarded = 0usize;
        for (_peer_key, peer_short, peer, htl_cfg) in peer_refs {
            let next_htl = decrement_htl_with_policy(frame.htl, &MESH_EVENT_POLICY, &htl_cfg);
            if !should_forward_htl(next_htl) {
                continue;
            }

            let mut outbound = frame.clone();
            outbound.htl = next_htl;
            if peer.send_mesh_frame_text(&outbound).await.is_ok() {
                forwarded += 1;
            } else {
                debug!("Failed to forward mesh frame to {}", peer_short);
            }
        }

        forwarded
    }

    async fn handle_mesh_frame(&self, from_peer_id: PeerId, frame: MeshNostrFrame) {
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

        if let Err(e) = self
            .handle_event("mesh", &event, self.shared_router.as_ref())
            .await
        {
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
        encode_signaling_event(
            keys,
            msg.peer_id(),
            msg,
            Kind::Ephemeral(WEBRTC_KIND as u16),
        )
        .map_err(|e| anyhow::anyhow!(e.to_string()))
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
        shared_router: Option<&Arc<SharedProductionRouter>>,
    ) -> Result<()> {
        if !self.config.signaling_enabled {
            return Ok(());
        }

        let Some(shared_router) = shared_router else {
            return Ok(());
        };

        let Some(msg) = decode_signaling_event(
            event,
            &self.my_peer_id.to_string(),
            &self.keys.public_key().to_hex(),
            &self.keys,
        ) else {
            return Ok(());
        };

        if matches!(
            msg,
            SignalingMessage::Hello { .. } | SignalingMessage::Offer { .. }
        ) {
            let peers = self.state.peers.read().await;
            if !self.can_track_local_bus_peer(relay, msg.peer_id(), &peers) {
                return Ok(());
            }
        }

        debug!(
            "Received {} from {} via {}",
            msg.msg_type(),
            msg.peer_id(),
            relay
        );
        let peer_id = msg.peer_id().to_string();
        shared_router
            .handle_message(msg)
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        remember_peer_signal_path(self.state.as_ref(), &peer_id, relay).await;

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
                    if let Some(shared_router) = self.shared_router.as_ref() {
                        let _ = shared_router.send_hello(Vec::new()).await;
                    } else {
                        self.dispatch_signaling_message(self.local_hello_message(), relay_write_tx)
                            .await;
                    }
                }
            }
            PeerStateEvent::Failed(peer_id) => {
                let peer_key = peer_id.to_string();
                info!(
                    "Peer {} connection failed - removing from pool",
                    peer_id.short()
                );
                let removed = {
                    let mut peers = self.state.peers.write().await;
                    peers.remove(&peer_key)
                };
                if let Some(entry) = removed {
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
                if let Some(shared_router) = self.shared_router.as_ref() {
                    if let Some(channel) = shared_router.remove_peer(&peer_key).await {
                        channel.close().await;
                    }
                }
            }
            PeerStateEvent::Disconnected(peer_id) => {
                let peer_key = peer_id.to_string();
                info!("Peer {} disconnected - removing from pool", peer_id.short());
                let removed = {
                    let mut peers = self.state.peers.write().await;
                    peers.remove(&peer_key)
                };
                if let Some(entry) = removed {
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
                if let Some(shared_router) = self.shared_router.as_ref() {
                    if let Some(channel) = shared_router.remove_peer(&peer_key).await {
                        channel.close().await;
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
                } else if entry.state == ConnectionState::Connected {
                    info!(
                        "Removing disconnected peer {} after transport closed",
                        entry.peer_id.short()
                    );
                    to_remove.push(key.clone());
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
        let mut removed_peers = Vec::new();
        for key in to_remove {
            if let Some(entry) = peers.remove(&key) {
                removed_peers.push(entry);
            }
        }
        drop(peers);

        for entry in removed_peers {
            if let Some(peer) = entry.peer {
                let _ = peer.close().await;
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
    use crate::webrtc::root_events::{self, PeerRootEvent};
    use crate::webrtc::session::TestMeshPeer;
    use crate::webrtc::SelectionStrategy;
    use crate::LocalNostrBus;
    use anyhow::Result as AnyResult;
    use async_trait::async_trait;
    use hashtree_network::{build_hedged_wave_plan, normalize_dispatch_config};
    use nostr::{EventBuilder, Keys, Tag};
    use std::time::Duration;

    struct TestLocalBus {
        source: &'static str,
        root: Option<PeerRootEvent>,
    }

    #[async_trait]
    impl LocalNostrBus for TestLocalBus {
        fn source_name(&self) -> &'static str {
            self.source
        }

        async fn broadcast_event(&self, _event: &nostr::Event) -> AnyResult<()> {
            Ok(())
        }

        async fn query_root(
            &self,
            _owner_pubkey: &str,
            _tree_name: &str,
            _timeout: Duration,
        ) -> Option<PeerRootEvent> {
            self.root.clone()
        }
    }

    #[test]
    fn root_event_from_peer_extracts_tags() {
        let keys = Keys::generate();
        let hash = "ab".repeat(32);
        let event = EventBuilder::new(
            Kind::Custom(root_events::HASHTREE_KIND),
            "",
            [
                Tag::parse(&["d", "repo"]).unwrap(),
                Tag::parse(&["l", root_events::HASHTREE_LABEL]).unwrap(),
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
        let event_a = EventBuilder::new(Kind::Custom(root_events::HASHTREE_KIND), "", [])
            .custom_created_at(created_at)
            .to_event(&keys)
            .unwrap();
        let event_b = EventBuilder::new(Kind::Custom(root_events::HASHTREE_KIND), "", [])
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

    #[tokio::test]
    async fn resolve_root_from_local_buses_returns_source_and_first_match() {
        let state = WebRTCState::new();
        let root = PeerRootEvent {
            hash: "ab".repeat(32),
            key: None,
            encrypted_key: None,
            self_encrypted_key: None,
            event_id: "event-1".to_string(),
            created_at: 1,
            peer_id: "bus-peer".to_string(),
        };

        state
            .set_local_buses(vec![
                Arc::new(TestLocalBus {
                    source: "empty",
                    root: None,
                }),
                Arc::new(TestLocalBus {
                    source: "mock-bus",
                    root: Some(root.clone()),
                }),
            ])
            .await;

        let resolved = state
            .resolve_root_from_local_buses_with_source("owner", "tree", Duration::from_millis(10))
            .await
            .expect("expected root from local bus");

        assert_eq!(resolved.0, "mock-bus");
        assert_eq!(resolved.1.hash, root.hash);
        assert_eq!(resolved.1.peer_id, root.peer_id);
    }

    #[tokio::test]
    async fn can_track_local_bus_peer_enforces_wifi_aware_limit() {
        let keys = Keys::generate();
        let mut config = WebRTCConfig::default();
        config.wifi_aware.enabled = true;
        config.wifi_aware.max_peers = 1;
        let manager = WebRTCManager::new(keys, config);
        let existing_peer = PeerId::new("peer-a".to_string());
        let existing_key = existing_peer.to_string();
        let mut peers = HashMap::new();
        peers.insert(
            existing_key.clone(),
            PeerEntry {
                peer_id: existing_peer,
                direction: PeerDirection::Outbound,
                state: ConnectionState::Discovered,
                last_seen: Instant::now(),
                peer: None,
                pool: PeerPool::Other,
                transport: PeerTransport::WebRtc,
                signal_paths: BTreeSet::from([PeerSignalPath::WifiAware]),
                bytes_sent: 0,
                bytes_received: 0,
            },
        );

        assert!(manager.can_track_local_bus_peer(WIFI_AWARE_SOURCE, &existing_key, &peers,));
        assert!(!manager.can_track_local_bus_peer(WIFI_AWARE_SOURCE, "peer-b:sess-b", &peers,));
        assert!(manager.can_track_local_bus_peer("relay", "peer-c:sess-c", &peers));
    }

    #[tokio::test]
    async fn request_from_peers_with_source_accepts_generic_mesh_peers() {
        let state = WebRTCState::new();
        let data = b"offline-over-ble".to_vec();
        let hash_hex = hex::encode(hashtree_core::sha256(&data));

        state.peers.write().await.insert(
            "peer-a".to_string(),
            PeerEntry {
                peer_id: PeerId::new("peer-a-pub".to_string()),
                direction: PeerDirection::Outbound,
                state: ConnectionState::Connected,
                last_seen: Instant::now(),
                peer: Some(MeshPeer::mock_for_tests(TestMeshPeer::with_response(Some(
                    data.clone(),
                )))),
                pool: PeerPool::Other,
                transport: PeerTransport::Bluetooth,
                signal_paths: BTreeSet::from([PeerSignalPath::Bluetooth]),
                bytes_sent: 0,
                bytes_received: 0,
            },
        );

        let resolved = state
            .request_from_peers_with_source(&hash_hex)
            .await
            .expect("expected mock mesh peer response");

        assert_eq!(resolved.0, data);
        assert_eq!(resolved.1, "peer-a-pub");
    }

    #[tokio::test]
    async fn request_from_peers_with_source_waits_full_timeout_for_last_generic_peer() {
        let state = WebRTCState::new_with_routing_and_cashu(
            SelectionStrategy::TitForTat,
            true,
            RequestDispatchConfig {
                initial_fanout: 1,
                hedge_fanout: 1,
                max_fanout: 1,
                hedge_interval_ms: 50,
            },
            Duration::from_millis(400),
            CashuRoutingConfig::default(),
            None,
            None,
        );
        let data = b"slow-offline-over-ble".to_vec();
        let hash_hex = hex::encode(hashtree_core::sha256(&data));

        state.peers.write().await.insert(
            "peer-a".to_string(),
            PeerEntry {
                peer_id: PeerId::new("peer-a-pub".to_string()),
                direction: PeerDirection::Outbound,
                state: ConnectionState::Connected,
                last_seen: Instant::now(),
                peer: Some(MeshPeer::mock_for_tests(
                    TestMeshPeer::with_delayed_response(
                        Some(data.clone()),
                        Duration::from_millis(200),
                    ),
                )),
                pool: PeerPool::Other,
                transport: PeerTransport::Bluetooth,
                signal_paths: BTreeSet::from([PeerSignalPath::Bluetooth]),
                bytes_sent: 0,
                bytes_received: 0,
            },
        );

        let resolved = state
            .request_from_peers_with_source(&hash_hex)
            .await
            .expect("expected delayed mock mesh peer response");

        assert_eq!(resolved.0, data);
        assert_eq!(resolved.1, "peer-a-pub");
    }

    #[tokio::test]
    async fn dispatch_signaling_message_is_noop_when_signaling_disabled() {
        let keys = Keys::generate();
        let mut config = WebRTCConfig::default();
        config.signaling_enabled = false;
        let manager = WebRTCManager::new(keys, config);
        let peer_id = PeerId::new("peer-a-pub".to_string());
        let peer_key = peer_id.to_string();
        let peer = MeshPeer::mock_for_tests(TestMeshPeer::with_response(None));
        let peer_ref = peer.mock_ref().expect("mock peer").clone();

        manager.state.peers.write().await.insert(
            peer_key,
            PeerEntry {
                peer_id,
                direction: PeerDirection::Outbound,
                state: ConnectionState::Connected,
                last_seen: Instant::now(),
                peer: Some(peer),
                pool: PeerPool::Other,
                transport: PeerTransport::Bluetooth,
                signal_paths: BTreeSet::from([PeerSignalPath::Bluetooth]),
                bytes_sent: 0,
                bytes_received: 0,
            },
        );

        let (relay_tx, _) = tokio::sync::broadcast::channel(4);
        manager
            .dispatch_signaling_message(
                SignalingMessage::Hello {
                    peer_id: manager.my_peer_id.to_string(),
                    roots: Vec::new(),
                },
                &relay_tx,
            )
            .await;

        assert_eq!(peer_ref.sent_frame_count().await, 0);
    }

    #[tokio::test]
    async fn failed_peer_cleanup_does_not_hold_peer_map_lock_while_closing() {
        let keys = Keys::generate();
        let manager = Arc::new(WebRTCManager::new(keys, WebRTCConfig::default()));
        let peer_id = PeerId::new("peer-a-pub".to_string());
        let peer_key = peer_id.to_string();

        manager.state.peers.write().await.insert(
            peer_key.clone(),
            PeerEntry {
                peer_id: peer_id.clone(),
                direction: PeerDirection::Outbound,
                state: ConnectionState::Connected,
                last_seen: Instant::now(),
                peer: Some(MeshPeer::mock_for_tests(TestMeshPeer::with_delayed_close(
                    Duration::from_millis(200),
                ))),
                pool: PeerPool::Other,
                transport: PeerTransport::Bluetooth,
                signal_paths: BTreeSet::from([PeerSignalPath::Bluetooth]),
                bytes_sent: 0,
                bytes_received: 0,
            },
        );

        let (relay_tx, _) = tokio::sync::broadcast::channel(4);
        let manager_for_task = manager.clone();
        let peer_id_for_task = peer_id.clone();
        let cleanup_task = tokio::spawn(async move {
            manager_for_task
                .handle_peer_state_event(PeerStateEvent::Failed(peer_id_for_task), &relay_tx)
                .await;
        });

        tokio::time::sleep(Duration::from_millis(20)).await;

        let remaining = tokio::time::timeout(Duration::from_millis(50), async {
            manager.state.peers.read().await.len()
        })
        .await
        .expect("peer map read should not block on close");

        assert_eq!(remaining, 0);
        cleanup_task.await.expect("cleanup task");
    }

    #[tokio::test]
    async fn resolve_root_from_peers_does_not_hold_peer_map_lock_while_querying() {
        let keys = Keys::generate();
        let manager = Arc::new(WebRTCManager::new(keys.clone(), WebRTCConfig::default()));
        let owner_keys = Keys::generate();
        let owner_pubkey = owner_keys.public_key().to_hex();
        let tree_name = "video";
        let hash = "ab".repeat(32);
        let event = EventBuilder::new(
            Kind::Custom(root_events::HASHTREE_KIND),
            "",
            [
                Tag::parse(&["d", tree_name]).unwrap(),
                Tag::parse(&["l", root_events::HASHTREE_LABEL]).unwrap(),
                Tag::parse(&["hash", &hash]).unwrap(),
            ],
        )
        .to_event(&owner_keys)
        .unwrap();

        let peer_id = PeerId::new("peer-a-pub".to_string());
        let peer_key = peer_id.to_string();

        manager.state.peers.write().await.insert(
            peer_key.clone(),
            PeerEntry {
                peer_id,
                direction: PeerDirection::Outbound,
                state: ConnectionState::Connected,
                last_seen: Instant::now(),
                peer: Some(MeshPeer::mock_for_tests(TestMeshPeer::with_delayed_events(
                    vec![event],
                    Duration::from_millis(200),
                ))),
                pool: PeerPool::Other,
                transport: PeerTransport::Bluetooth,
                signal_paths: BTreeSet::from([PeerSignalPath::Bluetooth]),
                bytes_sent: 0,
                bytes_received: 0,
            },
        );

        let manager_for_task = manager.clone();
        let owner_pubkey_for_task = owner_pubkey.clone();
        let resolve_task = tokio::spawn(async move {
            manager_for_task
                .state
                .resolve_root_from_peers(
                    &owner_pubkey_for_task,
                    tree_name,
                    Duration::from_millis(500),
                )
                .await
        });

        tokio::time::sleep(Duration::from_millis(20)).await;

        let manager_for_writer = manager.clone();
        let peer_key_for_writer = peer_key.clone();
        let writer_task = tokio::spawn(async move {
            let mut peers = manager_for_writer.state.peers.write().await;
            if let Some(entry) = peers.get_mut(&peer_key_for_writer) {
                entry.bytes_received += 1;
            }
        });

        tokio::time::sleep(Duration::from_millis(20)).await;

        let status_count = tokio::time::timeout(Duration::from_millis(50), async {
            manager.state.peers.read().await.len()
        })
        .await
        .expect("peer map read should not block on root query");

        assert_eq!(status_count, 1);
        assert!(resolve_task.await.expect("resolve task").is_some());
        writer_task.await.expect("writer task");
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
