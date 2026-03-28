pub mod access;
pub mod crawler;
pub mod local_lists;
pub mod snapshot;

pub use access::SocialGraphAccessControl;
pub use crawler::SocialGraphCrawler;
pub use local_lists::{
    read_local_list_file_state, sync_local_list_files_force, sync_local_list_files_if_changed,
    LocalListFileState, LocalListSyncOutcome,
};

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Context, Result};
use bytes::Bytes;
use futures::executor::block_on;
use hashtree_core::Cid;
use hashtree_nostr::{ListEventsOptions, NostrEventStore, NostrEventStoreError, StoredNostrEvent};
use nostr::{Event, Filter, JsonUtil, Kind, SingleLetterTag};
use nostr_social_graph::{
    BinaryBudget, GraphStats, NostrEvent as GraphEvent, SocialGraph,
    SocialGraphBackend as NostrSocialGraphBackend,
};
use nostr_social_graph_heed::HeedSocialGraph;

use crate::storage::{LocalStore, StorageRouter};

#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};
#[cfg(test)]
use std::time::Instant;

pub type UserSet = BTreeSet<[u8; 32]>;

const DEFAULT_ROOT_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const EVENTS_ROOT_FILE: &str = "events-root.msgpack";
const AMBIENT_EVENTS_ROOT_FILE: &str = "events-root-ambient.msgpack";
const AMBIENT_EVENTS_BLOB_DIR: &str = "ambient-blobs";
const UNKNOWN_FOLLOW_DISTANCE: u32 = 1000;
const DEFAULT_SOCIALGRAPH_MAP_SIZE_BYTES: u64 = 64 * 1024 * 1024;
const SOCIALGRAPH_MAX_DBS: u32 = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventStorageClass {
    Public,
    Ambient,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EventQueryScope {
    PublicOnly,
    AmbientOnly,
    All,
}

struct EventIndexBucket {
    event_store: NostrEventStore<StorageRouter>,
    root_path: PathBuf,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredCid {
    hash: [u8; 32],
    key: Option<[u8; 32]>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SocialGraphStats {
    pub total_users: usize,
    pub root: Option<String>,
    pub total_follows: usize,
    pub max_depth: u32,
    pub size_by_distance: BTreeMap<u32, usize>,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
struct DistanceCache {
    stats: SocialGraphStats,
    users_by_distance: BTreeMap<u32, Vec<[u8; 32]>>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct UpstreamGraphBackendError(String);

pub struct SocialGraphStore {
    graph: StdMutex<HeedSocialGraph>,
    distance_cache: StdMutex<Option<DistanceCache>>,
    public_events: EventIndexBucket,
    ambient_events: EventIndexBucket,
}

pub trait SocialGraphBackend: Send + Sync {
    fn stats(&self) -> Result<SocialGraphStats>;
    fn users_by_follow_distance(&self, distance: u32) -> Result<Vec<[u8; 32]>>;
    fn follow_distance(&self, pk_bytes: &[u8; 32]) -> Result<Option<u32>>;
    fn follow_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>>;
    fn followed_targets(&self, owner: &[u8; 32]) -> Result<UserSet>;
    fn is_overmuted_user(&self, user_pk: &[u8; 32], threshold: f64) -> Result<bool>;
    fn snapshot_chunks(&self, root: &[u8; 32], options: &BinaryBudget) -> Result<Vec<Bytes>>;
    fn ingest_event(&self, event: &Event) -> Result<()>;
    fn ingest_event_with_storage_class(
        &self,
        event: &Event,
        storage_class: EventStorageClass,
    ) -> Result<()> {
        let _ = storage_class;
        self.ingest_event(event)
    }
    fn ingest_events(&self, events: &[Event]) -> Result<()> {
        for event in events {
            self.ingest_event(event)?;
        }
        Ok(())
    }
    fn ingest_events_with_storage_class(
        &self,
        events: &[Event],
        storage_class: EventStorageClass,
    ) -> Result<()> {
        for event in events {
            self.ingest_event_with_storage_class(event, storage_class)?;
        }
        Ok(())
    }
    fn ingest_graph_events(&self, events: &[Event]) -> Result<()> {
        self.ingest_events(events)
    }
    fn query_events(&self, filter: &Filter, limit: usize) -> Result<Vec<Event>>;
}

#[cfg(test)]
pub type TestLockGuard = MutexGuard<'static, ()>;

#[cfg(test)]
static NDB_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(test)]
pub fn test_lock() -> TestLockGuard {
    NDB_TEST_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

pub fn open_social_graph_store(data_dir: &Path) -> Result<Arc<SocialGraphStore>> {
    open_social_graph_store_with_mapsize(data_dir, None)
}

pub fn open_social_graph_store_with_mapsize(
    data_dir: &Path,
    mapsize_bytes: Option<u64>,
) -> Result<Arc<SocialGraphStore>> {
    let db_dir = data_dir.join("socialgraph");
    open_social_graph_store_at_path(&db_dir, mapsize_bytes)
}

pub fn open_social_graph_store_with_storage(
    data_dir: &Path,
    store: Arc<StorageRouter>,
    mapsize_bytes: Option<u64>,
) -> Result<Arc<SocialGraphStore>> {
    let db_dir = data_dir.join("socialgraph");
    open_social_graph_store_at_path_with_storage(&db_dir, store, mapsize_bytes)
}

pub fn open_social_graph_store_at_path(
    db_dir: &Path,
    mapsize_bytes: Option<u64>,
) -> Result<Arc<SocialGraphStore>> {
    let config = hashtree_config::Config::load_or_default();
    let backend = &config.storage.backend;
    let local_store = Arc::new(
        LocalStore::new(db_dir.join("blobs"), backend)
            .map_err(|err| anyhow::anyhow!("Failed to create social graph blob store: {err}"))?,
    );
    let store = Arc::new(StorageRouter::new(local_store));
    open_social_graph_store_at_path_with_storage(db_dir, store, mapsize_bytes)
}

pub fn open_social_graph_store_at_path_with_storage(
    db_dir: &Path,
    store: Arc<StorageRouter>,
    mapsize_bytes: Option<u64>,
) -> Result<Arc<SocialGraphStore>> {
    let ambient_backend = store.local_store().backend();
    let ambient_local = Arc::new(
        LocalStore::new(db_dir.join(AMBIENT_EVENTS_BLOB_DIR), &ambient_backend).map_err(|err| {
            anyhow::anyhow!("Failed to create social graph ambient blob store: {err}")
        })?,
    );
    let ambient_store = Arc::new(StorageRouter::new(ambient_local));
    open_social_graph_store_at_path_with_storage_split(db_dir, store, ambient_store, mapsize_bytes)
}

pub fn open_social_graph_store_at_path_with_storage_split(
    db_dir: &Path,
    public_store: Arc<StorageRouter>,
    ambient_store: Arc<StorageRouter>,
    mapsize_bytes: Option<u64>,
) -> Result<Arc<SocialGraphStore>> {
    std::fs::create_dir_all(db_dir)?;
    if let Some(size) = mapsize_bytes {
        ensure_social_graph_mapsize(db_dir, size)?;
    }
    let graph = HeedSocialGraph::open(db_dir, DEFAULT_ROOT_HEX)
        .context("open nostr-social-graph heed backend")?;

    Ok(Arc::new(SocialGraphStore {
        graph: StdMutex::new(graph),
        distance_cache: StdMutex::new(None),
        public_events: EventIndexBucket {
            event_store: NostrEventStore::new(public_store),
            root_path: db_dir.join(EVENTS_ROOT_FILE),
        },
        ambient_events: EventIndexBucket {
            event_store: NostrEventStore::new(ambient_store),
            root_path: db_dir.join(AMBIENT_EVENTS_ROOT_FILE),
        },
    }))
}

pub fn set_social_graph_root(store: &SocialGraphStore, pk_bytes: &[u8; 32]) {
    if let Err(err) = store.set_root(pk_bytes) {
        tracing::warn!("Failed to set social graph root: {err}");
    }
}

pub fn get_follow_distance(
    backend: &(impl SocialGraphBackend + ?Sized),
    pk_bytes: &[u8; 32],
) -> Option<u32> {
    backend.follow_distance(pk_bytes).ok().flatten()
}

pub fn get_follows(
    backend: &(impl SocialGraphBackend + ?Sized),
    pk_bytes: &[u8; 32],
) -> Vec<[u8; 32]> {
    match backend.followed_targets(pk_bytes) {
        Ok(set) => set.into_iter().collect(),
        Err(_) => Vec::new(),
    }
}

pub fn is_overmuted(
    backend: &(impl SocialGraphBackend + ?Sized),
    _root_pk: &[u8; 32],
    user_pk: &[u8; 32],
    threshold: f64,
) -> bool {
    backend
        .is_overmuted_user(user_pk, threshold)
        .unwrap_or(false)
}

pub fn ingest_event(backend: &(impl SocialGraphBackend + ?Sized), _sub_id: &str, event_json: &str) {
    let event = match Event::from_json(event_json) {
        Ok(event) => event,
        Err(_) => return,
    };

    if let Err(err) = backend.ingest_event(&event) {
        tracing::warn!("Failed to ingest social graph event: {err}");
    }
}

pub fn ingest_parsed_event(
    backend: &(impl SocialGraphBackend + ?Sized),
    event: &Event,
) -> Result<()> {
    backend.ingest_event(event)
}

pub fn ingest_parsed_event_with_storage_class(
    backend: &(impl SocialGraphBackend + ?Sized),
    event: &Event,
    storage_class: EventStorageClass,
) -> Result<()> {
    backend.ingest_event_with_storage_class(event, storage_class)
}

pub fn ingest_parsed_events(
    backend: &(impl SocialGraphBackend + ?Sized),
    events: &[Event],
) -> Result<()> {
    backend.ingest_events(events)
}

pub fn ingest_parsed_events_with_storage_class(
    backend: &(impl SocialGraphBackend + ?Sized),
    events: &[Event],
    storage_class: EventStorageClass,
) -> Result<()> {
    backend.ingest_events_with_storage_class(events, storage_class)
}

pub fn ingest_graph_parsed_events(
    backend: &(impl SocialGraphBackend + ?Sized),
    events: &[Event],
) -> Result<()> {
    backend.ingest_graph_events(events)
}

pub fn query_events(
    backend: &(impl SocialGraphBackend + ?Sized),
    filter: &Filter,
    limit: usize,
) -> Vec<Event> {
    backend.query_events(filter, limit).unwrap_or_default()
}

impl SocialGraphStore {
    fn invalidate_distance_cache(&self) {
        *self.distance_cache.lock().unwrap() = None;
    }

    fn build_distance_cache(state: nostr_social_graph::SocialGraphState) -> Result<DistanceCache> {
        let unique_ids = state
            .unique_ids
            .into_iter()
            .map(|(pubkey, id)| decode_pubkey(&pubkey).map(|decoded| (id, decoded)))
            .collect::<Result<HashMap<_, _>>>()?;

        let mut users_by_distance = BTreeMap::new();
        let mut size_by_distance = BTreeMap::new();
        for (distance, users) in state.users_by_follow_distance {
            let decoded = users
                .into_iter()
                .filter_map(|id| unique_ids.get(&id).copied())
                .collect::<Vec<_>>();
            size_by_distance.insert(distance, decoded.len());
            users_by_distance.insert(distance, decoded);
        }

        let total_follows = state
            .followed_by_user
            .iter()
            .map(|(_, targets)| targets.len())
            .sum::<usize>();
        let total_users = size_by_distance.values().copied().sum();
        let max_depth = size_by_distance.keys().copied().max().unwrap_or_default();

        Ok(DistanceCache {
            stats: SocialGraphStats {
                total_users,
                root: Some(state.root),
                total_follows,
                max_depth,
                size_by_distance,
                enabled: true,
            },
            users_by_distance,
        })
    }

    fn load_distance_cache(&self) -> Result<DistanceCache> {
        if let Some(cache) = self.distance_cache.lock().unwrap().clone() {
            return Ok(cache);
        }

        let state = {
            let graph = self.graph.lock().unwrap();
            graph.export_state().context("export social graph state")?
        };
        let cache = Self::build_distance_cache(state)?;
        *self.distance_cache.lock().unwrap() = Some(cache.clone());
        Ok(cache)
    }

    fn set_root(&self, root: &[u8; 32]) -> Result<()> {
        let root_hex = hex::encode(root);
        {
            let mut graph = self.graph.lock().unwrap();
            if should_replace_placeholder_root(&graph)? {
                let fresh = SocialGraph::new(&root_hex);
                graph
                    .replace_state(&fresh.export_state())
                    .context("replace placeholder social graph root")?;
            } else {
                graph
                    .set_root(&root_hex)
                    .context("set nostr-social-graph root")?;
            }
        }
        self.invalidate_distance_cache();
        Ok(())
    }

    fn stats(&self) -> Result<SocialGraphStats> {
        Ok(self.load_distance_cache()?.stats)
    }

    fn follow_distance(&self, pk_bytes: &[u8; 32]) -> Result<Option<u32>> {
        let graph = self.graph.lock().unwrap();
        let distance = graph
            .get_follow_distance(&hex::encode(pk_bytes))
            .context("read social graph follow distance")?;
        Ok((distance != UNKNOWN_FOLLOW_DISTANCE).then_some(distance))
    }

    fn users_by_follow_distance(&self, distance: u32) -> Result<Vec<[u8; 32]>> {
        Ok(self
            .load_distance_cache()?
            .users_by_distance
            .get(&distance)
            .cloned()
            .unwrap_or_default())
    }

    fn follow_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>> {
        let graph = self.graph.lock().unwrap();
        graph
            .get_follow_list_created_at(&hex::encode(owner))
            .context("read social graph follow list timestamp")
    }

    fn followed_targets(&self, owner: &[u8; 32]) -> Result<UserSet> {
        let graph = self.graph.lock().unwrap();
        decode_pubkey_set(
            graph
                .get_followed_by_user(&hex::encode(owner))
                .context("read followed targets")?,
        )
    }

    fn is_overmuted_user(&self, user_pk: &[u8; 32], threshold: f64) -> Result<bool> {
        if threshold <= 0.0 {
            return Ok(false);
        }
        let graph = self.graph.lock().unwrap();
        graph
            .is_overmuted(&hex::encode(user_pk), threshold)
            .context("check social graph overmute")
    }

    fn snapshot_chunks(&self, root: &[u8; 32], options: &BinaryBudget) -> Result<Vec<Bytes>> {
        let state = {
            let graph = self.graph.lock().unwrap();
            graph.export_state().context("export social graph state")?
        };
        let mut graph = SocialGraph::from_state(state).context("rebuild social graph state")?;
        let root_hex = hex::encode(root);
        if graph.get_root() != root_hex {
            graph
                .set_root(&root_hex)
                .context("set snapshot social graph root")?;
        }
        let chunks = graph
            .to_binary_chunks_with_budget(*options)
            .context("encode social graph snapshot")?;
        Ok(chunks.into_iter().map(Bytes::from).collect())
    }

    fn ingest_event(&self, event: &Event) -> Result<()> {
        self.ingest_event_with_storage_class(event, self.default_storage_class_for(event)?)
    }

    fn ingest_events(&self, events: &[Event]) -> Result<()> {
        for event in events {
            self.ingest_event(event)?;
        }
        Ok(())
    }

    fn apply_graph_events_only(&self, events: &[Event]) -> Result<()> {
        let graph_events = events
            .iter()
            .filter(|event| is_social_graph_event(event.kind))
            .collect::<Vec<_>>();
        if graph_events.is_empty() {
            return Ok(());
        }

        {
            let mut graph = self.graph.lock().unwrap();
            let mut snapshot = SocialGraph::from_state(
                graph
                    .export_state()
                    .context("export social graph state for graph-only ingest")?,
            )
            .context("rebuild social graph state for graph-only ingest")?;
            for event in graph_events {
                snapshot.handle_event(&graph_event_from_nostr(event), true, 0.0);
            }
            graph
                .replace_state(&snapshot.export_state())
                .context("replace graph-only social graph state")?;
        }
        self.invalidate_distance_cache();
        Ok(())
    }

    fn query_events(&self, filter: &Filter, limit: usize) -> Result<Vec<Event>> {
        self.query_events_in_scope(filter, limit, EventQueryScope::All)
    }

    fn default_storage_class_for(&self, event: &Event) -> Result<EventStorageClass> {
        let graph = self.graph.lock().unwrap();
        let root_hex = graph.get_root().context("read social graph root")?;
        if root_hex != DEFAULT_ROOT_HEX && root_hex == event.pubkey.to_hex() {
            return Ok(EventStorageClass::Public);
        }
        Ok(EventStorageClass::Ambient)
    }

    fn bucket(&self, storage_class: EventStorageClass) -> &EventIndexBucket {
        match storage_class {
            EventStorageClass::Public => &self.public_events,
            EventStorageClass::Ambient => &self.ambient_events,
        }
    }

    fn ingest_event_with_storage_class(
        &self,
        event: &Event,
        storage_class: EventStorageClass,
    ) -> Result<()> {
        let current_root = self.bucket(storage_class).events_root()?;
        let next_root = self
            .bucket(storage_class)
            .store_event(current_root.as_ref(), event)?;
        self.bucket(storage_class)
            .write_events_root(Some(&next_root))?;

        if is_social_graph_event(event.kind) {
            {
                let mut graph = self.graph.lock().unwrap();
                graph
                    .handle_event(&graph_event_from_nostr(event), true, 0.0)
                    .context("ingest social graph event into nostr-social-graph")?;
            }
            self.invalidate_distance_cache();
        }

        Ok(())
    }

    fn ingest_events_with_storage_class(
        &self,
        events: &[Event],
        storage_class: EventStorageClass,
    ) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }

        let bucket = self.bucket(storage_class);
        let mut current_root = bucket.events_root()?;
        for event in events {
            let next_root = bucket.store_event(current_root.as_ref(), event)?;
            current_root = Some(next_root);
        }
        bucket.write_events_root(current_root.as_ref())?;

        let graph_events = events
            .iter()
            .filter(|event| is_social_graph_event(event.kind))
            .collect::<Vec<_>>();
        if graph_events.is_empty() {
            return Ok(());
        }

        {
            let mut graph = self.graph.lock().unwrap();
            let mut snapshot = SocialGraph::from_state(
                graph
                    .export_state()
                    .context("export social graph state for batch ingest")?,
            )
            .context("rebuild social graph state for batch ingest")?;
            for event in graph_events {
                snapshot.handle_event(&graph_event_from_nostr(event), true, 0.0);
            }
            graph
                .replace_state(&snapshot.export_state())
                .context("replace batched social graph state")?;
        }
        self.invalidate_distance_cache();

        Ok(())
    }

    pub(crate) fn query_events_in_scope(
        &self,
        filter: &Filter,
        limit: usize,
        scope: EventQueryScope,
    ) -> Result<Vec<Event>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let buckets: &[&EventIndexBucket] = match scope {
            EventQueryScope::PublicOnly => &[&self.public_events],
            EventQueryScope::AmbientOnly => &[&self.ambient_events],
            EventQueryScope::All => &[&self.public_events, &self.ambient_events],
        };

        let mut candidates = Vec::new();
        for bucket in buckets {
            candidates.extend(bucket.query_events(filter, limit)?);
        }

        let mut deduped = dedupe_events(candidates);
        deduped.retain(|event| filter.match_event(event));
        deduped.truncate(limit);
        Ok(deduped)
    }
}

impl EventIndexBucket {
    fn events_root(&self) -> Result<Option<Cid>> {
        let Ok(bytes) = std::fs::read(&self.root_path) else {
            return Ok(None);
        };
        decode_cid(&bytes)
    }

    fn write_events_root(&self, root: Option<&Cid>) -> Result<()> {
        let Some(root) = root else {
            if self.root_path.exists() {
                std::fs::remove_file(&self.root_path)?;
            }
            return Ok(());
        };

        let encoded = encode_cid(root)?;
        let tmp_path = self.root_path.with_extension("tmp");
        std::fs::write(&tmp_path, encoded)?;
        std::fs::rename(tmp_path, &self.root_path)?;
        Ok(())
    }

    fn store_event(&self, root: Option<&Cid>, event: &Event) -> Result<Cid> {
        let stored = stored_event_from_nostr(event);
        block_on(self.event_store.add(root, stored)).map_err(map_event_store_error)
    }

    fn load_event_by_id(&self, root: &Cid, event_id: &str) -> Result<Option<Event>> {
        let stored = block_on(self.event_store.get_by_id(Some(root), event_id))
            .map_err(map_event_store_error)?;
        stored.map(nostr_event_from_stored).transpose()
    }

    fn load_events_for_author(
        &self,
        root: &Cid,
        author: &nostr::PublicKey,
        filter: &Filter,
        limit: usize,
        exact: bool,
    ) -> Result<Vec<Event>> {
        let kind_filter = filter.kinds.as_ref().and_then(|kinds| {
            if kinds.len() == 1 {
                kinds.iter().next().map(|kind| kind.as_u16() as u32)
            } else {
                None
            }
        });
        let author_hex = author.to_hex();
        let options = filter_list_options(filter, limit, exact);
        let stored = match kind_filter {
            Some(kind) => block_on(self.event_store.list_by_author_and_kind(
                Some(root),
                &author_hex,
                kind,
                options.clone(),
            ))
            .map_err(map_event_store_error)?,
            None => block_on(
                self.event_store
                    .list_by_author(Some(root), &author_hex, options),
            )
            .map_err(map_event_store_error)?,
        };
        stored
            .into_iter()
            .map(nostr_event_from_stored)
            .collect::<Result<Vec<_>>>()
    }

    fn load_events_for_kind(
        &self,
        root: &Cid,
        kind: Kind,
        filter: &Filter,
        limit: usize,
        exact: bool,
    ) -> Result<Vec<Event>> {
        let stored = block_on(self.event_store.list_by_kind(
            Some(root),
            kind.as_u16() as u32,
            filter_list_options(filter, limit, exact),
        ))
        .map_err(map_event_store_error)?;
        stored
            .into_iter()
            .map(nostr_event_from_stored)
            .collect::<Result<Vec<_>>>()
    }

    fn load_recent_events(
        &self,
        root: &Cid,
        filter: &Filter,
        limit: usize,
        exact: bool,
    ) -> Result<Vec<Event>> {
        let stored = block_on(
            self.event_store
                .list_recent(Some(root), filter_list_options(filter, limit, exact)),
        )
        .map_err(map_event_store_error)?;
        stored
            .into_iter()
            .map(nostr_event_from_stored)
            .collect::<Result<Vec<_>>>()
    }

    fn load_events_for_tag(
        &self,
        root: &Cid,
        tag_name: &str,
        values: &[String],
        filter: &Filter,
        limit: usize,
        exact: bool,
    ) -> Result<Vec<Event>> {
        let mut events = Vec::new();
        let options = filter_list_options(filter, limit, exact);
        for value in values {
            let stored = block_on(self.event_store.list_by_tag(
                Some(root),
                tag_name,
                value,
                options.clone(),
            ))
            .map_err(map_event_store_error)?;
            events.extend(
                stored
                    .into_iter()
                    .map(nostr_event_from_stored)
                    .collect::<Result<Vec<_>>>()?,
            );
        }
        Ok(dedupe_events(events))
    }

    fn choose_tag_source(&self, filter: &Filter) -> Option<(String, Vec<String>)> {
        filter
            .generic_tags
            .iter()
            .min_by_key(|(_, values)| values.len())
            .map(|(tag, values)| {
                (
                    tag.as_char().to_ascii_lowercase().to_string(),
                    values.iter().cloned().collect(),
                )
            })
    }

    fn load_major_index_candidates(
        &self,
        root: &Cid,
        filter: &Filter,
        limit: usize,
    ) -> Result<Option<Vec<Event>>> {
        if let Some(events) = self.load_direct_replaceable_candidates(root, filter)? {
            return Ok(Some(events));
        }

        if let Some((tag_name, values)) = self.choose_tag_source(filter) {
            let exact = filter.authors.is_none()
                && filter.kinds.is_none()
                && filter.search.is_none()
                && filter.generic_tags.len() == 1;
            return Ok(Some(self.load_events_for_tag(
                root, &tag_name, &values, filter, limit, exact,
            )?));
        }

        if let (Some(authors), Some(kinds)) = (filter.authors.as_ref(), filter.kinds.as_ref()) {
            if authors.len() == 1 && kinds.len() == 1 {
                let author = authors.iter().next().expect("checked single author");
                let exact = filter.generic_tags.is_empty() && filter.search.is_none();
                return Ok(Some(
                    self.load_events_for_author(root, author, filter, limit, exact)?,
                ));
            }

            if kinds.len() < authors.len() {
                let mut events = Vec::new();
                for kind in kinds {
                    events.extend(self.load_events_for_kind(root, *kind, filter, limit, false)?);
                }
                return Ok(Some(dedupe_events(events)));
            }

            let mut events = Vec::new();
            for author in authors {
                events.extend(self.load_events_for_author(root, author, filter, limit, false)?);
            }
            return Ok(Some(dedupe_events(events)));
        }

        if let Some(authors) = filter.authors.as_ref() {
            let mut events = Vec::new();
            let exact = filter.generic_tags.is_empty() && filter.search.is_none();
            for author in authors {
                events.extend(self.load_events_for_author(root, author, filter, limit, exact)?);
            }
            return Ok(Some(dedupe_events(events)));
        }

        if let Some(kinds) = filter.kinds.as_ref() {
            let mut events = Vec::new();
            let exact = filter.authors.is_none()
                && filter.generic_tags.is_empty()
                && filter.search.is_none();
            for kind in kinds {
                events.extend(self.load_events_for_kind(root, *kind, filter, limit, exact)?);
            }
            return Ok(Some(dedupe_events(events)));
        }

        Ok(None)
    }

    fn load_direct_replaceable_candidates(
        &self,
        root: &Cid,
        filter: &Filter,
    ) -> Result<Option<Vec<Event>>> {
        let Some(authors) = filter.authors.as_ref() else {
            return Ok(None);
        };
        let Some(kinds) = filter.kinds.as_ref() else {
            return Ok(None);
        };
        if kinds.len() != 1 {
            return Ok(None);
        }

        let kind = kinds.iter().next().expect("checked single kind").as_u16() as u32;

        if (30_000..40_000).contains(&kind) {
            let d_tag = SingleLetterTag::lowercase(nostr::Alphabet::D);
            let Some(d_values) = filter.generic_tags.get(&d_tag) else {
                return Ok(None);
            };
            let mut events = Vec::new();
            for author in authors {
                let author_hex = author.to_hex();
                for d_value in d_values {
                    if let Some(stored) = block_on(self.event_store.get_parameterized_replaceable(
                        Some(root),
                        &author_hex,
                        kind,
                        d_value,
                    ))
                    .map_err(map_event_store_error)?
                    {
                        events.push(nostr_event_from_stored(stored)?);
                    }
                }
            }
            return Ok(Some(dedupe_events(events)));
        }

        if kind == 0 || kind == 3 || (10_000..20_000).contains(&kind) {
            let mut events = Vec::new();
            for author in authors {
                if let Some(stored) = block_on(self.event_store.get_replaceable(
                    Some(root),
                    &author.to_hex(),
                    kind,
                ))
                .map_err(map_event_store_error)?
                {
                    events.push(nostr_event_from_stored(stored)?);
                }
            }
            return Ok(Some(dedupe_events(events)));
        }

        Ok(None)
    }

    fn query_events(&self, filter: &Filter, limit: usize) -> Result<Vec<Event>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let events_root = self.events_root()?;
        let Some(root) = events_root.as_ref() else {
            return Ok(Vec::new());
        };
        let mut candidates = Vec::new();
        let mut seen: HashSet<[u8; 32]> = HashSet::new();

        if let Some(ids) = filter.ids.as_ref() {
            for id in ids {
                let id_bytes = id.to_bytes();
                if !seen.insert(id_bytes) {
                    continue;
                }
                if let Some(event) = self.load_event_by_id(root, &id.to_hex())? {
                    if filter.match_event(&event) {
                        candidates.push(event);
                    }
                }
                if candidates.len() >= limit {
                    break;
                }
            }
        } else {
            let base_events = match self.load_major_index_candidates(root, filter, limit)? {
                Some(events) => events,
                None => self.load_recent_events(
                    root,
                    filter,
                    limit,
                    filter.authors.is_none()
                        && filter.kinds.is_none()
                        && filter.generic_tags.is_empty()
                        && filter.search.is_none(),
                )?,
            };

            for event in base_events {
                let id_bytes = event.id.to_bytes();
                if !seen.insert(id_bytes) {
                    continue;
                }
                if filter.match_event(&event) {
                    candidates.push(event);
                }
                if candidates.len() >= limit {
                    break;
                }
            }
        }

        candidates.sort_by(|a, b| {
            b.created_at
                .as_u64()
                .cmp(&a.created_at.as_u64())
                .then_with(|| a.id.cmp(&b.id))
        });
        candidates.truncate(limit);
        Ok(candidates)
    }
}

fn filter_list_options(filter: &Filter, limit: usize, exact: bool) -> ListEventsOptions {
    ListEventsOptions {
        limit: exact.then_some(limit.max(1)),
        since: filter.since.map(|timestamp| timestamp.as_u64()),
        until: filter.until.map(|timestamp| timestamp.as_u64()),
    }
}

fn dedupe_events(events: Vec<Event>) -> Vec<Event> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for event in events {
        if seen.insert(event.id.to_bytes()) {
            deduped.push(event);
        }
    }
    deduped.sort_by(|a, b| {
        b.created_at
            .as_u64()
            .cmp(&a.created_at.as_u64())
            .then_with(|| a.id.cmp(&b.id))
    });
    deduped
}

