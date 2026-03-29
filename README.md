# hashtree

Content-addressed storage, git transport, and app runtime on Nostr. Merkle roots can be published to get mutable `npub/tree/path` addresses. Data is chunked, CHK-encrypted by default, and can be fetched from Blossom-compatible storage, peers over WebRTC, or a local daemon.

## Current status

- The core storage format, CHK encryption, CLI/daemon, and `git-remote-htree` are implemented and used across the Rust and TypeScript stacks.
- `apps/iris` is the current native desktop shell. It embeds the htree daemon, loads `htree://` apps in isolated child webviews, and supports NIP-07 injection for compatible apps.
- `apps/iris-files` is the main portable web-app workspace for files, git, video, docs, maps, boards, and related release tooling.
- `apps/iris-sites` is the isolated web runtime for serving `htree://` sites in the browser.
- `apps/hashtree-cc` is the landing page and file-sharing app.
- Packaging is still uneven: Cargo installs and release tarballs work today; Homebrew and `apt` style packaging are still pending.
- The protocol is implemented, but the written spec is still a draft and nearby Bluetooth/Wi-Fi sync work is still in progress.

## Repository layout

- `rust/` - Rust CLI/daemon, git remote helper, and core crates. See [`rust/README.md`](rust/README.md).
- `ts/` - TypeScript/JavaScript SDK packages. See [`ts/README.md`](ts/README.md).
- `apps/iris/` - Native desktop shell built with Tauri. See [`apps/iris/README.md`](apps/iris/README.md).
- `apps/iris-files/` - Main web-app workspace and release tooling. See [`apps/iris-files/README.md`](apps/iris-files/README.md).
- `apps/iris-sites/` - Isolated runtime for portable `htree://` sites.
- `apps/hashtree-cc/` - Landing page and file sharing app. See [`apps/hashtree-cc/README.md`](apps/hashtree-cc/README.md).

## Canonical remote

Hashtree is the canonical remote for this repository:

- `origin = htree://self/hashtree`
- `github = git@github.com:mmalmi/hashtree.git`

## Design highlights

- SHA256 hashing
- Deterministic MessagePack encoding for tree nodes
- CHK encryption by default (hash + key in CIDs)
- Simple storage interface: `get(hash) -> bytes`, `put(hash, bytes)`
- 2MB chunks optimized for Blossom uploads
- Nostr-published roots for mutable addresses
- WebRTC fetches with Blossom fallback

## Installation

### Cargo (supported today)

```bash
# CLI + daemon + git helper + Cashu helper
cargo install hashtree-cli git-remote-htree hashtree-cashu-cli

# Minimal install without P2P/WebRTC/Cashu/git helper (smaller binary)
cargo install hashtree-cli --no-default-features
```

### Local install from this repo

```bash
cargo install --path rust/crates/hashtree-cli
cargo install --path rust/crates/git-remote-htree
cargo install --path rust/crates/hashtree-cashu-cli
```

### Packaging status

- CLI release artifacts are assembled under `rust/dist/` and published with `rust/scripts/release_to_htree.sh`.
- Iris native release artifacts are assembled under `dist/iris-native/`.
- Homebrew and Linux package-manager installs are not shipped yet.

## Getting started

- CLI + daemon + git remote: follow [`rust/README.md`](rust/README.md)
- JS SDK packages: follow [`ts/README.md`](ts/README.md)
- Native desktop shell: follow [`apps/iris/README.md`](apps/iris/README.md)
- Portable web apps and release flows: follow [`apps/iris-files/README.md`](apps/iris-files/README.md)

## Site Releases

- Release all Cloudflare/hashtree static sites with `node ./scripts/release-sites.mjs`
- Release only the Iris sites with `node ./apps/iris-files/scripts/release-site.mjs all`
- Release only hashtree.cc with `node ./apps/hashtree-cc/scripts/release-site.mjs`

## Mobile FFI (optional)

- FFI crate: [`rust/crates/hashtree-ffi`](rust/crates/hashtree-ffi) (UniFFI bindings for attachment operations)
- Native Rust apps should usually use `hashtree-core`/`hashtree-blossom` directly
- Mobile/Flutter apps can build `hashtree-ffi` and generate Kotlin/Swift bindings with UniFFI

## Protocol spec

- [`docs/HTS-01.md`](docs/HTS-01.md) - hashtree core protocol (draft)

## License

MIT
