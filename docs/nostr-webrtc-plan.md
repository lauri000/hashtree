# Plan: Nostr Over WebRTC For HTree Daemons

## Goals
- Let htree daemons exchange Nostr events directly over WebRTC data channels (relay-free path for p2p).
- Provide npub/path resolution over the WebRTC channel (not just via relays).
- Reduce spam risk when peering with unknown nodes.
- Keep local storage bounded (default 10 GB) with automatic pruning.
- Support NDR (nostr-double-ratchet) for private messaging over p2p links.
- Add simulation coverage for Nostr-over-p2p behavior alongside hash lookup simulation.

## Progress (as of 2026-01-30)
### Done
- Consolidated `/ws` (removed `/ws/data`) while keeping existing TS JSON + msgpack hashtree interop intact.
- Implemented `/htree` routes for nhash/npub with range requests, thumbnail lookup, and JSON directory listings.
- Added Nostr relay core: trusted storage + spambox (memory fallback), REQ/COUNT querying, OK/EOSE responses, and subscription broadcasting.
- WebRTC data-channel Nostr support using standard NIP-01 JSON framing (same as `/ws`).
- Configurable nostrdb size limits (trusted + spambox) via config.

### In progress
- NDR integration (session bootstrap + message framing).
- hashtree-sim Nostr scenarios.

### Next
- Spambox promotion/scoring + persistence tuning (LRU/TTL).
- NDR handshake + storage separation.
- hashtree-sim Nostr scenarios (p2p/hybrid/spam/partition).

## Non-goals (for now)
- DNS-based identity (no NIP-05 usage).
- Building a full replacement for public relays; relays remain a fallback.
- Perfect Sybil resistance; we focus on pragmatic abuse containment.

## Architecture Overview
### Components
- **WebRTC Transport**: ICE + data channels for p2p; multiplex logical channels (control, nostr, ndr).
- **Nostr P2P Relay Layer**: a relay-compatible loop on each node that speaks standard Nostr messages over WebRTC.
- **Resolver via Nostr Events**: use existing resolver events (no new protocol) so `npub/tree/path` resolution works over p2p.
- **Spam Guard**: admission control, rate limits, scoring, and a "spambox" storage tier.
- **Storage Manager**: dual nostrdb instances (trusted vs spambox) with size caps and pruning.
- **NDR Service**: double-ratchet sessions negotiated over WebRTC (or bootstrap via relays).
- **Simulation Harness**: hashtree-sim extended to model Nostr traffic, spam, and trust propagation.
- **WebSocket Gateway**: `/ws` endpoint that serves a Nostr relay plus hashtree hash send/req (no `/ws/data`).
- **Daemon HTTP Surface**: `/htree/nhash...` and `/htree/npub/...` routes to match iris-files SW/Tauri expectations.
- **Shared Protocol Layer**: common framing for WebRTC + WebSocket to maximize code reuse while preserving existing TS WebSocket interop.

## Nostr Over WebRTC: Protocol Sketch
### Session Bootstrap
- **WebRTC handshake** for transport; once open, exchange a signed hello with:
  - `pubkey`, `supported_protocols`, `node_id`, and a short-lived session ID.
  - Challenge/response signature for freshness (similar to NIP-42 semantics without a relay).
- **Rate limits** for unknown peers to reduce spam on first contact (no PoW).
- **Unordered channels** by default for data/event transport (stateless frames; ordering not critical).

### Event Transport
- Speak **Nostr relay protocol** as closely as possible over WebRTC:
  - Preserve NIP-01 message arrays and direction-specific semantics.
  - `REQ` (client->relay), `EVENT` (client->relay), `CLOSE` (client->relay).
  - `EVENT` (relay->client), `EOSE` (relay->client), `NOTICE` (relay->client).
  - Support `AUTH`/`OK` where required by existing relay logic.
  - Batch mode for efficiency (small frames that fit MTU).
- Maintain **per-peer filter quotas** and **per-peer event quotas** to prevent abuse.
- Prefer **deduplicated caching** by event ID to avoid reprocessing repeats.

## Resolver Over Nostr Events (No New Protocol)
- Use existing resolver events for `npub/tree/path` resolution.
- Allow resolver queries and responses to flow over WebRTC using standard Nostr `REQ`/`EVENT`.
- Cache resolver results with TTL; prefer trusted peers when multiple answers exist.

## `/ws` Endpoint: Nostr Relay + HashTree Protocol
- Provide a single WebSocket endpoint (`/ws`) that serves:
  - Standard Nostr relay protocol (NIP-01 message arrays).
  - HashTree messages for send/req by hash (namespaced message types).
