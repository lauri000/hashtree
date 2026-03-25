use anyhow::{Context, Result};
use async_trait::async_trait;
use nostr::{ClientMessage, Event, Filter, JsonUtil, Keys, RelayMessage};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, watch, Mutex};
use tracing::{debug, warn};

use super::root_events::{
    build_root_filter, is_hashtree_labeled_event, pick_latest_event, root_event_from_peer,
    PeerRootEvent, HASHTREE_KIND,
};
use super::LocalNostrBus;
use crate::nostr_relay::NostrRelay;

#[derive(Debug, Clone)]
pub struct MulticastConfig {
    pub enabled: bool,
    pub group: String,
    pub port: u16,
    pub max_peers: usize,
    pub announce_interval_ms: u64,
}

#[async_trait]
impl LocalNostrBus for MulticastNostrBus {
    fn source_name(&self) -> &'static str {
        "multicast"
    }

    async fn broadcast_event(&self, event: &Event) -> Result<()> {
        MulticastNostrBus::broadcast_event(self, event).await
    }

    async fn query_root(
        &self,
        owner_pubkey: &str,
        tree_name: &str,
        timeout: Duration,
    ) -> Option<PeerRootEvent> {
        MulticastNostrBus::query_root(self, owner_pubkey, tree_name, timeout).await
    }
}

impl MulticastConfig {
    pub fn is_enabled(&self) -> bool {
        self.enabled && self.max_peers > 0
    }
}

impl Default for MulticastConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            group: "239.255.42.98".to_string(),
            port: 48555,
            max_peers: 0,
            announce_interval_ms: 2_000,
        }
    }
}

pub struct MulticastNostrBus {
    config: MulticastConfig,
    keys: Keys,
    relay: Arc<NostrRelay>,
    socket: Arc<UdpSocket>,
    target_addr: SocketAddr,
    pending_queries: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<RelayMessage>>>>,
    announced_event_ids: Arc<Mutex<HashSet<String>>>,
}

impl MulticastNostrBus {
    pub async fn bind(
        config: MulticastConfig,
        keys: Keys,
        relay: Arc<NostrRelay>,
    ) -> Result<Arc<Self>> {
        let group: Ipv4Addr = config
            .group
            .parse()
            .with_context(|| format!("invalid multicast group {}", config.group))?;
        let std_socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        std_socket.set_reuse_address(true)?;
        #[cfg(unix)]
        std_socket.set_reuse_port(true)?;
        std_socket.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, config.port).into())?;
        std_socket.set_multicast_loop_v4(true)?;
        std_socket.join_multicast_v4(&group, &Ipv4Addr::UNSPECIFIED)?;
        std_socket.set_nonblocking(true)?;

        let socket = UdpSocket::from_std(std_socket.into())?;
        let target_addr = SocketAddr::V4(SocketAddrV4::new(group, config.port));

        Ok(Arc::new(Self {
            config,
            keys,
            relay,
            socket: Arc::new(socket),
            target_addr,
            pending_queries: Arc::new(Mutex::new(HashMap::new())),
            announced_event_ids: Arc::new(Mutex::new(HashSet::new())),
        }))
    }

    pub async fn run(
        self: Arc<Self>,
        mut shutdown_rx: watch::Receiver<bool>,
        signaling_tx: mpsc::Sender<(String, Event)>,
    ) -> Result<()> {
        let mut announce_ticker = tokio::time::interval(Duration::from_millis(
            self.config.announce_interval_ms.max(1),
        ));
        let mut buf = vec![0u8; 64 * 1024];

        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = announce_ticker.tick() => {
                    if let Err(err) = self.broadcast_known_root_updates().await {
                        debug!("multicast root announcement failed: {}", err);
                    }
                }
                recv = self.socket.recv_from(&mut buf) => {
                    let (len, _src) = match recv {
                        Ok(value) => value,
                        Err(err) => {
                            warn!("multicast receive failed: {}", err);
                            continue;
                        }
                    };
                    let text = match std::str::from_utf8(&buf[..len]) {
                        Ok(text) => text,
                        Err(err) => {
                            debug!("ignoring non-utf8 multicast datagram: {}", err);
                            continue;
                        }
                    };
                    self.handle_datagram(text, &signaling_tx).await;
                }
            }
        }

        Ok(())
    }

    pub async fn broadcast_event(&self, event: &Event) -> Result<()> {
        let payload = event.as_json();
        let copies = if event.kind.is_ephemeral() { 3 } else { 1 };
        for _ in 0..copies {
            self.socket
                .send_to(payload.as_bytes(), self.target_addr)
                .await?;
        }
        Ok(())
    }

    pub async fn query_root(
        &self,
        owner_pubkey: &str,
        tree_name: &str,
        timeout: Duration,
    ) -> Option<PeerRootEvent> {
        let filter = build_root_filter(owner_pubkey, tree_name)?;
        let subscription_id = format!("multicast-root-{}", rand::random::<u64>());
        let request = ClientMessage::req(
            nostr::SubscriptionId::new(subscription_id.clone()),
            vec![filter],
        );
        let (tx, mut rx) = mpsc::unbounded_channel();
        self.pending_queries
            .lock()
            .await
            .insert(subscription_id.clone(), tx);

        if self
            .socket
            .send_to(request.as_json().as_bytes(), self.target_addr)
            .await
            .is_err()
        {
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

    async fn handle_datagram(&self, text: &str, signaling_tx: &mpsc::Sender<(String, Event)>) {
        if let Ok(event) = Event::from_json(text) {
            if event.pubkey == self.keys.public_key() {
                return;
            }

            if event.kind.is_ephemeral() {
                let _ = signaling_tx.send(("multicast".to_string(), event)).await;
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
                        let _ = self
                            .socket
                            .send_to(relay_msg.as_json().as_bytes(), self.target_addr)
                            .await;
                    }
                }
                let eose = RelayMessage::eose(subscription_id);
                let _ = self
                    .socket
                    .send_to(eose.as_json().as_bytes(), self.target_addr)
                    .await;
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
        }
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
