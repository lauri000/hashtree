# @hashtree/merge

Deterministic path-based merge primitives for hashtree.

This package intentionally starts one layer above raw directory trees:

- merge by normalized path
- explicit path tombstones
- deterministic source precedence
- provenance for shadowed and tombstoned paths

It does not attempt to provide CRDT rename or move semantics.
