use std::time::Duration;

use anyhow::Context;
use nostr::{EventBuilder, JsonUtil, Kind, Keys, SecretKey, Tag, Timestamp};

fn main() -> anyhow::Result<()> {
    let out_path = std::env::args()
        .nth(1)
        .context("Usage: socialgraph-snapshot-fixture <output-path>")?;

    let tmp = tempfile::TempDir::new().context("create temp dir")?;
    let ndb = hashtree_cli::socialgraph::init_ndb(tmp.path())
        .context("init nostrdb")?;

    let root_keys = keys_from_byte(1)?;
    let bob_keys = keys_from_byte(2)?;
    let carol_keys = keys_from_byte(3)?;
    let dave_keys = keys_from_byte(4)?;

    let root_pk = root_keys.public_key();
    let bob_pk = bob_keys.public_key();
    let carol_pk = carol_keys.public_key();
    let dave_pk = dave_keys.public_key();

    hashtree_cli::socialgraph::set_social_graph_root(&ndb, &root_pk.to_bytes());
    std::thread::sleep(Duration::from_millis(100));

    let root_follow_ts = 1_700_000_111;
    let bob_follow_ts = 1_700_000_222;
    let root_mute_ts = 1_700_000_333;

    let root_follow_event = EventBuilder::new(
        Kind::ContactList,
        "",
        [Tag::public_key(bob_pk)],
    )
    .custom_created_at(Timestamp::from_secs(root_follow_ts))
    .to_event(&root_keys)
    .context("build root follow event")?;

    let bob_follow_event = EventBuilder::new(
        Kind::ContactList,
        "",
        [Tag::public_key(carol_pk)],
    )
    .custom_created_at(Timestamp::from_secs(bob_follow_ts))
    .to_event(&bob_keys)
    .context("build bob follow event")?;

    let root_mute_event = EventBuilder::new(
        Kind::MuteList,
        "",
        [Tag::public_key(dave_pk)],
    )
    .custom_created_at(Timestamp::from_secs(root_mute_ts))
    .to_event(&root_keys)
    .context("build root mute event")?;

    hashtree_cli::socialgraph::ingest_event(&ndb, "follow", &root_follow_event.as_json());
    hashtree_cli::socialgraph::ingest_event(&ndb, "follow", &bob_follow_event.as_json());
    hashtree_cli::socialgraph::ingest_event(&ndb, "mute", &root_mute_event.as_json());
    std::thread::sleep(Duration::from_millis(200));

    let options = hashtree_cli::socialgraph::snapshot::SnapshotOptions::default();
    let chunks = hashtree_cli::socialgraph::snapshot::build_snapshot_chunks(
        &ndb,
        &root_pk.to_bytes(),
        &options,
    )
    .context("build snapshot")?;

    let data = flatten_chunks(chunks);
    std::fs::write(&out_path, data).context("write snapshot")?;
    Ok(())
}

fn keys_from_byte(byte: u8) -> anyhow::Result<Keys> {
    let mut sk = [0u8; 32];
    sk.fill(byte);
    let secret = SecretKey::from_slice(&sk)?;
    Ok(Keys::new(secret))
}

fn flatten_chunks(chunks: Vec<bytes::Bytes>) -> Vec<u8> {
    let total = chunks.iter().map(|c| c.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    for chunk in chunks {
        out.extend_from_slice(&chunk);
    }
    out
}
