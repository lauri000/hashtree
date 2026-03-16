use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::Result;
use bytes::{Bytes, BytesMut};

use super::Ndb;

const BINARY_FORMAT_VERSION: u64 = 2;
const CHUNK_SIZE: usize = 16 * 1024;

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

pub fn build_snapshot_chunks(
    ndb: &Ndb,
    root: &[u8; 32],
    options: &SnapshotOptions,
) -> Result<Vec<Bytes>> {
    let data = build_snapshot_data(ndb, root, options)?;
    Ok(encode_snapshot_chunks(&data))
}

fn build_snapshot_data(
    ndb: &Ndb,
    root: &[u8; 32],
    options: &SnapshotOptions,
) -> Result<SnapshotData> {
    let users_by_distance = compute_users_by_distance(ndb, root, options.max_distance)?;

    let mut used_nodes: HashSet<[u8; 32]> = HashSet::new();
    let mut used_order = Vec::new();

    let mut follow_targets = HashMap::new();
    let mut mute_targets = HashMap::new();
    let mut follow_owners = Vec::new();
    let mut mute_owners = Vec::new();
    let mut follow_owner_set = HashSet::new();
    let mut mute_owner_set = HashSet::new();
    let mut edge_count = 0usize;

    'edges: for (distance, owners) in users_by_distance {
        if options
            .max_distance
            .is_some_and(|max_distance| distance > max_distance)
        {
            break;
        }

        for owner in owners {
            let mut owner_edge_count = 0usize;
            let follows = ndb.followed_targets(&owner)?;
            for target in follows {
                if options
                    .max_edges_per_node
                    .is_some_and(|limit| owner_edge_count >= limit)
                {
                    break;
                }
                if options.max_edges.is_some_and(|limit| edge_count >= limit) {
                    break 'edges;
                }
                if !can_add_nodes(&used_nodes, &owner, &target, options.max_nodes) {
                    break 'edges;
                }

                if used_nodes.insert(owner) {
                    used_order.push(owner);
                }
                if used_nodes.insert(target) {
                    used_order.push(target);
                }

                follow_targets
                    .entry(owner)
                    .or_insert_with(Vec::new)
                    .push(target);
                if follow_owner_set.insert(owner) {
                    follow_owners.push(owner);
                }

                edge_count += 1;
                owner_edge_count += 1;
            }

            let mutes = ndb.muted_targets(&owner)?;
            for target in mutes {
                if options
                    .max_edges_per_node
                    .is_some_and(|limit| owner_edge_count >= limit)
                {
                    break;
                }
                if options.max_edges.is_some_and(|limit| edge_count >= limit) {
                    break 'edges;
                }
                if !can_add_nodes(&used_nodes, &owner, &target, options.max_nodes) {
                    break 'edges;
                }

                if used_nodes.insert(owner) {
                    used_order.push(owner);
                }
                if used_nodes.insert(target) {
                    used_order.push(target);
                }

                mute_targets
                    .entry(owner)
                    .or_insert_with(Vec::new)
                    .push(target);
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
        follow_created_at.insert(*owner, ndb.follow_list_created_at(owner)?.unwrap_or(0));
    }
    for owner in &mute_owners {
        mute_created_at.insert(*owner, ndb.mute_list_created_at(owner)?.unwrap_or(0));
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
    ndb: &Ndb,
    root: &[u8; 32],
    max_distance: Option<u32>,
) -> Result<BTreeMap<u32, Vec<[u8; 32]>>> {
    let mut visited = HashSet::new();
    let mut by_distance = BTreeMap::new();

    let mut current = vec![*root];
    visited.insert(*root);
    by_distance.insert(0, current.clone());

    let mut depth = 0u32;
    loop {
        if max_distance.is_some_and(|max_distance| depth >= max_distance) || current.is_empty() {
            break;
        }

        let mut next = Vec::new();
        for owner in &current {
            for target in ndb.followed_targets(owner)? {
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

    Ok(by_distance)
}

fn can_add_nodes(
    used_nodes: &HashSet<[u8; 32]>,
    owner: &[u8; 32],
    target: &[u8; 32],
    max_nodes: Option<usize>,
) -> bool {
    let Some(max_nodes) = max_nodes else {
        return true;
    };

    let mut new_nodes = 0usize;
    if !used_nodes.contains(owner) {
        new_nodes += 1;
    }
    if !used_nodes.contains(target) {
        new_nodes += 1;
    }
    used_nodes.len() + new_nodes <= max_nodes
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
        let mut offset = 0usize;
        while offset < bytes.len() {
            let remaining = CHUNK_SIZE - self.buf.len();
            if remaining == 0 {
                self.flush();
                continue;
            }

            let to_write = remaining.min(bytes.len() - offset);
            self.buf
                .extend_from_slice(&bytes[offset..offset + to_write]);
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
        self.chunks.push(self.buf.split().freeze());
    }

    fn finish(mut self) -> Vec<Bytes> {
        self.flush();
        self.chunks
    }
}
