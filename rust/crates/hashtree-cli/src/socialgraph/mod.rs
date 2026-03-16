pub mod access;
pub mod crawler;
pub mod snapshot;

pub use access::SocialGraphAccessControl;
pub use crawler::SocialGraphCrawler;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Context, Result};
use futures::executor::block_on;
use hashtree_core::Cid;
use hashtree_nostr::{ListEventsOptions, NostrEventStore, NostrEventStoreError, StoredNostrEvent};
use heed::byteorder::BigEndian;
use heed::types::{Bytes, SerdeBincode, Str, U32, U64};
use heed::{Database, Env, EnvOpenOptions};
use nostr::{Event, Filter, JsonUtil, Kind, TagStandard};

use crate::storage::{LocalStore, StorageRouter};

#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};

pub type UserSet = BTreeSet<[u8; 32]>;

const DEFAULT_MAP_SIZE: u64 = 1_024 * 1_024 * 1_024;
const MAX_FUTURE_EVENT_SECONDS: u64 = 10 * 60;
const ROOT_KEY: &str = "root";
const EVENTS_ROOT_KEY: &str = "events-root";

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
    env: Env,
    metadata: Database<Str, Bytes>,
    follow_distance_by_user: Database<Bytes, U32<BigEndian>>,
    followed_by_user: Database<Bytes, SerdeBincode<UserSet>>,
    followers_by_user: Database<Bytes, SerdeBincode<UserSet>>,
    follow_list_created_at: Database<Bytes, U64<BigEndian>>,
    muted_by_user: Database<Bytes, SerdeBincode<UserSet>>,
    muters_by_user: Database<Bytes, SerdeBincode<UserSet>>,
    mute_list_created_at: Database<Bytes, U64<BigEndian>>,
    users_by_follow_distance: Database<U32<BigEndian>, SerdeBincode<UserSet>>,
    event_store: NostrEventStore<StorageRouter>,
    write_lock: StdMutex<()>,
}

pub trait SocialGraphBackend: Send + Sync {
    fn stats(&self) -> Result<SocialGraphStats>;
    fn follow_distance(&self, pk_bytes: &[u8; 32]) -> Result<Option<u32>>;
    fn followed_targets(&self, owner: &[u8; 32]) -> Result<UserSet>;
    fn followers_of(&self, owner: &[u8; 32]) -> Result<UserSet>;
    fn muted_targets(&self, owner: &[u8; 32]) -> Result<UserSet>;
    fn muters_of(&self, owner: &[u8; 32]) -> Result<UserSet>;
    fn follow_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>>;
    fn mute_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>>;
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
            .map_err(|err| anyhow::anyhow!("Failed to create social graph blob store: {}", err))?,
    );
    let store = Arc::new(StorageRouter::new(local_store));
    init_ndb_at_path_with_store(db_dir, store, mapsize_bytes)
}

pub fn init_ndb_at_path_with_store(
    db_dir: &Path,
    store: Arc<StorageRouter>,
    mapsize_bytes: Option<u64>,
) -> Result<Arc<Ndb>> {
    std::fs::create_dir_all(db_dir)?;

    let env = unsafe {
        EnvOpenOptions::new()
            .map_size(
                usize::try_from(mapsize_bytes.unwrap_or(DEFAULT_MAP_SIZE)).unwrap_or(usize::MAX),
            )
            .max_dbs(12)
            .open(db_dir)?
    };

    let mut wtxn = env.write_txn()?;
    let metadata = env.create_database(&mut wtxn, Some("metadata"))?;
    let follow_distance_by_user =
        env.create_database(&mut wtxn, Some("follow_distance_by_user"))?;
    let followed_by_user = env.create_database(&mut wtxn, Some("followed_by_user"))?;
    let followers_by_user = env.create_database(&mut wtxn, Some("followers_by_user"))?;
    let follow_list_created_at = env.create_database(&mut wtxn, Some("follow_list_created_at"))?;
    let muted_by_user = env.create_database(&mut wtxn, Some("muted_by_user"))?;
    let muters_by_user = env.create_database(&mut wtxn, Some("muters_by_user"))?;
    let mute_list_created_at = env.create_database(&mut wtxn, Some("mute_list_created_at"))?;
    let users_by_follow_distance =
        env.create_database(&mut wtxn, Some("users_by_follow_distance"))?;
    wtxn.commit()?;

    Ok(Arc::new(Ndb {
        env,
        metadata,
        follow_distance_by_user,
        followed_by_user,
        followers_by_user,
        follow_list_created_at,
        muted_by_user,
        muters_by_user,
        mute_list_created_at,
        users_by_follow_distance,
        event_store: NostrEventStore::new(store),
        write_lock: StdMutex::new(()),
    }))
}

