use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, Mutex};

use nostr::{ClientMessage as NostrClientMessage, Event, EventId, Filter as NostrFilter, JsonUtil, RelayMessage as NostrRelayMessage, SubscriptionId};

use crate::socialgraph;

#[derive(Debug, Clone)]
pub struct NostrRelayConfig {
    pub spambox_db_max_bytes: u64,
    pub max_query_limit: usize,
    pub max_subs_per_client: usize,
    pub max_filters_per_sub: usize,
    pub spambox_max_events_per_min: u32,
    pub spambox_max_reqs_per_min: u32,
}

impl Default for NostrRelayConfig {
    fn default() -> Self {
        Self {
            spambox_db_max_bytes: 1 * 1024 * 1024 * 1024,
            max_query_limit: 200,
            max_subs_per_client: 64,
            max_filters_per_sub: 32,
            spambox_max_events_per_min: 120,
            spambox_max_reqs_per_min: 120,
        }
    }
}

#[cfg(feature = "nostrdb")]
mod imp {
    use super::*;
    use anyhow::Result;
    use nostrdb::{Filter as NdbFilter, Transaction};

    use crate::socialgraph::{Ndb, SocialGraphAccessControl};
    use tracing::warn;

    struct NostrStore {
        ndb: Arc<Ndb>,
    }

    impl NostrStore {
        fn new(ndb: Arc<Ndb>) -> Self {
            Self { ndb }
        }

        fn ingest(&self, event: &Event) -> Result<()> {
            let event_json = event.as_json();
            let wrapped = format!(r#"[\"EVENT\",\"p2p\",{}]"#, event_json);
            self.ndb.process_event(&wrapped)?;
            Ok(())
        }

        fn query(&self, filter: &NostrFilter, limit: usize) -> Vec<Event> {
            if limit == 0 {
                return Vec::new();
            }

            let filter_json = match serde_json::to_string(filter) {
                Ok(json) => json,
                Err(_) => return Vec::new(),
            };
            let ndb_filter = match NdbFilter::from_json(&filter_json) {
                Ok(f) => f,
                Err(_) => return Vec::new(),
            };
            let txn = match Transaction::new(&self.ndb) {
                Ok(txn) => txn,
                Err(_) => return Vec::new(),
            };

            let max_results = limit.min(i32::MAX as usize) as i32;
            let results = match self.ndb.query(&txn, &[ndb_filter], max_results) {
                Ok(r) => r,
                Err(_) => return Vec::new(),
            };

            let mut events = Vec::new();
            for result in results {
                let json = match result.note.json() {
                    Ok(json) => json,
                    Err(_) => continue,
                };
                if let Ok(event) = Event::from_json(json) {
                    events.push(event);
                }
            }
            events
        }
    }

    #[derive(Debug, Clone)]
    struct ClientQuota {
        last_reset: Instant,
        spambox_events: u32,
        reqs: u32,
    }

    impl ClientQuota {
        fn new() -> Self {
            Self {
                last_reset: Instant::now(),
                spambox_events: 0,
                reqs: 0,
            }
        }

        fn reset_if_needed(&mut self) {
            if self.last_reset.elapsed() >= Duration::from_secs(60) {
                self.last_reset = Instant::now();
                self.spambox_events = 0;
                self.reqs = 0;
            }
        }

        fn allow_spambox_event(&mut self, limit: u32) -> bool {
            self.reset_if_needed();
            if self.spambox_events >= limit {
                return false;
            }
            self.spambox_events += 1;
            true
        }

        fn allow_req(&mut self, limit: u32) -> bool {
            self.reset_if_needed();
            if self.reqs >= limit {
                return false;
            }
            self.reqs += 1;
            true
        }
    }

    struct ClientState {
        sender: mpsc::UnboundedSender<String>,
        pubkey: Option<String>,
        quota: ClientQuota,
    }

    struct RecentEvents {
        order: VecDeque<EventId>,
        events: HashMap<EventId, Event>,
        max_len: usize,
    }

