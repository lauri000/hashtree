# Wi-Fi Aware Nearby Sync Plan

Date: March 27, 2026
Scope: Android-first nearby sync for `hashtree-cli` and Iris, with a path to later Apple support

## Goal

Add Wi-Fi Aware in a low-obtrusion way so nearby Android devices can discover each other and sync over a higher-bandwidth local link without depending on BLE for discovery or bulk transfer.

The design should:

- keep transport logic in the daemon, not the app UI
- reuse one Wi-Fi Aware adapter for both small control traffic and future bulk transfer
- start with nearby discovery + root lookup before attempting full blob/tree transfer
- degrade cleanly on unsupported platforms and devices

## Non-Goals

- Do not build a cross-platform Wi-Fi Aware transport in one step.
- Do not make Wi-Fi Aware a required transport for htree.
- Do not reintroduce Bluetooth as the primary nearby path.
- Do not start with full nearby file transfer; start with control-plane wins first.

## Current Seams In The Codebase

The right integration points already exist:

- [`LocalNostrBus`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/local_bus.rs)
  - good fit for nearby signed event broadcast and root queries
- [`MulticastNostrBus`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/multicast.rs)
  - best reference for the first Wi-Fi Aware phase
- [`WebRTCManager::run`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/signaling.rs)
  - where local transports are started and wired into state
- [`WebRTCConfig`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/types.rs)
  - add `wifi_aware` config here
- [`MeshPeer`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/session.rs)
  - only needed once Wi-Fi Aware becomes a real data transport
- Existing Android bridge pattern:
  - [`mobile_bluetooth.rs`](/Users/sirius/src/iris-browser/apps/iris/src-tauri/src/mobile_bluetooth.rs)
  - this should be the reference shape for an Android-only Wi-Fi Aware bridge, not copied verbatim

## Implemented So Far

The daemon-side phase-0/phase-1 scaffold now exists:

- [`WifiAwareConfig`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/wifi_aware.rs)
- [`WifiAwareNostrBus`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/wifi_aware.rs)
- config plumbing in:
  - [`config.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/config.rs)
  - [`p2p_common.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/p2p_common.rs)
  - [`types.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/types.rs)
- local-bus registration and source labeling in [`signaling.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/signaling.rs)

What is still intentionally missing:

- Android plugin / `WifiAwareManager` integration
- real device discovery
- bulk transfer / `PeerTransport::WifiAware`
- any Iris settings UI

So the current code is a tested daemon scaffold, not end-to-end Wi-Fi Aware yet.

## Recommended Architecture

Use one shared Android Wi-Fi Aware runtime, but split it into logical layers:

1. `WifiAwareAdapter`
   - Android-only
   - owns publish/subscribe discovery, attach/session lifecycle, peer registry, capability exchange
   - can expose discovered peers and direct sockets/links to the daemon

2. `WifiAwareNostrBus`
   - daemon-facing
   - implements [`LocalNostrBus`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/local_bus.rs)
   - handles:
     - root announcements
     - root queries
     - small signed mesh hello/control events

3. `WifiAwarePeer`
   - later phase
   - daemon-facing bulk transport
   - plugs into [`MeshPeer`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/session.rs) and `PeerTransport`
   - handles:
     - blob fetch
     - quote/payment messages
     - mesh frame forwarding

This means:

- same adapter/runtime for both Nostr-style control traffic and hashtree transfer
- separate control-plane and data-plane logic
- no single giant protocol for everything

## Delivery Phases

### Phase 0: Config And Capability Plumbing

Add Android-only config for Wi-Fi Aware, default off.

Rust changes:

- add `WifiAwareConfig` to [`types.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/types.rs)
- add `enable_wifi_aware` and `max_wifi_aware_peers` to [`config.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/config.rs)
- map config into `WebRTCConfig`

Acceptance:

- non-Android builds stay unaffected
- Android can report whether Wi-Fi Aware is supported
- feature is hidden behind config, default off

### Phase 1: Nearby Discovery And Root Lookup Bus

Build `WifiAwareNostrBus` first. Do not attempt bulk blob transfer yet.

New Rust files:

- `rust/crates/hashtree-cli/src/webrtc/wifi_aware.rs`
  - Android bridge trait
  - bus implementation
  - peer discovery session state

Rust changes:

- export from [`mod.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/mod.rs)
- start the bus from [`signaling.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/signaling.rs) similarly to multicast
- register it as a `LocalNostrBus`
- use it for:
  - root announcements
  - root queries
  - nearby signed hello/capability events

Android bridge changes:

- new Iris plugin, likely:
  - `../iris-browser/apps/iris/src-tauri/plugins/mobile-wifi-aware/android/...`
  - `../iris-browser/apps/iris/src-tauri/src/mobile_wifi_aware.rs`
- start only on Android when config enables it

Acceptance:

- two nearby Android devices can discover each other over Wi-Fi Aware
- `resolve_root_from_local_buses_with_source()` can succeed via Wi-Fi Aware
- no user-facing UI required beyond one-time permission/feature enablement

