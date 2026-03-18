use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use super::SocialGraphBackend;

const DEFAULT_AUTHOR_BATCH_SIZE: usize = 500;
const GRAPH_FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const RELAY_SOURCE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct SocialGraphCrawler {
    ndb: Arc<dyn SocialGraphBackend>,
    spambox: Option<Arc<dyn SocialGraphBackend>>,
    keys: nostr::Keys,
    relays: Vec<String>,
    max_depth: u32,
    author_batch_size: usize,
    full_recrawl: bool,
}

impl SocialGraphCrawler {
    pub fn new(
        ndb: Arc<dyn SocialGraphBackend>,
        keys: nostr::Keys,
        relays: Vec<String>,
        max_depth: u32,
    ) -> Self {
        Self {
            ndb,
            spambox: None,
            keys,
            relays,
            max_depth,
            author_batch_size: DEFAULT_AUTHOR_BATCH_SIZE,
            full_recrawl: false,
        }
    }

    pub fn with_spambox(mut self, spambox: Arc<dyn SocialGraphBackend>) -> Self {
        self.spambox = Some(spambox);
        self
    }

    pub fn with_author_batch_size(mut self, author_batch_size: usize) -> Self {
        self.author_batch_size = author_batch_size.max(1);
        self
    }

    pub fn with_full_recrawl(mut self, full_recrawl: bool) -> Self {
        self.full_recrawl = full_recrawl;
        self
    }

    fn is_within_social_graph(&self, pk_bytes: &[u8; 32]) -> bool {
        if pk_bytes == &self.keys.public_key().to_bytes() {
            return true;
        }

        super::get_follow_distance(self.ndb.as_ref(), pk_bytes)
            .map(|distance| distance <= self.max_depth)
            .unwrap_or(false)
    }

    fn ingest_event_into(&self, ndb: &(impl SocialGraphBackend + ?Sized), event: &nostr::Event) {
        if let Err(err) = super::ingest_parsed_event(ndb, event) {
            tracing::debug!("Failed to ingest crawler event: {}", err);
        }
    }

    #[allow(deprecated)]
    fn collect_missing_root_follows(
        &self,
        event: &nostr::Event,
        fetched_contact_lists: &mut HashSet<[u8; 32]>,
    ) -> Vec<[u8; 32]> {
        if self.max_depth < 2 || event.kind != nostr::Kind::ContactList {
            return Vec::new();
        }

        let root_pk = self.keys.public_key().to_bytes();
        if event.pubkey.to_bytes() != root_pk {
            return Vec::new();
        }

        let mut missing = Vec::new();
        for tag in event.tags.iter() {
            if let Some(nostr::TagStandard::PublicKey { public_key, .. }) = tag.as_standardized() {
                let pk_bytes = public_key.to_bytes();
                if fetched_contact_lists.contains(&pk_bytes) {
                    continue;
                }

                let existing_follows = super::get_follows(self.ndb.as_ref(), &pk_bytes);
                if !existing_follows.is_empty() {
                    fetched_contact_lists.insert(pk_bytes);
                    continue;
                }

                fetched_contact_lists.insert(pk_bytes);
                missing.push(pk_bytes);
            }
        }

        missing
    }

    fn graph_filter_for_pubkeys(pubkeys: &[[u8; 32]]) -> Option<nostr::Filter> {
        let authors = pubkeys
            .iter()
            .filter_map(|pk_bytes| nostr::PublicKey::from_slice(pk_bytes).ok())
            .collect::<Vec<_>>();
        if authors.is_empty() {
            return None;
        }

        Some(
            nostr::Filter::new()
                .authors(authors)
                .kinds(vec![nostr::Kind::ContactList, nostr::Kind::MuteList]),
        )
    }

    async fn fetch_graph_events_for_pubkeys(
        &self,
        client: &nostr_sdk::Client,
        pubkeys: &[[u8; 32]],
    ) -> Vec<nostr::Event> {
        let Some(filter) = Self::graph_filter_for_pubkeys(pubkeys) else {
            return Vec::new();
        };

        let source = nostr_sdk::EventSource::relays(Some(RELAY_SOURCE_TIMEOUT));
        match tokio::time::timeout(
            GRAPH_FETCH_TIMEOUT,
            client.get_events_of(vec![filter], source),
        )
        .await
        {
            Ok(Ok(events)) => events,
            Ok(Err(err)) => {
                tracing::debug!(
                    "Failed to fetch graph events for {} authors: {}",
                    pubkeys.len(),
                    err
                );
                Vec::new()
            }
            Err(_) => {
                tracing::debug!(
                    "Timeout fetching graph events for {} authors",
                    pubkeys.len()
                );
                Vec::new()
            }
        }
    }