    impl RecentEvents {
        fn new(max_len: usize) -> Self {
            Self {
                order: VecDeque::new(),
                events: HashMap::new(),
                max_len: max_len.max(128),
            }
        }

        fn insert(&mut self, event: Event) {
            if self.events.contains_key(&event.id) {
                return;
            }
            self.order.push_back(event.id);
            self.events.insert(event.id, event);
            while self.order.len() > self.max_len {
                if let Some(oldest) = self.order.pop_front() {
                    self.events.remove(&oldest);
                }
            }
        }

        fn matching(&self, filter: &NostrFilter) -> Vec<Event> {
            self.events
                .values()
                .filter(|event| filter.match_event(event))
                .cloned()
                .collect()
        }
    }

    enum SpamboxStore {
        Ndb(NostrStore),
        Memory(MemorySpambox),
    }

    struct MemorySpambox {
        events: Mutex<VecDeque<Event>>,
        max_len: usize,
    }

    impl MemorySpambox {
        fn new(max_len: usize) -> Self {
            Self {
                events: Mutex::new(VecDeque::new()),
                max_len: max_len.max(128),
            }
        }

        async fn ingest(&self, event: &Event) -> bool {
            let mut events = self.events.lock().await;
            events.push_back(event.clone());
            while events.len() > self.max_len {
                events.pop_front();
            }
            true
        }
    }

    impl SpamboxStore {
        async fn ingest(&self, event: &Event) -> bool {
            match self {
                SpamboxStore::Ndb(store) => store.ingest(event).is_ok(),
                SpamboxStore::Memory(store) => store.ingest(event).await,
            }
        }
    }

    pub struct NostrRelay {
        config: NostrRelayConfig,
        trusted: NostrStore,
        spambox: Option<SpamboxStore>,
        social_graph: Option<Arc<SocialGraphAccessControl>>,
        clients: Mutex<HashMap<u64, ClientState>>,
        subscriptions: Mutex<HashMap<u64, HashMap<SubscriptionId, Vec<NostrFilter>>>>,
        recent_events: Mutex<RecentEvents>,
        next_client_id: AtomicU64,
    }

    impl NostrRelay {
        pub fn new(
            trusted_ndb: Arc<Ndb>,
            data_dir: PathBuf,
            social_graph: Option<Arc<SocialGraphAccessControl>>,
            config: NostrRelayConfig,
        ) -> Result<Self> {
            let spambox = if config.spambox_db_max_bytes == 0 {
                Some(SpamboxStore::Memory(MemorySpambox::new(config.max_query_limit * 2)))
            } else {
                let spam_dir = data_dir.join("nostrdb_spambox");
                match socialgraph::init_ndb_at_path(&spam_dir, Some(config.spambox_db_max_bytes)) {
                    Ok(ndb) => Some(SpamboxStore::Ndb(NostrStore::new(ndb))),
                    Err(err) => {
                        warn!("Failed to open spambox nostrdb (falling back to memory): {}", err);
                        Some(SpamboxStore::Memory(MemorySpambox::new(config.max_query_limit * 2)))
                    }
                }
            };

            let recent_size = config.max_query_limit.saturating_mul(2);

            Ok(Self {
                config,
                trusted: NostrStore::new(trusted_ndb),
                spambox,
                social_graph,
                clients: Mutex::new(HashMap::new()),
                subscriptions: Mutex::new(HashMap::new()),
                recent_events: Mutex::new(RecentEvents::new(recent_size)),
                next_client_id: AtomicU64::new(1),
            })
        }

        pub fn next_client_id(&self) -> u64 {
            self.next_client_id.fetch_add(1, Ordering::SeqCst)
        }

        pub async fn register_client(
            &self,
            client_id: u64,
            sender: mpsc::UnboundedSender<String>,
            pubkey: Option<String>,
        ) {
            let mut clients = self.clients.lock().await;
            clients.insert(
                client_id,
                ClientState {
                    sender,
                    pubkey,
                    quota: ClientQuota::new(),
                },
            );
        }

