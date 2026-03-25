use std::path::PathBuf;
use std::sync::Arc;

use crate::config::Config;
use crate::socialgraph;
use crate::webrtc::{MulticastConfig, PeerClassifier, PeerPool, WebRTCConfig};

fn relay_is_loopback(relay: &str) -> bool {
    relay.contains("://127.0.0.1") || relay.contains("://localhost") || relay.contains("://[::1]")
}

/// Build default WebRTC config from daemon/app config.
pub fn default_webrtc_config(config: &Config) -> WebRTCConfig {
    let local_only_relays = !config.nostr.relays.is_empty()
        && config
            .nostr
            .relays
            .iter()
            .all(|relay| relay_is_loopback(relay));

    WebRTCConfig {
        relays: config.nostr.relays.clone(),
        stun_servers: if config.server.enable_multicast && local_only_relays {
            Vec::new()
        } else {
            WebRTCConfig::default().stun_servers
        },
        multicast: MulticastConfig {
            enabled: config.server.enable_multicast,
            group: config.server.multicast_group.clone(),
            port: config.server.multicast_port,
            max_peers: config.server.max_multicast_peers,
            ..Default::default()
        },
        ..Default::default()
    }
}

/// Build peer classifier used by daemon/runtime startup paths.
pub fn build_peer_classifier(
    data_dir: PathBuf,
    store: Arc<dyn socialgraph::SocialGraphBackend>,
) -> PeerClassifier {
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
                if let Some(dist) = socialgraph::get_follow_distance(store.as_ref(), &pk) {
                    if dist <= 2 {
                        return PeerPool::Follows;
                    }
                }
            }
        }
        PeerPool::Other
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_webrtc_config_disables_stun_for_loopback_only_multicast() {
        let mut config = Config::default();
        config.server.enable_multicast = true;
        config.server.max_multicast_peers = 4;
        config.nostr.relays = vec!["ws://127.0.0.1:8080/ws".to_string()];

        let webrtc = default_webrtc_config(&config);
        assert!(webrtc.stun_servers.is_empty());
    }

    #[test]
    fn default_webrtc_config_keeps_stun_for_non_loopback_relays() {
        let mut config = Config::default();
        config.server.enable_multicast = true;
        config.server.max_multicast_peers = 4;
        config.nostr.relays = vec!["wss://relay.example".to_string()];

        let webrtc = default_webrtc_config(&config);
        assert!(!webrtc.stun_servers.is_empty());
    }
}