    async fn fetch_contact_lists_for_pubkeys(
        &self,
        client: &nostr_sdk::Client,
        pubkeys: &[[u8; 32]],
        shutdown_rx: &watch::Receiver<bool>,
    ) {
        for chunk in pubkeys.chunks(self.author_batch_size) {
            if *shutdown_rx.borrow() {
                break;
            }

            let events = self.fetch_graph_events_for_pubkeys(client, chunk).await;
            for event in &events {
                self.ingest_event_into(self.ndb.as_ref(), event);
            }
        }
    }

    fn authors_to_fetch_at_distance(&self, distance: u32) -> Vec<[u8; 32]> {
        let Ok(users) = self.ndb.users_by_follow_distance(distance) else {
            return Vec::new();
        };
        if self.full_recrawl {
            return users;
        }

        users
            .into_iter()
            .filter(|pk_bytes| {
                self.ndb
                    .follow_list_created_at(pk_bytes)
                    .ok()
                    .flatten()
                    .is_none()
            })
            .collect()
    }

    pub(crate) fn handle_incoming_event(&self, event: &nostr::Event) {
        let is_contact_list = event.kind == nostr::Kind::ContactList;
        let is_mute_list = event.kind == nostr::Kind::MuteList;
        if !is_contact_list && !is_mute_list {
            return;
        }

        let pk_bytes = event.pubkey.to_bytes();
        if self.is_within_social_graph(&pk_bytes) {
            self.ingest_event_into(self.ndb.as_ref(), event);
            return;
        }

        if let Some(spambox) = &self.spambox {
            self.ingest_event_into(spambox.as_ref(), event);
        }
    }

