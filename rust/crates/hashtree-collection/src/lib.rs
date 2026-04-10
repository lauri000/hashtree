//! Immutable by-id, key-index, and search-index collections for hashtree.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use hashtree_core::{
    Cid, DirEntry, HashTree, HashTreeConfig, HashTreeError, LinkType, Store, TreeEntry,
};
use hashtree_index::{BTree, BTreeError, BTreeOptions, SearchError, SearchIndex};
pub use hashtree_index::{SearchIndexOptions, SearchLinkResult, SearchOptions};

pub const MANIFEST_BY_ID: &str = "by-id";

pub type CollectionWriteContext = BTreeMap<String, Cid>;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CollectionState {
    pub by_id_root: Option<Cid>,
    pub key_roots: BTreeMap<String, Option<Cid>>,
    pub search_roots: BTreeMap<String, Option<Cid>>,
}

impl CollectionState {
    pub fn key_root(&self, name: &str) -> Option<&Cid> {
        self.key_roots.get(name).and_then(Option::as_ref)
    }

    pub fn search_root(&self, name: &str) -> Option<&Cid> {
        self.search_roots.get(name).and_then(Option::as_ref)
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
type CollectionSearchTextFn<T> = Arc<dyn Fn(&T) -> Vec<String> + Send + Sync>;
type CollectionSearchEntriesFn<T> = Arc<
    dyn for<'a> Fn(&T, &CollectionEntryContext<'a>) -> Vec<CollectionSearchEntry> + Send + Sync,
>;

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

#[derive(Debug, Clone)]
pub struct CollectionEntryContext<'a> {
    pub id: &'a str,
    pub cid: Option<&'a Cid>,
    pub write_context: Option<&'a CollectionWriteContext>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionSearchEntry {
    pub text: Vec<String>,
    pub id: Option<String>,
    pub cid: Option<Cid>,
    pub prefix: Option<String>,
}

impl CollectionSearchEntry {
    pub fn new(text: Vec<String>) -> Self {
        Self {
            text,
            id: None,
            cid: None,
            prefix: None,
        }
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    pub fn with_cid(mut self, cid: Cid) -> Self {
        self.cid = Some(cid);
        self
    }

    pub fn with_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.prefix = Some(prefix.into());
        self
    }
}

#[derive(Clone)]
pub struct CollectionSearchIndexDefinition<T> {
    name: String,
    root_name: Option<String>,
    prefix: Option<String>,
    options: SearchIndexOptions,
    text: Option<CollectionSearchTextFn<T>>,
    entries: Option<CollectionSearchEntriesFn<T>>,
}

impl<T> CollectionSearchIndexDefinition<T> {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            root_name: None,
            prefix: None,
            options: SearchIndexOptions::default(),
            text: None,
            entries: None,
        }
    }

    pub fn with_root_name(mut self, root_name: impl Into<String>) -> Self {
        self.root_name = Some(root_name.into());
        self
    }

    pub fn with_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.prefix = Some(prefix.into());
        self
    }

    pub fn with_options(mut self, options: SearchIndexOptions) -> Self {
        self.options = options;
        self
    }

    pub fn with_text(mut self, text: impl Fn(&T) -> Vec<String> + Send + Sync + 'static) -> Self {
        self.text = Some(Arc::new(text));
        self
    }

    pub fn with_entries(
        mut self,
        entries: impl for<'a> Fn(&T, &CollectionEntryContext<'a>) -> Vec<CollectionSearchEntry>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        self.entries = Some(Arc::new(entries));
        self
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn root_name(&self) -> Option<&str> {
        self.root_name.as_deref()
    }

    pub fn prefix(&self) -> Option<&str> {
        self.prefix.as_deref()
    }

    pub fn options(&self) -> &SearchIndexOptions {
        &self.options
    }

    fn materialize_entries(
        &self,
        item: &T,
        context: &CollectionEntryContext<'_>,
    ) -> Vec<MaterializedCollectionSearchEntry> {
        if let Some(entries) = self.entries.as_ref() {
            return normalize_search_entries(entries(item, context));
        }

        let Some(text) = self
            .text
            .as_ref()
            .map(|text| normalize_string_input(text(item)))
            .filter(|text| !text.is_empty())
        else {
            return Vec::new();
        };

        vec![MaterializedCollectionSearchEntry {
            text,
            id: Some(context.id.to_string()),
            cid: context.cid.cloned(),
            prefix: self.prefix.clone(),
        }]
    }
}

impl<T> fmt::Debug for CollectionSearchIndexDefinition<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CollectionSearchIndexDefinition")
            .field("name", &self.name)
            .field("root_name", &self.root_name)
            .field("prefix", &self.prefix)
            .field("options", &self.options)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq)]
struct MaterializedCollectionSearchEntry {
    text: String,
    id: Option<String>,
    cid: Option<Cid>,
    prefix: Option<String>,
}

