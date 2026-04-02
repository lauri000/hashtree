# Changelog

## Unreleased

No published-package changes have landed since `@hashtree/worker@0.1.11` on 2026-04-01, so there is no pending npm version bump right now.

## 0.1.11 - 2026-04-01

Changes since the previous npm package publish.

### Improved

- Added the `@hashtree/worker/client` export and moved `ndk`, `ndk-cache`, and `nostr-social-graph` to optional peer dependencies so apps can provide those integrations explicitly.

### Fixed

- Fixed Blossom reads in `@hashtree/worker` to fetch the hashed `.bin` payload directly, verify it, and treat the cache write as a trusted backfill instead of blocking the response path.
- Fixed media file streaming in `@hashtree/worker` to resolve requested subpaths before streaming and to clone transferred chunk buffers so browsers do not trip over detached `ArrayBuffer` state.