        pub async fn unregister_client(&self, client_id: u64) {
            let mut clients = self.clients.lock().await;
            clients.remove(&client_id);
            drop(clients);
            let mut subs = self.subscriptions.lock().await;
            subs.remove(&client_id);
        }

        pub async fn handle_client_message(&self, client_id: u64, msg: NostrClientMessage) {
            match msg {
                NostrClientMessage::Event(event) => {
                    self.handle_event(client_id, *event).await;
                }
                NostrClientMessage::Req { subscription_id, filters } => {
                    self.handle_req(client_id, subscription_id, filters).await;
                }
                NostrClientMessage::Count { subscription_id, filters } => {
                    self.handle_count(client_id, subscription_id, filters).await;
                }
                NostrClientMessage::Close(subscription_id) => {
                    self.handle_close(client_id, subscription_id).await;
                }
                NostrClientMessage::Auth(event) => {
                    self.handle_auth(client_id, *event).await;
                }
                NostrClientMessage::NegOpen { .. }
                | NostrClientMessage::NegMsg { .. }
                | NostrClientMessage::NegClose { .. } => {
                    self.send_to_client(client_id, NostrRelayMessage::notice("negentropy not supported")).await;
                }
            }
        }

        async fn handle_auth(&self, client_id: u64, event: Event) {
            let ok = event.verify().is_ok();
            let message = if ok { "" } else { "invalid auth" };
            self.send_to_client(client_id, NostrRelayMessage::ok(event.id, ok, message)).await;
        }

        async fn handle_close(&self, client_id: u64, subscription_id: SubscriptionId) {
            let mut subs = self.subscriptions.lock().await;
            if let Some(map) = subs.get_mut(&client_id) {
                map.remove(&subscription_id);
            }
        }

        async fn handle_event(&self, client_id: u64, event: Event) {
            let ok = event.verify().is_ok();
            if !ok {
                self.send_to_client(
                    client_id,
                    NostrRelayMessage::ok(event.id, false, "invalid: signature"),
                )
                .await;
                return;
            }

            let trusted = self.is_trusted_event(client_id, &event).await;
            if !trusted {
                if !self.allow_spambox_event(client_id).await {
                    self.send_to_client(
                        client_id,
                        NostrRelayMessage::ok(event.id, false, "rate limited"),
                    )
                    .await;
                    return;
                }
            }

            let is_ephemeral = event.kind.is_ephemeral();
            if trusted {
                let mut recent = self.recent_events.lock().await;
                recent.insert(event.clone());
            }
            if !is_ephemeral {
                let stored = if trusted {
                    self.trusted.ingest(&event).is_ok()
                } else {
                    match self.spambox.as_ref() {
                        Some(spambox) => spambox.ingest(&event).await,
                        None => false,
                    }
                };

                if !stored {
                    let message = if trusted { "store failed" } else { "spambox full" };
                    self.send_to_client(client_id, NostrRelayMessage::ok(event.id, false, message)).await;
                    return;
                }
            }

            let message = if trusted { "" } else { "spambox" };
            self.send_to_client(client_id, NostrRelayMessage::ok(event.id, true, message)).await;

            if trusted {
                self.broadcast_event(&event).await;
            }
        }

        async fn handle_req(
            &self,
            client_id: u64,
            subscription_id: SubscriptionId,
            mut filters: Vec<NostrFilter>,
        ) {
            if !self.allow_req(client_id).await {
                self.send_to_client(
                    client_id,
                    NostrRelayMessage::closed(subscription_id, "rate limited"),
                )
                .await;
                return;
            }

            if filters.len() > self.config.max_filters_per_sub {
                filters.truncate(self.config.max_filters_per_sub);
            }

            {
                let mut subs = self.subscriptions.lock().await;
                let entry = subs.entry(client_id).or_default();
                if !entry.contains_key(&subscription_id)
                    && entry.len() >= self.config.max_subs_per_client
                {
                    self.send_to_client(
                        client_id,
                        NostrRelayMessage::closed(subscription_id, "too many subscriptions"),
                    )
                    .await;
                    return;
                }
                entry.insert(subscription_id.clone(), filters.clone());
            }

            let mut seen: HashSet<EventId> = HashSet::new();
            for filter in &filters {
                let limit = filter
                    .limit
                    .unwrap_or(self.config.max_query_limit)
                    .min(self.config.max_query_limit);
                if limit == 0 {
                    continue;
                }

                let recent = {
                    let cache = self.recent_events.lock().await;
                    cache.matching(filter)
                };
                for event in recent {
                    if seen.insert(event.id) {
                        self.send_to_client(
                            client_id,
                            NostrRelayMessage::event(subscription_id.clone(), event),
                        )
                        .await;
                    }
                }

                for event in self.trusted.query(filter, limit) {
                    if seen.insert(event.id) {
                        self.send_to_client(
                            client_id,
                            NostrRelayMessage::event(subscription_id.clone(), event),
                        )
                        .await;
                    }
                }
            }

            self.send_to_client(client_id, NostrRelayMessage::eose(subscription_id)).await;
        }

