use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use hashtree_core::{Cid, Store};
use hashtree_nostr::{ListEventsOptions, NostrEventStore, NostrEventStoreError, StoredNostrEvent};
use nostr_sdk::{Client, EventId, Filter, Keys, Kind, NegentropyOptions, PublicKey, Timestamp};
use nostr_social_graph::SocialGraphBackend;

const NEGENTROPY_FETCH_CHUNK_SIZE: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayFetchMode {
    AuthorBatches,
    GlobalRecent,
}

#[derive(Debug, Clone)]
pub struct CrawlConfig {
    pub relays: Vec<String>,
    pub max_live_bytes: Option<u64>,
    pub max_authors: Option<usize>,
    pub max_follow_distance: Option<u32>,
    pub author_batch_size: usize,
    pub per_author_event_limit: usize,
    pub per_author_live_bytes: Option<u64>,
    pub fetch_timeout: Duration,
    pub kinds: Option<Vec<u16>>,
    pub relay_fetch_mode: RelayFetchMode,
    pub relay_page_size: usize,
    pub max_relay_pages: usize,
}

impl Default for CrawlConfig {
    fn default() -> Self {
        Self {
            relays: Vec::new(),
            max_live_bytes: None,
            max_authors: None,
            max_follow_distance: Some(1),
            author_batch_size: 64,
            per_author_event_limit: 256,
            per_author_live_bytes: None,
            fetch_timeout: Duration::from_secs(10),
            kinds: None,
            relay_fetch_mode: RelayFetchMode::AuthorBatches,
            relay_page_size: 1_000,
            max_relay_pages: 10,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CrawlReport {
    pub root: Option<Cid>,
    pub authors_considered: usize,
    pub events_seen: usize,
    pub events_selected: usize,
    pub live_bytes_selected: u64,
}

pub trait EventSelectionPolicy: Send + Sync {
    fn priority(&self, event: &StoredNostrEvent) -> i32;
}

#[derive(Debug, Clone)]
pub struct KindPriorityPolicy {
    default_priority: i32,
    priorities: BTreeMap<u32, i32>,
}

impl Default for KindPriorityPolicy {
    fn default() -> Self {
        let mut priorities = BTreeMap::new();
        priorities.insert(1, 1_000);
        priorities.insert(0, 900);
        priorities.insert(3, 800);
        priorities.insert(10_000, 750);
        priorities.insert(6, 600);
        priorities.insert(7, 500);
        Self {
            default_priority: 100,
            priorities,
        }
    }
}

impl KindPriorityPolicy {
    pub fn with_priority(mut self, kind: u32, priority: i32) -> Self {
        self.priorities.insert(kind, priority);
        self
    }
}

impl EventSelectionPolicy for KindPriorityPolicy {
    fn priority(&self, event: &StoredNostrEvent) -> i32 {
        self.priorities
            .get(&event.kind)
            .copied()
            .unwrap_or(self.default_priority)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CrawlError {
    #[error("event store error: {0}")]
    EventStore(#[from] NostrEventStoreError),
    #[error("crawl requires at least one relay")]
    MissingRelays,
    #[error("per-author event limit must be greater than zero")]
    InvalidPerAuthorLimit,
    #[error("per-author live byte cap must be greater than zero")]
    InvalidPerAuthorLiveBytes,
    #[error("author batch size must be greater than zero")]
    InvalidAuthorBatchSize,
    #[error("relay page size must be greater than zero")]
    InvalidRelayPageSize,
    #[error("max relay pages must be greater than zero")]
    InvalidMaxRelayPages,
    #[error("nostr error: {0}")]
    Nostr(String),
    #[error("social graph error: {0}")]
    SocialGraph(String),
}

pub type Result<T> = std::result::Result<T, CrawlError>;

#[derive(Debug, Default)]
struct FetchEventsResult {
    events_seen: usize,
    events: Vec<StoredNostrEvent>,
}

#[derive(Debug, Default)]
struct RelayFetchResult {
    events_seen: usize,
    events: Vec<StoredNostrEvent>,
    supports_negentropy: bool,
}

pub struct NostrBridge<S: Store> {
    event_store: NostrEventStore<S>,
    config: CrawlConfig,
    policy: Arc<dyn EventSelectionPolicy>,
}

impl<S: Store> NostrBridge<S> {
    pub fn new(store: Arc<S>, config: CrawlConfig) -> Self {
        Self {
            event_store: NostrEventStore::new(store),
            config,
            policy: Arc::new(KindPriorityPolicy::default()),
        }
    }

    pub fn with_policy(mut self, policy: Arc<dyn EventSelectionPolicy>) -> Self {
        self.policy = policy;
        self
    }

    pub async fn crawl<G: SocialGraphBackend>(
        &self,
        graph: &G,
        existing_root: Option<&Cid>,
    ) -> Result<CrawlReport> {
        self.validate_config()?;

        let authors = self.collect_authors(graph)?;
        if authors.is_empty() {
            return Ok(CrawlReport::default());
        }

        let client = self.connect_client().await?;
        let mut existing_by_author: BTreeMap<String, Vec<StoredNostrEvent>> = BTreeMap::new();
        for author in &authors {
            let retained = self
                .event_store
                .list_by_author(existing_root, author, ListEventsOptions::default())
                .await?
                .into_iter()
                .filter(|event| self.kind_allowed(event.kind))
                .collect::<Vec<_>>();
            existing_by_author.insert(author.clone(), retained);
        }

        let fetched = self
            .fetch_events(&client, &authors, &existing_by_author)
            .await?;
        let mut fetched_by_author: BTreeMap<String, Vec<StoredNostrEvent>> = BTreeMap::new();
        for event in fetched.events {
            fetched_by_author
                .entry(event.pubkey.clone())
                .or_default()
                .push(event);
        }

        let mut selected = Vec::new();
        for author in &authors {
            let mut merged: BTreeMap<String, StoredNostrEvent> = BTreeMap::new();
            if let Some(existing_events) = existing_by_author.remove(author) {
                for event in existing_events {
                    merged.insert(event.id.clone(), event);
                }
            }
            if let Some(events) = fetched_by_author.remove(author) {
                for event in events {
                    merged.insert(event.id.clone(), event);
                }
            }

            selected.extend(self.select_author_events(merged.into_values().collect())?);
        }

        let (selected, live_bytes_selected) = self.apply_live_byte_cap(selected)?;
        let root = self.event_store.build(None, selected.clone()).await?;
        Ok(CrawlReport {
            root,
            authors_considered: authors.len(),
            events_seen: fetched.events_seen,
            events_selected: selected.len(),
            live_bytes_selected,
        })
    }

    fn validate_config(&self) -> Result<()> {
        if self.config.relays.is_empty() {
            return Err(CrawlError::MissingRelays);
        }
        if self.config.per_author_event_limit == 0 {
            return Err(CrawlError::InvalidPerAuthorLimit);
        }
        if self.config.per_author_live_bytes == Some(0) {
            return Err(CrawlError::InvalidPerAuthorLiveBytes);
        }
        if self.config.author_batch_size == 0 {
            return Err(CrawlError::InvalidAuthorBatchSize);
        }
        if self.config.relay_page_size == 0 {
            return Err(CrawlError::InvalidRelayPageSize);
        }
        if self.config.max_relay_pages == 0 {
            return Err(CrawlError::InvalidMaxRelayPages);
        }
        Ok(())
    }

    fn collect_authors<G: SocialGraphBackend>(&self, graph: &G) -> Result<Vec<String>> {
        let root = graph
            .get_root()
            .map_err(|err| CrawlError::SocialGraph(err.to_string()))?;
        let mut visited = BTreeSet::new();
        let mut authors = Vec::new();
        let mut queue = VecDeque::from([(root.clone(), 0u32)]);
        visited.insert(root);

        while let Some((author, distance)) = queue.pop_front() {
            authors.push(author.clone());
            if self
                .config
                .max_authors
                .is_some_and(|max_authors| authors.len() >= max_authors)
            {
                break;
            }
            if self
                .config
                .max_follow_distance
                .is_some_and(|max_distance| distance >= max_distance)
            {
                continue;
            }

            let mut follows = graph
                .get_followed_by_user(&author)
                .map_err(|err| CrawlError::SocialGraph(err.to_string()))?;
            follows.sort();
            for followed in follows {
                if visited.insert(followed.clone()) {
                    queue.push_back((followed, distance.saturating_add(1)));
                }
            }
        }

        Ok(authors)
    }

    async fn connect_client(&self) -> Result<Client> {
        let client = Client::new(Keys::generate());
        for relay in &self.config.relays {
            client
                .add_relay(relay)
                .await
                .map_err(|err| CrawlError::Nostr(err.to_string()))?;
        }
        client.connect().await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        Ok(client)
    }

    async fn fetch_events(
        &self,
        client: &Client,
        authors: &[String],
        existing_by_author: &BTreeMap<String, Vec<StoredNostrEvent>>,
    ) -> Result<FetchEventsResult> {
        let mut known = BTreeMap::<String, StoredNostrEvent>::new();
        for events in existing_by_author.values() {
            for event in events {
                known.insert(event.id.clone(), event.clone());
            }
        }

        if self.config.relay_fetch_mode == RelayFetchMode::GlobalRecent {
            return self
                .fetch_events_global_recent(client, authors, known)
                .await;
        }

        let mut fetched = BTreeMap::<String, StoredNostrEvent>::new();
        let mut relay_negentropy_support = BTreeMap::<String, bool>::new();
        let mut events_seen = 0usize;
        for author_batch in authors.chunks(self.config.author_batch_size) {
            let pubkeys: Vec<PublicKey> = author_batch
                .iter()
                .filter_map(|author| author.parse::<PublicKey>().ok())
                .collect();
            if pubkeys.is_empty() {
                continue;
            }

            let filter = self.batch_filter(pubkeys);
            for relay in &self.config.relays {
                let local_items = self.local_items_for_batch(known.values(), author_batch);
                let relay_support = relay_negentropy_support.get(relay).copied();
                let fetched_from_relay = self
                    .fetch_events_from_relay(
                        client,
                        relay,
                        filter.clone(),
                        local_items,
                        relay_support,
                    )
                    .await?;
                relay_negentropy_support
                    .insert(relay.clone(), fetched_from_relay.supports_negentropy);
                events_seen = events_seen.saturating_add(fetched_from_relay.events_seen);
                for event in fetched_from_relay.events {
                    if self.kind_allowed(event.kind)
                        && known.insert(event.id.clone(), event.clone()).is_none()
                    {
                        fetched.insert(event.id.clone(), event);
                    }
                }
            }
        }
        Ok(FetchEventsResult {
            events_seen,
            events: fetched.into_values().collect(),
        })
    }

    async fn fetch_events_global_recent(
        &self,
        client: &Client,
        authors: &[String],
        mut known: BTreeMap<String, StoredNostrEvent>,
    ) -> Result<FetchEventsResult> {
        let authors = authors.iter().map(String::as_str).collect::<BTreeSet<_>>();
        let mut fetched = BTreeMap::<String, StoredNostrEvent>::new();
        let mut events_seen = 0usize;

        for relay in &self.config.relays {
            let mut until = None;
            for _ in 0..self.config.max_relay_pages {
                let filter = self.global_recent_filter(until);
                let events = client
                    .get_events_from([relay], vec![filter], Some(self.config.fetch_timeout))
                    .await
                    .map_err(|err| CrawlError::Nostr(err.to_string()))?;
                let fetched_count = events.len();
                events_seen = events_seen.saturating_add(fetched_count);
                if fetched_count == 0 {
                    break;
                }

                let mut min_created_at = u64::MAX;
                for event in events {
                    min_created_at = min_created_at.min(event.created_at.as_u64());
                    if event.kind.is_ephemeral() {
                        continue;
                    }

                    let stored = stored_event_from_nostr(&event);
                    if !authors.contains(stored.pubkey.as_str()) || !self.kind_allowed(stored.kind)
                    {
                        continue;
                    }

                    if known.insert(stored.id.clone(), stored.clone()).is_none() {
                        fetched.insert(stored.id.clone(), stored);
                    }
                }

                if min_created_at == u64::MAX || min_created_at == 0 {
                    break;
                }
                let next_until = min_created_at.saturating_sub(1);
                if until == Some(next_until) {
                    break;
                }
                until = Some(next_until);
            }
        }

        Ok(FetchEventsResult {
            events_seen,
            events: fetched.into_values().collect(),
        })
    }

    fn batch_filter(&self, pubkeys: Vec<PublicKey>) -> Filter {
        let mut filter = Filter::new().authors(pubkeys);
        if let Some(kinds) = &self.config.kinds {
            filter = filter.kinds(kinds.iter().copied().map(Kind::from));
        }
        let relay_limit = self
            .config
            .author_batch_size
            .saturating_mul(self.config.per_author_event_limit);
        if relay_limit > 0 {
            filter = filter.limit(relay_limit);
        }
        filter
    }

    fn global_recent_filter(&self, until: Option<u64>) -> Filter {
        let mut filter = Filter::new().limit(self.config.relay_page_size);
        if let Some(kinds) = &self.config.kinds {
            filter = filter.kinds(kinds.iter().copied().map(Kind::from));
        }
        if let Some(until) = until {
            filter = filter.until(Timestamp::from_secs(until));
        }
        filter
    }

    fn local_items_for_batch<'a, I>(
        &self,
        known_events: I,
        author_batch: &[String],
    ) -> Vec<(EventId, Timestamp)>
    where
        I: Iterator<Item = &'a StoredNostrEvent>,
    {
        let authors = author_batch
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();

        known_events
            .filter(|event| {
                authors.contains(event.pubkey.as_str()) && self.kind_allowed(event.kind)
            })
            .filter_map(|event| {
                let event_id = EventId::parse(&event.id).ok()?;
                Some((event_id, Timestamp::from_secs(event.created_at)))
            })
            .collect()
    }

    async fn fetch_events_from_relay(
        &self,
        client: &Client,
        relay: &str,
        filter: Filter,
        local_items: Vec<(EventId, Timestamp)>,
        supports_negentropy: Option<bool>,
    ) -> Result<RelayFetchResult> {
        if supports_negentropy == Some(false) {
            return self
                .fetch_full_filter(client, relay, filter)
                .await
                .map(|events| RelayFetchResult {
                    events_seen: events.len(),
                    events,
                    supports_negentropy: false,
                });
        }

        match client
            .reconcile_advanced(
                [relay],
                filter.clone(),
                local_items,
                NegentropyOptions::default().dry_run(),
            )
            .await
        {
            Ok(output) if !output.success.is_empty() => {
                let missing = output.remote.iter().cloned().collect::<Vec<_>>();
                self.fetch_missing_ids(client, relay, missing).await.map(
                    |RelayFetchResult {
                         events_seen,
                         events,
                         ..
                     }| RelayFetchResult {
                        events_seen,
                        events,
                        supports_negentropy: true,
                    },
                )
            }
            Ok(_) | Err(_) => self
                .fetch_full_filter(client, relay, filter)
                .await
                .map(|events| RelayFetchResult {
                    events_seen: events.len(),
                    events,
                    supports_negentropy: false,
                }),
        }
    }

    async fn fetch_missing_ids(
        &self,
        client: &Client,
        relay: &str,
        missing_ids: Vec<EventId>,
    ) -> Result<RelayFetchResult> {
        if missing_ids.is_empty() {
            return Ok(RelayFetchResult {
                events_seen: 0,
                events: Vec::new(),
                supports_negentropy: true,
            });
        }

        let mut out = BTreeMap::<String, StoredNostrEvent>::new();
        let mut events_seen = 0usize;
        for chunk in missing_ids.chunks(NEGENTROPY_FETCH_CHUNK_SIZE) {
            let filter = Filter::new().ids(chunk.iter().cloned());
            let events = client
                .get_events_from([relay], vec![filter], Some(self.config.fetch_timeout))
                .await
                .map_err(|err| CrawlError::Nostr(err.to_string()))?;
            events_seen = events_seen.saturating_add(events.len());
            for event in events {
                if event.kind.is_ephemeral() {
                    continue;
                }
                let stored = stored_event_from_nostr(&event);
                out.insert(stored.id.clone(), stored);
            }
        }
        Ok(RelayFetchResult {
            events_seen,
            events: out.into_values().collect(),
            supports_negentropy: true,
        })
    }

    async fn fetch_full_filter(
        &self,
        client: &Client,
        relay: &str,
        filter: Filter,
    ) -> Result<Vec<StoredNostrEvent>> {
        let mut out = Vec::new();
        let events = client
            .get_events_from([relay], vec![filter], Some(self.config.fetch_timeout))
            .await
            .map_err(|err| CrawlError::Nostr(err.to_string()))?;

        for event in events {
            if event.kind.is_ephemeral() {
                continue;
            }
            out.push(stored_event_from_nostr(&event));
        }

        Ok(out)
    }

    fn select_author_events(
        &self,
        mut events: Vec<StoredNostrEvent>,
    ) -> Result<Vec<StoredNostrEvent>> {
        events.sort_by(|left, right| {
            self.policy
                .priority(right)
                .cmp(&self.policy.priority(left))
                .then_with(|| right.created_at.cmp(&left.created_at))
                .then_with(|| left.id.cmp(&right.id))
        });

        if let Some(max_live_bytes) = self.config.per_author_live_bytes {
            let mut selected = Vec::new();
            let mut live_bytes_selected = 0u64;
            for event in events {
                let encoded_len = self.event_store.encode_event(&event)?.len() as u64;
                if live_bytes_selected.saturating_add(encoded_len) > max_live_bytes {
                    continue;
                }
                live_bytes_selected = live_bytes_selected.saturating_add(encoded_len);
                selected.push(event);
            }
            selected.truncate(self.config.per_author_event_limit);
            return Ok(selected);
        }

        events.truncate(self.config.per_author_event_limit);
        Ok(events)
    }

    fn apply_live_byte_cap(
        &self,
        mut events: Vec<StoredNostrEvent>,
    ) -> Result<(Vec<StoredNostrEvent>, u64)> {
        events.sort_by(|left, right| {
            self.policy
                .priority(right)
                .cmp(&self.policy.priority(left))
                .then_with(|| right.created_at.cmp(&left.created_at))
                .then_with(|| left.id.cmp(&right.id))
        });

        let Some(max_live_bytes) = self.config.max_live_bytes else {
            let live_bytes_selected = events.iter().try_fold(0u64, |total, event| {
                let encoded = self.event_store.encode_event(event)?;
                Ok::<u64, NostrEventStoreError>(total.saturating_add(encoded.len() as u64))
            })?;
            return Ok((events, live_bytes_selected));
        };

        let mut selected = Vec::new();
        let mut live_bytes_selected = 0u64;
        for event in events {
            let encoded_len = self.event_store.encode_event(&event)?.len() as u64;
            if live_bytes_selected.saturating_add(encoded_len) > max_live_bytes {
                continue;
            }
            live_bytes_selected = live_bytes_selected.saturating_add(encoded_len);
            selected.push(event);
        }

        Ok((selected, live_bytes_selected))
    }

    fn kind_allowed(&self, kind: u32) -> bool {
        self.config.kinds.as_ref().is_none_or(|allowed| {
            allowed
                .iter()
                .any(|candidate| u32::from(*candidate) == kind)
        })
    }
}

fn stored_event_from_nostr(event: &nostr_sdk::Event) -> StoredNostrEvent {
    StoredNostrEvent {
        id: event.id.to_hex(),
        pubkey: event.pubkey.to_hex(),
        created_at: event.created_at.as_u64(),
        kind: event.kind.as_u16() as u32,
        tags: event
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect(),
        content: event.content.clone(),
        sig: event.sig.to_string(),
    }
}
