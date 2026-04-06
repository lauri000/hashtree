# Git Repo Fetch And Push Improvement Plan

Date: April 7, 2026
Scope: Practical roadmap for making `git-remote-htree` faster for large repos over hashtree and Blossom, with a reusable benchmark path for future transport changes

## Goal

Improve large-repo performance without losing the correctness and repair properties that the current content-addressed model provides.

This note focuses on:

- large initial clone and fetch
- incremental push to Blossom-backed remotes
- how to measure future improvements in a way that is reusable for packfile or batch-fetch experiments

## Current State

### Push

Recent push behavior now distinguishes normal incremental push from force push:

- normal push may trust sampled old-tree server coverage
- force push disables that trust and falls back to full upload behavior
- when a server is known to need repair, uploads can be directed only to the affected servers instead of broadcasting to every server every time

Relevant code:

- `rust/crates/git-remote-htree/src/helper/push.rs`
- `rust/crates/hashtree-blossom/src/lib.rs`
- `rust/crates/git-remote-htree/src/helper/tests.rs`

### Fetch

Recent fetch behavior now:

1. resolves and walks `.git/objects`
2. batch-checks which objects already exist in local `.git`
3. downloads missing objects with bounded concurrency
4. feeds object writes through a bounded writer pipeline
5. reports stage timings for enumeration, local existence checks, and download plus write

Relevant code:

- `rust/crates/git-remote-htree/src/helper.rs`
- `rust/crates/git-remote-htree/src/helper/git_objects.rs`

## Benchmark Harness

A reusable local benchmark now exists for first-clone measurements:

- `rust/crates/git-remote-htree/tests/perf_clone.rs`
- `rust/scripts/benchmark_git_clone_local.sh`

The harness intentionally uses:

- one publisher environment for seeding the remote
- one fresh consumer environment per iteration
- a real local relay and Blossom server
- a real `git clone htree://...`

Important measurement rule:

- the reported clone duration excludes `cargo build` time
- the reported clone duration excludes the initial publish time
- it measures only the actual `git clone`

## Measured Result On This Repo

Using `/Users/sirius/src/hashtree` as the source repo and one local relay plus Blossom server:

- committed baseline clone: `124109 ms`
- first refactor attempt: `150366 ms`
- corrected bounded-writer fetch path: `103094 ms`

Interpretation:

- writing loose objects directly inside the async fetch loop was a regression
- decoupling download and write with a bounded writer queue improved first clone by about `17%` relative to the baseline

These numbers are useful as a starting point, not as universal truth. Future measurements should compare against the same harness and similar source repo size.

## What Still Dominates

Even after the low-risk refactor, the main remaining costs are still structural:

1. one HTTP GET per git object
2. one loose-object write per git object
3. full `.git/objects` tree enumeration before transfer

This means there is still a hard performance ceiling for very large repos.

## Recommended Improvement Order

### Phase 1: Finish Low-Risk Tuning

Keep the current transport shape and tighten the obvious knobs:

1. make fetch concurrency configurable
2. benchmark several concurrency levels on localhost and on a realistic-latency server
3. add push-side timing for:
   - rev-list/object discovery
   - old-tree diff collection
   - upload time
   - Nostr publish time
4. keep using the current benchmark harness as the baseline for future work

### Phase 2: Reduce Metadata Overhead

Add a compact per-repo object manifest so clone does not have to walk the whole exported `.git/objects` tree just to discover object IDs and content CIDs.

Possible manifest contents:

- object ID
- backing hashtree CID
- size

Benefits:

- simpler clone planning
- lower tree-walk overhead

Limit:

- still one GET per object unless combined with batch transfer

### Phase 3: Reduce Request Count

Add a batch blob fetch path for clone.

Shape:

- client requests many object blobs in one response
- server returns a framed stream or grouped archive of raw loose-object payloads

Benefits:

- fewer HTTP round trips
- lower per-request overhead

Limit:

- still many loose-object writes locally

### Phase 4: Move To Pack-Oriented Clone

If large-clone speed remains important, this is the most likely step to matter substantially.

Shape:

1. server builds or caches a git pack for a repo root or wanted refs
2. client downloads pack and index data
3. client feeds it to `git index-pack` or `git unpack-objects`

Benefits:

- far fewer requests
- far fewer filesystem operations
- behavior much closer to normal fast git clone

Tradeoffs:

- more implementation complexity
- need pack caching and invalidation policy

## Push-Side Roadmap

### Keep Current Heuristic Improvement

The sampled old-tree coverage optimization is worthwhile for today:

- it avoids unnecessary old-tree probing in the common case
- it preserves force-push escape hatches
- it is already test-covered

### Next Step: Deterministic Reconciliation

The long-term push improvement should be a real Blossom reconciliation protocol rather than increasingly clever guessing.

Recommended direction:

1. add a Blossom-specific deterministic reconciliation endpoint over sorted blob hashes
2. start with radix or prefix reconciliation over hash space
3. preserve repair semantics for partially inconsistent servers

Related note:

- `docs/blossom-reconciliation-and-large-fetch-plan.md`

## Decision Rule For Next Work

When choosing the next optimization:

- if tree walk dominates, add the manifest
- if request overhead dominates, add batch blob fetch
- if local loose-object writes dominate, prioritize pack-oriented clone
- if push correctness and repeated repair overhead dominate, prioritize deterministic Blossom reconciliation

## Recommended Next Slice

The next concrete slice should be:

1. keep the current pipelined fetch path
2. add a few benchmark presets around concurrency
3. record timings for push phases as well as clone phases
4. only then choose between manifest, batch loose fetch, and pack-based clone based on real measurements

That keeps the roadmap evidence-driven instead of speculative.
