use hashtree_core::{Cid, TreeEntry};
use hashtree_index::SearchIndexOptions;

use crate::definition::MaterializedCollectionSearchEntry;
use crate::state::CollectionOptions;
use crate::CollectionSearchEntry;

pub(crate) fn merge_search_index_options(
    mut options: SearchIndexOptions,
    collection_options: &CollectionOptions,
) -> SearchIndexOptions {
    if options.order.is_none() {
        options.order = collection_options.btree_order;
    }
    options
}

pub(crate) fn normalize_search_entries(
    entries: Vec<CollectionSearchEntry>,
) -> Vec<MaterializedCollectionSearchEntry> {
    entries
        .into_iter()
        .filter_map(|entry| {
            let text = normalize_string_input(entry.text);
            if text.is_empty() {
                return None;
            }
            Some(MaterializedCollectionSearchEntry {
                text,
                id: entry
                    .id
                    .map(|id| id.trim().to_string())
                    .filter(|id| !id.is_empty()),
                cid: entry.cid,
                prefix: entry
                    .prefix
                    .map(|prefix| prefix.trim().to_string())
                    .filter(|prefix| !prefix.is_empty()),
            })
        })
        .collect()
}

pub(crate) fn normalize_string_input(values: Vec<String>) -> String {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut unique = Vec::new();
    for value in values {
        let normalized = value.trim().to_string();
        if normalized.is_empty() || unique.iter().any(|existing| existing == &normalized) {
            continue;
        }
        unique.push(normalized);
    }
    unique
}

pub(crate) fn find_manifest_cid(entries: &[TreeEntry], name: &str) -> Option<Cid> {
    entries
        .iter()
        .find(|entry| entry.name == name)
        .map(|entry| Cid {
            hash: entry.hash,
            key: entry.key,
        })
}
