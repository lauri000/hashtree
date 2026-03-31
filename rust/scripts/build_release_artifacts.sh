#!/bin/bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: rust/scripts/build_release_artifacts.sh --version <version> [options]

Builds and packages CLI release artifacts in the same layout as the GitHub release
workflow for the supported local targets, then writes them into a release directory.

Options:
  --version <version>                 Release version label, for example: v0.2.3
  --output-dir <dir>                 Output directory (default: rust/dist/hashtree-<version>)
  --target-dir <dir>                 Cargo target dir to read/write (default: rust/target)
  --targets <csv>                    Comma-separated targets to package
  --windows-artifacts-dir <dir>      Directory containing Windows .exe binaries from a VM
  --package-only                     Skip builds and package existing binaries only
  --cargo-bin <path>                 Cargo binary to use (default: cargo)
  --cross-bin <path>                 cross binary to use for Linux musl targets (default: cross)
  -h, --help                         Show this help

Examples:
  rust/scripts/build_release_artifacts.sh --version v0.2.3
  rust/scripts/build_release_artifacts.sh --version v0.2.3 --targets aarch64-apple-darwin,x86_64-unknown-linux-musl
  rust/scripts/build_release_artifacts.sh --version v0.2.3 --windows-artifacts-dir /Volumes/windows-share/release
  rust/scripts/build_release_artifacts.sh --version v0.2.3 --package-only --target-dir /tmp/target
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${RUST_DIR}/.." && pwd)"

VERSION=""
OUTPUT_DIR=""
TARGET_DIR="${RUST_DIR}/target"
TARGETS_CSV=""
WINDOWS_ARTIFACTS_DIR=""
PACKAGE_ONLY=0
CARGO_BIN="${CARGO_BIN:-cargo}"
CROSS_BIN="${CROSS_BIN:-cross}"

default_targets_csv() {
    case "$(uname -s)" in
        Darwin)
            echo "aarch64-apple-darwin,x86_64-apple-darwin,x86_64-unknown-linux-musl,aarch64-unknown-linux-musl"
            ;;
        Linux)
            echo "x86_64-unknown-linux-musl,aarch64-unknown-linux-musl"
            ;;
        *)
            echo ""
            ;;
    esac
}

require_command() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing required command: $cmd" >&2
        exit 1
    fi
}

