//! Hashtree CLI and daemon
//!
//! Usage:
//!   htree start [--addr 127.0.0.1:8080] [--daemon]
//!   htree stop [--pid-file <path>]
//!   htree add <path> [--only-hash] [--public] [--no-ignore] [--publish <ref_name>]
//!   htree get <cid> [-o output]
//!   htree cat <cid>
//!   htree pins
//!   htree pin <cid>
//!   htree unpin <cid>
//!   htree info <cid>
//!   htree stats
//!   htree gc
//!   htree user [<nsec>]
//!   htree publish <ref_name> <hash> [--key <key>]

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use hashtree_cli::config::{ensure_auth_cookie, ensure_keys, ensure_keys_string, parse_npub, pubkey_bytes};
use hashtree_cli::{
    BackgroundSync, Config, HashtreeServer, HashtreeStore,
    NostrKeys, NostrResolverConfig, NostrRootResolver, NostrToBech32, RootResolver,
};
#[cfg(feature = "fuse")]
use hashtree_fuse::{FsError as FuseFsError, HashtreeFuse, RootPublisher};
#[cfg(feature = "p2p")]
use hashtree_cli::{PeerPool, WebRTCConfig, WebRTCManager};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
#[cfg(feature = "fuse")]
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

#[derive(Parser)]
#[command(name = "htree")]
#[command(version)]
#[command(about = "Content-addressed filesystem", long_about = None)]
struct Cli {
    /// Data directory (default: ~/.hashtree/data)
    #[arg(long, global = true, env = "HTREE_DATA_DIR")]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

impl Cli {
    /// Get the data directory, defaulting to ~/.hashtree/data
    fn data_dir(&self) -> PathBuf {
        self.data_dir.clone().unwrap_or_else(|| {
            hashtree_cli::config::get_hashtree_dir().join("data")
        })
    }
}

#[derive(Subcommand)]
enum Commands {
    /// Start the hashtree daemon
    Start {
        #[arg(long, default_value = "127.0.0.1:8080")]
        addr: String,
        /// Override Nostr relays (comma-separated)
        #[arg(long)]
        relays: Option<String>,
        /// Run in background (daemonize)
        #[arg(long)]
        daemon: bool,
        /// Log file for daemon mode (default: ~/.hashtree/logs/htree.log)
        #[arg(long, requires = "daemon")]
        log_file: Option<PathBuf>,
        /// PID file for daemon mode (default: ~/.hashtree/htree.pid)
        #[arg(long, requires = "daemon")]
        pid_file: Option<PathBuf>,
    },
    /// Mount a hashtree via FUSE
    #[cfg(feature = "fuse")]
    Mount {
        /// Target to mount (nhash, npub/tree, or htree:// URL)
        target: String,
        /// Mount point directory
        mountpoint: PathBuf,
        /// Visibility: public, link-visible, or private
        #[arg(long)]
        visibility: Option<String>,
        /// Link key for link-visible trees (hex)
        #[arg(long)]
        link_key: Option<String>,
        /// Use private visibility (NIP-44 to self)
        #[arg(long)]
        private: bool,
        /// Override Nostr relays (comma-separated)
        #[arg(long)]
        relays: Option<String>,
        /// Allow other users to access the mount
        #[arg(long)]
        allow_other: bool,
    },
    /// Add file or directory to hashtree (like ipfs add)
    Add {
        /// Path to file or directory
        path: PathBuf,
        /// Only compute hash, don't store
        #[arg(long)]
        only_hash: bool,
        /// Store without encryption (public, unencrypted)
        #[arg(long)]
        public: bool,
        /// Include files ignored by .gitignore (default: respect .gitignore)
        #[arg(long)]
        no_ignore: bool,
        /// Publish to Nostr under this ref name (e.g., "mydata" -> npub.../mydata)
        #[arg(long)]
        publish: Option<String>,
        /// Don't push to file servers (local only)
        #[arg(long)]
        local: bool,
    },
    /// Get/download content by CID
    Get {
        /// CID to retrieve
        cid: String,
        /// Output path (default: current dir, uses CID as filename)
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Output file content to stdout (like cat)
    Cat {
        /// CID to read
        cid: String,
    },
    /// List all pinned CIDs
    Pins,
    /// Pin a CID
    Pin {
        /// CID to pin
        cid: String,
    },
    /// Unpin a CID
    Unpin {
        /// CID to unpin
        cid: String,
    },
    /// Get information about a CID
    Info {
        /// CID to inspect
        cid: String,
    },
    /// Get storage statistics
    Stats,
    /// Show daemon status (peers, storage, etc.)
    Status {
        /// Daemon address (default: 127.0.0.1:8080)
        #[arg(long, default_value = "127.0.0.1:8080")]
        addr: String,
    },
    /// Stop the hashtree daemon
    Stop {
        /// PID file (default: ~/.hashtree/htree.pid)
        #[arg(long)]
        pid_file: Option<PathBuf>,
    },
    /// Run garbage collection
    Gc,
    /// Show or set your nostr identity
    User {
        /// npub or nsec to set as active identity (omit to show current)
        identity: Option<String>,
    },
    /// Publish a hash to Nostr under a ref name
    Publish {
        /// The ref name to publish under (e.g., "mydata" -> npub.../mydata)
        ref_name: String,
        /// The hash to publish (hex encoded)
        hash: String,
        /// Optional decryption key (hex encoded, for encrypted content)
        #[arg(long)]
        key: Option<String>,
    },
    /// Follow a user (adds to your contact list)
    Follow {
        /// npub of user to follow
        npub: String,
    },
    /// Unfollow a user (removes from your contact list)
    Unfollow {
        /// npub of user to unfollow
        npub: String,
    },
    /// Mute a user (adds to your mute list)
    Mute {
        /// npub of user to mute
        npub: String,
    },
    /// Unmute a user (removes from your mute list)
    Unmute {
        /// npub of user to unmute
        npub: String,
    },
    /// List users you follow
    Following,
    /// List users you mute
    Muted,
    /// Social graph utilities
    Socialgraph {
        #[command(subcommand)]
        command: SocialGraphCommands,
    },
    /// Show or update your Nostr profile
    Profile {
        /// Set display name
        #[arg(long)]
        name: Option<String>,
        /// Set about/bio
        #[arg(long)]
        about: Option<String>,
        /// Set profile picture URL
        #[arg(long)]
        picture: Option<String>,
    },
    /// Push content to file servers (Blossom)
    Push {
        /// CID (hash or hash:key) to push
        cid: String,
        /// File server URL (overrides config)
        #[arg(long, short)]
        server: Option<String>,
    },
    /// Manage storage limits and eviction
    Storage {
        #[command(subcommand)]
        command: StorageCommands,
    },
    /// Show connected P2P peers
    Peer {
        /// Daemon address (default: 127.0.0.1:8080)
        #[arg(long, default_value = "127.0.0.1:8080")]
        addr: String,
    },
}

#[derive(Subcommand)]
enum StorageCommands {
    /// Show storage usage statistics by priority tier
    Stats,
    /// List all indexed trees
    Trees,
    /// Manually trigger eviction
    Evict,
    /// Verify blob integrity and delete corrupted entries
    Verify {
        /// Actually delete corrupted entries (default: dry-run)
        #[arg(long)]
        delete: bool,
        /// Also verify R2/S3 storage (slower)
        #[arg(long)]
        r2: bool,
    },
}

#[derive(Subcommand)]
enum SocialGraphCommands {
    /// Filter JSONL Nostr events to those within the social graph
    Filter {
        /// Max follow distance to allow (default: config nostr.max_write_distance)
        #[arg(long)]
        max_distance: Option<u32>,
        /// Overmute threshold (muters * threshold > followers)
        #[arg(long, default_value_t = 1.0)]
        overmute_threshold: f64,
    },
}


/// Resolved CID with optional path
pub struct ResolvedCid {
    pub cid: hashtree_core::Cid,
    pub path: Option<String>,
}

#[derive(Default, Clone)]
struct ResolveOptions {
    link_key: Option<[u8; 32]>,
    private: bool,
    relays: Option<Vec<String>>,
    secret_key: Option<NostrKeys>,
}

/// Resolve a CID input which can be:
/// - An nhash (bech32-encoded hash with optional path/key)
/// - An npub/repo path (e.g., "npub1.../myrepo")
/// - An htree:// URL (e.g., "htree://npub1.../myrepo")
/// Returns the resolved Cid (raw bytes) and optional path within the tree
async fn resolve_cid_input(input: &str) -> Result<ResolvedCid> {
    resolve_cid_input_with_opts(input, &ResolveOptions::default()).await
}

async fn resolve_cid_input_with_opts(input: &str, opts: &ResolveOptions) -> Result<ResolvedCid> {
    use hashtree_core::{nhash_decode, is_nhash, Cid};

    // Strip htree:// prefix if present
    let input = input.strip_prefix("htree://").unwrap_or(input);

    // Check if it's an nhash (bech32-encoded) - gives us raw bytes directly
    // Support nhash1.../path/to/file format (path suffix after slash)
    if is_nhash(input) {
        let (nhash_part, url_path) = if let Some(slash_pos) = input.find('/') {
            (&input[..slash_pos], Some(&input[slash_pos + 1..]))
        } else {
            (input, None)
        };

        let data = nhash_decode(nhash_part)
            .map_err(|e| anyhow::anyhow!("Invalid nhash: {}", e))?;

        // Combine embedded TLV path with URL-style path suffix
        let path = match (data.path.is_empty(), url_path) {
            (true, None) => None,
            (true, Some(p)) => Some(p.to_string()),
            (false, None) => Some(data.path.join("/")),
            (false, Some(p)) => Some(format!("{}/{}", data.path.join("/"), p)),
        };

        return Ok(ResolvedCid {
            cid: Cid {
                hash: data.hash,
                key: data.decrypt_key,
            },
            path,
        });
    }

    // Check for hex CID format: "hash" or "hash:key", optionally with /path
    let (cid_part, url_path) = if let Some(slash_pos) = input.find('/') {
        (&input[..slash_pos], Some(&input[slash_pos + 1..]))
    } else {
        (input, None)
    };
    if let Ok(cid) = Cid::parse(cid_part) {
        return Ok(ResolvedCid {
            cid,
            path: url_path.map(|p| p.to_string()),
        });
    }

    // Check if it looks like an npub path (npub1.../name or npub1.../name/path)
    if input.starts_with("npub1") && input.contains('/') {
        let parts: Vec<&str> = input.splitn(3, '/').collect();
        if parts.len() >= 2 {
            let npub = parts[0];
            let repo = parts[1];
            let subpath = if parts.len() > 2 { Some(parts[2].to_string()) } else { None };

            // Resolve via nostr
            let key = format!("{}/{}", npub, repo);
            eprintln!("Resolving {}...", key);

            let mut config = NostrResolverConfig::default();
            if let Some(relays) = &opts.relays {
                config.relays = relays.clone();
            }
            if opts.private {
                config.secret_key = opts.secret_key.clone();
            }

            let resolver = NostrRootResolver::new(config).await
                .context("Failed to create nostr resolver")?;

            let resolved = if let Some(link_key) = opts.link_key {
                resolver.resolve_shared(&key, &link_key).await
            } else {
                resolver.resolve(&key).await
            };

            match resolved {
                Ok(Some(cid)) => {
                    eprintln!("Resolved to: {}", hashtree_core::to_hex(&cid.hash));
                    return Ok(ResolvedCid { cid, path: subpath });
                }
                Ok(None) => {
                    anyhow::bail!("No content found for {}", key);
                }
                Err(e) => {
                    anyhow::bail!("Failed to resolve {}: {}", key, e);
                }
            }
        }
    }

    anyhow::bail!("Invalid format. Use nhash1..., <hash>, <hash:key>, or npub1.../name")
}

fn parse_pubkey_hex(hex_str: &str) -> Option<[u8; 32]> {
    if hex_str.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    if hex::decode_to_slice(hex_str, &mut bytes).is_err() {
        return None;
    }
    Some(bytes)
}

fn run_socialgraph_filter(
    data_dir: PathBuf,
    max_distance: Option<u32>,
    overmute_threshold: f64,
) -> Result<()> {
    let config = Config::load()?;
    let max_distance = max_distance.unwrap_or(config.nostr.max_write_distance);
    let nostr_db_max_bytes = config
        .nostr
        .db_max_size_gb
        .saturating_mul(1024 * 1024 * 1024);

    let (keys, _was_generated) = ensure_keys()?;
    let pk_bytes = pubkey_bytes(&keys);
    let social_graph_root_bytes = if let Some(ref root_npub) = config.nostr.socialgraph_root {
        match parse_npub(root_npub) {
            Ok(pk) => pk,
            Err(_) => {
                tracing::warn!("Invalid npub in socialgraph_root: {}", root_npub);
                pk_bytes
            }
        }
    } else {
        pk_bytes
    };

    let ndb = hashtree_cli::socialgraph::init_ndb_with_mapsize(&data_dir, Some(nostr_db_max_bytes))
        .context("Failed to initialize nostrdb")?;
    hashtree_cli::socialgraph::set_social_graph_root(&ndb, &social_graph_root_bytes);

    let mut distance_cache: HashMap<[u8; 32], Option<u32>> = HashMap::new();
    let mut overmute_cache: HashMap<[u8; 32], bool> = HashMap::new();

    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let event_value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("Skipping invalid JSON line: {}", err);
                continue;
            }
        };

