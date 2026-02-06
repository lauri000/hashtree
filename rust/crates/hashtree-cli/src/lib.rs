pub mod config;
pub mod daemon;
pub mod fetch;
pub mod nostr_relay;
pub mod server;
pub mod storage;
pub mod sync;

#[cfg(feature = "p2p")]
pub mod webrtc;
#[cfg(not(feature = "p2p"))]
pub mod webrtc_stub;
#[cfg(not(feature = "p2p"))]
pub use webrtc_stub as webrtc;

#[cfg(feature = "nostrdb")]
pub mod nostrdb_integration;
#[cfg(not(feature = "nostrdb"))]
pub mod nostrdb_stub;
#[cfg(feature = "nostrdb")]
pub use nostrdb_integration as socialgraph;
#[cfg(not(feature = "nostrdb"))]
pub use nostrdb_stub as socialgraph;

pub use config::Config;
pub use fetch::{FetchConfig, Fetcher};
pub use hashtree_resolver::nostr::{NostrResolverConfig, NostrRootResolver};
pub use hashtree_resolver::{
    Keys as NostrKeys, ResolverEntry, ResolverError, RootResolver, ToBech32 as NostrToBech32,
};
pub use server::HashtreeServer;
pub use storage::{
    CachedRoot, HashtreeStore, StorageByPriority, TreeMeta, PRIORITY_FOLLOWED, PRIORITY_OTHER,
    PRIORITY_OWN,
};
pub use sync::{BackgroundSync, SyncConfig, SyncPriority, SyncStatus, SyncTask};
pub use webrtc::{ConnectionState, WebRTCState};
#[cfg(feature = "p2p")]
pub use webrtc::{
    ContentStore, DataMessage, PeerClassifier, PeerId, PeerPool, PoolConfig, PoolSettings,
    WebRTCConfig, WebRTCManager,
};
