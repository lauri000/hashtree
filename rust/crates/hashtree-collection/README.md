# hashtree-collection

Immutable content-addressed collections for hashtree.

This Rust crate provides the core collection pieces that `hashtree-nostr` and
other Rust crates can share today:

- canonical `by-id` roots
- named derived key indexes
- named derived search indexes
- incremental `put` / `delete` updates
- full rebuilds from owned item snapshots
- directory-root read/write helpers
- shared search roots for multiple named views
- contextual derived search entries for related entities

The Rust crate is still intentionally smaller than the TypeScript
`@hashtree/collection` package. It now covers the shared by-id, key-index, and
search-index lifecycle so crates like `hashtree-nostr` can stop hand-rolling
manifest and index maintenance. TS-style federated search helpers and schema
hooks can still be added later if Rust-side needs become concrete.

Part of [hashtree](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree).
