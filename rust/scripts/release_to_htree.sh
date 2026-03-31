#!/bin/bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: rust/scripts/release_to_htree.sh --version <version> [options]

Builds local CLI release artifacts, stages a metadata-backed repo release
directory, adds it to hashtree, then publishes it into a mutable release tree.
When apps/iris is present, the same release also stages locally-built Iris
desktop installers unless explicitly skipped.

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
  --skip-windows-vm                  Skip auto-building Windows CLI artifacts from a Parallels VM
  --windows-vm-name <name>           Override the Parallels Windows VM name for auto builds
  --windows-shared-repo-path <path>  Override the repo path inside Parallels shared folders
  --windows-guest-repo-path <path>   Override the guest repo path used for the Windows build
  --package-only                     Skip builds and package existing binaries only
  --skip-iris                        Do not include Iris desktop assets in the repo release
  --skip-iris-verify                 Skip pnpm build/icon verification before Iris packaging
  --iris-only <csv>                  Limit Iris packaging steps to verify,macos,linux,windows
  --iris-skip <csv>                  Skip selected Iris packaging steps
  --iris-stage-dir <dir>             Directory to use for staged Iris release metadata
  --release-stage-dir <dir>          Directory to use for the staged repo release metadata
  --cargo-bin <path>                 Cargo binary to use
  --cross-bin <path>                 cross binary to use for Linux musl targets
  -h, --help                         Show this help

Examples:
  rust/scripts/release_to_htree.sh --version v0.2.3
  rust/scripts/release_to_htree.sh --version v0.2.3 --windows-artifacts-dir /Volumes/windows-share/release
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/release_common.sh"
RUST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${RUST_DIR}/.." && pwd)"
REPO_NAME="$(infer_repo_name "$REPO_DIR")"

VERSION=""
VERSION_PATH=""
TREE_NAME="releases/${REPO_NAME}"
HOMEBREW_TAP_REPO="homebrew-${REPO_NAME}"
SKIP_HOMEBREW_TAP=0
CARGO_PUBLISH=0
SKIP_IRIS=0
SKIP_IRIS_VERIFY=0
IRIS_ONLY=""
IRIS_SKIP=""
IRIS_STAGE_DIR=""
RELEASE_STAGE_DIR=""

BUILD_ARGS=()
TEMP_DIRS=()
SKIP_WINDOWS_VM=0
WINDOWS_VM_NAME=""
WINDOWS_SHARED_REPO_PATH=""
WINDOWS_GUEST_REPO_PATH=""

cleanup() {
    local path
    for path in "${TEMP_DIRS[@]:-}"; do
        if [ -n "$path" ] && [ -e "$path" ]; then
            rm -rf "$path"
        fi
    done
}

trap cleanup EXIT

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
        --skip-iris)
            SKIP_IRIS=1
            shift
            ;;
        --skip-windows-vm)
            SKIP_WINDOWS_VM=1
            shift
            ;;
        --windows-vm-name)
            WINDOWS_VM_NAME="${2:-}"
            shift 2
            ;;
        --windows-shared-repo-path)
            WINDOWS_SHARED_REPO_PATH="${2:-}"
            shift 2
            ;;
        --windows-guest-repo-path)
            WINDOWS_GUEST_REPO_PATH="${2:-}"
            shift 2
            ;;
        --skip-iris-verify)
            SKIP_IRIS_VERIFY=1
            shift
            ;;
        --iris-only)
            IRIS_ONLY="${2:-}"
            shift 2
            ;;
        --iris-skip)
            IRIS_SKIP="${2:-}"
            shift 2
            ;;
        --iris-stage-dir)
            IRIS_STAGE_DIR="${2:-}"
            shift 2
            ;;
        --release-stage-dir)
            RELEASE_STAGE_DIR="${2:-}"
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

require_command() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing required command: $cmd" >&2
        exit 1
    fi
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

