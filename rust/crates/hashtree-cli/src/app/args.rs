use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "htree")]
#[command(version)]
#[command(about = "Content-addressed filesystem", long_about = None)]
pub(crate) struct Cli {
    /// Data directory (default: ~/.hashtree/data)
    #[arg(long, global = true, env = "HTREE_DATA_DIR")]
    pub(crate) data_dir: Option<PathBuf>,

    #[command(subcommand)]
    pub(crate) command: Commands,
}

impl Cli {
    /// Get the data directory, defaulting to ~/.hashtree/data
    pub(crate) fn data_dir(&self) -> PathBuf {
        self.data_dir
            .clone()
            .unwrap_or_else(|| hashtree_cli::config::get_hashtree_dir().join("data"))
    }
}

#[derive(Subcommand)]
pub(crate) enum Commands {
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
        /// Optional reason to include in the mute list
        #[arg(long)]
        reason: Option<String>,
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

    /// Pull request management
    Pr {
        #[command(subcommand)]
        command: PrCommands,
    },
}

#[derive(Subcommand)]
pub(crate) enum PrCommands {
    /// Create a pull request
    Create {
        /// Target repository (git remote alias, npub/reponame, or htree:// URL of the repo to PR into)
        repo: Option<String>,
        /// PR title
        #[arg(long, short)]
        title: String,
        /// PR description
        #[arg(long, short)]
        description: Option<String>,
        /// Source branch name (default: current branch)
        #[arg(long)]
        branch: Option<String>,
        /// Target branch (default: master)
        #[arg(long, default_value = "master")]
        target_branch: String,
        /// Clone URL for source repo (default: htree://self/<reponame>)
        #[arg(long)]
        clone_url: Option<String>,
    },
}

#[derive(Subcommand)]
pub(crate) enum StorageCommands {
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
pub(crate) enum SocialGraphCommands {
    /// Filter JSONL Nostr events to those within the social graph
    Filter {
        /// Max follow distance to allow (default: config nostr.max_write_distance)
        #[arg(long)]
        max_distance: Option<u32>,
        /// Overmute threshold (muters * threshold > followers)
        #[arg(long, default_value_t = 1.0)]
        overmute_threshold: f64,
    },
    /// Save a social graph snapshot (nostr-social-graph binary format)
    Snapshot {
        /// Output file path (use "-" for stdout)
        #[arg(long, short)]
        out: PathBuf,
        /// Maximum number of nodes
        #[arg(long)]
        max_nodes: Option<usize>,
        /// Maximum number of edges
        #[arg(long)]
        max_edges: Option<usize>,
        /// Maximum follow distance
        #[arg(long)]
        max_distance: Option<u32>,
        /// Maximum edges per node
        #[arg(long)]
        max_edges_per_node: Option<usize>,
    },
}
