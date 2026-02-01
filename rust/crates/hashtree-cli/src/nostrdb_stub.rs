//! Stub module for when nostrdb feature is disabled.
//! Provides the same public API as nostrdb_integration with no-op implementations.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

/// Placeholder type for Ndb when nostrdb is disabled
#[derive(Debug)]
pub struct NdbStub;

/// Alias to mirror nostrdb::Ndb when feature is disabled
pub type Ndb = NdbStub;

#[cfg(test)]
pub struct TestLockGuard;

#[cfg(test)]
pub fn test_lock() -> TestLockGuard {
    TestLockGuard
}

/// Initialize nostrdb - returns stub when feature is disabled
pub fn init_ndb(_data_dir: &Path) -> anyhow::Result<Arc<NdbStub>> {
    Ok(Arc::new(NdbStub))
}

/// Initialize nostrdb with optional mapsize - stubbed.
pub fn init_ndb_with_mapsize(_data_dir: &Path, _mapsize_bytes: Option<u64>) -> anyhow::Result<Arc<NdbStub>> {
    Ok(Arc::new(NdbStub))
}

/// Initialize nostrdb at a specific directory - stubbed.
pub fn init_ndb_at_path(_db_dir: &Path, _mapsize_bytes: Option<u64>) -> anyhow::Result<Arc<NdbStub>> {
    Ok(Arc::new(NdbStub))
}

/// Set social graph root - no-op when nostrdb is disabled
pub fn set_social_graph_root(_ndb: &NdbStub, _pk_bytes: &[u8; 32]) {}

/// Get follow distance - always None when nostrdb is disabled
pub fn get_follow_distance(_ndb: &NdbStub, _pk_bytes: &[u8; 32]) -> Option<u32> {
    None
}

/// Get follows list - always empty when nostrdb is disabled
pub fn get_follows(_ndb: &NdbStub, _pk_bytes: &[u8; 32]) -> Vec<[u8; 32]> {
    Vec::new()
}

/// Check if a user is overmuted - always false when nostrdb is disabled
pub fn is_overmuted(_ndb: &NdbStub, _root_pk: &[u8; 32], _user_pk: &[u8; 32], _threshold: f64) -> bool {
    false
}

/// Ingest a Nostr event - no-op when nostrdb is disabled
pub fn ingest_event(_ndb: &NdbStub, _sub_id: &str, _event_json: &str) {}

/// Social graph statistics
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SocialGraphStats {
    pub root: Option<String>,
    pub total_follows: usize,
    pub max_depth: u32,
    pub enabled: bool,
}

/// Access control based on social graph follow distance.
/// When nostrdb is disabled, falls back to allowed_pubkeys only.
#[derive(Clone)]
pub struct SocialGraphAccessControl {
    allowed_pubkeys: HashSet<String>,
}

impl SocialGraphAccessControl {
    pub fn new(
        _ndb: Arc<NdbStub>,
        _max_write_distance: u32,
        allowed_pubkeys: HashSet<String>,
    ) -> Self {
        Self { allowed_pubkeys }
    }

    /// Check if a pubkey (hex) has write access.
    /// Without nostrdb, only allowed_pubkeys list is checked.
    pub fn check_write_access(&self, pubkey_hex: &str) -> bool {
        self.allowed_pubkeys.contains(pubkey_hex)
    }

    pub fn stats(&self) -> SocialGraphStats {
        SocialGraphStats::default()
    }
}

/// Social graph crawler - no-op when nostrdb is disabled
pub struct SocialGraphCrawler;

impl SocialGraphCrawler {
    pub fn new(
        _ndb: Arc<NdbStub>,
        _keys: nostr::Keys,
        _relays: Vec<String>,
        _max_depth: u32,
    ) -> Self {
        SocialGraphCrawler
    }

    pub fn with_spambox(self, _spambox: Arc<NdbStub>) -> Self {
        self
    }

    pub(crate) fn handle_incoming_event(&self, _event: &nostr::Event) {}

    pub async fn crawl(&self, _shutdown_rx: tokio::sync::watch::Receiver<bool>) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_init_ndb_stub() {
        let ndb = init_ndb(&PathBuf::from("/tmp/test-ndb-stub")).unwrap();
        // Should succeed without errors
        assert!(Arc::strong_count(&ndb) == 1);
    }

    #[test]
    fn test_follow_distance_always_none() {
        let ndb = init_ndb(&PathBuf::from("/tmp/test-ndb-stub")).unwrap();
        let pk = [0u8; 32];
        assert_eq!(get_follow_distance(&ndb, &pk), None);
    }

    #[test]
    fn test_get_follows_always_empty() {
        let ndb = init_ndb(&PathBuf::from("/tmp/test-ndb-stub")).unwrap();
        let pk = [0u8; 32];
        assert!(get_follows(&ndb, &pk).is_empty());
    }

    #[test]
    fn test_ingest_event_no_panic() {
        let ndb = init_ndb(&PathBuf::from("/tmp/test-ndb-stub")).unwrap();
        ingest_event(&ndb, "sub1", r#"{"kind":3}"#);
    }

    #[test]
    fn test_set_social_graph_root_no_panic() {
        let ndb = init_ndb(&PathBuf::from("/tmp/test-ndb-stub")).unwrap();
        let pk = [1u8; 32];
        set_social_graph_root(&ndb, &pk);
    }

    #[test]
    fn test_access_control_allowed_pubkeys() {
        let ndb = init_ndb(&PathBuf::from("/tmp/test-ndb-stub")).unwrap();
        let mut allowed = HashSet::new();
        let pk_hex = "aabbccdd".repeat(8);
        allowed.insert(pk_hex.clone());

        let ac = SocialGraphAccessControl::new(ndb, 3, allowed);
        assert!(ac.check_write_access(&pk_hex));
        assert!(!ac.check_write_access("00000000".repeat(8).as_str()));
    }

    #[test]
    fn test_access_control_empty_allowed() {
        let ndb = init_ndb(&PathBuf::from("/tmp/test-ndb-stub")).unwrap();
        let ac = SocialGraphAccessControl::new(ndb, 3, HashSet::new());
        assert!(!ac.check_write_access("anything"));
    }

    #[test]
    fn test_stats_disabled() {
        let ndb = init_ndb(&PathBuf::from("/tmp/test-ndb-stub")).unwrap();
        let ac = SocialGraphAccessControl::new(ndb, 3, HashSet::new());
        let stats = ac.stats();
        assert!(!stats.enabled);
        assert_eq!(stats.total_follows, 0);
    }

    #[tokio::test]
    async fn test_crawler_noop() {
        let ndb = init_ndb(&PathBuf::from("/tmp/test-ndb-stub")).unwrap();
        let keys = nostr::Keys::generate();
        let crawler = SocialGraphCrawler::new(ndb, keys, vec![], 2);
        let (tx, rx) = tokio::sync::watch::channel(false);
        // Should return immediately
        crawler.crawl(rx).await;
        drop(tx);
    }
}
