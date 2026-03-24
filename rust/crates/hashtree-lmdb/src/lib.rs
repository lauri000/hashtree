//! LMDB-backed content-addressed blob storage.

use async_trait::async_trait;
use hashtree_core::store::{Store, StoreError};
use hashtree_core::types::Hash;
use heed::types::*;
use heed::{Database, EnvOpenOptions};
use std::path::Path;

// Re-export sha256 for convenience
pub use hashtree_core::hash::sha256 as compute_sha256;

const DEFAULT_MAP_SIZE: usize = 10 * 1024 * 1024 * 1024;
const DEFAULT_MAX_READERS: u32 = 1024;

/// LMDB-backed blob store implementing hashtree's Store trait.
pub struct LmdbBlobStore {
    env: heed::Env,
    /// Maps SHA256 hash (32 bytes) → blob data
    blobs: Database<Bytes, Bytes>,
}

impl LmdbBlobStore {
    /// Open or create an LMDB blob store at the given path.
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, StoreError> {
        Self::with_map_size(path, DEFAULT_MAP_SIZE)
    }

    /// Open or create with custom map size.
    pub fn with_map_size<P: AsRef<Path>>(path: P, map_size: usize) -> Result<Self, StoreError> {
        std::fs::create_dir_all(&path).map_err(StoreError::Io)?;

        let env = unsafe {
            EnvOpenOptions::new()
                .map_size(map_size)
                .max_dbs(1)
                .max_readers(DEFAULT_MAX_READERS)
                .open(path)
                .map_err(|e| StoreError::Other(e.to_string()))?
        };
        let _ = env.clear_stale_readers();

        let mut wtxn = env
            .write_txn()
            .map_err(|e| StoreError::Other(e.to_string()))?;
        let blobs = env
            .create_database(&mut wtxn, Some("blobs"))
            .map_err(|e| StoreError::Other(e.to_string()))?;
        wtxn.commit()
            .map_err(|e| StoreError::Other(e.to_string()))?;

        Ok(Self { env, blobs })
    }

    /// Check if a hash exists (sync version for internal use).
    pub fn exists(&self, hash: &Hash) -> Result<bool, StoreError> {
        let rtxn = self
            .env
            .read_txn()
            .map_err(|e| StoreError::Other(e.to_string()))?;

        Ok(self
            .blobs
            .get(&rtxn, hash)
            .map_err(|e| StoreError::Other(e.to_string()))?
            .is_some())
    }

    /// Get storage statistics.
    pub fn stats(&self) -> Result<LmdbStats, StoreError> {
        let rtxn = self
            .env
            .read_txn()
            .map_err(|e| StoreError::Other(e.to_string()))?;

        let count = self
            .blobs
            .len(&rtxn)
            .map_err(|e| StoreError::Other(e.to_string()))? as usize;

        let mut total_bytes = 0u64;
        for item in self
            .blobs
            .iter(&rtxn)
            .map_err(|e| StoreError::Other(e.to_string()))?
        {
            let (_, data) = item.map_err(|e| StoreError::Other(e.to_string()))?;
            total_bytes += data.len() as u64;
        }

        Ok(LmdbStats { count, total_bytes })
    }

    /// List all hashes in the store.
    pub fn list(&self) -> Result<Vec<Hash>, StoreError> {
        let rtxn = self
            .env
            .read_txn()
            .map_err(|e| StoreError::Other(e.to_string()))?;

        let mut hashes = Vec::new();
        for item in self
            .blobs
            .iter(&rtxn)
            .map_err(|e| StoreError::Other(e.to_string()))?
        {
            let (hash, _) = item.map_err(|e| StoreError::Other(e.to_string()))?;
            let hash_arr: Hash = hash
                .try_into()
                .map_err(|_| StoreError::Other("invalid hash length".into()))?;
            hashes.push(hash_arr);
        }

        Ok(hashes)
    }

    /// Sync put operation (for use in sync contexts).
    pub fn put_sync(&self, hash: Hash, data: &[u8]) -> Result<bool, StoreError> {
        let mut wtxn = self
            .env
            .write_txn()
            .map_err(|e| StoreError::Other(e.to_string()))?;

        let existed = self
            .blobs
            .get(&wtxn, &hash)
            .map_err(|e| StoreError::Other(e.to_string()))?
            .is_some();

        if !existed {
            self.blobs
                .put(&mut wtxn, &hash, data)
                .map_err(|e| StoreError::Other(e.to_string()))?;
        }

        wtxn.commit()
            .map_err(|e| StoreError::Other(e.to_string()))?;

        Ok(!existed)
    }

    /// Sync get operation (for use in sync contexts).
    pub fn get_sync(&self, hash: &Hash) -> Result<Option<Vec<u8>>, StoreError> {
        let rtxn = self
            .env
            .read_txn()
            .map_err(|e| StoreError::Other(e.to_string()))?;

        Ok(self
            .blobs
            .get(&rtxn, hash)
            .map_err(|e| StoreError::Other(e.to_string()))?
            .map(|b| b.to_vec()))
    }

