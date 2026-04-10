# Changelog

## Unreleased

Pending npm version bump:

- `@hashtree/collection@0.1.1`
- `@hashtree/nostr@0.1.7`

### Added

- Added `CollectionSource.count()` and `CollectionSource.queryById(...)` so callers can enumerate `by-id` entries and perform prefix-limited ID queries without reading internal index objects directly.
- Added shared `.collection-manifest.json` helpers in `@hashtree/collection` so collection roots can publish and reload `schemaVersion`, item/projection formats, and optional schema references in a cross-runtime format.
- Added `@hashtree/nostr` event-root publication of the shared collection manifest metadata plus TS/Rust interop coverage that compares the actual published metadata payloads.

## 0.1.22 - 2026-04-10

Changes since the previous npm package publish.

### Fixed

- Fixed `@hashtree/worker` root watches to start immediately instead of blocking client startup on the first relay resolution, and emit the first resolved root through the normal update channel when it arrives.
- Fixed the published `@hashtree/worker` package manifest to depend on released `@hashtree/*` versions instead of leaking `workspace:*` ranges to npm consumers.

### Improved

- Improved `@hashtree/worker/client` root-watch behavior so delayed initial roots no longer produce a synthetic `null` callback before the first real update.

## 0.1.20 - 2026-04-10

Changes since the previous npm package publish.

### Added

- Added `createHtreeRuntime(...)` plus runtime URL helpers so Iris-compatible apps can consistently resolve the active htree, relay, and Blossom endpoints and generate `/htree/...` request URLs with per-client scoping.
- Added worker diagnostics events and client listeners so apps can observe runtime/media issues without scraping console output.

### Improved

- Improved `@hashtree/worker` Blossom reads by deduplicating concurrent fetches for the same hash and limiting cross-hash read concurrency.
- Updated the package documentation to show the intended worker bootstrap and Iris-compatible runtime pattern.

### Changed

- Removed `wss://offchain.pub` from the default relay fallback lists used by root resolution and Iris tree-root subscriptions.

## 0.1.11 - 2026-04-01

Changes since the previous npm package publish.

### Improved

- Added the `@hashtree/worker/client` export and moved `ndk`, `ndk-cache`, and `nostr-social-graph` to optional peer dependencies so apps can provide those integrations explicitly.

### Fixed

- Fixed Blossom reads in `@hashtree/worker` to fetch the hashed `.bin` payload directly, verify it, and treat the cache write as a trusted backfill instead of blocking the response path.
- Fixed media file streaming in `@hashtree/worker` to resolve requested subpaths before streaming and to clone transferred chunk buffers so browsers do not trip over detached `ArrayBuffer` state.
