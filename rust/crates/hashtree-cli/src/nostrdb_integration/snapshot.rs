use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{Context, Result};
use bytes::{Bytes, BytesMut};
use nostr::{Filter, Kind, PublicKey, Timestamp};
use nostrdb_social::{Filter as NdbFilter, Transaction};

use super::Ndb;

const BINARY_FORMAT_VERSION: u64 = 2;
const CHUNK_SIZE: usize = 16 * 1024;
const MAX_MUTE_FETCH: usize = 100_000;

#[derive(Debug, Clone, Copy, Default)]
pub struct SnapshotOptions {
    pub max_nodes: Option<usize>,
    pub max_edges: Option<usize>,
    pub max_distance: Option<u32>,
    pub max_edges_per_node: Option<usize>,
}

#[derive(Debug, Clone)]
struct SnapshotData {
    used_order: Vec<[u8; 32]>,
    follow_owners: Vec<[u8; 32]>,
    mute_owners: Vec<[u8; 32]>,
    follow_targets: HashMap<[u8; 32], Vec<[u8; 32]>>,
    mute_targets: HashMap<[u8; 32], Vec<[u8; 32]>>,
    follow_created_at: HashMap<[u8; 32], u64>,
    mute_created_at: HashMap<[u8; 32], u64>,
}

pub fn build_snapshot_chunks(ndb: &Ndb, root: &[u8; 32], options: &SnapshotOptions) -> Result<Vec<Bytes>> {
    let data = build_snapshot_data(ndb, root, options)?;
    Ok(encode_snapshot_chunks(&data))
}

fn build_snapshot_data(ndb: &Ndb, root: &[u8; 32], options: &SnapshotOptions) -> Result<SnapshotData> {
    let txn = Transaction::new(ndb).context("create nostrdb transaction")?;

    let users_by_distance = compute_users_by_distance(&txn, ndb, root, options.max_distance);

    let mut follow_cache: HashMap<[u8; 32], Vec<[u8; 32]>> = HashMap::new();
    let mut mute_cache: HashMap<[u8; 32], Vec<[u8; 32]>> = HashMap::new();

    let mut used_nodes: HashSet<[u8; 32]> = HashSet::new();
    let mut used_order: Vec<[u8; 32]> = Vec::new();

    let mut follow_targets: HashMap<[u8; 32], Vec<[u8; 32]>> = HashMap::new();
    let mut mute_targets: HashMap<[u8; 32], Vec<[u8; 32]>> = HashMap::new();
    let mut follow_owners: Vec<[u8; 32]> = Vec::new();
    let mut mute_owners: Vec<[u8; 32]> = Vec::new();
    let mut follow_owner_set: HashSet<[u8; 32]> = HashSet::new();
    let mut mute_owner_set: HashSet<[u8; 32]> = HashSet::new();

    let mut edge_count: usize = 0;

    'edges: for (distance, owners) in users_by_distance {
        if let Some(max_distance) = options.max_distance {
            if distance > max_distance {
                break;
            }
        }

        for owner in owners {
            let mut owner_edge_count: usize = 0;
            let mut per_node_limit_reached = false;

            let follows = get_followed_cached(&txn, ndb, &mut follow_cache, &owner);
            for target in follows {
                if let Some(limit) = options.max_edges_per_node {
                    if owner_edge_count >= limit {
                        per_node_limit_reached = true;
                        break;
                    }
                }

                if let Some(max_edges) = options.max_edges {
                    if edge_count >= max_edges {
                        break 'edges;
                    }
                }

                if let Some(max_nodes) = options.max_nodes {
                    let mut new_nodes = 0usize;
                    if !used_nodes.contains(&owner) {
                        new_nodes += 1;
                    }
                    if !used_nodes.contains(&target) {
                        new_nodes += 1;
                    }
                    if used_nodes.len() + new_nodes > max_nodes {
                        break 'edges;
                    }
                }

                if used_nodes.insert(owner) {
                    used_order.push(owner);
                }
                if used_nodes.insert(target) {
                    used_order.push(target);
                }

                follow_targets.entry(owner).or_default().push(target);
                if follow_owner_set.insert(owner) {
                    follow_owners.push(owner);
                }

                edge_count += 1;
                owner_edge_count += 1;
            }

            if per_node_limit_reached {
                continue;
            }

            let mutes = get_muted_cached(
                &txn,
                ndb,
                &mut mute_cache,
                &owner,
                options.max_edges_per_node,
            );
            for target in mutes {
                if let Some(limit) = options.max_edges_per_node {
                    if owner_edge_count >= limit {
                        break;
                    }
                }

                if let Some(max_edges) = options.max_edges {
                    if edge_count >= max_edges {
                        break 'edges;
                    }
                }

                if let Some(max_nodes) = options.max_nodes {
                    let mut new_nodes = 0usize;
                    if !used_nodes.contains(&owner) {
                        new_nodes += 1;
                    }
                    if !used_nodes.contains(&target) {
                        new_nodes += 1;
                    }
                    if used_nodes.len() + new_nodes > max_nodes {
                        break 'edges;
                    }
                }

                if used_nodes.insert(owner) {
                    used_order.push(owner);
                }
                if used_nodes.insert(target) {
                    used_order.push(target);
                }

                mute_targets.entry(owner).or_default().push(target);
                if mute_owner_set.insert(owner) {
                    mute_owners.push(owner);
                }

                edge_count += 1;
                owner_edge_count += 1;
            }
        }
    }

    let mut follow_created_at = HashMap::new();
    let mut mute_created_at = HashMap::new();
    for owner in &follow_owners {
        let ts = latest_created_at(&txn, ndb, owner, Kind::ContactList).unwrap_or(0);
        follow_created_at.insert(*owner, ts);
    }
    for owner in &mute_owners {
        let ts = latest_created_at(&txn, ndb, owner, Kind::MuteList).unwrap_or(0);
        mute_created_at.insert(*owner, ts);
    }

    Ok(SnapshotData {
        used_order,
        follow_owners,
        mute_owners,
        follow_targets,
        mute_targets,
        follow_created_at,
        mute_created_at,
    })
}