impl SocialGraphBackend for SocialGraphStore {
    fn stats(&self) -> Result<SocialGraphStats> {
        SocialGraphStore::stats(self)
    }

    fn users_by_follow_distance(&self, distance: u32) -> Result<Vec<[u8; 32]>> {
        SocialGraphStore::users_by_follow_distance(self, distance)
    }

    fn follow_distance(&self, pk_bytes: &[u8; 32]) -> Result<Option<u32>> {
        SocialGraphStore::follow_distance(self, pk_bytes)
    }

    fn follow_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>> {
        SocialGraphStore::follow_list_created_at(self, owner)
    }

    fn followed_targets(&self, owner: &[u8; 32]) -> Result<UserSet> {
        SocialGraphStore::followed_targets(self, owner)
    }

    fn is_overmuted_user(&self, user_pk: &[u8; 32], threshold: f64) -> Result<bool> {
        SocialGraphStore::is_overmuted_user(self, user_pk, threshold)
    }

    fn snapshot_chunks(&self, root: &[u8; 32], options: &BinaryBudget) -> Result<Vec<Bytes>> {
        SocialGraphStore::snapshot_chunks(self, root, options)
    }

    fn ingest_event(&self, event: &Event) -> Result<()> {
        SocialGraphStore::ingest_event(self, event)
    }

