use hashtree_core::HashTreeError;
use hashtree_index::{BTreeError, SearchError};

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
