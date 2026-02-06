use anyhow::{Context, Result};
use clap::Parser;
use hashtree_cli::config::{
    ensure_auth_cookie, ensure_keys, ensure_keys_string, parse_npub, pubkey_bytes,
};
use hashtree_cli::{
    BackgroundSync, Config, HashtreeServer, HashtreeStore, NostrKeys, NostrResolverConfig,
    NostrRootResolver, NostrToBech32, RootResolver,
};
#[cfg(feature = "p2p")]
use hashtree_cli::{PeerPool, WebRTCConfig, WebRTCManager};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use super::args::{Cli, Commands, SocialGraphCommands, StorageCommands};
use super::blossom::{background_blossom_push, push_to_blossom};
use super::content::add_directory;
use super::daemonize::{format_daemon_status, spawn_daemon, stop_daemon};
use super::lists::{follow_user, list_following, list_muted, mute_user, update_profile};
#[cfg(feature = "fuse")]
use super::mount::mount_fuse;
use super::peers::{fetch_profile_name, list_peers};
use super::resolve::resolve_cid_input;
use super::socialgraph::{run_socialgraph_filter, run_socialgraph_snapshot};
use super::util::chrono_humanize_timestamp;

pub(crate) async fn run() -> Result<()> {
    // Install rustls crypto provider (required for TLS connections)
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Initialize tracing (respects RUST_LOG env var)
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    // Get data_dir early to avoid borrow issues in match arms
    let data_dir = cli.data_dir();

    match cli.command {
        Commands::Start {
            addr,
            relays: relays_override,
            daemon,
            log_file,
            pid_file,
        } => {
            if daemon && std::env::var_os("HTREE_DAEMONIZED").is_none() {
                spawn_daemon(
                    &addr,
                    relays_override.as_deref(),
                    cli.data_dir.clone(),
                    log_file.as_ref(),
                    pid_file.as_ref(),
                )?;
                return Ok(());
            }
            // Load or create config
            let mut config = Config::load()?;

            // Override relays if specified on command line
            if let Some(relays_str) = relays_override.as_deref() {
                config.nostr.relays = relays_str
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .collect();
                println!("Using relays from CLI: {:?}", config.nostr.relays);
            }

            // Use CLI data_dir if provided, otherwise use config's data_dir
            let data_dir = cli
                .data_dir
                .clone()
                .unwrap_or_else(|| PathBuf::from(&config.storage.data_dir));

            // Convert max_size_gb to bytes
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
                &data_dir,
                config.storage.s3.as_ref(),
                max_size_bytes,
            )?);

            // Ensure nsec exists (generate if needed)
            let (keys, was_generated) = ensure_keys()?;
            let pk_bytes = pubkey_bytes(&keys);
            let npub = keys
                .public_key()
                .to_bech32()
                .context("Failed to encode npub")?;

            // Convert allowed_npubs to hex pubkeys for blossom access control
            let mut allowed_pubkeys: HashSet<String> = HashSet::new();
            // Always allow own pubkey
            allowed_pubkeys.insert(hex::encode(pk_bytes));
            // Add configured allowed npubs
            for npub_str in &config.nostr.allowed_npubs {
                if let Ok(pk) = parse_npub(npub_str) {
                    allowed_pubkeys.insert(hex::encode(pk));
                } else {
                    tracing::warn!("Invalid npub in allowed_npubs: {}", npub_str);
                }
            }

            // Initialize social graph (nostrdb)
            let ndb = hashtree_cli::socialgraph::init_ndb_with_mapsize(
                &data_dir,
                Some(nostr_db_max_bytes),
            )
            .context("Failed to initialize nostrdb")?;

            // Set social graph root (configured npub or own key)
            let social_graph_root_bytes = if let Some(ref root_npub) = config.nostr.socialgraph_root
            {
                parse_npub(root_npub).unwrap_or(pk_bytes)
            } else {
                pk_bytes
            };
            hashtree_cli::socialgraph::set_social_graph_root(&ndb, &social_graph_root_bytes);

            // Build social graph access control
            let social_graph = Arc::new(hashtree_cli::socialgraph::SocialGraphAccessControl::new(
                Arc::clone(&ndb),
                config.nostr.max_write_distance,
                allowed_pubkeys.clone(),
            ));

            let nostr_relay_config = hashtree_cli::nostr_relay::NostrRelayConfig {
                spambox_db_max_bytes: spambox_db_max_bytes,
                ..Default::default()
            };
            let nostr_relay = Arc::new(
                hashtree_cli::nostr_relay::NostrRelay::new(
                    Arc::clone(&ndb),
                    data_dir.clone(),
                    Some(social_graph.clone()),
                    nostr_relay_config,
                )
                .context("Failed to initialize Nostr relay")?,
            );

            let crawler_spambox = if spambox_db_max_bytes == 0 {
                None
            } else {
                let spam_dir = data_dir.join("nostrdb_spambox");
                match hashtree_cli::socialgraph::init_ndb_at_path(
                    &spam_dir,
                    Some(spambox_db_max_bytes),
                ) {
                    Ok(db) => Some(db),
                    Err(err) => {
                        tracing::warn!("Failed to open spambox nostrdb for crawler: {}", err);
                        None
                    }
                }
            };

            // Spawn social graph crawler with 5s startup delay
            let crawler_ndb = Arc::clone(&ndb);
            let crawler_keys = keys.clone();
            let crawler_relays = config.nostr.relays.clone();
            let crawler_depth = config.nostr.crawl_depth;
            let crawler_spambox = crawler_spambox.clone();
            let (crawler_shutdown_tx, crawler_shutdown_rx) = tokio::sync::watch::channel(false);
            let crawler_handle = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let mut crawler = hashtree_cli::socialgraph::SocialGraphCrawler::new(
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

            // Start STUN server and WebRTC if P2P feature enabled
            #[cfg(feature = "p2p")]
            let (stun_handle, webrtc_handle, webrtc_state) = {
                // Start STUN server if configured
                let stun_handle = if config.server.stun_port > 0 {
                    let stun_addr: std::net::SocketAddr =
                        format!("0.0.0.0:{}", config.server.stun_port)
                            .parse()
                            .context("Invalid STUN bind address")?;
                    Some(
                        hashtree_cli::server::stun::start_stun_server(stun_addr)
                            .await
                            .context("Failed to start STUN server")?,
                    )
                } else {
                    None
                };

                // Start WebRTC signaling manager if enabled
                let (webrtc_handle, webrtc_state) = if config.server.enable_webrtc {
                    let webrtc_config = WebRTCConfig {
                        relays: config.nostr.relays.clone(),
                        ..Default::default()
                    };

                    // Create peer classifier using contacts file + social graph fallback
                    let contacts_file = data_dir.join("contacts.json");
                    let classifier_ndb = Arc::clone(&ndb);
                    let peer_classifier: hashtree_cli::PeerClassifier =
                        Arc::new(move |pubkey_hex: &str| {
                            // Check local contacts.json file first (updated by htree follow command)
                            if contacts_file.exists() {
                                if let Ok(data) = std::fs::read_to_string(&contacts_file) {
                                    if let Ok(contacts) = serde_json::from_str::<Vec<String>>(&data)
                                    {
                                        if contacts.contains(&pubkey_hex.to_string()) {
                                            return PeerPool::Follows;
                                        }
                                    }
                                }
                            }
                            // Fallback: check social graph via nostrdb
                            if let Ok(pk_bytes) = hex::decode(pubkey_hex) {
                                if pk_bytes.len() == 32 {
                                    let pk: [u8; 32] = pk_bytes.try_into().unwrap();
                                    if let Some(dist) =
                                        hashtree_cli::socialgraph::get_follow_distance(
                                            &classifier_ndb,
                                            &pk,
                                        )
                                    {
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
                        Arc::clone(&store) as Arc<dyn hashtree_cli::ContentStore>,
                        peer_classifier,
                    );
                    manager.set_nostr_relay(nostr_relay.clone());

                    // Get the WebRTC state before spawning (for HTTP handler to query peers)
                    let webrtc_state = manager.state();

                    // Spawn the manager in a background task
                    let handle = tokio::spawn(async move {
                        if let Err(e) = manager.run().await {
                            tracing::error!("WebRTC manager error: {}", e);
                        }
                    });
                    (Some(handle), Some(webrtc_state))
                } else {
                    (None, None)
                };
                (stun_handle, webrtc_handle, webrtc_state)
            };

            #[cfg(not(feature = "p2p"))]
            let (stun_handle, webrtc_handle, webrtc_state): (
                Option<tokio::task::JoinHandle<()>>,
                Option<tokio::task::JoinHandle<()>>,
                Option<Arc<hashtree_cli::webrtc::WebRTCState>>,
            ) = (None, None, None);

            // Combine legacy servers with read_servers for upstream cascade
            let mut upstream_blossom = config.blossom.servers.clone();
            upstream_blossom.extend(config.blossom.read_servers.clone());

            // Set up server with allowed pubkeys for blossom write access
            let mut server = HashtreeServer::new(Arc::clone(&store), addr.clone())
                .with_allowed_pubkeys(allowed_pubkeys.clone())
                .with_max_upload_bytes((config.blossom.max_upload_mb as usize) * 1024 * 1024)
                .with_public_writes(config.server.public_writes)
                .with_upstream_blossom(upstream_blossom);

            // Add social graph to server
            server = server.with_social_graph(social_graph);
            server = server.with_socialgraph_snapshot(
                Arc::clone(&ndb),
                social_graph_root_bytes,
                config.server.socialgraph_snapshot_public,
            );
            server = server.with_nostr_relay(nostr_relay.clone());

            // Add WebRTC peer state for P2P queries from HTTP handler
            if let Some(ref webrtc_state) = webrtc_state {
                server = server.with_webrtc_peers(webrtc_state.clone());
            }

            // Start background sync service if enabled
            let sync_handle = if config.sync.enabled {
                // Combine legacy servers with read_servers for sync (reading)
                let mut blossom_read_servers = config.blossom.servers.clone();
                blossom_read_servers.extend(config.blossom.read_servers.clone());
                let sync_config = hashtree_cli::sync::SyncConfig {
                    sync_own: config.sync.sync_own,
                    sync_followed: config.sync.sync_followed,
                    relays: config.nostr.relays.clone(),
                    max_concurrent: config.sync.max_concurrent,
                    webrtc_timeout_ms: config.sync.webrtc_timeout_ms,
                    blossom_timeout_ms: config.sync.blossom_timeout_ms,
                };

                // Create nostr-sdk Keys from our nostr Keys
                let sync_keys = nostr_sdk::Keys::parse(&keys.secret_key().to_bech32()?)
                    .context("Failed to parse keys for sync")?;

                let sync_service = BackgroundSync::new(
                    sync_config,
                    Arc::clone(&store),
                    sync_keys,
                    webrtc_state.clone(),
                )
                .await
                .context("Failed to create background sync service")?;

                let contacts_file = data_dir.join("contacts.json");

                // Spawn the sync service
                let handle = tokio::spawn(async move {
                    if let Err(e) = sync_service.run(contacts_file).await {
                        tracing::error!("Background sync error: {}", e);
                    }
                });

                Some(handle)
            } else {
                None
            };

            // Start background eviction task (runs every 5 minutes)
            let eviction_store = Arc::clone(&store);
            let eviction_handle = tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(300)); // 5 minutes
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

            // Print startup info
            println!("Starting hashtree daemon on {}", addr);
            println!("Data directory: {}", data_dir.display());
            if was_generated {
                println!("Identity: {} (new)", npub);
            } else {
                println!("Identity: {}", npub);
            }
            if !config.nostr.allowed_npubs.is_empty() {
                println!(
                    "Allowed writers: {} npubs",
                    config.nostr.allowed_npubs.len()
                );
            }
            if config.server.public_writes {
                println!("Public writes: enabled");
            }
            println!("Relays: {} configured", config.nostr.relays.len());
            println!("Git remote: http://{}/git/<pubkey>/<repo>", addr);
            #[cfg(feature = "p2p")]
            if let Some(ref handle) = stun_handle {
                println!("STUN server: {}", handle.addr);
            }
            #[cfg(feature = "p2p")]
            if config.server.enable_webrtc {
                println!("WebRTC: enabled (P2P connections)");
            }
            println!(
                "Social graph: enabled (crawl_depth={}, max_write_distance={})",
                config.nostr.crawl_depth, config.nostr.max_write_distance
            );
            println!("Storage limit: {} GB", config.storage.max_size_gb);
            if config.sync.enabled {
                let mut sync_features = Vec::new();
                if config.sync.sync_own {
                    sync_features.push("own trees");
                }
                if config.sync.sync_followed {
                    sync_features.push("followed trees");
                }
                println!("Background sync: enabled ({})", sync_features.join(", "));
            }

            if config.server.enable_auth {
                let (username, password) = ensure_auth_cookie()?;
                println!();
                println!("Web UI: http://{}/#{}:{}", addr, username, password);
                server = server.with_auth(username, password);
            } else {
                println!("Web UI: http://{}", addr);
                println!("Auth: disabled");
            }

            server.run().await?;

            // Shutdown social graph crawler
            let _ = crawler_shutdown_tx.send(true);
            crawler_handle.abort();

            // Shutdown background eviction
            eviction_handle.abort();

            // Shutdown background sync
            if let Some(handle) = sync_handle {
                handle.abort();
            }

            // Shutdown WebRTC manager
            #[cfg(feature = "p2p")]
            if let Some(handle) = webrtc_handle {
                handle.abort();
            }

            // Shutdown STUN server
            #[cfg(feature = "p2p")]
            if let Some(handle) = stun_handle {
                handle.shutdown();
            }

            // Suppress unused variable warnings when p2p is disabled
            #[cfg(not(feature = "p2p"))]
            let _ = (stun_handle, webrtc_handle);
        }
        #[cfg(feature = "fuse")]
        Commands::Mount {
            target,
            mountpoint,
            visibility,
            link_key,
            private,
            relays,
            allow_other,
        } => {
            mount_fuse(
                target,
                mountpoint,
                visibility,
                link_key,
                private,
                relays,
                allow_other,
                data_dir,
            )
            .await?;
        }
        Commands::Add {
            path,
            only_hash,
            public,
            no_ignore,
            publish,
            local,
        } => {
            let is_dir = path.is_dir();

            if only_hash {
                // Use in-memory store for hash-only mode
                use hashtree_core::store::MemoryStore;
                use hashtree_core::{to_hex, HashTree, HashTreeConfig};
                use std::sync::Arc;

                let store = Arc::new(MemoryStore::new());
                // Use unified API: encryption by default, .public() to disable
                let config = if public {
                    HashTreeConfig::new(store.clone()).public()
                } else {
                    HashTreeConfig::new(store.clone())
                };
                let tree = HashTree::new(config);

                if is_dir {
                    // For directories, use the recursive helper
                    let cid = add_directory(&tree, &path, !no_ignore).await?;
                    println!("hash: {}", to_hex(&cid.hash));
                    if let Some(key) = cid.key {
                        println!("key:  {}", to_hex(&key));
                    }
                } else {
                    let data = std::fs::read(&path)?;
                    let (cid, _size) = tree
                        .put(&data)
                        .await
                        .map_err(|e| anyhow::anyhow!("Failed to hash file: {}", e))?;
                    println!("hash: {}", to_hex(&cid.hash));
                    if let Some(key) = cid.key {
                        println!("key:  {}", to_hex(&key));
                    }
                }
            } else {
                // Store in local hashtree
                use hashtree_core::{
                    from_hex, key_from_hex, nhash_encode, nhash_encode_full, Cid, NHashData,
                };

                let store = HashtreeStore::new(&data_dir)?;

                // Store and capture hash/key for potential publishing
                let (hash_hex, key_hex): (String, Option<String>) = if public {
                    let hash_hex = if is_dir {
                        store
                            .upload_dir_with_options(&path, !no_ignore)
                            .context("Failed to add directory")?
                    } else {
                        store.upload_file(&path).context("Failed to add file")?
                    };
                    let hash = from_hex(&hash_hex).context("Invalid hash")?;
                    let nhash = nhash_encode(&hash)
                        .map_err(|e| anyhow::anyhow!("Failed to encode nhash: {}", e))?;
                    let filename = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    println!("added {}", path.display());
                    println!("  url:   {}/{}", nhash, filename);
                    println!("  hash:  {}", hash_hex);
                    (hash_hex, None)
                } else {
                    let cid_str = if is_dir {
                        store
                            .upload_dir_encrypted_with_options(&path, !no_ignore)
                            .context("Failed to add directory")?
                    } else {
                        store
                            .upload_file_encrypted(&path)
                            .context("Failed to add file")?
                    };
                    // Parse cid_str which may be "hash" or "hash:key"
                    let (hash_hex, key_hex) = if let Some((h, k)) = cid_str.split_once(':') {
                        (h.to_string(), Some(k.to_string()))
                    } else {
                        (cid_str.clone(), None)
                    };
                    let hash = from_hex(&hash_hex).context("Invalid hash")?;
                    let key = key_hex
                        .as_ref()
                        .map(|k| key_from_hex(k))
                        .transpose()
                        .map_err(|e| anyhow::anyhow!("Invalid key: {}", e))?;
                    let nhash_data = NHashData {
                        hash,
                        path: vec![],
                        decrypt_key: key,
                    };
                    let nhash = nhash_encode_full(&nhash_data)
                        .map_err(|e| anyhow::anyhow!("Failed to encode nhash: {}", e))?;
                    let filename = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    println!("added {}", path.display());
                    println!("  url:   {}/{}", nhash, filename);
                    println!("  hash:  {}", hash_hex);
                    if let Some(ref k) = key_hex {
                        println!("  key:   {}", k);
                    }
                    (hash_hex, key_hex)
                };

                // Index tree for eviction tracking (own content = highest priority)
                // Get user's npub as owner
                let (nsec_str, _) = ensure_keys_string()?;
                let keys = NostrKeys::parse(&nsec_str).context("Failed to parse nsec")?;
                let npub = NostrToBech32::to_bech32(&keys.public_key())
                    .context("Failed to encode npub")?;

                let tree_name = path.file_name().map(|n| n.to_string_lossy().to_string());

                // Build ref_key: "npub/filename"
                let ref_key = tree_name.as_ref().map(|name| format!("{}/{}", npub, name));

                let hash_bytes = from_hex(&hash_hex).context("Invalid hash")?;
                if let Err(e) = store.index_tree(
                    &hash_bytes,
                    &npub,
                    tree_name.as_deref(),
                    hashtree_cli::PRIORITY_OWN,
                    ref_key.as_deref(),
                ) {
                    tracing::warn!("Failed to index tree: {}", e);
                }

                // Publish to Nostr if --publish was specified
                if let Some(ref_name) = publish {
                    // Load config for relay list
                    let config = Config::load()?;

                    // Ensure nsec exists (generate if needed)
                    let (nsec_str, was_generated) = ensure_keys_string()?;

                    // Create Keys using nostr-sdk's version (via NostrKeys re-export)
                    let keys = NostrKeys::parse(&nsec_str).context("Failed to parse nsec")?;
                    let npub = NostrToBech32::to_bech32(&keys.public_key())
                        .context("Failed to encode npub")?;

                    if was_generated {
                        println!("  identity: {} (new)", npub);
                    }

                    // Create resolver config with secret key for publishing
                    let resolver_config = NostrResolverConfig {
                        relays: config.nostr.relays.clone(),
                        resolve_timeout: Duration::from_secs(5),
                        secret_key: Some(keys),
                    };

                    // Create resolver
                    let resolver = NostrRootResolver::new(resolver_config)
                        .await
                        .context("Failed to create Nostr resolver")?;

                    // Build Cid from computed hash
                    let hash = from_hex(&hash_hex).context("Invalid hash")?;
                    let key = key_hex
                        .as_ref()
                        .map(|k| key_from_hex(k))
                        .transpose()
                        .map_err(|e| anyhow::anyhow!("Invalid key: {}", e))?;
                    let cid = Cid { hash, key };

                    // Build Nostr key: "npub.../ref_name"
                    let nostr_key = format!("{}/{}", npub, ref_name);

                    // Publish
                    match resolver.publish(&nostr_key, &cid).await {
                        Ok(_) => {
                            println!("  published: {}", nostr_key);
                        }
                        Err(e) => {
                            eprintln!("  publish failed: {}", e);
                        }
                    }

                    // Clean up
                    let _ = resolver.stop().await;
                }

                // Push to Blossom (unless --local)
                if !local {
                    let config = Config::load()?;
                    // Combine legacy servers with write_servers for pushing
                    let mut write_servers = config.blossom.servers.clone();
                    write_servers.extend(config.blossom.write_servers.clone());
                    if !write_servers.is_empty() {
                        // Await the upload to ensure it completes before exiting
                        if let Err(e) =
                            background_blossom_push(&data_dir, &hash_hex, &write_servers).await
                        {
                            eprintln!("  file server push failed: {}", e);
                        }
                    }
                }
            }
        }
        Commands::Get {
            cid: cid_input,
            output,
        } => {
            use hashtree_cli::{FetchConfig, Fetcher};
            use hashtree_core::{from_hex, to_hex};

            // Resolve to Cid (raw bytes, no hex conversion needed for nhash)
            let resolved = resolve_cid_input(&cid_input).await?;
            let cid = resolved.cid;
            let hash_hex = to_hex(&cid.hash);

            let store = Arc::new(HashtreeStore::new(&data_dir)?);
            let fetcher = Fetcher::new(FetchConfig::default());

            // Try to fetch tree from remote if not local
            fetcher.fetch_tree(&store, None, &cid.hash).await?;

            // Check if it's a directory
            let listing = store.get_directory_listing(&cid.hash)?;

            // Handle path: nhash/path/to/file.ext
            if let Some(ref path) = resolved.path {
                if listing.is_some() {
                    // nhash points to directory - resolve path within it
                    let resolved_cid = store
                        .resolve_path(&cid, path)?
                        .ok_or_else(|| anyhow::anyhow!("Path not found in directory: {}", path))?;

                    // Fetch the resolved file if needed
                    fetcher.fetch_tree(&store, None, &resolved_cid.hash).await?;

                    // Get the filename from the path
                    let filename = path.rsplit('/').next().unwrap_or(path);
                    let out_path = output.unwrap_or_else(|| PathBuf::from(filename));

                    if let Some(content) = store.get_file_by_cid(&resolved_cid)? {
                        std::fs::write(&out_path, content)?;
                        println!("{} -> {}", to_hex(&resolved_cid.hash), out_path.display());
                    } else {
                        anyhow::bail!("File not found: {}", path);
                    }
                } else {
                    // nhash points to file - save with the filename from path
                    let filename = path.rsplit('/').next().unwrap_or(path);
                    let out_path = output.unwrap_or_else(|| PathBuf::from(filename));

                    if let Some(content) = store.get_file_by_cid(&cid)? {
                        std::fs::write(&out_path, content)?;
                        println!("{} -> {}", hash_hex, out_path.display());
                    } else {
                        anyhow::bail!("CID not found: {}", hash_hex);
                    }
                }
            } else if let Some(_) = listing {
                // It's a directory - create it and download contents
                let out_dir = output.unwrap_or_else(|| PathBuf::from(&hash_hex));
                std::fs::create_dir_all(&out_dir)?;

                async fn download_dir(
                    store: &Arc<HashtreeStore>,
                    hash: &[u8; 32],
                    dir: &std::path::Path,
                ) -> Result<()> {
                    // Get listing
                    let listing = store.get_directory_listing(hash)?;
                    if let Some(listing) = listing {
                        for entry in listing.entries {
                            let entry_path = dir.join(&entry.name);
                            let entry_hash = from_hex(&entry.cid)
                                .map_err(|e| anyhow::anyhow!("Invalid CID: {}", e))?;
                            if entry.is_directory {
                                std::fs::create_dir_all(&entry_path)?;
                                Box::pin(download_dir(store, &entry_hash, &entry_path)).await?;
                            } else {
                                // Get file content
                                if let Some(content) = store.get_file(&entry_hash)? {
                                    std::fs::write(&entry_path, content)?;
                                    println!("  {} -> {}", entry.cid, entry_path.display());
                                }
                            }
                        }
                    }
                    Ok(())
                }

                println!("Downloading directory to {}", out_dir.display());
                download_dir(&store, &cid.hash, &out_dir).await?;
                println!("Done.");
            } else {
                // Try as a file - use get_file_by_cid for decryption support
                if let Some(content) = store.get_file_by_cid(&cid)? {
                    let out_path = output.unwrap_or_else(|| PathBuf::from(&hash_hex));
                    std::fs::write(&out_path, content)?;
                    println!("{} -> {}", hash_hex, out_path.display());
                } else {
                    anyhow::bail!("CID not found: {}", hash_hex);
                }
            }
        }
        Commands::Cat { cid: cid_input } => {
            use hashtree_cli::{FetchConfig, Fetcher};
            use hashtree_core::to_hex;

            // Resolve npub/repo or htree:// URLs to CID
            let resolved = resolve_cid_input(&cid_input).await?;
            let cid_hex = to_hex(&resolved.cid.hash);

            let store = Arc::new(HashtreeStore::new(&data_dir)?);

            // Create fetcher (BlossomClient auto-loads servers from config)
            let fetcher = Fetcher::new(FetchConfig::default());

            // Fetch file (local first, then Blossom)
            if let Some(content) = fetcher.fetch_file(&store, None, &resolved.cid.hash).await? {
                use std::io::Write;
                std::io::stdout().write_all(&content)?;
            } else {
                anyhow::bail!("CID not found locally or on remote servers: {}", cid_hex);
            }
        }
        Commands::Pins => {
            let store = HashtreeStore::new(&data_dir)?;
            let pins = store.list_pins_with_names()?;
            if pins.is_empty() {
                println!("No pinned CIDs");
            } else {
                println!("Pinned items ({}):", pins.len());
                for pin in pins {
                    let icon = if pin.is_directory { "dir" } else { "file" };
                    println!("  [{}] {} ({})", icon, pin.name, pin.cid);
                }
            }
        }
        Commands::Pin { cid: cid_input } => {
            use hashtree_core::{nhash_encode, to_hex};

            // Resolve npub/repo or htree:// URLs to CID
            let resolved = resolve_cid_input(&cid_input).await?;
            let store = HashtreeStore::new(&data_dir)?;
            store.pin(&resolved.cid.hash)?;
            let nhash =
                nhash_encode(&resolved.cid.hash).unwrap_or_else(|_| to_hex(&resolved.cid.hash));
            println!("Pinned: {}", nhash);
        }
        Commands::Unpin { cid: cid_input } => {
            use hashtree_core::{nhash_encode, to_hex};

            // Resolve npub/repo or htree:// URLs to CID
            let resolved = resolve_cid_input(&cid_input).await?;
            let store = HashtreeStore::new(&data_dir)?;
            store.unpin(&resolved.cid.hash)?;
            let nhash =
                nhash_encode(&resolved.cid.hash).unwrap_or_else(|_| to_hex(&resolved.cid.hash));
            println!("Unpinned: {}", nhash);
        }
        Commands::Info { cid: cid_input } => {
            use hashtree_core::{nhash_encode, to_hex};

            // Resolve npub/repo or htree:// URLs to CID
            let resolved = resolve_cid_input(&cid_input).await?;
            let store = HashtreeStore::new(&data_dir)?;
            let nhash =
                nhash_encode(&resolved.cid.hash).unwrap_or_else(|_| to_hex(&resolved.cid.hash));

            // Check if content exists using file chunk metadata
            if let Some(metadata) = store.get_file_chunk_metadata(&resolved.cid.hash)? {
                println!("Hash: {}", nhash);
                println!("Pinned: {}", store.is_pinned(&resolved.cid.hash)?);
                println!("Total size: {} bytes", metadata.total_size);
                println!("Chunked: {}", metadata.is_chunked);

                if metadata.is_chunked {
                    println!("Chunks: {}", metadata.chunk_hashes.len());
                    println!("\nChunk details:");
                    for (i, (chunk_hash, size)) in metadata
                        .chunk_hashes
                        .iter()
                        .zip(metadata.chunk_sizes.iter())
                        .enumerate()
                    {
                        println!("  [{}] {} ({} bytes)", i, to_hex(chunk_hash), size);
                    }
                }

                // Show directory listing if it's a directory
                if let Ok(Some(listing)) = store.get_directory_listing(&resolved.cid.hash) {
                    println!("\nDirectory contents:");
                    for entry in listing.entries {
                        let type_str = if entry.is_directory { "dir" } else { "file" };
                        println!(
                            "  [{}] {} -> {} ({} bytes)",
                            type_str, entry.name, entry.cid, entry.size
                        );
                    }
                }

                // Show tree node info if available
                if let Ok(Some(node)) = store.get_tree_node(&resolved.cid.hash) {
                    println!("\nTree node info:");
                    println!("  Links: {}", node.links.len());
                    for (i, link) in node.links.iter().enumerate() {
                        let name = link
                            .name
                            .as_ref()
                            .map(|n| n.as_str())
                            .unwrap_or("<unnamed>");
                        let size_str = format!("{} bytes", link.size);
                        println!(
                            "    [{}] {} -> {} ({})",
                            i,
                            name,
                            hashtree_core::to_hex(&link.hash),
                            size_str
                        );
                    }
                }
            } else {
                println!("Hash not found: {}", nhash);
            }
        }
        Commands::Stats => {
            let store = HashtreeStore::new(&data_dir)?;
            let stats = store.get_storage_stats()?;
            println!("Storage Statistics:");
            println!("  Total DAGs: {}", stats.total_dags);
            println!("  Pinned DAGs: {}", stats.pinned_dags);
            println!(
                "  Total size: {} bytes ({:.2} KB)",
                stats.total_bytes,
                stats.total_bytes as f64 / 1024.0
            );
        }
        Commands::Status { addr } => {
            let url = format!("http://{}/api/status", addr);
            match reqwest::blocking::get(&url) {
                Ok(resp) if resp.status().is_success() => {
                    let status: serde_json::Value = resp.json()?;
                    println!("{}", format_daemon_status(&status, true));
                }
                Ok(resp) => {
                    eprintln!("Daemon returned error: {}", resp.status());
                }
                Err(_) => {
                    eprintln!("Daemon not running at {}", addr);
                    eprintln!("Start with: htree start");
                }
            }
        }
        Commands::Stop { pid_file } => {
            stop_daemon(pid_file.as_ref())?;
        }
        Commands::Gc => {
            let store = HashtreeStore::new(&data_dir)?;
            println!("Running garbage collection...");
            let gc_stats = store.gc()?;
            println!("Deleted {} DAGs", gc_stats.deleted_dags);
            println!(
                "Freed {} bytes ({:.2} KB)",
                gc_stats.freed_bytes,
                gc_stats.freed_bytes as f64 / 1024.0
            );
        }
        Commands::User { identity } => {
            use hashtree_cli::config::get_keys_path;
            use nostr::nips::nip19::FromBech32;
            use std::fs;

            match identity {
                None => {
                    // Show current identity
                    let (keys, was_generated) = ensure_keys()?;
                    let npub = keys.public_key().to_bech32()?;
                    if was_generated {
                        eprintln!("Generated new identity");
                    }
                    // Try to fetch profile name
                    let config = Config::load()?;
                    let profile_name =
                        fetch_profile_name(&config.nostr.relays, &keys.public_key().to_hex()).await;
                    if let Some(name) = profile_name {
                        println!("{} ({})", npub, name);
                    } else {
                        println!("{}", npub);
                    }
                }
                Some(id) => {
                    // Set identity - accept nsec or derive from input
                    let nsec = if id.starts_with("nsec1") {
                        // Validate it's a valid nsec
                        nostr::SecretKey::from_bech32(&id).context("Invalid nsec")?;
                        id
                    } else {
                        anyhow::bail!("Identity must be an nsec (secret key). Use 'htree user' to see your current npub.");
                    };

                    // Save to keys file
                    let keys_path = get_keys_path();
                    if let Some(parent) = keys_path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::write(&keys_path, &nsec)?;

                    // Set permissions to 0600
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(&keys_path, fs::Permissions::from_mode(0o600))?;
                    }

                    // Show the new npub
                    let secret_key = nostr::SecretKey::from_bech32(&nsec)?;
                    let keys = nostr::Keys::new(secret_key);
                    let npub = keys.public_key().to_bech32()?;
                    println!("{}", npub);
                }
            }
        }
        Commands::Publish {
            ref_name,
            hash,
            key,
        } => {
            use hashtree_core::{from_hex, key_from_hex, Cid};

            // Load config for relay list
            let config = Config::load()?;

            // Ensure nsec exists (generate if needed)
            let (nsec_str, was_generated) = ensure_keys_string()?;

            // Create Keys using nostr-sdk's version
            let keys = NostrKeys::parse(&nsec_str).context("Failed to parse nsec")?;
            let npub =
                NostrToBech32::to_bech32(&keys.public_key()).context("Failed to encode npub")?;

            if was_generated {
                println!("Identity: {} (new)", npub);
            }

            // Parse hash and optional key
            let hash_bytes = from_hex(&hash).context("Invalid hash (expected hex)")?;
            let key_bytes = key
                .as_ref()
                .map(|k| key_from_hex(k))
                .transpose()
                .map_err(|e| anyhow::anyhow!("Invalid key: {}", e))?;

            let cid = Cid {
                hash: hash_bytes,
                key: key_bytes,
            };

            // Create resolver config with secret key for publishing
            let resolver_config = NostrResolverConfig {
                relays: config.nostr.relays.clone(),
                resolve_timeout: Duration::from_secs(5),
                secret_key: Some(keys),
            };

            // Create resolver
            let resolver = NostrRootResolver::new(resolver_config)
                .await
                .context("Failed to create Nostr resolver")?;

            // Build Nostr key: "npub.../ref_name"
            let nostr_key = format!("{}/{}", npub, ref_name);

            // Publish
            match resolver.publish(&nostr_key, &cid).await {
                Ok(_) => {
                    println!("Published: {}", nostr_key);
                    println!("  hash: {}", hash);
                    if let Some(k) = key {
                        println!("  key:  {}", k);
                    }
                }
                Err(e) => {
                    eprintln!("Publish failed: {}", e);
                    std::process::exit(1);
                }
            }

            // Clean up
            let _ = resolver.stop().await;
        }
        Commands::Follow { npub } => {
            follow_user(&data_dir, &npub, true).await?;
        }
        Commands::Unfollow { npub } => {
            follow_user(&data_dir, &npub, false).await?;
        }
        Commands::Mute { npub, reason } => {
            mute_user(&data_dir, &npub, reason.as_deref(), true).await?;
        }
        Commands::Unmute { npub } => {
            mute_user(&data_dir, &npub, None, false).await?;
        }
        Commands::Following => {
            list_following(&data_dir).await?;
        }
        Commands::Muted => {
            list_muted(&data_dir).await?;
        }
        Commands::Socialgraph { command } => match command {
            SocialGraphCommands::Filter {
                max_distance,
                overmute_threshold,
            } => {
                run_socialgraph_filter(data_dir, max_distance, overmute_threshold)?;
            }
            SocialGraphCommands::Snapshot {
                out,
                max_nodes,
                max_edges,
                max_distance,
                max_edges_per_node,
            } => {
                run_socialgraph_snapshot(
                    data_dir,
                    out,
                    max_nodes,
                    max_edges,
                    max_distance,
                    max_edges_per_node,
                )?;
            }
        },
        Commands::Profile {
            name,
            about,
            picture,
        } => {
            update_profile(name, about, picture).await?;
        }
        Commands::Push {
            cid: cid_input,
            server,
        } => {
            use hashtree_core::to_hex;

            // Resolve npub/repo or htree:// URLs to CID
            let resolved = resolve_cid_input(&cid_input).await?;
            let cid_hex = to_hex(&resolved.cid.hash);
            push_to_blossom(&data_dir, &cid_hex, server).await?;
        }
        Commands::Storage { command } => {
            // Load config
            let config = Config::load()?;

            // Use CLI data_dir if provided, otherwise use config's data_dir
            let data_dir = cli
                .data_dir
                .clone()
                .unwrap_or_else(|| PathBuf::from(&config.storage.data_dir));

            let max_size_bytes = config.storage.max_size_gb * 1024 * 1024 * 1024;
            let store =
                HashtreeStore::with_options(&data_dir, config.storage.s3.as_ref(), max_size_bytes)?;

            match command {
                StorageCommands::Stats => {
                    let stats = store.get_storage_stats()?;
                    let by_priority = store.storage_by_priority()?;
                    let tracked = store.tracked_size()?;
                    let trees = store.list_indexed_trees()?;

                    println!("Storage Statistics:");
                    println!(
                        "  Max size:     {} GB ({} bytes)",
                        config.storage.max_size_gb, max_size_bytes
                    );
                    println!(
                        "  Total bytes:  {} ({:.2} GB)",
                        stats.total_bytes,
                        stats.total_bytes as f64 / 1024.0 / 1024.0 / 1024.0
                    );
                    println!(
                        "  Tracked:      {} ({:.2} GB)",
                        tracked,
                        tracked as f64 / 1024.0 / 1024.0 / 1024.0
                    );
                    println!("  Total DAGs:   {}", stats.total_dags);
                    println!("  Pinned DAGs:  {}", stats.pinned_dags);
                    println!("  Indexed trees: {}", trees.len());
                    println!();
                    println!("Usage by priority:");
                    println!(
                        "  Own (255):      {} ({:.2} MB)",
                        by_priority.own,
                        by_priority.own as f64 / 1024.0 / 1024.0
                    );
                    println!(
                        "  Followed (128): {} ({:.2} MB)",
                        by_priority.followed,
                        by_priority.followed as f64 / 1024.0 / 1024.0
                    );
                    println!(
                        "  Other (64):     {} ({:.2} MB)",
                        by_priority.other,
                        by_priority.other as f64 / 1024.0 / 1024.0
                    );

                    let utilization = if max_size_bytes > 0 {
                        (tracked as f64 / max_size_bytes as f64) * 100.0
                    } else {
                        0.0
                    };
                    println!();
                    println!("Utilization: {:.1}%", utilization);
                }
                StorageCommands::Trees => {
                    use hashtree_core::to_hex;
                    let trees = store.list_indexed_trees()?;

                    if trees.is_empty() {
                        println!("No indexed trees");
                    } else {
                        println!("Indexed trees ({}):", trees.len());
                        for (root_hash, meta) in trees {
                            let root_hex = to_hex(&root_hash);
                            let priority_str = match meta.priority {
                                255 => "own",
                                128 => "followed",
                                _ => "other",
                            };
                            let name = meta.name.as_deref().unwrap_or("<unnamed>");
                            let synced = chrono_humanize_timestamp(meta.synced_at);
                            println!(
                                "  {}... {} ({}) - {} - {} bytes - {}",
                                &root_hex[..12],
                                name,
                                priority_str,
                                &meta.owner[..12.min(meta.owner.len())],
                                meta.total_size,
                                synced
                            );
                        }
                    }
                }
                StorageCommands::Evict => {
                    println!("Running eviction...");
                    let freed = store.evict_if_needed()?;
                    if freed > 0 {
                        println!(
                            "Evicted {} bytes ({:.2} MB)",
                            freed,
                            freed as f64 / 1024.0 / 1024.0
                        );
                    } else {
                        println!("No eviction needed (storage under limit)");
                    }
                }
                StorageCommands::Verify { delete, r2 } => {
                    println!("Verifying blob integrity...");
                    if !delete {
                        println!(
                            "(dry-run mode - use --delete to actually remove corrupted entries)"
                        );
                    }
                    println!();

                    // Verify LMDB
                    let lmdb_result = store.verify_lmdb_integrity(delete)?;
                    println!("LMDB verification:");
                    println!("  Total blobs:     {}", lmdb_result.total);
                    println!("  Valid:           {}", lmdb_result.valid);
                    println!("  Corrupted:       {}", lmdb_result.corrupted);
                    if delete {
                        println!("  Deleted:         {}", lmdb_result.deleted);
                    }
                    println!();

                    // Verify R2 if requested
                    if r2 {
                        println!("Verifying R2 storage (this may take a while)...");
                        match store.verify_r2_integrity(delete).await {
                            Ok(r2_result) => {
                                println!("R2 verification:");
                                println!("  Total objects:   {}", r2_result.total);
                                println!("  Valid:           {}", r2_result.valid);
                                println!("  Corrupted:       {}", r2_result.corrupted);
                                if delete {
                                    println!("  Deleted:         {}", r2_result.deleted);
                                }
                            }
                            Err(e) => {
                                println!("R2 verification failed: {}", e);
                            }
                        }
                    }

                    let total_corrupted = lmdb_result.corrupted;
                    if total_corrupted > 0 {
                        println!();
                        if delete {
                            println!(
                                "Cleanup complete. Removed {} corrupted entries.",
                                total_corrupted
                            );
                        } else {
                            println!(
                                "Found {} corrupted entries. Run with --delete to remove them.",
                                total_corrupted
                            );
                        }
                    } else {
                        println!("All blobs verified successfully!");
                    }
                }
            }
        }
        Commands::Peer { addr } => {
            list_peers(&addr).await?;
        }
    }

    Ok(())
}