    fn ingest_event_with_storage_class(
        &self,
        event: &Event,
        storage_class: EventStorageClass,
    ) -> Result<()> {
        SocialGraphStore::ingest_event_with_storage_class(self, event, storage_class)
    }

    fn ingest_events(&self, events: &[Event]) -> Result<()> {
        SocialGraphStore::ingest_events(self, events)
    }

    fn ingest_events_with_storage_class(
        &self,
        events: &[Event],
        storage_class: EventStorageClass,
    ) -> Result<()> {
        SocialGraphStore::ingest_events_with_storage_class(self, events, storage_class)
    }

    fn ingest_graph_events(&self, events: &[Event]) -> Result<()> {
        SocialGraphStore::apply_graph_events_only(self, events)
    }

    fn query_events(&self, filter: &Filter, limit: usize) -> Result<Vec<Event>> {
        SocialGraphStore::query_events(self, filter, limit)
    }
}

impl NostrSocialGraphBackend for SocialGraphStore {
    type Error = UpstreamGraphBackendError;

    fn get_root(&self) -> std::result::Result<String, Self::Error> {
        let graph = self.graph.lock().unwrap();
        graph
            .get_root()
            .context("read social graph root")
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }

    fn set_root(&mut self, root: &str) -> std::result::Result<(), Self::Error> {
        let root_bytes =
            decode_pubkey(root).map_err(|err| UpstreamGraphBackendError(err.to_string()))?;
        SocialGraphStore::set_root(self, &root_bytes)
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }

