use std::fmt;
use std::sync::Arc;

use hashtree_core::Cid;

use crate::helpers::{normalize_search_entries, normalize_string_input, unique_strings};
use crate::schema::CollectionSchema;
use crate::{CollectionError, CollectionWriteContext};

type CollectionIdFn<T> = Arc<dyn Fn(&T) -> String + Send + Sync>;
type CollectionKeysFn<T> = Arc<dyn Fn(&T) -> Vec<String> + Send + Sync>;
type CollectionSearchTextFn<T> = Arc<dyn Fn(&T) -> Vec<String> + Send + Sync>;
type CollectionSearchEntriesFn<T> = Arc<
    dyn for<'a> Fn(&T, &CollectionEntryContext<'a>) -> Vec<CollectionSearchEntry> + Send + Sync,
>;

pub fn default_search_prefix(name: &str) -> String {
    format!("{name}:")
}

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

    pub(crate) fn materialize_keys(&self, item: &T) -> Vec<String> {
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
    options: hashtree_index::SearchIndexOptions,
    text: Option<CollectionSearchTextFn<T>>,
    entries: Option<CollectionSearchEntriesFn<T>>,
}

impl<T> CollectionSearchIndexDefinition<T> {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            root_name: None,
            prefix: None,
            options: hashtree_index::SearchIndexOptions::default(),
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

    pub fn with_options(mut self, options: hashtree_index::SearchIndexOptions) -> Self {
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

    pub fn options(&self) -> &hashtree_index::SearchIndexOptions {
        &self.options
    }

    pub(crate) fn materialize_entries(
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
pub(crate) struct MaterializedCollectionSearchEntry {
    pub(crate) text: String,
    pub(crate) id: Option<String>,
    pub(crate) cid: Option<Cid>,
    pub(crate) prefix: Option<String>,
}

#[derive(Clone)]
pub struct CollectionDefinition<T> {
    schema: Option<CollectionSchema<T>>,
    get_id: CollectionIdFn<T>,
    key_indexes: Vec<CollectionKeyIndexDefinition<T>>,
    search_indexes: Vec<CollectionSearchIndexDefinition<T>>,
}

impl<T> CollectionDefinition<T> {
    pub fn new(get_id: impl Fn(&T) -> String + Send + Sync + 'static) -> Self {
        Self {
            schema: None,
            get_id: Arc::new(get_id),
            key_indexes: Vec::new(),
            search_indexes: Vec::new(),
        }
    }

    pub fn with_schema(mut self, schema: CollectionSchema<T>) -> Self {
        self.schema = Some(schema);
        self
    }

    pub fn schema(&self) -> Option<&CollectionSchema<T>> {
        self.schema.as_ref()
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

    pub(crate) fn item_id(&self, item: &T) -> Result<String, CollectionError> {
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
            .field(
                "schema_version",
                &self.schema.as_ref().map(|schema| schema.version()),
            )
            .field("key_indexes", &self.key_indexes)
            .field("search_indexes", &self.search_indexes)
            .finish()
    }
}