write_unix_install_script() {
    local path="$1"
    cat >"$path" <<'EOF'
#!/bin/bash
set -e

default_install_dir() {
  if [ "${1:-}" = "root" ]; then
    printf '%s\n' /usr/local/bin
    return
  fi

  if [ -n "${XDG_BIN_HOME:-}" ]; then
    printf '%s\n' "${XDG_BIN_HOME}"
    return
  fi

  if [ -n "${HOME:-}" ]; then
    printf '%s\n' "${HOME}/.local/bin"
    return
  fi

  printf '%s\n' /usr/local/bin
}

path_contains() {
  local target="$1"
  local entry
  local old_ifs="${IFS}"
  IFS=:
  for entry in ${PATH:-}; do
    if [ "$entry" = "$target" ]; then
      IFS="${old_ifs}"
      return 0
    fi
  done
  IFS="${old_ifs}"
  return 1
}

existing_parent_dir() {
  local dir="$1"
  while [ ! -e "$dir" ]; do
    dir="$(dirname "$dir")"
  done
  printf '%s\n' "$dir"
}

if [ $# -gt 0 ]; then
  INSTALL_DIR="$1"
elif [ "$(id -u)" -eq 0 ]; then
  INSTALL_DIR="$(default_install_dir root)"
else
  INSTALL_DIR="$(default_install_dir)"
fi

echo "Installing hashtree binaries to $INSTALL_DIR"

if [ ! -d "$INSTALL_DIR" ]; then
  EXISTING_PARENT="$(existing_parent_dir "$INSTALL_DIR")"
  if [ -w "$EXISTING_PARENT" ]; then
    mkdir -p "$INSTALL_DIR"
  else
    echo "Need sudo to create $INSTALL_DIR"
    sudo mkdir -p "$INSTALL_DIR"
  fi
fi

if [ ! -w "$INSTALL_DIR" ]; then
  echo "Need sudo to install to $INSTALL_DIR"
  sudo install -m 755 htree htree-cashu git-remote-htree "$INSTALL_DIR/"
else
  install -m 755 htree htree-cashu git-remote-htree "$INSTALL_DIR/"
fi

echo "✓ Installed htree, htree-cashu, and git-remote-htree"
if ! path_contains "$INSTALL_DIR"; then
  echo ""
  echo "Add $INSTALL_DIR to your PATH, for example:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
fi
echo ""
echo "Verify with:"
echo "  htree --help"
echo "  htree cashu balance"
echo "  git clone htree://npub1.../repo"
EOF
    chmod +x "$path"
}

write_unix_readme() {
    local path="$1"
    cat >"$path" <<'EOF'
hashtree - Git over Nostr via Merkle trees
==========================================

Binaries included:
  htree             - CLI and daemon for hashtree operations
  htree-cashu       - Cashu wallet helper for htree cashu
  git-remote-htree  - Git remote helper for htree:// URLs

Quick install:
  ./install.sh               # installs to ~/.local/bin by default
  ./install.sh /usr/local/bin # installs system-wide (may need sudo)

Manual install:
  cp htree htree-cashu git-remote-htree ~/.local/bin/

Usage:
  htree add <file>                    # add file to hashtree
  htree get <hash>                    # download by hash
  htree start                         # start P2P daemon
  htree cashu balance                 # inspect Cashu wallet
  git clone htree://npub1.../repo     # clone git repo
  git remote add htree htree://self/myrepo
  git push htree main

More info: https://github.com/mmalmi/hashtree
EOF
}

write_windows_readme() {
    local path="$1"
    cat >"$path" <<'EOF'
hashtree - Git over Nostr via Merkle trees
==========================================

Binaries included:
  htree.exe             - CLI and daemon for hashtree operations
  htree-cashu.exe       - Cashu wallet helper for htree cashu
  git-remote-htree.exe  - Git remote helper for htree:// URLs

Install:
  Copy all three .exe files to a directory in your PATH, e.g.:
  C:\Users\<you>\AppData\Local\Microsoft\WindowsApps\

Usage:
  htree add <file>                    # add file to hashtree
  htree get <hash>                    # download by hash
  htree start                         # start P2P daemon
  htree cashu balance                 # inspect Cashu wallet
  git clone htree://npub1.../repo     # clone git repo

More info: https://github.com/mmalmi/hashtree
EOF
}

write_sha256() {
    local file="$1"
    local output="$2"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$(basename "$file")" >"$output"
    else
        shasum -a 256 "$(basename "$file")" >"$output"
    fi
}

ensure_rust_target() {
    local target="$1"
    if [ "$PACKAGE_ONLY" -eq 1 ]; then
        return
    fi
    require_command rustup
    rustup target add "$target" >/dev/null
}

build_target() {
    local target="$1"

    if [ "$PACKAGE_ONLY" -eq 1 ]; then
        return
    fi

    case "$target" in
        x86_64-unknown-linux-musl|aarch64-unknown-linux-musl)
            require_command "$CROSS_BIN"
            (
                cd "$RUST_DIR"
                export CARGO_TARGET_DIR="$TARGET_DIR"
                "$CROSS_BIN" build --release --target "$target" \
                    -p git-remote-htree \
                    -p hashtree-cashu-cli \
                    -p hashtree-cli
            )
            ;;
        x86_64-apple-darwin|aarch64-apple-darwin)
            if [ "$(uname -s)" != "Darwin" ]; then
                echo "Cannot build $target natively on $(uname -s). Use --targets to skip it." >&2
                exit 1
            fi
            require_command "$CARGO_BIN"
            ensure_rust_target "$target"
            (
                cd "$RUST_DIR"
                export CARGO_TARGET_DIR="$TARGET_DIR"
                "$CARGO_BIN" build --release --target "$target" \
                    -p git-remote-htree \
                    -p hashtree-cashu-cli \
                    -p hashtree-cli
            )
            ;;
        x86_64-pc-windows-msvc)
            echo "Windows MSVC artifacts must come from a Windows VM or runner via --windows-artifacts-dir." >&2
            exit 1
            ;;
        *)
            echo "Unsupported target: $target" >&2
            exit 1
            ;;
    esac
}

