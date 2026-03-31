#!/bin/bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: packaging/homebrew/tests/test_static_http_tap.sh

End-to-end test for a Homebrew tap served from static HTTP:
1. Builds tiny release tarballs for each supported target.
2. Generates a bare tap repository with create_tap.sh.
3. Serves both over a local HTTP server.
4. Runs brew tap, brew install, and brew test.

This test modifies the local Homebrew installation temporarily. It refuses to
run if the real htree formula is already installed.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    usage
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOMEBREW_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CREATE_TAP_SCRIPT="${HOMEBREW_DIR}/create_tap.sh"
PORT=18080
TAP_NAME="codex/htree-http-test"

require_command() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing required command: $cmd" >&2
        exit 1
    fi
}

cleanup() {
    local exit_code=$?

    if brew tap | grep -qx "$TAP_NAME"; then
        HOMEBREW_NO_AUTO_UPDATE=1 brew untap "$TAP_NAME" >/dev/null 2>&1 || true
    fi

    if brew list --formula | grep -qx 'htree'; then
        HOMEBREW_NO_AUTO_UPDATE=1 brew uninstall --formula htree >/dev/null 2>&1 || true
    fi

    if [ -n "${SERVER_PID:-}" ]; then
        kill "$SERVER_PID" >/dev/null 2>&1 || true
        wait "$SERVER_PID" >/dev/null 2>&1 || true
    fi

    if [ -n "${TMP_DIR:-}" ] && [ -d "${TMP_DIR:-}" ]; then
        rm -rf "$TMP_DIR"
    fi

    exit "$exit_code"
}

require_command brew
require_command git
require_command python3
require_command tar
require_command "$CREATE_TAP_SCRIPT"

if brew list --formula | grep -qx 'htree'; then
    echo "Refusing to run because Homebrew formula 'htree' is already installed." >&2
    exit 1
fi

TMP_DIR="$(mktemp -d)"
trap cleanup EXIT

ROOT_DIR="${TMP_DIR}/root"
ASSETS_DIR="${ROOT_DIR}/assets"
TAP_DIR="${ROOT_DIR}/homebrew-htree.git"

mkdir -p "${ASSETS_DIR}"

for target in \
    aarch64-apple-darwin \
    x86_64-apple-darwin \
    aarch64-unknown-linux-musl \
    x86_64-unknown-linux-musl
do
    stage_dir="${TMP_DIR}/stage-${target}"
    mkdir -p "${stage_dir}/hashtree"

    cat > "${stage_dir}/hashtree/htree" <<'EOF'
#!/bin/sh
echo htree-static-http-test
EOF
    chmod +x "${stage_dir}/hashtree/htree"

    cat > "${stage_dir}/hashtree/htree-cashu" <<'EOF'
#!/bin/sh
echo htree-cashu-static-http-test
EOF
    chmod +x "${stage_dir}/hashtree/htree-cashu"

    cat > "${stage_dir}/hashtree/git-remote-htree" <<'EOF'
#!/bin/sh
echo git-remote-htree-static-http-test
EOF
    chmod +x "${stage_dir}/hashtree/git-remote-htree"

    (
        cd "$stage_dir"
        tar -czf "${ASSETS_DIR}/hashtree-${target}.tar.gz" hashtree
    )
done

"$CREATE_TAP_SCRIPT" \
    --version v0.0.1 \
    --release-base-url "http://127.0.0.1:${PORT}/assets" \
    --assets-dir "$ASSETS_DIR" \
    --output-dir "$TAP_DIR"

(
    cd "$ROOT_DIR"
    python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1
) &
SERVER_PID=$!
sleep 1

rm -rf "${TMP_DIR}/clone"
git clone "http://127.0.0.1:${PORT}/homebrew-htree.git" "${TMP_DIR}/clone" >/dev/null

HOMEBREW_NO_AUTO_UPDATE=1 brew tap "$TAP_NAME" "http://127.0.0.1:${PORT}/homebrew-htree.git" >/dev/null
HOMEBREW_NO_AUTO_UPDATE=1 brew install "${TAP_NAME}/htree" >/dev/null
HOMEBREW_NO_AUTO_UPDATE=1 brew test "${TAP_NAME}/htree" >/dev/null

prefix="$(brew --prefix)"
actual_htree="$("${prefix}/bin/htree")"
actual_cashu="$("${prefix}/bin/htree-cashu")"
actual_remote="$("${prefix}/bin/git-remote-htree")"

if [ "$actual_htree" != "htree-static-http-test" ]; then
    echo "Unexpected htree output: $actual_htree" >&2
    exit 1
fi

if [ "$actual_cashu" != "htree-cashu-static-http-test" ]; then
    echo "Unexpected htree-cashu output: $actual_cashu" >&2
    exit 1
fi

if [ "$actual_remote" != "git-remote-htree-static-http-test" ]; then
    echo "Unexpected git-remote-htree output: $actual_remote" >&2
    exit 1
fi

echo "Static HTTP Homebrew tap test passed."
