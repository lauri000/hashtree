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

#[tokio::test]
async fn embedded_daemon_background_services_follow_live_relay_settings() {
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
    config.nostr.enabled = true;
    config.nostr.relays = vec!["ws://127.0.0.1:1".to_string()];
    config.nostr.crawl_depth = 1;
    config.sync.enabled = true;
    config.sync.sync_own = true;
    config.sync.sync_followed = false;

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
        .background_services_controller
        .clone()
        .expect("background services controller");

    let initial = controller.status().await;
    assert!(
        initial.crawler_active,
        "crawler should start when relays are enabled"
    );
    assert!(
        initial.sync_active,
        "background sync should start when relays are enabled"
    );

    let mut relays_disabled = config.clone();
    relays_disabled.nostr.enabled = false;

    let disabled = controller
        .apply_config(&relays_disabled)
        .await
        .expect("disable relay-backed background services");
    assert!(
        !disabled.crawler_active,
        "crawler should stop when relays are disabled"
    );
    assert!(
        !disabled.sync_active,
        "background sync should stop when relays are disabled"
    );

    let restarted = controller
        .apply_config(&config)
        .await
        .expect("re-enable relay-backed background services");
    assert!(
        restarted.crawler_active,
        "crawler should restart when relays return"
    );
    assert!(
        restarted.sync_active,
        "background sync should restart when relays return"
    );

    controller
        .apply_config(&relays_disabled)
        .await
        .expect("shut down background services");
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
