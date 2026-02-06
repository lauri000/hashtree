use std::time::Duration;

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
