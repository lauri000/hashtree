use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::Router;
use nostr::nips::nip19::ToBech32;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use crate::config::{ensure_keys, parse_npub, pubkey_bytes, Config};
use crate::nostr_relay::{NostrRelay, NostrRelayConfig};
use crate::server::{AppState, HashtreeServer};
use crate::socialgraph;
use crate::storage::HashtreeStore;

#[cfg(feature = "p2p")]
use crate::webrtc::{ContentStore, PeerClassifier, PeerPool, WebRTCConfig, WebRTCManager, WebRTCState};

pub struct EmbeddedDaemonOptions {
    pub config: Config,
    pub data_dir: PathBuf,
    pub bind_address: String,
    pub relays: Option<Vec<String>>,
    pub extra_routes: Option<Router<AppState>>,
    pub cors: Option<CorsLayer>,
}

pub struct EmbeddedDaemonInfo {
    pub addr: String,
    pub port: u16,
    pub store: Arc<HashtreeStore>,
    #[allow(dead_code)]
    pub webrtc_state: Option<Arc<WebRTCState>>,
}

pub async fn start_embedded(opts: EmbeddedDaemonOptions) -> Result<EmbeddedDaemonInfo> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mut config = opts.config;
    if let Some(relays) = opts.relays {
        config.nostr.relays = relays;
    }

    let max_size_bytes = config.storage.max_size_gb * 1024 * 1024 * 1024;
    let nostr_db_max_bytes = config
        .nostr
        .db_max_size_gb
        .saturating_mul(1024 * 1024 * 1024);
    let spambox_db_max_bytes = config
        .nostr
        .spambox_max_size_gb
        .saturating_mul(1024 * 1024 * 1024);

    let store = Arc::new(HashtreeStore::with_options(
        &opts.data_dir,
        config.storage.s3.as_ref(),
        max_size_bytes,
    )?);

    let (keys, _was_generated) = ensure_keys()?;
    let pk_bytes = pubkey_bytes(&keys);
    let npub = keys
        .public_key()
        .to_bech32()
        .context("Failed to encode npub")?;

    let mut allowed_pubkeys: HashSet<String> = HashSet::new();
    allowed_pubkeys.insert(hex::encode(pk_bytes));
    for npub_str in &config.nostr.allowed_npubs {
        if let Ok(pk) = parse_npub(npub_str) {
            allowed_pubkeys.insert(hex::encode(pk));
        } else {
            tracing::warn!("Invalid npub in allowed_npubs: {}", npub_str);
        }
    }

    let ndb = socialgraph::init_ndb_with_mapsize(&opts.data_dir, Some(nostr_db_max_bytes))
        .context("Failed to initialize nostrdb")?;

    let social_graph_root_bytes = if let Some(ref root_npub) = config.nostr.socialgraph_root {
        parse_npub(root_npub).unwrap_or(pk_bytes)
    } else {
        pk_bytes
    };
    socialgraph::set_social_graph_root(&ndb, &social_graph_root_bytes);

    let social_graph = Arc::new(socialgraph::SocialGraphAccessControl::new(
        Arc::clone(&ndb),
        config.nostr.max_write_distance,
        allowed_pubkeys.clone(),
    ));

    let nostr_relay_config = NostrRelayConfig {
        spambox_db_max_bytes,
        ..Default::default()
    };
    let nostr_relay = Arc::new(
        NostrRelay::new(
            Arc::clone(&ndb),
            opts.data_dir.clone(),
            Some(social_graph.clone()),
            nostr_relay_config,
        )
        .context("Failed to initialize Nostr relay")?,
    );

    let crawler_spambox = if spambox_db_max_bytes == 0 {
        None
    } else {
        let spam_dir = opts.data_dir.join("nostrdb_spambox");
        match socialgraph::init_ndb_at_path(&spam_dir, Some(spambox_db_max_bytes)) {
            Ok(db) => Some(db),
            Err(err) => {
                tracing::warn!("Failed to open spambox nostrdb for crawler: {}", err);
                None
            }
        }
    };

    let crawler_ndb = Arc::clone(&ndb);
    let crawler_keys = keys.clone();
    let crawler_relays = config.nostr.relays.clone();
    let crawler_depth = config.nostr.crawl_depth;
    let crawler_spambox = crawler_spambox.clone();
    let (_crawler_shutdown_tx, crawler_shutdown_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let mut crawler = socialgraph::SocialGraphCrawler::new(
            crawler_ndb,
            crawler_keys,
            crawler_relays,
            crawler_depth,
        );
        if let Some(spambox) = crawler_spambox {
            crawler = crawler.with_spambox(spambox);
        }
        crawler.crawl(crawler_shutdown_rx).await;
    });

    #[cfg(feature = "p2p")]
    let webrtc_state: Option<Arc<WebRTCState>> = {
        let (webrtc_state, webrtc_handle) = if config.server.enable_webrtc {
            let webrtc_config = WebRTCConfig {
                relays: config.nostr.relays.clone(),
                ..Default::default()
            };

            let contacts_file = opts.data_dir.join("contacts.json");
            let classifier_ndb = Arc::clone(&ndb);
            let peer_classifier: PeerClassifier = Arc::new(move |pubkey_hex: &str| {
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
                        if let Some(dist) = socialgraph::get_follow_distance(&classifier_ndb, &pk) {
                            if dist <= 2 {
                                return PeerPool::Follows;
                            }
                        }
                    }
                }
                PeerPool::Other
            });

            let mut manager = WebRTCManager::new_with_store_and_classifier(
                keys.clone(),
                webrtc_config,
                Arc::clone(&store) as Arc<dyn ContentStore>,
                peer_classifier,
            );
            manager.set_nostr_relay(nostr_relay.clone());

            let webrtc_state = manager.state();
            let handle = tokio::spawn(async move {
                if let Err(e) = manager.run().await {
                    tracing::error!("WebRTC manager error: {}", e);
                }
            });
            (Some(webrtc_state), Some(handle))
        } else {
            (None, None)
        };
        let _ = webrtc_handle;
        webrtc_state
    };

    #[cfg(not(feature = "p2p"))]
    let webrtc_state: Option<Arc<crate::webrtc::WebRTCState>> = None;

    let mut upstream_blossom = config.blossom.servers.clone();
    upstream_blossom.extend(config.blossom.read_servers.clone());

    let mut server = HashtreeServer::new(Arc::clone(&store), opts.bind_address.clone())
        .with_allowed_pubkeys(allowed_pubkeys.clone())
        .with_max_upload_bytes((config.blossom.max_upload_mb as usize) * 1024 * 1024)
        .with_public_writes(config.server.public_writes)
        .with_upstream_blossom(upstream_blossom)
        .with_social_graph(social_graph)
        .with_socialgraph_snapshot(
            Arc::clone(&ndb),
            social_graph_root_bytes,
            config.server.socialgraph_snapshot_public,
        )
        .with_nostr_relay(nostr_relay.clone());

    if let Some(ref state) = webrtc_state {
        server = server.with_webrtc_peers(state.clone());
    }

    if let Some(extra) = opts.extra_routes {
        server = server.with_extra_routes(extra);
    }
    if let Some(cors) = opts.cors {
        server = server.with_cors(cors);
    }

    if config.sync.enabled {
        let mut blossom_read_servers = config.blossom.servers.clone();
        blossom_read_servers.extend(config.blossom.read_servers.clone());
        let sync_config = crate::sync::SyncConfig {
            sync_own: config.sync.sync_own,
            sync_followed: config.sync.sync_followed,
            relays: config.nostr.relays.clone(),
            max_concurrent: config.sync.max_concurrent,
            webrtc_timeout_ms: config.sync.webrtc_timeout_ms,
            blossom_timeout_ms: config.sync.blossom_timeout_ms,
        };

        let sync_keys = nostr_sdk::Keys::parse(&keys.secret_key().to_bech32()?)
            .context("Failed to parse keys for sync")?;

        let sync_service = crate::sync::BackgroundSync::new(
            sync_config,
            Arc::clone(&store),
            sync_keys,
            webrtc_state.clone(),
        )
        .await
        .context("Failed to create background sync service")?;

        let contacts_file = opts.data_dir.join("contacts.json");
        tokio::spawn(async move {
            if let Err(e) = sync_service.run(contacts_file).await {
                tracing::error!("Background sync error: {}", e);
            }
        });
    }

    let eviction_store = Arc::clone(&store);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;
            match eviction_store.evict_if_needed() {
                Ok(freed) => {
                    if freed > 0 {
                        tracing::info!("Background eviction freed {} bytes", freed);
                    }
                }
                Err(e) => {
                    tracing::warn!("Background eviction error: {}", e);
                }
            }
        }
    });

    let listener = TcpListener::bind(&opts.bind_address).await?;
    let local_addr = listener.local_addr()?;
    let actual_addr = format!("{}:{}", local_addr.ip(), local_addr.port());

    tokio::spawn(async move {
        if let Err(e) = server.run_with_listener(listener).await {
            tracing::error!("Embedded daemon server error: {}", e);
        }
    });

    tracing::info!(
        "Embedded daemon started on {}, identity {}",
        actual_addr,
        npub
    );

    Ok(EmbeddedDaemonInfo {
        addr: actual_addr,
        port: local_addr.port(),
        store,
        webrtc_state,
    })
}
