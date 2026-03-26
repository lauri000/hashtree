use std::time::Duration;

use serde_json::Value;
use tempfile::TempDir;

#[tokio::test]
async fn embedded_daemon_serves_htree_test() {
    let dir = TempDir::new().expect("temp dir");
    std::env::set_var("HTREE_CONFIG_DIR", dir.path());
    std::env::set_var("HTREE_DATA_DIR", dir.path());

    let data_dir = dir.path().join("data");
    std::fs::create_dir_all(&data_dir).expect("create data dir");

    let mut config = hashtree_cli::Config::default();
    config.storage.data_dir = data_dir.to_string_lossy().to_string();
    config.server.enable_auth = false;
    config.server.enable_webrtc = false;
    config.server.stun_port = 0;

    let info = hashtree_cli::daemon::start_embedded(hashtree_cli::daemon::EmbeddedDaemonOptions {
        config,
        data_dir: data_dir.clone(),
        bind_address: "127.0.0.1:0".to_string(),
        relays: None,
        extra_routes: None,
        cors: None,
    })
    .await
    .expect("start embedded daemon");

    let base = format!("http://127.0.0.1:{}", info.port);
    let mut ok = false;
    for _ in 0..10 {
        if let Ok(resp) = reqwest::get(format!("{}/htree/test", base)).await {
            if resp.status().is_success() {
                ok = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    assert!(ok, "expected /htree/test to respond");
}

#[tokio::test]
async fn embedded_daemon_uses_default_blossom_servers_when_config_is_empty() {
    let dir = TempDir::new().expect("temp dir");
    std::env::set_var("HTREE_CONFIG_DIR", dir.path());
    std::env::set_var("HTREE_DATA_DIR", dir.path());

    let data_dir = dir.path().join("data");
    std::fs::create_dir_all(&data_dir).expect("create data dir");

    let mut config = hashtree_cli::Config::default();
    config.storage.data_dir = data_dir.to_string_lossy().to_string();
    config.server.enable_auth = false;
    config.server.enable_webrtc = false;
    config.server.stun_port = 0;
    config.blossom.servers.clear();
    config.blossom.read_servers.clear();
    config.blossom.write_servers.clear();

    let info = hashtree_cli::daemon::start_embedded(hashtree_cli::daemon::EmbeddedDaemonOptions {
        config,
        data_dir: data_dir.clone(),
        bind_address: "127.0.0.1:0".to_string(),
        relays: None,
        extra_routes: None,
        cors: None,
    })
    .await
    .expect("start embedded daemon");

    let status: Value = reqwest::get(format!("http://127.0.0.1:{}/api/status", info.port))
        .await
        .expect("fetch daemon status")
        .json()
        .await
        .expect("parse daemon status json");

    let blossom_servers = status["upstream"]["blossom_servers"]
        .as_u64()
        .expect("blossom_servers count");
    assert!(
        blossom_servers >= 2,
        "expected embedded daemon to keep default blossom read servers, got {blossom_servers}"
    );
}

#[cfg(feature = "p2p")]
#[tokio::test]
async fn embedded_daemon_exposes_live_peer_router_controller() {
    let dir = TempDir::new().expect("temp dir");
    std::env::set_var("HTREE_CONFIG_DIR", dir.path());
    std::env::set_var("HTREE_DATA_DIR", dir.path());

    let data_dir = dir.path().join("data");
    std::fs::create_dir_all(&data_dir).expect("create data dir");

    let mut config = hashtree_cli::Config::default();
    config.storage.data_dir = data_dir.to_string_lossy().to_string();
    config.server.enable_auth = false;
    config.server.enable_webrtc = false;
    config.server.enable_multicast = false;
    config.server.max_multicast_peers = 0;
    config.server.enable_bluetooth = false;
    config.server.max_bluetooth_peers = 0;
    config.server.stun_port = 0;
    config.sync.enabled = false;
    config.nostr.relays.clear();

    let info = hashtree_cli::daemon::start_embedded(hashtree_cli::daemon::EmbeddedDaemonOptions {
        config: config.clone(),
        data_dir: data_dir.clone(),
        bind_address: "127.0.0.1:0".to_string(),
        relays: None,
        extra_routes: None,
        cors: None,
    })
    .await
    .expect("start embedded daemon");

    let controller = info
        .peer_router_controller
        .clone()
        .expect("peer router controller");
    let state = info.webrtc_state.clone().expect("shared webrtc state");

    let disabled = controller
        .apply_config(&config)
        .await
        .expect("apply disabled config");
    assert!(!disabled, "all transports disabled should stop the router");

    let mut enabled_config = config.clone();
    enabled_config.server.enable_webrtc = true;
    let enabled = controller
        .apply_config(&enabled_config)
        .await
        .expect("apply enabled config");
    assert!(enabled, "webrtc toggle should start the router");

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        state.peers.read().await.is_empty(),
        "no peers expected in test"
    );

    controller
        .apply_config(&config)
        .await
        .expect("disable router again");
}
