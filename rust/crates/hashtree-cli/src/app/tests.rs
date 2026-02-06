use super::daemonize::{build_daemon_args, parse_pid, read_pid_file, write_pid_file};
use super::lists::{
    build_mute_list_event, load_mute_entries, update_hex_list_file,
    update_mute_list_file_with_status, MuteEntry, MuteUpdate,
};
use super::resolve::resolve_cid_input;
use nostr::Kind;
use std::path::PathBuf;

fn args_to_strings(args: Vec<std::ffi::OsString>) -> Vec<String> {
    args.into_iter()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect()
}

#[test]
fn test_build_daemon_args_with_overrides() {
    let data_dir = PathBuf::from("data-dir");
    let args = args_to_strings(build_daemon_args(
        "127.0.0.1:8080",
        Some("wss://relay.example"),
        Some(&data_dir),
    ));

    assert_eq!(
        args,
        vec![
            "--addr",
            "127.0.0.1:8080",
            "--relays",
            "wss://relay.example",
            "--data-dir",
            "data-dir",
        ]
    );
}

#[test]
fn test_build_daemon_args_minimal() {
    let args = args_to_strings(build_daemon_args("0.0.0.0:8080", None, None));
    assert_eq!(args, vec!["--addr", "0.0.0.0:8080"]);
}

#[test]
fn test_parse_pid() {
    assert_eq!(parse_pid("123\n").unwrap(), 123);
    assert!(parse_pid("").is_err());
    assert!(parse_pid("abc").is_err());
}

#[test]
fn test_pid_file_roundtrip() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("htree.pid");
    write_pid_file(&path, 42).unwrap();
    let pid = read_pid_file(&path).unwrap();
    assert_eq!(pid, 42);
}

#[test]
fn test_update_hex_list_file_add_remove() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("mutes.json");
    let pk1 = "aa".repeat(32);
    let pk2 = "bb".repeat(32);

    let list = update_hex_list_file(&path, &pk1, true).unwrap();
    assert_eq!(list, vec![pk1.clone()]);

    let list = update_hex_list_file(&path, &pk1, true).unwrap();
    assert_eq!(list, vec![pk1.clone()]);

    let list = update_hex_list_file(&path, &pk2, true).unwrap();
    assert_eq!(list, vec![pk1.clone(), pk2.clone()]);

    let list = update_hex_list_file(&path, &pk1, false).unwrap();
    assert_eq!(list, vec![pk2.clone()]);
}

#[test]
fn test_build_mute_list_event_tags() {
    let keys = nostr::Keys::generate();
    let pk1 = nostr::Keys::generate().public_key().to_hex();
    let pk2 = nostr::Keys::generate().public_key().to_hex();
    let list = vec![
        MuteEntry {
            pubkey: pk1.clone(),
            reason: Some("spam".to_string()),
        },
        MuteEntry {
            pubkey: pk2.clone(),
            reason: None,
        },
    ];
    let event = build_mute_list_event(&list, &keys).unwrap();

    assert_eq!(event.kind, Kind::Custom(10000));

    let tags: Vec<String> = event
        .tags
        .iter()
        .filter_map(|tag| {
            let slice = tag.as_slice();
            if slice.first().map(|v| v.as_str()) == Some("p") {
                slice.get(1).cloned()
            } else {
                None
            }
        })
        .collect();

    assert_eq!(tags.len(), 2);
    assert!(tags.contains(&pk1));
    assert!(tags.contains(&pk2));

    let reason_tag = event
        .tags
        .iter()
        .find(|tag| tag.as_slice().get(1).map(|v| v.as_str()) == Some(pk1.as_str()))
        .expect("reason tag missing");
    assert_eq!(
        reason_tag.as_slice().get(2).map(|v| v.as_str()),
        Some("spam")
    );
}

