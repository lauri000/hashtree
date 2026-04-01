# hashtree

Content-addressed storage, git transport, and app runtime on Nostr. Merkle roots can be published to get mutable `npub/tree/path` addresses. Data is chunked, CHK-encrypted by default, and can be fetched from Blossom-compatible storage, peers over WebRTC, or a local daemon.

## Installation

### Quick install (prebuilt binaries, macOS/Linux)

```bash
curl -fsSL https://upload.iris.to/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/releases%2Fhashtree/latest/install.sh | sh
```

That installs `htree`, `htree-cashu`, and `git-remote-htree` into `~/.local/bin` by default. For a system-wide install, pass a target directory, for example `sh -s -- /usr/local/bin`.

Windows note: the shell bootstrap is not supported there. Download the latest `hashtree-x86_64-pc-windows-msvc.zip` release asset, extract it, and add `htree.exe`, `htree-cashu.exe`, and `git-remote-htree.exe` to your PATH.

### Build from source

Install Rust first if needed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

```bash
# Git helper only (enables git clone/pull/push for htree:// URLs)
cargo install git-remote-htree

# CLI + daemon + mount support (default; requires system FUSE libraries)
cargo install hashtree-cli

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

### Homebrew

```bash
brew tap sirius/hashtree https://upload.iris.to/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/homebrew-hashtree.git
brew install htree
```

That installs `htree`, `htree-cashu`, and `git-remote-htree`. After tapping, `brew install hashtree` also works via the alias.

### Packaging status

- `./publish_release.sh --version v<version>` is the primary release entrypoint. It publishes the canonical hashtree release, updates the Homebrew tap when the full macOS/Linux CLI set is present, and mirrors the same staged files to GitHub.
- CLI release artifacts are assembled under `rust/dist/` by `rust/scripts/release_to_htree.sh`, which `./publish_release.sh` wraps.
- When a sibling `../iris-browser` checkout is available locally, the same release flow can also stage Iris desktop installers from that repo.
- Iris native release artifacts are assembled under `dist/iris-native/`.
- Linux package-manager installs beyond Homebrew are not shipped yet.

## Current status

- The core storage format, CHK encryption, CLI/daemon, and `git-remote-htree` are implemented and used across the Rust and TypeScript stacks.
- The standalone app repos now live alongside this repo: `../iris-browser`, `../iris-apps`, and `../hashtree-cc`.
- Packaging is still uneven: Cargo installs, release tarballs, and the Homebrew tap work today; `apt` style packaging is still pending.
- The protocol is implemented, but the written spec is still a draft and nearby Bluetooth/Wi-Fi sync work is still in progress.

## Repository layout

- `rust/` - Rust CLI/daemon, git remote helper, and core crates. See [`rust/README.md`](rust/README.md).
- `ts/` - TypeScript/JavaScript SDK packages. See [`ts/README.md`](ts/README.md).
- Sibling repos:
  - `../iris-browser/` - Native desktop shell built with Tauri.
  - `../iris-apps/` - Portable Iris web apps and the isolated site runtime.
  - `../hashtree-cc/` - Landing page and file sharing app.

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

## Getting started

- CLI + daemon + git remote: follow [`rust/README.md`](rust/README.md)
- JS SDK packages: follow [`ts/README.md`](ts/README.md)
- Native desktop shell: follow the sibling `../iris-browser` repo
- Portable web apps and release flows: follow the sibling `../iris-apps` repo

## Site Releases

- Release all Cloudflare/hashtree static sites with `node ./scripts/release-sites.mjs`
- `scripts/release-sites.mjs` expects sibling `../iris-apps` and `../hashtree-cc` checkouts unless `IRIS_APPS_REPO_ROOT` and `HASHTREE_CC_REPO_ROOT` override them

## Mobile FFI (optional)

- FFI crate: [`rust/crates/hashtree-ffi`](rust/crates/hashtree-ffi) (UniFFI bindings for attachment operations)
- Native Rust apps should usually use `hashtree-core`/`hashtree-blossom` directly
- Mobile/Flutter apps can build `hashtree-ffi` and generate Kotlin/Swift bindings with UniFFI

## Protocol spec

- [`docs/HTS-01.md`](docs/HTS-01.md) - hashtree core protocol (draft)
- [`docs/URL-ENCODING.md`](docs/URL-ENCODING.md) - concise routing rules for slash-containing tree names

## License

MIT
