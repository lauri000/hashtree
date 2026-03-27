use anyhow::{anyhow, Result};
use async_trait::async_trait;
use nostr::{ClientMessage, Event, Filter, JsonUtil, Keys, RelayMessage};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{mpsc, watch, Mutex};
use tracing::{debug, warn};

use super::root_events::{
    build_root_filter, is_hashtree_labeled_event, pick_latest_event, root_event_from_peer,
    PeerRootEvent, HASHTREE_KIND,
};
use super::LocalNostrBus;
use crate::nostr_relay::NostrRelay;

pub const WIFI_AWARE_SOURCE: &str = "wifi-aware";

#[derive(Debug, Clone)]
pub struct WifiAwareConfig {
    pub enabled: bool,
    pub max_peers: usize,
    pub announce_interval_ms: u64,
}

impl WifiAwareConfig {
    pub fn is_enabled(&self) -> bool {
        self.enabled && self.max_peers > 0
    }
}

impl Default for WifiAwareConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_peers: 0,
            announce_interval_ms: 2_000,
        }
    }
}

#[derive(Debug, Clone)]
pub enum WifiAwareEvent {
    PeerDiscovered { peer_id: String },
    PeerLost { peer_id: String },
    TextMessage { peer_id: String, payload: String },
}

#[async_trait]
pub trait MobileWifiAwareBridge: Send + Sync {
    async fn start(&self, local_peer_id: String) -> Result<mpsc::Receiver<WifiAwareEvent>>;

    async fn broadcast_text(&self, payload: String) -> Result<()>;
}

static MOBILE_WIFI_AWARE_BRIDGE: OnceLock<Arc<dyn MobileWifiAwareBridge>> = OnceLock::new();

pub fn install_mobile_wifi_aware_bridge(bridge: Arc<dyn MobileWifiAwareBridge>) -> Result<()> {
    MOBILE_WIFI_AWARE_BRIDGE
        .set(bridge)
        .map_err(|_| anyhow!("mobile wifi aware bridge already installed"))
}

pub(crate) fn mobile_wifi_aware_bridge() -> Option<Arc<dyn MobileWifiAwareBridge>> {
    MOBILE_WIFI_AWARE_BRIDGE.get().cloned()
}

pub struct WifiAwareNostrBus {
    config: WifiAwareConfig,
    keys: Keys,
    relay: Arc<NostrRelay>,
    bridge: Arc<dyn MobileWifiAwareBridge>,
    pending_queries: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<RelayMessage>>>>,
    announced_event_ids: Arc<Mutex<HashSet<String>>>,
}

#[async_trait]
impl LocalNostrBus for WifiAwareNostrBus {
    fn source_name(&self) -> &'static str {
        WIFI_AWARE_SOURCE
    }

    async fn broadcast_event(&self, event: &Event) -> Result<()> {
        WifiAwareNostrBus::broadcast_event(self, event).await
    }

    async fn query_root(
        &self,
        owner_pubkey: &str,
        tree_name: &str,
        timeout: Duration,
    ) -> Option<PeerRootEvent> {
        WifiAwareNostrBus::query_root(self, owner_pubkey, tree_name, timeout).await
    }
}