### Phase 2: Nearby Nostr Event Transfer

Once Phase 1 works, widen the bus to carry small signed events beyond root lookup.

Use cases:

- root updates
- small relayless Nostr events
- nearby DMs / gift-wrapped messages
- tiny app-level control messages

Rules:

- cap payload size
- prioritize control messages over any future bulk transfer
- keep timeout/retry behavior separate from blob retrieval

Acceptance:

- small signed events can round-trip between Android peers over Wi-Fi Aware
- no dependence on relays for nearby-only event exchange

### Phase 3: Bulk Hashtree Transport

Only after Phases 1-2 are stable, add a real Wi-Fi Aware data peer.

New Rust files:

- `rust/crates/hashtree-cli/src/webrtc/wifi_aware_peer.rs`

Rust changes:

- add `PeerTransport::WifiAware`
- add `PeerSignalPath::WifiAware`
- add `MeshPeer::WifiAware`
- teach request/query codepaths to treat Wi-Fi Aware as a first-class peer transport

Protocol:

- keep the same daemon-side request/response model used by `Peer`
- use a direct socket/stream created from the Android Wi-Fi Aware session
- reuse existing hashtree request framing where practical

Acceptance:

- blob fetch over Wi-Fi Aware works
- root lookup and small control traffic still stay responsive while bulk transfer runs

### Phase 4: Minimal Iris Integration

Keep app integration small.

Suggested Iris behavior:

- Android only
- feature off by default
- one settings toggle at most:
  - `Nearby direct sync (experimental)`
- no Bluetooth-style peer list UX at first
- status can surface under existing mesh diagnostics later

## File-Level Handoff

Likely files to touch:

- [`rust/crates/hashtree-cli/src/webrtc/mod.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/mod.rs)
- [`rust/crates/hashtree-cli/src/webrtc/types.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/types.rs)
- [`rust/crates/hashtree-cli/src/webrtc/signaling.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/signaling.rs)
- [`rust/crates/hashtree-cli/src/config.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/config.rs)
- [`rust/crates/hashtree-cli/src/webrtc/local_bus.rs`](/Users/sirius/src/hashtree/rust/crates/hashtree-cli/src/webrtc/local_bus.rs)
- `rust/crates/hashtree-cli/src/webrtc/wifi_aware.rs`
- `rust/crates/hashtree-cli/src/webrtc/wifi_aware_peer.rs`
- `../iris-browser/apps/iris/src-tauri/src/mobile_wifi_aware.rs`
- `../iris-browser/apps/iris/src-tauri/plugins/mobile-wifi-aware/android/...`
- [`apps/iris/src-tauri/src/lib.rs`](/Users/sirius/src/iris-browser/apps/iris/src-tauri/src/lib.rs)

## Testing Plan

Unit tests:

- bus registration and config defaults
- root query selection via local buses
- Wi-Fi Aware source labeling
- peer transport ordering and timeout behavior once `PeerTransport::WifiAware` exists

Android/device tests:

- support detection
- discovery of nearby peer
- root query succeeds over Wi-Fi Aware with relays disabled
- later: blob fetch over Wi-Fi Aware

Iris automation/e2e:

- Android smoke only
- startup with Wi-Fi Aware enabled should not break normal shell startup
- nearby peer discovery should not affect normal `htree://` navigation when no peer is found

## Open Questions

- Should Wi-Fi Aware peer trust on Android be open-to-discovered-peers, or restricted to app-level known pubkeys?
- Should the first implementation use only signed Nostr envelopes, or also carry a direct daemon protocol channel from day one?
- How should Android-only support be exposed in config without cluttering desktop/mobile UI?
- Do we want Apple support in the same plan, or as a later separate effort after Android proves out?

## Recommendation On BLE Nostr Bus

Short version: maybe, but not as a priority and not as the main nearby path.

BLE likely is sufficient for small Nostr-style traffic:

- root announcements
- root queries
- tiny gift-wrapped DMs
- presence/hello messages

BLE is not a good primary data path for hashtree:

- we already measured poor real throughput in this codebase
- bulk transfer was bad enough to make the user experience unacceptable
- it adds Android permissions, lifecycle complexity, and tricky debugging

Recommendation:

- `Do Wi-Fi Aware first`
- keep BLE out of Iris UI
- only consider a BLE Nostr bus later if:
  - Wi-Fi Aware support is missing on target devices, and
  - we only need tiny nearby event exchange, not file transfer

If BLE returns at all, keep it strictly scoped:

- control-plane only
- payload caps
- no blob/tree transfer
- no expectation of transparent sync of large content

## Bottom Line

The best path is:

1. shared Wi-Fi Aware adapter
2. Wi-Fi Aware local Nostr bus first
3. Wi-Fi Aware bulk transport later
4. BLE only as an optional tiny-message fallback, not as a flagship transport
