use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use futures::executor::block_on;
use hashtree_core::{sha256, Cid, MemoryStore, Store};
use hashtree_nostr::{NostrEventStore, StoredNostrEvent};
use serde::Serialize;

#[derive(Debug, Serialize)]
struct SerializedCid {
    hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
}

#[derive(Debug, Serialize)]
struct Fixture {
    root: SerializedCid,
    events: Vec<StoredNostrEvent>,
    blocks: BTreeMap<String, String>,
}

fn serialize_cid(cid: &Cid) -> SerializedCid {
    SerializedCid {
        hash: hex::encode(cid.hash),
        key: cid.key.map(hex::encode),
    }
}

fn canonical_event_id(
    pubkey: &str,
    created_at: u64,
    kind: u32,
    tags: &[Vec<String>],
    content: &str,
) -> String {
    let payload = serde_json::to_string(&(0u8, pubkey, created_at, kind, tags, content))
        .expect("canonical payload");
    hex::encode(sha256(payload.as_bytes()))
}

fn canonical_store_event(
    pubkey: &str,
    created_at: u64,
    kind: u32,
    tags: Vec<Vec<String>>,
    content: &str,
    sig_seed: char,
) -> StoredNostrEvent {
    StoredNostrEvent {
        id: canonical_event_id(pubkey, created_at, kind, &tags, content),
        pubkey: pubkey.to_string(),
        created_at,
        kind,
        tags,
        content: content.to_string(),
        sig: sig_seed.to_string().repeat(128),
    }
}

async fn export_blocks(
    store: &MemoryStore,
) -> Result<BTreeMap<String, String>, Box<dyn std::error::Error>> {
    let mut blocks = BTreeMap::new();
    let mut hashes = store.keys();
    hashes.sort_unstable();

    for hash in hashes {
        let data = store
            .get(&hash)
            .await?
            .ok_or_else(|| format!("missing block {}", hex::encode(hash)))?;
        blocks.insert(hex::encode(hash), hex::encode(data));
    }

    Ok(blocks)
}

fn fixture_events() -> Vec<StoredNostrEvent> {
    let author = "a".repeat(64);
    let other_author = "b".repeat(64);
    let parameterized_author = "c".repeat(64);

    vec![
        canonical_store_event(
            &author,
            30,
            0,
            Vec::new(),
            r#"{"name":"latest profile"}"#,
            '3',
        ),
        canonical_store_event(&author, 10, 1, Vec::new(), "older", '2'),
        canonical_store_event(
            &author,
            25,
            0,
            Vec::new(),
            r#"{"name":"stale profile"}"#,
            '4',
        ),
        canonical_store_event(
            &other_author,
            40,
            1,
            Vec::new(),
            "other",
            '5',
        ),
        canonical_store_event(
            &author,
            50,
            1,
            vec![
                vec!["t".to_string(), "nostr".to_string()],
                vec!["t".to_string(), "Hashtree".to_string()],
            ],
            "tagged",
            '6',
        ),
        canonical_store_event(
            &parameterized_author,
            60,
            30_023,
            vec![vec!["d".to_string(), "article-1".to_string()]],
            "draft alpha",
            '7',
        ),
        canonical_store_event(
            &author,
            20,
            1,
            Vec::new(),
            "newer",
            '2',
        ),
        canonical_store_event(
            &parameterized_author,
            60,
            30_023,
            vec![vec!["d".to_string(), "article-1".to_string()]],
            "draft omega",
            '8',
        ),
    ]
}

async fn build_fixture() -> Result<Fixture, Box<dyn std::error::Error>> {
    let store = Arc::new(MemoryStore::new());
    let events = fixture_events();
    let event_store = NostrEventStore::new(Arc::clone(&store));
    let root = event_store
        .build(None, events.clone())
        .await?
        .ok_or("missing event root")?;

    Ok(Fixture {
        root: serialize_cid(&root),
        events,
        blocks: export_blocks(store.as_ref()).await?,
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: nostr-event-store-fixture <output-path>")?;

    let fixture = block_on(build_fixture())?;
    fs::write(output, serde_json::to_vec_pretty(&fixture)?)?;
    Ok(())
}
