use std::sync::Arc;

use futures::executor::block_on;
use hashtree_core::{sha256, Cid, HashTree, HashTreeConfig, MemoryStore};
use hashtree_nostr::{ListEventsOptions, NostrEventStore, StoredNostrEvent};

fn event(
    id: &str,
    pubkey: &str,
    created_at: u64,
    kind: u32,
    content: &str,
    sig: &str,
) -> StoredNostrEvent {
    StoredNostrEvent {
        id: id.to_string(),
        pubkey: pubkey.to_string(),
        created_at,
        kind,
        tags: Vec::new(),
        content: content.to_string(),
        sig: sig.to_string(),
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

#[test]
fn stores_events_by_id_author_and_replaceable_views() {
    block_on(async {
        let store = NostrEventStore::new(Arc::new(MemoryStore::new()));
        let author = "a".repeat(64);
        let other_author = "b".repeat(64);
        let event1 = event(
            "1195275911eb877e6687b4f8a3495de1e0719280e7fc1fb229a9de37b2d87bea",
            &author,
            10,
            1,
            "older",
            &"2".repeat(128),
        );
        let event2 = event(
            "ff92321262e009d97bc0292e83a851e4a2435b2b9748f656fbdbd5c0ccd6f0b4",
            &author,
            20,
            1,
            "newer",
            &"2".repeat(128),
        );
        let profile = event(
            "74c5538f00cc767f7b40113e315e731bd80b06d5160b950c154efca10535f805",
            &author,
            30,
            0,
            "profile",
            &"3".repeat(128),
        );
        let other = event(
            "ee5e6609ca7f7beb6a0e1927740e8cb1c68cc29e407bc85b2936883757cb0884",
            &other_author,
            40,
            1,
            "other",
            &"4".repeat(128),
        );
        let hashtagged_tags = vec![
            vec!["t".to_string(), "nostr".to_string()],
            vec!["t".to_string(), "Hashtree".to_string()],
        ];
        let hashtagged = StoredNostrEvent {
            id: canonical_event_id(&author, 50, 1, &hashtagged_tags, "tagged"),
            pubkey: author.clone(),
            created_at: 50,
            kind: 1,
            tags: hashtagged_tags,
            content: "tagged".to_string(),
            sig: "5".repeat(128),
        };

        let mut root = store.add(None, event1.clone()).await.unwrap();
        root = store.add(Some(&root), event2.clone()).await.unwrap();
        root = store.add(Some(&root), profile.clone()).await.unwrap();
        root = store.add(Some(&root), other.clone()).await.unwrap();
        root = store.add(Some(&root), hashtagged.clone()).await.unwrap();

        assert_eq!(
            store.get_by_id(Some(&root), &event2.id).await.unwrap(),
            Some(event2.clone())
        );
        assert_eq!(
            store
                .list_by_author(Some(&root), &author, ListEventsOptions::default())
                .await
                .unwrap(),
            vec![
                hashtagged.clone(),
                profile.clone(),
                event2.clone(),
                event1.clone()
            ]
        );
        assert_eq!(
            store
                .list_by_kind(Some(&root), 1, ListEventsOptions::default())
                .await
                .unwrap(),
            vec![
                hashtagged.clone(),
                other.clone(),
                event2.clone(),
                event1.clone()
            ]
        );
        assert_eq!(
            store
                .list_recent(
                    Some(&root),
                    ListEventsOptions {
                        limit: Some(3),
                        ..Default::default()
                    }
                )
                .await
                .unwrap(),
            vec![hashtagged.clone(), other.clone(), profile.clone()]
        );
        assert_eq!(
            store
                .list_recent(
                    Some(&root),
                    ListEventsOptions {
                        since: Some(20),
                        until: Some(40),
                        ..Default::default()
                    }
                )
                .await
                .unwrap(),
            vec![other.clone(), profile.clone(), event2.clone()]
        );
        assert_eq!(
            store
                .get_replaceable(Some(&root), &author, 0)
                .await
                .unwrap(),
            Some(profile)
        );
        assert_eq!(
            store
                .list_by_tag(
                    Some(&root),
                    "t",
                    "nostr",
                    ListEventsOptions {
                        limit: Some(10),
                        ..Default::default()
                    }
                )
                .await
                .unwrap(),
            vec![hashtagged.clone()]
        );
        assert_eq!(
            store
                .list_by_tag(
                    Some(&root),
                    "t",
                    "hashtree",
                    ListEventsOptions {
                        limit: Some(10),
                        ..Default::default()
                    }
                )
                .await
                .unwrap(),
            vec![hashtagged]
        );
    });
}

#[test]
fn manifest_exposes_by_id_key_only() {
    block_on(async {
        let backing = Arc::new(MemoryStore::new());
        let tree = HashTree::new(HashTreeConfig::new(backing.clone()));
        let store = NostrEventStore::new(backing);
        let author = "a".repeat(64);
        let event = event(
            "1195275911eb877e6687b4f8a3495de1e0719280e7fc1fb229a9de37b2d87bea",
            &author,
            10,
            1,
            "older",
            &"2".repeat(128),
        );

        let root = store.add(None, event).await.unwrap();
        let entries = tree.list_directory(&root).await.unwrap();
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();

        assert!(names.contains(&"by-id"));
        assert!(!names.contains(&"events_by_id"));
    });
}

#[test]
fn nostr_event_roots_and_blobs_are_public() {
    block_on(async {
        let backing = Arc::new(MemoryStore::new());
        let tree = HashTree::new(HashTreeConfig::new(backing.clone()));
        let store = NostrEventStore::new(backing);
        let author = "a".repeat(64);
        let event = event(
            "1195275911eb877e6687b4f8a3495de1e0719280e7fc1fb229a9de37b2d87bea",
            &author,
            10,
            1,
            "older",
            &"2".repeat(128),
        );

        let root = store.add(None, event).await.unwrap();
        assert!(root.key.is_none());

        let manifest = store.get_manifest(Some(&root)).await.unwrap();
        let by_id = manifest.by_id.expect("by-id root");
        assert!(by_id.key.is_none());

        let entries = tree.list_directory(&by_id).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].key.is_none());
    });
}

