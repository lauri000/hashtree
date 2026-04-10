use std::sync::Arc;

use hashtree_collection::{
    CollectionDefinition, CollectionSource, CollectionWriter, MANIFEST_BY_ID,
};
use hashtree_core::{Cid, HashTree, HashTreeConfig, MemoryStore};

#[derive(Debug, Clone, PartialEq, Eq)]
struct Song {
    id: String,
    title: String,
    artist: String,
    tags: Vec<String>,
}

fn song_definition() -> CollectionDefinition<Song> {
    CollectionDefinition::new(|song: &Song| song.id.clone())
        .with_key_index("artist", |song| {
            vec![format!("artist:{}", song.artist.to_lowercase())]
        })
        .with_key_index("tag", |song| {
            song.tags
                .iter()
                .map(|tag| format!("tag:{}", tag.to_lowercase()))
                .collect()
        })
}

fn cid_from_seed(seed: u8) -> Cid {
    let mut hash = [0u8; 32];
    for (index, byte) in hash.iter_mut().enumerate() {
        *byte = seed.wrapping_add(index as u8);
    }
    Cid::public(hash)
}

#[tokio::test]
async fn put_and_delete_update_by_id_and_key_indexes() {
    let store = Arc::new(MemoryStore::new());
    let definition = song_definition();
    let mut writer = CollectionWriter::new(Arc::clone(&store), definition.clone());
    let song_a = Song {
        id: "song-a".to_string(),
        title: "Midnight Orchard".to_string(),
        artist: "Ada".to_string(),
        tags: vec!["dream-pop".to_string()],
    };
    let song_b = Song {
        id: "song-b".to_string(),
        title: "Sun Clock".to_string(),
        artist: "Bea".to_string(),
        tags: vec!["ambient".to_string()],
    };

    writer.put(&song_a, &cid_from_seed(1), None).await.unwrap();
    writer.put(&song_b, &cid_from_seed(2), None).await.unwrap();

    let source = CollectionSource::new(Arc::clone(&store), writer.snapshot());
    assert_eq!(source.get("song-a").await.unwrap(), Some(cid_from_seed(1)));
    assert_eq!(
        source
            .query_index("artist", Some("artist:ada"), None)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.key)
            .collect::<Vec<_>>(),
        vec!["artist:ada".to_string()]
    );

    writer.delete(&song_a).await.unwrap();

    let source = CollectionSource::new(Arc::clone(&store), writer.snapshot());
    assert_eq!(source.get("song-a").await.unwrap(), None);
    assert!(source
        .query_index("artist", Some("artist:ada"), None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn previous_item_cleanup_and_root_reload_remove_stale_keys() {
    let store = Arc::new(MemoryStore::new());
    let definition = song_definition();
    let mut writer = CollectionWriter::new(Arc::clone(&store), definition.clone());
    let original = Song {
        id: "song-a".to_string(),
        title: "Old Horizon".to_string(),
        artist: "Ada".to_string(),
        tags: vec!["night".to_string()],
    };
    let replacement = Song {
        id: "song-a".to_string(),
        title: "New Horizon".to_string(),
        artist: "Bea".to_string(),
        tags: vec!["day".to_string()],
    };

    writer
        .put(&original, &cid_from_seed(10), None)
        .await
        .unwrap();
    writer
        .put(&replacement, &cid_from_seed(11), Some(&original))
        .await
        .unwrap();

    let root = writer.write_root().await.unwrap().expect("collection root");
    let tree = HashTree::new(HashTreeConfig::new(Arc::clone(&store)));
    let entries = tree.list_directory(&root).await.unwrap();
    let names = entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&MANIFEST_BY_ID));
    assert!(names.contains(&"artist"));
    assert!(names.contains(&"tag"));

    let source = CollectionSource::from_root(Arc::clone(&store), &definition, Some(&root))
        .await
        .unwrap();
    assert_eq!(source.get("song-a").await.unwrap(), Some(cid_from_seed(11)));
    assert!(source
        .query_index("artist", Some("artist:ada"), None)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        source
            .query_index("artist", Some("artist:bea"), None)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.key)
            .collect::<Vec<_>>(),
        vec!["artist:bea".to_string()]
    );
}

#[tokio::test]
async fn rebuild_keeps_only_the_last_item_for_each_id() {
    let store = Arc::new(MemoryStore::new());
    let definition = song_definition();
    let mut writer = CollectionWriter::new(Arc::clone(&store), definition.clone());
    let original = Song {
        id: "song-a".to_string(),
        title: "Old Horizon".to_string(),
        artist: "Ada".to_string(),
        tags: vec!["night".to_string()],
    };
    let replacement = Song {
        id: "song-a".to_string(),
        title: "New Horizon".to_string(),
        artist: "Bea".to_string(),
        tags: vec!["day".to_string()],
    };
    let other = Song {
        id: "song-b".to_string(),
        title: "Sun Clock".to_string(),
        artist: "Bea".to_string(),
        tags: vec!["ambient".to_string()],
    };

    writer
        .rebuild(vec![
            (original, cid_from_seed(20)),
            (replacement, cid_from_seed(21)),
            (other, cid_from_seed(22)),
        ])
        .await
        .unwrap();

    let source = CollectionSource::new(Arc::clone(&store), writer.snapshot());
    assert_eq!(source.get("song-a").await.unwrap(), Some(cid_from_seed(21)));
    assert!(source
        .query_index("artist", Some("artist:ada"), None)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        source
            .query_index("tag", Some("tag:day"), None)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.key)
            .collect::<Vec<_>>(),
        vec!["tag:day".to_string()]
    );
    assert!(source
        .query_index("tag", Some("tag:night"), None)
        .await
        .unwrap()
        .is_empty());
}
