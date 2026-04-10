use std::collections::BTreeMap;
use std::sync::Arc;

use hashtree_core::{Cid, Store};
use hashtree_index::{BTree, BTreeOptions, SearchIndex};

use crate::{
    default_search_prefix, load_collection_state, CollectionDefinition, CollectionError,
    CollectionState, SearchLinkResult, SearchOptions,
};

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionIndexLinkResult {
    pub key: String,
    pub cid: Cid,
}

struct CollectionSearchSource<S: Store> {
    prefix: String,
    index: SearchIndex<S>,
}

pub struct CollectionSource<S: Store> {
    index: BTree<S>,
    search_indexes: BTreeMap<String, CollectionSearchSource<S>>,
    state: CollectionState,
}

impl<S: Store> CollectionSource<S> {
    pub fn new(store: Arc<S>, state: CollectionState) -> Self {
        Self {
            index: BTree::new(store, BTreeOptions::default()),
            search_indexes: BTreeMap::new(),
            state,
        }
    }

    pub fn with_definition<T>(
        store: Arc<S>,
        state: CollectionState,
        definition: &CollectionDefinition<T>,
    ) -> Self {
        let search_indexes = definition
            .search_indexes()
            .iter()
            .map(|index| {
                (
                    index.name().to_string(),
                    CollectionSearchSource {
                        prefix: index
                            .prefix()
                            .map(ToOwned::to_owned)
                            .unwrap_or_else(|| default_search_prefix(index.name())),
                        index: SearchIndex::new(Arc::clone(&store), index.options().clone()),
                    },
                )
            })
            .collect();

        Self {
            index: BTree::new(store, BTreeOptions::default()),
            search_indexes,
            state,
        }
    }

    pub async fn from_root<T>(
        store: Arc<S>,
        definition: &CollectionDefinition<T>,
        root: Option<&Cid>,
    ) -> Result<Self, CollectionError> {
        let state = load_collection_state(Arc::clone(&store), definition, root).await?;
        Ok(Self::with_definition(store, state, definition))
    }

    pub fn state(&self) -> &CollectionState {
        &self.state
    }

    pub async fn get(&self, id: &str) -> Result<Option<Cid>, CollectionError> {
        Ok(self
            .index
            .get_link(self.state.by_id_root.as_ref(), id)
            .await?)
    }

    pub async fn search(
        &self,
        index_name: &str,
        query: &str,
        options: SearchOptions,
    ) -> Result<Vec<SearchLinkResult>, CollectionError> {
        let Some(runtime) = self.search_indexes.get(index_name) else {
            return Ok(Vec::new());
        };
        Ok(runtime
            .index
            .search_links(
                self.state.search_root(index_name),
                &runtime.prefix,
                query,
                options,
            )
            .await?)
    }

    pub async fn get_index_link(
        &self,
        index_name: &str,
        key: &str,
    ) -> Result<Option<Cid>, CollectionError> {
        let root = self
            .state
            .key_root(index_name)
            .or_else(|| self.state.search_root(index_name));
        let Some(root) = root else {
            return Ok(None);
        };
        Ok(self.index.get_link(Some(root), key).await?)
    }

    pub async fn query_index(
        &self,
        index_name: &str,
        prefix: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<CollectionIndexLinkResult>, CollectionError> {
        let root = self
            .state
            .key_root(index_name)
            .or_else(|| self.state.search_root(index_name));
        let Some(root) = root else {
            return Ok(Vec::new());
        };

        let entries = if let Some(prefix) = prefix {
            self.index.prefix_links(root, prefix).await?
        } else {
            self.index.links_entries(Some(root)).await?
        };

        let limit = limit.unwrap_or(usize::MAX);
        Ok(entries
            .into_iter()
            .take(limit)
            .map(|(key, cid)| CollectionIndexLinkResult { key, cid })
            .collect())
    }
}
