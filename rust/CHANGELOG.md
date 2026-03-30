# Changelog

## 0.2.15 - 2026-03-31

Changes since the `0.2.14` crates.io release.

### Added

- Added signed tree snapshot permalinks in the Nostr stack, giving published trees a stable signed snapshot path for linking and sharing.
- Added the `cashu-service` crate to carry the shared Cashu helper and wallet primitives used by `htree` and `htree-cashu`.
- Added dumb-HTTP Git metadata export in `git-remote-htree`, so static HTTP gateways can serve cloneable taps and repositories from published `.git` trees.

### Improved

- Bulk-built Nostr event indexes and improved steady-state ingest behavior in `hashtree-nostr`, reducing indexing overhead on larger relay or mirror workloads.
- Expanded social-graph tooling in `htree` with profile-index rebuild support and author allowlist URL input for indexing jobs.
- Restored Bluetooth/Nostr publish receipts, capped receipt logs, and cleaned up BLE polling and routing behavior in the daemon transport path.
- Automated Homebrew tap publication from the Rust release flow, with an explicit opt-in path for chaining crates.io publishing from the same release command.

## 0.2.14 - 2026-03-28

Changes since the `0.2.13` crates.io release.

### Added

- Added the new `hashtree-merge` crate with deterministic path-based merge primitives and wired it into the publish chain.
- Added `htree repos` and improved repo listing/source-link handling for hashtree-first repositories.
- Added offline LAN multicast signaling, Bluetooth mesh transport work, Wi-Fi Aware nearby-bus scaffolding, and transport usage tracking in the daemon/CLI stack.

### Improved

- Switched the local Nostr relay to B-tree-backed event indexes, split trusted public and ambient indexes, and added faster planning for `ids`, authors, kinds, replaceables, parameterized replaceables, and tag queries.
- Improved Nostr relay correctness coverage for filter matching, limits, `COUNT`, replaceables, `since`/`until`, and search behavior.
- Batched Nostr ingest writes through buffered store flushes and LMDB batch commits, substantially reducing publish-side write amplification.
- Improved cold root resolution, daemon root handling, filesystem blob sharding, and LMDB quota/default-store behavior.
- Tightened git publish ordering so roots are published after blob upload and improved progress/reporting in `git-remote-htree`.

### Fixed

- Fixed publish blockers in the Rust crate graph and aligned published repository/homepage links with the current hashtree remote.
- Fixed several Bluetooth/native relay startup and htree loading issues in the Rust networking stack.
- Fixed Nostr manifest/index handling around by-id compatibility transitions and relay query edge cases found by the new tests.
