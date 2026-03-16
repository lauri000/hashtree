pub mod access;
pub mod crawler;
pub mod snapshot;

pub use access::SocialGraphAccessControl;
pub use crawler::SocialGraphCrawler;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Context, Result};
use heed::byteorder::BigEndian;
use heed::types::{Bytes, SerdeBincode, Str, Unit, U32, U64};
use heed::{Database, Env, EnvOpenOptions};
use nostr::{Event, Filter, JsonUtil, Kind, TagStandard};

#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};

type UserSet = BTreeSet<[u8; 32]>;

const DEFAULT_MAP_SIZE: u64 = 1_024 * 1_024 * 1_024;
const MAX_FUTURE_EVENT_SECONDS: u64 = 10 * 60;
const ROOT_KEY: &str = "root";

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
    events_by_id: Database<Bytes, Bytes>,
    events_by_author_time: Database<Bytes, Unit>,
    events_by_time: Database<Bytes, Unit>,
    write_lock: StdMutex<()>,
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

pub fn init_ndb_at_path(db_dir: &Path, mapsize_bytes: Option<u64>) -> Result<Arc<Ndb>> {
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
    let events_by_id = env.create_database(&mut wtxn, Some("events_by_id"))?;
    let events_by_author_time = env.create_database(&mut wtxn, Some("events_by_author_time"))?;
    let events_by_time = env.create_database(&mut wtxn, Some("events_by_time"))?;
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
        events_by_id,
        events_by_author_time,
        events_by_time,
        write_lock: StdMutex::new(()),
    }))
}

pub fn set_social_graph_root(ndb: &Ndb, pk_bytes: &[u8; 32]) {
    if let Err(err) = ndb.set_root(pk_bytes) {
        tracing::warn!("Failed to set social graph root: {}", err);
    }
}

pub fn get_follow_distance(ndb: &Ndb, pk_bytes: &[u8; 32]) -> Option<u32> {
    ndb.follow_distance(pk_bytes).ok().flatten()
}

pub fn get_follows(ndb: &Ndb, pk_bytes: &[u8; 32]) -> Vec<[u8; 32]> {
    match ndb.followed_targets(pk_bytes) {
        Ok(set) => set.into_iter().collect(),
        Err(_) => Vec::new(),
    }
}

pub fn is_overmuted(ndb: &Ndb, root_pk: &[u8; 32], user_pk: &[u8; 32], threshold: f64) -> bool {
    if threshold <= 0.0 || user_pk == root_pk {
        return false;
    }

    let followers = match ndb.followers_of(user_pk) {
        Ok(set) => set,
        Err(_) => return false,
    };
    let muters = match ndb.muters_of(user_pk) {
        Ok(set) => set,
        Err(_) => return false,
    };

    if muters.is_empty() {
        return false;
    }

    if let Ok(root_mutes) = ndb.muted_targets(root_pk) {
        if root_mutes.contains(user_pk) {
            return true;
        }
    }

    let mut stats: HashMap<u32, (usize, usize)> = HashMap::new();

    for follower in followers {
        if let Ok(Some(distance)) = ndb.follow_distance(&follower) {
            let entry = stats.entry(distance).or_insert((0, 0));
            entry.0 += 1;
        }
    }

    for muter in muters {
        if let Ok(Some(distance)) = ndb.follow_distance(&muter) {
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

pub fn ingest_event(ndb: &Ndb, _sub_id: &str, event_json: &str) {
    let event = match Event::from_json(event_json) {
        Ok(event) => event,
        Err(_) => return,
    };

    if let Err(err) = ndb.ingest_event(&event) {
        tracing::warn!("Failed to ingest social graph event: {}", err);
    }
}

pub fn ingest_parsed_event(ndb: &Ndb, event: &Event) -> Result<()> {
    ndb.ingest_event(event)
}

pub fn query_events(ndb: &Ndb, filter: &Filter, limit: usize) -> Vec<Event> {
    ndb.query_events(filter, limit).unwrap_or_default()
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
        let event_bytes = rmp_serde::to_vec_named(event).context("encode nostr event")?;
        let event_id = event.id.to_bytes();
        let author = event.pubkey.to_bytes();
        let created_at = event.created_at.as_u64();
        let author_key = author_time_key(&author, created_at, &event_id);
        let time_key = time_key(created_at, &event_id);

        let graph_changed = {
            let _guard = self.write_lock.lock().unwrap();
            let mut wtxn = self.env.write_txn()?;

            if self.events_by_id.get(&wtxn, &event_id[..])?.is_none() {
                self.events_by_id
                    .put(&mut wtxn, &event_id[..], &event_bytes)?;
                self.events_by_author_time
                    .put(&mut wtxn, &author_key, &())?;
                self.events_by_time.put(&mut wtxn, &time_key, &())?;
            }

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

        let rtxn = self.env.read_txn()?;
        let mut candidates = Vec::new();
        let mut seen: HashSet<[u8; 32]> = HashSet::new();

        if let Some(ids) = filter.ids.as_ref() {
            for id in ids {
                let id_bytes = id.to_bytes();
                if let Some(event) = self.load_event(&rtxn, &id_bytes)? {
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
                let prefix = author.to_bytes();
                let mut author_matches = 0usize;
                for entry in self.events_by_author_time.prefix_iter(&rtxn, &prefix[..])? {
                    let (key, _) = entry?;
                    let id_bytes: [u8; 32] = key[40..72]
                        .try_into()
                        .map_err(|_| anyhow::anyhow!("invalid author index key"))?;
                    if !seen.insert(id_bytes) {
                        continue;
                    }
                    if let Some(event) = self.load_event(&rtxn, &id_bytes)? {
                        if filter.match_event(&event) {
                            candidates.push(event);
                            author_matches += 1;
                        }
                    }
                    if author_matches >= limit {
                        break;
                    }
                }
            }
        } else {
            for entry in self.events_by_time.iter(&rtxn)? {
                let (key, _) = entry?;
                let id_bytes: [u8; 32] = key[8..40]
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("invalid time index key"))?;
                if !seen.insert(id_bytes) {
                    continue;
                }
                if let Some(event) = self.load_event(&rtxn, &id_bytes)? {
                    if filter.match_event(&event) {
                        candidates.push(event);
                    }
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

    fn load_event(&self, rtxn: &heed::RoTxn, event_id: &[u8; 32]) -> Result<Option<Event>> {
        let Some(bytes) = self.events_by_id.get(rtxn, &event_id[..])? else {
            return Ok(None);
        };
        let event = rmp_serde::from_slice(bytes).context("decode nostr event")?;
        Ok(Some(event))
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

fn reverse_timestamp(timestamp: u64) -> [u8; 8] {
    (u64::MAX - timestamp).to_be_bytes()
}

fn author_time_key(author: &[u8; 32], timestamp: u64, event_id: &[u8; 32]) -> [u8; 72] {
    let mut key = [0u8; 72];
    key[..32].copy_from_slice(author);
    key[32..40].copy_from_slice(&reverse_timestamp(timestamp));
    key[40..].copy_from_slice(event_id);
    key
}

fn time_key(timestamp: u64, event_id: &[u8; 32]) -> [u8; 40] {
    let mut key = [0u8; 40];
    key[..8].copy_from_slice(&reverse_timestamp(timestamp));
    key[8..].copy_from_slice(event_id);
    key
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
}
