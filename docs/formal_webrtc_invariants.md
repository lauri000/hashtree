# Formal WebRTC Invariants

## Scope
This document defines formal-style invariants for WebRTC forwarding, reassembly, and peer selection.

Code scope:
- `rust/crates/hashtree-webrtc/src/types.rs`
- `rust/crates/hashtree-webrtc/src/peer.rs`
- `rust/crates/hashtree-webrtc/src/peer_selector.rs`

## Invariants
- `HT-WEBRTC-001`: HTL is monotonic non-increasing per hop, and requests with `htl=0` are not forwarded.
- `HT-WEBRTC-002`: Fragment reassembly outputs payload only when all fragments `[0..n-1]` are present exactly once.
- `HT-WEBRTC-003`: Backoff/fairness rules constrain peer ordering and avoid selecting only backed-off peers when alternatives exist.
- `HT-WEBRTC-004`: Pending reassembly state is bounded and cleared on completion.

## Safety Rules
- Never increase HTL during forwarding.
- Preserve deterministic fragment ordering during reassembly.
- Prefer non-backed-off peers; use backed-off peers only as fallback.
- Ensure completed reassemblies are removed from pending state.

## Test Strategy
- Deterministic tests in:
  - `rust/crates/hashtree-webrtc/tests/formal_webrtc_props.rs`
  - unit tests in `rust/crates/hashtree-webrtc/src/peer.rs` for private reassembly logic.
- No network dependencies for formal invariants.

## CI
- Planned CI job name: `webrtc-formal`.
- Initially advisory, promoted to hard gate after stabilization.
