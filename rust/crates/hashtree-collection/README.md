# hashtree-collection

Immutable content-addressed collections for hashtree.

This Rust crate provides the core collection pieces that `hashtree-nostr` and
other Rust crates can share today:

- canonical `by-id` roots
- named derived key indexes
- named derived search indexes
- optional schema defaults, normalization, validation, and migration hooks
- incremental `put` / `delete` updates
- full rebuilds and explicit reindexing from owned item snapshots
- directory-root read/write helpers
- federated search across many collection sources
- shared search roots for multiple named views
- contextual derived search entries for related entities

`reindex` is the public "rebuild everything from canonical items" entrypoint. It
is useful when you add a new derived index or change derivation rules, but it
still requires caller-supplied item snapshots and their CIDs. Collection roots
alone are not enough to regenerate new indexes.

The Rust crate now covers the same core lifecycle as the TypeScript
`@hashtree/collection` package: collection roots, derived indexes, schema
hooks, and federated search helpers. It still stays focused on immutable
collection/index mechanics rather than trying to become a general-purpose
database layer.

Published collection roots can include a reserved
`.collection-manifest.json` file for small declarative metadata that peers can
inspect directly. The JSON shape matches the TypeScript package and currently
includes:

- `schemaVersion`
- `publishedSchema.itemFormat`
- `publishedSchema.projectionFormat`
- optional `publishedSchema.schemaRef`

Index names are expected to be reasonably self-descriptive, so this metadata
does not add a separate per-index description layer by default.

Part of [hashtree](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree).