        let event_obj = match &event_value {
            serde_json::Value::Object(obj) => Some(obj),
            serde_json::Value::Array(items) if items.len() >= 3 => match &items[2] {
                serde_json::Value::Object(obj) => Some(obj),
                _ => None,
            },
            _ => None,
        };
        let Some(event_obj) = event_obj else {
            eprintln!("Skipping JSON line without event object");
            continue;
        };

        let Some(pubkey_hex) = event_obj.get("pubkey").and_then(|value| value.as_str()) else {
            eprintln!("Skipping JSON line without pubkey");
            continue;
        };
        let Some(pk_bytes) = parse_pubkey_hex(pubkey_hex) else {
            eprintln!("Skipping invalid pubkey hex: {}", pubkey_hex);
            continue;
        };

        let distance = *distance_cache.entry(pk_bytes).or_insert_with(|| {
            hashtree_cli::socialgraph::get_follow_distance(&ndb, &pk_bytes)
        });
        let Some(distance) = distance else {
            continue;
        };
        if distance > max_distance {
            continue;
        }

        if overmute_threshold > 0.0 {
            let overmuted = *overmute_cache.entry(pk_bytes).or_insert_with(|| {
                hashtree_cli::socialgraph::is_overmuted(
                    &ndb,
                    &social_graph_root_bytes,
                    &pk_bytes,
                    overmute_threshold,
                )
            });
            if overmuted {
                continue;
            }
        }

        stdout.write_all(trimmed.as_bytes())?;
        stdout.write_all(b"\n")?;
    }

    Ok(())
}

#[cfg(feature = "fuse")]
struct MountVisibility {
    visibility: hashtree_core::TreeVisibility,
    link_key: Option<[u8; 32]>,
}

#[cfg(feature = "fuse")]
fn parse_mount_visibility(
    visibility: Option<String>,
    link_key: Option<String>,
    private: bool,
    fragment: Option<&str>,
) -> Result<MountVisibility> {
    use hashtree_core::TreeVisibility;

    let mut resolved_visibility: Option<TreeVisibility> = None;
    let mut resolved_link_key: Option<[u8; 32]> = None;

    if let Some(fragment) = fragment {
        if fragment == "private" {
            resolved_visibility = Some(TreeVisibility::Private);
        } else if fragment == "link-visible" {
            resolved_visibility = Some(TreeVisibility::LinkVisible);
        } else if let Some(hex_key) = fragment.strip_prefix("k=") {
            resolved_visibility = Some(TreeVisibility::LinkVisible);
            resolved_link_key = Some(hashtree_core::key_from_hex(hex_key)
                .map_err(|e| anyhow::anyhow!("Invalid link key: {}", e))?);
        }
    }

    if let Some(vis) = visibility {
        let parsed = TreeVisibility::from_str(&vis)
            .map_err(|e| anyhow::anyhow!("Invalid visibility: {}", e))?;
        if let Some(existing) = resolved_visibility {
            if existing != parsed {
                anyhow::bail!("Conflicting visibility options");
            }
        }
        resolved_visibility = Some(parsed);
    }

    if let Some(link_key) = link_key {
        let parsed = hashtree_core::key_from_hex(&link_key)
            .map_err(|e| anyhow::anyhow!("Invalid link key: {}", e))?;
        if let Some(existing) = resolved_link_key {
            if existing != parsed {
                anyhow::bail!("Conflicting link key options");
            }
        }
        resolved_link_key = Some(parsed);
        if let Some(existing) = resolved_visibility {
            if existing != TreeVisibility::LinkVisible {
                anyhow::bail!("Link key only applies to link-visible trees");
            }
        }
        resolved_visibility = Some(TreeVisibility::LinkVisible);
    }

    if private {
        if let Some(existing) = resolved_visibility {
            if existing != TreeVisibility::Private {
                anyhow::bail!("Conflicting visibility options");
            }
        }
        resolved_visibility = Some(TreeVisibility::Private);
    }

    let visibility = resolved_visibility.unwrap_or(TreeVisibility::Public);
    if visibility == TreeVisibility::LinkVisible && resolved_link_key.is_none() {
        anyhow::bail!("Link-visible trees require a link key");
    }
    if visibility == TreeVisibility::Private && resolved_link_key.is_some() {
        anyhow::bail!("Private trees cannot use a link key");
    }

    Ok(MountVisibility {
        visibility,
        link_key: resolved_link_key,
    })
}

#[cfg(feature = "fuse")]
struct NostrRootPublisher {
    resolver: NostrRootResolver,
    key: String,
    visibility: hashtree_core::TreeVisibility,
    link_key: Option<[u8; 32]>,
    store: Arc<HashtreeStore>,
    pubkey_hex: String,
    tree_name: String,
    handle: tokio::runtime::Handle,
}

#[cfg(feature = "fuse")]
impl RootPublisher for NostrRootPublisher {
    fn publish(&self, cid: &hashtree_core::Cid) -> Result<(), FuseFsError> {
        let visibility = self.visibility;
        let link_key = self.link_key;
        let key = self.key.clone();
        let resolver = &self.resolver;

        let published = self.handle.block_on(async move {
            match visibility {
                hashtree_core::TreeVisibility::Public => resolver.publish(&key, cid).await,
                hashtree_core::TreeVisibility::LinkVisible => {
                    let Some(link_key) = link_key else {
                        return Err(hashtree_cli::ResolverError::Other("Missing link key".into()));
                    };
                    resolver.publish_shared(&key, cid, &link_key).await
                }
                hashtree_core::TreeVisibility::Private => {
                    resolver.publish_private(&key, cid).await
                }
            }
        }).map_err(|e| FuseFsError::Publish(e.to_string()))?;

        if !published {
            return Err(FuseFsError::Publish("Publish returned false".into()));
        }

        let key_hex = cid.key.map(hex::encode);
        let updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.store.set_cached_root(
            &self.pubkey_hex,
            &self.tree_name,
            &hashtree_core::to_hex(&cid.hash),
            key_hex.as_deref(),
            self.visibility.as_str(),
            updated_at,
        ).map_err(|e| FuseFsError::Publish(e.to_string()))?;

        Ok(())
    }
}

