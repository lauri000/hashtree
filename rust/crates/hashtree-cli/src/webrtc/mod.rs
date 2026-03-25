//! Native peer-to-peer connectivity for hashtree data exchange
//!
//! Uses Nostr relays for signaling with the same protocol as iris-client:
//! - Event kind: 30078 (KIND_APP_DATA)
//! - Tag: ["l", "webrtc"]
//! - Message types: hello, offer, answer, candidate

mod bluetooth;
mod cashu;
mod local_bus;
mod multicast;
mod peer;
mod root_events;
mod signaling;
pub mod types;

#[cfg(test)]
mod tests;

pub use bluetooth::{BluetoothBackendState, BluetoothConfig, BluetoothMesh};
pub use cashu::{cashu_mint_metadata_path, CashuMintMetadataStore, CashuRoutingConfig};
pub use local_bus::{LocalNostrBus, SharedLocalNostrBus};
pub use multicast::{MulticastConfig, MulticastNostrBus};
pub use peer::{ContentStore, Peer, PendingRequest};
pub use root_events::PeerRootEvent;
pub(crate) use root_events::{build_root_filter, pick_latest_event, root_event_from_peer};
pub use signaling::{
    ConnectionState, PeerClassifier, PeerEntry, PeerRouter, PeerRouterState, PeerSignalPath,
    PeerTransport, WebRTCManager, WebRTCState,
};
pub use types::{
    encode_request, DataMessage, DataRequest, PeerDirection, PeerId, PeerPool, PeerRouterConfig,
    PoolConfig, PoolSettings, RequestDispatchConfig, SelectionStrategy, SignalingMessage,
    WebRTCConfig, MAX_HTL,
};