write_release_bootstrap_installer() {
    local path="$1"
    local base_url="$2"

    cat >"$path" <<EOF
#!/bin/sh
set -eu

BASE_URL="${base_url}"
ASSET_BASE_URL="\${BASE_URL}/assets"

# This bootstrap is the trust root for curl|sh installs. Same-origin checksum
# files would not improve security here, so it downloads the release archive
# directly and delegates to the packaged installer.

require_command() {
    if ! command -v "\$1" >/dev/null 2>&1; then
        echo "Missing required command: \$1" >&2
        exit 1
    fi
}

detect_arch() {
    case "\$(uname -m)" in
        arm64|aarch64)
            printf '%s\n' aarch64
            ;;
        x86_64|amd64)
            printf '%s\n' x86_64
            ;;
        *)
            echo "Unsupported architecture: \$(uname -m)" >&2
            exit 1
            ;;
    esac
}

detect_os() {
    case "\$(uname -s)" in
        Darwin)
            printf '%s\n' apple-darwin
            ;;
        Linux)
            printf '%s\n' unknown-linux-musl
            ;;
        *)
            echo "Unsupported operating system: \$(uname -s)" >&2
            exit 1
            ;;
    esac
}

require_command curl
require_command tar
require_command mktemp

target="\$(detect_arch)-\$(detect_os)"
archive="hashtree-\${target}.tar.gz"
tmpdir="\$(mktemp -d 2>/dev/null || mktemp -d -t hashtree-install)"
trap 'rm -rf "\$tmpdir"' EXIT HUP INT TERM

curl -fsSL "\${ASSET_BASE_URL}/\${archive}" -o "\${tmpdir}/\${archive}"
tar -xzf "\${tmpdir}/\${archive}" -C "\${tmpdir}"

cd "\${tmpdir}/hashtree"
exec ./install.sh "\$@"
EOF

    chmod +x "$path"
}

auto_build_windows_vm_artifacts() {
    local helper_script windows_output_dir

    if [ "$SKIP_WINDOWS_VM" -eq 1 ]; then
        return
    fi

    if [ -n "$(value_from_build_args --windows-artifacts-dir)" ]; then
        return
    fi

    helper_script="${SCRIPT_DIR}/build_windows_vm_artifacts.mjs"
    if [ ! -f "$helper_script" ]; then
        echo "Warning: Windows VM build helper not found at ${helper_script}; skipping Windows CLI artifacts." >&2
        return
    fi

    if ! command -v node >/dev/null 2>&1; then
        echo "Warning: node is required for Windows VM builds; skipping Windows CLI artifacts." >&2
        return
    fi

    mkdir -p "${RUST_DIR}/dist"
    windows_output_dir="$(mktemp -d "${RUST_DIR}/dist/windows-vm-XXXXXX")"
    TEMP_DIRS+=("$windows_output_dir")

    WINDOWS_BUILD_ARGS=("$helper_script" "--output-dir" "$windows_output_dir")
    if [ -n "$WINDOWS_VM_NAME" ]; then
        WINDOWS_BUILD_ARGS+=("--vm-name" "$WINDOWS_VM_NAME")
    fi
    if [ -n "$WINDOWS_SHARED_REPO_PATH" ]; then
        WINDOWS_BUILD_ARGS+=("--shared-repo-path" "$WINDOWS_SHARED_REPO_PATH")
    fi
    if [ -n "$WINDOWS_GUEST_REPO_PATH" ]; then
        WINDOWS_BUILD_ARGS+=("--guest-repo-path" "$WINDOWS_GUEST_REPO_PATH")
    fi

    if node "${WINDOWS_BUILD_ARGS[@]}"; then
        BUILD_ARGS+=("--windows-artifacts-dir" "$windows_output_dir")
    else
        echo "Warning: Windows VM build failed; continuing without Windows CLI artifacts." >&2
        rm -rf "$windows_output_dir"
    fi
}

auto_build_windows_vm_artifacts

