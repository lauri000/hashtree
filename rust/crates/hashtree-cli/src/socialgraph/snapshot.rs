use anyhow::Result;
use bytes::Bytes;
pub use nostr_social_graph::BinaryBudget as SnapshotOptions;

use super::SocialGraphBackend;

pub fn build_snapshot_chunks(
    ndb: &(impl SocialGraphBackend + ?Sized),
    root: &[u8; 32],
    options: &SnapshotOptions,
) -> Result<Vec<Bytes>> {
    ndb.snapshot_chunks(root, options)
}
