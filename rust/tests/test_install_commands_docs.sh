#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${RUST_DIR}/.." && pwd)"

INSTALL_CMD='curl -fsSL https://upload.iris.to/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/releases%2Fhashtree/latest/install.sh | sh'
LEGACY_GITHUB_URL='https://github.com/mmalmi/hashtree/releases/latest/download/'

FILES=(
    "${REPO_ROOT}/README.md"
    "${REPO_ROOT}/rust/crates/git-remote-htree/README.md"
    "${REPO_ROOT}/apps/hashtree-cc/src/components/Developers.svelte"
)

for file in "${FILES[@]}"; do
    grep -F "$INSTALL_CMD" "$file" >/dev/null || {
        echo "Missing canonical install command in ${file}" >&2
        exit 1
    }

    if grep -F "$LEGACY_GITHUB_URL" "$file" >/dev/null; then
        echo "Found legacy GitHub install command in ${file}" >&2
        exit 1
    fi
done

echo "test_install_commands_docs.sh passed"
