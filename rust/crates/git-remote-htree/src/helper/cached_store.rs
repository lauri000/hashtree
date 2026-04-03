use hashtree_blossom::BlossomStore;
use hashtree_core::{Hash, Store, StoreError};
use std::sync::Arc;

pub(super) struct CachedStore {
    local: Arc<dyn Store + Send + Sync>,
    blossom: BlossomStore,
}

impl CachedStore {
    pub(super) fn new(local: Arc<dyn Store + Send + Sync>, blossom: BlossomStore) -> Self {
        Self { local, blossom }
    }
}

#[async_trait::async_trait]
impl Store for CachedStore {
    async fn put(&self, hash: Hash, data: Vec<u8>) -> Result<bool, StoreError> {
        self.local.put(hash, data).await
    }

    async fn get(&self, hash: &Hash) -> Result<Option<Vec<u8>>, StoreError> {
        if let Ok(Some(data)) = self.local.get(hash).await {
            return Ok(Some(data));
        }

        let result = self.blossom.get(hash).await;
        if let Ok(Some(ref data)) = result {
            let _ = self.local.put(*hash, data.clone()).await;
        }
        result
    }

    async fn has(&self, hash: &Hash) -> Result<bool, StoreError> {
        if self.local.has(hash).await? {
            return Ok(true);
        }
        self.blossom.has(hash).await
    }

    async fn delete(&self, hash: &Hash) -> Result<bool, StoreError> {
        self.local.delete(hash).await
    }
}