    #[allow(deprecated)]
    pub async fn crawl(&self, shutdown_rx: watch::Receiver<bool>) {
        use nostr::nips::nip19::ToBech32;
        use nostr_sdk::prelude::RelayPoolNotification;

        if self.relays.is_empty() {
            tracing::warn!("Social graph crawler: no relays configured, skipping");
            return;
        }

        let mut shutdown_rx = shutdown_rx;
        if *shutdown_rx.borrow() {
            return;
        }

        let Ok(sdk_keys) =
            nostr_sdk::Keys::parse(self.keys.secret_key().to_bech32().unwrap_or_default())
        else {
            return;
        };

        let client = nostr_sdk::Client::new(&sdk_keys);
        for relay in &self.relays {
            if let Err(err) = client.add_relay(relay).await {
                tracing::warn!("Failed to add relay {}: {}", relay, err);
            }
        }
        client.connect().await;

        let mut fetched_contact_lists: HashSet<[u8; 32]> = HashSet::new();

        for distance in 0..self.max_depth {
            if *shutdown_rx.borrow() {
                break;
            }

            let authors = self.authors_to_fetch_at_distance(distance);
            if authors.is_empty() {
                continue;
            }

            for author_chunk in authors.chunks(self.author_batch_size) {
                if *shutdown_rx.borrow() {
                    break;
                }

                for pk_bytes in author_chunk {
                    fetched_contact_lists.insert(*pk_bytes);
                }

                let events = self
                    .fetch_graph_events_for_pubkeys(&client, author_chunk)
                    .await;
                for event in &events {
                    self.ingest_event_into(self.ndb.as_ref(), event);
                }
            }
        }

        let filter = nostr::Filter::new()
            .kinds(vec![nostr::Kind::ContactList, nostr::Kind::MuteList])
            .since(nostr::Timestamp::now());

        let _ = client.subscribe(vec![filter], None).await;

        let mut notifications = client.notifications();
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
                notification = notifications.recv() => {
                    match notification {
                        Ok(RelayPoolNotification::Event { event, .. }) => {
                            self.handle_incoming_event(&event);
                            let missing = self.collect_missing_root_follows(&event, &mut fetched_contact_lists);
                            if !missing.is_empty() {
                                self.fetch_contact_lists_for_pubkeys(&client, &missing, &shutdown_rx).await;
                            }
                        }
                        Ok(_) => {}
                        Err(err) => {
                            tracing::warn!("Social graph crawler notification error: {}", err);
                            break;
                        }
                    }
                }
            }
        }

        let _ = client.disconnect().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Mutex;
    use std::time::Instant;

    use futures::{SinkExt, StreamExt};
    use nostr::{EventBuilder, JsonUtil, Kind, PublicKey, Tag};
    use tempfile::TempDir;
    use tokio::net::TcpStream;
    use tokio::sync::broadcast;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    #[derive(Debug, Default)]
    struct RelayState {
        events: Vec<nostr::Event>,
        request_author_counts: Vec<usize>,
    }

    struct TestRelay {
        port: u16,
        shutdown: broadcast::Sender<()>,
        state: Arc<Mutex<RelayState>>,
    }

    impl TestRelay {
        fn new(events: Vec<nostr::Event>) -> Self {
            let state = Arc::new(Mutex::new(RelayState {
                events,
                request_author_counts: Vec::new(),
            }));
            let (shutdown, _) = broadcast::channel(1);

            let std_listener = TcpListener::bind("127.0.0.1:0").expect("bind relay listener");
            let port = std_listener.local_addr().expect("local addr").port();
            std_listener
                .set_nonblocking(true)
                .expect("set listener nonblocking");

            let state_for_thread = Arc::clone(&state);
            let shutdown_for_thread = shutdown.clone();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .expect("build tokio runtime");
                runtime.block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(std_listener)
                        .expect("tokio listener from std");
                    let mut shutdown_rx = shutdown_for_thread.subscribe();

                    loop {
                        tokio::select! {
                            _ = shutdown_rx.recv() => break,
                            accept = listener.accept() => {
                                if let Ok((stream, _)) = accept {
                                    let state = Arc::clone(&state_for_thread);
                                    tokio::spawn(async move {
                                        handle_connection(stream, state).await;
                                    });
                                }
                            }
                        }
                    }
                });
            });

            std::thread::sleep(Duration::from_millis(100));

            Self {
                port,
                shutdown,
                state,
            }
        }

        fn url(&self) -> String {
            format!("ws://127.0.0.1:{}", self.port)
        }

        fn request_author_counts(&self) -> Vec<usize> {
            self.state
                .lock()
                .expect("relay state lock")
                .request_author_counts
                .clone()
        }
    }

    impl Drop for TestRelay {
        fn drop(&mut self) {
            let _ = self.shutdown.send(());
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn matching_events(
        state: &Arc<Mutex<RelayState>>,
        filters: &[nostr::Filter],
    ) -> Vec<nostr::Event> {
        let guard = state.lock().expect("relay state lock");
        guard
            .events
            .iter()
            .filter(|event| {
                filters.is_empty() || filters.iter().any(|filter| filter.match_event(event))
            })
            .cloned()
            .collect()
    }

    async fn send_relay_message(
        write: &mut futures::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<TcpStream>,
            Message,
        >,
        message: nostr::RelayMessage,
    ) {
        let _ = write.send(Message::Text(message.as_json())).await;
    }

    async fn handle_connection(stream: TcpStream, state: Arc<Mutex<RelayState>>) {
        let ws_stream = match accept_async(stream).await {
            Ok(ws) => ws,
            Err(_) => return,
        };
        let (mut write, mut read) = ws_stream.split();

        while let Some(message) = read.next().await {
            let text = match message {
                Ok(Message::Text(text)) => text,
                Ok(Message::Ping(data)) => {
                    let _ = write.send(Message::Pong(data)).await;
                    continue;
                }
                Ok(Message::Close(_)) => break,
                _ => continue,
            };

            let parsed = match nostr::ClientMessage::from_json(text.as_bytes()) {
                Ok(message) => message,
                Err(_) => continue,
            };

            match parsed {
                nostr::ClientMessage::Req {
                    subscription_id,
                    filters,
                } => {
                    let author_count = filters
                        .iter()
                        .filter_map(|filter| filter.authors.as_ref())
                        .map(|authors| authors.len())
                        .sum();
                    state
                        .lock()
                        .expect("relay state lock")
                        .request_author_counts
                        .push(author_count);

                    for event in matching_events(&state, &filters) {
                        send_relay_message(
                            &mut write,
                            nostr::RelayMessage::event(subscription_id.clone(), event),
                        )
                        .await;
                    }
                    send_relay_message(&mut write, nostr::RelayMessage::eose(subscription_id))
                        .await;
                }
                nostr::ClientMessage::Close(subscription_id) => {
                    send_relay_message(
                        &mut write,
                        nostr::RelayMessage::closed(subscription_id, ""),
                    )
                    .await;
                }
                _ => {}
            }
        }
    }

    async fn wait_until<F>(timeout: Duration, mut condition: F)
    where
        F: FnMut() -> bool,
    {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("condition not met within {:?}", timeout);
    }

    #[tokio::test]
    async fn test_crawler_routes_untrusted_to_spambox() {
        let _guard = crate::socialgraph::test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = crate::socialgraph::init_ndb(tmp.path()).unwrap();
        let spambox =
            crate::socialgraph::init_ndb_at_path(&tmp.path().join("spambox"), None).unwrap();

        let root_keys = nostr::Keys::generate();
        let root_pk = root_keys.public_key().to_bytes();
        crate::socialgraph::set_social_graph_root(&ndb, &root_pk);
        let backend: Arc<dyn crate::socialgraph::SocialGraphBackend> = ndb.clone();
        let spambox_backend: Arc<dyn crate::socialgraph::SocialGraphBackend> = spambox.clone();

        let crawler = SocialGraphCrawler::new(backend, root_keys.clone(), vec![], 2)
            .with_spambox(spambox_backend);

        let unknown_keys = nostr::Keys::generate();
        let follow_tag = Tag::public_key(PublicKey::from_slice(&root_pk).unwrap());
        let event = EventBuilder::new(Kind::ContactList, "", vec![follow_tag])
            .to_event(&unknown_keys)
            .unwrap();

        crawler.handle_incoming_event(&event);

        let unknown_pk = unknown_keys.public_key().to_bytes();
        assert!(crate::socialgraph::get_follows(&ndb, &unknown_pk).is_empty());
        assert_eq!(
            crate::socialgraph::get_follows(&spambox, &unknown_pk),
            vec![root_pk]
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_crawler_batches_graph_fetches_by_author_chunk() {
        let _guard = crate::socialgraph::test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = crate::socialgraph::init_ndb(tmp.path()).unwrap();

        let root_keys = nostr::Keys::generate();
        let root_pk = root_keys.public_key().to_bytes();
        crate::socialgraph::set_social_graph_root(&ndb, &root_pk);
        let backend: Arc<dyn crate::socialgraph::SocialGraphBackend> = ndb.clone();

        let alice_keys = nostr::Keys::generate();
        let bob_keys = nostr::Keys::generate();
        let carol_keys = nostr::Keys::generate();

        let root_event = EventBuilder::new(
            Kind::ContactList,
            "",
            vec![
                Tag::public_key(alice_keys.public_key()),
                Tag::public_key(bob_keys.public_key()),
            ],
        )
        .custom_created_at(nostr::Timestamp::from(10))
        .to_event(&root_keys)
        .unwrap();
        let alice_event = EventBuilder::new(
            Kind::ContactList,
            "",
            vec![Tag::public_key(carol_keys.public_key())],
        )
        .custom_created_at(nostr::Timestamp::from(11))
        .to_event(&alice_keys)
        .unwrap();
        let bob_event = EventBuilder::new(Kind::ContactList, "", vec![])
            .custom_created_at(nostr::Timestamp::from(12))
            .to_event(&bob_keys)
            .unwrap();

        let relay = TestRelay::new(vec![root_event, alice_event, bob_event]);
        let crawler = SocialGraphCrawler::new(backend, root_keys.clone(), vec![relay.url()], 2)
            .with_author_batch_size(2);

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let handle = tokio::spawn(async move {
            crawler.crawl(shutdown_rx).await;
        });

        let alice_pk = alice_keys.public_key().to_bytes();
        let bob_pk = bob_keys.public_key().to_bytes();
        let carol_pk = carol_keys.public_key().to_bytes();
        wait_until(Duration::from_secs(5), || {
            let root_follows = crate::socialgraph::get_follows(&ndb, &root_pk);
            let alice_follows = crate::socialgraph::get_follows(&ndb, &alice_pk);
            root_follows.contains(&alice_pk)
                && root_follows.contains(&bob_pk)
                && alice_follows.contains(&carol_pk)
        })
        .await;

        let _ = shutdown_tx.send(true);
        handle.await.unwrap();

        let author_counts = relay.request_author_counts();
        assert!(
            author_counts.iter().any(|count| *count >= 2),
            "expected batched author REQ, got {:?}",
            author_counts
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_crawler_expands_from_existing_graph_without_root_refetch() {
        let _guard = crate::socialgraph::test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = crate::socialgraph::init_ndb(tmp.path()).unwrap();

        let root_keys = nostr::Keys::generate();
        let root_pk = root_keys.public_key().to_bytes();
        crate::socialgraph::set_social_graph_root(&ndb, &root_pk);
        let backend: Arc<dyn crate::socialgraph::SocialGraphBackend> = ndb.clone();

        let alice_keys = nostr::Keys::generate();
        let bob_keys = nostr::Keys::generate();
        let carol_keys = nostr::Keys::generate();

        let root_event = EventBuilder::new(
            Kind::ContactList,
            "",
            vec![
                Tag::public_key(alice_keys.public_key()),
                Tag::public_key(bob_keys.public_key()),
            ],
        )
        .custom_created_at(nostr::Timestamp::from(10))
        .to_event(&root_keys)
        .unwrap();
        crate::socialgraph::ingest_parsed_event(&ndb, &root_event).unwrap();

        let alice_event = EventBuilder::new(
            Kind::ContactList,
            "",
            vec![Tag::public_key(carol_keys.public_key())],
        )
        .custom_created_at(nostr::Timestamp::from(11))
        .to_event(&alice_keys)
        .unwrap();
        let bob_event = EventBuilder::new(Kind::ContactList, "", vec![])
            .custom_created_at(nostr::Timestamp::from(12))
            .to_event(&bob_keys)
            .unwrap();

        let relay = TestRelay::new(vec![alice_event, bob_event]);
        let crawler = SocialGraphCrawler::new(backend, root_keys.clone(), vec![relay.url()], 2)
            .with_author_batch_size(2);

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let handle = tokio::spawn(async move {
            crawler.crawl(shutdown_rx).await;
        });

        let alice_pk = alice_keys.public_key().to_bytes();
        let carol_pk = carol_keys.public_key().to_bytes();
        wait_until(Duration::from_secs(5), || {
            crate::socialgraph::get_follows(&ndb, &alice_pk).contains(&carol_pk)
        })
        .await;

        let _ = shutdown_tx.send(true);
        handle.await.unwrap();

        let author_counts = relay.request_author_counts();
        assert!(
            !author_counts.contains(&1),
            "expected incremental crawl to skip root refetch, got {:?}",
            author_counts
        );
        assert!(
            author_counts.iter().any(|count| *count >= 2),
            "expected batched distance-1 REQ, got {:?}",
            author_counts
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_crawler_full_recrawl_refetches_root() {
        let _guard = crate::socialgraph::test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = crate::socialgraph::init_ndb(tmp.path()).unwrap();

        let root_keys = nostr::Keys::generate();
        let root_pk = root_keys.public_key().to_bytes();
        crate::socialgraph::set_social_graph_root(&ndb, &root_pk);
        let backend: Arc<dyn crate::socialgraph::SocialGraphBackend> = ndb.clone();

        let alice_keys = nostr::Keys::generate();
        let bob_keys = nostr::Keys::generate();

        let root_event = EventBuilder::new(
            Kind::ContactList,
            "",
            vec![
                Tag::public_key(alice_keys.public_key()),
                Tag::public_key(bob_keys.public_key()),
            ],
        )
        .custom_created_at(nostr::Timestamp::from(10))
        .to_event(&root_keys)
        .unwrap();
        crate::socialgraph::ingest_parsed_event(&ndb, &root_event).unwrap();

        let relay = TestRelay::new(vec![root_event]);
        let crawler = SocialGraphCrawler::new(backend, root_keys.clone(), vec![relay.url()], 1)
            .with_full_recrawl(true);

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let handle = tokio::spawn(async move {
            crawler.crawl(shutdown_rx).await;
        });

        wait_until(Duration::from_secs(5), || {
            relay.request_author_counts().contains(&1)
        })
        .await;

        let _ = shutdown_tx.send(true);
        handle.await.unwrap();

        let author_counts = relay.request_author_counts();
        assert!(
            author_counts.contains(&1),
            "expected full recrawl to refetch root, got {:?}",
            author_counts
        );
    }
}