        async fn handle_count(
            &self,
            client_id: u64,
            subscription_id: SubscriptionId,
            filters: Vec<NostrFilter>,
        ) {
            if !self.allow_req(client_id).await {
                self.send_to_client(
                    client_id,
                    NostrRelayMessage::closed(subscription_id, "rate limited"),
                )
                .await;
                return;
            }

            let mut seen: HashSet<EventId> = HashSet::new();
            for filter in &filters {
                let limit = filter
                    .limit
                    .unwrap_or(self.config.max_query_limit)
                    .min(self.config.max_query_limit);
                if limit == 0 {
                    continue;
                }
                let recent = {
                    let cache = self.recent_events.lock().await;
                    cache.matching(filter)
                };
                for event in recent {
                    seen.insert(event.id);
                }
                for event in self.trusted.query(filter, limit) {
                    seen.insert(event.id);
                }
            }

            self.send_to_client(
                client_id,
                NostrRelayMessage::count(subscription_id, seen.len()),
            )
            .await;
        }

        async fn is_trusted_event(&self, client_id: u64, event: &Event) -> bool {
            if let Some(ref social_graph) = self.social_graph {
                return social_graph.check_write_access(&event.pubkey.to_hex());
            }
            let client_pubkey = {
                let clients = self.clients.lock().await;
                clients.get(&client_id).and_then(|state| state.pubkey.clone())
            };
            if let Some(pubkey) = client_pubkey {
                return pubkey == event.pubkey.to_hex();
            }
            true
        }

        async fn allow_spambox_event(&self, client_id: u64) -> bool {
            let mut clients = self.clients.lock().await;
            let Some(state) = clients.get_mut(&client_id) else {
                return false;
            };
            state
                .quota
                .allow_spambox_event(self.config.spambox_max_events_per_min)
        }

        async fn allow_req(&self, client_id: u64) -> bool {
            let mut clients = self.clients.lock().await;
            let Some(state) = clients.get_mut(&client_id) else {
                return false;
            };
            state.quota.allow_req(self.config.spambox_max_reqs_per_min)
        }

        async fn broadcast_event(&self, event: &Event) {
            let subscriptions = self.subscriptions.lock().await;
            let mut deliveries: Vec<(u64, SubscriptionId)> = Vec::new();
            for (client_id, subs) in subscriptions.iter() {
                for (sub_id, filters) in subs.iter() {
                    if filters.iter().any(|f| f.match_event(event)) {
                        deliveries.push((*client_id, sub_id.clone()));
                    }
                }
            }
            drop(subscriptions);

            for (client_id, sub_id) in deliveries {
                self.send_to_client(client_id, NostrRelayMessage::event(sub_id, event.clone()))
                    .await;
            }
        }

        async fn send_to_client(&self, client_id: u64, msg: NostrRelayMessage) {
            let sender = {
                let clients = self.clients.lock().await;
                clients.get(&client_id).map(|state| state.sender.clone())
            };
            if let Some(tx) = sender {
                let _ = tx.send(msg.as_json());
            }
        }
    }
}

#[cfg(not(feature = "nostrdb"))]
mod imp {
    use super::*;
    use anyhow::Result;
    use crate::socialgraph::{Ndb, SocialGraphAccessControl};

