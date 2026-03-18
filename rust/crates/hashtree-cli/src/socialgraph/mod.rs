pub mod access;
pub mod crawler;
pub mod snapshot;

pub use access::SocialGraphAccessControl;
pub use crawler::SocialGraphCrawler;

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Context, Result};
use bytes::Bytes;
use futures::executor::block_on;
use hashtree_core::Cid;
use hashtree_nostr::{ListEventsOptions, NostrEventStore, NostrEventStoreError, StoredNostrEvent};
use nostr::{Event, Filter, JsonUtil, Kind};
use nostr_social_graph::{BinaryBudget, GraphStats, NostrEvent as GraphEvent, SocialGraph};
use nostr_social_graph_heed::HeedSocialGraph;

use crate::storage::{LocalStore, StorageRouter};

#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};

pub type UserSet = BTreeSet<[u8; 32]>;

const DEFAULT_ROOT_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const EVENTS_ROOT_FILE: &str = "events-root.msgpack";
const UNKNOWN_FOLLOW_DISTANCE: u32 = 1000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredCid {
    hash: [u8; 32],
    key: Option<[u8; 32]>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SocialGraphStats {
    pub root: Option<String>,
    pub total_follows: usize,
    pub max_depth: u32,
    pub enabled: bool,
}

pub struct Ndb {
    graph: StdMutex<HeedSocialGraph>,
    event_store: NostrEventStore<StorageRouter>,
    events_root_path: PathBuf,
}

pub trait SocialGraphBackend: Send + Sync {
    fn stats(&self) -> Result<SocialGraphStats>;
    fn follow_distance(&self, pk_bytes: &[u8; 32]) -> Result<Option<u32>>;
    fn followed_targets(&self, owner: &[u8; 32]) -> Result<UserSet>;
    fn is_overmuted_user(&self, user_pk: &[u8; 32], threshold: f64) -> Result<bool>;
    fn snapshot_chunks(&self, root: &[u8; 32], options: &BinaryBudget) -> Result<Vec<Bytes>>;
    fn ingest_event(&self, event: &Event) -> Result<()>;
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

pub fn init_ndb(data_dir: &Path) -> Result<Arc<Ndb>> {
    init_ndb_with_mapsize(data_dir, None)
}

pub fn init_ndb_with_mapsize(data_dir: &Path, mapsize_bytes: Option<u64>) -> Result<Arc<Ndb>> {
    let db_dir = data_dir.join("socialgraph");
    init_ndb_at_path(&db_dir, mapsize_bytes)
}

pub fn init_ndb_with_store(
    data_dir: &Path,
    store: Arc<StorageRouter>,
    mapsize_bytes: Option<u64>,
) -> Result<Arc<Ndb>> {
    let db_dir = data_dir.join("socialgraph");
    init_ndb_at_path_with_store(&db_dir, store, mapsize_bytes)
}

pub fn init_ndb_at_path(db_dir: &Path, mapsize_bytes: Option<u64>) -> Result<Arc<Ndb>> {
    let config = hashtree_config::Config::load_or_default();
    let backend = &config.storage.backend;
    let local_store = Arc::new(
        LocalStore::new(db_dir.join("blobs"), backend)
            .map_err(|err| anyhow::anyhow!("Failed to create social graph blob store: {err}"))?,
    );
    let store = Arc::new(StorageRouter::new(local_store));
    init_ndb_at_path_with_store(db_dir, store, mapsize_bytes)
}

pub fn init_ndb_at_path_with_store(
    db_dir: &Path,
    store: Arc<StorageRouter>,
    _mapsize_bytes: Option<u64>,
) -> Result<Arc<Ndb>> {
    std::fs::create_dir_all(db_dir)?;
    let graph = HeedSocialGraph::open(db_dir, DEFAULT_ROOT_HEX)
        .context("open nostr-social-graph heed backend")?;

    Ok(Arc::new(Ndb {
        graph: StdMutex::new(graph),
        event_store: NostrEventStore::new(store),
        events_root_path: db_dir.join(EVENTS_ROOT_FILE),
    }))
}

pub fn set_social_graph_root(ndb: &Ndb, pk_bytes: &[u8; 32]) {
    if let Err(err) = ndb.set_root(pk_bytes) {
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

pub fn query_events(
    backend: &(impl SocialGraphBackend + ?Sized),
    filter: &Filter,
    limit: usize,
) -> Vec<Event> {
    backend.query_events(filter, limit).unwrap_or_default()
}

impl Ndb {
    fn set_root(&self, root: &[u8; 32]) -> Result<()> {
        let root_hex = hex::encode(root);
        let mut graph = self.graph.lock().unwrap();
        if should_replace_placeholder_root(&graph)? {
            let fresh = SocialGraph::new(&root_hex);
            graph
                .replace_state(&fresh.export_state())
                .context("replace placeholder social graph root")?;
            return Ok(());
        }
        graph
            .set_root(&root_hex)
            .context("set nostr-social-graph root")?;
        Ok(())
    }

    fn stats(&self) -> Result<SocialGraphStats> {
        let graph = self.graph.lock().unwrap();
        let stats = graph.size().context("read social graph stats")?;
        Ok(SocialGraphStats {
            root: Some(graph.get_root().context("read social graph root")?),
            total_follows: stats.follows,
            max_depth: stats
                .size_by_distance
                .keys()
                .copied()
                .max()
                .unwrap_or_default(),
            enabled: true,
        })
    }

    fn follow_distance(&self, pk_bytes: &[u8; 32]) -> Result<Option<u32>> {
        let graph = self.graph.lock().unwrap();
        let distance = graph
            .get_follow_distance(&hex::encode(pk_bytes))
            .context("read social graph follow distance")?;
        Ok((distance != UNKNOWN_FOLLOW_DISTANCE).then_some(distance))
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
        let mut graph = self.graph.lock().unwrap();
        let current_root = self.events_root()?;
        let next_root = self.store_event(current_root.as_ref(), event)?;
        self.write_events_root(Some(&next_root))?;

        if is_social_graph_event(event.kind) {
            graph
                .handle_event(&graph_event_from_nostr(event), true, 0.0)
                .context("ingest social graph event into nostr-social-graph")?;
        }

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

impl SocialGraphBackend for Ndb {
    fn stats(&self) -> Result<SocialGraphStats> {
        Ndb::stats(self)
    }

    fn follow_distance(&self, pk_bytes: &[u8; 32]) -> Result<Option<u32>> {
        Ndb::follow_distance(self, pk_bytes)
    }

    fn followed_targets(&self, owner: &[u8; 32]) -> Result<UserSet> {
        Ndb::followed_targets(self, owner)
    }

    fn is_overmuted_user(&self, user_pk: &[u8; 32], threshold: f64) -> Result<bool> {
        Ndb::is_overmuted_user(self, user_pk, threshold)
    }

    fn snapshot_chunks(&self, root: &[u8; 32], options: &BinaryBudget) -> Result<Vec<Bytes>> {
        Ndb::snapshot_chunks(self, root, options)
    }

    fn ingest_event(&self, event: &Event) -> Result<()> {
        Ndb::ingest_event(self, event)
    }

    fn query_events(&self, filter: &Filter, limit: usize) -> Result<Vec<Event>> {
        Ndb::query_events(self, filter, limit)
    }
}

impl<T> SocialGraphBackend for Arc<T>
where
    T: SocialGraphBackend + ?Sized,
{
    fn stats(&self) -> Result<SocialGraphStats> {
        self.as_ref().stats()
    }

    fn follow_distance(&self, pk_bytes: &[u8; 32]) -> Result<Option<u32>> {
        self.as_ref().follow_distance(pk_bytes)
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

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, JsonUtil, Keys, Tag, Timestamp};
    use tempfile::TempDir;

    #[test]
    fn test_init_ndb() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = init_ndb(tmp.path()).unwrap();
        assert_eq!(Arc::strong_count(&ndb), 1);
    }

    #[test]
    fn test_set_root_and_get_follow_distance() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = init_ndb(tmp.path()).unwrap();
        let root_pk = [1u8; 32];
        set_social_graph_root(&ndb, &root_pk);
        assert_eq!(get_follow_distance(&ndb, &root_pk), Some(0));
    }

    #[test]
    fn test_ingest_event_updates_follows_and_mutes() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = init_ndb(tmp.path()).unwrap();

        let root_keys = Keys::generate();
        let alice_keys = Keys::generate();
        let bob_keys = Keys::generate();

        let root_pk = root_keys.public_key().to_bytes();
        set_social_graph_root(&ndb, &root_pk);

        let follow = EventBuilder::new(
            Kind::ContactList,
            "",
            vec![Tag::public_key(alice_keys.public_key())],
        )
        .custom_created_at(Timestamp::from_secs(10))
        .to_event(&root_keys)
        .unwrap();
        ingest_event(&ndb, "follow", &follow.as_json());

        let mute = EventBuilder::new(
            Kind::MuteList,
            "",
            vec![Tag::public_key(bob_keys.public_key())],
        )
        .custom_created_at(Timestamp::from_secs(11))
        .to_event(&root_keys)
        .unwrap();
        ingest_event(&ndb, "mute", &mute.as_json());

        assert_eq!(
            get_follow_distance(&ndb, &alice_keys.public_key().to_bytes()),
            Some(1)
        );
        assert!(is_overmuted(
            &ndb,
            &root_pk,
            &bob_keys.public_key().to_bytes(),
            1.0
        ));
    }

    #[test]
    fn test_query_events_by_author() {
        let _guard = test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = init_ndb(tmp.path()).unwrap();
        let keys = Keys::generate();

        let older = EventBuilder::new(Kind::TextNote, "older", [])
            .custom_created_at(Timestamp::from_secs(5))
            .to_event(&keys)
            .unwrap();
        let newer = EventBuilder::new(Kind::TextNote, "newer", [])
            .custom_created_at(Timestamp::from_secs(6))
            .to_event(&keys)
            .unwrap();

        ingest_parsed_event(&ndb, &older).unwrap();
        ingest_parsed_event(&ndb, &newer).unwrap();

        let filter = Filter::new().author(keys.public_key()).kind(Kind::TextNote);
        let events = query_events(&ndb, &filter, 10);
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
            let ndb = init_ndb_at_path(&db_dir, None).unwrap();
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

            ingest_parsed_event(&ndb, &older).unwrap();
            ingest_parsed_event(&ndb, &newer).unwrap();
            ingest_parsed_event(&ndb, &latest).unwrap();
        }

        let reopened = init_ndb_at_path(&db_dir, None).unwrap();

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
}
