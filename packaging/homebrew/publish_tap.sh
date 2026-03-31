#!/bin/bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: packaging/homebrew/publish_tap.sh --version <version> --release-base-url <url> --checksums-dir <dir> [options]

Generate a Homebrew tap repository and push it to a git remote.

Required options:
  --version <version>              Release version, for example: v0.2.15
  --release-base-url <url>         Base URL containing hashtree-<target>.tar.gz files
  --checksums-dir <dir>            Directory containing hashtree-<target>.sha256 files

Optional:
  --tap-repo <name>                Tap repo name (default: homebrew-<repo-name>)
  --push-url <git-url>             Git remote to push (default: htree://self/<tap-repo>)
  --npub <npub>                    Npub used only for install URL output
  --target-dir <dir>               Cargo target dir searched for git-remote-htree
  --formula-name <name>            Formula name (default: htree)
  --alias-name <name>              Alias name (default: hashtree)
  --no-alias                       Do not create an alias
  --homepage <url>                 Formula homepage
  --desc <text>                    Formula description
  --license <id>                   Formula license
  -h, --help                       Show this help

Examples:
  packaging/homebrew/publish_tap.sh \
    --version v0.2.15 \
    --release-base-url https://upload.iris.to/<npub>/releases%2Fhashtree/v0.2.15 \
    --checksums-dir rust/dist/hashtree-v0.2.15
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${REPO_DIR}/rust/scripts/release_common.sh"
RUST_DIR="${REPO_DIR}/rust"
CREATE_TAP_SCRIPT="${SCRIPT_DIR}/create_tap.sh"

VERSION=""
RELEASE_BASE_URL=""
CHECKSUMS_DIR=""
TARGET_DIR="${RUST_DIR}/target"
TAP_REPO=""
PUSH_URL=""
NPUB=""
FORMULA_NAME="htree"
ALIAS_NAME="hashtree"
CREATE_ALIAS=1

CREATE_TAP_ARGS=()

require_command() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing required command: $cmd" >&2
        exit 1
    fi
}

prefer_local_git_helper_dir() {
    local candidate
    while IFS= read -r candidate; do
        if [ -x "${candidate}/git-remote-htree" ]; then
            PATH="${candidate}:${PATH}"
            export PATH
            return 0
        fi
    done < <(
        {
            printf '%s\n' \
                "${TARGET_DIR}/debug" \
                "${RUST_DIR}/target/debug"
            find "${TARGET_DIR}" "${RUST_DIR}/target" -type f -name git-remote-htree -print 2>/dev/null \
                | sed 's#/git-remote-htree$##'
        } | awk '!seen[$0]++'
    )

    if command -v git-remote-htree >/dev/null 2>&1; then
        return 0
    fi

    echo "Missing git-remote-htree in PATH and could not find a local build under ${TARGET_DIR}" >&2
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            VERSION="${2:-}"
            CREATE_TAP_ARGS+=("$1" "${2:-}")
            shift 2
            ;;
        --release-base-url)
            RELEASE_BASE_URL="${2:-}"
            CREATE_TAP_ARGS+=("$1" "${2:-}")
            shift 2
            ;;
        --checksums-dir)
            CHECKSUMS_DIR="${2:-}"
            CREATE_TAP_ARGS+=("$1" "${2:-}")
            shift 2
            ;;
        --tap-repo)
            TAP_REPO="${2:-}"
            shift 2
            ;;
        --push-url)
            PUSH_URL="${2:-}"
            shift 2
            ;;
        --npub)
            NPUB="${2:-}"
            shift 2
            ;;
        --target-dir)
            TARGET_DIR="${2:-}"
            shift 2
            ;;
        --output-dir)
            echo "--output-dir is managed internally by publish_tap.sh" >&2
            exit 1
            ;;
        --formula-name|--alias-name|--homepage|--desc|--license)
            case "$1" in
                --formula-name)
                    FORMULA_NAME="${2:-}"
                    ;;
                --alias-name)
                    ALIAS_NAME="${2:-}"
                    CREATE_ALIAS=1
                    ;;
            esac
            CREATE_TAP_ARGS+=("$1" "${2:-}")
            shift 2
            ;;
        --no-alias)
            CREATE_ALIAS=0
            CREATE_TAP_ARGS+=("$1")
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

if [ -z "$VERSION" ] || [ -z "$RELEASE_BASE_URL" ] || [ -z "$CHECKSUMS_DIR" ]; then
    usage >&2
    exit 1
fi

if [ ! -d "$CHECKSUMS_DIR" ]; then
    echo "Checksums directory does not exist: $CHECKSUMS_DIR" >&2
    exit 1
fi

require_command git
require_command "$CREATE_TAP_SCRIPT"

repo_name="$(infer_repo_name "$REPO_DIR")"
if [ -z "$TAP_REPO" ]; then
    TAP_REPO="homebrew-${repo_name}"
fi

if [ -z "$PUSH_URL" ]; then
    PUSH_URL="htree://self/${TAP_REPO}"
fi

if [[ "$PUSH_URL" == htree://* ]]; then
    prefer_local_git_helper_dir
fi

if [ -z "$NPUB" ] && command -v htree >/dev/null 2>&1; then
    NPUB="$(current_npub)"
fi

tmp_dir="$(mktemp -d)"
bare_repo="${tmp_dir}/tap.git"
work_repo="${tmp_dir}/work"
trap 'rm -rf "$tmp_dir"' EXIT

"${CREATE_TAP_SCRIPT}" \
    "${CREATE_TAP_ARGS[@]}" \
    --output-dir "${bare_repo}" >/dev/null

git clone "${bare_repo}" "${work_repo}" >/dev/null
(
    cd "${work_repo}"
    git remote remove origin
    git remote add origin "${PUSH_URL}"
    git push --force origin master >/dev/null
)

echo "Published Homebrew tap."

if [[ "$PUSH_URL" == htree://* ]]; then
    cat <<EOF

Canonical:
  ${PUSH_URL}
EOF
fi

if [ -n "$NPUB" ]; then
    cat <<EOF

Gateway URL:
  https://upload.iris.to/${NPUB}/${TAP_REPO}/.git

Install:
  brew tap <user>/<repo> https://upload.iris.to/${NPUB}/${TAP_REPO}/.git
  brew install ${FORMULA_NAME}
EOF

    if [ "$CREATE_ALIAS" -eq 1 ] && [ -n "$ALIAS_NAME" ] && [ "$ALIAS_NAME" != "$FORMULA_NAME" ]; then
        cat <<EOF

Alias:
  brew install ${ALIAS_NAME}
EOF
    fi
fi