#[test]
fn manifest_root_matches_typescript_fixture() {
    block_on(async {
        let store = NostrEventStore::new(Arc::new(MemoryStore::new()));
        let author = "a".repeat(64);
        let event1 = event(
            "1195275911eb877e6687b4f8a3495de1e0719280e7fc1fb229a9de37b2d87bea",
            &author,
            10,
            1,
            "older",
            &"2".repeat(128),
        );
        let event2 = event(
            "ff92321262e009d97bc0292e83a851e4a2435b2b9748f656fbdbd5c0ccd6f0b4",
            &author,
            20,
            1,
            "newer",
            &"2".repeat(128),
        );
        let profile = event(
            "74c5538f00cc767f7b40113e315e731bd80b06d5160b950c154efca10535f805",
            &author,
            30,
            0,
            "profile",
            &"3".repeat(128),
        );

        let mut root = store.add(None, event1).await.unwrap();
        root = store.add(Some(&root), event2).await.unwrap();
        root = store.add(Some(&root), profile).await.unwrap();
        let manifest = store.get_manifest(Some(&root)).await.unwrap();

        assert_eq!(
            cid_to_pair(&root),
            (
                "3be7ef3cd8535a609273fc114bbc0137f0eb1b5af2d0f52a89a4d718af5a9ec8".to_string(),
                None,
            )
        );

        assert_eq!(
            cid_to_pair(manifest.by_id.as_ref().unwrap()),
            (
                "4beaf15a71ae8a4a7067d07cafdc2d5f6b81963ae44e316963392592d82352c4".to_string(),
                None,
            )
        );
        assert_eq!(
            cid_to_pair(manifest.by_author_time.as_ref().unwrap()),
            (
                "271361def97236a7dcf2e57d585b7a5136affe84312f705cefe61886e8c9222e".to_string(),
                None,
            )
        );
        assert_eq!(
            cid_to_pair(manifest.by_kind_time.as_ref().unwrap()),
            (
                "ae8faea98db4e5d99e705f8de2d6c93c6e7926d19d76633245fae9ff4d4aff70".to_string(),
                None,
            )
        );
        assert_eq!(
            cid_to_pair(manifest.by_time.as_ref().unwrap()),
            (
                "2b2d08fe7cef3a470faf83f3b7f344ab01fe4c16e7baebb1cf1cd61e01fc9969".to_string(),
                None,
            )
        );
    });
}

#[test]
fn build_sorts_events_deterministically() {
    block_on(async {
        let store = NostrEventStore::new(Arc::new(MemoryStore::new()));
        let author = "a".repeat(64);
        let older = event(
            "1195275911eb877e6687b4f8a3495de1e0719280e7fc1fb229a9de37b2d87bea",
            &author,
            10,
            1,
            "older",
            &"2".repeat(128),
        );
        let newer = event(
            "ff92321262e009d97bc0292e83a851e4a2435b2b9748f656fbdbd5c0ccd6f0b4",
            &author,
            20,
            1,
            "newer",
            &"2".repeat(128),
        );
        let profile = event(
            "74c5538f00cc767f7b40113e315e731bd80b06d5160b950c154efca10535f805",
            &author,
            30,
            0,
            "profile",
            &"3".repeat(128),
        );

        let built = store
            .build(None, vec![profile.clone(), older.clone(), newer.clone()])
            .await
            .unwrap()
            .expect("root");

        let mut incremental = store.add(None, older).await.unwrap();
        incremental = store.add(Some(&incremental), newer).await.unwrap();
        incremental = store.add(Some(&incremental), profile).await.unwrap();

        assert_eq!(cid_to_pair(&built), cid_to_pair(&incremental));
    });
}

fn cid_to_pair(cid: &Cid) -> (String, Option<String>) {
    (hex::encode(cid.hash), cid.key.map(hex::encode))
}