    fn handle_event(
        &mut self,
        event: &GraphEvent,
        allow_unknown_authors: bool,
        overmute_threshold: f64,
    ) -> std::result::Result<(), Self::Error> {
        {
            let mut graph = self.graph.lock().unwrap();
            graph
                .handle_event(event, allow_unknown_authors, overmute_threshold)
                .context("ingest social graph event into heed backend")
                .map_err(|err| UpstreamGraphBackendError(err.to_string()))?;
        }
        self.invalidate_distance_cache();
        Ok(())
    }

    fn get_follow_distance(&self, user: &str) -> std::result::Result<u32, Self::Error> {
        let graph = self.graph.lock().unwrap();
        graph
            .get_follow_distance(user)
            .context("read social graph follow distance")
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }

    fn is_following(
        &self,
        follower: &str,
        followed_user: &str,
    ) -> std::result::Result<bool, Self::Error> {
        let graph = self.graph.lock().unwrap();
        graph
            .is_following(follower, followed_user)
            .context("read social graph following edge")
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }

    fn get_followed_by_user(&self, user: &str) -> std::result::Result<Vec<String>, Self::Error> {
        let graph = self.graph.lock().unwrap();
        graph
            .get_followed_by_user(user)
            .context("read followed-by-user list")
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }

    fn get_followers_by_user(&self, user: &str) -> std::result::Result<Vec<String>, Self::Error> {
        let graph = self.graph.lock().unwrap();
        graph
            .get_followers_by_user(user)
            .context("read followers-by-user list")
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }

