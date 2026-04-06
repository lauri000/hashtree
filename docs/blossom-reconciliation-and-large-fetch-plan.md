# Blossom Reconciliation And Large-Fetch Plan

## Why This Exists

Large repos stored over Blossom can become slow in two places:

1. Incremental push currently has to infer server coverage from sampled `HEAD` checks and then fall back to more checks or uploads when confidence is low.
2. Initial clone/fetch of a large repo still downloads and writes git objects one-by-one, which creates a hard per-object overhead floor.

This note captures:

- the recommended direction for deterministic Blossom sync/reconciliation
- what currently limits initial large-repo download speed
- the order in which improvements should be attempted

## Part 1: Deterministic Blossom Sync

### Recommendation

Do not implement NIP-77 directly for Blossom.

Use it as inspiration only, then define a Blossom-specific reconciliation protocol over sorted SHA-256 blob hashes.

Reasoning:

- NIP-77 is a relay/websocket protocol for event sets, not a natural fit for a flat HTTP blob store.
- Our Blossom server currently exposes per-blob `HEAD /:sha`, `PUT /upload`, and optional owner-scoped `/list/:pubkey`, but not a global ordered inventory.
- The existing git remote helper tests already model the case where sampled `HEAD` checks succeed and old blobs later disappear, so any new protocol must preserve repair behavior instead of trusting a one-shot coverage guess forever.

Relevant code:

- `rust/crates/hashtree-cli/src/server/blossom.rs`
- `rust/crates/hashtree-cli/src/storage.rs`
- `rust/crates/git-remote-htree/tests/missing_old_chunks.rs`

### Best Protocol Shape

The best fit is a Blossom-specific exact reconciliation protocol over lexicographically sorted SHA-256 hashes.

Two viable designs:

1. Prefix/radix reconciliation over hash space.
2. Negentropy-style range reconciliation over hash space.

Recommendation:

- Start with prefix/radix reconciliation.
- Consider Negentropy-style range fingerprints only if the simpler design is still too chatty.

Why radix first:

- Our keys are already uniformly distributed SHA-256 values.
- Buckets by prefix should stay balanced naturally.
- The protocol can stay stateless and HTTP-friendly.
- It is simpler to implement and debug than a full Negentropy wrapper.

### Better-Than-Negentropy?

There is no universally better algorithm. The tradeoff depends on whether we optimize for exactness, simplicity, bounded-delta efficiency, or CPU cost.

- Negentropy / range-based reconciliation: strong general-purpose choice when overlap is high and the difference size is unknown.
- Minisketch / PinSketch: excellent fast path when the symmetric difference is known to be small, but requires a capacity guess and fallback when that guess is wrong.
- IBLT: simple and fast, but probabilistic rather than exact.
- CPISync: communication-efficient but computationally unattractive here.

Recommendation:

- Exact main path: radix or Negentropy-style reconciliation.
- Optional tiny-delta fast path later: Minisketch.
- Do not choose CPISync for this use case.

### Proposed Reconciliation Protocol

Phase 1 should be simple and deterministic:

1. Add a global blob index ordered by raw hash bytes.
2. Add a reconciliation endpoint under the Blossom server, separate from `/list/:pubkey`.
3. Client asks for summary data over a prefix range:
   - prefix
   - item count
   - fingerprint of hashes in that range
4. If count and fingerprint match, stop descending.
5. If a range is small, return raw missing hashes directly.
6. If ranges do not match, recurse into finer prefixes.
7. After the missing hash set is known, upload or fetch only those blobs.

### Why Not Stop At Sampled `HEAD` Checks

Sampled checks are a heuristic, not a proof.

This repo already has a test for the failure mode:

- `rust/crates/git-remote-htree/tests/missing_old_chunks.rs`

That test intentionally makes the first sample checks pass and then removes old blobs. The sync design therefore needs:

- deterministic reconciliation when correctness matters
- a repair path that can recover from partial or stale server state

## Part 2: Initial Large Repo Download From Blossom

### Current Fetch Path

For git remote helper clone/fetch:

1. Resolve repo root from Nostr.
2. Resolve `.git/objects` inside the tree.
3. Walk the full `.git/objects` tree to enumerate object entries.
4. Build a complete `Vec` of fetch tasks.
5. Download every object into memory.
6. Return a complete `Vec<(oid, content)>`.
7. Only then check which objects already exist in `.git`.
8. Write loose objects one-by-one to `.git/objects/xx/yyyy...`.

Relevant code:

- `rust/crates/git-remote-htree/src/helper.rs`
- `rust/crates/git-remote-htree/src/helper/git_objects.rs`
- `rust/crates/git-remote-htree/src/git/storage.rs`
- `rust/crates/hashtree-blossom/src/lib.rs`

