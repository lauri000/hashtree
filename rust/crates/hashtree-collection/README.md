# hashtree-collection

Immutable content-addressed collections for hashtree.

This Rust crate provides the core collection pieces that `hashtree-nostr` and
other Rust crates can share today:

- canonical `by-id` roots
- named derived key indexes
- incremental `put` / `delete` updates
- full rebuilds from owned item snapshots
- directory-root read/write helpers

The initial Rust scope is intentionally smaller than the TypeScript
`@hashtree/collection` package. It focuses on the shared by-id and key-index
layer first, so crates like `hashtree-nostr` can stop hand-rolling manifest and
index maintenance. Search indexes and richer manifests can be added on top as
Rust-side needs become concrete.

Part of [hashtree](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree).
