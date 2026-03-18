use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use hashtree_core::{Cid, Store};
use hashtree_nostr::{ListEventsOptions, NostrEventStore, NostrEventStoreError, StoredNostrEvent};
use nostr_sdk::{Client, EventSource, Filter, Keys, Kind, PublicKey};
use nostr_social_graph::SocialGraphBackend;

#[derive(Debug, Clone)]
pub struct CrawlConfig {
    pub relays: Vec<String>,
    pub max_follow_distance: Option<u32>,
    pub author_batch_size: usize,
    pub per_author_event_limit: usize,
    pub fetch_timeout: Duration,
    pub kinds: Option<Vec<u16>>,
}

impl Default for CrawlConfig {
    fn default() -> Self {
        Self {
            relays: Vec::new(),
            max_follow_distance: Some(1),
            author_batch_size: 64,
            per_author_event_limit: 256,
            fetch_timeout: Duration::from_secs(10),
            kinds: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CrawlReport {
    pub root: Option<Cid>,
    pub authors_considered: usize,
    pub events_seen: usize,
    pub events_selected: usize,
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
    #[error("author batch size must be greater than zero")]
    InvalidAuthorBatchSize,
    #[error("nostr error: {0}")]
    Nostr(String),
    #[error("social graph error: {0}")]
    SocialGraph(String),
}

pub type Result<T> = std::result::Result<T, CrawlError>;

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
        let fetched_events = self.fetch_events(&client, &authors).await?;
        let events_seen = fetched_events.len();
        let mut fetched_by_author: BTreeMap<String, Vec<StoredNostrEvent>> = BTreeMap::new();
        for event in fetched_events {
            fetched_by_author
                .entry(event.pubkey.clone())
                .or_default()
                .push(event);
        }

        let mut selected = Vec::new();
        for author in &authors {
            let mut merged: BTreeMap<String, StoredNostrEvent> = BTreeMap::new();
            for event in self
                .event_store
                .list_by_author(existing_root, author, ListEventsOptions::default())
                .await?
            {
                if self.kind_allowed(event.kind) {
                    merged.insert(event.id.clone(), event);
                }
            }
            if let Some(events) = fetched_by_author.remove(author) {
                for event in events {
                    if self.kind_allowed(event.kind) {
                        merged.insert(event.id.clone(), event);
                    }
                }
            }

            selected.extend(self.select_author_events(merged.into_values().collect()));
        }

        let root = self.event_store.build(None, selected.clone()).await?;
        Ok(CrawlReport {
            root,
            authors_considered: authors.len(),
            events_seen,
            events_selected: selected.len(),
        })
    }

    fn validate_config(&self) -> Result<()> {
        if self.config.relays.is_empty() {
            return Err(CrawlError::MissingRelays);
        }
        if self.config.per_author_event_limit == 0 {
            return Err(CrawlError::InvalidPerAuthorLimit);
        }
        if self.config.author_batch_size == 0 {
            return Err(CrawlError::InvalidAuthorBatchSize);
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
    ) -> Result<Vec<StoredNostrEvent>> {
        let mut out = Vec::new();
        for author_batch in authors.chunks(self.config.author_batch_size) {
            let pubkeys: Vec<PublicKey> = author_batch
                .iter()
                .filter_map(|author| author.parse::<PublicKey>().ok())
                .collect();
            if pubkeys.is_empty() {
                continue;
            }

            let mut filter = Filter::new().authors(pubkeys);
            if let Some(kinds) = &self.config.kinds {
                filter = filter.kinds(kinds.iter().copied().map(Kind::from));
            }

            let events = client
                .get_events_of(
                    vec![filter],
                    EventSource::relays(Some(self.config.fetch_timeout)),
                )
                .await
                .map_err(|err| CrawlError::Nostr(err.to_string()))?;

            for event in events {
                if event.kind.is_ephemeral() {
                    continue;
                }
                out.push(stored_event_from_nostr(&event));
            }
        }
        Ok(out)
    }

    fn select_author_events(&self, mut events: Vec<StoredNostrEvent>) -> Vec<StoredNostrEvent> {
        events.sort_by(|left, right| {
            self.policy
                .priority(right)
                .cmp(&self.policy.priority(left))
                .then_with(|| right.created_at.cmp(&left.created_at))
                .then_with(|| left.id.cmp(&right.id))
        });
        events.truncate(self.config.per_author_event_limit);
        events
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