Important details:

- The tree walker already avoids fetching blob contents during enumeration, which is good.
- Enumeration still returns a full in-memory `Vec<WalkEntry>`.
- Object downloads are then collected into another in-memory `Vec`.
- Downloads use a fixed concurrency of `20`.
- Each object is fetched with a separate HTTP GET.
- Each object is then written as a separate loose git object.

### What Actually Dominates

For very large repos, the biggest costs are usually:

1. Per-object HTTP request overhead.
2. Per-object loose-object filesystem writes.
3. End-to-end buffering before any write begins.

The pure merkle-tree walk is probably not the main bottleneck unless the tree is extremely fragmented.

If we keep:

- one GET per object
- one loose-object write per object

then there is a hard ceiling on clone speed regardless of smaller optimizations.

### Findings

#### 1. Full-buffer fetch is hurting latency and memory

The fetch path currently waits until all objects are enumerated and downloaded before writing them.

That is avoidable.

This should be improved even if we do nothing else.

#### 2. The current model is request-heavy

A repo with `100k` objects means roughly `100k` GET requests.

Even with keepalive and concurrency, this leaves a lot of per-request overhead on:

- TLS/session management
- header parsing
- server routing
- request scheduling

#### 3. Loose-object output is not clone-friendly

Git clone from packfiles is much faster than writing huge numbers of loose objects.

The current hashtree git export stores loose-style object layout under `.git/objects/xx/...`.
That keeps compatibility simple, but it is not optimal for initial large clones.

### Recommended Speedup Order

#### Phase A: Low-Risk Improvements

These should happen first.

1. Stream the tree walk instead of collecting the full `Vec<WalkEntry>`.
2. Pipeline download and local git write instead of returning `Vec<(oid, Vec<u8>)>`.
3. Start writing objects as soon as each download verifies.
4. Keep only a bounded in-flight buffer.
5. Make fetch concurrency configurable and benchmark values above `20`.

Expected benefit:

- less peak memory
- shorter time-to-first-object
- somewhat better total time

Expected limit:

- still one GET and one loose write per object

#### Phase B: Object Manifest

Add a compact object manifest blob under the repo root.

Contents:

- object ID
- corresponding hashtree CID/hash
- optional size

This avoids walking the `.git/objects` tree just to discover objects.

Expected benefit:

- lower metadata traversal overhead
- simpler fetch planning

Expected limit:

- still one GET per object unless paired with a batch transport

#### Phase C: Batch Blob Fetch

Add a Blossom endpoint that returns many blobs in one request.

Example shape:

- client sends a list of blob hashes
- server returns a length-prefixed stream of `(hash, bytes)` records

Expected benefit:

- much lower per-request overhead
- keeps content-addressed verification simple

Expected limit:

- still many loose-object writes on the client

#### Phase D: Pack-Oriented Clone Path

This is the highest-impact improvement for initial large clone.

Instead of cloning from many loose objects:

1. Server builds a git pack for a repo root or wanted refs.
2. Pack is cached by repo root hash.
3. Client downloads `.pack` plus `.idx`, or a pack stream.
4. Client feeds it to `git index-pack` / `git unpack-objects`.

Expected benefit:

- far fewer HTTP requests
- far fewer filesystem operations
- much closer to normal git clone performance

Tradeoff:

- more implementation complexity
- pack generation/caching policy needed

### Strong Recommendation

If the goal is "make initial large repo download genuinely fast", the likely winning path is:

1. pipeline current fetch path first
2. add a manifest if needed
3. move to a pack-based clone path

Batch fetching many loose blobs can help, but packfiles are the first improvement likely to move clone performance by a large factor rather than a small factor.

## Suggested Execution Plan

### Step 1: Instrumentation

Add timing around:

- root resolution
- `.git/objects` path resolution
- tree walk
- object download
- git object writes

Do this before changing protocol design further.

### Step 2: Pipelined Fetch

Refactor the git remote helper fetch path to:

- stream object discovery
- download with bounded concurrency
- verify and write immediately

### Step 3: Benchmark

Benchmark at least:

- `10k` objects
- `100k` objects
- one server on localhost
- one remote server with realistic latency

### Step 4: Decide Between Batch Blobs And Packfiles

Decision rule:

- if HTTP round trips dominate, add batch blob fetch
- if loose-object writes dominate, go directly to pack-based clone
- if both dominate, packfiles should take priority

## Final Recommendation

For sync:

- build a Blossom-specific deterministic reconciliation protocol
- prefer radix/prefix reconciliation first
- keep a repair fallback for inconsistent servers

For initial large clone:

- the current loose-object-over-many-GETs model has limited upside
- do a pipelined fetch refactor first
- if large-clone speed still matters after that, implement a pack-oriented clone path
