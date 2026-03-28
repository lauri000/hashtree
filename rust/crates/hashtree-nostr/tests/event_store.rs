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
                "46d23c598097d7e13cef3c4aa4aea878596f9f5018ce5969d915e149311058e2".to_string(),
                Some(
                    "1589629f9c1c73084a91bdef7d032bb690d431e07483b3c5bfea39aa7ebf1ba0".to_string()
                )
            )
        );

        assert_eq!(
            cid_to_pair(manifest.by_id.as_ref().unwrap()),
            (
                "cfef6382cd6e8f76eeac020241e0bf2cf06f1d4aa04f22386563f51cd6b82255".to_string(),
                Some(
                    "b6574a09ef40e5e058bdefb41da932984754a29dd41286b1edb2a0d76e949df3".to_string()
                )
            )
        );
        assert_eq!(
            cid_to_pair(manifest.by_author_time.as_ref().unwrap()),
            (
                "59c18768cfd9635b0fcd9aa4364428176eaf81b198cf01dd15d5d7fbd64f8b58".to_string(),
                Some(
                    "a9a6b38d6fc3ae3ec08ce09a5d9ffe1c1a3ee7b1019713abf691ce9635c9ef0c".to_string()
                )
            )
        );
        assert_eq!(
            cid_to_pair(manifest.by_kind_time.as_ref().unwrap()),
            (
                "66679b40e811a34aa6f769a1463b0c3d99ad902ce25765ee7f11e4e6a2c9504d".to_string(),
                Some(
                    "b6c798064906e42b709e44271942d9a489f8304ac6f6e99d49ce7f88fe11e6f7".to_string()
                )
            )
        );
        assert_eq!(
            cid_to_pair(manifest.by_time.as_ref().unwrap()),
            (
                "3a06b344cc4f726e9000f00d6ddea99f28466fc08a33a84c01def4b682fbb2f0".to_string(),
                Some(
                    "4d6e07652d9fd5d148d826e2acb06195a416efff0df27fdd0c11a52cd7ee3a34".to_string()
                )
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
