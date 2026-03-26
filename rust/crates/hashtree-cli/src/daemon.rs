use anyhow::{Context, Result};
use axum::Router;
use nostr::nips::nip19::ToBech32;
use nostr::Keys;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tower_http::cors::CorsLayer;

use crate::config::{ensure_keys, parse_npub, pubkey_bytes, Config};
use crate::eviction::{spawn_background_eviction_task, BACKGROUND_EVICTION_INTERVAL};
use crate::nostr_relay::{NostrRelay, NostrRelayConfig};
use crate::server::{AppState, HashtreeServer};
use crate::socialgraph;
use crate::storage::HashtreeStore;

#[cfg(feature = "p2p")]
use crate::webrtc::{ContentStore, PeerClassifier, PeerRouter, WebRTCState};
#[cfg(not(feature = "p2p"))]
use crate::WebRTCState;

#[cfg(feature = "p2p")]
struct PeerRouterRuntime {
    shutdown: Arc<tokio::sync::watch::Sender<bool>>,
    join: JoinHandle<()>,
}

struct BackgroundSyncRuntime {
    service: Arc<crate::sync::BackgroundSync>,
    join: JoinHandle<()>,
}

struct BackgroundServicesRuntime {
    crawler: Option<socialgraph::crawler::SocialGraphTaskHandles>,
    sync: Option<BackgroundSyncRuntime>,
}

