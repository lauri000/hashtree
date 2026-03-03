use std::path::PathBuf;
use std::sync::Arc;

use crate::socialgraph;
use crate::webrtc::{PeerClassifier, PeerPool, WebRTCConfig};

/// Build default WebRTC config with explicit relay set.
pub fn default_webrtc_config(relays: &[String]) -> WebRTCConfig {
    WebRTCConfig {
        relays: relays.to_vec(),
        ..Default::default()
    }
}

/// Build peer classifier used by daemon/runtime startup paths.
pub fn build_peer_classifier(data_dir: PathBuf, ndb: Arc<socialgraph::Ndb>) -> PeerClassifier {
    let contacts_file = data_dir.join("contacts.json");
    Arc::new(move |pubkey_hex: &str| {
        if contacts_file.exists() {
            if let Ok(data) = std::fs::read_to_string(&contacts_file) {
                if let Ok(contacts) = serde_json::from_str::<Vec<String>>(&data) {
                    if contacts.contains(&pubkey_hex.to_string()) {
                        return PeerPool::Follows;
                    }
                }
            }
        }
        if let Ok(pk_bytes) = hex::decode(pubkey_hex) {
            if pk_bytes.len() == 32 {
                let pk: [u8; 32] = pk_bytes.try_into().unwrap();
                if let Some(dist) = socialgraph::get_follow_distance(&ndb, &pk) {
                    if dist <= 2 {
                        return PeerPool::Follows;
                    }
                }
            }
        }
        PeerPool::Other
    })
}
