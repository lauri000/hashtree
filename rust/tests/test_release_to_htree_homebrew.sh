#!/bin/bash
set -euo pipefail

TMPDIR="$(mktemp -d)"
REPO_ROOT="${TMPDIR}/hashtree-release-worktree"
cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

mkdir -p \
    "${REPO_ROOT}/rust/scripts" \
    "${REPO_ROOT}/packaging/homebrew" \
    "${TMPDIR}/bin" \
    "${TMPDIR}/logs" \
    "${TMPDIR}/out"

cp /Users/sirius/src/hashtree/rust/scripts/release_to_htree.sh "${REPO_ROOT}/rust/scripts/release_to_htree.sh"
cp /Users/sirius/src/hashtree/rust/scripts/release_common.sh "${REPO_ROOT}/rust/scripts/release_common.sh"
chmod +x "${REPO_ROOT}/rust/scripts/release_to_htree.sh"
git init "${REPO_ROOT}" >/dev/null
git -C "${REPO_ROOT}" remote add origin htree://self/hashtree

cat >"${REPO_ROOT}/rust/scripts/build_release_artifacts.sh" <<'EOF'
#!/bin/bash
set -euo pipefail

output_dir=""
while [ $# -gt 0 ]; do
    case "$1" in
        --output-dir)
            output_dir="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

mkdir -p "$output_dir"
for target in \
    aarch64-apple-darwin \
    x86_64-apple-darwin \
    aarch64-unknown-linux-musl \
    x86_64-unknown-linux-musl
do
    printf 'deadbeef  hashtree-%s.tar.gz\n' "$target" >"${output_dir}/hashtree-${target}.sha256"
done

echo "build:$*" >>"${TEST_LOG_DIR}/calls.log"
EOF
chmod +x "${REPO_ROOT}/rust/scripts/build_release_artifacts.sh"

cat >"${REPO_ROOT}/rust/scripts/publish_release.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
echo "publish_release:$*" >>"${TEST_LOG_DIR}/calls.log"
EOF
chmod +x "${REPO_ROOT}/rust/scripts/publish_release.sh"

cat >"${REPO_ROOT}/packaging/homebrew/publish_tap.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
echo "publish_tap:$*" >>"${TEST_LOG_DIR}/calls.log"
if [ "${FAIL_HOME_TAP:-0}" = "1" ]; then
    exit 1
fi
EOF
chmod +x "${REPO_ROOT}/packaging/homebrew/publish_tap.sh"

cat >"${REPO_ROOT}/rust/scripts/publish.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
echo "cargo_publish:$*" >>"${TEST_LOG_DIR}/calls.log"
EOF
chmod +x "${REPO_ROOT}/rust/scripts/publish.sh"

cat >"${TMPDIR}/bin/htree" <<'EOF'
#!/bin/bash
set -euo pipefail
case "${1:-}" in
    add)
        printf '  url: nhash1release\n'
        ;;
    user)
        printf '2026-03-31T10:00:00Z INFO loading profile\n'
        printf 'npub1qqqqqqqqqqqqqqqqqqqqq (Release Owner)\n'
        ;;
    *)
        echo "unexpected htree command: $*" >&2
        exit 1
        ;;
esac
EOF
chmod +x "${TMPDIR}/bin/htree"

PATH="${TMPDIR}/bin:$PATH" TEST_LOG_DIR="${TMPDIR}/logs" \
    "${REPO_ROOT}/rust/scripts/release_to_htree.sh" \
    --version v0.2.3 \
    --output-dir "${TMPDIR}/out" >/dev/null

grep -F "publish_release:v0.2.3 nhash1release hashtree-releases" "${TMPDIR}/logs/calls.log" >/dev/null
grep -F "publish_tap:--version v0.2.3 --release-base-url https://upload.iris.to/npub1qqqqqqqqqqqqqqqqqqqqq/hashtree-releases/v0.2.3 --checksums-dir ${TMPDIR}/out --tap-repo homebrew-hashtree" "${TMPDIR}/logs/calls.log" >/dev/null
if grep -F "cargo_publish:" "${TMPDIR}/logs/calls.log" >/dev/null; then
    echo "release_to_htree should not cargo publish unless requested" >&2
    exit 1
fi

rm -f "${TMPDIR}/logs/calls.log"
PATH="${TMPDIR}/bin:$PATH" TEST_LOG_DIR="${TMPDIR}/logs" \
    "${REPO_ROOT}/rust/scripts/release_to_htree.sh" \
    --version v0.2.3 \
    --output-dir "${TMPDIR}/out" \
    --cargo-publish >/dev/null

grep -F "cargo_publish:" "${TMPDIR}/logs/calls.log" >/dev/null
publish_release_line="$(grep -n '^publish_release:' "${TMPDIR}/logs/calls.log" | cut -d: -f1)"
publish_tap_line="$(grep -n '^publish_tap:' "${TMPDIR}/logs/calls.log" | cut -d: -f1)"
cargo_publish_line="$(grep -n '^cargo_publish:' "${TMPDIR}/logs/calls.log" | cut -d: -f1)"

if [ -z "$publish_release_line" ] || [ -z "$publish_tap_line" ] || [ -z "$cargo_publish_line" ]; then
    echo "Expected publish_release, publish_tap, and cargo_publish calls" >&2
    exit 1
fi

if [ "$cargo_publish_line" -le "$publish_tap_line" ] || [ "$publish_tap_line" -le "$publish_release_line" ]; then
    echo "Expected cargo publish to run after release and tap publication" >&2
    exit 1
fi

rm -f "${TMPDIR}/logs/calls.log"
STDOUT_FILE="${TMPDIR}/release_to_htree_homebrew.out"
STDERR_FILE="${TMPDIR}/release_to_htree_homebrew.err"
PATH="${TMPDIR}/bin:$PATH" TEST_LOG_DIR="${TMPDIR}/logs" FAIL_HOME_TAP=1 \
    "${REPO_ROOT}/rust/scripts/release_to_htree.sh" \
    --version v0.2.3 \
    --output-dir "${TMPDIR}/out" >"${STDOUT_FILE}" 2>"${STDERR_FILE}"

grep -F "Warning: Homebrew tap update failed; release artifacts are still published." "${STDERR_FILE}" >/dev/null

echo "test_release_to_htree_homebrew.sh passed"
