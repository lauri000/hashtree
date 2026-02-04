use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use nostr::{EventBuilder, JsonUtil, Kind, Keys, Tag, Timestamp};
use tempfile::TempDir;

#[cfg(feature = "nostrdb")]
#[test]
fn snapshot_includes_list_timestamps() {
    let _guard = test_lock();
    let tmp = TempDir::new().unwrap();
    let ndb = hashtree_cli::socialgraph::init_ndb(tmp.path()).unwrap();

    let root_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let carol_keys = Keys::generate();

    let root_pk = root_keys.public_key();
    let bob_pk = bob_keys.public_key();
    let carol_pk = carol_keys.public_key();

    hashtree_cli::socialgraph::set_social_graph_root(&ndb, &root_pk.to_bytes());
    std::thread::sleep(Duration::from_millis(100));

    let follow_created_at = 1_700_000_111;
    let mute_created_at = 1_700_000_222;

    let follow_event = EventBuilder::new(
        Kind::ContactList,
        "",
        [Tag::public_key(bob_pk)],
    )
    .custom_created_at(Timestamp::from_secs(follow_created_at))
    .to_event(&root_keys)
    .unwrap();

    let mute_event = EventBuilder::new(
        Kind::MuteList,
        "",
        [Tag::public_key(carol_pk)],
    )
    .custom_created_at(Timestamp::from_secs(mute_created_at))
    .to_event(&root_keys)
    .unwrap();

    hashtree_cli::socialgraph::ingest_event(&ndb, "follow", &follow_event.as_json());
    hashtree_cli::socialgraph::ingest_event(&ndb, "mute", &mute_event.as_json());
    std::thread::sleep(Duration::from_millis(200));

    let options = hashtree_cli::socialgraph::snapshot::SnapshotOptions::default();
    let chunks = hashtree_cli::socialgraph::snapshot::build_snapshot_chunks(
        &ndb,
        &root_pk.to_bytes(),
        &options,
    )
    .unwrap();

    let data = flatten_chunks(chunks);

    let parsed = parse_snapshot(&data);
    let root_id = find_id(&parsed.id_to_pubkey, &root_pk.to_bytes()).expect("root id");
    let bob_id = find_id(&parsed.id_to_pubkey, &bob_pk.to_bytes()).expect("bob id");
    let carol_id = find_id(&parsed.id_to_pubkey, &carol_pk.to_bytes()).expect("carol id");

    let (follow_ts, follow_targets) = parsed
        .follow_lists
        .get(&root_id)
        .expect("root follow list");
    assert_eq!(*follow_ts, follow_created_at as u64);
    assert!(follow_targets.contains(&bob_id));

    let (mute_ts, mute_targets) = parsed
        .mute_lists
        .get(&root_id)
        .expect("root mute list");
    assert_eq!(*mute_ts, mute_created_at as u64);
    assert!(mute_targets.contains(&carol_id));
}

fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

fn flatten_chunks(chunks: Vec<Bytes>) -> Vec<u8> {
    let total = chunks.iter().map(|c| c.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    for chunk in chunks {
        out.extend_from_slice(&chunk);
    }
    out
}

struct ParsedSnapshot {
    id_to_pubkey: HashMap<u32, [u8; 32]>,
    follow_lists: HashMap<u32, (u64, Vec<u32>)>,
    mute_lists: HashMap<u32, (u64, Vec<u32>)>,
}

fn parse_snapshot(data: &[u8]) -> ParsedSnapshot {
    let mut offset = 0usize;
    let _version = read_varint(data, &mut offset);
    let id_count = read_varint(data, &mut offset) as usize;

    let mut id_to_pubkey = HashMap::new();
    for _ in 0..id_count {
        let pk = data[offset..offset + 32].try_into().unwrap();
        offset += 32;
        let id = read_varint(data, &mut offset) as u32;
        id_to_pubkey.insert(id, pk);
    }

    let follow_lists_count = read_varint(data, &mut offset) as usize;
    let mut follow_lists = HashMap::new();
    for _ in 0..follow_lists_count {
        let owner = read_varint(data, &mut offset) as u32;
        let ts = read_varint(data, &mut offset);
        let count = read_varint(data, &mut offset) as usize;
        let mut targets = Vec::with_capacity(count);
        for _ in 0..count {
            targets.push(read_varint(data, &mut offset) as u32);
        }
        follow_lists.insert(owner, (ts, targets));
    }

    let mute_lists_count = read_varint(data, &mut offset) as usize;
    let mut mute_lists = HashMap::new();
    for _ in 0..mute_lists_count {
        let owner = read_varint(data, &mut offset) as u32;
        let ts = read_varint(data, &mut offset);
        let count = read_varint(data, &mut offset) as usize;
        let mut targets = Vec::with_capacity(count);
        for _ in 0..count {
            targets.push(read_varint(data, &mut offset) as u32);
        }
        mute_lists.insert(owner, (ts, targets));
    }

    ParsedSnapshot {
        id_to_pubkey,
        follow_lists,
        mute_lists,
    }
}

fn read_varint(data: &[u8], offset: &mut usize) -> u64 {
    let mut value = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = data[*offset];
        *offset += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        if (byte & 0x80) == 0 {
            break;
        }
        shift += 7;
    }
    value
}

fn find_id(map: &HashMap<u32, [u8; 32]>, pk: &[u8; 32]) -> Option<u32> {
    map.iter().find_map(|(id, value)| if value == pk { Some(*id) } else { None })
}
