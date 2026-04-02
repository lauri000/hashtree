# Changelog

## 0.2.21 - 2026-04-02

Changes since the `0.2.20` crates.io release.

### Improved

- Improved `htree mount` ergonomics: FUSE now ships in the default `hashtree-cli` build, `htree mount` can derive a mountpoint from the target automatically, and owner aliases or hex pubkeys are normalized to `npub` targets before resolution.
- Debounced mounted-root publishing and preserved sibling entries when mounting a published subdirectory, which reduces redundant Nostr publishes without clobbering the rest of the published tree.
- Grouped the top-level `htree help` output by command category so storage, publishing, identity, and wallet flows are easier to discover.

### Fixed

- Fixed the FUSE adapter for current `fuser` callback signatures so mkdir, unlink, rmdir, rename, and write operations dispatch cleanly on newer builds.
- Fixed the embedded daemon and mount publish path to keep default Blossom read-server behavior and related integration coverage intact after the FUSE follow-up changes.

## 0.2.20 - 2026-04-01

Changes since the `0.2.18` crates.io release.

### Improved

- Extracted the shared mesh routing core into the Rust networking crates and aligned the CLI, simulation, and TypeScript interop paths around the same signaling model.
- Improved `git-remote-htree` and `hashtree-cli` pull-request interoperability, including better published-repo handling and PR listing coverage.
- Improved Iris release defaults on supported platforms so Bluetooth-enabled builds and app release packaging behave more consistently.

### Fixed

- Fixed Iris Android release networking and Zapstore publishing regressions that were blocking the release pipeline.
- Fixed several mobile Bluetooth startup and interoperability issues across the Rust networking stack.

## 0.2.18 - 2026-03-31

Changes since the `0.2.17` crates.io release.

### Improved

- Unified the shared mesh signaling path across `hashtree-cli`, `hashtree-sim`, and the TypeScript interop tests, so production and simulation now exercise the same router-layer protocol and hedged retrieval scheduling.
- Renamed the reusable networking crate from `hashtree-webrtc` to `hashtree-network`, which better matches its scope: mesh routing, signaling, peer links, and store composition rather than just transport bindings.

### Fixed

- Fixed Rust ignored integration and doctest coverage so the full workspace, including network-gated tests and cross-language WebRTC checks, passes from the merged `master` tip.

## 0.2.17 - 2026-03-31

Changes since the `0.2.16` crates.io release.

### Fixed

- Fixed GitHub CI by refreshing the shared TypeScript lockfile and removing lint failures that had started failing the `ts` workflow.
- Fixed GitHub Iris desktop release builds by removing the cross-app `apps/iris` import on `iris-files` source-only TypeScript config and assets.
- Fixed flaky Rust workspace failures in multicast root queries and embedded daemon integration tests, so the GitHub Rust and release workflows complete reliably.

## 0.2.16 - 2026-03-31

Changes since the `0.2.15` crates.io release.

### Improved

- Unified slash-containing mutable tree paths across the Rust server, service-worker-facing helpers, and release publishing flow, so repo releases and encoded `htree` paths resolve consistently.
- Improved embedded daemon and background Nostr service behavior with cleaner shutdown, better default Blossom fallback handling, and broader profile-index/social-graph coverage.
- Improved the native Iris shell transport stack with more robust Bluetooth session handling, origin-isolated `htree` child webviews, and tighter user-facing deep-link/PWA path handling.

### Fixed

- Fixed release publishing defaults to use repo-scoped `releases/<repo>` trees and removed the obsolete standalone `hashtree-nostr-bridge` crate by merging its crawler into `hashtree-nostr`.
- Fixed Rust test hangs caused by embedded daemon background services outliving Tokio runtime shutdown.

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
