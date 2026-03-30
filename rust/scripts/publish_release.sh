#!/bin/bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: rust/scripts/publish_release.sh <version-path> <release-cid-or-nhash> [tree-name]

Publishes a release directory CID into a mutable release tree and repoints the
"latest" entry to the same CID.

Examples:
  rust/scripts/publish_release.sh v0.2.3 nhash1...
  rust/scripts/publish_release.sh releases/v0.2.3 nhash1... hashtree-releases
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    usage
    exit 0
fi

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
    usage >&2
    exit 1
fi

version_path="$1"
release_cid="$2"
repo_name="$(basename "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)")"
tree_name="${3:-${repo_name}-releases}"
npub="$(htree user | awk '{print $1}')"

if [[ "$version_path" == */* ]]; then
    latest_path="${version_path%/*}/latest"
else
    latest_path="latest"
fi

htree release publish "$tree_name" "$version_path" "$release_cid"

cat <<EOF

Canonical:
  htree://${npub}/${tree_name}/${version_path}
  htree://${npub}/${tree_name}/${latest_path}

Direct:
  https://upload.iris.to/${npub}/${tree_name}/${version_path}/
  https://upload.iris.to/${npub}/${tree_name}/${latest_path}/

Browser:
  https://files.iris.to/#/${npub}/${tree_name}/${version_path}
  https://files.iris.to/#/${npub}/${tree_name}/${latest_path}
EOF
