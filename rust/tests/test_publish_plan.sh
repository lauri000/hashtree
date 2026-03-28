#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PUBLISH_SCRIPT="${RUST_DIR}/scripts/publish.sh"

crates=()
while IFS= read -r crate; do
    crates+=("$crate")
done < <("${PUBLISH_SCRIPT}" --plan)

expected=(
    "hashtree-core"
    "hashtree-config"
    "hashtree-merge"
    "hashtree-index"
    "hashtree-lmdb"
    "hashtree-fs"
    "hashtree-fuse"
    "hashtree-s3"
    "hashtree-blossom"
    "hashtree-resolver"
    "hashtree-nostr"
    "hashtree-webrtc"
    "git-remote-htree"
    "hashtree-nostr-bridge"
    "hashtree-cli"
    "hashtree-cashu-cli"
)

if [[ "${#crates[@]}" -ne "${#expected[@]}" ]]; then
    echo "expected ${#expected[@]} crates, got ${#crates[@]}" >&2
    exit 1
fi

for i in "${!expected[@]}"; do
    if [[ "${crates[$i]}" != "${expected[$i]}" ]]; then
        echo "crate mismatch at index ${i}: expected '${expected[$i]}', got '${crates[$i]}'" >&2
        exit 1
    fi
done

echo "test_publish_plan.sh passed"
