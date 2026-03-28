# hashtree-merge

Deterministic path-based merge primitives for hashtree.

This crate intentionally starts with path-based overlays:

- merge by normalized path
- explicit path tombstones
- deterministic source precedence
- provenance for shadowed and tombstoned paths

It does not attempt to provide CRDT rename or move semantics.