fn compute_users_by_distance(
    txn: &Transaction,
    ndb: &Ndb,
    root: &[u8; 32],
    max_distance: Option<u32>,
) -> BTreeMap<u32, Vec<[u8; 32]>> {
    let mut visited: HashSet<[u8; 32]> = HashSet::new();
    let mut by_distance: BTreeMap<u32, Vec<[u8; 32]>> = BTreeMap::new();

    let mut current: Vec<[u8; 32]> = vec![*root];
    visited.insert(*root);
    by_distance.insert(0, current.clone());

    let mut depth: u32 = 0;
    loop {
        if let Some(max_distance) = max_distance {
            if depth >= max_distance {
                break;
            }
        }

        if current.is_empty() {
            break;
        }

        let mut next: Vec<[u8; 32]> = Vec::new();
        for owner in &current {
            let follows = get_followed_full(txn, ndb, owner);
            for target in follows {
                if visited.insert(target) {
                    next.push(target);
                }
            }
        }

        depth += 1;
        if !next.is_empty() {
            by_distance.insert(depth, next.clone());
        }
        current = next;
    }

    by_distance
}

fn get_followed_cached(
    txn: &Transaction,
    ndb: &Ndb,
    cache: &mut HashMap<[u8; 32], Vec<[u8; 32]>>,
    owner: &[u8; 32],
) -> Vec<[u8; 32]> {
    if let Some(existing) = cache.get(owner) {
        return existing.clone();
    }
    let follows = get_followed_full(txn, ndb, owner);
    cache.insert(*owner, follows.clone());
    follows
}

fn get_muted_cached(
    txn: &Transaction,
    ndb: &Ndb,
    cache: &mut HashMap<[u8; 32], Vec<[u8; 32]>>,
    owner: &[u8; 32],
    max_edges_per_node: Option<usize>,
) -> Vec<[u8; 32]> {
    if let Some(existing) = cache.get(owner) {
        return existing.clone();
    }
    let mutes = get_muted_full(txn, ndb, owner, max_edges_per_node);
    cache.insert(*owner, mutes.clone());
    mutes
}

fn get_followed_full(txn: &Transaction, ndb: &Ndb, owner: &[u8; 32]) -> Vec<[u8; 32]> {
    let count = nostrdb_social::socialgraph::followed_count(txn, ndb, owner);
    let max = count.min(i32::MAX as usize);
    nostrdb_social::socialgraph::get_followed(txn, ndb, owner, max)
}

fn get_muted_full(
    txn: &Transaction,
    ndb: &Ndb,
    owner: &[u8; 32],
    max_edges_per_node: Option<usize>,
) -> Vec<[u8; 32]> {
    if let Some(limit) = max_edges_per_node {
        let capped = limit.min(i32::MAX as usize);
        return nostrdb_social::socialgraph::get_muted(txn, ndb, owner, capped);
    }

    let mut max_out = 1024usize.min(MAX_MUTE_FETCH);
    loop {
        let mutes = nostrdb_social::socialgraph::get_muted(txn, ndb, owner, max_out);
        if mutes.len() < max_out || max_out >= MAX_MUTE_FETCH {
            return mutes;
        }
        max_out = (max_out * 2).min(MAX_MUTE_FETCH);
    }
}