    pub struct NostrRelay {
        clients: Mutex<HashMap<u64, mpsc::UnboundedSender<String>>>,
        next_client_id: AtomicU64,
    }

    impl NostrRelay {
        pub fn new(
            _trusted_ndb: Arc<Ndb>,
            _data_dir: PathBuf,
            _social_graph: Option<Arc<SocialGraphAccessControl>>,
            _config: NostrRelayConfig,
        ) -> Result<Self> {
            Ok(Self {
                clients: Mutex::new(HashMap::new()),
                next_client_id: AtomicU64::new(1),
            })
        }

        pub fn next_client_id(&self) -> u64 {
            self.next_client_id.fetch_add(1, Ordering::SeqCst)
        }

        pub async fn register_client(
            &self,
            client_id: u64,
            sender: mpsc::UnboundedSender<String>,
            _pubkey: Option<String>,
        ) {
            let mut clients = self.clients.lock().await;
            clients.insert(client_id, sender);
        }

        pub async fn unregister_client(&self, client_id: u64) {
            let mut clients = self.clients.lock().await;
            clients.remove(&client_id);
        }

        pub async fn handle_client_message(&self, client_id: u64, msg: NostrClientMessage) {
            for reply in nostr_responses_for(&msg) {
                self.send_to_client(client_id, reply).await;
            }
        }

        async fn send_to_client(&self, client_id: u64, msg: NostrRelayMessage) {
            let sender = {
                let clients = self.clients.lock().await;
                clients.get(&client_id).cloned()
            };
            if let Some(tx) = sender {
                let _ = tx.send(msg.as_json());
            }
        }
    }

    fn nostr_responses_for(msg: &NostrClientMessage) -> Vec<NostrRelayMessage> {
        match msg {
            NostrClientMessage::Event(event) => {
                let ok = event.verify().is_ok();
                let message = if ok { "" } else { "invalid: signature" };
                vec![NostrRelayMessage::ok(event.id, ok, message)]
            }
            NostrClientMessage::Req { subscription_id, .. } => {
                vec![NostrRelayMessage::eose(subscription_id.clone())]
            }
            NostrClientMessage::Count { subscription_id, .. } => {
                vec![NostrRelayMessage::count(subscription_id.clone(), 0)]
            }
            NostrClientMessage::Close(_) => Vec::new(),
            NostrClientMessage::Auth(event) => {
                let ok = event.verify().is_ok();
                let message = if ok { "" } else { "invalid auth" };
                vec![NostrRelayMessage::ok(event.id, ok, message)]
            }
            NostrClientMessage::NegOpen { .. }
            | NostrClientMessage::NegMsg { .. }
            | NostrClientMessage::NegClose { .. } => {
                vec![NostrRelayMessage::notice("negentropy not supported")]
            }
        }
    }
}

pub use imp::NostrRelay;

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use nostr::{EventBuilder, Filter, JsonUtil, Keys, Kind, RelayMessage, SubscriptionId};
    use std::collections::HashSet;
    use tempfile::TempDir;
    use tokio::time::{timeout, Duration};

    async fn recv_relay_message(
        rx: &mut mpsc::UnboundedReceiver<String>,
    ) -> Result<RelayMessage> {
        let msg = timeout(Duration::from_secs(1), rx.recv()).await?
            .ok_or_else(|| anyhow::anyhow!("channel closed"))?;
        Ok(RelayMessage::from_json(msg)?)
    }

