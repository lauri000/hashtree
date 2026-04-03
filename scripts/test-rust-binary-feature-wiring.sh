#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

grep -F 'default = ["p2p", "lmdb"]' rust/crates/hashtree-cli/Cargo.toml >/dev/null
grep -F 'cargo build -p hashtree-cli --bin htree --features fuse' .github/workflows/ci.yml >/dev/null
grep -F 'cross build --release --target ${{ matrix.target }} -p hashtree-cli --features fuse' .github/workflows/release.yml >/dev/null
grep -F 'cargo build --release --target ${{ matrix.target }} -p hashtree-cli --features fuse' .github/workflows/release.yml >/dev/null
grep -F 'HTREE_RELEASE_FEATURES="hashtree-cli/fuse"' rust/scripts/build_release_artifacts.sh >/dev/null

echo "Rust binary feature wiring checks passed."
