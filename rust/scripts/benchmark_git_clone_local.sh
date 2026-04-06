#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUST_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$RUST_DIR/.." && pwd)

SOURCE_REPO=${HTREE_BENCH_SOURCE_REPO:-$REPO_ROOT}
ITERATIONS=${HTREE_BENCH_ITERATIONS:-1}
LABEL=${HTREE_BENCH_LABEL:-clone-local}

cd "$RUST_DIR"

cargo build -p git-remote-htree --bin git-remote-htree
cargo build -p hashtree-cli --bin htree

export HTREE_BENCH_SOURCE_REPO="$SOURCE_REPO"
export HTREE_BENCH_ITERATIONS="$ITERATIONS"
export HTREE_BENCH_LABEL="$LABEL"

cargo test -p git-remote-htree --test perf_clone benchmark_large_repo_clone_local -- --ignored --nocapture
