# hashtree

Content-addressed filesystem on Nostr. Merkle roots can be published to get mutable `npub/tree/path` addresses. Data is chunked, optionally encrypted by default (CHK), and works with Blossom-compatible storage and WebRTC fetches.

## Implementations

- `ts/` - TypeScript/JavaScript SDKs and web apps (Iris Files + Iris Video). See [`ts/README.md`](ts/README.md).
- `rust/` - Rust CLI/daemon, git remote helper, and crates. See [`rust/README.md`](rust/README.md).

## Design highlights

- SHA256 hashing
- Deterministic MessagePack encoding for tree nodes
- CHK encryption by default (hash + key in CIDs)
- Simple storage interface: `get(hash) -> bytes`, `put(hash, bytes)`
- 2MB chunks optimized for Blossom uploads
- Nostr-published roots for mutable addresses
- WebRTC fetches with Blossom fallback

## Getting started

- Web app + JS SDK: follow [`ts/README.md`](ts/README.md)
- CLI + daemon + git remote: follow [`rust/README.md`](rust/README.md)

## License

MIT
