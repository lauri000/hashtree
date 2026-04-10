use std::sync::Arc;

use futures::executor::block_on;
use hashtree_core::{Cid, MemoryStore};
use hashtree_index::{SearchIndex, SearchIndexOptions, SearchOptions};

fn cid_from_seed(seed: u8) -> Cid {
    let mut hash = [0u8; 32];
    for (index, byte) in hash.iter_mut().enumerate() {
        *byte = seed.wrapping_add(index as u8);
    }
    Cid::public(hash)
}

#[test]
fn keeps_whole_tokens_and_splits_camel_case_variants() {
    let store = Arc::new(MemoryStore::new());
    let index = SearchIndex::new(
        store,
        SearchIndexOptions {
            order: Some(4),
            ..Default::default()
        },
    );

    assert_eq!(
        index.parse_keywords("SirLibre"),
        vec!["sirlibre", "sir", "libre"]
    );
    assert_eq!(
        index.parse_keywords("XMLHttpRequest42"),
        vec!["xmlhttprequest42", "xml", "http", "request"]
    );
}

#[test]
fn ranks_exact_keyword_matches_ahead_of_longer_prefix_matches() {
    block_on(async {
        let store = Arc::new(MemoryStore::new());
        let index = SearchIndex::new(
            store,
            SearchIndexOptions {
                order: Some(4),
                ..Default::default()
            },
        );

        let mut root = None;
        root = Some(
            index
                .index(
                    root.as_ref(),
                    "p:",
                    &["petrix".to_string()],
                    "pubkey-petrix",
                    r#"{"name":"petrix"}"#,
                )
                .await
                .unwrap(),
        );
        root = Some(
            index
                .index(
                    root.as_ref(),
                    "p:",
                    &["petri".to_string()],
                    "pubkey-petri",
                    r#"{"name":"petri"}"#,
                )
                .await
                .unwrap(),
        );

        let results = index
            .search(
                root.as_ref(),
                "p:",
                "petri",
                SearchOptions {
                    limit: Some(10),
                    full_match: false,
                },
            )
            .await
            .unwrap();

        assert_eq!(
            results
                .into_iter()
                .map(|result| result.id)
                .collect::<Vec<_>>(),
            vec!["pubkey-petri".to_string(), "pubkey-petrix".to_string()]
        );
    });
}

#[test]
fn search_links_returns_best_exact_matches_first() {
    block_on(async {
        let store = Arc::new(MemoryStore::new());
        let index = SearchIndex::new(store, SearchIndexOptions::default());

        let mut root = None;
        root = Some(
            index
                .index_link(
                    root.as_ref(),
                    "a:",
                    &["ambient".to_string()],
                    "album-ambient",
                    &cid_from_seed(1),
                )
                .await
                .unwrap(),
        );
        root = Some(
            index
                .index_link(
                    root.as_ref(),
                    "a:",
                    &["ambi".to_string()],
                    "album-ambi",
                    &cid_from_seed(2),
                )
                .await
                .unwrap(),
        );

        let results = index
            .search_links(root.as_ref(), "a:", "ambi", SearchOptions::default())
            .await
            .unwrap();

        assert_eq!(
            results
                .into_iter()
                .map(|result| result.id)
                .collect::<Vec<_>>(),
            vec!["album-ambi".to_string(), "album-ambient".to_string()]
        );
    });
}