fn latest_created_at(
    txn: &Transaction,
    ndb: &Ndb,
    owner: &[u8; 32],
    kind: Kind,
) -> Result<u64> {
    let pubkey = match PublicKey::from_slice(owner) {
        Ok(pk) => pk,
        Err(_) => return Ok(0),
    };

    let mut max_seen = 0u64;
    let mut since = 0u64;
    let max_results = 512usize;

    loop {
        let filter = Filter::new()
            .author(pubkey)
            .kind(kind)
            .since(Timestamp::from_secs(since))
            .limit(max_results);
        let filter_json = serde_json::to_string(&filter).context("serialize filter")?;
        let ndb_filter = NdbFilter::from_json(&filter_json).context("build nostrdb filter")?;

        let results = ndb
            .query(txn, &[ndb_filter], max_results as i32)
            .context("query nostrdb")?;

        if results.is_empty() {
            break;
        }

        for result in &results {
            let ts = result.note.created_at();
            if ts > max_seen {
                max_seen = ts;
            }
        }

        if results.len() < max_results {
            break;
        }

        if max_seen >= since {
            since = max_seen.saturating_add(1);
        } else {
            break;
        }
    }

    Ok(max_seen)
}

fn encode_snapshot_chunks(data: &SnapshotData) -> Vec<Bytes> {
    let mut id_map: HashMap<[u8; 32], u32> = HashMap::new();
    for (idx, pk) in data.used_order.iter().enumerate() {
        id_map.insert(*pk, idx as u32);
    }

    let mut writer = ChunkWriter::new();
    writer.write_varint(BINARY_FORMAT_VERSION);

    writer.write_varint(data.used_order.len() as u64);
    for (idx, pk) in data.used_order.iter().enumerate() {
        writer.write_bytes(pk);
        writer.write_varint(idx as u64);
    }

    writer.write_varint(data.follow_owners.len() as u64);
    for owner in &data.follow_owners {
        let owner_id = id_map.get(owner).copied().unwrap_or_default();
        let ts = data.follow_created_at.get(owner).copied().unwrap_or(0);
        let targets = data.follow_targets.get(owner).cloned().unwrap_or_default();

        writer.write_varint(owner_id as u64);
        writer.write_varint(ts);
        writer.write_varint(targets.len() as u64);
        for target in targets {
            let target_id = id_map.get(&target).copied().unwrap_or_default();
            writer.write_varint(target_id as u64);
        }
    }

    writer.write_varint(data.mute_owners.len() as u64);
    for owner in &data.mute_owners {
        let owner_id = id_map.get(owner).copied().unwrap_or_default();
        let ts = data.mute_created_at.get(owner).copied().unwrap_or(0);
        let targets = data.mute_targets.get(owner).cloned().unwrap_or_default();

        writer.write_varint(owner_id as u64);
        writer.write_varint(ts);
        writer.write_varint(targets.len() as u64);
        for target in targets {
            let target_id = id_map.get(&target).copied().unwrap_or_default();
            writer.write_varint(target_id as u64);
        }
    }

    writer.finish()
}

struct ChunkWriter {
    buf: BytesMut,
    chunks: Vec<Bytes>,
}

impl ChunkWriter {
    fn new() -> Self {
        Self {
            buf: BytesMut::with_capacity(CHUNK_SIZE),
            chunks: Vec::new(),
        }
    }

    fn write_bytes(&mut self, bytes: &[u8]) {
        let mut offset = 0;
        while offset < bytes.len() {
            let remaining = CHUNK_SIZE - self.buf.len();
            if remaining == 0 {
                self.flush();
                continue;
            }
            let to_write = remaining.min(bytes.len() - offset);
            self.buf.extend_from_slice(&bytes[offset..offset + to_write]);
            offset += to_write;
        }
    }

    fn write_varint(&mut self, mut value: u64) {
        while value >= 0x80 {
            let byte = ((value as u8) & 0x7f) | 0x80;
            self.write_bytes(&[byte]);
            value >>= 7;
        }
        self.write_bytes(&[(value as u8) & 0x7f]);
    }

    fn flush(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let chunk = self.buf.split().freeze();
        self.chunks.push(chunk);
    }

    fn finish(mut self) -> Vec<Bytes> {
        self.flush();
        self.chunks
    }
}