    /// Sync delete operation (for use in sync contexts).
    pub fn delete_sync(&self, hash: &Hash) -> Result<bool, StoreError> {
        let mut wtxn = self
            .env
            .write_txn()
            .map_err(|e| StoreError::Other(e.to_string()))?;

        let existed = self
            .blobs
            .delete(&mut wtxn, hash)
            .map_err(|e| StoreError::Other(e.to_string()))?;

        wtxn.commit()
            .map_err(|e| StoreError::Other(e.to_string()))?;

        Ok(existed)
    }
}

#[derive(Debug, Clone)]
pub struct LmdbStats {
    pub count: usize,
    pub total_bytes: u64,
}

#[async_trait]
impl Store for LmdbBlobStore {
    async fn put(&self, hash: Hash, data: Vec<u8>) -> Result<bool, StoreError> {
        self.put_sync(hash, &data)
    }

    async fn get(&self, hash: &Hash) -> Result<Option<Vec<u8>>, StoreError> {
        self.get_sync(hash)
    }

    async fn has(&self, hash: &Hash) -> Result<bool, StoreError> {
        self.exists(hash)
    }

    async fn delete(&self, hash: &Hash) -> Result<bool, StoreError> {
        self.delete_sync(hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hashtree_core::sha256;
    use heed::EnvOpenOptions;
    #[cfg(unix)]
    use std::path::{Path, PathBuf};
    #[cfg(unix)]
    use std::process::Command;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Barrier,
    };
    use std::time::Duration;
    use tempfile::TempDir;

    #[cfg(unix)]
    const STALE_READER_HELPER_ENV: &str = "HASHTREE_LMDB_STALE_READER_HELPER";
    #[cfg(unix)]
    const STALE_READER_HELPER_MODE_ENV: &str = "HASHTREE_LMDB_STALE_READER_HELPER_MODE";
    #[cfg(unix)]
    const STALE_READER_DB_PATH_ENV: &str = "HASHTREE_LMDB_STALE_READER_DB_PATH";
    #[cfg(unix)]
    const STALE_READER_MARKER_PATH_ENV: &str = "HASHTREE_LMDB_STALE_READER_MARKER_PATH";
    #[cfg(unix)]
    const TEST_MAX_READERS: u32 = 4;

    #[cfg(unix)]
    fn run_helper(mode: &str, path: &Path, marker: &Path) {
        let output = Command::new(std::env::current_exe().expect("test binary path"))
            .arg("--ignored")
            .arg("--exact")
            .arg("tests::lmdb_stale_reader_helper")
            .env(STALE_READER_HELPER_ENV, "1")
            .env(STALE_READER_HELPER_MODE_ENV, mode)
            .env(STALE_READER_DB_PATH_ENV, path)
            .env(STALE_READER_MARKER_PATH_ENV, marker)
            .env("RUST_TEST_THREADS", "1")
            .output()
            .expect("spawn stale-reader helper");

        assert!(
            output.status.success(),
            "stale-reader helper failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            marker.exists(),
            "stale-reader helper did not run: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn test_put_get() -> Result<(), StoreError> {
        let temp = TempDir::new().unwrap();
        let store = LmdbBlobStore::new(temp.path().join("blobs"))?;

        let data = b"hello lmdb";
        let hash = sha256(data);
        store.put(hash, data.to_vec()).await?;

        assert!(store.has(&hash).await?);
        assert_eq!(store.get(&hash).await?, Some(data.to_vec()));

        Ok(())
    }

    #[tokio::test]
    async fn test_delete() -> Result<(), StoreError> {
        let temp = TempDir::new().unwrap();
        let store = LmdbBlobStore::new(temp.path().join("blobs"))?;

        let data = b"delete me";
        let hash = sha256(data);
        store.put(hash, data.to_vec()).await?;
        assert!(store.has(&hash).await?);

        assert!(store.delete(&hash).await?);
        assert!(!store.has(&hash).await?);
        assert!(!store.delete(&hash).await?);

        Ok(())
    }

    #[tokio::test]
    async fn test_list() -> Result<(), StoreError> {
        let temp = TempDir::new().unwrap();
        let store = LmdbBlobStore::new(temp.path().join("blobs"))?;

        let d1 = b"one";
        let d2 = b"two";
        let d3 = b"three";
        let h1 = sha256(d1);
        let h2 = sha256(d2);
        let h3 = sha256(d3);

        store.put(h1, d1.to_vec()).await?;
        store.put(h2, d2.to_vec()).await?;
        store.put(h3, d3.to_vec()).await?;

        let hashes = store.list()?;
        assert_eq!(hashes.len(), 3);
        assert!(hashes.contains(&h1));
        assert!(hashes.contains(&h2));
        assert!(hashes.contains(&h3));

        Ok(())
    }

    #[tokio::test]
    async fn test_stats() -> Result<(), StoreError> {
        let temp = TempDir::new().unwrap();
        let store = LmdbBlobStore::new(temp.path().join("blobs"))?;

        let d1 = b"hello";
        let d2 = b"world";
        store.put(sha256(d1), d1.to_vec()).await?;
        store.put(sha256(d2), d2.to_vec()).await?;

        let stats = store.stats()?;
        assert_eq!(stats.count, 2);
        assert_eq!(stats.total_bytes, 10);

        Ok(())
    }

    #[tokio::test]
    async fn test_deduplication() -> Result<(), StoreError> {
        let temp = TempDir::new().unwrap();
        let store = LmdbBlobStore::new(temp.path().join("blobs"))?;

        let data = b"same";
        let hash = sha256(data);
        assert!(store.put(hash, data.to_vec()).await?); // Returns true (newly stored)
        assert!(!store.put(hash, data.to_vec()).await?); // Returns false (already existed)

        assert_eq!(store.list()?.len(), 1);

        Ok(())
    }

    #[test]
    fn test_supports_many_concurrent_readers() -> Result<(), Box<dyn std::error::Error>> {
        const READER_THREADS: usize = 160;

        let temp = TempDir::new()?;
        let store = Arc::new(LmdbBlobStore::new(temp.path().join("blobs"))?);
        let hash = sha256(b"many readers");
        store.put_sync(hash, b"many readers")?;

        let start = Arc::new(Barrier::new(READER_THREADS + 1));
        let release = Arc::new(AtomicBool::new(false));
        let mut handles = Vec::with_capacity(READER_THREADS);

        for _ in 0..READER_THREADS {
            let env = store.env.clone();
            let start = Arc::clone(&start);
            let release = Arc::clone(&release);
            handles.push(std::thread::spawn(move || -> Result<(), String> {
                start.wait();
                let _rtxn = env.read_txn().map_err(|err| err.to_string())?;
                while !release.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Ok(())
            }));
        }

        start.wait();
        std::thread::sleep(Duration::from_millis(50));
        release.store(true, Ordering::Relaxed);

        let results: Vec<Result<(), String>> = handles
            .into_iter()
            .map(|handle| handle.join().expect("reader thread panicked"))
            .collect();

        let failures: Vec<String> = results.into_iter().filter_map(Result::err).collect();
        assert!(
            failures.is_empty(),
            "concurrent reader failures: {}",
            failures.join(" | ")
        );
        assert!(store.exists(&hash)?);

        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn test_reclaims_stale_reader_slots() -> Result<(), Box<dyn std::error::Error>> {
        let temp = TempDir::new()?;
        let path = temp.path().join("blobs");
        let data = b"hello stale readers";
        let hash = sha256(data);

        run_helper("setup", &path, &temp.path().join("setup.marker"));

        for index in 0..TEST_MAX_READERS {
            let marker = temp.path().join(format!("helper-{index}.marker"));
            run_helper("stale", &path, &marker);
        }

        let store = LmdbBlobStore::with_map_size(&path, 1024 * 1024)?;
        assert!(store.exists(&hash)?);

        Ok(())
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "used as a subprocess helper by test_reclaims_stale_reader_slots"]
    fn lmdb_stale_reader_helper() {
        let Some(db_path) = std::env::var_os(STALE_READER_DB_PATH_ENV) else {
            return;
        };
        let marker_path =
            PathBuf::from(std::env::var_os(STALE_READER_MARKER_PATH_ENV).expect("marker path"));
        std::fs::write(&marker_path, b"started").expect("write helper marker");

        let _env_flag = std::env::var_os(STALE_READER_HELPER_ENV).expect("helper mode enabled");
        let mode = std::env::var(STALE_READER_HELPER_MODE_ENV).expect("helper mode");
        let db_path = PathBuf::from(db_path);
        std::fs::create_dir_all(&db_path).expect("create helper db dir");
        let env = unsafe {
            EnvOpenOptions::new()
                .map_size(1024 * 1024)
                .max_dbs(1)
                .max_readers(TEST_MAX_READERS)
                .open(&db_path)
                .expect("open lmdb env")
        };
        match mode.as_str() {
            "setup" => {
                let mut wtxn = env.write_txn().expect("open write txn");
                let blobs: Database<Bytes, Bytes> = env
                    .create_database(&mut wtxn, Some("blobs"))
                    .expect("create blobs database");
                let data = b"hello stale readers";
                let hash = sha256(data);
                blobs.put(&mut wtxn, &hash, data).expect("seed blob");
                wtxn.commit().expect("commit setup txn");
                std::process::exit(0);
            }
            "stale" => {
                let _rtxn = env.read_txn().expect("open read txn");
                std::process::exit(0);
            }
            other => panic!("unknown helper mode: {other}"),
        }
    }
}