- Keep hashtree message types distinct to avoid collisions (e.g., `HTREE_REQ`, `HTREE_SEND`).
- Preserve **existing TS WebSocket JSON protocol** for compatibility; add msgpack/WebRTC framing as an optional path.
- TS side may not have full Nostr relay capability yet; the endpoint must be backward-compatible and non-breaking.

## `/htree` HTTP Routes (daemon as backend)
- Implement daemon routes to match iris-files SW/worker + Tauri usage:
  - `/htree/test` (HEAD/GET) for local probe.
  - `/htree/nhash1...[/path]` (immutable): decode nhash, serve file or JSON directory listing.
  - `/htree/npub1.../<treeName>[/path]` (mutable): resolve via Nostr, apply `?k=` link key if present, serve file or JSON directory listing.
- Path rules:
  - If nhash resolves to file, suffix is filename hint only.
  - If nhash resolves to dir, use suffix to resolve file; if no suffix, return JSON listing.
  - For `thumbnail` suffix under npub trees, map to first matching thumbnail file.

## Spam Prevention + Trust Policy
### Admission Control
- **Warm path**: known contacts / social-graph neighbors get full privileges.
- **Cold path**: unknown peers get a low quota and spambox storage only.
- **Rate limiting**: per-peer and global; bursts allowed but capped.
- **Validation**: use nostrdb signature verification by default; only skip on explicit import/rehydration paths.

### Scoring
- Score peers by:
  - Social graph proximity (follow distance).
  - Signed interactions over time (stable session history).
  - Event validity ratio (invalid signatures == negative score).
- Promote from spambox to trusted only when score exceeds threshold.

### Spambox Storage
- Use a **separate nostrdb instance** for untrusted data (default):
  - Smaller size cap (e.g., 0.5-1 GB by default).
  - Aggressive TTL (hours/days) and LRU eviction.
  - No propagation to other peers unless promoted.
- Optional: in-memory-only spambox for ephemeral nodes.

## Storage Limits + Pruning (Default 10 GB)
### Strategy
- Split storage into **trusted** and **spambox**.
- Enforce **global ceiling** (e.g., 10 GB total) via:
  - Periodic size checks (timer) and size checks after batches.
  - Priority-based pruning: delete lowest-score and oldest data first.
  - Separate caps and retention policies per data class (events, profiles, resolver cache).

### Implementation Notes
- Add a background job:
  - Compute on-disk size, per-namespace size, and recent access stats.
  - Apply LRU + TTL policy; keep a small reserved "hot set".
- Keep **bounded indices** for social graph and resolver cache.

## NDR Integration
- Use NDR over WebRTC as the preferred **private messaging channel**.
- Bootstrap ratchet sessions with:
  - In-band NDR handshake frames over WebRTC, or
  - Fallback to relay-based rendezvous for first contact.
- Store NDR state separately from nostrdb (small, encrypted, prunable).

## Relay Interop
- Keep relays as a fallback path for discovery and initial contact.
- Allow "relay-bridged" events to be imported into trusted storage if they pass validation.
- Avoid NIP-05; use only pubkey-based addressing.

## Simulation Plan (hashtree-sim)
### Add Scenarios
- **Direct p2p**: few peers with WebRTC only, no relays.
- **Hybrid**: mix relays + WebRTC, test resolver convergence.
- **Spam**: many unknown peers, varying rate limits, spambox behavior.
- **Partition**: network splits and merge to test dedupe/consistency.

### Metrics
- Resolver hit rate, time-to-first-resolve, spam drop rate.
- Storage growth over time, time to prune, hottest data retention.
- Message latency and reconnection behavior.

## Implementation Phases
1) **Protocol skeleton**: WebRTC Nostr relay framing (NIP-01 compatible) + `/ws` endpoint + hash send/req + shared framing across WebRTC/WS (back-compat).
2) **Trust + spambox**: dual nostrdb instances, scoring, quotas, pruning.
3) **NDR + simulation**: NDR handshake over p2p; add nostr scenarios to hashtree-sim.

## Open Questions
- What exact on-wire framing should we use for REQ/EVENT/EOSE over WebRTC?
- How do we handle client-vs-relay message format differences on the p2p channel?
- Default quotas per peer (event rate, filter count, bandwidth)?
- How should we promote spambox data into trusted storage (manual vs automatic thresholds)?
- Which Nostr kinds are worth caching in trusted storage by default?
