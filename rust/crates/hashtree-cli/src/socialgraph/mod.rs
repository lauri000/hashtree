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
use nostr::{Event, Filter, JsonUtil, Kind};
use nostr_social_graph::{
    BinaryBudget, GraphStats, NostrEvent as GraphEvent, SocialGraph,
    SocialGraphBackend as NostrSocialGraphBackend,
};
use nostr_social_graph_heed::HeedSocialGraph;

use crate::storage::{LocalStore, StorageRouter};

#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};

pub type UserSet = BTreeSet<[u8; 32]>;

const DEFAULT_ROOT_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const EVENTS_ROOT_FILE: &str = "events-root.msgpack";
const UNKNOWN_FOLLOW_DISTANCE: u32 = 1000;
const DEFAULT_SOCIALGRAPH_MAP_SIZE_BYTES: u64 = 64 * 1024 * 1024;
const SOCIALGRAPH_MAX_DBS: u32 = 16;

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
    event_store: NostrEventStore<StorageRouter>,
    events_root_path: PathBuf,
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
    fn ingest_events(&self, events: &[Event]) -> Result<()> {
        for event in events {
            self.ingest_event(event)?;
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
    std::fs::create_dir_all(db_dir)?;
    if let Some(size) = mapsize_bytes {
        ensure_social_graph_mapsize(db_dir, size)?;
    }
    let graph = HeedSocialGraph::open(db_dir, DEFAULT_ROOT_HEX)
        .context("open nostr-social-graph heed backend")?;

    Ok(Arc::new(SocialGraphStore {
        graph: StdMutex::new(graph),
        distance_cache: StdMutex::new(None),
        event_store: NostrEventStore::new(store),
        events_root_path: db_dir.join(EVENTS_ROOT_FILE),
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

pub fn ingest_parsed_events(
    backend: &(impl SocialGraphBackend + ?Sized),
    events: &[Event],
) -> Result<()> {
    backend.ingest_events(events)
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
        let current_root = self.events_root()?;
        let next_root = self.store_event(current_root.as_ref(), event)?;
        self.write_events_root(Some(&next_root))?;

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

    fn ingest_events(&self, events: &[Event]) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }

        let mut current_root = self.events_root()?;
        for event in events {
            let next_root = self.store_event(current_root.as_ref(), event)?;
            current_root = Some(next_root);
        }
        self.write_events_root(current_root.as_ref())?;

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
        } else if let Some(authors) = filter.authors.as_ref() {
            for author in authors {
                let mut author_matches = 0usize;
                for event in self.load_events_for_author(root, author, filter)? {
                    let id_bytes = event.id.to_bytes();
                    if !seen.insert(id_bytes) {
                        continue;
                    }
                    if filter.match_event(&event) {
                        candidates.push(event);
                        author_matches += 1;
                    }
                    if author_matches >= limit {
                        break;
                    }
                }
            }
        } else {
            for event in self.load_recent_events(root)? {
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

    fn events_root(&self) -> Result<Option<Cid>> {
        let Ok(bytes) = std::fs::read(&self.events_root_path) else {
            return Ok(None);
        };
        decode_cid(&bytes)
    }

    fn write_events_root(&self, root: Option<&Cid>) -> Result<()> {
        let Some(root) = root else {
            if self.events_root_path.exists() {
                std::fs::remove_file(&self.events_root_path)?;
            }
            return Ok(());
        };

        let encoded = encode_cid(root)?;
        let tmp_path = self.events_root_path.with_extension("tmp");
        std::fs::write(&tmp_path, encoded)?;
        std::fs::rename(tmp_path, &self.events_root_path)?;
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
    ) -> Result<Vec<Event>> {
        let kind_filter = filter.kinds.as_ref().and_then(|kinds| {
            if kinds.len() == 1 {
                kinds.iter().next().map(|kind| kind.as_u16() as u32)
            } else {
                None
            }
        });
        let author_hex = author.to_hex();
        let stored = match kind_filter {
            Some(kind) => block_on(self.event_store.list_by_author_and_kind(
                Some(root),
                &author_hex,
                kind,
                ListEventsOptions::default(),
            ))
            .map_err(map_event_store_error)?,
            None => block_on(self.event_store.list_by_author(
                Some(root),
                &author_hex,
                ListEventsOptions::default(),
            ))
            .map_err(map_event_store_error)?,
        };
        stored
            .into_iter()
            .map(nostr_event_from_stored)
            .collect::<Result<Vec<_>>>()
    }

    fn load_recent_events(&self, root: &Cid) -> Result<Vec<Event>> {
        let stored = block_on(
            self.event_store
                .list_recent(Some(root), ListEventsOptions::default()),
        )
        .map_err(map_event_store_error)?;
        stored
            .into_iter()
            .map(nostr_event_from_stored)
            .collect::<Result<Vec<_>>>()
    }
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

    fn ingest_events(&self, events: &[Event]) -> Result<()> {
        SocialGraphStore::ingest_events(self, events)
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

    fn ingest_events(&self, events: &[Event]) -> Result<()> {
        self.as_ref().ingest_events(events)
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