#[derive(Clone)]
pub struct CollectionDefinition<T> {
    get_id: CollectionIdFn<T>,
    key_indexes: Vec<CollectionKeyIndexDefinition<T>>,
    search_indexes: Vec<CollectionSearchIndexDefinition<T>>,
}

impl<T> CollectionDefinition<T> {
    pub fn new(get_id: impl Fn(&T) -> String + Send + Sync + 'static) -> Self {
        Self {
            get_id: Arc::new(get_id),
            key_indexes: Vec::new(),
            search_indexes: Vec::new(),
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

    pub fn with_search_index(mut self, index: CollectionSearchIndexDefinition<T>) -> Self {
        self.search_indexes.push(index);
        self
    }

    pub fn key_indexes(&self) -> &[CollectionKeyIndexDefinition<T>] {
        &self.key_indexes
    }

    pub fn search_indexes(&self) -> &[CollectionSearchIndexDefinition<T>] {
        &self.search_indexes
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
            .field("search_indexes", &self.search_indexes)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CollectionError {
    #[error("hash tree error: {0}")]
    HashTree(#[from] HashTreeError),
    #[error("index error: {0}")]
    Index(#[from] BTreeError),
    #[error("search error: {0}")]
    Search(#[from] SearchError),
    #[error("{0}")]
    Validation(String),
}

pub fn default_search_prefix(name: &str) -> String {
    format!("{name}:")
}

pub fn create_empty_collection_state<T>(definition: &CollectionDefinition<T>) -> CollectionState {
    CollectionState {
        by_id_root: None,
        key_roots: definition
            .key_indexes()
            .iter()
            .map(|index| (index.name().to_string(), None))
            .collect(),
        search_roots: definition
            .search_indexes()
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
    for index in definition.search_indexes() {
        state.search_roots.insert(
            index.name().to_string(),
            find_manifest_cid(&entries, index.name()),
        );
    }
    Ok(state)
}

pub struct CollectionWriter<S: Store, T> {
    tree: HashTree<S>,
    index: BTree<S>,
    search_indexes: BTreeMap<String, SearchIndex<S>>,
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
        let search_indexes = definition
            .search_indexes()
            .iter()
            .map(|index| {
                (
                    index.name().to_string(),
                    SearchIndex::new(
                        Arc::clone(&store),
                        merge_search_index_options(index.options().clone(), &options),
                    ),
                )
            })
            .collect();

        Self {
            tree: HashTree::new(HashTreeConfig::new(Arc::clone(&store))),
            index: BTree::new(
                store,
                BTreeOptions {
                    order: options.btree_order,
                },
            ),
            search_indexes,
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
        self.put_with_context(item, cid, previous, None, None).await
    }

    pub async fn put_with_context(
        &mut self,
        item: &T,
        cid: &Cid,
        previous: Option<&T>,
        context: Option<&CollectionWriteContext>,
        previous_context: Option<&CollectionWriteContext>,
    ) -> Result<CollectionState, CollectionError> {
        if let Some(previous) = previous {
            self.delete_with_context(previous, previous_context.or(context))
                .await?;
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

        let mut search_root_groups = BTreeMap::<String, Option<Cid>>::new();
        let entry_context = CollectionEntryContext {
            id: &id,
            cid: Some(cid),
            write_context: context,
        };
        for index in self.definition.search_indexes() {
            let Some(search_index) = self.search_indexes.get(index.name()) else {
                continue;
            };

            let root_name = index.root_name().unwrap_or(index.name()).to_string();
            let mut root = search_root_groups
                .get(&root_name)
                .cloned()
                .unwrap_or_else(|| self.read_search_root_group(&root_name));

            for entry in index.materialize_entries(item, &entry_context) {
                let terms = search_index.parse_keywords(&entry.text);
                if terms.is_empty() {
                    continue;
                }
                let entry_id = entry.id.as_deref().unwrap_or(&id);
                let Some(entry_cid) = entry.cid.as_ref().or(Some(cid)) else {
                    continue;
                };
                root = Some(
                    search_index
                        .index_link(
                            root.as_ref(),
                            entry
                                .prefix
                                .as_deref()
                                .or_else(|| index.prefix())
                                .unwrap_or(&default_search_prefix(index.name())),
                            &terms,
                            entry_id,
                            entry_cid,
                        )
                        .await?,
                );
            }

            search_root_groups.insert(root_name, root);
        }

        if !search_root_groups.is_empty() {
            self.assign_search_root_groups(&search_root_groups);
        }

        Ok(self.snapshot())
    }

    pub async fn delete(&mut self, item: &T) -> Result<CollectionState, CollectionError> {
        self.delete_with_context(item, None).await
    }

    pub async fn delete_with_context(
        &mut self,
        item: &T,
        context: Option<&CollectionWriteContext>,
    ) -> Result<CollectionState, CollectionError> {
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

        let mut search_root_groups = BTreeMap::<String, Option<Cid>>::new();
        let entry_context = CollectionEntryContext {
            id: &id,
            cid: None,
            write_context: context,
        };
        for index in self.definition.search_indexes() {
            let Some(search_index) = self.search_indexes.get(index.name()) else {
                continue;
            };

            let root_name = index.root_name().unwrap_or(index.name()).to_string();
            let mut root = search_root_groups
                .get(&root_name)
                .cloned()
                .unwrap_or_else(|| self.read_search_root_group(&root_name));
            let Some(existing_root) = root.clone() else {
                continue;
            };
            root = Some(existing_root);

            for entry in index.materialize_entries(item, &entry_context) {
                let terms = search_index.parse_keywords(&entry.text);
                if terms.is_empty() {
                    continue;
                }
                let entry_id = entry.id.as_deref().unwrap_or(&id);
                let Some(active_root) = root.as_ref() else {
                    break;
                };
                root = search_index
                    .remove_link(
                        active_root,
                        entry
                            .prefix
                            .as_deref()
                            .or_else(|| index.prefix())
                            .unwrap_or(&default_search_prefix(index.name())),
                        &terms,
                        entry_id,
                    )
                    .await?;
            }

            search_root_groups.insert(root_name, root);
        }

        if !search_root_groups.is_empty() {
            self.assign_search_root_groups(&search_root_groups);
        } else {
            for index in self.definition.search_indexes() {
                let root_name = index.root_name().unwrap_or(index.name()).to_string();
                self.state.search_roots.insert(
                    index.name().to_string(),
                    self.read_search_root_group(&root_name),
                );
            }
        }

        Ok(self.snapshot())
    }

    pub async fn rebuild<I>(&mut self, entries: I) -> Result<CollectionState, CollectionError>
    where
        I: IntoIterator<Item = (T, Cid)>,
    {
        if self.definition.search_indexes().is_empty() {
            return self.rebuild_without_search(entries).await;
        }

        let mut final_entries = BTreeMap::<String, (T, Cid)>::new();
        for (item, cid) in entries {
            let id = self.definition.item_id(&item)?;
            final_entries.insert(id, (item, cid));
        }

        self.state = create_empty_collection_state(&self.definition);
        for (_id, (item, cid)) in final_entries {
            self.put(&item, &cid, None).await?;
        }
        Ok(self.snapshot())
    }

    pub async fn reindex<I>(&mut self, entries: I) -> Result<CollectionState, CollectionError>
    where
        I: IntoIterator<Item = (T, Cid)>,
    {
        self.rebuild(entries).await
    }

    pub async fn rebuild_with_context<I>(
        &mut self,
        entries: I,
    ) -> Result<CollectionState, CollectionError>
    where
        I: IntoIterator<Item = (T, Cid, Option<CollectionWriteContext>)>,
    {
        let mut final_entries = BTreeMap::<String, (T, Cid, Option<CollectionWriteContext>)>::new();
        for (item, cid, context) in entries {
            let id = self.definition.item_id(&item)?;
            final_entries.insert(id, (item, cid, context));
        }

        self.state = create_empty_collection_state(&self.definition);
        for (_id, (item, cid, context)) in final_entries {
            self.put_with_context(&item, &cid, None, context.as_ref(), None)
                .await?;
        }
        Ok(self.snapshot())
    }

    pub async fn reindex_with_context<I>(
        &mut self,
        entries: I,
    ) -> Result<CollectionState, CollectionError>
    where
        I: IntoIterator<Item = (T, Cid, Option<CollectionWriteContext>)>,
    {
        self.rebuild_with_context(entries).await
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
        for index in self.definition.search_indexes() {
            if let Some(cid) = self.state.search_root(index.name()) {
                entries.push(DirEntry::from_cid(index.name(), cid).with_link_type(LinkType::Dir));
            }
        }

        if entries.is_empty() {
            return Ok(None);
        }

        Ok(Some(self.tree.put_directory(entries).await?))
    }

    async fn rebuild_without_search<I>(
        &mut self,
        entries: I,
    ) -> Result<CollectionState, CollectionError>
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

    fn read_search_root_group(&self, root_name: &str) -> Option<Cid> {
        for index in self.definition.search_indexes() {
            if index.root_name().unwrap_or(index.name()) == root_name {
                return self.state.search_root(index.name()).cloned();
            }
        }
        None
    }

    fn assign_search_root_groups(&mut self, groups: &BTreeMap<String, Option<Cid>>) {
        for index in self.definition.search_indexes() {
            let root_name = index.root_name().unwrap_or(index.name());
            if let Some(root) = groups.get(root_name) {
                self.state
                    .search_roots
                    .insert(index.name().to_string(), root.clone());
            }
        }
    }
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

fn merge_search_index_options(
    mut options: SearchIndexOptions,
    collection_options: &CollectionOptions,
) -> SearchIndexOptions {
    if options.order.is_none() {
        options.order = collection_options.btree_order;
    }
    options
}

fn normalize_search_entries(
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

fn normalize_string_input(values: Vec<String>) -> String {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
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