    #[tokio::test]
    async fn relay_stores_and_serves_events() -> Result<()> {
        let tmp = TempDir::new()?;
        let ndb = {
            let _guard = crate::socialgraph::test_lock();
            crate::socialgraph::init_ndb_with_mapsize(tmp.path(), Some(128 * 1024 * 1024))?
        };
        let keys = Keys::generate();
        let mut allowed = HashSet::new();
        allowed.insert(keys.public_key().to_hex());

        let access = Arc::new(crate::socialgraph::SocialGraphAccessControl::new(
            Arc::clone(&ndb),
            0,
            allowed,
        ));

        let mut relay_config = NostrRelayConfig::default();
        relay_config.spambox_db_max_bytes = 0;
        let relay = NostrRelay::new(
            Arc::clone(&ndb),
            tmp.path().to_path_buf(),
            Some(access),
            relay_config,
        )?;

        let (tx, mut rx) = mpsc::unbounded_channel();
        relay.register_client(1, tx, None).await;

        let event = EventBuilder::new(Kind::TextNote, "hello", []).to_event(&keys)?;
        relay
            .handle_client_message(1, NostrClientMessage::event(event.clone()))
            .await;

        match recv_relay_message(&mut rx).await? {
            RelayMessage::Ok { status, .. } => assert!(status),
            other => anyhow::bail!("expected OK, got {:?}", other),
        }

        tokio::time::sleep(Duration::from_millis(50)).await;

        let sub_id = SubscriptionId::new("sub-1");
        let filter = Filter::new()
            .authors(vec![event.pubkey])
            .kinds(vec![event.kind]);
        let mut got_event = false;
        for _ in 0..3 {
            relay
                .handle_client_message(1, NostrClientMessage::req(sub_id.clone(), vec![filter.clone()]))
                .await;

            match recv_relay_message(&mut rx).await? {
                RelayMessage::Event { subscription_id, event: ev } => {
                    assert_eq!(subscription_id, sub_id);
                    assert_eq!(ev.id, event.id);
                    got_event = true;
                    break;
                }
                RelayMessage::EndOfStoredEvents(id) => {
                    assert_eq!(id, sub_id);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                other => anyhow::bail!("expected EVENT/EOSE, got {:?}", other),
            }
        }

        if !got_event {
            anyhow::bail!("event not available in time");
        }

        match recv_relay_message(&mut rx).await? {
            RelayMessage::EndOfStoredEvents(id) => assert_eq!(id, sub_id),
            other => anyhow::bail!("expected EOSE, got {:?}", other),
        }

        Ok(())
    }

    #[tokio::test]
    async fn relay_spambox_does_not_serve_untrusted_events() -> Result<()> {
        let tmp = TempDir::new()?;
        let ndb = {
            let _guard = crate::socialgraph::test_lock();
            crate::socialgraph::init_ndb_with_mapsize(tmp.path(), Some(128 * 1024 * 1024))?
        };

        crate::socialgraph::set_social_graph_root(&ndb, &[1u8; 32]);
        std::thread::sleep(std::time::Duration::from_millis(100));

        let access = Arc::new(crate::socialgraph::SocialGraphAccessControl::new(
            Arc::clone(&ndb),
            0,
            HashSet::new(),
        ));

        let mut relay_config = NostrRelayConfig::default();
        relay_config.spambox_db_max_bytes = 0;
        let relay = NostrRelay::new(
            Arc::clone(&ndb),
            tmp.path().to_path_buf(),
            Some(access),
            relay_config,
        )?;

        let (tx, mut rx) = mpsc::unbounded_channel();
        relay.register_client(2, tx, None).await;

        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, "spam", []).to_event(&keys)?;
        relay
            .handle_client_message(2, NostrClientMessage::event(event.clone()))
            .await;

        match recv_relay_message(&mut rx).await? {
            RelayMessage::Ok { status, .. } => assert!(status),
            other => anyhow::bail!("expected OK, got {:?}", other),
        }

        tokio::time::sleep(Duration::from_millis(50)).await;

        let sub_id = SubscriptionId::new("sub-2");
        let filter = Filter::new()
            .authors(vec![event.pubkey])
            .kinds(vec![event.kind]);
        relay
            .handle_client_message(2, NostrClientMessage::req(sub_id.clone(), vec![filter]))
            .await;

        match recv_relay_message(&mut rx).await? {
            RelayMessage::EndOfStoredEvents(id) => assert_eq!(id, sub_id),
            other => anyhow::bail!("expected EOSE only, got {:?}", other),
        }

        Ok(())
    }
}
