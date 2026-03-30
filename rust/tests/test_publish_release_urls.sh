#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PUBLISH_SCRIPT="${RUST_DIR}/scripts/publish_release.sh"

TMPDIR="$(mktemp -d)"
cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

BIN_DIR="${TMPDIR}/bin"
mkdir -p "$BIN_DIR"

cat >"${BIN_DIR}/htree" <<'EOF'
#!/bin/bash
set -euo pipefail

case "${1:-}" in
    user)
        echo "npub1releaseowner (Release Owner)"
        ;;
    release)
        echo "$*" >>"${TEST_LOG_DIR}/htree.log"
        ;;
    *)
        echo "unexpected htree command: $*" >&2
        exit 1
        ;;
esac
EOF
chmod +x "${BIN_DIR}/htree"

OUTPUT="$(
    PATH="${BIN_DIR}:$PATH" TEST_LOG_DIR="$TMPDIR" \
        "${PUBLISH_SCRIPT}" v0.2.3 nhash1example hashtree-releases
)"

grep -F "release publish hashtree-releases v0.2.3 nhash1example" "${TMPDIR}/htree.log" >/dev/null
printf '%s\n' "$OUTPUT" | grep -F "htree://npub1releaseowner/hashtree-releases/v0.2.3" >/dev/null
printf '%s\n' "$OUTPUT" | grep -F "https://upload.iris.to/npub1releaseowner/hashtree-releases/v0.2.3/" >/dev/null
if printf '%s\n' "$OUTPUT" | grep -F "Release Owner" >/dev/null; then
    echo "publish_release output should not include display names from htree user" >&2
    exit 1
fi

echo "test_publish_release_urls.sh passed"
