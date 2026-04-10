#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUN_SCRIPT="${RUST_DIR}/scripts/test_install_matrix.sh"

TMPDIR="$(mktemp -d)"
cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

BIN_DIR="${TMPDIR}/bin"
LOG_FILE="${TMPDIR}/calls.log"
mkdir -p "$BIN_DIR"

cat >"${BIN_DIR}/uname" <<'EOF'
#!/bin/bash
set -euo pipefail
case "${1:-}" in
    -s)
        printf 'Darwin\n'
        ;;
    -m)
        printf 'arm64\n'
        ;;
    *)
        printf 'Darwin\n'
        ;;
esac
EOF
chmod +x "${BIN_DIR}/uname"

cat >"${BIN_DIR}/fake-install" <<'EOF'
#!/bin/bash
set -euo pipefail
mkdir -p "${HOME}/.local/bin"
cat >"${HOME}/.local/bin/htree" <<'SCRIPT'
#!/bin/bash
set -euo pipefail
if [ "${1:-}" = "--help" ]; then
    printf 'Content-addressed filesystem\n'
    exit 0
fi
exit 0
SCRIPT
cat >"${HOME}/.local/bin/htree-cashu" <<'SCRIPT'
#!/bin/bash
set -euo pipefail
exit 0
SCRIPT
cat >"${HOME}/.local/bin/git-remote-htree" <<'SCRIPT'
#!/bin/bash
set -euo pipefail
if [ "${1:-}" != "origin" ]; then
    exit 1
fi
cat >/dev/null
printf 'fetch\npush\noption\n\n'
SCRIPT
chmod +x "${HOME}/.local/bin/htree" "${HOME}/.local/bin/htree-cashu" "${HOME}/.local/bin/git-remote-htree"
EOF
chmod +x "${BIN_DIR}/fake-install"

cat >"${BIN_DIR}/git" <<'EOF'
#!/bin/bash
set -euo pipefail
if [ "${1:-}" = "ls-remote" ]; then
    printf '0123456789abcdef0123456789abcdef01234567\tHEAD\n'
    exit 0
fi
exit 1
EOF
chmod +x "${BIN_DIR}/git"

cat >"${BIN_DIR}/docker" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'docker:%s\n' "$*" >>"${TEST_LOG_FILE}"
platform=""
previous=""
for arg in "$@"; do
    if [ "$previous" = "--platform" ]; then
        platform="$arg"
        previous=""
        continue
    fi
    previous="$arg"
done

case "$*" in
    *"alpine:3.22 true"*)
        exit 0
        ;;
esac

case "$platform" in
    linux/arm64)
        exit 0
        ;;
    linux/amd64)
        printf 'Store error: Function not implemented (os error 38)\n' >&2
        exit 1
        ;;
esac

exit 1
EOF
chmod +x "${BIN_DIR}/docker"

cat >"${BIN_DIR}/brew" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'brew:%s\n' "$*" >>"${TEST_LOG_FILE}"
case "${1:-}" in
    tap)
        if [ $# -eq 1 ]; then
            exit 0
        fi
        exit 0
        ;;
    list)
        exit 1
        ;;
    install|test|info|uninstall|untap)
        exit 0
        ;;
esac
exit 0
EOF
chmod +x "${BIN_DIR}/brew"

cat >"${BIN_DIR}/prlctl" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'prlctl:%s\n' "$*" >>"${TEST_LOG_FILE}"
case "${1:-}" in
    list)
        printf 'UUID                                    STATUS       IP_ADDR         NAME\n'
        printf '{00000000-0000-0000-0000-000000000000}  running      -               Windows 11\n'
        ;;
    exec)
        exit 0
        ;;
esac
EOF
chmod +x "${BIN_DIR}/prlctl"

OUTPUT_FILE="${TMPDIR}/matrix.out"
set +e
PATH="${BIN_DIR}:/usr/bin:/bin" TEST_LOG_FILE="${LOG_FILE}" \
    "${RUN_SCRIPT}" \
    --install-cmd "fake-install" \
    --windows-zip-url "https://example.test/hashtree.zip" \
    --brew-tap-name "sirius/hashtree" \
    --brew-tap-url "https://example.test/homebrew-hashtree.git" \
    --platforms "host,docker-arm64,docker-amd64,windows,brew" \
    >"${OUTPUT_FILE}" 2>&1
status=$?
set -e

test "$status" -eq 1
grep -F "PASS     host-darwin-arm64" "${OUTPUT_FILE}" >/dev/null
grep -F "PASS     docker-linux-arm64" "${OUTPUT_FILE}" >/dev/null
grep -F "FAIL     docker-linux-amd64" "${OUTPUT_FILE}" >/dev/null
grep -F "PASS     windows-vm-x86_64" "${OUTPUT_FILE}" >/dev/null
grep -F "PASS     homebrew-host" "${OUTPUT_FILE}" >/dev/null
grep -F "Summary: 4 passed, 1 failed, 0 skipped" "${OUTPUT_FILE}" >/dev/null

grep -F "docker:run --rm --platform linux/arm64 alpine:3.22 true" "${LOG_FILE}" >/dev/null
grep -F "docker:run --rm --platform linux/amd64 alpine:3.22 true" "${LOG_FILE}" >/dev/null
grep -F "brew:install htree" "${LOG_FILE}" >/dev/null
grep -F "prlctl:list -a" "${LOG_FILE}" >/dev/null
grep -F "prlctl:exec Windows 11 --current-user powershell.exe -NoProfile -NonInteractive -EncodedCommand" "${LOG_FILE}" >/dev/null

echo "test_install_matrix_script.sh passed"
