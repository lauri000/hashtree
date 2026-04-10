use std::sync::Arc;

use hashtree_collection::{
    CollectionDefinition, CollectionSearchEntry, CollectionSearchIndexDefinition, CollectionSource,
    CollectionWriteContext, CollectionWriter, MANIFEST_BY_ID,
};
use hashtree_core::{Cid, HashTree, HashTreeConfig, MemoryStore};
use hashtree_index::{SearchIndexOptions, SearchOptions};

#[derive(Debug, Clone, PartialEq, Eq)]
struct Song {
    id: String,
    title: String,
    artist: String,
    tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CatalogSong {
    id: String,
    title: String,
    artist: String,
    artist_id: String,
    album: String,
    album_id: String,
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
        .with_search_index(
            CollectionSearchIndexDefinition::new("songs")
                .with_prefix("s:")
                .with_options(SearchIndexOptions {
                    order: Some(4),
                    ..Default::default()
                })
                .with_text(|song: &Song| {
                    let mut text = vec![song.title.clone(), song.artist.clone()];
                    text.extend(song.tags.iter().cloned());
                    text
                }),
        )
}

fn catalog_definition() -> CollectionDefinition<CatalogSong> {
    CollectionDefinition::new(|song: &CatalogSong| song.id.clone())
        .with_search_index(
            CollectionSearchIndexDefinition::new("songs")
                .with_root_name("catalog-search")
                .with_prefix("s:")
                .with_text(|song: &CatalogSong| {
                    vec![song.title.clone(), song.artist.clone(), song.album.clone()]
                }),
        )
        .with_search_index(
            CollectionSearchIndexDefinition::new("artists")
                .with_root_name("catalog-search")
                .with_prefix("a:")
                .with_entries(|song: &CatalogSong, context| {
                    let Some(artist_cid) = context
                        .write_context
                        .and_then(|context| context.get("artistCid"))
                        .cloned()
                    else {
                        return Vec::new();
                    };
                    vec![CollectionSearchEntry::new(vec![song.artist.clone()])
                        .with_id(song.artist_id.clone())
                        .with_cid(artist_cid)]
                }),
        )
        .with_search_index(
            CollectionSearchIndexDefinition::new("albums")
                .with_root_name("catalog-search")
                .with_prefix("l:")
                .with_entries(|song: &CatalogSong, context| {
                    let Some(album_cid) = context
                        .write_context
                        .and_then(|context| context.get("albumCid"))
                        .cloned()
                    else {
                        return Vec::new();
                    };
                    vec![
                        CollectionSearchEntry::new(vec![song.album.clone(), song.artist.clone()])
                            .with_id(song.album_id.clone())
                            .with_cid(album_cid),
                    ]
                }),
        )
}

fn cid_from_seed(seed: u8) -> Cid {
    let mut hash = [0u8; 32];
    for (index, byte) in hash.iter_mut().enumerate() {
        *byte = seed.wrapping_add(index as u8);
    }
    Cid::public(hash)
}

#[tokio::test]
async fn put_and_delete_update_by_id_key_and_search_indexes() {
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

    let source =
        CollectionSource::with_definition(Arc::clone(&store), writer.snapshot(), &definition);
    assert_eq!(source.get("song-a").await.unwrap(), Some(cid_from_seed(1)));
    assert_eq!(
        source
            .search(
                "songs",
                "midnight",
                SearchOptions {
                    limit: Some(10),
                    full_match: false,
                },
            )
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        vec!["song-a".to_string()]
    );
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

    let source =
        CollectionSource::with_definition(Arc::clone(&store), writer.snapshot(), &definition);
    assert_eq!(source.get("song-a").await.unwrap(), None);
    assert!(source
        .search("songs", "midnight", SearchOptions::default())
        .await
        .unwrap()
        .is_empty());
    assert!(source
        .query_index("artist", Some("artist:ada"), None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn previous_item_cleanup_and_root_reload_remove_stale_search_terms() {
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
    assert!(names.contains(&"songs"));

    let source = CollectionSource::from_root(Arc::clone(&store), &definition, Some(&root))
        .await
        .unwrap();
    assert_eq!(source.get("song-a").await.unwrap(), Some(cid_from_seed(11)));
    assert!(source
        .search("songs", "old", SearchOptions::default())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        source
            .search("songs", "new", SearchOptions::default())
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        vec!["song-a".to_string()]
    );
}

#[tokio::test]
async fn shared_search_roots_support_derived_entity_targets() {
    let store = Arc::new(MemoryStore::new());
    let definition = catalog_definition();
    let mut writer = CollectionWriter::new(Arc::clone(&store), definition.clone());
    let song = CatalogSong {
        id: "song-1".to_string(),
        title: "Quiet Bloom".to_string(),
        artist: "Open Meridian".to_string(),
        artist_id: "artist-1".to_string(),
        album: "Harbor Echo".to_string(),
        album_id: "album-1".to_string(),
    };
    let mut context = CollectionWriteContext::new();
    context.insert("artistCid".to_string(), cid_from_seed(51));
    context.insert("albumCid".to_string(), cid_from_seed(52));

    writer
        .put_with_context(&song, &cid_from_seed(50), None, Some(&context), None)
        .await
        .unwrap();

    let snapshot = writer.snapshot();
    assert_eq!(
        snapshot.search_root("songs"),
        snapshot.search_root("artists")
    );
    assert_eq!(
        snapshot.search_root("songs"),
        snapshot.search_root("albums")
    );

    let source = CollectionSource::with_definition(Arc::clone(&store), snapshot, &definition);
    assert_eq!(
        source
            .search("songs", "quiet", SearchOptions::default())
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        vec!["song-1".to_string()]
    );
    assert_eq!(
        source
            .search("artists", "open", SearchOptions::default())
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        vec!["artist-1".to_string()]
    );
    assert_eq!(
        source
            .search("albums", "harbor", SearchOptions::default())
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        vec!["album-1".to_string()]
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

    let source =
        CollectionSource::with_definition(Arc::clone(&store), writer.snapshot(), &definition);
    assert_eq!(source.get("song-a").await.unwrap(), Some(cid_from_seed(21)));
    assert!(source
        .query_index("artist", Some("artist:ada"), None)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        source
            .search("songs", "new", SearchOptions::default())
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        vec!["song-a".to_string()]
    );
    assert!(source
        .search("songs", "old", SearchOptions::default())
        .await
        .unwrap()
        .is_empty());
}