#[test]
fn test_update_mute_list_with_reason() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("mutes.json");
    let pk1 = "aa".repeat(32);
    let pk2 = "bb".repeat(32);

    let (list, update) =
        update_mute_list_file_with_status(&path, &pk1, Some("spam"), true).unwrap();
    assert_eq!(update, MuteUpdate::Added);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].reason.as_deref(), Some("spam"));

    let (list, update) =
        update_mute_list_file_with_status(&path, &pk1, Some("abuse"), true).unwrap();
    assert_eq!(update, MuteUpdate::Updated);
    assert_eq!(list[0].reason.as_deref(), Some("abuse"));

    let (_list, update) = update_mute_list_file_with_status(&path, &pk2, None, true).unwrap();
    assert_eq!(update, MuteUpdate::Added);

    let (list, update) = update_mute_list_file_with_status(&path, &pk1, None, false).unwrap();
    assert_eq!(update, MuteUpdate::Removed);
    assert_eq!(list.len(), 1);
}

#[test]
fn test_load_mute_entries_legacy_format() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("mutes.json");
    let pk1 = "aa".repeat(32);
    let pk2 = "bb".repeat(32);
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&vec![pk1.clone(), pk2.clone()]).unwrap(),
    )
    .unwrap();

    let entries = load_mute_entries(&path).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].pubkey, pk1);
    assert_eq!(entries[0].reason, None);
}

#[tokio::test]
async fn test_resolve_nhash_with_path_suffix() {
    // nhash for hash [0xaa; 32]
    let nhash = hashtree_core::nhash_encode(&[0xaa; 32]).unwrap();

    // Test nhash without path
    let resolved = resolve_cid_input(&nhash).await.unwrap();
    assert_eq!(resolved.cid.hash, [0xaa; 32]);
    assert!(resolved.path.is_none());

    // Test nhash with single file path suffix
    let with_path = format!("{}/bitcoin.pdf", nhash);
    let resolved = resolve_cid_input(&with_path).await.unwrap();
    assert_eq!(resolved.cid.hash, [0xaa; 32]);
    assert_eq!(resolved.path, Some("bitcoin.pdf".to_string()));

    // Test nhash with nested path suffix
    let with_nested = format!("{}/docs/papers/bitcoin.pdf", nhash);
    let resolved = resolve_cid_input(&with_nested).await.unwrap();
    assert_eq!(resolved.cid.hash, [0xaa; 32]);
    assert_eq!(resolved.path, Some("docs/papers/bitcoin.pdf".to_string()));
}

#[tokio::test]
async fn test_resolve_nhash_with_htree_prefix() {
    let nhash = hashtree_core::nhash_encode(&[0xbb; 32]).unwrap();

    // Test htree:// prefix with path
    let htree_url = format!("htree://{}/file.txt", nhash);
    let resolved = resolve_cid_input(&htree_url).await.unwrap();
    assert_eq!(resolved.cid.hash, [0xbb; 32]);
    assert_eq!(resolved.path, Some("file.txt".to_string()));
}

#[tokio::test]
async fn test_resolve_hex_cid_with_key_and_path() {
    let hash = [0x11; 32];
    let key = [0x22; 32];
    let hash_hex = hashtree_core::to_hex(&hash);
    let key_hex = hashtree_core::to_hex(&key);
    let cid = format!("{}:{}", hash_hex, key_hex);

    let resolved = resolve_cid_input(&cid).await.unwrap();
    assert_eq!(resolved.cid.hash, hash);
    assert_eq!(resolved.cid.key, Some(key));
    assert!(resolved.path.is_none());

    let with_path = format!("{}/dir/file.txt", cid);
    let resolved = resolve_cid_input(&with_path).await.unwrap();
    assert_eq!(resolved.cid.hash, hash);
    assert_eq!(resolved.cid.key, Some(key));
    assert_eq!(resolved.path, Some("dir/file.txt".to_string()));
}

#[tokio::test]
async fn test_resolve_hex_cid_without_key() {
    let hash = [0x33; 32];
    let hash_hex = hashtree_core::to_hex(&hash);
    let resolved = resolve_cid_input(&hash_hex).await.unwrap();
    assert_eq!(resolved.cid.hash, hash);
    assert!(resolved.cid.key.is_none());
}