    fn get_muted_by_user(&self, user: &str) -> std::result::Result<Vec<String>, Self::Error> {
        let graph = self.graph.lock().unwrap();
        graph
            .get_muted_by_user(user)
            .context("read muted-by-user list")
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }

    fn get_user_muted_by(&self, user: &str) -> std::result::Result<Vec<String>, Self::Error> {
        let graph = self.graph.lock().unwrap();
        graph
            .get_user_muted_by(user)
            .context("read user-muted-by list")
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }

    fn get_follow_list_created_at(
        &self,
        user: &str,
    ) -> std::result::Result<Option<u64>, Self::Error> {
        let graph = self.graph.lock().unwrap();
        graph
            .get_follow_list_created_at(user)
            .context("read social graph follow list timestamp")
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }

    fn get_mute_list_created_at(
        &self,
        user: &str,
    ) -> std::result::Result<Option<u64>, Self::Error> {
        let graph = self.graph.lock().unwrap();
        graph
            .get_mute_list_created_at(user)
            .context("read social graph mute list timestamp")
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }

    fn is_overmuted(&self, user: &str, threshold: f64) -> std::result::Result<bool, Self::Error> {
        let graph = self.graph.lock().unwrap();
        graph
            .is_overmuted(user, threshold)
            .context("check social graph overmute")
            .map_err(|err| UpstreamGraphBackendError(err.to_string()))
    }
}

impl<T> SocialGraphBackend for Arc<T>
where
    T: SocialGraphBackend + ?Sized,
{
    fn stats(&self) -> Result<SocialGraphStats> {
        self.as_ref().stats()
    }

    fn users_by_follow_distance(&self, distance: u32) -> Result<Vec<[u8; 32]>> {
        self.as_ref().users_by_follow_distance(distance)
    }

    fn follow_distance(&self, pk_bytes: &[u8; 32]) -> Result<Option<u32>> {
        self.as_ref().follow_distance(pk_bytes)
    }

    fn follow_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>> {
        self.as_ref().follow_list_created_at(owner)
    }

    fn followed_targets(&self, owner: &[u8; 32]) -> Result<UserSet> {
        self.as_ref().followed_targets(owner)
    }

    fn is_overmuted_user(&self, user_pk: &[u8; 32], threshold: f64) -> Result<bool> {
        self.as_ref().is_overmuted_user(user_pk, threshold)
    }

    fn snapshot_chunks(&self, root: &[u8; 32], options: &BinaryBudget) -> Result<Vec<Bytes>> {
        self.as_ref().snapshot_chunks(root, options)
    }

    fn ingest_event(&self, event: &Event) -> Result<()> {
        self.as_ref().ingest_event(event)
    }

    fn ingest_event_with_storage_class(
        &self,
        event: &Event,
        storage_class: EventStorageClass,
    ) -> Result<()> {
        self.as_ref()
            .ingest_event_with_storage_class(event, storage_class)
    }

    fn ingest_events(&self, events: &[Event]) -> Result<()> {
        self.as_ref().ingest_events(events)
    }

    fn ingest_events_with_storage_class(
        &self,
        events: &[Event],
        storage_class: EventStorageClass,
    ) -> Result<()> {
        self.as_ref()
            .ingest_events_with_storage_class(events, storage_class)
    }

    fn ingest_graph_events(&self, events: &[Event]) -> Result<()> {
        self.as_ref().ingest_graph_events(events)
    }

    fn query_events(&self, filter: &Filter, limit: usize) -> Result<Vec<Event>> {
        self.as_ref().query_events(filter, limit)
    }
}

fn should_replace_placeholder_root(graph: &HeedSocialGraph) -> Result<bool> {
    if graph.get_root().context("read current social graph root")? != DEFAULT_ROOT_HEX {
        return Ok(false);
    }

    let GraphStats {
        users,
        follows,
        mutes,
        ..
    } = graph.size().context("size social graph")?;
    Ok(users <= 1 && follows == 0 && mutes == 0)
}

fn decode_pubkey_set(values: Vec<String>) -> Result<UserSet> {
    let mut set = UserSet::new();
    for value in values {
        set.insert(decode_pubkey(&value)?);
    }
    Ok(set)
}

fn decode_pubkey(value: &str) -> Result<[u8; 32]> {
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(value, &mut bytes)
        .with_context(|| format!("decode social graph pubkey {value}"))?;
    Ok(bytes)
}

fn is_social_graph_event(kind: Kind) -> bool {
    kind == Kind::ContactList || kind == Kind::MuteList
}

fn graph_event_from_nostr(event: &Event) -> GraphEvent {
    GraphEvent {
        created_at: event.created_at.as_u64(),
        content: event.content.clone(),
        tags: event
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect(),
        kind: event.kind.as_u16() as u32,
        pubkey: event.pubkey.to_hex(),
        id: event.id.to_hex(),
        sig: event.sig.to_string(),
    }
}

