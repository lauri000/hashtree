//! Nostrdb integration for social graph-based access control and peer classification.

pub mod access;
pub mod crawler;

use nostrdb::{Config as NdbConfig, Ndb, Transaction};
use std::path::Path;
use std::sync::Arc;

pub use access::SocialGraphAccessControl;
pub use crawler::SocialGraphCrawler;

/// Social graph statistics
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SocialGraphStats {
    pub root: Option<String>,
    pub total_follows: usize,
    pub max_depth: u32,
    pub enabled: bool,
}

/// Initialize nostrdb with the given data directory.
pub fn init_ndb(data_dir: &Path) -> anyhow::Result<Arc<Ndb>> {
    let ndb_dir = data_dir.join("nostrdb");
    std::fs::create_dir_all(&ndb_dir)?;
    let config = NdbConfig::new()
        .set_ingester_threads(2);
    let ndb = Ndb::new(ndb_dir.to_str().unwrap_or("."), &config)?;
    Ok(Arc::new(ndb))
}

/// Set the social graph root pubkey.
pub fn set_social_graph_root(ndb: &Ndb, pk_bytes: &[u8; 32]) {
    nostrdb::socialgraph::set_root(ndb, pk_bytes);
}

/// Get the follow distance for a pubkey from the social graph root.
/// Returns None if the pubkey is not in the social graph.
pub fn get_follow_distance(ndb: &Ndb, pk_bytes: &[u8; 32]) -> Option<u32> {
    let txn = Transaction::new(ndb).ok()?;
    let distance = nostrdb::socialgraph::get_follow_distance(&txn, ndb, pk_bytes);
    if distance >= 1000 {
        None
    } else {
        Some(distance)
    }
}

/// Get the list of pubkeys that a given pubkey follows.
pub fn get_follows(ndb: &Ndb, pk_bytes: &[u8; 32]) -> Vec<[u8; 32]> {
    let txn = match Transaction::new(ndb) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    nostrdb::socialgraph::get_followed(&txn, ndb, pk_bytes, 10000)
}

/// Ingest a Nostr event JSON string into nostrdb.
/// Wraps the event in relay format: ["EVENT","sub_id",{...}]
pub fn ingest_event(ndb: &Ndb, sub_id: &str, event_json: &str) {
    let relay_msg = format!(r#"["EVENT","{}",{}]"#, sub_id, event_json);
    if let Err(e) = ndb.process_event(&relay_msg) {
        tracing::warn!("Failed to ingest event into nostrdb: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_init_ndb() {
        let tmp = TempDir::new().unwrap();
        let ndb = init_ndb(tmp.path()).unwrap();
        assert!(Arc::strong_count(&ndb) == 1);
    }

    #[test]
    fn test_set_root_and_get_follow_distance() {
        let tmp = TempDir::new().unwrap();
        let ndb = init_ndb(tmp.path()).unwrap();
        let root_pk = [1u8; 32];
        set_social_graph_root(&ndb, &root_pk);
        // Give nostrdb a moment to process the root setting
        std::thread::sleep(std::time::Duration::from_millis(100));
        let dist = get_follow_distance(&ndb, &root_pk);
        assert_eq!(dist, Some(0));
    }

    #[test]
    fn test_unknown_pubkey_follow_distance() {
        let tmp = TempDir::new().unwrap();
        let ndb = init_ndb(tmp.path()).unwrap();
        let root_pk = [1u8; 32];
        set_social_graph_root(&ndb, &root_pk);
        std::thread::sleep(std::time::Duration::from_millis(100));
        let unknown_pk = [2u8; 32];
        assert_eq!(get_follow_distance(&ndb, &unknown_pk), None);
    }

    #[test]
    fn test_ingest_event_no_panic() {
        let tmp = TempDir::new().unwrap();
        let ndb = init_ndb(tmp.path()).unwrap();
        // Pass invalid event - should not panic, just log warning
        ingest_event(&ndb, "sub1", r#"{"kind":1,"content":"hello"}"#);
    }

    #[test]
    fn test_get_follows_empty() {
        let tmp = TempDir::new().unwrap();
        let ndb = init_ndb(tmp.path()).unwrap();
        let pk = [1u8; 32];
        assert!(get_follows(&ndb, &pk).is_empty());
    }
}
