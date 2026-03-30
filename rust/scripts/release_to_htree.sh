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
  --tree-name <name>                 Mutable release tree name (default: releases/<repo>)
  --homebrew-tap-repo <name>         Homebrew tap repo name (default: homebrew-<repo>)
  --skip-homebrew-tap                Skip updating the Homebrew tap
  --cargo-publish                    Publish Rust crates to crates.io after releasing artifacts
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
TREE_NAME="releases/${REPO_NAME}"
HOMEBREW_TAP_REPO="homebrew-${REPO_NAME}"
SKIP_HOMEBREW_TAP=0
CARGO_PUBLISH=0

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
        --homebrew-tap-repo)
            HOMEBREW_TAP_REPO="${2:-}"
            shift 2
            ;;
        --skip-homebrew-tap)
            SKIP_HOMEBREW_TAP=1
            shift
            ;;
        --cargo-publish)
            CARGO_PUBLISH=1
            shift
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

value_from_build_args() {
    local key="$1"
    local default_value="${2:-}"
    local i
    for ((i = 0; i < ${#BUILD_ARGS[@]}; i++)); do
        if [ "${BUILD_ARGS[$i]}" = "$key" ]; then
            echo "${BUILD_ARGS[$((i + 1))]}"
            return
        fi
    done
    echo "$default_value"
}

homebrew_checksums_ready() {
    local checksums_dir="$1"
    local target
    for target in \
        aarch64-apple-darwin \
        x86_64-apple-darwin \
        aarch64-unknown-linux-musl \
        x86_64-unknown-linux-musl
    do
        if [ ! -f "${checksums_dir}/hashtree-${target}.sha256" ]; then
            return 1
        fi
    done
    return 0
}

"${SCRIPT_DIR}/build_release_artifacts.sh" "${BUILD_ARGS[@]}"

OUTPUT_DIR="$(value_from_build_args --output-dir "${RUST_DIR}/dist/hashtree-${VERSION}")"
TARGET_DIR="$(value_from_build_args --target-dir "${RUST_DIR}/target")"

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

if [ "$SKIP_HOMEBREW_TAP" -eq 0 ]; then
    HOMEBREW_PUBLISH_SCRIPT="${REPO_DIR}/packaging/homebrew/publish_tap.sh"
    if [ ! -x "$HOMEBREW_PUBLISH_SCRIPT" ]; then
        echo "Warning: Homebrew tap script not found at packaging/homebrew/publish_tap.sh; skipping tap update." >&2
    elif ! homebrew_checksums_ready "$OUTPUT_DIR"; then
        echo "Warning: Homebrew tap update skipped because the release directory does not contain the full macOS/Linux checksum set." >&2
    else
        npub="$(htree user | awk '{print $1}')"
        release_base_url="https://upload.iris.to/${npub}/${TREE_NAME}/${VERSION_PATH}"
        if ! "${HOMEBREW_PUBLISH_SCRIPT}" \
            --version "$VERSION" \
            --release-base-url "$release_base_url" \
            --checksums-dir "$OUTPUT_DIR" \
            --tap-repo "$HOMEBREW_TAP_REPO" \
            --target-dir "$TARGET_DIR"
        then
            echo "Warning: Homebrew tap update failed; release artifacts are still published." >&2
        fi
    fi
fi

if [ "$CARGO_PUBLISH" -eq 1 ]; then
    "${SCRIPT_DIR}/publish.sh"
fi