fn stored_event_from_nostr(event: &Event) -> StoredNostrEvent {
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

fn nostr_event_from_stored(event: StoredNostrEvent) -> Result<Event> {
    let value = serde_json::json!({
        "id": event.id,
        "pubkey": event.pubkey,
        "created_at": event.created_at,
        "kind": event.kind,
        "tags": event.tags,
        "content": event.content,
        "sig": event.sig,
    });
    Event::from_json(value.to_string()).context("decode stored nostr event")
}

fn encode_cid(cid: &Cid) -> Result<Vec<u8>> {
    rmp_serde::to_vec_named(&StoredCid {
        hash: cid.hash,
        key: cid.key,
    })
    .context("encode social graph events root")
}

fn decode_cid(bytes: &[u8]) -> Result<Option<Cid>> {
    let stored: StoredCid =
        rmp_serde::from_slice(bytes).context("decode social graph events root")?;
    Ok(Some(Cid {
        hash: stored.hash,
        key: stored.key,
    }))
}

fn map_event_store_error(err: NostrEventStoreError) -> anyhow::Error {
    anyhow::anyhow!("nostr event store error: {err}")
}

fn ensure_social_graph_mapsize(db_dir: &Path, requested_bytes: u64) -> Result<()> {
    let requested = requested_bytes.max(DEFAULT_SOCIALGRAPH_MAP_SIZE_BYTES);
    let page_size = page_size_bytes() as u64;
    let rounded = requested
        .checked_add(page_size.saturating_sub(1))
        .map(|size| size / page_size * page_size)
        .unwrap_or(requested);
    let map_size = usize::try_from(rounded).context("social graph mapsize exceeds usize")?;

    let env = unsafe {
        heed::EnvOpenOptions::new()
            .map_size(DEFAULT_SOCIALGRAPH_MAP_SIZE_BYTES as usize)
            .max_dbs(SOCIALGRAPH_MAX_DBS)
            .open(db_dir)
    }
    .context("open social graph LMDB env for resize")?;
    if env.info().map_size < map_size {
        unsafe { env.resize(map_size) }.context("resize social graph LMDB env")?;
    }

    Ok(())
}

fn page_size_bytes() -> usize {
    page_size::get_granularity()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, JsonUtil, Keys, Tag, Timestamp};
    use tempfile::TempDir;

    #[test]
    fn test_open_social_graph_store() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        assert_eq!(Arc::strong_count(&graph_store), 1);
    }

    #[test]
    fn test_set_root_and_get_follow_distance() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let root_pk = [1u8; 32];
        set_social_graph_root(&graph_store, &root_pk);
        assert_eq!(get_follow_distance(&graph_store, &root_pk), Some(0));
    }

    #[test]
    fn test_ingest_event_updates_follows_and_mutes() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();

        let root_keys = Keys::generate();
        let alice_keys = Keys::generate();
        let bob_keys = Keys::generate();

        let root_pk = root_keys.public_key().to_bytes();
        set_social_graph_root(&graph_store, &root_pk);

        let follow = EventBuilder::new(
            Kind::ContactList,
            "",
            vec![Tag::public_key(alice_keys.public_key())],
        )
        .custom_created_at(Timestamp::from_secs(10))
        .to_event(&root_keys)
        .unwrap();
        ingest_event(&graph_store, "follow", &follow.as_json());

        let mute = EventBuilder::new(
            Kind::MuteList,
            "",
            vec![Tag::public_key(bob_keys.public_key())],
        )
        .custom_created_at(Timestamp::from_secs(11))
        .to_event(&root_keys)
        .unwrap();
        ingest_event(&graph_store, "mute", &mute.as_json());

        assert_eq!(
            get_follow_distance(&graph_store, &alice_keys.public_key().to_bytes()),
            Some(1)
        );
        assert!(is_overmuted(
            &graph_store,
            &root_pk,
            &bob_keys.public_key().to_bytes(),
            1.0
        ));
    }

    #[test]
    fn test_query_events_by_author() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let keys = Keys::generate();

        let older = EventBuilder::new(Kind::TextNote, "older", [])
            .custom_created_at(Timestamp::from_secs(5))
            .to_event(&keys)
            .unwrap();
        let newer = EventBuilder::new(Kind::TextNote, "newer", [])
            .custom_created_at(Timestamp::from_secs(6))
            .to_event(&keys)
            .unwrap();

        ingest_parsed_event(&graph_store, &older).unwrap();
        ingest_parsed_event(&graph_store, &newer).unwrap();

        let filter = Filter::new().author(keys.public_key()).kind(Kind::TextNote);
        let events = query_events(&graph_store, &filter, 10);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id, newer.id);
        assert_eq!(events[1].id, older.id);
    }

    #[test]
    fn test_query_events_by_kind() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let first_keys = Keys::generate();
        let second_keys = Keys::generate();

        let older = EventBuilder::new(Kind::TextNote, "older", [])
            .custom_created_at(Timestamp::from_secs(5))
            .to_event(&first_keys)
            .unwrap();
        let newer = EventBuilder::new(Kind::TextNote, "newer", [])
            .custom_created_at(Timestamp::from_secs(6))
            .to_event(&second_keys)
            .unwrap();
        let other_kind = EventBuilder::new(Kind::Metadata, "profile", [])
            .custom_created_at(Timestamp::from_secs(7))
            .to_event(&second_keys)
            .unwrap();

        ingest_parsed_event(&graph_store, &older).unwrap();
        ingest_parsed_event(&graph_store, &newer).unwrap();
        ingest_parsed_event(&graph_store, &other_kind).unwrap();

        let filter = Filter::new().kind(Kind::TextNote);
        let events = query_events(&graph_store, &filter, 10);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id, newer.id);
        assert_eq!(events[1].id, older.id);
    }

    #[test]
    fn test_query_events_by_id() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let keys = Keys::generate();

        let first = EventBuilder::new(Kind::TextNote, "first", [])
            .custom_created_at(Timestamp::from_secs(5))
            .to_event(&keys)
            .unwrap();
        let target = EventBuilder::new(Kind::TextNote, "target", [])
            .custom_created_at(Timestamp::from_secs(6))
            .to_event(&keys)
            .unwrap();

        ingest_parsed_event(&graph_store, &first).unwrap();
        ingest_parsed_event(&graph_store, &target).unwrap();

        let filter = Filter::new().id(target.id).kind(Kind::TextNote);
        let events = query_events(&graph_store, &filter, 10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, target.id);
    }

    #[test]
    fn test_query_events_search_is_case_insensitive() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let keys = Keys::generate();
        let other_keys = Keys::generate();

        let matching = EventBuilder::new(Kind::TextNote, "Hello Nostr Search", [])
            .custom_created_at(Timestamp::from_secs(5))
            .to_event(&keys)
            .unwrap();
        let other = EventBuilder::new(Kind::TextNote, "goodbye world", [])
            .custom_created_at(Timestamp::from_secs(6))
            .to_event(&other_keys)
            .unwrap();

        ingest_parsed_event(&graph_store, &matching).unwrap();
        ingest_parsed_event(&graph_store, &other).unwrap();

        let filter = Filter::new().kind(Kind::TextNote).search("nostr search");
        let events = query_events(&graph_store, &filter, 10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, matching.id);
    }

    #[test]
    fn test_query_events_since_until_are_inclusive() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let keys = Keys::generate();

        let before = EventBuilder::new(Kind::TextNote, "before", [])
            .custom_created_at(Timestamp::from_secs(5))
            .to_event(&keys)
            .unwrap();
        let start = EventBuilder::new(Kind::TextNote, "start", [])
            .custom_created_at(Timestamp::from_secs(6))
            .to_event(&keys)
            .unwrap();
        let end = EventBuilder::new(Kind::TextNote, "end", [])
            .custom_created_at(Timestamp::from_secs(10))
            .to_event(&keys)
            .unwrap();
        let after = EventBuilder::new(Kind::TextNote, "after", [])
            .custom_created_at(Timestamp::from_secs(11))
            .to_event(&keys)
            .unwrap();

        ingest_parsed_event(&graph_store, &before).unwrap();
        ingest_parsed_event(&graph_store, &start).unwrap();
        ingest_parsed_event(&graph_store, &end).unwrap();
        ingest_parsed_event(&graph_store, &after).unwrap();

        let filter = Filter::new()
            .kind(Kind::TextNote)
            .since(Timestamp::from_secs(6))
            .until(Timestamp::from_secs(10));
        let events = query_events(&graph_store, &filter, 10);
        let ids = events.into_iter().map(|event| event.id).collect::<Vec<_>>();
        assert_eq!(ids, vec![end.id, start.id]);
    }

    #[test]
    fn test_query_events_replaceable_kind_returns_latest_winner() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let keys = Keys::generate();

        let older = EventBuilder::new(Kind::Custom(10_000), "older mute list", [])
            .custom_created_at(Timestamp::from_secs(5))
            .to_event(&keys)
            .unwrap();
        let newer = EventBuilder::new(Kind::Custom(10_000), "newer mute list", [])
            .custom_created_at(Timestamp::from_secs(6))
            .to_event(&keys)
            .unwrap();

        ingest_parsed_event(&graph_store, &older).unwrap();
        ingest_parsed_event(&graph_store, &newer).unwrap();

        let filter = Filter::new()
            .author(keys.public_key())
            .kind(Kind::Custom(10_000));
        let events = query_events(&graph_store, &filter, 10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, newer.id);
    }

    #[test]
    fn test_public_and_ambient_indexes_stay_separate() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let public_keys = Keys::generate();
        let ambient_keys = Keys::generate();

        let public_event = EventBuilder::new(Kind::TextNote, "public", [])
            .custom_created_at(Timestamp::from_secs(5))
            .to_event(&public_keys)
            .unwrap();
        let ambient_event = EventBuilder::new(Kind::TextNote, "ambient", [])
            .custom_created_at(Timestamp::from_secs(6))
            .to_event(&ambient_keys)
            .unwrap();

        ingest_parsed_event_with_storage_class(
            &graph_store,
            &public_event,
            EventStorageClass::Public,
        )
        .unwrap();
        ingest_parsed_event_with_storage_class(
            &graph_store,
            &ambient_event,
            EventStorageClass::Ambient,
        )
        .unwrap();

        let filter = Filter::new().kind(Kind::TextNote);
        let all_events = graph_store
            .query_events_in_scope(&filter, 10, EventQueryScope::All)
            .unwrap();
        assert_eq!(all_events.len(), 2);

        let public_events = graph_store
            .query_events_in_scope(&filter, 10, EventQueryScope::PublicOnly)
            .unwrap();
        assert_eq!(public_events.len(), 1);
        assert_eq!(public_events[0].id, public_event.id);

        let ambient_events = graph_store
            .query_events_in_scope(&filter, 10, EventQueryScope::AmbientOnly)
            .unwrap();
        assert_eq!(ambient_events.len(), 1);
        assert_eq!(ambient_events[0].id, ambient_event.id);
    }

    #[test]
    fn test_default_ingest_classifies_root_author_as_public() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let root_keys = Keys::generate();
        let other_keys = Keys::generate();
        set_social_graph_root(&graph_store, &root_keys.public_key().to_bytes());

        let root_event = EventBuilder::new(Kind::TextNote, "root", [])
            .custom_created_at(Timestamp::from_secs(5))
            .to_event(&root_keys)
            .unwrap();
        let other_event = EventBuilder::new(Kind::TextNote, "other", [])
            .custom_created_at(Timestamp::from_secs(6))
            .to_event(&other_keys)
            .unwrap();

        ingest_parsed_event(&graph_store, &root_event).unwrap();
        ingest_parsed_event(&graph_store, &other_event).unwrap();

        let filter = Filter::new().kind(Kind::TextNote);
        let public_events = graph_store
            .query_events_in_scope(&filter, 10, EventQueryScope::PublicOnly)
            .unwrap();
        assert_eq!(public_events.len(), 1);
        assert_eq!(public_events[0].id, root_event.id);

        let ambient_events = graph_store
            .query_events_in_scope(&filter, 10, EventQueryScope::AmbientOnly)
            .unwrap();
        assert_eq!(ambient_events.len(), 1);
        assert_eq!(ambient_events[0].id, other_event.id);
    }

    #[test]
    fn test_query_events_survives_reopen() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let db_dir = tmp.path().join("socialgraph-store");
        let keys = Keys::generate();
        let other_keys = Keys::generate();

        {
            let graph_store = open_social_graph_store_at_path(&db_dir, None).unwrap();
            let older = EventBuilder::new(Kind::TextNote, "older", [])
                .custom_created_at(Timestamp::from_secs(5))
                .to_event(&keys)
                .unwrap();
            let newer = EventBuilder::new(Kind::TextNote, "newer", [])
                .custom_created_at(Timestamp::from_secs(6))
                .to_event(&keys)
                .unwrap();
            let latest = EventBuilder::new(Kind::TextNote, "latest", [])
                .custom_created_at(Timestamp::from_secs(7))
                .to_event(&other_keys)
                .unwrap();

            ingest_parsed_event(&graph_store, &older).unwrap();
            ingest_parsed_event(&graph_store, &newer).unwrap();
            ingest_parsed_event(&graph_store, &latest).unwrap();
        }

        let reopened = open_social_graph_store_at_path(&db_dir, None).unwrap();

        let author_filter = Filter::new().author(keys.public_key()).kind(Kind::TextNote);
        let author_events = query_events(&reopened, &author_filter, 10);
        assert_eq!(author_events.len(), 2);
        assert_eq!(author_events[0].content, "newer");
        assert_eq!(author_events[1].content, "older");

        let recent_filter = Filter::new().kind(Kind::TextNote);
        let recent_events = query_events(&reopened, &recent_filter, 2);
        assert_eq!(recent_events.len(), 2);
        assert_eq!(recent_events[0].content, "latest");
        assert_eq!(recent_events[1].content, "newer");
    }

    #[test]
    fn test_query_events_parameterized_replaceable_by_d_tag() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let keys = Keys::generate();

        let older = EventBuilder::new(
            Kind::Custom(30078),
            "",
            vec![
                Tag::identifier("video"),
                Tag::parse(&["l", "hashtree"]).unwrap(),
                Tag::parse(&["hash", &"11".repeat(32)]).unwrap(),
            ],
        )
        .custom_created_at(Timestamp::from_secs(5))
        .to_event(&keys)
        .unwrap();
        let newer = EventBuilder::new(
            Kind::Custom(30078),
            "",
            vec![
                Tag::identifier("video"),
                Tag::parse(&["l", "hashtree"]).unwrap(),
                Tag::parse(&["hash", &"22".repeat(32)]).unwrap(),
            ],
        )
        .custom_created_at(Timestamp::from_secs(6))
        .to_event(&keys)
        .unwrap();
        let other_tree = EventBuilder::new(
            Kind::Custom(30078),
            "",
            vec![
                Tag::identifier("files"),
                Tag::parse(&["l", "hashtree"]).unwrap(),
                Tag::parse(&["hash", &"33".repeat(32)]).unwrap(),
            ],
        )
        .custom_created_at(Timestamp::from_secs(7))
        .to_event(&keys)
        .unwrap();

        ingest_parsed_event(&graph_store, &older).unwrap();
        ingest_parsed_event(&graph_store, &newer).unwrap();
        ingest_parsed_event(&graph_store, &other_tree).unwrap();

        let filter = Filter::new()
            .author(keys.public_key())
            .kind(Kind::Custom(30078))
            .identifier("video");
        let events = query_events(&graph_store, &filter, 10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, newer.id);
    }

    #[test]
    fn test_query_events_by_hashtag_uses_tag_index() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let keys = Keys::generate();
        let other_keys = Keys::generate();

        let first = EventBuilder::new(
            Kind::TextNote,
            "first",
            vec![Tag::parse(&["t", "hashtree"]).unwrap()],
        )
        .custom_created_at(Timestamp::from_secs(5))
        .to_event(&keys)
        .unwrap();
        let second = EventBuilder::new(
            Kind::TextNote,
            "second",
            vec![Tag::parse(&["t", "hashtree"]).unwrap()],
        )
        .custom_created_at(Timestamp::from_secs(6))
        .to_event(&other_keys)
        .unwrap();
        let unrelated = EventBuilder::new(
            Kind::TextNote,
            "third",
            vec![Tag::parse(&["t", "other"]).unwrap()],
        )
        .custom_created_at(Timestamp::from_secs(7))
        .to_event(&other_keys)
        .unwrap();

        ingest_parsed_event(&graph_store, &first).unwrap();
        ingest_parsed_event(&graph_store, &second).unwrap();
        ingest_parsed_event(&graph_store, &unrelated).unwrap();

        let filter = Filter::new().hashtag("hashtree");
        let events = query_events(&graph_store, &filter, 10);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id, second.id);
        assert_eq!(events[1].id, first.id);
    }

    #[test]
    fn test_query_events_combines_indexes_then_applies_search_filter() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();
        let keys = Keys::generate();
        let other_keys = Keys::generate();

        let matching = EventBuilder::new(
            Kind::TextNote,
            "hashtree video release",
            vec![Tag::parse(&["t", "hashtree"]).unwrap()],
        )
        .custom_created_at(Timestamp::from_secs(5))
        .to_event(&keys)
        .unwrap();
        let non_matching = EventBuilder::new(
            Kind::TextNote,
            "plain text note",
            vec![Tag::parse(&["t", "hashtree"]).unwrap()],
        )
        .custom_created_at(Timestamp::from_secs(6))
        .to_event(&other_keys)
        .unwrap();

        ingest_parsed_event(&graph_store, &matching).unwrap();
        ingest_parsed_event(&graph_store, &non_matching).unwrap();

        let filter = Filter::new().hashtag("hashtree").search("video");
        let events = query_events(&graph_store, &filter, 10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, matching.id);
    }

    #[test]
    #[ignore = "benchmark"]
    fn benchmark_query_events_large_dataset() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store =
            open_social_graph_store_with_mapsize(tmp.path(), Some(512 * 1024 * 1024)).unwrap();

        let author_count = 64usize;
        let event_count = std::env::var("HASHTREE_BENCH_EVENTS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(500usize);
        let authors = (0..author_count)
            .map(|_| Keys::generate())
            .collect::<Vec<_>>();

        println!(
            "starting large dataset benchmark with {} events across {} authors",
            event_count, author_count
        );
        let ingest_start = Instant::now();
        let mut text_note_total = 0usize;
        let mut author_text_note_total = 0usize;
        let mut hashtag_total = 0usize;
        let mut search_total = 0usize;
        for i in 0..event_count {
            let kind = if i % 8 < 5 {
                Kind::TextNote
            } else {
                Kind::Custom(30_023)
            };
            let mut tags = Vec::new();
            if kind == Kind::TextNote && i % 16 == 0 {
                tags.push(Tag::parse(&["t", "hashtree"]).unwrap());
            }
            let content = if kind == Kind::TextNote && i % 32 == 0 {
                format!("benchmark target event {i}")
            } else {
                format!("benchmark event {i}")
            };
            if kind == Kind::TextNote {
                text_note_total += 1;
                if i % author_count == 0 {
                    author_text_note_total += 1;
                }
                if i % 16 == 0 {
                    hashtag_total += 1;
                }
                if i % 32 == 0 {
                    search_total += 1;
                }
            }
            let event = EventBuilder::new(kind, content, tags)
                .custom_created_at(Timestamp::from_secs(1_700_000_000 + i as u64))
                .to_event(&authors[i % author_count])
                .unwrap();
            ingest_parsed_event(&graph_store, &event).unwrap();
        }
        let ingest_duration = ingest_start.elapsed();
        println!("benchmark ingest complete in {:?}", ingest_duration);

        let kind_filter = Filter::new().kind(Kind::TextNote);
        let kind_start = Instant::now();
        let kind_events = query_events(&graph_store, &kind_filter, 200);
        let kind_duration = kind_start.elapsed();
        assert_eq!(kind_events.len(), text_note_total.min(200));
        assert!(kind_events
            .windows(2)
            .all(|window| window[0].created_at >= window[1].created_at));

        let author_filter = Filter::new()
            .author(authors[0].public_key())
            .kind(Kind::TextNote);
        let author_start = Instant::now();
        let author_events = query_events(&graph_store, &author_filter, 50);
        let author_duration = author_start.elapsed();
        assert_eq!(author_events.len(), author_text_note_total.min(50));

        let hashtag_filter = Filter::new().hashtag("hashtree");
        let hashtag_start = Instant::now();
        let hashtag_events = query_events(&graph_store, &hashtag_filter, 100);
        let hashtag_duration = hashtag_start.elapsed();
        assert_eq!(hashtag_events.len(), hashtag_total.min(100));

        let search_filter = Filter::new().kind(Kind::TextNote).search("target");
        let search_start = Instant::now();
        let search_events = query_events(&graph_store, &search_filter, 100);
        let search_duration = search_start.elapsed();
        assert_eq!(search_events.len(), search_total.min(100));

        println!(
            "large dataset benchmark: events={} authors={} ingest={:?} kind={:?} author={:?} hashtag={:?} search={:?}",
            event_count,
            author_count,
            ingest_duration,
            kind_duration,
            author_duration,
            hashtag_duration,
            search_duration
        );
    }

    #[test]
    fn test_ensure_social_graph_mapsize_rounds_and_applies() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        ensure_social_graph_mapsize(tmp.path(), DEFAULT_SOCIALGRAPH_MAP_SIZE_BYTES).unwrap();
        let requested = 70 * 1024 * 1024;
        ensure_social_graph_mapsize(tmp.path(), requested).unwrap();
        let env = unsafe {
            heed::EnvOpenOptions::new()
                .map_size(DEFAULT_SOCIALGRAPH_MAP_SIZE_BYTES as usize)
                .max_dbs(SOCIALGRAPH_MAX_DBS)
                .open(tmp.path())
        }
        .unwrap();
        assert!(env.info().map_size >= requested as usize);
        assert_eq!(env.info().map_size % page_size_bytes(), 0);
    }

    #[test]
    fn test_ingest_events_batches_graph_updates() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();

        let root_keys = Keys::generate();
        let alice_keys = Keys::generate();
        let bob_keys = Keys::generate();

        let root_pk = root_keys.public_key().to_bytes();
        set_social_graph_root(&graph_store, &root_pk);

        let root_follows_alice = EventBuilder::new(
            Kind::ContactList,
            "",
            vec![Tag::public_key(alice_keys.public_key())],
        )
        .custom_created_at(Timestamp::from_secs(10))
        .to_event(&root_keys)
        .unwrap();
        let alice_follows_bob = EventBuilder::new(
            Kind::ContactList,
            "",
            vec![Tag::public_key(bob_keys.public_key())],
        )
        .custom_created_at(Timestamp::from_secs(11))
        .to_event(&alice_keys)
        .unwrap();

        ingest_parsed_events(
            &graph_store,
            &[root_follows_alice.clone(), alice_follows_bob.clone()],
        )
        .unwrap();

        assert_eq!(
            get_follow_distance(&graph_store, &alice_keys.public_key().to_bytes()),
            Some(1)
        );
        assert_eq!(
            get_follow_distance(&graph_store, &bob_keys.public_key().to_bytes()),
            Some(2)
        );

        let filter = Filter::new().kind(Kind::ContactList);
        let stored = query_events(&graph_store, &filter, 10);
        let ids = stored.into_iter().map(|event| event.id).collect::<Vec<_>>();
        assert!(ids.contains(&root_follows_alice.id));
        assert!(ids.contains(&alice_follows_bob.id));
    }

    #[test]
    fn test_ingest_graph_events_updates_graph_without_indexing_events() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let graph_store = open_social_graph_store(tmp.path()).unwrap();

        let root_keys = Keys::generate();
        let alice_keys = Keys::generate();

        let root_pk = root_keys.public_key().to_bytes();
        set_social_graph_root(&graph_store, &root_pk);

        let root_follows_alice = EventBuilder::new(
            Kind::ContactList,
            "",
            vec![Tag::public_key(alice_keys.public_key())],
        )
        .custom_created_at(Timestamp::from_secs(10))
        .to_event(&root_keys)
        .unwrap();

        ingest_graph_parsed_events(&graph_store, std::slice::from_ref(&root_follows_alice))
            .unwrap();

        assert_eq!(
            get_follow_distance(&graph_store, &alice_keys.public_key().to_bytes()),
            Some(1)
        );
        let filter = Filter::new().kind(Kind::ContactList);
        assert!(query_events(&graph_store, &filter, 10).is_empty());
    }
}
