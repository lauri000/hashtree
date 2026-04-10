//! Immutable by-id and key-index collections for hashtree.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use hashtree_core::{
    Cid, DirEntry, HashTree, HashTreeConfig, HashTreeError, LinkType, Store, TreeEntry,
};
use hashtree_index::{BTree, BTreeError, BTreeOptions};

pub const MANIFEST_BY_ID: &str = "by-id";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CollectionState {
    pub by_id_root: Option<Cid>,
    pub key_roots: BTreeMap<String, Option<Cid>>,
}

impl CollectionState {
    pub fn key_root(&self, name: &str) -> Option<&Cid> {
        self.key_roots.get(name).and_then(Option::as_ref)
    }
}

#[derive(Debug, Clone, Default)]
pub struct CollectionOptions {
    pub btree_order: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionIndexLinkResult {
    pub key: String,
    pub cid: Cid,
}

type CollectionIdFn<T> = Arc<dyn Fn(&T) -> String + Send + Sync>;
type CollectionKeysFn<T> = Arc<dyn Fn(&T) -> Vec<String> + Send + Sync>;

#[derive(Clone)]
pub struct CollectionKeyIndexDefinition<T> {
    name: String,
    keys: CollectionKeysFn<T>,
}

impl<T> CollectionKeyIndexDefinition<T> {
    pub fn new(
        name: impl Into<String>,
        keys: impl Fn(&T) -> Vec<String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            keys: Arc::new(keys),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    fn materialize_keys(&self, item: &T) -> Vec<String> {
        unique_strings((self.keys)(item))
    }
}

impl<T> fmt::Debug for CollectionKeyIndexDefinition<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CollectionKeyIndexDefinition")
            .field("name", &self.name)
            .finish()
    }
}

#[derive(Clone)]
pub struct CollectionDefinition<T> {
    get_id: CollectionIdFn<T>,
    key_indexes: Vec<CollectionKeyIndexDefinition<T>>,
}

impl<T> CollectionDefinition<T> {
    pub fn new(get_id: impl Fn(&T) -> String + Send + Sync + 'static) -> Self {
        Self {
            get_id: Arc::new(get_id),
            key_indexes: Vec::new(),
        }
    }

    pub fn with_key_index(
        mut self,
        name: impl Into<String>,
        keys: impl Fn(&T) -> Vec<String> + Send + Sync + 'static,
    ) -> Self {
        self.key_indexes
            .push(CollectionKeyIndexDefinition::new(name, keys));
        self
    }

    pub fn key_indexes(&self) -> &[CollectionKeyIndexDefinition<T>] {
        &self.key_indexes
    }

    fn item_id(&self, item: &T) -> Result<String, CollectionError> {
        let id = (self.get_id)(item).trim().to_string();
        if id.is_empty() {
            return Err(CollectionError::Validation(
                "collection item id must not be empty".to_string(),
            ));
        }
        Ok(id)
    }
}

