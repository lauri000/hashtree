//! WebRTC peer-to-peer connectivity for hashtree data exchange
//!
//! Uses Nostr relays for signaling with the same protocol as iris-client:
//! - Event kind: 30078 (KIND_APP_DATA)
//! - Tag: ["l", "webrtc"]
//! - Message types: hello, offer, answer, candidate

mod cashu;
mod peer;
mod signaling;
pub mod types;

#[cfg(test)]
mod tests;

pub use cashu::CashuRoutingConfig;
pub use peer::{ContentStore, Peer, PendingRequest};
pub use signaling::{ConnectionState, PeerClassifier, PeerEntry, WebRTCManager, WebRTCState};
pub use types::{
    encode_request, DataMessage, DataRequest, PeerDirection, PeerId, PeerPool, PoolConfig,
    PoolSettings, RequestDispatchConfig, SelectionStrategy, SignalingMessage, WebRTCConfig,
    MAX_HTL,
};