#[cfg(feature = "fuse")]
async fn mount_fuse(
    target: String,
    mountpoint: PathBuf,
    visibility: Option<String>,
    link_key: Option<String>,
    private: bool,
    relays: Option<String>,
    allow_other: bool,
    data_dir: PathBuf,
) -> Result<()> {
    let target = target.strip_prefix("htree://").unwrap_or(&target);
    let (base, fragment) = match target.split_once('#') {
        Some((base, fragment)) => (base, Some(fragment)),
        None => (target, None),
    };

    let MountVisibility { visibility: mount_visibility, link_key: mount_link_key } =
        parse_mount_visibility(visibility, link_key, private, fragment)?;

    let config = Config::load_or_default();
    let relays = if let Some(relays) = relays {
        relays.split(',').map(|s| s.trim().to_string()).collect()
    } else {
        config.nostr.relays.clone()
    };

    let mut opts = ResolveOptions::default();
    opts.link_key = mount_link_key;
    opts.private = mount_visibility == hashtree_core::TreeVisibility::Private;
    opts.relays = Some(relays);

    if opts.private {
        let keys = hashtree_cli::config::read_keys()
            .context("Private mounts require a local nsec key")?;
        opts.secret_key = Some(keys);
    }

    let resolved = resolve_cid_input_with_opts(base, &opts).await?;

    let nostr_key = if base.starts_with("npub1") && base.contains('/') {
        let parts: Vec<&str> = base.splitn(3, '/').collect();
        if parts.len() >= 2 {
            Some(format!("{}/{}", parts[0], parts[1]))
        } else {
            None
        }
    } else {
        None
    };

    let max_size_bytes = config.storage.max_size_gb * 1024 * 1024 * 1024;
    let store = Arc::new(HashtreeStore::with_options(&data_dir, config.storage.s3.as_ref(), max_size_bytes)?);
    let store_arc = store.store_arc();

    let mut root_cid = resolved.cid.clone();
    if let Some(path) = resolved.path.clone() {
        let tree = hashtree_core::HashTree::new(hashtree_core::HashTreeConfig::new(store_arc.clone()));
        let Some(path_cid) = tree.resolve(&root_cid, &path).await? else {
            anyhow::bail!("Path not found: {}", path);
        };
        let is_dir = tree.get_directory_node(&path_cid).await?.is_some();
        if !is_dir {
            anyhow::bail!("Path is not a directory: {}", path);
        }
        root_cid = path_cid;
    }

    let publisher = if let Some(nostr_key) = nostr_key {
        let keys = hashtree_cli::config::read_keys()
            .context("Failed to read nostr keys")?;
        let mut resolver_config = NostrResolverConfig::default();
        if let Some(relays) = opts.relays.clone() {
            resolver_config.relays = relays;
        }
        resolver_config.secret_key = Some(keys.clone());
        let resolver = NostrRootResolver::new(resolver_config).await
            .context("Failed to create nostr resolver")?;

        let (npub, tree_name) = nostr_key.split_once('/')
            .ok_or_else(|| anyhow::anyhow!("Invalid nostr key: {}", nostr_key))?;
        let pubkey_bytes = parse_npub(npub)?;
        if keys.public_key().to_bytes() != pubkey_bytes {
            anyhow::bail!("Nostr key does not match mounted npub");
        }
        let pubkey_hex = hex::encode(pubkey_bytes);

        Some(Arc::new(NostrRootPublisher {
            resolver,
            key: nostr_key,
            visibility: mount_visibility,
            link_key: mount_link_key,
            store: store.clone(),
            pubkey_hex,
            tree_name: tree_name.to_string(),
            handle: tokio::runtime::Handle::current(),
        }) as Arc<dyn RootPublisher>)
    } else {
        None
    };

    let fs = HashtreeFuse::new_with_publisher(store_arc, root_cid, publisher)?;
    let mut options = vec![
        fuser::MountOption::FSName("hashtree".to_string()),
        fuser::MountOption::DefaultPermissions,
    ];
    if allow_other {
        options.push(fuser::MountOption::AllowOther);
    }

    fs.mount(mountpoint, &options)?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Install rustls crypto provider (required for TLS connections)
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Initialize tracing (respects RUST_LOG env var)
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    // Get data_dir early to avoid borrow issues in match arms
    let data_dir = cli.data_dir();

    match cli.command {
        Commands::Start { addr, relays: relays_override, daemon, log_file, pid_file } => {
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
                config.nostr.relays = relays_str.split(',').map(|s| s.trim().to_string()).collect();
                println!("Using relays from CLI: {:?}", config.nostr.relays);
            }

            // Use CLI data_dir if provided, otherwise use config's data_dir
            let data_dir = cli.data_dir.clone().unwrap_or_else(|| {
                PathBuf::from(&config.storage.data_dir)
            });

            // Convert max_size_gb to bytes
            let max_size_bytes = config.storage.max_size_gb * 1024 * 1024 * 1024;
            let nostr_db_max_bytes = config.nostr.db_max_size_gb.saturating_mul(1024 * 1024 * 1024);
            let spambox_db_max_bytes = config.nostr.spambox_max_size_gb.saturating_mul(1024 * 1024 * 1024);
            let store = Arc::new(HashtreeStore::with_options(&data_dir, config.storage.s3.as_ref(), max_size_bytes)?);

            // Ensure nsec exists (generate if needed)
            let (keys, was_generated) = ensure_keys()?;
            let pk_bytes = pubkey_bytes(&keys);
            let npub = keys.public_key().to_bech32()
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
            let ndb = hashtree_cli::socialgraph::init_ndb_with_mapsize(&data_dir, Some(nostr_db_max_bytes))
                .context("Failed to initialize nostrdb")?;

            // Set social graph root (configured npub or own key)
            let social_graph_root_bytes = if let Some(ref root_npub) = config.nostr.socialgraph_root {
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
                match hashtree_cli::socialgraph::init_ndb_at_path(&spam_dir, Some(spambox_db_max_bytes)) {
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
                    let stun_addr: std::net::SocketAddr = format!("0.0.0.0:{}", config.server.stun_port)
                        .parse()
                        .context("Invalid STUN bind address")?;
                    Some(hashtree_cli::server::stun::start_stun_server(stun_addr).await
                        .context("Failed to start STUN server")?)
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
                    let peer_classifier: hashtree_cli::PeerClassifier = Arc::new(move |pubkey_hex: &str| {
                        // Check local contacts.json file first (updated by htree follow command)
                        if contacts_file.exists() {
                            if let Ok(data) = std::fs::read_to_string(&contacts_file) {
                                if let Ok(contacts) = serde_json::from_str::<Vec<String>>(&data) {
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
                                if let Some(dist) = hashtree_cli::socialgraph::get_follow_distance(&classifier_ndb, &pk) {
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
            let (stun_handle, webrtc_handle, webrtc_state): (Option<tokio::task::JoinHandle<()>>, Option<tokio::task::JoinHandle<()>>, Option<Arc<hashtree_cli::webrtc::WebRTCState>>) = (None, None, None);

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
                ).await.context("Failed to create background sync service")?;

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
                println!("Allowed writers: {} npubs", config.nostr.allowed_npubs.len());
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
            println!("Social graph: enabled (crawl_depth={}, max_write_distance={})",
                config.nostr.crawl_depth, config.nostr.max_write_distance);
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
        Commands::Mount { target, mountpoint, visibility, link_key, private, relays, allow_other } => {
            mount_fuse(target, mountpoint, visibility, link_key, private, relays, allow_other, data_dir).await?;
        }
        Commands::Add { path, only_hash, public, no_ignore, publish, local } => {
            let is_dir = path.is_dir();

            if only_hash {
                // Use in-memory store for hash-only mode
                use hashtree_core::store::MemoryStore;
                use hashtree_core::{HashTree, HashTreeConfig, to_hex};
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
                    let (cid, _size) = tree.put(&data).await
                        .map_err(|e| anyhow::anyhow!("Failed to hash file: {}", e))?;
                    println!("hash: {}", to_hex(&cid.hash));
                    if let Some(key) = cid.key {
                        println!("key:  {}", to_hex(&key));
                    }
                }
            } else {
                // Store in local hashtree
                use hashtree_core::{nhash_encode, nhash_encode_full, NHashData, from_hex, key_from_hex, Cid};

                let store = HashtreeStore::new(&data_dir)?;

                // Store and capture hash/key for potential publishing
                let (hash_hex, key_hex): (String, Option<String>) = if public {
                    let hash_hex = if is_dir {
                        store.upload_dir_with_options(&path, !no_ignore)
                            .context("Failed to add directory")?
                    } else {
                        store.upload_file(&path)
                            .context("Failed to add file")?
                    };
                    let hash = from_hex(&hash_hex).context("Invalid hash")?;
                    let nhash = nhash_encode(&hash)
                        .map_err(|e| anyhow::anyhow!("Failed to encode nhash: {}", e))?;
                    let filename = path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    println!("added {}", path.display());
                    println!("  url:   {}/{}", nhash, filename);
                    println!("  hash:  {}", hash_hex);
                    (hash_hex, None)
                } else {
                    let cid_str = if is_dir {
                        store.upload_dir_encrypted_with_options(&path, !no_ignore)
                            .context("Failed to add directory")?
                    } else {
                        store.upload_file_encrypted(&path)
                            .context("Failed to add file")?
                    };
                    // Parse cid_str which may be "hash" or "hash:key"
                    let (hash_hex, key_hex) = if let Some((h, k)) = cid_str.split_once(':') {
                        (h.to_string(), Some(k.to_string()))
                    } else {
                        (cid_str.clone(), None)
                    };
                    let hash = from_hex(&hash_hex).context("Invalid hash")?;
                    let key = key_hex.as_ref().map(|k| key_from_hex(k)).transpose()
                        .map_err(|e| anyhow::anyhow!("Invalid key: {}", e))?;
                    let nhash_data = NHashData {
                        hash,
                        path: vec![],
                        decrypt_key: key,
                    };
                    let nhash = nhash_encode_full(&nhash_data)
                        .map_err(|e| anyhow::anyhow!("Failed to encode nhash: {}", e))?;
                    let filename = path.file_name()
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
                let keys = NostrKeys::parse(&nsec_str)
                    .context("Failed to parse nsec")?;
                let npub = NostrToBech32::to_bech32(&keys.public_key())
                    .context("Failed to encode npub")?;

                let tree_name = path.file_name()
                    .map(|n| n.to_string_lossy().to_string());

                // Build ref_key: "npub/filename"
                let ref_key = tree_name.as_ref()
                    .map(|name| format!("{}/{}", npub, name));

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
                    let keys = NostrKeys::parse(&nsec_str)
                        .context("Failed to parse nsec")?;
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
                    let resolver = NostrRootResolver::new(resolver_config).await
                        .context("Failed to create Nostr resolver")?;

                    // Build Cid from computed hash
                    let hash = from_hex(&hash_hex).context("Invalid hash")?;
                    let key = key_hex.as_ref().map(|k| key_from_hex(k)).transpose()
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
                        if let Err(e) = background_blossom_push(&data_dir, &hash_hex, &write_servers).await {
                            eprintln!("  file server push failed: {}", e);
                        }
                    }
                }
            }
        }
        Commands::Get { cid: cid_input, output } => {
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
                    let resolved_cid = store.resolve_path(&cid, path)?
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
            let nhash = nhash_encode(&resolved.cid.hash)
                .unwrap_or_else(|_| to_hex(&resolved.cid.hash));
            println!("Pinned: {}", nhash);
        }
        Commands::Unpin { cid: cid_input } => {
            use hashtree_core::{nhash_encode, to_hex};

            // Resolve npub/repo or htree:// URLs to CID
            let resolved = resolve_cid_input(&cid_input).await?;
            let store = HashtreeStore::new(&data_dir)?;
            store.unpin(&resolved.cid.hash)?;
            let nhash = nhash_encode(&resolved.cid.hash)
                .unwrap_or_else(|_| to_hex(&resolved.cid.hash));
            println!("Unpinned: {}", nhash);
        }
        Commands::Info { cid: cid_input } => {
            use hashtree_core::{nhash_encode, to_hex};

            // Resolve npub/repo or htree:// URLs to CID
            let resolved = resolve_cid_input(&cid_input).await?;
            let store = HashtreeStore::new(&data_dir)?;
            let nhash = nhash_encode(&resolved.cid.hash)
                .unwrap_or_else(|_| to_hex(&resolved.cid.hash));

            // Check if content exists using file chunk metadata
            if let Some(metadata) = store.get_file_chunk_metadata(&resolved.cid.hash)? {
                println!("Hash: {}", nhash);
                println!("Pinned: {}", store.is_pinned(&resolved.cid.hash)?);
                println!("Total size: {} bytes", metadata.total_size);
                println!("Chunked: {}", metadata.is_chunked);

                if metadata.is_chunked {
                    println!("Chunks: {}", metadata.chunk_hashes.len());
                    println!("\nChunk details:");
                    for (i, (chunk_hash, size)) in metadata.chunk_hashes.iter().zip(metadata.chunk_sizes.iter()).enumerate() {
                        println!("  [{}] {} ({} bytes)", i, to_hex(chunk_hash), size);
                    }
                }

                // Show directory listing if it's a directory
                if let Ok(Some(listing)) = store.get_directory_listing(&resolved.cid.hash) {
                    println!("\nDirectory contents:");
                    for entry in listing.entries {
                        let type_str = if entry.is_directory { "dir" } else { "file" };
                        println!("  [{}] {} -> {} ({} bytes)",
                            type_str, entry.name, entry.cid, entry.size);
                    }
                }

                // Show tree node info if available
                if let Ok(Some(node)) = store.get_tree_node(&resolved.cid.hash) {
                    println!("\nTree node info:");
                    println!("  Links: {}", node.links.len());
                    for (i, link) in node.links.iter().enumerate() {
                        let name = link.name.as_ref().map(|n| n.as_str()).unwrap_or("<unnamed>");
                        let size_str = format!("{} bytes", link.size);
                        println!("    [{}] {} -> {} ({})", i, name, hashtree_core::to_hex(&link.hash), size_str);
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
            println!("  Total size: {} bytes ({:.2} KB)",
                stats.total_bytes,
                stats.total_bytes as f64 / 1024.0);
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
            println!("Freed {} bytes ({:.2} KB)",
                gc_stats.freed_bytes,
                gc_stats.freed_bytes as f64 / 1024.0);
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
                    let profile_name = fetch_profile_name(&config.nostr.relays, &keys.public_key().to_hex()).await;
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
                        nostr::SecretKey::from_bech32(&id)
                            .context("Invalid nsec")?;
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
        Commands::Publish { ref_name, hash, key } => {
            use hashtree_core::{from_hex, key_from_hex, Cid};

            // Load config for relay list
            let config = Config::load()?;

            // Ensure nsec exists (generate if needed)
            let (nsec_str, was_generated) = ensure_keys_string()?;

            // Create Keys using nostr-sdk's version
            let keys = NostrKeys::parse(&nsec_str)
                .context("Failed to parse nsec")?;
            let npub = NostrToBech32::to_bech32(&keys.public_key())
                .context("Failed to encode npub")?;

            if was_generated {
                println!("Identity: {} (new)", npub);
            }

            // Parse hash and optional key
            let hash_bytes = from_hex(&hash)
                .context("Invalid hash (expected hex)")?;
            let key_bytes = key.as_ref()
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
            let resolver = NostrRootResolver::new(resolver_config).await
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
        Commands::Mute { npub } => {
            mute_user(&data_dir, &npub, true).await?;
        }
        Commands::Unmute { npub } => {
            mute_user(&data_dir, &npub, false).await?;
        }
        Commands::Following => {
            list_following(&data_dir).await?;
        }
        Commands::Muted => {
            list_muted(&data_dir).await?;
        }
        Commands::Socialgraph { command } => {
            match command {
                SocialGraphCommands::Filter { max_distance, overmute_threshold } => {
                    run_socialgraph_filter(data_dir, max_distance, overmute_threshold)?;
                }
            }
        }
        Commands::Profile { name, about, picture } => {
            update_profile(name, about, picture).await?;
        }
        Commands::Push { cid: cid_input, server } => {
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
            let data_dir = cli.data_dir.clone().unwrap_or_else(|| {
                PathBuf::from(&config.storage.data_dir)
            });

            let max_size_bytes = config.storage.max_size_gb * 1024 * 1024 * 1024;
            let store = HashtreeStore::with_options(&data_dir, config.storage.s3.as_ref(), max_size_bytes)?;

            match command {
                StorageCommands::Stats => {
                    let stats = store.get_storage_stats()?;
                    let by_priority = store.storage_by_priority()?;
                    let tracked = store.tracked_size()?;
                    let trees = store.list_indexed_trees()?;

                    println!("Storage Statistics:");
                    println!("  Max size:     {} GB ({} bytes)", config.storage.max_size_gb, max_size_bytes);
                    println!("  Total bytes:  {} ({:.2} GB)", stats.total_bytes, stats.total_bytes as f64 / 1024.0 / 1024.0 / 1024.0);
                    println!("  Tracked:      {} ({:.2} GB)", tracked, tracked as f64 / 1024.0 / 1024.0 / 1024.0);
                    println!("  Total DAGs:   {}", stats.total_dags);
                    println!("  Pinned DAGs:  {}", stats.pinned_dags);
                    println!("  Indexed trees: {}", trees.len());
                    println!();
                    println!("Usage by priority:");
                    println!("  Own (255):      {} ({:.2} MB)", by_priority.own, by_priority.own as f64 / 1024.0 / 1024.0);
                    println!("  Followed (128): {} ({:.2} MB)", by_priority.followed, by_priority.followed as f64 / 1024.0 / 1024.0);
                    println!("  Other (64):     {} ({:.2} MB)", by_priority.other, by_priority.other as f64 / 1024.0 / 1024.0);

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
                        println!("Evicted {} bytes ({:.2} MB)", freed, freed as f64 / 1024.0 / 1024.0);
                    } else {
                        println!("No eviction needed (storage under limit)");
                    }
                }
                StorageCommands::Verify { delete, r2 } => {
                    println!("Verifying blob integrity...");
                    if !delete {
                        println!("(dry-run mode - use --delete to actually remove corrupted entries)");
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
                            println!("Cleanup complete. Removed {} corrupted entries.", total_corrupted);
                        } else {
                            println!("Found {} corrupted entries. Run with --delete to remove them.", total_corrupted);
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

/// Format bytes in human-readable form
fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

/// Convert unix timestamp to human-readable string
fn chrono_humanize_timestamp(ts: u64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH, Duration};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();

    let diff = now.saturating_sub(ts);

    if diff < 60 {
        format!("{}s ago", diff)
    } else if diff < 3600 {
        format!("{}m ago", diff / 60)
    } else if diff < 86400 {
        format!("{}h ago", diff / 3600)
    } else {
        format!("{}d ago", diff / 86400)
    }
}

fn format_daemon_status(status: &serde_json::Value, include_header: bool) -> String {
    let mut lines = Vec::new();
    if include_header {
        lines.push("Daemon Status:".to_string());
    }
    let status_text = status["status"].as_str().unwrap_or("unknown");
    lines.push(format!("  Status: {}", status_text));

    if let Some(storage) = status.get("storage") {
        lines.push(String::new());
        lines.push("Storage:".to_string());
        if let Some(total) = storage.get("total_dags") {
            lines.push(format!("  Total DAGs: {}", total));
        }
        if let Some(pinned) = storage.get("pinned_dags") {
            lines.push(format!("  Pinned DAGs: {}", pinned));
        }
        if let Some(bytes) = storage.get("total_bytes").and_then(|b| b.as_u64()) {
            lines.push(format!("  Total size: {}", format_bytes(bytes)));
        }
    }

    if let Some(webrtc) = status.get("webrtc") {
        lines.push(String::new());
        lines.push("WebRTC:".to_string());
        if webrtc.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false) {
            lines.push("  Enabled: yes".to_string());
            if let Some(total) = webrtc.get("total_peers") {
                lines.push(format!("  Total peers: {}", total));
            }
            if let Some(connected) = webrtc.get("connected") {
                lines.push(format!("  Connected: {}", connected));
            }
            if let Some(dc) = webrtc.get("with_data_channel") {
                lines.push(format!("  With data channel: {}", dc));
            }
            if let Some(sent) = webrtc.get("bytes_sent").and_then(|b| b.as_u64()) {
                lines.push(format!("  Bytes sent: {}", format_bytes(sent)));
            }
            if let Some(received) = webrtc.get("bytes_received").and_then(|b| b.as_u64()) {
                lines.push(format!("  Bytes received: {}", format_bytes(received)));
            }
        } else {
            lines.push("  Enabled: no".to_string());
        }
    }

    if let Some(upstream) = status.get("upstream") {
        if let Some(count) = upstream.get("blossom_servers").and_then(|c| c.as_u64()) {
            if count > 0 {
                lines.push(String::new());
                lines.push("Upstream:".to_string());
                lines.push(format!("  Blossom servers: {}", count));
            }
        }
    }

    lines.join("\n")
}

fn default_daemon_log_file() -> PathBuf {
    hashtree_cli::config::get_hashtree_dir()
        .join("logs")
        .join("htree.log")
}

fn default_daemon_pid_file() -> PathBuf {
    hashtree_cli::config::get_hashtree_dir()
        .join("htree.pid")
}

fn build_daemon_args(
    addr: &str,
    relays: Option<&str>,
    data_dir: Option<&PathBuf>,
) -> Vec<std::ffi::OsString> {
    let mut args = Vec::new();
    args.push(std::ffi::OsString::from("--addr"));
    args.push(std::ffi::OsString::from(addr));
    if let Some(relays) = relays {
        args.push(std::ffi::OsString::from("--relays"));
        args.push(std::ffi::OsString::from(relays));
    }
    if let Some(data_dir) = data_dir {
        args.push(std::ffi::OsString::from("--data-dir"));
        args.push(data_dir.as_os_str().to_owned());
    }
    args
}

fn spawn_daemon(
    addr: &str,
    relays: Option<&str>,
    data_dir: Option<PathBuf>,
    log_file: Option<&PathBuf>,
    pid_file: Option<&PathBuf>,
) -> Result<()> {
    #[cfg(unix)]
    {
        use std::fs::{self, OpenOptions};
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};

        let log_path = log_file.cloned().unwrap_or_else(default_daemon_log_file);
        let pid_path = pid_file.cloned().unwrap_or_else(default_daemon_pid_file);
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create log dir {}", parent.display()))?;
        }
        if let Some(parent) = pid_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create pid dir {}", parent.display()))?;
        }

        if pid_path.exists() {
            let pid = read_pid_file(&pid_path)
                .with_context(|| format!("Failed to read pid file {}", pid_path.display()))?;
            if is_process_running(pid) {
                anyhow::bail!("Daemon already running (pid {})", pid);
            }
            fs::remove_file(&pid_path)
                .with_context(|| format!("Failed to remove stale pid file {}", pid_path.display()))?;
        }

        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("Failed to open log file {}", log_path.display()))?;
        let log_err = log.try_clone().context("Failed to clone log file handle")?;

        let exe = std::env::current_exe().context("Failed to locate htree binary")?;
        let mut cmd = Command::new(exe);
        cmd.arg("start")
            .args(build_daemon_args(addr, relays, data_dir.as_ref()))
            .env("HTREE_DAEMONIZED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));

        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let child = cmd.spawn().context("Failed to spawn daemon")?;
        write_pid_file(&pid_path, child.id())
            .with_context(|| format!("Failed to write pid file {}", pid_path.display()))?;
        println!("Started hashtree daemon (pid {})", child.id());
        println!("Log file: {}", log_path.display());
        println!("PID file: {}", pid_path.display());
        return Ok(());
    }

    #[cfg(not(unix))]
    {
        let _ = addr;
        let _ = relays;
        let _ = data_dir;
        let _ = log_file;
        let _ = pid_file;
        anyhow::bail!("Daemon mode is only supported on Unix systems");
    }
}

fn parse_pid(contents: &str) -> Result<i32> {
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        anyhow::bail!("PID file is empty");
    }
    let pid: i32 = trimmed.parse().context("Invalid PID value")?;
    if pid <= 0 {
        anyhow::bail!("PID must be a positive integer");
    }
    Ok(pid)
}

fn read_pid_file(path: &std::path::Path) -> Result<i32> {
    let contents = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read pid file {}", path.display()))?;
    parse_pid(&contents)
}

fn write_pid_file(path: &std::path::Path, pid: u32) -> Result<()> {
    std::fs::write(path, format!("{}\n", pid))
        .with_context(|| format!("Failed to write pid file {}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
fn is_process_running(pid: i32) -> bool {
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        return true;
    }
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
        Some(code) if code == libc::ESRCH => false,
        Some(code) if code == libc::EPERM => true,
        _ => false,
    }
}

#[cfg(unix)]
fn signal_process(pid: i32, signal: i32) -> Result<()> {
    let result = unsafe { libc::kill(pid, signal) };
    if result == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    anyhow::bail!("Failed to signal pid {}: {}", pid, err);
}

fn stop_daemon(pid_file: Option<&PathBuf>) -> Result<()> {
    let pid_path = pid_file.cloned().unwrap_or_else(default_daemon_pid_file);
    let pid = read_pid_file(&pid_path)?;

    #[cfg(unix)]
    {
        if !is_process_running(pid) {
            let _ = std::fs::remove_file(&pid_path);
            anyhow::bail!("Daemon not running (pid {})", pid);
        }

        signal_process(pid, libc::SIGTERM)?;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if !is_process_running(pid) {
                std::fs::remove_file(&pid_path)
                    .with_context(|| format!("Failed to remove pid file {}", pid_path.display()))?;
                println!("Stopped hashtree daemon (pid {})", pid);
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        anyhow::bail!("Timed out waiting for daemon to stop (pid {})", pid);
    }

    #[cfg(not(unix))]
    {
        let _ = pid_path;
        anyhow::bail!("Daemon stop is only supported on Unix systems");
    }
}

fn load_hex_list(path: &Path) -> Result<Vec<String>> {
    if path.exists() {
        let data = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&data).unwrap_or_default())
    } else {
        Ok(Vec::new())
    }
}

fn save_hex_list(path: &Path, list: &[String]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(list)?)?;
    Ok(())
}

fn update_hex_list_file_with_status(
    path: &Path,
    target_hex: &str,
    add: bool,
) -> Result<(Vec<String>, bool)> {
    let mut list = load_hex_list(path)?;
    let changed = if add {
        if list.contains(&target_hex.to_string()) {
            false
        } else {
            list.push(target_hex.to_string());
            true
        }
    } else if let Some(pos) = list.iter().position(|x| x == target_hex) {
        list.remove(pos);
        true
    } else {
        false
    };

    if changed {
        save_hex_list(path, &list)?;
    }

    Ok((list, changed))
}

#[cfg(test)]
fn update_hex_list_file(path: &Path, target_hex: &str, add: bool) -> Result<Vec<String>> {
    let (list, _changed) = update_hex_list_file_with_status(path, target_hex, add)?;
    Ok(list)
}

fn build_pubkey_list_event(
    kind: nostr::Kind,
    pubkeys: &[String],
    keys: &nostr::Keys,
) -> Result<nostr::Event> {
    use nostr::{EventBuilder, PublicKey, Tag};

    let tags: Vec<Tag> = pubkeys
        .iter()
        .filter_map(|pk_hex| PublicKey::from_hex(pk_hex).ok().map(Tag::public_key))
        .collect();

    EventBuilder::new(kind, "", tags)
        .to_event(keys)
        .context("Failed to sign list event")
}

/// Follow or unfollow a user by publishing an updated kind 3 contact list
async fn follow_user(data_dir: &PathBuf, npub_str: &str, follow: bool) -> Result<()> {
    use nostr::{Kind, Keys, JsonUtil, ClientMessage};
    use tokio_tungstenite::connect_async;
    use futures::sink::SinkExt;

    // Load config for relay list
    let config = Config::load()?;

    // Ensure nsec exists
    let (nsec_str, _) = ensure_keys_string()?;
    let keys = Keys::parse(&nsec_str).context("Failed to parse nsec")?;

    // Parse target npub
    let target_pubkey = parse_npub(npub_str).context("Invalid npub")?;
    let target_pubkey_hex = hex::encode(target_pubkey);

    // Update contact list locally
    let contacts_file = data_dir.join("contacts.json");
    let (contacts, changed) =
        update_hex_list_file_with_status(&contacts_file, &target_pubkey_hex, follow)?;

    if follow {
        if changed {
            println!("Following: {}", npub_str);
        } else {
            println!("Already following: {}", npub_str);
            return Ok(());
        }
    } else if changed {
        println!("Unfollowed: {}", npub_str);
    } else {
        println!("Not following: {}", npub_str);
        return Ok(());
    }

    let event = build_pubkey_list_event(Kind::ContactList, &contacts, &keys)?;

    let event_json = ClientMessage::event(event).as_json();

    // Publish to relays
    let mut success_count = 0;
    for relay in &config.nostr.relays {
        match connect_async(relay).await {
            Ok((mut ws, _)) => {
                if ws.send(tokio_tungstenite::tungstenite::Message::Text(event_json.clone().into())).await.is_ok() {
                    success_count += 1;
                }
                let _ = ws.close(None).await;
            }
            Err(_) => {}
        }
    }

    println!("Published contact list to {} relays", success_count);
    Ok(())
}

/// Mute or unmute a user by publishing an updated kind 10000 mute list
async fn mute_user(data_dir: &PathBuf, npub_str: &str, mute: bool) -> Result<()> {
    use nostr::{Kind, Keys, JsonUtil, ClientMessage};
    use tokio_tungstenite::connect_async;
    use futures::sink::SinkExt;

    let config = Config::load()?;

    let (nsec_str, _) = ensure_keys_string()?;
    let keys = Keys::parse(&nsec_str).context("Failed to parse nsec")?;

    let target_pubkey = parse_npub(npub_str).context("Invalid npub")?;
    let target_pubkey_hex = hex::encode(target_pubkey);

    let mutes_file = data_dir.join("mutes.json");
    let (mutes, changed) =
        update_hex_list_file_with_status(&mutes_file, &target_pubkey_hex, mute)?;

    if mute {
        if changed {
            println!("Muted: {}", npub_str);
        } else {
            println!("Already muted: {}", npub_str);
            return Ok(());
        }
    } else if changed {
        println!("Unmuted: {}", npub_str);
    } else {
        println!("Not muted: {}", npub_str);
        return Ok(());
    }

    let event = build_pubkey_list_event(Kind::Custom(10000), &mutes, &keys)?;
    let event_json = ClientMessage::event(event).as_json();

    let mut success_count = 0;
    for relay in &config.nostr.relays {
        match connect_async(relay).await {
            Ok((mut ws, _)) => {
                if ws.send(tokio_tungstenite::tungstenite::Message::Text(event_json.clone().into())).await.is_ok() {
                    success_count += 1;
                }
                let _ = ws.close(None).await;
            }
            Err(_) => {}
        }
    }

    println!("Published mute list to {} relays", success_count);
    Ok(())
}

/// Show or update Nostr profile (kind 0)
async fn update_profile(
    name: Option<String>,
    about: Option<String>,
    picture: Option<String>,
) -> Result<()> {
    use nostr::{EventBuilder, Kind, Keys, Filter};
    use nostr::nips::nip19::ToBech32;
    use nostr_sdk::{ClientBuilder, EventSource};
    use std::time::Duration;

    // Load config for relay list
    let config = Config::load()?;

    // Ensure nsec exists
    let (nsec_str, _) = ensure_keys_string()?;
    let keys = Keys::parse(&nsec_str).context("Failed to parse nsec")?;
    let npub = keys.public_key().to_bech32()?;

    // Check if we're just showing the profile (no args)
    let is_show_only = name.is_none() && about.is_none() && picture.is_none();

    // Fetch existing profile
    let client = ClientBuilder::default().build();
    for relay in &config.nostr.relays {
        let _ = client.add_relay(relay).await;
    }
    client.connect().await;

    // Wait for relay connections to establish
    tokio::time::sleep(Duration::from_millis(500)).await;

    let filter = Filter::new()
        .author(keys.public_key())
        .kind(Kind::Metadata)
        .limit(1);

    let timeout = Duration::from_secs(5);
    let events = tokio::time::timeout(
        timeout,
        client.get_events_of(vec![filter], EventSource::relays(None))
    ).await.ok().and_then(|r| r.ok()).unwrap_or_default();
    let _ = client.disconnect().await;

    // Parse existing profile or start fresh
    let mut profile: serde_json::Map<String, serde_json::Value> = events
        .into_iter()
        .next()
        .and_then(|e| serde_json::from_str(&e.content).ok())
        .unwrap_or_default();

    if is_show_only {
        // Just display current profile
        println!("Profile: {}\n", npub);
        if let Some(n) = profile.get("name").and_then(|v| v.as_str()) {
            println!("  name:    {}", n);
        }
        if let Some(a) = profile.get("about").and_then(|v| v.as_str()) {
            println!("  about:   {}", a);
        }
        if let Some(p) = profile.get("picture").and_then(|v| v.as_str()) {
            println!("  picture: {}", p);
        }
        if profile.is_empty() {
            println!("  (no profile set)");
        }
        return Ok(());
    }

    // Update fields
    if let Some(n) = name {
        profile.insert("name".to_string(), serde_json::Value::String(n));
    }
    if let Some(a) = about {
        profile.insert("about".to_string(), serde_json::Value::String(a));
    }
    if let Some(p) = picture {
        profile.insert("picture".to_string(), serde_json::Value::String(p));
    }

    // Build and sign kind 0 event
    let content = serde_json::to_string(&profile)?;
    let event = EventBuilder::new(Kind::Metadata, &content, [])
        .to_event(&keys)
        .context("Failed to sign profile event")?;

    // Reuse the client we already have connected for publishing
    let client = ClientBuilder::default().build();
    for relay in &config.nostr.relays {
        let _ = client.add_relay(relay).await;
    }
    client.connect().await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Publish using nostr_sdk
    match client.send_event(event).await {
        Ok(output) => {
            let success_count = output.success.len();
            let failed_count = output.failed.len();
            if success_count > 0 {
                println!("Profile updated, published to {} relays", success_count);
            }
            if failed_count > 0 {
                eprintln!("Failed to publish to {} relays", failed_count);
            }
        }
        Err(e) => {
            eprintln!("Failed to publish profile: {}", e);
        }
    }

    let _ = client.disconnect().await;
    Ok(())
}

/// List users we follow
async fn list_following(data_dir: &PathBuf) -> Result<()> {
    use nostr::PublicKey;
    use nostr::nips::nip19::ToBech32;

    // Load contacts from local storage
    let contacts_file = data_dir.join("contacts.json");
    let contacts: Vec<String> = if contacts_file.exists() {
        let data = std::fs::read_to_string(&contacts_file)?;
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    };

    if contacts.is_empty() {
        println!("Not following anyone");
        return Ok(());
    }

    println!("Following {} users:", contacts.len());
    for pk_hex in &contacts {
        if let Ok(pk) = PublicKey::from_hex(pk_hex) {
            if let Ok(npub) = pk.to_bech32() {
                println!("  {}", npub);
            } else {
                println!("  {}", pk_hex);
            }
        } else {
            println!("  {} (invalid)", pk_hex);
        }
    }

    Ok(())
}

/// List users we mute
async fn list_muted(data_dir: &PathBuf) -> Result<()> {
    use nostr::PublicKey;
    use nostr::nips::nip19::ToBech32;

    let mutes_file = data_dir.join("mutes.json");
    let mutes: Vec<String> = if mutes_file.exists() {
        let data = std::fs::read_to_string(&mutes_file)?;
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    };

    if mutes.is_empty() {
        println!("Not muting anyone");
        return Ok(());
    }

    println!("Muted {} users:", mutes.len());
    for pk_hex in &mutes {
        if let Ok(pk) = PublicKey::from_hex(pk_hex) {
            if let Ok(npub) = pk.to_bech32() {
                println!("  {}", npub);
            } else {
                println!("  {}", pk_hex);
            }
        } else {
            println!("  {} (invalid)", pk_hex);
        }
    }

    Ok(())
}

/// List connected peers with optional profile resolution
async fn list_peers(addr: &str) -> Result<()> {
    use nostr::nips::nip19::ToBech32;
    use nostr::PublicKey;

    let url = format!("http://{}/api/peers", addr);
    let resp = match reqwest::get(&url).await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            eprintln!("Daemon returned error: {}", r.status());
            return Ok(());
        }
        Err(_) => {
            eprintln!("Daemon not running at {}", addr);
            eprintln!("Start with: htree start");
            return Ok(());
        }
    };

    let data: serde_json::Value = resp.json().await?;

    if !data.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false) {
        println!("WebRTC is not enabled");
        return Ok(());
    }

    let peers = data.get("peers").and_then(|p| p.as_array());
    let Some(peers) = peers else {
        println!("No peers");
        return Ok(());
    };

    // Collect connected peers
    let connected: Vec<_> = peers.iter()
        .filter(|p| {
            p.get("state")
                .and_then(|s| s.as_str())
                .map(|s| s.eq_ignore_ascii_case("connected"))
                .unwrap_or(false)
        })
        .collect();

    if connected.is_empty() {
        println!("No connected peers (total: {})", peers.len());
        return Ok(());
    }

    println!("Connected peers ({}/{}):\n", connected.len(), peers.len());

    // Load config for relays
    let config = Config::load()?;

    // Group peers by pool
    let follows: Vec<_> = connected.iter()
        .filter(|p| p.get("pool").and_then(|s| s.as_str()).map(|s| s.eq_ignore_ascii_case("follows")).unwrap_or(false))
        .collect();
    let others: Vec<_> = connected.iter()
        .filter(|p| !p.get("pool").and_then(|s| s.as_str()).map(|s| s.eq_ignore_ascii_case("follows")).unwrap_or(false))
        .collect();

    // Helper to print peer with profile
    async fn print_peer(peer: &serde_json::Value, relays: &[String]) {
        let pubkey_hex = peer.get("pubkey").and_then(|p| p.as_str()).unwrap_or("");

        let npub = if let Ok(pk) = PublicKey::from_hex(pubkey_hex) {
            pk.to_bech32().unwrap_or_else(|_| pubkey_hex.to_string())
        } else {
            pubkey_hex.to_string()
        };

        let profile_name = fetch_profile_name(relays, pubkey_hex).await;

        // Get bandwidth stats
        let bytes_sent = peer.get("bytes_sent").and_then(|b| b.as_u64()).unwrap_or(0);
        let bytes_received = peer.get("bytes_received").and_then(|b| b.as_u64()).unwrap_or(0);

        let name_part = if let Some(name) = profile_name {
            format!(" ({})", name)
        } else {
            String::new()
        };

        let bandwidth_part = if bytes_sent > 0 || bytes_received > 0 {
            format!(" [↑{} ↓{}]", format_bytes(bytes_sent), format_bytes(bytes_received))
        } else {
            String::new()
        };

        println!("  {}{}{}", npub, name_part, bandwidth_part);
    }

    if !follows.is_empty() {
        println!("Follows:");
        for peer in follows {
            print_peer(peer, &config.nostr.relays).await;
        }
        if !others.is_empty() {
            println!();
        }
    }

    if !others.is_empty() {
        println!("Other:");
        for peer in others {
            print_peer(peer, &config.nostr.relays).await;
        }
    }

    Ok(())
}

/// Fetch profile name from Nostr relays (2s timeout)
async fn fetch_profile_name(relays: &[String], pubkey_hex: &str) -> Option<String> {
    use nostr::{Filter, Kind, PublicKey};
    use nostr_sdk::{ClientBuilder, EventSource};
    use std::time::Duration;

    let pk = PublicKey::from_hex(pubkey_hex).ok()?;

    // Create client with relays
    let client = ClientBuilder::default().build();
    for relay in relays {
        let _ = client.add_relay(relay).await;
    }
    client.connect().await;

    // Fetch kind 0 profile
    let filter = Filter::new()
        .author(pk)
        .kind(Kind::Metadata)
        .limit(1);

    let timeout = Duration::from_secs(2);
    let events = tokio::time::timeout(
        timeout,
        client.get_events_of(vec![filter], EventSource::relays(None))
    ).await.ok()?.ok()?;
    let _ = client.disconnect().await;

    // Parse profile JSON
    let event = events.into_iter().next()?;
    let profile: serde_json::Value = serde_json::from_str(&event.content).ok()?;

    // Try display_name, then name, then username
    profile.get("display_name")
        .or_else(|| profile.get("name"))
        .or_else(|| profile.get("username"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Push content to Blossom servers
async fn push_to_blossom(data_dir: &PathBuf, cid_str: &str, server_override: Option<String>) -> Result<()> {
    use hashtree_blossom::BlossomClient;
    use hashtree_core::from_hex;
    use nostr::Keys;

    // Ensure nsec exists for signing
    let (nsec_str, _) = ensure_keys_string()?;
    let keys = Keys::parse(&nsec_str).context("Failed to parse nsec")?;

    // Create client (optionally with server override)
    let client = if let Some(server) = server_override {
        BlossomClient::new(keys).with_write_servers(vec![server])
    } else {
        BlossomClient::new(keys)
    };

    if client.write_servers().is_empty() {
        anyhow::bail!("No file servers configured. Use --server or add write_servers to config.toml");
    }

    // Open local store
    let store = HashtreeStore::new(data_dir)?;

    // Parse CID (hash or hash:key)
    let (hash_hex, _key_hex) = if let Some((h, k)) = cid_str.split_once(':') {
        (h.to_string(), Some(k.to_string()))
    } else {
        (cid_str.to_string(), None)
    };

    // Collect all blocks to push (walk the DAG)
    println!("Collecting blocks...");
    let mut blocks_to_push: Vec<Vec<u8>> = Vec::new();
    let mut visited: std::collections::HashSet<[u8; 32]> = std::collections::HashSet::new();
    let root_hash = from_hex(&hash_hex).context("Invalid hash")?;
    let mut queue = vec![root_hash];

    while let Some(hash) = queue.pop() {
        if visited.contains(&hash) {
            continue;
        }
        visited.insert(hash);

        if let Ok(Some(node)) = store.get_tree_node(&hash) {
            if let Ok(Some(data)) = store.get_blob(&hash) {
                blocks_to_push.push(data);
            }
            for link in &node.links {
                if !visited.contains(&link.hash) {
                    queue.push(link.hash);
                }
            }
        } else if let Ok(Some(metadata)) = store.get_file_chunk_metadata(&hash) {
            if metadata.is_chunked {
                for chunk_hash in &metadata.chunk_hashes {
                    if !visited.contains(chunk_hash) {
                        if let Ok(Some(chunk_data)) = store.get_blob(chunk_hash) {
                            blocks_to_push.push(chunk_data);
                            visited.insert(*chunk_hash);
                        }
                    }
                }
            }
            if let Ok(Some(data)) = store.get_blob(&hash) {
                blocks_to_push.push(data);
            }
        } else if let Ok(Some(data)) = store.get_blob(&hash) {
            blocks_to_push.push(data);
        }
    }

    println!("Found {} blocks to push", blocks_to_push.len());

    let mut uploaded = 0;
    let mut skipped = 0;
    let mut errors = 0;

    for data in &blocks_to_push {
        match client.upload_if_missing(data).await {
            Ok((_hash, was_uploaded)) => {
                if was_uploaded {
                    uploaded += 1;
                } else {
                    skipped += 1;
                }
            }
            Err(e) => {
                eprintln!("  Upload error: {}", e);
                errors += 1;
            }
        }
    }

    println!("\nUploaded: {}, Skipped: {}, Errors: {}", uploaded, skipped, errors);
    println!("Done!");
    Ok(())
}

/// Push tree to Blossom servers using BlossomClient
async fn background_blossom_push(data_dir: &PathBuf, cid_str: &str, _servers: &[String]) -> Result<()> {
    use hashtree_blossom::BlossomClient;
    use hashtree_core::from_hex;
    use nostr::Keys;

    // Ensure nsec exists for signing
    let (nsec_str, _) = ensure_keys_string()?;
    let keys = Keys::parse(&nsec_str).context("Failed to parse nsec")?;

    // Open local store
    let store = HashtreeStore::new(data_dir)?;

    // Parse CID (hash or hash:key)
    let (hash_hex, _key_hex) = if let Some((h, k)) = cid_str.split_once(':') {
        (h.to_string(), Some(k.to_string()))
    } else {
        (cid_str.to_string(), None)
    };

    // Collect all blocks to push (walk the DAG)
    let mut blocks_to_push: Vec<Vec<u8>> = Vec::new();
    let mut visited: std::collections::HashSet<[u8; 32]> = std::collections::HashSet::new();
    let root_hash = from_hex(&hash_hex).context("Invalid hash")?;
    let mut queue = vec![root_hash];

    while let Some(hash) = queue.pop() {
        if visited.contains(&hash) {
            continue;
        }
        visited.insert(hash);

        // Try to get as tree node first (for directories/internal nodes)
        if let Ok(Some(node)) = store.get_tree_node(&hash) {
            if let Ok(Some(data)) = store.get_blob(&hash) {
                blocks_to_push.push(data);
            }
            for link in &node.links {
                if !visited.contains(&link.hash) {
                    queue.push(link.hash);
                }
            }
        } else if let Ok(Some(metadata)) = store.get_file_chunk_metadata(&hash) {
            if metadata.is_chunked {
                for chunk_hash in &metadata.chunk_hashes {
                    if !visited.contains(chunk_hash) {
                        if let Ok(Some(chunk_data)) = store.get_blob(chunk_hash) {
                            blocks_to_push.push(chunk_data);
                            visited.insert(*chunk_hash);
                        }
                    }
                }
            }
            if let Ok(Some(data)) = store.get_blob(&hash) {
                blocks_to_push.push(data);
            }
        } else if let Ok(Some(data)) = store.get_blob(&hash) {
            blocks_to_push.push(data);
        }
    }

    if blocks_to_push.is_empty() {
        return Ok(());
    }

    // Use BlossomClient (auto-loads servers from config)
    let client = BlossomClient::new(keys);
    let mut total_uploaded = 0;
    let mut total_skipped = 0;

    for data in &blocks_to_push {
        match client.upload_if_missing(data).await {
            Ok((_hash, was_uploaded)) => {
                if was_uploaded {
                    total_uploaded += 1;
                } else {
                    total_skipped += 1;
                }
            }
            Err(e) => {
                tracing::warn!("Blossom upload failed: {}", e);
            }
        }
    }

    if total_uploaded > 0 || total_skipped > 0 {
        println!("  file servers: {} uploaded, {} already exist", total_uploaded, total_skipped);
    }

    Ok(())
}

/// Recursively add a directory (handles encryption automatically based on tree config)
async fn add_directory<S: hashtree_core::store::Store>(
    tree: &hashtree_core::HashTree<S>,
    dir: &std::path::Path,
    respect_gitignore: bool,
) -> Result<hashtree_core::Cid> {
    use ignore::WalkBuilder;
    use hashtree_core::DirEntry;
    use std::collections::HashMap;

    // Collect files by their parent directory path
    let mut dir_contents: HashMap<String, Vec<(String, hashtree_core::Cid)>> = HashMap::new();

    // Use ignore crate for gitignore-aware walking
    let walker = WalkBuilder::new(dir)
        .git_ignore(respect_gitignore)
        .git_global(respect_gitignore)
        .git_exclude(respect_gitignore)
        .hidden(false)
        .build();

    for result in walker {
        let entry = result?;
        let path = entry.path();

        // Skip the root directory itself
        if path == dir {
            continue;
        }

        let relative = path.strip_prefix(dir).unwrap_or(path);

        if path.is_file() {
            let data = std::fs::read(path)?;
            let (cid, _size) = tree.put(&data).await
                .map_err(|e| anyhow::anyhow!("Failed to add file {}: {}", path.display(), e))?;

            let parent = relative.parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let name = relative.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            dir_contents.entry(parent).or_default().push((name, cid));
        } else if path.is_dir() {
            // Ensure directory entry exists
            let dir_path = relative.to_string_lossy().to_string();
            dir_contents.entry(dir_path).or_default();
        }
    }

    // Build directory tree bottom-up
    let mut dirs: Vec<String> = dir_contents.keys().cloned().collect();
    dirs.sort_by(|a, b| {
        let depth_a = a.matches('/').count() + if a.is_empty() { 0 } else { 1 };
        let depth_b = b.matches('/').count() + if b.is_empty() { 0 } else { 1 };
        depth_b.cmp(&depth_a) // Deepest first
    });

    let mut dir_cids: HashMap<String, hashtree_core::Cid> = HashMap::new();

    for dir_path in dirs {
        let files = dir_contents.get(&dir_path).cloned().unwrap_or_default();

        let mut entries: Vec<DirEntry> = files.into_iter()
            .map(|(name, cid)| DirEntry::from_cid(name, &cid))
            .collect();

        // Add subdirectory entries
        for (subdir_path, cid) in &dir_cids {
            let parent = std::path::Path::new(subdir_path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            if parent == dir_path {
                let name = std::path::Path::new(subdir_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                entries.push(DirEntry::from_cid(name, cid));
            }
        }

        let cid = tree.put_directory(entries).await
            .map_err(|e| anyhow::anyhow!("Failed to create directory node: {}", e))?;

        dir_cids.insert(dir_path, cid);
    }

    // Return root directory cid
    dir_cids.get("")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("No root directory"))
}

/// Calculate total size of a directory
#[allow(dead_code)]
fn dir_size(path: &std::path::Path) -> Result<u64> {
    let mut size = 0;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            size += dir_size(&path)?;
        } else {
            size += entry.metadata()?.len();
        }
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{Kind, TagStandard};

    fn args_to_strings(args: Vec<std::ffi::OsString>) -> Vec<String> {
        args.into_iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn test_build_daemon_args_with_overrides() {
        let data_dir = PathBuf::from("data-dir");
        let args = args_to_strings(build_daemon_args(
            "127.0.0.1:8080",
            Some("wss://relay.example"),
            Some(&data_dir),
        ));

        assert_eq!(
            args,
            vec![
                "--addr",
                "127.0.0.1:8080",
                "--relays",
                "wss://relay.example",
                "--data-dir",
                "data-dir",
            ]
        );
    }

    #[test]
    fn test_build_daemon_args_minimal() {
        let args = args_to_strings(build_daemon_args("0.0.0.0:8080", None, None));
        assert_eq!(args, vec!["--addr", "0.0.0.0:8080"]);
    }

    #[test]
    fn test_parse_pid() {
        assert_eq!(parse_pid("123\n").unwrap(), 123);
        assert!(parse_pid("").is_err());
        assert!(parse_pid("abc").is_err());
    }

    #[test]
    fn test_pid_file_roundtrip() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("htree.pid");
        write_pid_file(&path, 42).unwrap();
        let pid = read_pid_file(&path).unwrap();
        assert_eq!(pid, 42);
    }

    #[test]
    fn test_update_hex_list_file_add_remove() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("mutes.json");
        let pk1 = "aa".repeat(32);
        let pk2 = "bb".repeat(32);

        let list = update_hex_list_file(&path, &pk1, true).unwrap();
        assert_eq!(list, vec![pk1.clone()]);

        let list = update_hex_list_file(&path, &pk1, true).unwrap();
        assert_eq!(list, vec![pk1.clone()]);

        let list = update_hex_list_file(&path, &pk2, true).unwrap();
        assert_eq!(list, vec![pk1.clone(), pk2.clone()]);

        let list = update_hex_list_file(&path, &pk1, false).unwrap();
        assert_eq!(list, vec![pk2.clone()]);
    }

    #[test]
    fn test_build_mute_list_event_tags() {
        let keys = nostr::Keys::generate();
        let pk1 = nostr::Keys::generate().public_key().to_hex();
        let pk2 = nostr::Keys::generate().public_key().to_hex();
        let list = vec![pk1.clone(), pk2.clone()];
        let event = build_pubkey_list_event(Kind::Custom(10000), &list, &keys).unwrap();

        assert_eq!(event.kind, Kind::Custom(10000));

        let tags: Vec<String> = event
            .tags
            .iter()
            .filter_map(|tag| match tag.as_standardized() {
                Some(TagStandard::PublicKey { public_key, .. }) => Some(public_key.to_hex()),
                _ => None,
            })
            .collect();

        assert_eq!(tags.len(), 2);
        assert!(tags.contains(&pk1));
        assert!(tags.contains(&pk2));
    }

    #[tokio::test]
    async fn test_resolve_nhash_with_path_suffix() {
        // nhash for hash [0xaa; 32]
        let nhash = hashtree_core::nhash_encode(&[0xaa; 32]).unwrap();

        // Test nhash without path
        let resolved = resolve_cid_input(&nhash).await.unwrap();
        assert_eq!(resolved.cid.hash, [0xaa; 32]);
        assert!(resolved.path.is_none());

        // Test nhash with single file path suffix
        let with_path = format!("{}/bitcoin.pdf", nhash);
        let resolved = resolve_cid_input(&with_path).await.unwrap();
        assert_eq!(resolved.cid.hash, [0xaa; 32]);
        assert_eq!(resolved.path, Some("bitcoin.pdf".to_string()));

        // Test nhash with nested path suffix
        let with_nested = format!("{}/docs/papers/bitcoin.pdf", nhash);
        let resolved = resolve_cid_input(&with_nested).await.unwrap();
        assert_eq!(resolved.cid.hash, [0xaa; 32]);
        assert_eq!(resolved.path, Some("docs/papers/bitcoin.pdf".to_string()));
    }

    #[tokio::test]
    async fn test_resolve_nhash_with_htree_prefix() {
        let nhash = hashtree_core::nhash_encode(&[0xbb; 32]).unwrap();

        // Test htree:// prefix with path
        let htree_url = format!("htree://{}/file.txt", nhash);
        let resolved = resolve_cid_input(&htree_url).await.unwrap();
        assert_eq!(resolved.cid.hash, [0xbb; 32]);
        assert_eq!(resolved.path, Some("file.txt".to_string()));
    }

    #[tokio::test]
    async fn test_resolve_hex_cid_with_key_and_path() {
        let hash = [0x11; 32];
        let key = [0x22; 32];
        let hash_hex = hashtree_core::to_hex(&hash);
        let key_hex = hashtree_core::to_hex(&key);
        let cid = format!("{}:{}", hash_hex, key_hex);

        let resolved = resolve_cid_input(&cid).await.unwrap();
        assert_eq!(resolved.cid.hash, hash);
        assert_eq!(resolved.cid.key, Some(key));
        assert!(resolved.path.is_none());

        let with_path = format!("{}/dir/file.txt", cid);
        let resolved = resolve_cid_input(&with_path).await.unwrap();
        assert_eq!(resolved.cid.hash, hash);
        assert_eq!(resolved.cid.key, Some(key));
        assert_eq!(resolved.path, Some("dir/file.txt".to_string()));
    }

    #[tokio::test]
    async fn test_resolve_hex_cid_without_key() {
        let hash = [0x33; 32];
        let hash_hex = hashtree_core::to_hex(&hash);
        let resolved = resolve_cid_input(&hash_hex).await.unwrap();
        assert_eq!(resolved.cid.hash, hash);
        assert!(resolved.cid.key.is_none());
    }
}