impl<T> fmt::Debug for CollectionDefinition<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CollectionDefinition")
            .field("key_indexes", &self.key_indexes)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CollectionError {
    #[error("hash tree error: {0}")]
    HashTree(#[from] HashTreeError),
    #[error("index error: {0}")]
    Index(#[from] BTreeError),
    #[error("{0}")]
    Validation(String),
}

pub fn create_empty_collection_state<T>(definition: &CollectionDefinition<T>) -> CollectionState {
    CollectionState {
        by_id_root: None,
        key_roots: definition
            .key_indexes()
            .iter()
            .map(|index| (index.name().to_string(), None))
            .collect(),
    }
}

pub async fn load_collection_state<S: Store, T>(
    store: Arc<S>,
    definition: &CollectionDefinition<T>,
    root: Option<&Cid>,
) -> Result<CollectionState, CollectionError> {
    let mut state = create_empty_collection_state(definition);
    let Some(root) = root else {
        return Ok(state);
    };

    let tree = HashTree::new(HashTreeConfig::new(store));
    let entries = tree.list_directory(root).await?;
    state.by_id_root = find_manifest_cid(&entries, MANIFEST_BY_ID);
    for index in definition.key_indexes() {
        state.key_roots.insert(
            index.name().to_string(),
            find_manifest_cid(&entries, index.name()),
        );
    }
    Ok(state)
}

pub struct CollectionWriter<S: Store, T> {
    tree: HashTree<S>,
    index: BTree<S>,
    definition: CollectionDefinition<T>,
    state: CollectionState,
}

impl<S: Store, T> CollectionWriter<S, T> {
    pub fn new(store: Arc<S>, definition: CollectionDefinition<T>) -> Self {
        Self::with_options(store, definition, CollectionOptions::default())
    }

    pub fn with_options(
        store: Arc<S>,
        definition: CollectionDefinition<T>,
        options: CollectionOptions,
    ) -> Self {
        let state = create_empty_collection_state(&definition);
        Self::with_state_and_options(store, definition, state, options)
    }

    pub fn with_state(
        store: Arc<S>,
        definition: CollectionDefinition<T>,
        state: CollectionState,
    ) -> Self {
        Self::with_state_and_options(store, definition, state, CollectionOptions::default())
    }

    pub fn with_state_and_options(
        store: Arc<S>,
        definition: CollectionDefinition<T>,
        state: CollectionState,
        options: CollectionOptions,
    ) -> Self {
        Self {
            tree: HashTree::new(HashTreeConfig::new(Arc::clone(&store))),
            index: BTree::new(
                store,
                BTreeOptions {
                    order: options.btree_order,
                },
            ),
            definition,
            state,
        }
    }

    pub async fn from_root(
        store: Arc<S>,
        definition: CollectionDefinition<T>,
        root: Option<&Cid>,
        options: CollectionOptions,
    ) -> Result<Self, CollectionError> {
        let state = load_collection_state(Arc::clone(&store), &definition, root).await?;
        Ok(Self::with_state_and_options(
            store, definition, state, options,
        ))
    }

    pub fn snapshot(&self) -> CollectionState {
        self.state.clone()
    }

    pub fn state(&self) -> &CollectionState {
        &self.state
    }

    pub async fn put(
        &mut self,
        item: &T,
        cid: &Cid,
        previous: Option<&T>,
    ) -> Result<CollectionState, CollectionError> {
        if let Some(previous) = previous {
            self.delete(previous).await?;
        }

        let id = self.definition.item_id(item)?;
        self.state.by_id_root = Some(
            self.index
                .insert_link(self.state.by_id_root.as_ref(), &id, cid)
                .await?,
        );

        for index in self.definition.key_indexes() {
            let mut root = self.state.key_root(index.name()).cloned();
            for key in index.materialize_keys(item) {
                root = Some(self.index.insert_link(root.as_ref(), &key, cid).await?);
            }
            self.state.key_roots.insert(index.name().to_string(), root);
        }

        Ok(self.snapshot())
    }

    pub async fn delete(&mut self, item: &T) -> Result<CollectionState, CollectionError> {
        let id = self.definition.item_id(item)?;
        if let Some(root) = self.state.by_id_root.as_ref() {
            self.state.by_id_root = self.index.delete(root, &id).await?;
        }

        for index in self.definition.key_indexes() {
            let mut root = self.state.key_root(index.name()).cloned();
            for key in index.materialize_keys(item) {
                let Some(active_root) = root.as_ref() else {
                    break;
                };
                root = self.index.delete(active_root, &key).await?;
            }
            self.state.key_roots.insert(index.name().to_string(), root);
        }

        Ok(self.snapshot())
    }

    pub async fn rebuild<I>(&mut self, entries: I) -> Result<CollectionState, CollectionError>
    where
        I: IntoIterator<Item = (T, Cid)>,
    {
        let mut final_entries = BTreeMap::<String, (T, Cid)>::new();
        for (item, cid) in entries {
            let id = self.definition.item_id(&item)?;
            final_entries.insert(id, (item, cid));
        }

        let mut by_id = BTreeMap::<String, Cid>::new();
        let mut key_roots = self
            .definition
            .key_indexes()
            .iter()
            .map(|index| (index.name().to_string(), BTreeMap::<String, Cid>::new()))
            .collect::<BTreeMap<_, _>>();

        for (id, (item, cid)) in final_entries {
            by_id.insert(id, cid.clone());
            for index in self.definition.key_indexes() {
                let root = key_roots
                    .get_mut(index.name())
                    .expect("collection key root must exist");
                for key in index.materialize_keys(&item) {
                    root.insert(key, cid.clone());
                }
            }
        }

        self.state = create_empty_collection_state(&self.definition);
        self.state.by_id_root = self.index.build_links(by_id).await?;
        for index in self.definition.key_indexes() {
            let root = self
                .index
                .build_links(key_roots.remove(index.name()).unwrap_or_default())
                .await?;
            self.state.key_roots.insert(index.name().to_string(), root);
        }

        Ok(self.snapshot())
    }

    pub async fn write_root(&self) -> Result<Option<Cid>, CollectionError> {
        let mut entries = Vec::new();
        if let Some(cid) = self.state.by_id_root.as_ref() {
            entries.push(DirEntry::from_cid(MANIFEST_BY_ID, cid).with_link_type(LinkType::Dir));
        }
        for index in self.definition.key_indexes() {
            if let Some(cid) = self.state.key_root(index.name()) {
                entries.push(DirEntry::from_cid(index.name(), cid).with_link_type(LinkType::Dir));
            }
        }

        if entries.is_empty() {
            return Ok(None);
        }

        Ok(Some(self.tree.put_directory(entries).await?))
    }
}

pub struct CollectionSource<S: Store> {
    index: BTree<S>,
    state: CollectionState,
}

impl<S: Store> CollectionSource<S> {
    pub fn new(store: Arc<S>, state: CollectionState) -> Self {
        Self::with_options(store, state, CollectionOptions::default())
    }

    pub fn with_options(store: Arc<S>, state: CollectionState, options: CollectionOptions) -> Self {
        Self {
            index: BTree::new(
                store,
                BTreeOptions {
                    order: options.btree_order,
                },
            ),
            state,
        }
    }

    pub async fn from_root<T>(
        store: Arc<S>,
        definition: &CollectionDefinition<T>,
        root: Option<&Cid>,
    ) -> Result<Self, CollectionError> {
        let state = load_collection_state(Arc::clone(&store), definition, root).await?;
        Ok(Self::new(store, state))
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

    pub async fn get_index_link(
        &self,
        index_name: &str,
        key: &str,
    ) -> Result<Option<Cid>, CollectionError> {
        let Some(root) = self.state.key_root(index_name) else {
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
        let Some(root) = self.state.key_root(index_name) else {
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

fn unique_strings(values: Vec<String>) -> Vec<String> {
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

fn find_manifest_cid(entries: &[TreeEntry], name: &str) -> Option<Cid> {
    entries
        .iter()
        .find(|entry| entry.name == name)
        .map(|entry| Cid {
            hash: entry.hash,
            key: entry.key,
        })
}
