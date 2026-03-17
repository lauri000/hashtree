# hashtree-nostr

Hashtree-native Nostr event indexes for Rust.

This crate stores signed Nostr events as deterministic content-addressed blobs
and maintains thin B-tree indexes for lookups like:

- `event_id -> event blob`
- author/time scans
- author/kind/time scans
- replaceable and parameterized-replaceable event winners

The layout is kept interoperable with the TypeScript `@hashtree/nostr`
implementation.

Part of [hashtree](https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree).
