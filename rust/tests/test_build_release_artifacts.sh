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

TARGET_DIR="${TMPDIR}/target"
OUTPUT_DIR="${TMPDIR}/out"
WINDOWS_DIR="${TMPDIR}/windows-release"

mkdir -p \
    "${TARGET_DIR}/aarch64-apple-darwin/release" \
    "${TARGET_DIR}/x86_64-unknown-linux-musl/release" \
    "${WINDOWS_DIR}"

for binary in git-remote-htree htree-cashu htree; do
    printf '%s\n' "#!/bin/sh" "echo ${binary}" >"${TARGET_DIR}/aarch64-apple-darwin/release/${binary}"
    printf '%s\n' "#!/bin/sh" "echo ${binary}" >"${TARGET_DIR}/x86_64-unknown-linux-musl/release/${binary}"
    chmod +x "${TARGET_DIR}/aarch64-apple-darwin/release/${binary}" "${TARGET_DIR}/x86_64-unknown-linux-musl/release/${binary}"
done

for binary in git-remote-htree.exe htree-cashu.exe htree.exe; do
    printf '%s\n' "${binary}" >"${WINDOWS_DIR}/${binary}"
done

"${BUILD_SCRIPT}" \
    --version v0.2.3 \
    --output-dir "${OUTPUT_DIR}" \
    --target-dir "${TARGET_DIR}" \
    --targets "aarch64-apple-darwin,x86_64-unknown-linux-musl" \
    --windows-artifacts-dir "${WINDOWS_DIR}" \
    --package-only

test -f "${OUTPUT_DIR}/hashtree-aarch64-apple-darwin.tar.gz"
test -f "${OUTPUT_DIR}/hashtree-aarch64-apple-darwin.sha256"
test -f "${OUTPUT_DIR}/hashtree-x86_64-unknown-linux-musl.tar.gz"
test -f "${OUTPUT_DIR}/hashtree-x86_64-unknown-linux-musl.sha256"
test -f "${OUTPUT_DIR}/hashtree-x86_64-pc-windows-msvc.zip"
test -f "${OUTPUT_DIR}/hashtree-x86_64-pc-windows-msvc.sha256"

tar -tzf "${OUTPUT_DIR}/hashtree-aarch64-apple-darwin.tar.gz" | grep -Fx "hashtree/install.sh" >/dev/null
tar -tzf "${OUTPUT_DIR}/hashtree-aarch64-apple-darwin.tar.gz" | grep -Fx "hashtree/htree" >/dev/null
tar -tzf "${OUTPUT_DIR}/hashtree-x86_64-unknown-linux-musl.tar.gz" | grep -Fx "hashtree/README.txt" >/dev/null

INSTALL_TMPDIR="${TMPDIR}/install-test"
INSTALL_HOME="${INSTALL_TMPDIR}/home"
CUSTOM_BIN="${INSTALL_TMPDIR}/custom-bin"
mkdir -p "${INSTALL_TMPDIR}" "${INSTALL_HOME}"
tar -xzf "${OUTPUT_DIR}/hashtree-aarch64-apple-darwin.tar.gz" -C "${INSTALL_TMPDIR}"
(
    cd "${INSTALL_TMPDIR}/hashtree"
    env HOME="${INSTALL_HOME}" PATH="/usr/bin:/bin" ./install.sh
)
test -x "${INSTALL_HOME}/.local/bin/htree"
test -x "${INSTALL_HOME}/.local/bin/htree-cashu"
test -x "${INSTALL_HOME}/.local/bin/git-remote-htree"
(
    cd "${INSTALL_TMPDIR}/hashtree"
    env HOME="${INSTALL_HOME}" PATH="/usr/bin:/bin" ./install.sh "${CUSTOM_BIN}"
)
test -x "${CUSTOM_BIN}/htree"
test -x "${CUSTOM_BIN}/htree-cashu"
test -x "${CUSTOM_BIN}/git-remote-htree"

python3 - <<'PY' "${OUTPUT_DIR}/hashtree-x86_64-pc-windows-msvc.zip"
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as zf:
    names = set(zf.namelist())

required = {
    "hashtree/README.txt",
    "hashtree/htree.exe",
    "hashtree/htree-cashu.exe",
    "hashtree/git-remote-htree.exe",
}

missing = required - names
if missing:
    raise SystemExit(f"missing files in windows zip: {sorted(missing)}")
PY

grep -F "hashtree-aarch64-apple-darwin.tar.gz" "${OUTPUT_DIR}/hashtree-aarch64-apple-darwin.sha256" >/dev/null
grep -F "hashtree-x86_64-pc-windows-msvc.zip" "${OUTPUT_DIR}/hashtree-x86_64-pc-windows-msvc.sha256" >/dev/null

RELATIVE_ROOT="${TMPDIR}/relative-output-check"
mkdir -p "${RELATIVE_ROOT}"
(
    cd "${RELATIVE_ROOT}"
    "${BUILD_SCRIPT}" \
        --version v0.2.3 \
        --output-dir out \
        --targets , \
        --windows-artifacts-dir "${WINDOWS_DIR}" \
        --package-only
)
test -f "${RELATIVE_ROOT}/out/hashtree-x86_64-pc-windows-msvc.zip"

echo "test_build_release_artifacts.sh passed"
