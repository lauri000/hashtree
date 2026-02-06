//! Social graph-based write access control using nostrdb.

use nostrdb_social::Ndb;
use std::collections::HashSet;
use std::sync::Arc;

use super::SocialGraphStats;

/// Access control that combines allowed_pubkeys with social graph follow distance.
#[derive(Clone)]
pub struct SocialGraphAccessControl {
    ndb: Arc<Ndb>,
    max_write_distance: u32,
    allowed_pubkeys: HashSet<String>,
}

impl SocialGraphAccessControl {
    pub fn new(ndb: Arc<Ndb>, max_write_distance: u32, allowed_pubkeys: HashSet<String>) -> Self {
        Self {
            ndb,
            max_write_distance,
            allowed_pubkeys,
        }
    }

    /// Check if a pubkey (hex) has write access.
    /// Returns true if:
    /// 1. The pubkey is in the allowed_pubkeys set, OR
    /// 2. The pubkey's follow distance from the root is <= max_write_distance
    pub fn check_write_access(&self, pubkey_hex: &str) -> bool {
        if self.allowed_pubkeys.contains(pubkey_hex) {
            return true;
        }

        if let Ok(pk_bytes) = hex::decode(pubkey_hex) {
            if pk_bytes.len() == 32 {
                let pk: [u8; 32] = pk_bytes.try_into().unwrap();
                if let Some(distance) = super::get_follow_distance(&self.ndb, &pk) {
                    return distance <= self.max_write_distance;
                }
            }
        }

        false
    }

    pub fn stats(&self) -> SocialGraphStats {
        SocialGraphStats {
            root: None,
            total_follows: 0,
            max_depth: self.max_write_distance,
            enabled: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Arc<Ndb>) {
        let tmp = TempDir::new().unwrap();
        let ndb = super::super::init_ndb(tmp.path()).unwrap();
        (tmp, ndb)
    }

    #[test]
    fn test_allowed_pubkey_passes() {
        let _guard = super::super::test_lock();
        let (_tmp, ndb) = setup();
        let pk_hex = "aa".repeat(32);
        let mut allowed = HashSet::new();
        allowed.insert(pk_hex.clone());

        let ac = SocialGraphAccessControl::new(ndb, 3, allowed);
        assert!(ac.check_write_access(&pk_hex));
    }

    #[test]
    fn test_unknown_pubkey_denied() {
        let _guard = super::super::test_lock();
        let (_tmp, ndb) = setup();
        let root_pk = [1u8; 32];
        super::super::set_social_graph_root(&ndb, &root_pk);
        std::thread::sleep(std::time::Duration::from_millis(100));

        let ac = SocialGraphAccessControl::new(ndb, 3, HashSet::new());
        let unknown = "bb".repeat(32);
        assert!(!ac.check_write_access(&unknown));
    }

    #[test]
    fn test_root_pubkey_within_distance() {
        let _guard = super::super::test_lock();
        let (_tmp, ndb) = setup();
        let root_pk = [1u8; 32];
        super::super::set_social_graph_root(&ndb, &root_pk);
        std::thread::sleep(std::time::Duration::from_millis(100));

        let ac = SocialGraphAccessControl::new(ndb, 3, HashSet::new());
        let root_hex = hex::encode(root_pk);
        assert!(ac.check_write_access(&root_hex));
    }

    #[test]
    fn test_stats_enabled() {
        let _guard = super::super::test_lock();
        let (_tmp, ndb) = setup();
        let ac = SocialGraphAccessControl::new(ndb, 3, HashSet::new());
        let stats = ac.stats();
        assert!(stats.enabled);
    }
}
