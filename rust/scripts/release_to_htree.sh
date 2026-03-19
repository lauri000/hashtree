#!/bin/bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: rust/scripts/release_to_htree.sh --version <version> [options]

Builds local CLI release artifacts, adds the assembled release directory to
hashtree, then publishes it into a mutable release tree.

Options:
  --version <version>                 Release version label, for example: v0.2.3
  --version-path <path>              Published path inside the release tree (default: <version>)
  --tree-name <name>                 Mutable release tree name (default: <repo>-releases)
  --output-dir <dir>                 Release directory to create/use
  --target-dir <dir>                 Cargo target dir to read/write
  --targets <csv>                    Comma-separated targets to build/package
  --windows-artifacts-dir <dir>      Directory containing Windows .exe binaries from a VM
  --package-only                     Skip builds and package existing binaries only
  --cargo-bin <path>                 Cargo binary to use
  --cross-bin <path>                 cross binary to use for Linux musl targets
  -h, --help                         Show this help

Examples:
  rust/scripts/release_to_htree.sh --version v0.2.3
  rust/scripts/release_to_htree.sh --version v0.2.3 --windows-artifacts-dir /Volumes/windows-share/release
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${RUST_DIR}/.." && pwd)"
REPO_NAME="$(basename "$REPO_DIR")"

VERSION=""
VERSION_PATH=""
TREE_NAME="${REPO_NAME}-releases"

BUILD_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            VERSION="${2:-}"
            BUILD_ARGS+=("$1" "${2:-}")
            shift 2
            ;;
        --version-path)
            VERSION_PATH="${2:-}"
            shift 2
            ;;
        --tree-name)
            TREE_NAME="${2:-}"
            shift 2
            ;;
        --output-dir|--target-dir|--targets|--windows-artifacts-dir|--cargo-bin|--cross-bin)
            BUILD_ARGS+=("$1" "${2:-}")
            shift 2
            ;;
        --package-only)
            BUILD_ARGS+=("$1")
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [ -z "$VERSION" ]; then
    echo "--version is required" >&2
    usage >&2
    exit 1
fi

if [ -z "$VERSION_PATH" ]; then
    VERSION_PATH="$VERSION"
fi

"${SCRIPT_DIR}/build_release_artifacts.sh" "${BUILD_ARGS[@]}"

OUTPUT_DIR=""
for ((i = 0; i < ${#BUILD_ARGS[@]}; i++)); do
    if [ "${BUILD_ARGS[$i]}" = "--output-dir" ]; then
        OUTPUT_DIR="${BUILD_ARGS[$((i + 1))]}"
        break
    fi
done

if [ -z "$OUTPUT_DIR" ]; then
    OUTPUT_DIR="${RUST_DIR}/dist/hashtree-${VERSION}"
fi

release_cid="$(
    cd "$REPO_DIR"
    htree add "$OUTPUT_DIR" | awk '/^  url:/ {print $2}'
)"

if [ -z "$release_cid" ]; then
    echo "Failed to determine release CID from htree add output" >&2
    exit 1
fi

echo "Release CID: ${release_cid}"
"${SCRIPT_DIR}/publish_release.sh" "$VERSION_PATH" "$release_cid" "$TREE_NAME"
