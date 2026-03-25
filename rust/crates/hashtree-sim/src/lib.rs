//! Simulation tools for hashtree P2P protocols
//!
//! Provides simulation and router tests using the same code as production transports.
//!
//! ## Architecture
//!
//! - `webrtc_sim::Simulation` - uses GenericStore with mock transports
//! - Shared router tests - exercise the production signaling/router core directly
//! - `WsRelay` - WebSocket Nostr relay for integration testing

pub mod cashu_test_mint;
pub mod mint_client;
#[cfg(feature = "nostr")]
pub mod nostr_mesh;
pub mod webrtc_sim;
pub mod ws_relay;

// Re-export main types from webrtc_sim
pub use cashu_test_mint::{
    ChannelSettlement, ChannelState, LocalTestCashuMint, MintError, MintStats,
};
pub use mint_client::{LocalMintClient, MintClient};
#[cfg(feature = "nostr")]
pub use nostr_mesh::NostrMesh;
pub use webrtc_sim::{
    run_parameter_sweep, CashuIncentiveConfig, LocalResourceStats, NodeStrategyProfile,
    RetrievalStats, RetrievalTimingMode, SimConfig, SimEvent, SimStats, Simulation, SweepResult,
    TopologyStats,
};
pub use ws_relay::WsRelay;

// Re-export types from hashtree-webrtc for convenience
pub use hashtree_webrtc::{
    PoolConfig, PoolSettings, RequestDispatchConfig, ResponseBehaviorConfig, SelectionStrategy,
    SignalingMessage,
};

// Re-export hashtree types for convenience
pub use hashtree_core::{Cid, HashTree, HashTreeConfig, MemoryStore, Store};
