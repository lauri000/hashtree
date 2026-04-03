#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_SCRIPT="${RUST_DIR}/scripts/build_release_artifacts.sh"

TMPDIR="$(mktemp -d)"
cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

BIN_DIR="${TMPDIR}/bin"
TARGET_DIR="${TMPDIR}/custom-target"
OUTPUT_DIR="${TMPDIR}/out"
LOG_DIR="${TMPDIR}/logs"

mkdir -p "$BIN_DIR" "$LOG_DIR"

cat >"${BIN_DIR}/rustup" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >>"${TEST_LOG_DIR}/rustup.log"
EOF
chmod +x "${BIN_DIR}/rustup"

cat >"${BIN_DIR}/cargo" <<'EOF'
#!/bin/bash
set -euo pipefail

printf 'env:%s\nargs:%s\n' "${CARGO_TARGET_DIR:-}" "$*" >>"${TEST_LOG_DIR}/cargo.log"

target=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    if [ "${args[$i]}" = "--target" ]; then
        target="${args[$((i + 1))]}"
        break
    fi
done

if [ -z "$target" ]; then
    echo "missing --target" >&2
    exit 1
fi

release_dir="${CARGO_TARGET_DIR}/${target}/release"
mkdir -p "$release_dir"
for binary in git-remote-htree htree-cashu htree; do
    printf '%s\n' "#!/bin/sh" "echo ${binary}" >"${release_dir}/${binary}"
    chmod +x "${release_dir}/${binary}"
done
EOF
chmod +x "${BIN_DIR}/cargo"

cat >"${BIN_DIR}/cross" <<'EOF'
#!/bin/bash
set -euo pipefail

printf 'env:%s\nargs:%s\n' "${CARGO_TARGET_DIR:-}" "$*" >>"${TEST_LOG_DIR}/cross.log"

target=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    if [ "${args[$i]}" = "--target" ]; then
        target="${args[$((i + 1))]}"
        break
    fi
done

if [ -z "$target" ]; then
    echo "missing --target" >&2
    exit 1
fi

release_dir="${CARGO_TARGET_DIR}/${target}/release"
mkdir -p "$release_dir"
for binary in git-remote-htree htree-cashu htree; do
    printf '%s\n' "#!/bin/sh" "echo ${binary}" >"${release_dir}/${binary}"
    chmod +x "${release_dir}/${binary}"
done
EOF
chmod +x "${BIN_DIR}/cross"

PATH="${BIN_DIR}:$PATH" TEST_LOG_DIR="${LOG_DIR}" "${BUILD_SCRIPT}" \
    --version v0.2.3 \
    --output-dir "${OUTPUT_DIR}" \
    --target-dir "${TARGET_DIR}" \
    --targets "aarch64-apple-darwin,x86_64-unknown-linux-musl" \
    --cargo-bin cargo \
    --cross-bin cross

grep -Fx "target add aarch64-apple-darwin" "${LOG_DIR}/rustup.log" >/dev/null
grep -F "env:${TARGET_DIR}" "${LOG_DIR}/cargo.log" >/dev/null
grep -F "args:build --release --target aarch64-apple-darwin -p git-remote-htree -p hashtree-cashu-cli -p hashtree-cli --features hashtree-cli/fuse" "${LOG_DIR}/cargo.log" >/dev/null
grep -F "env:${TARGET_DIR}" "${LOG_DIR}/cross.log" >/dev/null
grep -F "args:build --release --target x86_64-unknown-linux-musl -p git-remote-htree -p hashtree-cashu-cli -p hashtree-cli --features hashtree-cli/fuse" "${LOG_DIR}/cross.log" >/dev/null

test -f "${OUTPUT_DIR}/hashtree-aarch64-apple-darwin.tar.gz"
test -f "${OUTPUT_DIR}/hashtree-x86_64-unknown-linux-musl.tar.gz"

echo "test_build_release_invocation.sh passed"
