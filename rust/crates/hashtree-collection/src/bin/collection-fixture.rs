use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use futures::executor::block_on;
use hashtree_collection::{
    CollectionDefinition, CollectionSearchEntry, CollectionSearchIndexDefinition, CollectionState,
    CollectionWriteContext, CollectionWriter,
};
use hashtree_core::{Cid, MemoryStore, Store};
use hashtree_index::SearchIndexOptions;
use serde::Serialize;

#[derive(Debug, Clone)]
struct Song {
    id: String,
    title: String,
    artist: String,
    tags: Vec<String>,
}

#[derive(Debug, Clone)]
struct CatalogSong {
    id: String,
    title: String,
    artist: String,
    artist_id: String,
    album: String,
    album_id: String,
}

#[derive(Debug, Serialize)]
struct SerializedCid {
    hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
}

#[derive(Debug, Serialize)]
struct SerializedCollectionState {
    by_id_root: Option<SerializedCid>,
    key_roots: BTreeMap<String, Option<SerializedCid>>,
    search_roots: BTreeMap<String, Option<SerializedCid>>,
    item_count: usize,
}

#[derive(Debug, Serialize)]
struct Fixture {
    blocks: BTreeMap<String, String>,
    songs: SerializedCollectionState,
    catalog: SerializedCollectionState,
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

fn serialize_cid(cid: Option<&Cid>) -> Option<SerializedCid> {
    cid.map(|cid| SerializedCid {
        hash: hex::encode(cid.hash),
        key: cid.key.map(hex::encode),
    })
}

fn serialize_state(state: &CollectionState, item_count: usize) -> SerializedCollectionState {
    SerializedCollectionState {
        by_id_root: serialize_cid(state.by_id_root.as_ref()),
        key_roots: state
            .key_roots
            .iter()
            .map(|(name, cid)| (name.clone(), serialize_cid(cid.as_ref())))
            .collect(),
        search_roots: state
            .search_roots
            .iter()
            .map(|(name, cid)| (name.clone(), serialize_cid(cid.as_ref())))
            .collect(),
        item_count,
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

async fn build_fixture() -> Result<Fixture, Box<dyn std::error::Error>> {
    let store = Arc::new(MemoryStore::new());

    let mut songs_writer = CollectionWriter::new(Arc::clone(&store), song_definition());
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

    songs_writer
        .put(&original, &cid_from_seed(12), None)
        .await?;
    songs_writer
        .reindex(vec![
            (replacement, cid_from_seed(13)),
            (other, cid_from_seed(14)),
        ])
        .await?;

    let mut catalog_writer = CollectionWriter::new(Arc::clone(&store), catalog_definition());
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
    catalog_writer
        .put_with_context(&song, &cid_from_seed(50), None, Some(&context), None)
        .await?;

    Ok(Fixture {
        blocks: export_blocks(store.as_ref()).await?,
        songs: serialize_state(&songs_writer.snapshot(), 2),
        catalog: serialize_state(&catalog_writer.snapshot(), 1),
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: collection-fixture <output-path>")?;

    let fixture = block_on(build_fixture())?;
    fs::write(output, serde_json::to_vec_pretty(&fixture)?)?;
    Ok(())
}