"${SCRIPT_DIR}/build_release_artifacts.sh" "${BUILD_ARGS[@]}"

OUTPUT_DIR="$(value_from_build_args --output-dir "${RUST_DIR}/dist/hashtree-${VERSION}")"
TARGET_DIR="$(value_from_build_args --target-dir "${RUST_DIR}/target")"
npub="$(current_npub)"
RELEASE_STAGE_SCRIPT="${REPO_DIR}/scripts/stage_repo_release.mjs"
IRIS_RELEASE_SCRIPT="${REPO_DIR}/apps/iris/scripts/local-release.mjs"

if [ -n "$npub" ]; then
    write_release_bootstrap_installer \
        "${OUTPUT_DIR}/install.sh" \
        "$(gateway_release_base_url "$npub" "$TREE_NAME" "$VERSION_PATH")"
else
    echo "Warning: Could not determine current npub; skipping release installer generation." >&2
fi

if [ "$SKIP_IRIS" -eq 0 ]; then
    if [ -f "$IRIS_RELEASE_SCRIPT" ]; then
        require_command node

        if [ -z "$IRIS_STAGE_DIR" ]; then
            IRIS_STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hashtree-iris-release-XXXXXX")"
            TEMP_DIRS+=("$IRIS_STAGE_DIR")
        fi

        IRIS_ARGS=("$IRIS_RELEASE_SCRIPT" "--tag" "$VERSION" "--stage-dir" "$IRIS_STAGE_DIR")
        if [ "$SKIP_IRIS_VERIFY" -eq 1 ]; then
            IRIS_ARGS+=("--skip-verify")
        fi
        if [ -n "$IRIS_ONLY" ]; then
            IRIS_ARGS+=("--only" "$IRIS_ONLY")
        fi
        if [ -n "$IRIS_SKIP" ]; then
            IRIS_ARGS+=("--skip" "$IRIS_SKIP")
        fi

        node "${IRIS_ARGS[@]}"
    else
        echo "Warning: Iris release script not found at apps/iris/scripts/local-release.mjs; skipping Iris desktop assets." >&2
    fi
fi

if [ ! -f "$RELEASE_STAGE_SCRIPT" ]; then
    echo "Missing repo release staging helper: ${RELEASE_STAGE_SCRIPT}" >&2
    exit 1
fi

require_command node
if [ -z "$RELEASE_STAGE_DIR" ]; then
    RELEASE_STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hashtree-release-stage-XXXXXX")"
    TEMP_DIRS+=("$RELEASE_STAGE_DIR")
fi
RELEASE_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || printf '%s\n' HEAD)"
STAGE_ARGS=(
    "$RELEASE_STAGE_SCRIPT"
    --tag "$VERSION"
    --commit "$RELEASE_COMMIT"
    --cli-dir "$OUTPUT_DIR"
    --output-dir "$RELEASE_STAGE_DIR"
)

if [ -n "$IRIS_STAGE_DIR" ] && [ -d "$IRIS_STAGE_DIR" ]; then
    STAGE_ARGS+=(--iris-stage-dir "$IRIS_STAGE_DIR")
fi

if [ -n "$npub" ] && [ -f "${OUTPUT_DIR}/install.sh" ]; then
    STAGE_ARGS+=(--install-url "$(gateway_release_base_url "$npub" "$TREE_NAME" "$VERSION_PATH")/install.sh")
fi

node "${STAGE_ARGS[@]}"

release_cid="$(
    cd "$REPO_DIR"
    htree add "$RELEASE_STAGE_DIR" | awk '/^  url:/ {print $2}'
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
        if [ -z "$npub" ]; then
            echo "Warning: Could not determine current npub; skipping Homebrew tap update." >&2
        else
            release_base_url="$(gateway_release_base_url "$npub" "$TREE_NAME" "$VERSION_PATH")"
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
fi

if [ "$CARGO_PUBLISH" -eq 1 ]; then
    "${SCRIPT_DIR}/publish.sh"
fi
