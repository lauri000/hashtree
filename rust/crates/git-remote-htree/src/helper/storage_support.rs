use anyhow::Result;
use hashtree_config::{Config, StorageBackend};
use hashtree_core::Store;
use hashtree_fs::FsBlobStore;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(not(feature = "lmdb"))]
use tracing::warn;

pub(super) fn get_hashtree_data_dir() -> PathBuf {
    hashtree_config::get_data_dir()
}

pub(super) fn queue_hash_if_new(
    queue: &mut Vec<([u8; 32], Option<[u8; 32]>)>,
    queued: &mut HashSet<[u8; 32]>,
    hash: [u8; 32],
    key: Option<[u8; 32]>,
) -> bool {
    if queued.insert(hash) {
        queue.push((hash, key));
        true
    } else {
        false
    }
}

pub(super) fn create_local_store(path: &Path) -> Result<Arc<dyn Store + Send + Sync>> {
    let config = Config::load_or_default();
    let max_size_bytes = config
        .storage
        .max_size_gb
        .saturating_mul(1024 * 1024 * 1024);
    match config.storage.backend {
        StorageBackend::Fs => {
            if max_size_bytes > 0 {
                Ok(Arc::new(FsBlobStore::with_max_bytes(path, max_size_bytes)?))
            } else {
                Ok(Arc::new(FsBlobStore::new(path)?))
            }
        }
        #[cfg(feature = "lmdb")]
        StorageBackend::Lmdb => Ok(Arc::new(if max_size_bytes > 0 {
            hashtree_lmdb::LmdbBlobStore::with_max_bytes(path, max_size_bytes)?
        } else {
            hashtree_lmdb::LmdbBlobStore::new(path)?
        })),
        #[cfg(not(feature = "lmdb"))]
        StorageBackend::Lmdb => {
            warn!("LMDB backend requested but lmdb feature not enabled, using filesystem storage");
            if max_size_bytes > 0 {
                Ok(Arc::new(FsBlobStore::with_max_bytes(path, max_size_bytes)?))
            } else {
                Ok(Arc::new(FsBlobStore::new(path)?))
            }
        }
    }
}

pub(super) fn build_repo_viewer_url(path: &str, url_secret: Option<&[u8; 32]>) -> String {
    match url_secret {
        Some(secret) => format!("https://git.iris.to/#/{}?k={}", path, hex::encode(secret)),
        None => format!("https://git.iris.to/#/{}", path),
    }
}