impl BackgroundServicesRuntime {
    fn status(&self) -> EmbeddedBackgroundServicesStatus {
        EmbeddedBackgroundServicesStatus {
            crawler_active: self.crawler.is_some(),
            sync_active: self.sync.is_some(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmbeddedBackgroundServicesStatus {
    pub crawler_active: bool,
    pub sync_active: bool,
}

pub struct EmbeddedBackgroundServicesController {
    keys: Keys,
    data_dir: PathBuf,
    store: Arc<HashtreeStore>,
    graph_store: Arc<dyn socialgraph::SocialGraphBackend>,
    spambox: Option<Arc<dyn socialgraph::SocialGraphBackend>>,
    webrtc_state: Option<Arc<WebRTCState>>,
    runtime: Mutex<BackgroundServicesRuntime>,
}

impl EmbeddedBackgroundServicesController {
    pub fn new(
        keys: Keys,
        data_dir: PathBuf,
        store: Arc<HashtreeStore>,
        graph_store: Arc<dyn socialgraph::SocialGraphBackend>,
        spambox: Option<Arc<dyn socialgraph::SocialGraphBackend>>,
        webrtc_state: Option<Arc<WebRTCState>>,
    ) -> Self {
        Self {
            keys,
            data_dir,
            store,
            graph_store,
            spambox,
            webrtc_state,
            runtime: Mutex::new(BackgroundServicesRuntime {
                crawler: None,
                sync: None,
            }),
        }
    }

    pub async fn status(&self) -> EmbeddedBackgroundServicesStatus {
        self.runtime.lock().await.status()
    }

    async fn shutdown_crawler(crawler: &mut Option<socialgraph::crawler::SocialGraphTaskHandles>) {
        let Some(handles) = crawler.take() else {
            return;
        };

        let _ = handles.shutdown_tx.send(true);

        let mut crawl_handle = handles.crawl_handle;
        match tokio::time::timeout(std::time::Duration::from_secs(3), &mut crawl_handle).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => tracing::warn!("Crawler task ended with join error: {}", err),
            Err(_) => {
                tracing::warn!("Timed out waiting for crawler task shutdown");
                crawl_handle.abort();
            }
        }

        let mut local_list_handle = handles.local_list_handle;
        match tokio::time::timeout(std::time::Duration::from_secs(3), &mut local_list_handle).await
        {
            Ok(Ok(())) => {}
            Ok(Err(err)) => tracing::warn!("Local list task ended with join error: {}", err),
            Err(_) => {
                tracing::warn!("Timed out waiting for local list task shutdown");
                local_list_handle.abort();
            }
        }
    }

    async fn shutdown_sync(sync: &mut Option<BackgroundSyncRuntime>) {
        let Some(runtime) = sync.take() else {
            return;
        };

        runtime.service.shutdown();
        let mut join = runtime.join;
        match tokio::time::timeout(std::time::Duration::from_secs(3), &mut join).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => tracing::warn!("Background sync task ended with join error: {}", err),
            Err(_) => {
                tracing::warn!("Timed out waiting for background sync shutdown");
                join.abort();
            }
        }
    }

    pub async fn apply_config(&self, config: &Config) -> Result<EmbeddedBackgroundServicesStatus> {
        let mut runtime = self.runtime.lock().await;

        Self::shutdown_crawler(&mut runtime.crawler).await;
        Self::shutdown_sync(&mut runtime.sync).await;

        let active_relays = config.nostr.active_relays();

        if config.nostr.enabled && config.nostr.crawl_depth > 0 && !active_relays.is_empty() {
            runtime.crawler = Some(socialgraph::crawler::spawn_social_graph_tasks(
                self.graph_store.clone(),
                self.keys.clone(),
                active_relays.clone(),
                config.nostr.crawl_depth,
                self.spambox.clone(),
                self.data_dir.clone(),
            ));
        }

        if config.sync.enabled
            && (config.sync.sync_own || config.sync.sync_followed)
            && !active_relays.is_empty()
        {
            let sync_config = crate::sync::SyncConfig {
                sync_own: config.sync.sync_own,
                sync_followed: config.sync.sync_followed,
                relays: active_relays,
                max_concurrent: config.sync.max_concurrent,
                webrtc_timeout_ms: config.sync.webrtc_timeout_ms,
                blossom_timeout_ms: config.sync.blossom_timeout_ms,
            };

            let sync_keys = nostr_sdk::Keys::parse(&self.keys.secret_key().to_bech32()?)
                .context("Failed to parse keys for sync")?;
            let service = Arc::new(
                crate::sync::BackgroundSync::new(
                    sync_config,
                    self.store.clone(),
                    sync_keys,
                    self.webrtc_state.clone(),
                )
                .await
                .context("Failed to create background sync service")?,
            );
            let contacts_file = self.data_dir.join("contacts.json");
            let service_for_task = service.clone();
            let join = tokio::spawn(async move {
                if let Err(err) = service_for_task.run(contacts_file).await {
                    tracing::error!("Background sync error: {}", err);
                }
            });
            runtime.sync = Some(BackgroundSyncRuntime { service, join });
        }

        Ok(runtime.status())
    }
}

#[cfg(feature = "p2p")]
pub struct EmbeddedPeerRouterController {
    keys: Keys,
    state: Arc<WebRTCState>,
    store: Arc<dyn ContentStore>,
    peer_classifier: PeerClassifier,
    nostr_relay: Arc<NostrRelay>,
    runtime: Mutex<Option<PeerRouterRuntime>>,
}

#[cfg(feature = "p2p")]
impl EmbeddedPeerRouterController {
    pub fn new(
        keys: Keys,
        state: Arc<WebRTCState>,
        store: Arc<dyn ContentStore>,
        peer_classifier: PeerClassifier,
        nostr_relay: Arc<NostrRelay>,
    ) -> Self {
        Self {
            keys,
            state,
            store,
            peer_classifier,
            nostr_relay,
            runtime: Mutex::new(None),
        }
    }

    pub fn state(&self) -> Arc<WebRTCState> {
        self.state.clone()
    }

    pub async fn apply_config(&self, config: &Config) -> Result<bool> {
        let mut runtime = self.runtime.lock().await;
        if let Some(runtime_handle) = runtime.take() {
            let _ = runtime_handle.shutdown.send(true);
            let mut join = runtime_handle.join;
            match tokio::time::timeout(std::time::Duration::from_secs(3), &mut join).await {
                Ok(Ok(())) => {}
                Ok(Err(err)) => {
                    tracing::warn!("Peer router task ended with join error: {}", err);
                }
                Err(_) => {
                    tracing::warn!("Timed out waiting for peer router shutdown");
                    join.abort();
                }
            }
        }

        self.state.reset_runtime_state().await;

        if !crate::p2p_common::peer_router_enabled(config) {
            return Ok(false);
        }

        let webrtc_config = crate::p2p_common::default_webrtc_config(config);
        let mut manager = PeerRouter::new_with_state_and_store_and_classifier(
            self.keys.clone(),
            webrtc_config,
            self.state.clone(),
            self.store.clone(),
            self.peer_classifier.clone(),
        );
        manager.set_nostr_relay(self.nostr_relay.clone());
        let shutdown = manager.shutdown_signal();
        let join = tokio::spawn(async move {
            if let Err(err) = manager.run().await {
                tracing::error!("Peer router error: {}", err);
            }
        });
        *runtime = Some(PeerRouterRuntime { shutdown, join });
        Ok(true)
    }
}

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
    pub npub: String,
    pub store: Arc<HashtreeStore>,
    #[allow(dead_code)]
    pub webrtc_state: Option<Arc<WebRTCState>>,
    #[cfg(feature = "p2p")]
    #[allow(dead_code)]
    pub peer_router_controller: Option<Arc<EmbeddedPeerRouterController>>,
    #[allow(dead_code)]
    pub background_services_controller: Option<Arc<EmbeddedBackgroundServicesController>>,
}

pub async fn start_embedded(opts: EmbeddedDaemonOptions) -> Result<EmbeddedDaemonInfo> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mut config = opts.config;
    if let Some(relays) = opts.relays {
        config.nostr.relays = relays;
        config.nostr.enabled = !config.nostr.relays.is_empty();
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

    let graph_store = socialgraph::open_social_graph_store_with_storage(
        &opts.data_dir,
        store.store_arc(),
        Some(nostr_db_max_bytes),
    )
    .context("Failed to initialize social graph store")?;

    let social_graph_root_bytes = if let Some(ref root_npub) = config.nostr.socialgraph_root {
        parse_npub(root_npub).unwrap_or(pk_bytes)
    } else {
        pk_bytes
    };
    socialgraph::set_social_graph_root(&graph_store, &social_graph_root_bytes);
    let social_graph_store: Arc<dyn socialgraph::SocialGraphBackend> = graph_store.clone();

    let social_graph = Arc::new(socialgraph::SocialGraphAccessControl::new(
        Arc::clone(&social_graph_store),
        config.nostr.max_write_distance,
        allowed_pubkeys.clone(),
    ));

    let nostr_relay_config = NostrRelayConfig {
        spambox_db_max_bytes,
        ..Default::default()
    };
    let nostr_relay = Arc::new(
        NostrRelay::new(
            Arc::clone(&social_graph_store),
            opts.data_dir.clone(),
            Some(social_graph.clone()),
            nostr_relay_config,
        )
        .context("Failed to initialize Nostr relay")?,
    );

    let crawler_spambox = if spambox_db_max_bytes == 0 {
        None
    } else {
        let spam_dir = opts.data_dir.join("socialgraph_spambox");
        match socialgraph::open_social_graph_store_at_path(&spam_dir, Some(spambox_db_max_bytes)) {
            Ok(store) => Some(store),
            Err(err) => {
                tracing::warn!("Failed to open social graph spambox for crawler: {}", err);
                None
            }
        }
    };
    let crawler_spambox_backend = crawler_spambox
        .clone()
        .map(|store| store as Arc<dyn socialgraph::SocialGraphBackend>);

    #[cfg(feature = "p2p")]
    let (webrtc_state, peer_router_controller): (
        Option<Arc<WebRTCState>>,
        Option<Arc<EmbeddedPeerRouterController>>,
    ) = {
        let router_config = crate::p2p_common::default_webrtc_config(&config);
        let peer_classifier = crate::p2p_common::build_peer_classifier(
            opts.data_dir.clone(),
            Arc::clone(&social_graph_store),
        );
        let cashu_payment_client =
            if config.cashu.default_mint.is_some() || !config.cashu.accepted_mints.is_empty() {
                match crate::cashu_helper::CashuHelperClient::discover(opts.data_dir.clone()) {
                    Ok(client) => {
                        Some(Arc::new(client) as Arc<dyn crate::cashu_helper::CashuPaymentClient>)
                    }
                    Err(err) => {
                        tracing::warn!(
                        "Cashu settlement helper unavailable; paid retrieval stays disabled: {}",
                        err
                    );
                        None
                    }
                }
            } else {
                None
            };
        let cashu_mint_metadata =
            if config.cashu.default_mint.is_some() || !config.cashu.accepted_mints.is_empty() {
                let metadata_path = crate::webrtc::cashu_mint_metadata_path(&opts.data_dir);
                match crate::webrtc::CashuMintMetadataStore::load(metadata_path) {
                    Ok(store) => Some(store),
                    Err(err) => {
                        tracing::warn!(
                        "Failed to load Cashu mint metadata; falling back to in-memory state: {}",
                        err
                    );
                        Some(crate::webrtc::CashuMintMetadataStore::in_memory())
                    }
                }
            } else {
                None
            };

        let state = Arc::new(WebRTCState::new_with_routing_and_cashu(
            router_config.request_selection_strategy,
            router_config.request_fairness_enabled,
            router_config.request_dispatch,
            std::time::Duration::from_millis(router_config.message_timeout_ms),
            crate::webrtc::CashuRoutingConfig::from(&config.cashu),
            cashu_payment_client,
            cashu_mint_metadata,
        ));
        let controller = Arc::new(EmbeddedPeerRouterController::new(
            keys.clone(),
            state.clone(),
            Arc::clone(&store) as Arc<dyn ContentStore>,
            peer_classifier,
            nostr_relay.clone(),
        ));
        controller.apply_config(&config).await?;
        (Some(state), Some(controller))
    };

    #[cfg(not(feature = "p2p"))]
    let webrtc_state: Option<Arc<crate::webrtc::WebRTCState>> = None;
    #[cfg(not(feature = "p2p"))]
    let peer_router_controller = None;

    let background_services_controller = Arc::new(EmbeddedBackgroundServicesController::new(
        keys.clone(),
        opts.data_dir.clone(),
        Arc::clone(&store),
        Arc::clone(&social_graph_store),
        crawler_spambox_backend,
        webrtc_state.clone(),
    ));
    background_services_controller.apply_config(&config).await?;

    let upstream_blossom = config.blossom.all_read_servers();
    let active_nostr_relays = config.nostr.active_relays();

    let mut server = HashtreeServer::new(Arc::clone(&store), opts.bind_address.clone())
        .with_allowed_pubkeys(allowed_pubkeys.clone())
        .with_max_upload_bytes((config.blossom.max_upload_mb as usize) * 1024 * 1024)
        .with_public_writes(config.server.public_writes)
        .with_upstream_blossom(upstream_blossom)
        .with_nostr_relay_urls(active_nostr_relays)
        .with_social_graph(social_graph)
        .with_socialgraph_snapshot(
            Arc::clone(&social_graph_store),
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

    spawn_background_eviction_task(
        Arc::clone(&store),
        BACKGROUND_EVICTION_INTERVAL,
        "embedded daemon",
    );

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
        npub,
        store,
        webrtc_state,
        #[cfg(feature = "p2p")]
        peer_router_controller,
        background_services_controller: Some(background_services_controller),
    })
}
