pub use hashtree_network::{
    build_root_filter, pick_latest_event, root_event_from_peer, PeerRootEvent,
};

#[allow(dead_code)]
pub const HASHTREE_KIND: u16 = hashtree_network::HASHTREE_KIND;
#[allow(dead_code)]
pub const HASHTREE_LABEL: &str = hashtree_network::HASHTREE_LABEL;