impl WifiAwareNostrBus {
    pub fn new(
        config: WifiAwareConfig,
        keys: Keys,
        relay: Arc<NostrRelay>,
        bridge: Arc<dyn MobileWifiAwareBridge>,
    ) -> Arc<Self> {
        Arc::new(Self {
            config,
            keys,
            relay,
            bridge,
            pending_queries: Arc::new(Mutex::new(HashMap::new())),
            announced_event_ids: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub async fn run(
        self: Arc<Self>,
        local_peer_id: String,
        mut shutdown_rx: watch::Receiver<bool>,
        signaling_tx: mpsc::Sender<(String, Event)>,
    ) -> Result<()> {
        let mut announce_ticker = tokio::time::interval(Duration::from_millis(
            self.config.announce_interval_ms.max(1),
        ));
        let mut events = self.bridge.start(local_peer_id).await?;

        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = announce_ticker.tick() => {
                    if let Err(err) = self.broadcast_known_root_updates().await {
                        debug!("wifi aware root announcement failed: {}", err);
                    }
                }
                maybe_event = events.recv() => {
                    match maybe_event {
                        Some(WifiAwareEvent::TextMessage { peer_id, payload }) => {
                            self.handle_text_message(&peer_id, &payload, &signaling_tx).await;
                        }
                        Some(WifiAwareEvent::PeerDiscovered { peer_id }) => {
                            debug!("wifi aware peer discovered: {}", peer_id);
                        }
                        Some(WifiAwareEvent::PeerLost { peer_id }) => {
                            debug!("wifi aware peer lost: {}", peer_id);
                        }
                        None => break,
                    }
                }
            }
        }

        Ok(())
    }

    pub async fn broadcast_event(&self, event: &Event) -> Result<()> {
        self.bridge.broadcast_text(event.as_json()).await
    }

    pub async fn query_root(
        &self,
        owner_pubkey: &str,
        tree_name: &str,
        timeout: Duration,
    ) -> Option<PeerRootEvent> {
        let filter = build_root_filter(owner_pubkey, tree_name)?;
        let subscription_id = format!("wifi-aware-root-{}", rand::random::<u64>());
        let request = ClientMessage::req(
            nostr::SubscriptionId::new(subscription_id.clone()),
            vec![filter],
        );
        let (tx, mut rx) = mpsc::unbounded_channel();
        self.pending_queries
            .lock()
            .await
            .insert(subscription_id.clone(), tx);

        if self.bridge.broadcast_text(request.as_json()).await.is_err() {
            self.pending_queries.lock().await.remove(&subscription_id);
            return None;
        }

        let mut events = Vec::new();
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                _ = &mut deadline => break,
                maybe_msg = rx.recv() => {
                    let Some(msg) = maybe_msg else {
                        break;
                    };
                    match msg {
                        RelayMessage::Event { subscription_id: sid, event }
                            if sid.to_string() == subscription_id =>
                        {
                            events.push(*event);
                        }
                        RelayMessage::EndOfStoredEvents(sid) if sid.to_string() == subscription_id => {
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        self.pending_queries.lock().await.remove(&subscription_id);

        let latest = pick_latest_event(events.iter())?;
        root_event_from_peer(latest, self.source_name(), tree_name)
    }

    async fn handle_text_message(
        &self,
        peer_id: &str,
        text: &str,
        signaling_tx: &mpsc::Sender<(String, Event)>,
    ) {
        if let Ok(event) = Event::from_json(text) {
            if event.pubkey == self.keys.public_key() {
                return;
            }

            if event.kind.is_ephemeral() {
                let _ = signaling_tx
                    .send((self.source_name().to_string(), event))
                    .await;
                return;
            }

            if event.kind == nostr::Kind::Custom(HASHTREE_KIND)
                && is_hashtree_labeled_event(&event)
                && event.verify().is_ok()
            {
                let _ = self.relay.ingest_trusted_event(event).await;
            }
            return;
        }

        if let Ok(msg) = ClientMessage::from_json(text) {
            if let ClientMessage::Req {
                subscription_id,
                filters,
            } = msg
            {
                for filter in filters {
                    let limit = filter.limit.unwrap_or(50).min(50);
                    for event in self.relay.query_events(&filter, limit).await {
                        let relay_msg = RelayMessage::event(subscription_id.clone(), event);
                        if let Err(err) = self.bridge.broadcast_text(relay_msg.as_json()).await {
                            warn!("wifi aware root response broadcast failed: {}", err);
                        }
                    }
                }
                let eose = RelayMessage::eose(subscription_id);
                if let Err(err) = self.bridge.broadcast_text(eose.as_json()).await {
                    warn!("wifi aware eose broadcast failed: {}", err);
                }
            }
            return;
        }

        if let Ok(msg) = RelayMessage::from_json(text) {
            match &msg {
                RelayMessage::Event {
                    subscription_id,
                    event,
                } => {
                    if event.kind == nostr::Kind::Custom(HASHTREE_KIND)
                        && is_hashtree_labeled_event(event)
                        && event.verify().is_ok()
                    {
                        let _ = self.relay.ingest_trusted_event((**event).clone()).await;
                    }
                    let tx = self
                        .pending_queries
                        .lock()
                        .await
                        .get(&subscription_id.to_string())
                        .cloned();
                    if let Some(tx) = tx {
                        let _ = tx.send(msg);
                    }
                }
                RelayMessage::EndOfStoredEvents(subscription_id) => {
                    let tx = self
                        .pending_queries
                        .lock()
                        .await
                        .get(&subscription_id.to_string())
                        .cloned();
                    if let Some(tx) = tx {
                        let _ = tx.send(msg);
                    }
                }
                _ => {}
            }
            return;
        }

        debug!("ignoring wifi aware text frame from {}: {}", peer_id, text);
    }

    async fn broadcast_known_root_updates(&self) -> Result<()> {
        let filter = Filter::new()
            .kind(nostr::Kind::Custom(HASHTREE_KIND))
            .author(self.keys.public_key())
            .custom_tag(
                nostr::SingleLetterTag::lowercase(nostr::Alphabet::L),
                vec![super::root_events::HASHTREE_LABEL.to_string()],
            )
            .limit(256);
        let events = self.relay.query_events(&filter, 256).await;
        let mut announced = self.announced_event_ids.lock().await;
        for event in events {
            let event_id = event.id.to_hex();
            if announced.insert(event_id) {
                self.broadcast_event(&event).await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_relay::NostrRelayConfig;
    use crate::socialgraph::{self, SocialGraphAccessControl, SocialGraphBackend};
    use nostr::{Alphabet, EventBuilder, Kind, SingleLetterTag, Tag, TagKind};
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::Mutex as AsyncMutex;

    struct MockWifiAwareBridge {
        sent_payloads: AsyncMutex<Vec<String>>,
        response_events: AsyncMutex<Vec<Event>>,
        event_tx: AsyncMutex<Option<mpsc::Sender<WifiAwareEvent>>>,
    }

    impl MockWifiAwareBridge {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                sent_payloads: AsyncMutex::new(Vec::new()),
                response_events: AsyncMutex::new(Vec::new()),
                event_tx: AsyncMutex::new(None),
            })
        }

        async fn queue_response_event(&self, event: Event) {
            self.response_events.lock().await.push(event);
        }

        async fn sent_payloads(&self) -> Vec<String> {
            self.sent_payloads.lock().await.clone()
        }

        async fn wait_until_started(&self) {
            for _ in 0..100 {
                if self.event_tx.lock().await.is_some() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("mock wifi aware bridge did not start in time");
        }
    }

    #[async_trait]
    impl MobileWifiAwareBridge for MockWifiAwareBridge {
        async fn start(&self, _local_peer_id: String) -> Result<mpsc::Receiver<WifiAwareEvent>> {
            let (tx, rx) = mpsc::channel(32);
            *self.event_tx.lock().await = Some(tx);
            Ok(rx)
        }

        async fn broadcast_text(&self, payload: String) -> Result<()> {
            self.sent_payloads.lock().await.push(payload.clone());
            let Some(tx) = self.event_tx.lock().await.clone() else {
                return Ok(());
            };

            if let Ok(ClientMessage::Req {
                subscription_id,
                filters,
            }) = ClientMessage::from_json(&payload)
            {
                let response_events = self.response_events.lock().await.clone();
                for filter in filters {
                    for event in response_events
                        .iter()
                        .filter(|event| filter.match_event(event))
                    {
                        tx.send(WifiAwareEvent::TextMessage {
                            peer_id: "peer-b".to_string(),
                            payload: RelayMessage::event(subscription_id.clone(), event.clone())
                                .as_json(),
                        })
                        .await
                        .map_err(|err| anyhow!("mock wifi aware event send failed: {}", err))?;
                    }
                }
                tx.send(WifiAwareEvent::TextMessage {
                    peer_id: "peer-b".to_string(),
                    payload: RelayMessage::eose(subscription_id).as_json(),
                })
                .await
                .map_err(|err| anyhow!("mock wifi aware eose send failed: {}", err))?;
            }
            Ok(())
        }
    }

    fn test_relay(keys: &Keys, tmp: &TempDir) -> Result<Arc<NostrRelay>> {
        let _guard = socialgraph::test_lock();
        let graph_store =
            socialgraph::open_social_graph_store_with_mapsize(tmp.path(), Some(128 * 1024 * 1024))?;
        let backend: Arc<dyn SocialGraphBackend> = graph_store.clone();
        let access = Arc::new(SocialGraphAccessControl::new(
            Arc::clone(&backend),
            0,
            HashSet::from([keys.public_key().to_hex()]),
        ));
        Ok(Arc::new(NostrRelay::new(
            Arc::clone(&backend),
            tmp.path().to_path_buf(),
            HashSet::from([keys.public_key().to_hex()]),
            Some(access),
            NostrRelayConfig {
                spambox_db_max_bytes: 0,
                ..Default::default()
            },
        )?))
    }

    #[tokio::test]
    async fn wifi_aware_bus_broadcast_event_forwards_json() -> Result<()> {
        let bridge = MockWifiAwareBridge::new();
        let bus_keys = Keys::generate();
        let tmp = TempDir::new()?;
        let relay = test_relay(&bus_keys, &tmp)?;
        let bus = WifiAwareNostrBus::new(
            WifiAwareConfig::default(),
            bus_keys.clone(),
            relay,
            bridge.clone(),
        );
        let event =
            EventBuilder::new(Kind::TextNote, "hello wifi aware", []).to_event(&bus_keys)?;

        bus.broadcast_event(&event).await?;

        let sent = bridge.sent_payloads().await;
        assert_eq!(sent, vec![event.as_json()]);
        Ok(())
    }

    #[tokio::test]
    async fn wifi_aware_bus_query_root_returns_matching_event() -> Result<()> {
        let bridge = MockWifiAwareBridge::new();
        let bus_keys = Keys::generate();
        let author_keys = Keys::generate();
        let tmp = TempDir::new()?;
        let relay = test_relay(&bus_keys, &tmp)?;
        let bus = WifiAwareNostrBus::new(
            WifiAwareConfig {
                enabled: true,
                max_peers: 2,
                announce_interval_ms: 60_000,
            },
            bus_keys,
            relay,
            bridge.clone(),
        );
        let root_event = EventBuilder::new(
            Kind::Custom(HASHTREE_KIND),
            "",
            [
                Tag::identifier("video".to_string()),
                Tag::custom(
                    TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::L)),
                    vec!["hashtree".to_string()],
                ),
                Tag::custom(TagKind::Custom("hash".into()), vec!["ab".repeat(32)]),
            ],
        )
        .to_event(&author_keys)?;
        bridge.queue_response_event(root_event).await;

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let bus_task = {
            let bus = bus.clone();
            tokio::spawn(async move {
                let (signaling_tx, _signaling_rx) = mpsc::channel(8);
                bus.run("local-peer".to_string(), shutdown_rx, signaling_tx)
                    .await
            })
        };
        bridge.wait_until_started().await;

        let resolved = bus
            .query_root(
                &author_keys.public_key().to_hex(),
                "video",
                Duration::from_secs(1),
            )
            .await
            .expect("expected wifi aware root");

        assert_eq!(resolved.hash, "ab".repeat(32));
        assert_eq!(resolved.peer_id, WIFI_AWARE_SOURCE);

        shutdown_tx.send(true)?;
        bus_task.await??;
        Ok(())
    }
}