package_unix_target() {
    local target="$1"
    local release_dir="${TARGET_DIR}/${target}/release"
    local stage_dir
    stage_dir="$(mktemp -d)"
    local package_dir="${stage_dir}/hashtree"

    mkdir -p "$package_dir"

    for binary in git-remote-htree htree-cashu htree; do
        if [ ! -f "${release_dir}/${binary}" ]; then
            echo "Missing binary for ${target}: ${release_dir}/${binary}" >&2
            exit 1
        fi
        cp "${release_dir}/${binary}" "${package_dir}/"
    done

    write_unix_install_script "${package_dir}/install.sh"
    write_unix_readme "${package_dir}/README.txt"

    (
        cd "$stage_dir"
        tar -czf "${OUTPUT_DIR}/hashtree-${target}.tar.gz" hashtree
    )
    (
        cd "$OUTPUT_DIR"
        write_sha256 "hashtree-${target}.tar.gz" "hashtree-${target}.sha256"
    )

    rm -rf "$stage_dir"
}

package_windows_artifacts() {
    local stage_dir
    stage_dir="$(mktemp -d)"
    local package_dir="${stage_dir}/hashtree"
    mkdir -p "$package_dir"

    for binary in git-remote-htree.exe htree-cashu.exe htree.exe; do
        if [ ! -f "${WINDOWS_ARTIFACTS_DIR}/${binary}" ]; then
            echo "Missing Windows binary: ${WINDOWS_ARTIFACTS_DIR}/${binary}" >&2
            exit 1
        fi
        cp "${WINDOWS_ARTIFACTS_DIR}/${binary}" "${package_dir}/"
    done

    write_windows_readme "${package_dir}/README.txt"

    require_command python3
    (
        cd "$stage_dir"
        python3 - <<'PY'
import pathlib
import zipfile

root = pathlib.Path("hashtree")
with zipfile.ZipFile("hashtree-x86_64-pc-windows-msvc.zip", "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            zf.write(path, path.as_posix())
PY
        mv "hashtree-x86_64-pc-windows-msvc.zip" "${OUTPUT_DIR}/"
    )
    (
        cd "$OUTPUT_DIR"
        write_sha256 "hashtree-x86_64-pc-windows-msvc.zip" "hashtree-x86_64-pc-windows-msvc.sha256"
    )

    rm -rf "$stage_dir"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            VERSION="${2:-}"
            shift 2
            ;;
        --output-dir)
            OUTPUT_DIR="${2:-}"
            shift 2
            ;;
        --target-dir)
            TARGET_DIR="${2:-}"
            shift 2
            ;;
        --targets)
            TARGETS_CSV="${2:-}"
            shift 2
            ;;
        --windows-artifacts-dir)
            WINDOWS_ARTIFACTS_DIR="${2:-}"
            shift 2
            ;;
        --package-only)
            PACKAGE_ONLY=1
            shift
            ;;
        --cargo-bin)
            CARGO_BIN="${2:-}"
            shift 2
            ;;
        --cross-bin)
            CROSS_BIN="${2:-}"
            shift 2
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

if [ -z "$TARGETS_CSV" ]; then
    TARGETS_CSV="$(default_targets_csv)"
fi

if [ -z "$TARGETS_CSV" ] && [ -z "$WINDOWS_ARTIFACTS_DIR" ]; then
    echo "No default targets for $(uname -s). Pass --targets explicitly." >&2
    exit 1
fi

if [ -z "$OUTPUT_DIR" ]; then
    OUTPUT_DIR="${RUST_DIR}/dist/hashtree-${VERSION}"
fi

require_command tar
require_command python3

IFS=',' read -r -a TARGETS <<<"$TARGETS_CSV"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

echo "Release version: ${VERSION}"
echo "Output dir: ${OUTPUT_DIR}"
echo "Target dir: ${TARGET_DIR}"

if [ "${#TARGETS[@]}" -gt 0 ] && [ -n "${TARGETS[0]}" ]; then
    echo "Targets: ${TARGETS[*]}"
    for target in "${TARGETS[@]}"; do
        build_target "$target"
        package_unix_target "$target"
    done
fi

if [ -n "$WINDOWS_ARTIFACTS_DIR" ]; then
    echo "Including Windows artifacts from: ${WINDOWS_ARTIFACTS_DIR}"
    package_windows_artifacts
fi

echo ""
echo "Created release artifacts in ${OUTPUT_DIR}:"
find "$OUTPUT_DIR" -maxdepth 1 -type f | sort
