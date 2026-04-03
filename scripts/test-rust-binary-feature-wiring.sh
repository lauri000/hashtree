#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

grep -F 'default = ["p2p", "lmdb"]' rust/crates/hashtree-cli/Cargo.toml >/dev/null
grep -F 'cargo build -p hashtree-cli --bin htree --features fuse' .github/workflows/ci.yml >/dev/null
grep -F 'bash scripts/build_release_artifacts.sh' .github/workflows/release.yml >/dev/null
grep -F -- '--linux-builder docker' .github/workflows/release.yml >/dev/null
grep -F 'write_release_bootstrap_installer.sh' .github/workflows/release.yml >/dev/null
grep -F 'FUSE-enabled Linux release builds use Docker-native musl containers' .github/workflows/release.yml >/dev/null
grep -F 'HTREE_RELEASE_FEATURES="hashtree-cli/fuse"' rust/scripts/build_release_artifacts.sh >/dev/null
grep -F -- '--locked' rust/scripts/build_release_artifacts.sh >/dev/null

echo "Rust binary feature wiring checks passed."