pub fn set_social_graph_root(ndb: &Ndb, pk_bytes: &[u8; 32]) {
    if let Err(err) = ndb.set_root(pk_bytes) {
        tracing::warn!("Failed to set social graph root: {}", err);
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
    root_pk: &[u8; 32],
    user_pk: &[u8; 32],
    threshold: f64,
) -> bool {
    if threshold <= 0.0 || user_pk == root_pk {
        return false;
    }

    let followers = match backend.followers_of(user_pk) {
        Ok(set) => set,
        Err(_) => return false,
    };
    let muters = match backend.muters_of(user_pk) {
        Ok(set) => set,
        Err(_) => return false,
    };

    if muters.is_empty() {
        return false;
    }

    if let Ok(root_mutes) = backend.muted_targets(root_pk) {
        if root_mutes.contains(user_pk) {
            return true;
        }
    }

    let mut stats: HashMap<u32, (usize, usize)> = HashMap::new();

    for follower in followers {
        if let Ok(Some(distance)) = backend.follow_distance(&follower) {
            let entry = stats.entry(distance).or_insert((0, 0));
            entry.0 += 1;
        }
    }

    for muter in muters {
        if let Ok(Some(distance)) = backend.follow_distance(&muter) {
            let entry = stats.entry(distance).or_insert((0, 0));
            entry.1 += 1;
        }
    }

    let mut distances: Vec<u32> = stats.keys().copied().collect();
    distances.sort_unstable();

    for distance in distances {
        let (followers, muters) = stats[&distance];
        if followers + muters > 0 {
            return (muters as f64) * threshold > followers as f64;
        }
    }

    false
}

pub fn ingest_event(backend: &(impl SocialGraphBackend + ?Sized), _sub_id: &str, event_json: &str) {
    let event = match Event::from_json(event_json) {
        Ok(event) => event,
        Err(_) => return,
    };

    if let Err(err) = backend.ingest_event(&event) {
        tracing::warn!("Failed to ingest social graph event: {}", err);
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
        {
            let _guard = self.write_lock.lock().unwrap();
            let mut wtxn = self.env.write_txn()?;
            self.metadata.put(&mut wtxn, ROOT_KEY, &root[..])?;
            wtxn.commit()?;
        }
        self.recalculate_follow_distances()
    }

    fn root(&self) -> Result<Option<[u8; 32]>> {
        let rtxn = self.env.read_txn()?;
        let Some(bytes) = self.metadata.get(&rtxn, ROOT_KEY)? else {
            return Ok(None);
        };
        let root: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid stored social graph root"))?;
        Ok(Some(root))
    }

    fn stats(&self) -> Result<SocialGraphStats> {
        let rtxn = self.env.read_txn()?;

        let root = self
            .metadata
            .get(&rtxn, ROOT_KEY)?
            .map(|bytes| hex::encode(bytes));

        let mut total_follows = 0usize;
        for entry in self.followed_by_user.iter(&rtxn)? {
            let (_, follows) = entry?;
            total_follows += follows.len();
        }

        let mut max_depth = 0u32;
        for entry in self.users_by_follow_distance.iter(&rtxn)? {
            let (distance, _) = entry?;
            max_depth = max_depth.max(distance);
        }

        Ok(SocialGraphStats {
            root,
            total_follows,
            max_depth,
            enabled: true,
        })
    }

    fn ingest_event(&self, event: &Event) -> Result<()> {
        let graph_changed = {
            let _guard = self.write_lock.lock().unwrap();
            let current_root = self.events_root()?;
            let next_root = self.store_event(current_root.as_ref(), event)?;
            let mut wtxn = self.env.write_txn()?;
            self.write_events_root(&mut wtxn, Some(&next_root))?;
            let changed = self.apply_social_graph_event(&mut wtxn, event)?;
            wtxn.commit()?;
            changed
        };

        if graph_changed {
            self.recalculate_follow_distances()?;
        }

        Ok(())
    }

    fn apply_social_graph_event(&self, wtxn: &mut heed::RwTxn, event: &Event) -> Result<bool> {
        if !is_social_graph_event(event.kind) {
            return Ok(false);
        }

        let created_at = event.created_at.as_u64();
        if created_at > unix_now().saturating_add(MAX_FUTURE_EVENT_SECONDS) {
            return Ok(false);
        }

        let author = event.pubkey.to_bytes();
        let targets = collect_tagged_pubkeys(event);

        if event.kind == Kind::ContactList {
            let current_ts = self.follow_list_created_at.get(&*wtxn, &author[..])?;
            if current_ts.is_some_and(|ts| created_at <= ts) {
                return Ok(false);
            }

            let current_targets = self
                .followed_by_user
                .get(&*wtxn, &author[..])?
                .unwrap_or_default();

            self.follow_list_created_at
                .put(wtxn, &author[..], &created_at)?;

            for removed in current_targets.difference(&targets) {
                self.remove_from_user_set(wtxn, &self.followers_by_user, removed, &author)?;
            }

            for added in targets.difference(&current_targets) {
                self.add_to_user_set(wtxn, &self.followers_by_user, added, &author)?;
            }

            put_or_delete_set(wtxn, &self.followed_by_user, &author, &targets)?;

            return Ok(current_targets != targets);
        }

        let current_ts = self.mute_list_created_at.get(&*wtxn, &author[..])?;
        if current_ts.is_some_and(|ts| created_at <= ts) {
            return Ok(false);
        }

        let current_targets = self
            .muted_by_user
            .get(&*wtxn, &author[..])?
            .unwrap_or_default();

        self.mute_list_created_at
            .put(wtxn, &author[..], &created_at)?;

        for removed in current_targets.difference(&targets) {
            self.remove_from_user_set(wtxn, &self.muters_by_user, removed, &author)?;
        }

        for added in targets.difference(&current_targets) {
            self.add_to_user_set(wtxn, &self.muters_by_user, added, &author)?;
        }

        put_or_delete_set(wtxn, &self.muted_by_user, &author, &targets)?;

        Ok(false)
    }

    fn add_to_user_set(
        &self,
        wtxn: &mut heed::RwTxn,
        db: &Database<Bytes, SerdeBincode<UserSet>>,
        owner: &[u8; 32],
        value: &[u8; 32],
    ) -> Result<()> {
        let mut set = db.get(&*wtxn, &owner[..])?.unwrap_or_default();
        set.insert(*value);
        db.put(wtxn, &owner[..], &set)?;
        Ok(())
    }

    fn remove_from_user_set(
        &self,
        wtxn: &mut heed::RwTxn,
        db: &Database<Bytes, SerdeBincode<UserSet>>,
        owner: &[u8; 32],
        value: &[u8; 32],
    ) -> Result<()> {
        let Some(mut set) = db.get(&*wtxn, &owner[..])? else {
            return Ok(());
        };

        set.remove(value);
        if set.is_empty() {
            db.delete(wtxn, &owner[..])?;
        } else {
            db.put(wtxn, &owner[..], &set)?;
        }
        Ok(())
    }

    fn recalculate_follow_distances(&self) -> Result<()> {
        let Some(root) = self.root()? else {
            return Ok(());
        };

        let rtxn = self.env.read_txn()?;
        let mut distances: BTreeMap<[u8; 32], u32> = BTreeMap::new();
        let mut users_by_distance: BTreeMap<u32, UserSet> = BTreeMap::new();
        let mut queue = VecDeque::new();

        distances.insert(root, 0);
        users_by_distance.entry(0).or_default().insert(root);
        queue.push_back(root);

        while let Some(owner) = queue.pop_front() {
            let distance = distances[&owner];
            if let Some(targets) = self.followed_by_user.get(&rtxn, &owner[..])? {
                for target in targets {
                    if distances.contains_key(&target) {
                        continue;
                    }
                    let next_distance = distance + 1;
                    distances.insert(target, next_distance);
                    users_by_distance
                        .entry(next_distance)
                        .or_default()
                        .insert(target);
                    queue.push_back(target);
                }
            }
        }
        drop(rtxn);

        let _guard = self.write_lock.lock().unwrap();
        let mut wtxn = self.env.write_txn()?;
        self.follow_distance_by_user.clear(&mut wtxn)?;
        self.users_by_follow_distance.clear(&mut wtxn)?;

        for (user, distance) in distances {
            self.follow_distance_by_user
                .put(&mut wtxn, &user[..], &distance)?;
        }

        for (distance, users) in users_by_distance {
            self.users_by_follow_distance
                .put(&mut wtxn, &distance, &users)?;
        }

        wtxn.commit()?;
        Ok(())
    }

    fn follow_distance(&self, pk_bytes: &[u8; 32]) -> Result<Option<u32>> {
        let rtxn = self.env.read_txn()?;
        Ok(self.follow_distance_by_user.get(&rtxn, &pk_bytes[..])?)
    }

    fn followed_targets(&self, owner: &[u8; 32]) -> Result<UserSet> {
        let rtxn = self.env.read_txn()?;
        Ok(self
            .followed_by_user
            .get(&rtxn, &owner[..])?
            .unwrap_or_default())
    }

    fn followers_of(&self, owner: &[u8; 32]) -> Result<UserSet> {
        let rtxn = self.env.read_txn()?;
        Ok(self
            .followers_by_user
            .get(&rtxn, &owner[..])?
            .unwrap_or_default())
    }

    fn muted_targets(&self, owner: &[u8; 32]) -> Result<UserSet> {
        let rtxn = self.env.read_txn()?;
        Ok(self
            .muted_by_user
            .get(&rtxn, &owner[..])?
            .unwrap_or_default())
    }

    fn muters_of(&self, owner: &[u8; 32]) -> Result<UserSet> {
        let rtxn = self.env.read_txn()?;
        Ok(self
            .muters_by_user
            .get(&rtxn, &owner[..])?
            .unwrap_or_default())
    }

    fn follow_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>> {
        let rtxn = self.env.read_txn()?;
        Ok(self.follow_list_created_at.get(&rtxn, &owner[..])?)
    }

    fn mute_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>> {
        let rtxn = self.env.read_txn()?;
        Ok(self.mute_list_created_at.get(&rtxn, &owner[..])?)
    }

    fn query_events(&self, filter: &Filter, limit: usize) -> Result<Vec<Event>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let root = self.events_root()?;
        let Some(root) = root.as_ref() else {
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
        let rtxn = self.env.read_txn()?;
        let Some(bytes) = self.metadata.get(&rtxn, EVENTS_ROOT_KEY)? else {
            return Ok(None);
        };
        decode_cid(bytes)
    }

    fn write_events_root(&self, wtxn: &mut heed::RwTxn, root: Option<&Cid>) -> Result<()> {
        let Some(root) = root else {
            self.metadata.delete(wtxn, EVENTS_ROOT_KEY)?;
            return Ok(());
        };
        let encoded = encode_cid(root)?;
        self.metadata.put(wtxn, EVENTS_ROOT_KEY, &encoded)?;
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

    fn followers_of(&self, owner: &[u8; 32]) -> Result<UserSet> {
        Ndb::followers_of(self, owner)
    }

    fn muted_targets(&self, owner: &[u8; 32]) -> Result<UserSet> {
        Ndb::muted_targets(self, owner)
    }

    fn muters_of(&self, owner: &[u8; 32]) -> Result<UserSet> {
        Ndb::muters_of(self, owner)
    }

    fn follow_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>> {
        Ndb::follow_list_created_at(self, owner)
    }

    fn mute_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>> {
        Ndb::mute_list_created_at(self, owner)
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

    fn followers_of(&self, owner: &[u8; 32]) -> Result<UserSet> {
        self.as_ref().followers_of(owner)
    }

    fn muted_targets(&self, owner: &[u8; 32]) -> Result<UserSet> {
        self.as_ref().muted_targets(owner)
    }

    fn muters_of(&self, owner: &[u8; 32]) -> Result<UserSet> {
        self.as_ref().muters_of(owner)
    }

    fn follow_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>> {
        self.as_ref().follow_list_created_at(owner)
    }

    fn mute_list_created_at(&self, owner: &[u8; 32]) -> Result<Option<u64>> {
        self.as_ref().mute_list_created_at(owner)
    }

    fn ingest_event(&self, event: &Event) -> Result<()> {
        self.as_ref().ingest_event(event)
    }

    fn query_events(&self, filter: &Filter, limit: usize) -> Result<Vec<Event>> {
        self.as_ref().query_events(filter, limit)
    }
}

fn put_or_delete_set(
    wtxn: &mut heed::RwTxn,
    db: &Database<Bytes, SerdeBincode<UserSet>>,
    owner: &[u8; 32],
    set: &UserSet,
) -> Result<()> {
    if set.is_empty() {
        db.delete(wtxn, &owner[..])?;
    } else {
        db.put(wtxn, &owner[..], set)?;
    }
    Ok(())
}

fn collect_tagged_pubkeys(event: &Event) -> UserSet {
    let author = event.pubkey.to_bytes();
    let mut targets = UserSet::new();

    for tag in event.tags.iter() {
        if let Some(TagStandard::PublicKey { public_key, .. }) = tag.as_standardized() {
            let target = public_key.to_bytes();
            if target != author {
                targets.insert(target);
            }
        }
    }

    targets
}

fn is_social_graph_event(kind: Kind) -> bool {
    kind == Kind::ContactList || kind == Kind::MuteList
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
    anyhow::anyhow!("nostr event store error: {}", err)
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
